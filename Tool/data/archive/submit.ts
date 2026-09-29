/**
 * Change the Facebook password, then hand the result to @tasklyBux_bot.
 *
 * The provider conversation, per the user and context.md §4:
 *   /start -> Tasks -> <group> -> <job> -> Start
 *   -> the bot hands US a password
 *   -> we change our Facebook account's password to that one
 *   -> we send our existing 2FA key
 *   -> the bot asks for a cookie -> we send COOKIE_STRING
 *
 * The bot gives the password, so we never send one to it.
 */
import { chromium } from "playwright";
import { config } from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { Taskly } from "./TG.ts";
import { fingerprint, isSent, isSkipped, listSent, listSkipped, markSent, markSkipped } from "./sent.ts";
import { audit } from "./audit.ts";
import {
  changePassword,
  parseCookies,
  readAccounts,
  resolveUrl,
  log,
  Bail,
  BailLogged,
  BailGated,
  argValue,
  isCookieDead,
  DEVICES_PHONE,
} from "./PC.ts";

config();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const GROUP = process.env.TASK_GROUP ?? "Cookies";
// Every account in the 2FA sheet shares this password.
const SHARED_PASSWORD = "dgddigital";
// "2FA:Create FB (No mail)" is unique among the live labels. The near-identical
// "🌟Create FB (No mail) ($0.0300)" does NOT contain it, so this cannot pick
// the wrong product the way "Create FB" would (bridge rule 6).
const JOB = process.env.TASK_NAME ?? "2FA:Create FB (No mail)";

// How long to wait for the bot's password after pressing Start. The bot sends
// it in the same second as the 2FA prompt, so this is short by design: it only
// has to cover scheduling jitter, not a real wait.
const CRED_WAIT_MS = 5_000;
// Floor on the gap between two provider interactions. The provider is a bot
// with its own modal state; firing presses back to back is how a screen gets
// half-updated and a label gets read against the wrong keyboard.
const STEP_MS = 1_000;
// How many accounts share one Telegram session.
//
// A session is a Telegram connection plus a provider-side modal state, and
// re-opening it per account is what the batch used to do: connect, knock,
// /start, walk four menus, disconnect - all to submit ONE row. That is the
// dominant fixed cost of a run, and it is also what provokes the provider's
// "You are making requests too often" reply seen on 2026-09-29. Re-using the
// session across a small group of accounts pays it once per group instead.
//
// Deliberately small. The provider is a bot with its own modal state, and each
// account ends in whatever state its last screen left behind, so a long-lived
// session is a long-lived opportunity for one account's leftovers to be read as
// the next one's keyboard. Small groups bound that blast radius, and
// --per-session is the dial.
const PER_SESSION = 3;

/** Minimum pause between two accounts sharing a session. */
const ACCOUNT_GAP_MS = 2_000;

/** How many times to re-walk the job with /start before giving up. Each retry
 * is a fresh charge, so this stays small. */
const MAX_START_ATTEMPTS = 3;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Hoisted so the top-level catch can record an SMS-gated account even though
// the run aborts from deep inside the Facebook flow. Without these the skip is
// logged and then lost, and the next run pays $0.05 to rediscover it.
const ARGS = process.argv.slice(2);
let curFp = "";
let curXlsx: string | undefined;
let curRow = 0;

/**
 * Parse the credentials the bot sends after we give it our 2FA key.
 *
 * Observed format on 2026-09-29:
 *   First name: Haley
 *   Last name: Hunter
 *   Password: u5yZIeweLu
 *
 * Deliberately strict. A "lone token on its own line" fallback existed and was
 * removed: on the real reply "🔑 Please enter your 2FA key to get the code:" it
 * returned "Please", which would have been typed into Facebook as a password.
 * Returning null is always safer than a guess.
 */
export function parseCreds(replies: string[]): {
  firstName: string | null;
  lastName: string | null;
  password: string | null;
} {
  const text = replies.join("\n");

  // No blanket "is this a prompt?" guard. There used to be one, and it broke
  // everything: the credentials and the 2FA prompt arrive in the SAME second,
  // so the batch always contains "Please enter your 2FA key" and the guard
  // threw the credentials away with it.
  //
  // The colon is mandatory and that is what keeps prose out: "Your password
  // must be at least 6 characters" has no colon after "password", so it
  // cannot match. Fields are NOT line-anchored - the bot sends all three on
  // one line: "First name: Emily Last name: Black Password: 790n1sAV5P".
  const field = (name: string) =>
    text.match(new RegExp(`\\b${name}\\s*[:=]\\s*(\\S+)`, "i"))?.[1]?.trim() ?? null;

  return {
    firstName: field("first name"),
    lastName: field("last name"),
    // An explicit separator is required, so prose like "Your password must be at
    // least 6 characters" cannot hand back the word "must".
    password: field("password"),
  };
}

/** Opens the phone browser, loads the Facebook cookie, and changes the password. */
async function changeFacebook(
  currentPw: string,
  newPw: string,
  url: string,
  cookieString: string,
) {
  const context = await chromium.launchPersistentContext(path.join(__dirname, "profile"), {
    ...DEVICES_PHONE,
    locale: "en-US",
    headless: false,
    channel: "chrome",
    args: ["--disable-blink-features=AutomationControlled"],
  });
  try {
    // Clear first. The profile is persistent and shared by every run, so without
    // this each account inherits the previous one's session and the cookies just
    // stack up. Facebook then picks whichever session is still active, which is
    // how "Devin Scott" turned into "Ashley Nocera" and then into a feed full
    // of other people's names - and why the right page sometimes never loaded.
    await context.clearCookies();
    await context.addCookies(
      parseCookies(cookieString.trim(), process.env.COOKIE_DOMAIN ?? new URL(url).hostname),
    );
    log.success("Cookies loaded");
    return await changePassword({ context, currentPw, newPw, targetUrl: url });
  } finally {
    await context.close();
  }
}

// --xlsx may be repeated, and comma-separated lists are accepted, so several
// sheets can be driven in one command:
//   --xlsx "a.xlsx" "b.xlsx"      --xlsx "a.xlsx,b.xlsx"
//
// Must be module scope: main() calls it before its own body defines anything.
function argValues(args: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith(name + "=")) {
      out.push(...a.slice(name.length + 1).split(",").map((s) => s.trim()).filter(Boolean));
      continue;
    }
    if (a !== name) continue;
    // Consume EVERY following non-flag token, not just one: the natural
    // `--xlsx a.xlsx b.xlsx` must yield both files. Stopping after the first
    // silently dropped every sheet but one.
    while (args[i + 1] && !args[i + 1].startsWith("-")) {
      out.push(...args[++i].split(",").map((s) => s.trim()).filter(Boolean));
    }
  }
  return out;
}

/**
 * Batch driver for several sheets in one command.
 *
 * Each row runs in a CHILD process, deliberately. One row owns a Playwright
 * browser and a Telegram connection, and a crash or a hang in one must not take
 * the other 99 with it - re-trying then costs nothing, because anything that
 * already completed is in sent.jsonl. The child is this same script with a
 * single --xlsx/--row, so the per-account logic is not duplicated.
 *
 * Rows already in sent.jsonl or skipped.jsonl are never started, so re-running
 * the same command retries only what failed.
 */
async function runBatch(files: string[], args: string[]): Promise<number> {
  const pass = args.filter(
    (a) => !a.startsWith("--xlsx") && a !== "--all" && !files.includes(a),
  );

  type Job = { file: string; row: number; fp: string };
  const queue: Job[] = [];
  for (const file of files) {
    if (!fs.existsSync(file)) {
      log.error(`no such file: ${file}`);
      continue;
    }
    const accounts = readAccounts(file);
    for (const a of accounts) {
      const fp = fingerprint(a.cookie);
      if (isSent(fp) || isSkipped(fp)) continue;
      queue.push({ file, row: a.row, fp });
    }
  }

  if (!queue.length) {
    log.success("nothing left to do - every row is sent or skipped");
    return 0;
  }

  // --per-session N overrides the group size; 1 restores the old one-process-
  // per-row behaviour exactly, which is the escape hatch if session reuse ever
  // misbehaves against the provider.
  const perSession = Math.max(
    1,
    Number(argValue(args, ["--per-session"]) ?? PER_SESSION) || PER_SESSION,
  );
  const groups: Job[][] = [];
  for (let i = 0; i < queue.length; i += perSession) {
    groups.push(queue.slice(i, i + perSession));
  }

  log.info(`${queue.length} account(s) queued across ${files.length} sheet(s)`);
  log.info(
    `${groups.length} Telegram session(s) for ${queue.length} account(s) ` +
      `(${perSession} per session${perSession === 1 ? "" : ", --per-session to change"})`,
  );

  // --plan prints the grouping and stops. Session reuse changes how a run is
  // paced, so the shape of the run should be inspectable BEFORE it spends
  // anything - not discovered from a log 40 minutes in.
  if (args.includes("--plan")) {
    for (const [gi, g] of groups.entries()) {
      log.info(`  session ${gi + 1}: ${g.map((j) => `${path.basename(j.file)}:${j.row}`).join(", ")}`);
    }
    log.success("--plan: nothing was run, nothing was spent");
    return 0;
  }

  let ok = 0;
  const failed: string[] = [];
  const self = fileURLToPath(import.meta.url);

  for (const [gi, group] of groups.entries()) {
    const label = group.map((j) => `${path.basename(j.file)}:${j.row}`).join(", ");
    log.info(`── session ${gi + 1}/${groups.length}: ${label}`);
    // inherit stdio: the per-row log is the record, and the browser is headed,
    // so its window must stay on the same desktop.
    //
    // One child per GROUP, not per row: the child keeps a single Telegram
    // session alive across the rows it is given. Isolation is still per group,
    // so a crash takes out at most `perSession` accounts, and every one of them
    // is absent from sent.jsonl/skipped.jsonl and so is retried next run.
    const r = spawnSync(
      process.execPath,
      [self, ...pass, "--rows", group.map((j) => `${j.file}#${j.row}`).join(",")],
      { stdio: "inherit" },
    );
    if (r.status === 0) ok += group.length;
    else failed.push(...group.map((j) => `${path.basename(j.file)}:${j.row}`));
  }

  log.info(`done: ${ok} passed, ${failed.length} failed`);
  if (failed.length) {
    log.error(`failed rows: ${failed.join(", ")}`);
    log.info("re-run the same command - completed rows are skipped automatically");
  }
  return failed.length ? 1 : 0;
}

/**
 * Runs a group of rows against ONE Telegram session.
 *
 * This is where the saving comes from. The batch used to spawn a child per row,
 * and each child called Taskly.open() - connect, knock, /start, walk four menus,
 * disconnect - to submit a single account. Three accounts therefore paid that
 * fixed cost three times, which is also what drew the provider's
 * "You are making requests too often" reply.
 *
 * A group of 3 pays it once. The Facebook side stays per-account: a fresh
 * browser, a fresh cookie, its own ledger entry.
 *
 * Failure handling is per account, not per group. A gated or dead account is
 * recorded and the group CONTINUES to the next row, because those are known,
 * permanent, and per-account outcomes - there is no reason to spend the two
 * remaining accounts on them. A dead CONNECTION stops the group, because every
 * later row would fail identically and look like a bad cookie.
 */
async function runGroup(
  group: { file: string; row: number }[],
  args: string[],
  phone: string | undefined,
): Promise<number> {
  if (!group.length) {
    log.error("nothing to run - no rows given");
    return 1;
  }

  // Drop rows that are already settled BEFORE opening a session.
  //
  // runOne() re-checks these, and must keep doing so - it is the guard that
  // protects a single-row run. But in a group the check would otherwise happen
  // after the session is already connected, so a group made entirely of skipped
  // rows would connect, walk nothing, and disconnect. runBatch() filters these
  // out before spawning, so this only bites a hand-built --rows list.
  const force = args.includes("--force");
  const runnable = group.filter((j) => {
    // A bad row must not abort the filter - it has to reach runOne(), which
    // reports it properly. Skipping it here silently would hide the mistake.
    let fp = "";
    try {
      fp = fingerprint(resolveRow(j.file, j.row).cookie);
    } catch {
      return true;
    }
    if (!force && isSent(fp)) {
      log.info(`── ${path.basename(j.file)}:${j.row} already in sent.jsonl - skipped`);
      return false;
    }
    if (!force && isSkipped(fp)) {
      log.info(`── ${path.basename(j.file)}:${j.row} is SMS-gated - skipped`);
      return false;
    }
    return true;
  });
  if (!runnable.length) {
    log.success("every row in this group is already sent or gated - nothing to do");
    return 0;
  }

  log.info(`Running ${runnable.length} account(s) on one Telegram session`);

  // The session opens ONCE, here. Everything below reuses it.
  const tg = await Taskly.open({ phone });
  let ok = 0;
  const failed: string[] = [];

  try {
    for (const [i, job] of runnable.entries()) {
      const tag = `${path.basename(job.file)}:${job.row}`;
      log.info(`── [${i + 1}/${runnable.length}] ${tag}`);
      try {
        // A previous account's keyboard must not be able to answer for this one.
        // label resolution walks the message window newest-first but falls
        // through to older messages, so without this a stale button can be
        // pressed against a paid provider.
        tg.resetWindow();

        if (await runOne(job, tg, args, phone)) ok++;
        else failed.push(tag);
      } catch (err: any) {
        // Record what is permanent, keep going for what is not.
        const message = String(err?.message ?? err);
        if (err instanceof BailGated && curFp) {
          markSkipped({ fp: curFp, reason: message.slice(0, 200), source: curXlsx, row: curRow });
          audit({ leg: "internal", what: "gated", status: "sms-required", fp: curFp });
          log.warn(`Recorded in skipped.jsonl (fp ${curFp}) - will not be retried`);
          ok++;
        } else {
          if (!(err instanceof BailLogged)) log.error(message);
          failed.push(tag);
        }

        if (!tg.isConnected()) {
          log.error("Telegram connection dropped - stopping this group");
          failed.push(...runnable.slice(i + 1).map((j) => `${path.basename(j.file)}:${j.row}`));
          break;
        }
        // Leave the provider somewhere known before the next account starts.
        // A failure mid-job leaves a modal state behind, and the next account
        // would otherwise read that leftover keyboard as its own.
        await tg
          .sendRaw("reset after failure", "/start")
          .then(() => sleep(ACCOUNT_GAP_MS))
          .catch((e: any) => log.warn(`could not reset provider state: ${e?.message ?? e}`));
      }
    }
  } finally {
    await tg.close();
  }

  log.info(`group done: ${ok} passed, ${failed.length} failed`);
  return failed.length ? 1 : 0;
}

async function main() {
  const args = ARGS;
  const phone = argValue(args, ["--phone", "-p"]) ?? process.env.TG_PHONE;

  // Group mode: runBatch() hands a whole group of rows to ONE child, which
  // keeps a single Telegram session open across them. This is the same code
  // path as a single --xlsx/--row, just looping - so a group cannot drift away
  // from the per-account behaviour that is actually tested.
  const group = parseRows(argValue(args, ["--rows"]));
  if (group.length) {
    process.exit(await runGroup(group, args, phone));
  }

  // Batch mode: --all, or more than one sheet, means "run them all". A single
  // --xlsx with an explicit --row keeps the original one-account behaviour,
  // so existing commands are unaffected.
  const sheets = argValues(args, "--xlsx");
  if (args.includes("--all") || sheets.length > 1) {
    process.exit(await runBatch(sheets, args));
  }

  // Every account in the sheet shares this password.
  const currentPw = argValue(args, ["--current-password", "-o"]) ?? process.env.FB_CURRENT_PASSWORD ?? SHARED_PASSWORD;
  // Resume mode: the job is already started and the bot already handed us a
  // password, so we change Facebook FIRST and only then send the 2FA key.
  const resumePw = argValue(args, ["--password", "-P"]);
  const url = resolveUrl();
  const dryRun = args.includes("--probe") || args.includes("--dry-run");
  // Press Start, then listen WITHOUT sending the 2FA key. Settles whether the
  // bot hands over credentials at Start, which every capture so far disputes.
  const listenAfterStart = argValue(args, ["--probe-start"]);

  // A single --xlsx/--row is the original one-account path. runGroup handles it
  // as a group of one, so there is exactly one implementation of a row and it
  // cannot drift between the two modes.
  const single = sheets[0]
    ? [{ file: sheets[0], row: Number(argValue(args, ["--row"]) ?? "1") }]
    : [];
  // Stopping on ONE account to look at it in the Inspector is the whole point of
  // CODEGEN, and it is safe when a human is watching a single row. It is not
  // safe across a group: page.pause() would freeze the run silently. So the
  // hold is authorised here, per invocation, and only for a single row.
  if (single.length === 1 && args.includes("--inspect")) {
    process.env.CODEGEN_HOLD_ALLOWED = "1";
    log.warn("CODEGEN hold enabled for this single row - the Inspector will open if it gets stuck.");
  }
  process.exit(await runGroup(single, args, phone));
}

// ---- Below: everything that runs inside a group, one account at a time ----

/** "sheet.xlsx#12,sheet.xlsx#13" -> [{file, row}, ...]. Exported for GroupTest. */
export function parseRows(raw: string | undefined): { file: string; row: number }[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const i = s.lastIndexOf("#");
      if (i < 0) throw new Bail(`bad --rows entry "${s}" (want file.xlsx#row)`);
      return { file: s.slice(0, i), row: Number(s.slice(i + 1)) };
    });
}

/** Reads one row and refuses the ones that must not be attempted. */
function resolveRow(
  file: string,
  row: number,
): { cookie: string; fa2Key: string; row: number; total: number } {
  const accounts = readAccounts(file);
  const pick = accounts.find((a) => a.row === row);
  if (!pick) {
    throw new Bail(`row ${row} not found. Usable rows: ${accounts.map((a) => a.row).join(", ")}`);
  }
  return { cookie: pick.cookie, fa2Key: pick.fa2Key, row: pick.row, total: accounts.length };
}

/**
 * Runs one account end to end, on an already-open Telegram session.
 *
 * Split out of main() so a group can loop it over several rows against ONE
 * session. Everything per-account - the Facebook browser, the ledgers, the
 * cookie pre-flight - stays per-account; only the Telegram connection is shared.
 */
async function runOne(
  job: { file: string; row: number },
  tg: Taskly,
  args: string[],
  phone: string | undefined,
): Promise<boolean> {
  const xlsxFile = job.file;
  const currentPw =
    argValue(args, ["--current-password", "-o"]) ??
    process.env.FB_CURRENT_PASSWORD ??
    SHARED_PASSWORD;
  const resumePw = argValue(args, ["--password", "-P"]);
  const url = resolveUrl();
  const dryRun = args.includes("--probe") || args.includes("--dry-run");
  const listenAfterStart = argValue(args, ["--probe-start"]);

  const pick = resolveRow(xlsxFile, job.row);
  // The sheet is the source of truth for this run: both values, not a mix.
  const fa2Key = pick.fa2Key;
  const cookieString = pick.cookie;
  const fp = fingerprint(cookieString);
  curFp = fp;
  curXlsx = xlsxFile;
  curRow = pick.row;
  log.success(
    `${path.basename(xlsxFile)}: ${pick.total} accounts, using row ${pick.row} (${pick.fa2Key.length}-char key, fp ${fp})`,
  );
  // Never re-send one that already completed. --force is the only way past.
  if (isSent(fp) && !args.includes("--force")) {
    throw new Bail(
      `row ${pick.row} (fp ${fp}) is already in sent.jsonl. Use --force to send it again.`,
    );
  }
  // Gated behind an SMS code to a phone we do not have. Retrying can never
  // work, and it would cost $0.05 plus a bot credential every single time,
  // so bail before Telegram is even contacted.
  if (isSkipped(fp) && !args.includes("--force")) {
    throw new Bail(
      `row ${pick.row} (fp ${fp}) is in skipped.jsonl (SMS-gated). Use --force to try it anyway.`,
    );
  }
  const done = listSent().length;
  const gated = listSkipped().length;
  log.info(`${done} account(s) already completed, ${gated} SMS-gated; neither will be retried`);

  // Pre-flight: one HTTP request, before any browser and before Telegram.
  // A cookie confirmed dead would otherwise cost $0.05 and a bot credential
  // to discover at the login wall. Confirmed twice - a single DEAD reading
  // has been observed to flip to ALIVE minutes later.
  const canProbe = !dryRun && !resumePw && !args.includes("--force");
  if (canProbe && (await isCookieDead(cookieString))) {
    markSkipped({ fp, reason: "cookie confirmed dead at accountscenter", source: xlsxFile, row: pick.row });
    audit({ leg: "internal", what: "cookie", status: "dead-confirmed", fp });
    log.warn("Recorded in skipped.jsonl - no browser opened, nothing spent");
    throw new Bail(
      `row ${pick.row} (fp ${fp}) cookie is dead (confirmed twice). Skipped - use --force to try anyway.`,
    );
  }
  if (canProbe) log.success("Cookie check passed - proceeding");

  if (!currentPw && !dryRun) {
    throw new Bail(
      "Current Facebook password missing. Pass -o <password> or set FB_CURRENT_PASSWORD.",
    );
  }
  if (!fa2Key && !dryRun) {
    throw new Bail("2FA key missing. Pass --fa2 <key> or set FA2_KEY.");
  }
  if (!cookieString) {
    throw new Bail("COOKIE_STRING is not set in .env (needed for the cookie step).");
  }

  // ---- Resume mode: job already started, password already in hand ----
  if (resumePw) {
    if (!currentPw) throw new Bail("Resume mode needs -o <current Facebook password>");
    if (!fa2Key) throw new Bail("Resume mode needs --fa2 <2FA key>");
    log.info("RESUME: job is already started, changing Facebook first");
    log.warn("ensureMainMenu() is deliberately skipped - /start would reset the job");

    const result = await changeFacebook(currentPw, resumePw, url, cookieString);
    if (!result.ok) {
      // Nothing is sent. A failed change must not advance the job.
      throw new Bail(`Facebook did not confirm the change: ${result.verdict}`);
    }
    log.success("Facebook password changed. Now sending the 2FA key.");

    // Uses the session the GROUP already holds. Opening a second client on one
    // session is what earns "Conflict: terminated by other getUpdates request"
    // and kills the loser permanently.
    const keyReplies = await tg.sendRaw("send 2FA key", fa2Key);
    keyReplies.forEach((r) => log.info(`After key: ${r.replace(/\s+/g, " ").slice(0, 300)}`));

    if (keyReplies.some((r) => /cookie/i.test(r))) {
      log.info("Bot asked for a cookie — sending it");
      const cookieReplies = await tg.sendRaw("send cookie", cookieString.trim());
      cookieReplies.forEach((r) =>
        log.info(`After cookie: ${r.replace(/\s+/g, " ").slice(0, 300)}`),
      );
      // The cookie alone does not finish it; the confirm button does.
      if (cookieReplies.some((r) => /confirm registration/i.test(r))) {
        const final = await tg.press("confirm registration", "Account registered");
        final.forEach((r) => log.success(`Final: ${r.replace(/\s+/g, " ").slice(0, 300)}`));
        const received = final.some((r) => /report has been received/i.test(r));
        if (received && fp) {
          markSent({ fp, source: xlsxFile, row: pick.row, job: JOB });
          log.success(`Recorded in sent.jsonl (fp ${fp}) - will not be retried`);
        }
        return received;
      }
      log.warn("No confirmation prompt after the cookie.");
      cookieReplies.forEach((r) => log.warn(`  ${r.replace(/\s+/g, " ").slice(0, 300)}`));
      return false;
    }
    log.warn("Bot did not ask for a cookie. It said:");
    keyReplies.forEach((r) => log.warn(`  ${r.replace(/\s+/g, " ").slice(0, 300)}`));
    return false;
  }

  log.info(`Job: ${GROUP} -> ${JOB}`);
  if (dryRun) {
    log.info("DRY RUN - walks the job and reads the credentials, then stops:");
    log.info(`  1. open @tasklyBux_bot as ${phone ?? "(auto)"}`);
    log.info(`  2. /start, then press "${GROUP}" then "${JOB}" then "Start"`);
    log.info("  3. Send the 2FA key (the bot asks for it first) and read the reply.");
    log.info("  4. Show the first name / last name / password, then STOP.");
    log.info("  Facebook is NOT touched. The cookie is NOT sent.");
    log.warn("Start may already have charged - context.md does not know when.");
  }

  // ---- 1. Walk the provider menus to the job ----
  // The session is already open and owned by the group. Opening one here would
  // be a SECOND client on the same session, which Telegram resolves by killing
  // one of them for good.
  {
    // ---- 2. Start, then the bot asks for our 2FA key FIRST ----
    // Observed 2026-09-29: Start replies "🔑 Please enter your 2FA key to get
    // the code:". The credentials only arrive after the key is sent.
    // Pressing Start produces TWO messages: the credentials, then the 2FA
    // prompt, in the same second. The live handler drops one of them, so read
    // from history - but SCOPED to this Start. An unscoped read returns a
    // credential from an earlier, abandoned run of the same job, which is how
    // row 5 got a stale name and had its password set from it.
    //
    // A single read is not enough. The credential can land a moment after the
    // press returns, and one immediate read turned that into a permanent
    // "no password" bail. So poll for CRED_WAIT_MS, and if the bot never
    // issues one, knock with /start and walk the whole job again rather than
    // sending a key and cookie for a password we do not have.
    let afterStart: ReturnType<typeof parseCreds> = {
      firstName: null,
      lastName: null,
      password: null,
    };
    let startReplies: string[] = [];
    let changedPassword = false;

    for (let attempt = 1; attempt <= MAX_START_ATTEMPTS && !changedPassword; attempt++) {
      if (attempt > 1) {
        log.warn(
          `No password within ${CRED_WAIT_MS}ms of Start - restarting with /start (attempt ${attempt}/${MAX_START_ATTEMPTS})`,
        );
        audit({ leg: "internal", what: "creds", status: "restart", attempt, fp });
        // Back to the top of the funnel: the modal state is now whatever the
        // abandoned Start left behind, so /start is the only reliable reset.
        await tg.sendRaw("restart", "/start");
        await sleep(STEP_MS);
      }

      await tg.ensureMainMenu();
      await sleep(STEP_MS);
      await tg.press("open Tasks", "Tasks");
      await sleep(STEP_MS);
      if (GROUP) await tg.press(`open ${GROUP}`, GROUP);
      await sleep(STEP_MS);
      await tg.press(`open job ${JOB}`, JOB);
      await sleep(STEP_MS);

      const beforeStart = await tg.latestId();
      await tg.press("click Start", "Start");

      const deadline = Date.now() + CRED_WAIT_MS;
      for (;;) {
        startReplies = await tg.freshSince(beforeStart, 6);
        afterStart = parseCreds(startReplies);
        if (afterStart.password) break;
        if (Date.now() >= deadline) break;
        await sleep(250);
      }

      if (!afterStart.password) {
        log.error(`No credentials within ${CRED_WAIT_MS}ms of Start - the bot issued no password`);
        log.info("Bot said:");
        startReplies.forEach((r) => log.info(`  ${r.replace(/\s+/g, " ").slice(0, 200)}`));
        audit({ leg: "internal", what: "creds", status: "missing-at-start", attempt, fp });
        continue;
      }

      if (afterStart.password === currentPw) {
        throw new Bail("bot gave the same password we already have — nothing to change");
      }
      log.success(
        `Bot gave: ${afterStart.firstName ?? "?"} ${afterStart.lastName ?? "?"} / password ${afterStart.password.length} chars`,
      );
      audit({ leg: "internal", what: "creds", status: "at-start", first: afterStart.firstName, last: afterStart.lastName, fp });
      const changed = await changeFacebook(currentPw, afterStart.password, url, cookieString);
      if (!changed.ok) {
        throw new Bail(`Facebook did not confirm the change: ${changed.verdict}`);
      }
      log.success("Facebook password changed to the bot's password");
      changedPassword = true;
    }

    if (!changedPassword) {
      log.info("Not sending the 2FA key or the cookie.");
      audit({ leg: "internal", what: "creds", status: "exhausted", attempts: MAX_START_ATTEMPTS, fp });
      throw new Bail(
        `no password after ${MAX_START_ATTEMPTS} Start attempts - stopped before the 2FA key`,
      );
    }

    if (listenAfterStart) {
      const secs = Number(listenAfterStart);
      log.info(`Start pressed. Listening ${secs}s and sending NOTHING.`);
      startReplies.forEach((r) => log.info(`At Start: ${r.replace(/\s+/g, " ").slice(0, 400)}`));
      const heard = await tg.listen(secs);
      log.info("----- everything that arrived after Start -----");
      (heard.length ? heard : ["(nothing at all)"]).forEach((r) =>
        log.info(r.replace(/\s+/g, " ").slice(0, 600)),
      );
      log.info("-----------------------------------------------");
      const c = parseCreds(heard);
      if (c.password) {
        log.success(`FOUND: ${c.firstName ?? "?"} ${c.lastName ?? "?"} / password ${c.password}`);
      } else {
        log.error("No credentials arrived after Start. Send me this output.");
      }
      return false;
    }

    const wantsKey = startReplies.some((r) => /2fa key/i.test(r));
    if (!wantsKey) {
      log.warn("Bot did not ask for a 2FA key after Start. It said:");
      startReplies.forEach((r) => log.warn(`  ${r.replace(/\s+/g, " ").slice(0, 200)}`));
    }
    if (dryRun) {
      log.info("----- history after Start -----");
      startReplies.forEach((r) => log.info(r.replace(/\s+/g, " ").slice(0, 600)));
      log.info("--------------------------------");
      if (afterStart.password) {
        log.success(`FIRST NAME: ${afterStart.firstName ?? "(none)"}`);
        log.success(`LAST NAME:  ${afterStart.lastName ?? "(none)"}`);
        log.success(`PASSWORD:    ${afterStart.password}`);
      } else {
        log.error("No credentials after Start. Send me the raw text above.");
      }
      log.success("DRY RUN done. Facebook untouched, no key or cookie sent.");
      return false;
    }

    if (!fa2Key) throw new Bail("Bot wants a 2FA key but none was given (--fa2 / FA2_KEY)");

    // ---- 3. Send the 2FA key ----
    // Live capture 2026-09-29: this replies "🍪 Please send the account Cookie:".
    const keyReplies = await tg.sendRaw("send 2FA key", fa2Key);
    log.info(`After the 2FA key, bot said ${keyReplies.length} message(s)`);

    // ---- 4. Send the cookie ----
    if (!keyReplies.some((r) => /cookie/i.test(r))) {
      log.warn("Bot did not ask for a cookie. It said:");
      keyReplies.forEach((r) => log.warn(`  ${r.replace(/\s+/g, " ").slice(0, 300)}`));
      throw new Bail("expected a cookie prompt after the 2FA key, got something else");
    }
    log.info("Sending the cookie");
    const cookieReplies = await tg.sendRaw("send cookie", cookieString.trim());
    cookieReplies.forEach((r) => log.info(`After cookie: ${r.replace(/\s+/g, " ").slice(0, 300)}`));

    // ---- 5. Press the confirmation button ----
    // Live capture: the cookie does NOT finish the job. The bot then waits for
    // the "✅ Account registered" button. Without this the task hangs.
    if (cookieReplies.some((r) => /confirm registration/i.test(r))) {
      const final = await tg.press("confirm registration", "Account registered");
      final.forEach((r) => log.success(`Final: ${r.replace(/\s+/g, " ").slice(0, 300)}`));
      const received = final.some((r) => /report has been received/i.test(r));
      if (received) {
        log.success("Job confirmed: report received");
        // Only now is it safe to record it, so a failed run is retried.
        if (fp) {
          // pick.row, NOT --row: in group mode this child was given several
          // rows and --row is absent, so the old lookup recorded row 1 for
          // every account and the ledger stopped matching the sheet.
          markSent({ fp, source: xlsxFile, row: pick.row, job: JOB });
          log.success(`Recorded in sent.jsonl (fp ${fp}) - will not be retried`);
        }
        audit({ leg: "internal", what: "job", status: "received", fp });

        // Credentials are issued at Start, NOT during the review - proven on
        // row 9, which had them in hand before the password change. The 64
        // minute review produces no credentials, so waiting is off by default.
        const minutes = Number(argValue(args, ["--wait-minutes"]) ?? "0");

        if (minutes > 0) {
          const deadline = Date.now() + minutes * 60_000;
          const seen: string[] = [];
          let got = parseCreds(seen);

          while (!got.password && Date.now() < deadline) {
            const chunk = await tg.listen(60); // a minute at a time, so it prints
            seen.push(...chunk);
            got = parseCreds(seen);
            if (got.password) break;
            const left = Math.max(0, Math.round((deadline - Date.now()) / 60_000));
            log.info(`No credentials yet. ${left} min left.`);
          }

          if (got.password) {
            log.success(
              `Credentials arrived late: ${got.firstName ?? "?"} ${got.lastName ?? "?"}`,
            );
            audit({ leg: "internal", what: "creds", status: "late", first: got.firstName, last: got.lastName, fp });
            const changed = await changeFacebook(currentPw, got.password, url, cookieString);
            if (!changed.ok) throw new Bail(`Facebook did not confirm: ${changed.verdict}`);
          } else {
            log.warn(`No credentials within ${minutes} min. Nothing was changed.`);
            audit({ leg: "internal", what: "creds", status: "timeout", minutes, fp });
          }
        }
      } else {
        log.warn("Confirmation sent, but no 'report received' in the reply");
        audit({ leg: "internal", what: "job", status: "unconfirmed", fp });
      }
    } else {
      log.warn("No confirmation prompt after the cookie. It said:");
      cookieReplies.forEach((r) => log.warn(`  ${r.replace(/\s+/g, " ").slice(0, 300)}`));
    }
  }
  return true;
}

// Only run when invoked directly. Importing this module must not start a run,
// or a test that imports parseRows() would launch a paid batch as a side effect.
// Same guard TG.ts uses.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
  // A permanent block (SMS gate, or a sheet stuck on 'Loading') is recorded here
  // - the single place every failure exits through - so the row is skipped on
  // later runs instead of costing $0.05 and a bot credential every time.
  //
  // Matched by TYPE. This used to test the message text against
  // /sms confirmation code/i, which meant rewording the log line would silently
  // stop every gate from being recorded - each of those rows costing $0.05 and a
  // credential to rediscover, on every run, forever. The text test is kept only
  // as a net for a gate raised by an older child process.
  const gated = err instanceof BailGated || /sms confirmation code|never left 'Loading/i.test(err?.message ?? "");
  if (gated && curFp) {
    markSkipped({ fp: curFp, reason: (err.message ?? "gated").slice(0, 200), source: curXlsx, row: curRow });
    audit({ leg: "internal", what: "gated", status: "sms-required", fp: curFp });
    log.warn("Recorded in skipped.jsonl - this account will not be retried");
  } else if (!curFp) {
    // A permanent block with no fingerprint could not be recorded, so it WILL be
    // retried. Say so rather than letting it look like it was saved.
    log.error("Could not record the skip: no fingerprint for this row. It will be retried next run.");
  }
  // BailLogged already printed its reason and a screenshot path.
  if (!(err instanceof BailLogged)) log.error(err.message);
  process.exit(1);
  });
}
