import { chromium } from "playwright";
import { config } from "dotenv";
import path from "path";
import fs from "node:fs";
import os from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "url";
import { spawnSync } from "node:child_process";
import * as XLSX from "xlsx";
import chalk from "chalk";
import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Everything that is not code lives under ./data: the sheets, the Telegram
// sessions, the credentials, the docs, the archive and the ledgers. One place
// to look, one rule for gitignore.
const DATA_DIR = path.join(__dirname, "data");
const OUT_DIR = path.join(DATA_DIR, "out");
// Pointed at data/.env explicitly. Bare config() only looks in the CWD, so
// moving the file into data/ silently emptied the environment - which showed up
// as "Several sessions exist, pass -p <phone>" rather than as a missing .env.
config({ path: path.join(DATA_DIR, ".env") });

// ---- Config ----
const GROUP = process.env.TASK_GROUP ?? "Cookies";
const JOB = process.env.TASK_NAME ?? "2FA:Create FB (No mail)";
// Read from .env only. This was once a hardcoded literal fallback, which put a
// live Facebook password into 15 commits of source. An empty value is not a
// problem here: the only consumer is the password-change step, which already
// refuses to run without it (see requirePassword).
const SHARED_PASSWORD = process.env.FB_CURRENT_PASSWORD ?? "";
const CRED_WAIT_MS = 5_000;
const STEP_MS = 1_000;
const PER_SESSION = 3;
const ACCOUNT_GAP_MS = 2_000;
const MAX_START_ATTEMPTS = 3;
const MAX_REUSE = 3; // one bot password covers at most 3 cookies, 1 success
const QUIET_MS = 2000;
const HARD_MS = 60_000;
const THROTTLE_MS = 1000;
const POLL_MS = 500;
const WAIT_MS = 60_000;
const PROBE_URL = "https://accountscenter.facebook.com/profiles";
const PROBE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
const DEVICES_PHONE = {
  userAgent: PROBE_UA,
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
};

// How the browser starts, so the same code runs on a desktop and in a container.
//
// On a desktop: headed, real Chrome (channel "chrome"). That is the only
// combination every measurement in this file was taken under, and Facebook
// detection is the thing that costs accounts, so it is what we keep.
//
// In a container there is no display, so headed Chrome cannot start at all, and
// "chrome" means installing a second 400MB browser that the Playwright base
// image does not ship. So the container uses headless with the bundled Chromium.
//
// HEADLESS IS LESS STEALTHY. That is a real risk, not a formality: switching to
// it is the most likely way to get an account flagged, and the accounts are the
// product. It is behind an env var rather than hardcoded so the desktop path
// stays byte-for-byte what was tested.
const HEADLESS = process.env.FB_HEADLESS === "1";
const BROWSER_CHANNEL = process.env.FB_CHANNEL || undefined; // undefined = Playwright's bundled Chromium
const launchBrowser = () =>
  chromium.launch({ headless: HEADLESS, channel: BROWSER_CHANNEL, args: LAUNCH_ARGS });

// Ephemeral browser, fresh context, every single run. This used to be
// launchPersistentContext against a shared ./profile folder, and that was a
// real bug: clearCookies() clears COOKIES ONLY. localStorage, IndexedDB, cache,
// service workers and visited links all survived, so leftover state from one
// account was readable during the next account's run, and every account shared
// one Chrome client-id / storage fingerprint. Playwright's own guidance for
// "start from scratch or cleanup in between" says cleanup is easy to forget and
// some things are impossible to clean up, such as visited links - so the fix
// is not to clean harder, it is to not share.
//
// Rationale and sources were kept in data/doc/profile-reuse.md, deleted on request.
//
// The old ./profile folder has been deleted - 68MB of shared storage that
// nothing reads any more.
const LAUNCH_ARGS = [
  "--disable-blink-features=AutomationControlled",
  // No --hide-crash-restore-bubble: that existed only because a shared
  // profile folder could be left with exit_type=Crashed, which produced a
  // "Restore pages?" bubble over the page being driven. With no folder there
  // is nothing to be left behind, so the flag and the crash-flag patch it
  // needed are both gone.
];

// navigator.webdriver is still true even with the Blink feature flag off, so
// any page that reads the property sees us. The old FAF bot set both; we only
// had the flag. Cheap, and it is the one stealth measure that does not require
// guessing at Facebook's heuristics.
const STEALTH_INIT = () => {
  Object.defineProperty(Navigator.prototype, "webdriver", { get: () => false, configurable: true });
};

// ---- Log ----
//
// Every line goes to the console AND to a file. The console is what you watch;
// the file is what you still have tomorrow.
//
// That matters more than it sounds for this tool. A run is ~16 hours and dies in
// a terminal scrollback: the evidence of what a verdict actually said, what a
// rate limit demanded, or which account was half-used is gone the moment the
// window closes, and the one thing that cannot be reconstructed afterwards is
// what the provider said.
//
// One file per process, named for the command and the pid, because runBatch
// spawns a child per group and 47 children writing one shared file interleave
// into something unreadable - the same shape of bug as the old shared
// pending.json. Separate files cannot interleave.
//
// Appended, never truncated: a file from this morning is still valid evidence.
// NEVER any credential - cookies and 2FA keys are the reason this file is safe
// to keep at all, and audit() already refuses to record them.
const LOG_DIR = path.join(DATA_DIR, "out", "logs");
const logStream = (() => {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    // A short name, so the file is identifiable: what was run, on which session.
    const cmd = (process.argv.slice(2).find((a) => !a.startsWith("-")) ?? "run").replace(/[^\w.-]/g, "");
    const sess = process.env.TG_PHONE ? `-${process.env.TG_PHONE.slice(-4)}` : "";
    const file = path.join(LOG_DIR, `${stamp}-${cmd}${sess}-${process.pid}.log`);
    // 'a' so an existing file is never emptied, which is what a crash mid-write
    // followed by a restart would otherwise cause.
    const fd = fs.openSync(file, "a");
    return { file, fd };
  } catch {
    // A log that cannot be opened must NEVER stop a run. Console still works.
    return null;
  }
})();

// Anything that could be a credential is refused here, not at each call site.
// A cookie is name=value pairs; a 2FA key is a block of base32. Both are
// already kept out of audit(), and this is the belt to that braces.
const SECRETISH = /\b(c_user=|datr=|xs=|sb=|fr=|pas=|wd=|ps_l=)|(^|\s)([A-Z2-7]{4}\s){4,}[A-Z2-7]{4}\b/i;
function toFile(level, m) {
  if (!logStream) return;
  try {
    const text = String(m ?? "").replace(/\s+/g, " ").trim();
    // The label is kept, the message is dropped, so a leak can never land in the
    // file even if a caller passes something it should not have.
    fs.writeSync(logStream.fd, `${new Date().toISOString()} ${level} ${SECRETISH.test(text) ? "[redacted: looked like a credential]" : text}\n`);
  } catch { /* never fail a run over a log line */ }
}

const emit = (label, level, m) => {
  console.log(chalk.blue(label), chalk.white(m));
  toFile(level, m);
};
export const log = {
  info: (m) => emit("INFO", "INFO", m),
  success: (m) => emit("SUCCESS", "OK", m),
  error: (m) => emit("ERROR", "ERROR", m),
  warn: (m) => emit("WARN", "WARN", m),
  // Off unless TOOL_DEBUG is set, so the per-tick wait tracing does not drown
  // the run by default.
  debug: (m) => { if (process.env.TOOL_DEBUG) { console.log(chalk.gray("DEBUG"), chalk.gray(m)); toFile("DEBUG", m); } },
};
const tlog = {
  info: (m) => emit("TG", "INFO", m),
  ok: (m) => emit("TG", "OK", m),
  err: (m) => emit("TG", "ERROR", m),
  raw: (m) => { if (process.env.TOOL_DEBUG) { console.log(chalk.gray("TG"), chalk.gray(m)); toFile("DEBUG", m); } },
};
const T0 = Date.now();
const elapsed = () => `${((Date.now() - T0) / 1000).toFixed(1)}s`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Errors ----
export class Bail extends Error {}
export class BailLogged extends Bail {}
export class BailGated extends BailLogged {}

// ---- Args ----
export function argValue(args, names) {
  for (const a of args)
    for (const n of names) if (a.startsWith(n + "=")) return a.slice(n.length + 1);
  for (const n of names) {
    const i = args.indexOf(n);
    if (i !== -1 && args[i + 1] && !args[i + 1].startsWith("-")) return args[i + 1];
  }
  return undefined;
}
function argValues(args, name) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith(name + "=")) {
      out.push(...a.slice(name.length + 1).split(",").map((s) => s.trim()).filter(Boolean));
      continue;
    }
    if (a !== name) continue;
    while (args[i + 1] && !args[i + 1].startsWith("-"))
      out.push(...args[++i].split(",").map((s) => s.trim()).filter(Boolean));
  }
  return out;
}
export function parseRows(raw) {
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean).map((s) => {
    const i = s.lastIndexOf("#");
    if (i < 0) throw new Bail(`bad --rows entry "${s}" (want file.xlsx#row)`);
    return { file: s.slice(0, i), row: Number(s.slice(i + 1)) };
  });
}

// ---- Ledgers (./out) ----
export function fingerprint(cookie) {
  return createHash("sha256").update(cookie.trim()).digest("hex").slice(0, 12);
}
// ---- The ledger: Postgres, not files ----
//
// These were JSON files (sent.jsonl, skipped.jsonl, used-passwords.json,
// pending.json) and that is precisely what stopped several processes running at
// once. pending.json in particular was read-modify-write: two processes each
// read the queue, each appended a row, and the second write erased the first
// one's row. That is the 38-vs-37 verdict bug one level down, except it loses
// submissions rather than mis-filing them.
//
// The same names are kept on purpose: the call sites are unchanged, so the diff
// is the storage and not a rewrite. Reads stay SYNCHRONOUS off a set loaded once
// at startup, because they sit inside a .filter() and a per-row loop; a database
// round trip per row would be slower and no safer. Writes go to Postgres
// immediately, because that is where the correctness is.
const ledgerDb = { sent: new Set(), skipped: new Set(), ready: false };

// Called once before any row is touched. Also ADOPTS the old JSON ledgers, so
// the accounts already sent and the ones already known dead carry over instead
// of being offered for sale a second time.
export async function ledgerLoad({ adopt = true } = {}) {
  const db = await import("./db.js");
  await db.migrate();
  const known = await db.sheetKnown();
  ledgerDb.sent = known.sent;
  ledgerDb.skipped = known.skipped;

  // The legacy jsonl files are UNIONED into the in-memory sets, always.
  //
  // This is not belt-and-braces, it is the thing that stops accounts being sold
  // twice. markSheetSent is an UPDATE by fingerprint, so for the ~67 accounts
  // sent BEFORE this table existed it matches nothing and silently records
  // nothing - the row is simply not there. Relying on the database alone would
  // therefore report every one of those accounts as never sent, and the very
  // next run would submit all of them again.
  const legacySent = readJsonl(SENT_FILE);
  const legacySkip = readJsonl(SKIP_FILE);
  let fromDb = ledgerDb.sent.size;
  for (const r of legacySent) ledgerDb.sent.add(r.fp);
  for (const r of legacySkip) ledgerDb.skipped.add(r.fp);

  // Best-effort copy into the database for a future run's benefit. Never fatal:
  // the in-memory union above is already correct on its own, and a failure here
  // must not stop accounts being submitted.
  if (adopt) {
    for (const r of legacySent) {
      await db.markSheetSent(r.fp, r.phone ?? "", r.source, r.row).catch(() => {});
    }
    for (const r of legacySkip) {
      await db.markSheetSkipped(r.fp, r.reason ?? "adopted from skipped.jsonl", r.source, r.row).catch(() => {});
    }
  }
  ledgerDb.ready = true;
  return { sent: ledgerDb.sent.size, skipped: ledgerDb.skipped.size, fromDb, legacy: legacySent.length + legacySkip.length };
}

const isSent = (fp) => ledgerDb.sent.has(fp);
const isSkipped = (fp) => ledgerDb.skipped.has(fp);

// Await these. Fire-and-forget would reintroduce exactly the bug the database
// removed: the process could exit with the write still in flight.
async function markSent(rec) {
  ledgerDb.sent.add(rec.fp);
  const db = await import("./db.js");
  await db.markSheetSent(rec.fp, rec.phone ?? "", rec.source, rec.row);
}
async function markSkipped(rec) {
  if (ledgerDb.skipped.has(rec.fp)) return;
  ledgerDb.skipped.add(rec.fp);
  const db = await import("./db.js");
  await db.markSheetSkipped(rec.fp, rec.reason ?? "", rec.source, rec.row);
}

// The old JSON ledgers. Still read, never written: ledgerLoad() adopts them into
// Postgres once so nothing already sent or already dead is offered for sale
// again. Delete them only after a run has completed with the database ledger.
const SENT_FILE = path.join(OUT_DIR, "sent.jsonl");
const SKIP_FILE = path.join(OUT_DIR, "skipped.jsonl");
function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter((r) => !!r?.fp);
}
const hashPw = (pw) => createHash("sha256").update(String(pw)).digest("hex");
// A CLAIM, not a check. isPasswordUsed() followed by markPasswordUsed() was a
// race: two processes could both see a password as free and both apply it to a
// Facebook account. The primary key on used_passwords decides it instead.
const isPasswordUsed = async (pw) => (await import("./db.js")).passwordClaimed(hashPw(pw));
async function markPasswordUsed(pw) {
  const db = await import("./db.js");
  if (!(await db.claimPassword(hashPw(pw)))) throw new Error("that password is already in use on another account");
}

// ---- Audit (./out/audit-YYYY-MM-DD.jsonl) ----
function audit(rec) {
  try {
    const dir = OUT_DIR;
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, `audit-${new Date().toISOString().slice(0, 10)}.jsonl`);
    fs.appendFileSync(f, JSON.stringify({ at: new Date().toISOString(), ...rec }) + "\n", "utf8");
  } catch { /* audit never fails the run */ }
}
const preview = (t, n = 300) => String(t ?? "").replace(/\s+/g, " ").slice(0, n);

// ---- What the provider says back ----
// All four of these are real messages, captured from 1000 messages of history
// across both sessions. Each one used to be an unexplained failure.

// "You are making requests too often. Please wait 9 sec."  (seen 2, 4 and 9)
// It REPLACES the reply we were waiting for, so the account was still there and
// we gave up on it for nothing. It states the wait, so there is nothing to guess.
const RATE_LIMIT = /too often\.?\s*please wait\s*(\d+)\s*sec/i;

// Telegram's OWN flood limit, which is a completely different message thrown by
// the library rather than sent by the provider:
//   "A wait of 705 seconds is required (caused by messages.SendMessage)"
// It arrives as an exception from sendMessage, so it was never seen by
// rateLimitSeconds() and every call site treated it as an ordinary failure. The
// run that hit this burned 66 accounts: the provider's polite "please wait" was
// caught, Telegram's hard flood was not. Both are a stop.
const TG_FLOOD = /a wait of (\d+) seconds is required/i;

// Exit codes. 75 is EX_TEMPFAIL, and it means exactly that: the work is fine,
// the provider is not ready, come back later. The batch parent keys on it to
// stop spawning instead of feeding the rest of the queue into the same wall.
const EXIT_RATE_LIMITED = 75;
const floodWaitSeconds = (e) => Number(String(e?.message ?? e ?? "").match(TG_FLOOD)?.[1] ?? 0) || 0;

// "Time's up! Task cancelled."  (seen 4 times)
// The PROVIDER's own timer, not ours, and how long it allows has been observed
// anywhere from a minute to about eight. So no duration is assumed anywhere in
// this file - only this message is matched. When it appears the account is
// already lost; the only useful thing is to say so plainly instead of
// reporting a confusing generic failure.
const TASK_CANCELLED = /time'?s up!?\s*task cancelled/i;

// "Action cancelled."  (seen 2 times)
// This one is OURS and it is expected: it is the confirmation that the
// Cancel button we press to clear a modal state did its job (ensureMainMenu
// does exactly that). It is NOT a rejected report and NOT a provider timeout -
// do not let the two "cancelled" messages be confused for each other.
const ACTION_CANCELLED = /action cancelled/i;

// "Report approved, +$0.05" / "Report rejected..."  (39 / 4)
const VERDICT_APPROVED = /report\s+approved/i;
const VERDICT_REJECTED = /report\s+rejected/i;

// ---- Two facts recorded, deliberately NOT acted on ----
//
// 1. The job card's "Report instruction:" field arrives EMPTY ("Report
//    instruction: ."). There is no instruction to follow. Do not go looking for
//    one, and do not fail a run over it.
//
// 2. The provider's rejection text carries a standing rule we must not break:
//      "after registration, you must NOT log out of the account, otherwise the
//       cookies become invalid automatically. You should clear your browser
//       history and cookies after registration, but stay logged into the
//       account."
//    Every run does clearCookies() and then addCookies() with the sheet's
//    cookie, which is exactly "clear cookies but stay logged in", so the
//    current behaviour is already correct. This note is here so nobody tidies
//    the per-run cookie reload into a persistent login, or shares one browser
//    session across accounts, and silently invalidates every cookie.

function rateLimitSeconds(replies) {
  for (const t of Array.isArray(replies) ? replies : [replies]) {
    const m = String(t ?? "").match(RATE_LIMIT);
    if (m) return Number(m[1]);
  }
  return 0;
}
// Exported so it can be run against real provider history, which is a better
// test than the hand-written samples in --selftest.
export function parseVerdict(text) {
  const t = String(text ?? "");
  if (VERDICT_APPROVED.test(t)) return { verdict: "approved", amount: t.match(/\$([\d.]+)/)?.[1] ?? null };
  if (VERDICT_REJECTED.test(t)) {
    return { verdict: "rejected", reason: t.replace(/\s+/g, " ").trim().slice(0, 300), accountBlocked: /account blocked/i.test(t) };
  }
  return null;
}

// ---- Verdict ledger (./out) ----
// "Your report has been received! Please wait" is a RECEIPT, not a decision.
// The decision arrives unprompted up to ~64 minutes later, and in the captured
// history 7 of them landed in the middle of an unrelated action. So the
// listener is permanent for the whole session, not attached per exchange.
//
// The hard part: a verdict carries NO identifier. No uid, no row number,
// nothing - just "Report approved, +$0.05". The only mapping available is
// order: the oldest unanswered submission takes the next verdict.
//
// Order is only meaningful WITHIN one Telegram session. There are two sessions,
// both talking to the same bot, and each one's verdicts come back on its own
// account. A single shared queue mixed them: a verdict arriving on session A
// used to shift whatever sat at the front, even if session B had submitted it.
// That is not theoretical - it is what made 2fa43 read as 38 approved when the
// provider's own balance proved 37 (37 x $0.05 = the $1.85 withdrawn). Measured
// on the captured history: session ...1929 is self-contained (39 submissions ->
// 39 verdicts, delays all 64-66 min), while session ...2634 received 12
// verdicts for 8 submissions, 4 of which had negative delays against a global
// pairing - impossible, so they belong to submissions that are not in our data
// at all.
//
// So every entry records the session it went out on, and a verdict only ever
// claims an entry from its OWN session. If that session has nothing waiting, the
// verdict is recorded unmatched rather than consuming somebody else's row.
// The verdict pairing now lives in Postgres (db.js bindSheetVerdict), which is
// where it can be made safe for several processes at once. savePending() wrote
// the WHOLE queue back on every single change, so two processes each read the
// queue and each appended one row, and the second write erased the first one's
// submission. That is this file's whole remaining purpose: kept only so
// --selftest can drive the pure pairing logic against a temp dir, and as the
// one-time source for adopting pending.json into the database.
//
// Nothing on the live path calls it. The verdict watcher goes through the db sink
// (Taskly.open({verdictSink: "db"})), which calls bindVerdict/bindSheetVerdict -
// both single-statement, both SKIP LOCKED, both scoped to their own session.
const PENDING_FILE = path.join(OUT_DIR, "pending.json");
const VERDICTS_FILE = path.join(OUT_DIR, "verdicts.jsonl");
function loadPending(file = PENDING_FILE) {
  try {
    const a = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(a) ? a : [];
  } catch { return []; }
}
function savePending(list, file = PENDING_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(list, null, 1), "utf8");
}
// The moment the provider acknowledges a report. Now a single INSERT ... ON
// CONFLICT DO NOTHING against sheet_rows: same "called exactly once per report"
// contract, but the duplicate check is the primary key rather than a hopeful read.
async function noteSubmission({ fp, source, row, phone = null }, file = null) {
  // A file argument means --selftest, which drives the pairing logic in a temp
  // dir and must not touch the real database. No argument means the live path.
  if (file) {
    const list = loadPending(file);
    list.push({ at: new Date().toISOString(), fp, source, row, phone });
    savePending(list, file);
    return list.length;
  }
  const db = await import("./db.js");
  await db.markSheetSent(fp, phone ?? "", source, row);
  return fp;
}
// phone is the session the verdict arrived on, and the pairing is db.js's
// problem now - see the note above. This function survives for the legacy jsonl
// sink and for the selftest; the db sink never comes through here.
function recordVerdict(v, phone = null, pendingFile = PENDING_FILE, verdictsFile = VERDICTS_FILE) {
  const list = loadPending(pendingFile);
  let idx = -1;
  if (phone) idx = list.findIndex((e) => e.phone === phone);
  const claim = idx === -1 ? null : list.splice(idx, 1)[0];
  if (idx !== -1) savePending(list, pendingFile);
  const rec = { at: new Date().toISOString(), ...v, session: phone, claim, matched: !!claim };
  fs.mkdirSync(path.dirname(verdictsFile), { recursive: true });
  fs.appendFileSync(verdictsFile, JSON.stringify(rec) + "\n", "utf8");
  return rec;
}
function listVerdicts() {
  if (!fs.existsSync(VERDICTS_FILE)) return [];
  return fs.readFileSync(VERDICTS_FILE, "utf8").split(/\r?\n/).filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((r) => r && r.verdict);
}

// Is the job listed right now? Reuses an already-open connection.
// Returns {on: true|false|null, rateLimited, waitSec, ...}.
//
// null means "could not tell" and MUST NOT stop a run - only a definitive
// absence of the job is a reason to stop, because a flaky network is not
// evidence that the provider delisted anything.
//
// A RATE LIMIT is a different animal entirely and used to be filed as `on: null`
// with the same "carrying on anyway" treatment. That cost 66 accounts in one
// minute: the provider said "wait 705 seconds", the child carried on into it,
// died on its very next send, and the parent spawned the next 22 groups into
// the same wall. `rateLimited` is now its own field so it can never again be
// mistaken for uncertainty - it is a definite STOP, carrying the exact wait.
async function taskAvailability(tg) {
  try {
    await tg.obeyRateLimit(await tg.ensureMainMenu());
    await sleep(STEP_MS);
    await tg.obeyRateLimit(await tg.press("open Tasks", "Tasks"));
    await sleep(STEP_MS);
    const opened = await tg.obeyRateLimit(await tg.press(`open ${GROUP}`, GROUP));
    if (opened.waited) return { on: null, rateLimited: true, waitSec: opened.waited, listed: [], why: "rate limited opening the group" };
    await sleep(STEP_MS);
    const all = tg.labels();
    const listed = all.filter((l) => l.toLowerCase().includes(JOB.toLowerCase()));
    return { on: listed.length > 0, listed, all };
  } catch (e) {
    const flood = floodWaitSeconds(e);
    if (flood) return { on: null, rateLimited: true, waitSec: flood, listed: [], why: e?.message ?? String(e) };
    return { on: null, listed: [], why: e?.message ?? String(e) };
  }
}

// --check-task: report the availability of the job we sell. Nothing is started,
// nothing is spent - but the list churns within a day, and "absent" is not
// "free", it means the catalogue must resolve to nothing.
//
// The price is shown because this is an operator tool, not a user-facing
// message: it is our cost and the basis of our margin. It is never shown to an
// end user anywhere in this file.
async function runCheckTask() {
  const phone = argValue(process.argv.slice(2), ["--phone", "-p"]) ?? process.env.TG_PHONE;
  const tg = await Taskly.open({ phone });
  try {
    const a = await taskAvailability(tg);
    if (a.on === null) {
      log.error(`Could not read the job list (${a.why}). Not proof of anything - try again.`);
      return 1;
    }
    log.info(`group "${GROUP}" lists: ${a.all.join(" | ") || "(no buttons)"}`);
    if (!a.on) {
      log.error(`OFF: "${JOB}" is not listed under ${GROUP}. Users would see "no jobs available" - that is correct, not a bug.`);
      const others = (a.all ?? []).filter((l) => /\$[\d.]+/.test(l) && !l.toLowerCase().includes(GROUP.toLowerCase()));
      if (others.length) log.info(`listed instead: ${others.join(" | ")}`);
      return 1;
    }
    for (const label of a.listed) {
      const price = label.match(/\$([\d.]+)/)?.[1];
      log.success(`ON: "${label}"`);
      if (price) {
        const sell = readSellPrice();
        log.info(`  provider price: $${price}  |  we sell: ${sell != null ? sell + "tk" : "(not set)"}`);
        if (sell != null && process.env.BDT_RATE) {
          const cost = Number(price) * Number(process.env.BDT_RATE);
          log.warn(`  cost ~${cost.toFixed(2)}tk vs ${sell}tk sell -> ${cost > sell ? "SELLING AT A LOSS" : "margin " + (sell - cost).toFixed(2) + "tk"}`);
        }
      }
    }
    return 0;
  } finally {
    await tg.close();
  }
}
function readSellPrice() {
  try {
    const f = path.join(__dirname, "task.json");
    if (!fs.existsSync(f)) return null;
    const cat = JSON.parse(fs.readFileSync(f, "utf8"));
    const list = Array.isArray(cat) ? cat : cat.tasks ?? [cat];
    return list.find((t) => JSON.stringify(t).includes(JOB))?.sell_bdt ?? null;
  } catch { return null; }
}

// --check-verdicts: what actually happened to everything we sent.
//
// The counts here come from verdicts.jsonl and sent.jsonl, and BOTH are frozen:
// the live writes go to postgres, so these files stopped moving at 07:17 and
// reported 67 sent when the ledger already held 69. Printing a stale number as
// though it were current is worse than printing nothing - it looks authoritative.
//
// So the ledger is asked instead, and the file is only used for the per-report
// rejection detail it uniquely holds. Anything countable is counted in one place.
//
// For the count that actually decides whether this business works, use
// --count-from-chat: it reads the provider's own words and needs no pairing at
// all. It is what proved 2fa43 was 38 approved, not 37.
async function checkVerdicts() {
  const v = listVerdicts();
  const approved = v.filter((r) => r.verdict === "approved");
  const rejected = v.filter((r) => r.verdict === "rejected");
  const unmatched = v.filter((r) => !r.matched);
  log.warn("verdicts.jsonl has been frozen since the ledger moved to postgres - these counts are HISTORICAL.");
  log.info(`verdicts recorded : ${v.length}`);
  log.info(`  approved        : ${approved.length}  ${approved.reduce((s, r) => s + Number(r.amount ?? 0), 0).toFixed(4)}`);
  log.info(`  rejected        : ${rejected.length}`);
  log.info(`  unmatched       : ${unmatched.length}${unmatched.length ? " - more verdicts than submissions, the queue was empty" : ""}`);
  for (const r of rejected) {
    const who = r.claim ? `${path.basename(r.claim.source ?? "")}:${r.claim.row ?? "?"} (fp ${r.claim.fp})` : "UNMATCHED";
    log.warn(`rejected: ${who}  ${r.accountBlocked ? "[says ACCOUNT BLOCKED] " : ""}${(r.reason ?? "").slice(0, 90)}`);
  }
  const blocked = rejected.filter((r) => r.accountBlocked && r.claim);
  if (blocked.length) {
    log.warn(`${blocked.length} rejected report(s) say the account was blocked.`);
    log.info("They are NOT auto-skipped: the pairing is FIFO, and a wrong pairing would skip a good account.");
    log.info("Fingerprints: " + blocked.map((r) => r.claim.fp).join(", "));
  }
  // The live numbers, from the one place that is still being written.
  const dbm = await import("./db.js");
  try {
    const c = await dbm.sheetCounts();
    log.success(`LIVE ledger: ${c.inflight} awaiting a verdict, ${c.approved} approved, ${c.rejected} rejected, ${c.queued} queued`);
  } catch {
    log.warn("Could not reach the ledger - the live counts above are unavailable.");
  } finally {
    await dbm.closeDb();
  }
  log.info("For the count you should trust: bun index.js --count-from-chat");
  return 0;
}

// ---- xlsx ----
function resolveFile(f) {
  if (fs.existsSync(f)) return f;
  const inData = path.join(__dirname, "data", path.basename(f));
  if (fs.existsSync(inData)) return inData;
  throw new Bail(`no such file: ${f} (also tried ${inData})`);
}
export function readAccounts(file) {
  const real = resolveFile(file);
  const wb = XLSX.readFile(real);
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) throw new Bail(`${file} has no sheets`);
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false });
  const out = [];
  rows.forEach((r, i) => {
    const cookie = String(r?.[0] ?? "").trim();
    const fa2Key = String(r?.[1] ?? "").replace(/\s+/g, "");
    if (cookie && fa2Key) out.push({ row: i + 1, cookie, fa2Key });
  });
  if (!out.length) throw new Bail(`${file} had no usable rows (need cookie + 2FA key)`);
  return out;
}

// ---- Cookie probe (no browser, no Telegram spend) ----
export function parseCookies(cookieString, domain) {
  return cookieString.split(";").map((pair) => {
    const [name, ...rest] = pair.trim().split("=");
    return { name, value: rest.join("="), domain, path: "/" };
  });
}
export function resolveUrl() {
  const url = process.env.TARGET_URL;
  if (!url) throw new Bail("TARGET_URL is not set in .env");
  return url;
}
// ---- Account liveness (the UID check) ----
// check.fb.tools answers "is this account still alive" from the UID alone, with
// no cookie and no browser. Same endpoint SheetSubmit's worker calls.
//
// It runs BEFORE the cookie probe on purpose. The cookie probe costs a request
// to Facebook and a 3s confirmation wait, and it can only ever say the SESSION
// is dead - which is true of a banned account too. The UID check answers the
// question that actually matters: is the ACCOUNT still there. A dead UID is
// permanent, so the row is skipped outright instead of being retried forever.
const UID_CHECK_URL = process.env.CHECK_URL ?? "https://check.fb.tools/api/check/facebook";
const uidOf = (cookie) => cookie.match(/c_user=(\d+)/)?.[1] ?? null;
// The UID identifies an account, so it is masked in logs the same way a cookie
// is - only ever shown in full to the checker itself.
const maskUid = (uid) => (uid ? `***${uid.slice(-4)}` : "(none)");

// "valid" | "dead" | "unknown". Anything unreadable is "unknown" and must NOT
// be treated as dead: guessing here throws away a working account.
export async function checkUids(uids) {
  const out = new Map();
  const list = [...new Set(uids.filter(Boolean))].slice(0, 500);
  if (!list.length) return out;
  try {
    const res = await fetch(UID_CHECK_URL, {
      method: "POST",
      headers: { accept: "application/x-ndjson", "content-type": "application/json" },
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({ inputData: list, userLang: "en", checkFriends: false }),
    });
    if (!res.ok) { log.warn(`UID check responded ${res.status} - treating as unknown`); return out; }
    const text = await res.text();
    if (text.length > 1_000_000) { log.warn("UID check response too large - ignoring"); return out; }
    for (const line of text.split("\n")) {
      // SheetSubmit does the same: the stream prefixes each record.
      const i = line.indexOf("{");
      if (i === -1) continue;
      try {
        const x = JSON.parse(line.slice(i));
        const seen = String(x?.data?.uid || x?.data?.account || "");
        if (!seen) continue;
        out.set(seen, { status: x?.data?.status?.name === "valid" ? "valid" : "dead", message: x?.data?.status?.message });
      } catch { /* not a JSON line */ }
    }
  } catch (e) {
    log.warn(`UID check failed: ${e?.message ?? e} - treating as unknown`);
  }
  return out;
}
export async function checkUid(cookie) {
  const uid = uidOf(cookie);
  if (!uid) return { uid: null, status: "unknown" };
  const hit = (await checkUids([uid])).get(uid);
  return hit ? { uid, status: hit.status, message: hit.message } : { uid, status: "unknown" };
}

// Exported so a sweep over many cookies can see ALIVE / DEAD / UNKNOWN
// separately. isCookieDead() folds them into a boolean, where UNKNOWN reads as
// "not dead" - correct for a single account in a run, but it would report
// rate-limited or checkpointed cookies as healthy in a bulk check.
export async function probeOnce(cookie) {
  try {
    const res = await fetch(PROBE_URL, {
      headers: {
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        cookie,
        "sec-ch-ua-mobile": "?1",
        "sec-ch-ua-platform": '"iOS"',
        "sec-fetch-dest": "document",
        "sec-fetch-mode": "navigate",
        "sec-fetch-site": "same-origin",
        "upgrade-insecure-requests": "1",
        "user-agent": PROBE_UA,
      },
      signal: AbortSignal.timeout(20_000),
      redirect: "follow",
    });
    if (res.status !== 200) return "UNKNOWN";
    const html = await res.text();
    if (!html) return "UNKNOWN";
    if (/temporarily blocked|security check|unusual activity|too many requests/i.test(html)) return "UNKNOWN";
    const cUser = cookie.match(/c_user=(\d+)/)?.[1];
    const identified =
      /"full_name"\s*:\s*"[^"]+"/.test(html) ||
      /"navigation_row_subtitle"\s*:\s*"\+?\d/.test(html) ||
      (!!cUser && html.includes(cUser));
    return identified ? "ALIVE" : "DEAD";
  } catch {
    return "UNKNOWN";
  }
}
export async function isCookieDead(cookie) {
  if ((await probeOnce(cookie)) !== "DEAD") return false;
  log.info("Cookie probe says DEAD - confirming (a single DEAD can be transient)");
  await sleep(3000);
  return (await probeOnce(cookie)) === "DEAD";
}

// Set from --hold. Makes every give-up path stop and keep the browser instead
// of closing, so an unrecognised screen can be inspected and recorded.
let HOLD = false;

// ---- Capturing a screen we do not understand ----
// When a screen is unrecognised, the useful thing is not a guess at the wording
// - it is a picture of the page and a browser the operator can poke at. This is
// the dump from the old FAF bot's logScreen, trimmed to what is needed here.
async function dumpScreen(page, why) {
  // A checkpoint page is often still blank when we give up on it - the first
  // dump of a real one came back with no text, no buttons and no inputs. So
  // give the page a few seconds to render before reporting it empty, otherwise
  // the dump is worthless exactly when it is needed most.
  const grab = () => page.evaluate(() => {
    const vis = (e) => !!(e.offsetWidth || e.offsetHeight);
    const uniq = (els, label, max) => {
      const seen = new Set(), out = [];
      for (const el of els) {
        if (!vis(el)) continue;
        const n = label(el);
        if (!n || seen.has(n)) continue;
        seen.add(n);
        out.push(n);
        if (out.length >= max) break;
      }
      return out;
    };
    const btn = (e) => (e.getAttribute("aria-label") || e.innerText || "").replace(/\s+/g, " ").trim();
    // A password input has no visible name at all, so reach for its <label>.
    const inp = (e) => (e.labels?.[0]?.innerText || e.getAttribute("aria-label") || e.placeholder || e.name || e.id || e.type || "").replace(/\s+/g, " ").trim();
    return {
      buttons: uniq([...document.querySelectorAll('button,[role="button"]')], btn, 30),
      links: uniq([...document.querySelectorAll("a")], btn, 15),
      inputs: uniq([...document.querySelectorAll('input,textarea,[role="textbox"]')], inp, 12),
      dialogs: [...document.querySelectorAll('[role="dialog"],[role="alert"]')].filter(vis)
        .map((e) => e.innerText.replace(/\s+/g, " ").trim().slice(0, 200)),
      text: (document.body?.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 800),
    };
  }).catch(() => null);
  let info = await grab();
  if (!info || (!info.text && !info.buttons.length && !info.inputs.length)) {
    for (let i = 0; i < 8; i++) {
      await sleep(750);
      const again = await grab();
      if (again && (again.text || again.buttons.length || again.inputs.length)) { info = again; break; }
    }
  }
  // A checkpoint's wording is often inside an iframe, where the top document
  // has nothing at all.
  const frameText = [];
  for (const f of page.frames()) {
    if (f === page.mainFrame()) continue;
    const t = await f.locator("body").innerText({ timeout: 1000 })
      .then((s) => s.replace(/\s+/g, " ").trim().slice(0, 300)).catch(() => "");
    if (t) frameText.push(`${f.url().slice(0, 60)}: ${t}`);
  }
  log.error(`── screen: ${why} ──`);
  log.error(`  url:     ${page.url().slice(0, 160)}`);
  if (!info) { log.error("  (could not read the page - it may have closed)"); return null; }
  log.error(`  text:    ${info.text || "(empty)"}`);
  log.error(`  buttons: ${info.buttons.join(" | ") || "(none)"}`);
  log.error(`  links:   ${info.links.join(" | ") || "(none)"}`);
  log.error(`  inputs:  ${info.inputs.join(" | ") || "(none)"}`);
  for (const d of info.dialogs) log.error(`  dialog:  ${d}`);
  for (const t of frameText) log.error(`  frame:   ${t}`);
  if (!info.text && !info.buttons.length && !info.inputs.length && !frameText.length) {
    log.error("  (the page rendered nothing - the state is not in the DOM, so it must be read off the screen by eye)");
  }
  return info;
}

// Never returns. The browser stays open so the screen can be inspected and the
// steps recorded by hand, which is the only way to learn a state we have never
// seen. Ctrl+C in this terminal ends the run and closes it.
async function holdForInspection(page, why) {
  const info = await dumpScreen(page, why);
  if (info?.buttons.some((b) => /^dismiss$/i.test(b))) {
    log.warn("There IS a Dismiss button on this screen. That is the state described as 'automated behaviour'.");
  }
  log.warn("Browser held OPEN on purpose. Do the steps by hand and note them down.");
  log.warn("Press Ctrl+C in this terminal when you are finished.");
  await new Promise(() => {});
}

// ---- Waiting on the UI ----
// Fixed sleeps are the wrong shape here: a slow page pays the full sleep, a
// fast one still waits it out. This polls instead and returns the moment the
// expected thing is on screen - the waitForAny shape from the old FAF bot.
// Progress is logged at most every 2s so a long wait is visible without
// flooding the log.
let lastWaitLog = 0;
async function waitForAny(candidates, ms, what, onTimeout) {
  const start = Date.now();
  const deadline = start + ms;
  let tick = 0;
  while (Date.now() < deadline) {
    tick++;
    for (let i = 0; i < candidates.length; i++) {
      const loc = candidates[i];
      try {
        const n = await loc.count();
        if (n > 0 && (await loc.nth(0).isVisible({ timeout: 250 }))) return { loc: loc.nth(0), waitedMs: Date.now() - start };
      } catch { /* mid-render */ }
    }
    if (Date.now() - lastWaitLog >= 2000) {
      lastWaitLog = Date.now();
      log.debug(`waiting for ${what} (${Date.now() - start}ms, ${tick} ticks)`);
    }
    await sleep(POLL_MS);
  }
  log.warn(`gave up waiting for ${what} after ${ms}ms`);
  if (onTimeout) await onTimeout();
  return null;
}

// The same wait, for "did this disappear yet" - used after a click so the
// next step starts on the new screen instead of the old one.
async function waitForGone(loc, ms, what) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (!(await loc.nth(0).isVisible({ timeout: 250 }).catch(() => false))) return true;
    await sleep(POLL_MS);
  }
  return false;
}

// ---- Facebook screens ----
// m.facebook.com/index.php?next=...&deoia=1&no_universal_links=1 is the door
// into an expired session: the cookie still identifies the account, but
// m.facebook.com answers with a "Continue" interstitial and then a re-auth
// form. Going straight to accountscenter from a cold profile can land here
// instead of the password page.
function accountSheet(page) {
  return page.getByRole("dialog").filter({ hasText: /choose an account|continue as/i }).first();
}
// These buttons live on m.facebook.com, not accountscenter, and getByRole
// finds nothing there either (same role=none wrappers). [role=button] is a
// DOM-level query, so it works regardless of what the a11y tree exposes.
// Facebook's logged-out login screen, in the wordings it actually serves. The
// m.facebook.com one is "Mobile number or email address" - same words as the
// older "Email or phone number", opposite order, which is why the old pattern
// never fired on the real page. Needs an identifier field specifically: the
// re-auth form has a password and a "Log in" button but no identifier, so it
// must not match here or a recoverable session gets filed as a dead cookie.
const LOGIN_SCREEN_RE = /Log into Facebook|Email or phone number|Mobile number or email/i;

const mButton = (page, re) => page.locator('[role="button"]').filter({ hasText: re }).first();
// The same, but also matching a real <button>. Measured on 2fa43 row 38: the
// automated-behaviour checkpoint renders its Dismiss as a <button>, which
// mButton's [role="button"]-only query does NOT match - so the gate reported
// "no Dismiss" on a page that plainly had one, twice, while dumpScreen - which
// already used 'button,[role="button"]' - listed it correctly.
//
// Detect and click must use the SAME locator, or a run confirms a button with
// one query and then tries to click a different element with another.
const anyButton = (page, re) => page.locator('button,[role="button"]').filter({ hasText: re }).first();
const screens = (page) => ({
  // "Brittany Welker / Continue / Use another profile / Create new account"
  continueGate: { name: "expired session - Continue", loc: page.getByText("Use another profile", { exact: true }) },
  // After Continue: Password textbox + Log in + Forgotten password?
  reauth: { name: "re-auth password form", loc: mButton(page, /^Log in$/) },
  // "Save your login info?" / "We'll save the login info for <name>" / Save / Not now
  saveLogin: { name: "save login info prompt", loc: page.getByText("Save your login info?", { exact: false }).first() },
  accountChooser: { name: "account chooser sheet", loc: accountSheet(page) },
  accountHub: { name: "account hub (profile picker)", loc: page.getByRole("button", { name: /Profile picture,/ }).first() },
  hubChangePassword: { name: "hub tile 'Change password'", loc: page.getByText("Change password", { exact: true }).first() },
  // The password inputs sit under role=none wrappers, so getByRole finds
  // NOTHING here (measured: getByRole textbox = 0, getByLabel = 1). Every
  // field is addressed by its <label> instead.
  passwordForm: { name: "password change form", loc: page.getByLabel("Current password", { exact: true }) },
  // Checked BEFORE reauth in every walk. Both halves of this were wrong once:
  // (1) the m.facebook.com build says "Mobile number or email address", which
  // /Email or phone number/ does not match - same words, opposite order; and
  // (2) waitForScreen returns the FIRST visible match while a login form has a
  // "Log in" button, so reauth beat loggedOut and the walk typed the account's
  // own password at a form that can never accept it - nine times on 2fa43 row
  // 33. Fixing the wording alone would NOT have fixed that.
  // It still requires an identifier field, which the re-auth form does not
  // have, so a recoverable session is never filed as a dead cookie. Pinned in
  // --selftest.
  // (was: checked LAST and matched narrowly on purpose: the re-auth form also says
  // "Log in", so a broad /Log in/ here would file a recoverable session as a
  // dead cookie. This wants an actual email/phone field, which the re-auth
  // form does not have.
  loggedOut: { name: "LOGGED OUT / login screen", loc: page.getByText(LOGIN_SCREEN_RE).first() },
  checkpoint: { name: "identity checkpoint dialog", loc: page.getByRole("dialog").getByText(/confirm your identity|it's you|enter your password to confirm/i).first() },
});

const CODE_PROMPT_STRONG = [
  /enter\s+(the\s+)?(confirmation|verification|security)?\s*code/i,
  /sent\s+(a\s+)?(confirmation|verification|security)?\s*code\s+to/i,
  /we\s+can\s+send\s+a\s+new\s+code/i,
  /confirmation\s+code\s+to\s*\+?[\d*]/i,
];
const CODE_PROMPT_WEAK = [/authenticity\s+verification/i];
const CODE_PROMPT_LOCATORS = [
  (s) => s.getByRole("textbox", { name: /confirmation code|security code|verification code/i }),
  (s) => s.getByPlaceholder(/confirmation code|security code|verification code|enter.*code/i),
  (s) => s.getByText(/enter (the )?(confirmation |verification |security )?code/i),
  (s) => s.getByText(/we can send a new code in/i),
  (s) => s.getByText(/sent (a )?(confirmation |verification |security )?code to/i),
];
const scopes = (page) => [page, ...page.frames().filter((f) => f !== page.mainFrame())];

export async function codePromptVisible(page) {
  for (const s of scopes(page)) {
    for (const make of CODE_PROMPT_LOCATORS) {
      try {
        if (await make(s).first().isVisible({ timeout: 400 })) return true;
      } catch { /* keep trying */ }
    }
    let text = "";
    try { text = await s.locator("body").innerText({ timeout: 1500 }); } catch { continue; }
    if (!text) continue;
    if (CODE_PROMPT_STRONG.some((re) => re.test(text))) return true;
    try {
      const n = Math.min(await s.getByRole("dialog").count().catch(() => 0), 6);
      for (let i = 0; i < n; i++) {
        const d = await s.getByRole("dialog").nth(i).innerText({ timeout: 800 }).catch(() => "");
        if (d && CODE_PROMPT_WEAK.some((re) => re.test(d))) return true;
      }
    } catch { /* raced a re-render */ }
  }
  return false;
}
async function codePromptText(page) {
  for (const s of scopes(page)) {
    const text = await s.locator("body").innerText({ timeout: 2000 })
      .then((t) => t.replace(/\s+/g, " ")).catch(() => "");
    if (!text) continue;
    const phone = text.match(/((confirmation|verification|security)\s+code\s+to\s*\+?[\d\s*]{6,}|we\s+can\s+send\s+a\s+new\s+code\s+in\s*\d+:\d+)/i);
    if (phone) return phone[1].replace(/\s+/g, " ").trim();
    const heading = text.match(/(enter\s+(the\s+)?(confirmation|verification|security)?\s*code)/i);
    if (heading) return heading[1].replace(/\s+/g, " ").trim();
  }
  return null;
}
export async function blockingDialog(page) {
  const dialogs = page.getByRole("dialog");
  const n = await dialogs.count().catch(() => 0);
  for (let i = 0; i < n; i++) {
    const d = dialogs.nth(i);
    if (!(await d.isVisible({ timeout: 300 }).catch(() => false))) continue;
    const text = await d.innerText({ timeout: 500 }).then((t) => t.replace(/\s+/g, " ")).catch(() => "");
    if (/choose an account|continue as/i.test(text)) continue;
    if (await d.getByLabel("Current password", { exact: true }).first().isVisible({ timeout: 400 }).catch(() => false)) continue;
    return true;
  }
  return false;
}

async function pickAccount(page) {
  const sheet = accountSheet(page);
  const candidates = [
    ["Facebook label", sheet.getByText("Facebook", { exact: true })],
    ["account name", sheet.getByText(/^[A-Z][a-z'’-]+ [A-Z][a-z'’-]+$/)],
  ];
  // Wait for the row rather than assuming it is already there. The sheet can
  // finish loading and hand over to the password form between the screen being
  // detected and this call, and reaching into a sheet that has already gone
  // used to log a scary "could not find the account row" on a perfectly fine
  // run - the walk simply carried on afterwards.
  for (const [label, loc] of candidates) {
    const hit = await waitForAny([loc], 3_000, `the account row (${label})`);
    if (!hit) continue;
    const who = (await hit.loc.innerText({ timeout: 1000 }).catch(() => "")).trim();
    await hit.loc.click({ timeout: 5000 }).catch(() => {});
    log.success(`Picked account "${who}" via ${label}`);
    return;
  }
  if (await codePromptVisible(page)) await bailCodePrompt((await codePromptText(page)) ?? "confirmation code");
  if (!(await sheet.first().isVisible({ timeout: 500 }).catch(() => false))) {
    log.info("The account sheet closed on its own - the form is probably already up");
    return;
  }
  const text = await sheet.innerText({ timeout: 2000 })
    .then((t) => t.replace(/\s+/g, " ").trim().slice(0, 200)).catch(() => "");
  log.error(`Could not find the account row in the sheet. Sheet says: ${text || "(empty)"}`);
}
async function bailCodePrompt(prompt) {
  log.error(`Facebook wants an SMS code (${prompt}). Cookie VALID - gated, not dead. Skipping.`);
  throw new BailGated(`gated: Facebook requires an SMS confirmation code (${prompt})`);
}
async function waitForScreen(page, list, what, ms = WAIT_MS) {
  const deadline = Date.now() + ms;
  let lastUrl = "";
  while (Date.now() < deadline) {
    if (page.isClosed()) throw new BailLogged(`Browser closed while waiting for ${what}`);
    for (const s of list) {
      try {
        if (await s.loc.first().isVisible({ timeout: 250 })) {
          log.success(`[${elapsed()}] Detected: ${s.name}`);
          return s;
        }
      } catch { /* still loading */ }
    }
    if (page.url() !== lastUrl) { lastUrl = page.url(); log.info(`[${elapsed()}] Waiting for ${what}… (${lastUrl})`); }
    // The code prompt can appear *while* we wait — a dialog matching none of the
    // screens. Without this the wait times out and a gated cookie is reported as
    // "no known screen", so it retries forever instead of being skipped.
    if (await codePromptVisible(page)) await bailCodePrompt((await codePromptText(page)) ?? "confirmation code");
    await sleep(POLL_MS);
  }
  return null;
}
// A checkpoint is not one thing. Facebook uses /checkpoint/ for a real ban
// AND for an ordinary identity challenge, and treating them the same is costly
// in both directions: wait on a banned account for ten minutes, or throw away a
// good one. So read the page and split them.
const BANNED_WORDS = /your account (has been |was )?(disabled|deactivated)|account disabled|you'?re temporarily blocked|this account (has been |was )?(disabled|deactivated)|violat(ed|ion) of our terms|account is not usable/i;
// There is deliberately no CHALLENGE_WORDS list. A challenge is the default -
// classifyCheckpointText returns it for anything that is not a ban - so a list
// of challenge phrases would be an unreachable second opinion that only looks
// like it is doing work. It existed once and was never called.
function isCheckpointUrl(page) {
  return /checkpoint/i.test(page.url());
}
// The "automated behaviour" interstitial, as --hold found it on 2fa100 row 9.
// One Continue button, no Dismiss. Requiring the phrase AND the button keeps a
// bare "Continue" on some other page from being clicked as a human check.
//
// Continue is NOT clicked. Measured on row 9: that click lands on a CAPTCHA
// ("Enter the text from the image"), and a CAPTCHA is deliberately not solved
// here. So clicking spends the account's clean screen to arrive at a dead end.
const HUMAN_CHECK = /confirm that you'?re human|are you a robot|verify you'?re human/i;

// The OTHER automated-behaviour screen, captured verbatim on 2fa43 row 38:
//
//   We suspect automated...
//   To prevent your account from being hacked
//   buttons: Dismiss
//
// Distinct from the human check above and must never be confused with it: that
// one leads to a CAPTCHA and is not clicked, this one closes on Dismiss. Both
// phrasings are required to match, and so is the button, so a bare "Dismiss"
// on an unrelated page is never clicked.
const AUTO_WARNING = /we suspect automated|to prevent your account from being hacked/i;
const pageText = (page) =>
  page.locator("body").innerText({ timeout: 5000 }).then((t) => t.replace(/\s+/g, " ")).catch(() => "");

// The checkpoint page is blank for several seconds after the redirect - the
// first dump of a real one had no text, no buttons and no inputs at all. So
// this WAITS for the wording rather than reading once; reading once found
// nothing and fell through to the ten-minute human wait.
async function findHumanCheck(page, ms = 10_000) {
  const btn = mButton(page, /^Continue$/);
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await page.isClosed()) return null;
    if (HUMAN_CHECK.test(await pageText(page)) && (await btn.isVisible({ timeout: 300 }).catch(() => false))) return btn;
    await sleep(POLL_MS);
  }
  return null;
}

// The same shape as findHumanCheck: both the wording AND the button, so a
// Dismiss belonging to something else cannot be clicked by accident.
async function findAutoWarning(page, ms = 10_000) {
  const btn = anyButton(page, /^Dismiss$/);
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await page.isClosed()) return null;
    if (AUTO_WARNING.test(await pageText(page)) && (await btn.isVisible({ timeout: 300 }).catch(() => false))) return btn;
    await sleep(POLL_MS);
  }
  return null;
}

// The first Continue on the human check leads to a CAPTCHA: "Enter the text
// from the image / Hear this code or get a new code / Type the text". That is a
// control whose whole purpose is to stop a program, so it is deliberately NOT
// solved here - no image reading, no audio transcription, no code lookup. The
// row stops and says so, and a person does it by hand with --codegen.
//
// The account itself is usually fine, so this is NOT recorded as dead or
// skipped. It is a stop, not a verdict on the cookie.
const CAPTCHA = /enter the text from the image|type the text|enter the characters you see|recaptcha/i;
const captchaVisible = (page) => pageText(page).then((t) => CAPTCHA.test(t));

// Two reasons a row is written off, and they are NOT the same thing:
//
//   account dead  - the UID check says the account is gone. Permanent. The
//                   account itself is the product; retrying it cannot help.
//   captcha       - Facebook asked for the text from an image. Deliberately
//                   NOT solved (see CAPTCHA in this file). A stop, not a
//                   verdict, so the row is NOT skipped - the account is fine
//                   and a person can do it with --codegen.
//
// So a captcha does NOT mean a banned account. It is a bot check on the way
// back in, and it is not evidence about the account itself.

// "banned" | "challenge". A challenge is the safe default: waiting costs time,
// wrongly calling a live account banned costs the account itself.
function classifyCheckpointText(text) {
  if (text && BANNED_WORDS.test(text)) return "banned";
  return "challenge";
}
// null when the page is not a checkpoint at all
async function classifyCheckpoint(page) {
  if (!isCheckpointUrl(page)) return null;
  let text = "";
  try { text = (await page.locator("body").innerText({ timeout: 5000 })).replace(/\s+/g, " "); } catch { /* closed */ }
  return classifyCheckpointText(text);
}

// The account is the product and a false "banned" discards a live one, so the
// split is asserted rather than assumed. Every sample below is real Facebook
// wording, and most exist to prove they are NOT treated as a ban.
async function selftest() {
  const banned = [
    "Your account has been disabled",
    "Your account was deactivated",
    "You're temporarily blocked from using Facebook",
    "This account has been disabled because it violates our terms",
    "Account disabled. You can't use Facebook right now.",
  ];
  const challenge = [
    "Confirm your identity",
    "It's you",
    "Enter your password to confirm it's you",
    "Security check",
    "We detected unusual login activity",
    // Captured verbatim from a real run (2fa100 row 9) via --hold. This is
    // the screen that was reported as "click Dismiss". The button is
    // Continue - there is no Dismiss - so a handler written from the
    // description would have found nothing and clicked nothing.
    "Ge. Alissa Bayuk, confirm that you're human to use your account Continue",
    // Captured verbatim on 2fa43 row 38. The OTHER automated-behaviour screen:
    // this one closes on Dismiss, the row above leads to a CAPTCHA and is not
    // clicked. It is a challenge, not a ban - BANNED_WORDS must not swallow it.
    "We suspect automated activity. To prevent your account from being hacked, ...",
    "",
  ];
  let bad = 0;
  for (const t of banned) {
    const got = classifyCheckpointText(t);
    if (got !== "banned") { log.error(`selftest: should be banned, got ${got}: "${t}"`); bad++; }
  }
  for (const t of challenge) {
    const got = classifyCheckpointText(t);
    if (got !== "challenge") { log.error(`selftest: should be a challenge, got ${got}: "${t}"`); bad++; }
  }
  // The user-facing Telegram bot is ARCHIVED, not deleted: data/archive/bot/bot.js,
  // with data/archive/bot/WHY-archived.md explaining the decision.
  //
  // The checks that used to live here - its message style, its inline keyboards and
  // its submission parser - are GONE WITH IT, deliberately. They guarded a surface
  // that no longer exists, and keeping them would mean importing a file out of an
  // archive, so a routine `bun index.js --selftest` would depend on code nobody runs
  // and that a well-meaning cleanup would delete as dead.
  //
  // What replaced them is the opposite check: that the bot really is unreachable
  // from the live path. A bot that comes back by accident - wired to a token and a
  // database - is a far worse failure than one that is merely absent.
  if (!fs.existsSync(path.join(DATA_DIR, "archive", "bot", "bot.js"))) {
    log.error("selftest: the archived bot is gone from data/archive/bot/ - it was deleted rather than archived"); bad++;
  }
  if (fs.existsSync(path.join(__dirname, "bot.js"))) {
    log.error("selftest: bot.js is back at the project root - it was archived deliberately (see data/archive/bot/WHY-archived.md)"); bad++;
  }
  // Nothing on the live path may import it. One stray import is how an archived
  // component comes back to life. Comments are stripped first, because every
  // explanation of this decision quotes the file name.
  const liveSrc = fs.readFileSync(path.join(__dirname, "index.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  if (/(?:from|import)\s*\(?\s*["'][^"']*\bbot\.js\b/.test(liveSrc)) {
    log.error("selftest: index.js still imports the archived bot - the live path must not depend on it"); bad++;
  }
  log.info("selftest: the user-facing bot is archived under data/archive/bot/ and nothing on the live path imports it");
  // The payout rule, pinned. This is money, so every branch is asserted rather
  // than assumed: the cap binds above 0.050, the 19% holds below it, and a
  // missing price or rate must yield nothing rather than an invented number.
  for (const [price, wantUser, wantUs] of [
    [0.050, 5.00, 1.15],   // the headline: 5 tk, we keep 19%
    [0.070, 5.00, 3.61],   // price ROSE - the cap holds, the extra is ours
    [0.048, 4.80, 1.10],   // price DROPPED - our cut stays 19%
    [0.040, 4.00, 0.92],
    [0.020, 2.00, 0.46],
  ]) {
    const r = payoutBkt(price, 123.0);
    if (r.user !== wantUser || Math.abs(r.us - wantUs) > 0.01) {
      log.error("selftest: payout at " + price + " gave user " + r.user + " us " + r.us + ", wanted " + wantUser + "/" + wantUs);
      bad++;
    }
  }
  // Never negative, whatever the price. A payout larger than the revenue is the
  // one arithmetic error that actually costs money.
  for (const price of [0.001, 0.01, 0.05, 1, 100]) {
    const r = payoutBkt(price, 123.0);
    if (r.us < 0 || r.user < 0) { log.error("selftest: payout at " + price + " went negative"); bad++; }
    if (r.user > MAX_USER_BKT + 1e-9) { log.error("selftest: payout exceeded the cap at " + price); bad++; }
  }
  // A missing rate or price must STOP a payout, never guess one.
  for (const [p, rate] of [[0.05, 0], [0.05, null], [0, 123], [null, 123]]) {
    if (payoutBkt(p, rate).user !== 0) { log.error("selftest: payout(" + p + ", " + rate + ") invented a number instead of refusing"); bad++; }
  }
  if (OUR_CUT !== 0.19) { log.error("selftest: our cut is " + OUR_CUT + ", wanted 0.19"); bad++; }
  log.info("selftest: payout rule pinned (cap " + MAX_USER_BKT + " BKT, our cut " + (OUR_CUT * 100) + "%, never negative, refuses a missing rate)");
  log.info(`selftest: ${banned.length + challenge.length} checkpoint wordings checked`);
  // loggedOut has to fire on the wording m.facebook.com really serves, and must
  // NOT fire on a re-auth form. Both real wordings, pinned.
  const loginCases = [
    ["Facebook Get Facebook for iOS and browse faster. English (UK) Mobile number or email address Password Log in Forgotten password? Create new account", "m.facebook.com (2fa43 row 33)"],
    ["Log into Facebook", "desktop"],
    ["Email or phone number", "older wording"],
  ];
  for (const [text, what] of loginCases) {
    if (!LOGIN_SCREEN_RE.test(text)) { log.error(`selftest: dead-cookie screen not detected - ${what}`); bad++; }
  }
  for (const [text, what] of [
    ["Password Log in Forgotten password?", "re-auth password form"],
    ["Save your login info?", "save-login prompt"],
  ]) {
    if (LOGIN_SCREEN_RE.test(text)) { log.error(`selftest: dead-cookie screen false-positives on ${what}`); bad++; }
  }
  log.info(`selftest: ${loginCases.length} dead-cookie wordings detected, re-auth still not misfiled`);
  // The human check and the auto warning are handled in OPPOSITE ways - one is
  // clicked, one is not - so a cross-match is a real bug, not a cosmetic one.
  // Both real wordings, pinned.
  const HUMAN_TEXT = "confirm that you're human to use your account Continue";
  const AUTO_TEXT = "We suspect automated activity. To prevent your account from being hacked.";
  if (!HUMAN_CHECK.test(HUMAN_TEXT)) { log.error("selftest: the human-check wording is not detected"); bad++; }
  if (!AUTO_WARNING.test(AUTO_TEXT)) { log.error("selftest: the auto-warning wording is not detected"); bad++; }
  if (AUTO_WARNING.test(HUMAN_TEXT)) { log.error("selftest: auto-warning regex matches the human-check screen - it would Dismiss a CAPTCHA"); bad++; }
  if (HUMAN_CHECK.test(AUTO_TEXT)) { log.error("selftest: human-check regex matches the auto-warning screen"); bad++; }
  if (BANNED_WORDS.test(AUTO_TEXT)) { log.error("selftest: the auto warning is being classified as a ban"); bad++; }
  log.info("selftest: human check and auto warning detected separately, neither crosses over");
  // The four provider messages, all captured from real history. These used to
  // be unexplained failures, so each one is pinned here.
  const rateLimitCases = [
    ["You are making requests too often. Please wait 9 sec.", 9],
    ["You are making requests too often. Please wait 2 sec.", 2],
    ["You are making requests too often. Please wait 4 sec.", 4],
    ["Report approved, +$0.05", 0],
    ["Time's up! Task cancelled.", 0],
  ];
  for (const [text, want] of rateLimitCases) {
    const got = rateLimitSeconds([text]);
    if (got !== want) { log.error(`selftest: rate limit "${text}" gave ${got}, wanted ${want}`); bad++; }
  }
  // THE BUG THAT LOST AN ACCOUNT. obeyRateLimit returns {replies, waited}, and
  // an object is always truthy, so `if (await obey(...)) continue;` fired on
  // every row: the Facebook password was changed, the 2FA key sent, the
  // cookie never sent, and the row reported as "0 passed, 0 failed". No error,
  // no record, no way to tell it had happened.
  //
  // A browser-free test is the only kind that can catch this, so the check is
  // static: every branch on obeyRateLimit's result must read .waited. It fails
  // on the old source, which is the point - the parser tests below all passed
  // while the tool was losing accounts.
  // The bad shape is `if (await f(x))` - the if's closing paren sits IMMEDIATELY
  // after the call's, with nothing in between. A correct branch always has
  // `.waited` there, so requiring the two parens to be adjacent is what
  // separates them without a parser.
  const obeyBranches = [...fs.readFileSync(path.join(__dirname, "index.js"), "utf8")
    .matchAll(/if\s*\(\s*await\s+[\w.]+\.obeyRateLimit\([^()]*\)\s*\)/g)]
    .map((m) => m[0]);
  if (obeyBranches.length) {
    for (const src of obeyBranches) log.error(`selftest: branches on the object, not .waited - the cookie is skipped: ${src}`);
    bad += obeyBranches.length;
  }
  // The trap itself, so the reason is on the record and not just the symptom.
  // The predicate the call sites now consume must be truthy ONLY when the
  // provider really did say to wait - a clean reply has to fall through, or the
  // row is skipped and the cookie is never sent.
  for (const [text, want] of [["Bot gave: Deborah Hopkins / password 10 chars", false], ["You are making requests too often. Please wait 9 sec.", true]]) {
    const got = !!({ replies: [text], waited: rateLimitSeconds([text]) }).waited;
    if (got !== want) { log.error(`selftest: obeyRateLimit branch for "${text}" was ${got}, wanted ${want}`); bad++; }
  }
  log.info("selftest: every obeyRateLimit branch reads .waited, so the cookie is no longer skipped");

  // THE BUG THAT COST 66 ACCOUNTS IN ONE MINUTE. The provider said "wait 705
  // seconds", it was filed as `on: null` - the same value as "could not tell" -
  // and the child carried on into it. Telegram's OWN flood limit
  // ("A wait of 705 seconds is required") was a thrown error that no call site
  // recognised at all. The parent had no circuit breaker, so it spawned the next
  // 22 groups into the same wall. Three separate holes, so three checks.
  // STATIC-CHECKS-BEGIN
  for (const [text, want] of [
    ["A wait of 705 seconds is required (caused by messages.SendMessage)", 705],
    ["A wait of 9 seconds is required (caused by messages.SendMessage)", 9],
    ["FLOOD_WAIT_705", 0],
    ["Your report has been received! Please wait.", 0],
  ]) {
    const got = floodWaitSeconds(new Error(text));
    if (got !== want) { log.error(`selftest: telegram flood "${text}" gave ${got}s, wanted ${want}`); bad++; }
  }
  // The provider's own polite limit and Telegram's hard flood are different
  // messages from different layers. Neither may be read as the other, or one of
  // them keeps being invisible.
  if (rateLimitSeconds(["A wait of 705 seconds is required (caused by messages.SendMessage)"]) !== 0) {
    log.error("selftest: telegram's flood wait was read as the provider's rate limit"); bad++;
  }
  if (floodWaitSeconds(new Error("You are making requests too often. Please wait 9 sec.")) !== 0) {
    log.error("selftest: the provider's rate limit was read as a telegram flood wait"); bad++;
  }
  // THE 2026-09-30 RUN. A flood thrown DURING the availability check (the knock
  // itself throws, so obeyRateLimit never sees it) was caught as `on: null` -
  // "could not tell" - and the child carried on into the wall, died on the next
  // send, exited 1, and the parent spawned all 21 groups into the same flood.
  // A thrown flood during setup is a stop, never uncertainty.
  {
    const throwing = {
      obeyRateLimit: async (r) => r,
      ensureMainMenu: async () => { throw new Error("A wait of 271 seconds is required (caused by messages.SendMessage)"); },
      press: async () => [],
    };
    const fa = await taskAvailability(throwing);
    if (!fa.rateLimited || fa.waitSec !== 271) {
      log.error(`selftest: a flood thrown during the availability check gave rateLimited=${!!fa.rateLimited} waitSec=${fa.waitSec} - it must stop the run, not carry on`);
      bad++;
    }
  }
  // Auto-wait, not re-run. A flood thrown by send must be waited out inside the
  // exchange and the SAME send retried - the 2026-09-30 run exited instead, and
  // the parent spawned all 21 groups into the same wall. Fails on old code: the
  // first send throws and the exchange rejects instead of returning the reply.
  {
    const t = new Taskly(null);
    let captured = null;
    t.client = { addEventHandler: (h) => { captured = h; }, removeEventHandler: () => { captured = null; } };
    const peer = new Api.PeerUser({ userId: 7 });
    t.peer = peer;
    let sends = 0;
    const replied = t._exchange("selftest-flood", async () => {
      sends++;
      if (sends === 1) throw new Error("A wait of 1 seconds is required (caused by messages.SendMessage)");
    });
    setTimeout(() => {
      if (!captured) return;
      const msg = new Api.Message({ id: 1, peerId: peer, message: "Balance", out: false });
      captured(new Api.UpdateNewMessage({ message: msg, pts: 1, ptsCount: 1 }));
    }, 3000);
    const got = await replied;
    if (sends !== 2 || !got.some((r) => /balance/i.test(r))) {
      log.error(`selftest: the flood was not waited out and retried (sends=${sends}, replies=${JSON.stringify(got).slice(0, 80)})`);
      bad++;
    } else log.info("selftest: a telegram flood is waited out and the same send retried");
  }
  // The batch parent MUST branch on the rate-limit exit code. A parent that only
  // records the failure is what turned one rate limit into 22 dead groups.
  //
  // These greps run against the file with THIS BLOCK REMOVED. Without that they
  // are vacuous: each pattern is written literally in this function, so
  // `src.includes(needle)` finds the test itself and passes for ever. Two of
  // these three did exactly that and were caught only because the fix was
  // reverted and the selftest still reported "passed".
  //
  // The markers are assembled from parts for the same reason one level down: any
  // line that merely TALKS ABOUT the closing marker - a comment, a log line -
  // still contains it, and a plain indexOf finds that first and slices the region
  // in the wrong place. That happened twice here, and it failed silently both
  // times: the selftest reported "passed" while checking nothing. So nothing
  // above this line may spell either marker out in full.
  const MARK_A = ["STATIC", "CHECKS", "BEGIN"].join("-");
  const MARK_B = ["STATIC", "CHECKS", "END"].join("-");
  const srcAll = fs.readFileSync(path.join(__dirname, "index.js"), "utf8");
  const b = srcAll.indexOf(MARK_A), e = srcAll.indexOf(MARK_B);
  if (b === -1 || e === -1 || e < b) { log.error("selftest: the static-check block is not delimited, so its greps would match this function"); bad++; }
  const prod = b === -1 || e === -1 ? "" : srcAll.slice(0, b) + srcAll.slice(e);
  if (!prod) { log.error("selftest: the static-check region came out empty, so the greps below prove nothing"); bad++; }
  if (!/r\.status === EXIT_RATE_LIMITED/.test(prod)) {
    log.error("selftest: the batch parent has no circuit breaker - one rate limit would spawn every remaining group into it"); bad++;
  }
  // THE 2026-09-30 RUN. Two more holes from the same flood: the menu reset after
  // the availability check threw outside the per-row handler (exit 1, so the
  // parent kept spawning), and the top-level handler itself exited 1 on any
  // setup flood. Both must exit 75 so the parent stops the whole run.
  // The needle is the setup path's own log line - `floodWaitSeconds(e)` alone
  // already existed in the per-row reset handler, so it would pass on old code.
  if (!/Nothing was spent and no row was started/.test(prod)) {
    log.error("selftest: a telegram flood during setup does not stop the run with the rate-limit code - the parent will spawn every group into the wall"); bad++;
  }
  if (!/floodWaitSeconds\(err\) \? EXIT_RATE_LIMITED/.test(prod)) {
    log.error("selftest: the top-level handler exits 1 on a setup flood instead of the rate-limit code - the parent will not stop"); bad++;
  }
  // The batch parent SPAWNS children, so it must NOT hold the session lock
  // itself - only the child that actually talks to Telegram may. A parent that
  // locks would make every child refuse to start, and the run would do nothing
  // with a perfectly clear error nobody reads.
  if (/runBatch[\s\S]{0,900}holdSessionLock/.test(prod)) {
    log.error("selftest: runBatch takes the session lock, so every child it spawns will refuse to start"); bad++;
  }
  // And the lock must be taken BEFORE the session opens, and released on every
  // exit path - a lock never released is a session nobody else can ever use.
  if (!/holdSessionLock/.test(prod)) {
    log.error("selftest: nothing takes the telegram session lock - two processes on one session will eat each other's replies"); bad++;
  }
  // Order matters and a plain "both exist" test cannot see it: the lock must be
  // taken BEFORE Taskly.open, or there is a window in which a second process
  // opens the same session and both are live at once. So the check is positional -
  // the LAST take of the lock must come before the FIRST open in the guarded path.
  const lockAt = prod.lastIndexOf("holdSessionLock");
  const openAfter = prod.indexOf("Taskly.open", lockAt);
  if (lockAt === -1 || openAfter === -1) {
    log.error("selftest: cannot find the session lock and the session open, so their order is unchecked"); bad++;
  } else {
    const between = prod.slice(lockAt, openAfter);
    if (!/holdSessionLock\(/.test(between)) {
      log.error("selftest: the session lock is taken AFTER the session opens - there is a window with two processes on one session"); bad++;
    }
  }
  // ...and released on the way out, or a crashed run locks the session for ever.
  if (!/finally \{[\s\S]{0,160}lock\.release/.test(prod)) {
    log.error("selftest: the session lock is not released in a finally block, so a crashed run locks the session permanently"); bad++;
  }
  // The submission queue must be Postgres. A JSON read-modify-write is what
  // stopped parallel runs in the first place.
  //
  // savePending is deliberately still here for the selftest, which drives the
  // pure pairing logic against a temp dir. So the check is not "savePending
  // appears nowhere" - that would fail on the very tests that prove the pairing
  // works, and get deleted to make it pass. The check is that it has exactly one
  // caller, and that the live "the provider took it" path is the database.
  // The name is taken from the line, not from a 60-character window: the window approach reported "?" and "function" and then compared them to a hardcoded list, which is a test that can only ever fail.
  // Comments are stripped FIRST. The explanation above this check names savePending
  // twice, and the original version counted those as call sites - so it reported
  // callers "?" and "function" and then failed against its own hardcoded list.
  const code = prod.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  // Which ENCLOSING function writes it. Slicing a fixed character window behind
  // the call was wrong three times over: the window cut names in half, a
  // trailing \r defeated the anchor, and the explanation comment above this very
  // check counted as a call site. Each is fixed here by taking the nearest
  // preceding `function name` and ignoring the definition itself.
  // Every `function X (` in the file, then each savePending call is attributed to
  // the nearest one before it. The definition is skipped by advancing past its
  // own opening paren first - matching the definition and then also letting it
  // appear in the enclosing-function list made it its own "caller", which is
  // what the previous attempt reported.
  // The DEFINITION and its own body, both skipped. Matching only the declaration
  // left the definition's enclosing name (loadPending) attached to calls that sit
  // in a later function - so the check reported a writer that does not exist.
  const savePendingDef = code.search(/(?:export )?(?:async )?function savePending\s*\(/);
  const defEnd = (() => {
    if (savePendingDef === -1) return -1;
    let i = code.indexOf("{", savePendingDef), depth = 0;
    for (; i < code.length; i++) { if (code[i] === "{") depth++; else if (code[i] === "}" && --depth === 0) return i; }
    return code.length;
  })();
  const enclosingAt = [...code.matchAll(/(?:export )?(?:async )?function (\w+)\s*\(/g)].filter((f) => f.index < savePendingDef || f.index > defEnd);
  const callers = [...code.matchAll(/(?<![\w.])savePending\(/g)]
    .filter((m) => m.index < savePendingDef || m.index > defEnd)
    .map((m) => [...enclosingAt].reverse().find((f) => f.index < m.index)?.[1] ?? "top-level");
  const unique = [...new Set(callers)];
  const allowed = new Set(["recordVerdict", "noteSubmission"]);
  const rogue = unique.filter((f) => !allowed.has(f));
  if (rogue.length) {
    log.error(`selftest: the whole-file json queue is written from ${rogue.join(", ")} - two processes will lose rows (all writers: ${unique.join(", ") || "none"})`);
    bad++;
  }
  if (!/markSheetSent/.test(prod)) {
    log.error("selftest: nothing writes the sheet ledger to postgres, so two processes would still share one queue"); bad++;
  }
  // Every ledger write on the LIVE path must be awaited: fire-and-forget lets
  // the process exit with the record still in flight, which is the bug the
  // database removed.
  //
  // Definitions are excluded by inspecting the text IMMEDIATELY before the call
  // and anchoring at its END. The first version anchored to the start of a
  // 60-character slice, which begins mid-preamble, so it flagged all three
  // definitions as un-awaited and could never have passed.
  const isDef = (i) => /(?:export )?(?:async )?function \w*$/.test(code.slice(Math.max(0, i - 40), i));
  const unawaited = [...code.matchAll(/(?<!await )\b(markSent|markSkipped|markPasswordUsed)\(/g)].filter((m) => !isDef(m.index));
  if (unawaited.length) {
    for (const m of unawaited.slice(0, 3)) log.error(`selftest: ledger write is not awaited: ${m[0]} - the process can exit with the record in flight`);
    bad += unawaited.length;
  }
  // A rate limit is a stop; "could not tell" is not. They shared a branch, which
  // is the original mistake, so the two must be separate fields.
  if (!/rateLimited: true/.test(prod)) {
    log.error("selftest: a rate limit is still reported as 'could not tell' - it must be its own field"); bad++;
  }
  // THE ORPHAN RULE. Once the password is changed the account can never be
  // retried, so the row has to be recorded or it sits in neither ledger and
  // fails forever on every run. 2fa43:1 and 2fa49:23 are both in that state.
  if (!/passwordChanged && curFp/.test(prod)) {
    log.error("selftest: a row whose password was already changed is not recorded - it will be retried forever and fail every time"); bad++;
  }
  if (EXIT_RATE_LIMITED === 1) { log.error("selftest: the rate-limit exit code collides with the ordinary failure code"); bad++; }
  log.info("selftest: a rate limit stops the run (both provider and telegram), and a half-used row can never be retried");
  // STATIC-CHECKS-END
  for (const [text, want] of [["Time's up! Task cancelled.", true], ["Action cancelled.", false], ["Report approved, +$0.05", false]]) {
    const got = [text].some((t) => TASK_CANCELLED.test(t));
    if (got !== want) { log.error(`selftest: task-cancelled "${text}" gave ${got}, wanted ${want}`); bad++; }
  }
  // "Action cancelled." is OUR cancel; "Time's up" is the provider's. They must
  // never be confused for one another, which is the whole reason both exist.
  for (const [text, want] of [["Action cancelled.", true], ["Time's up! Task cancelled.", false]]) {
    const got = [text].some((t) => ACTION_CANCELLED.test(t));
    if (got !== want) { log.error(`selftest: action-cancelled "${text}" gave ${got}, wanted ${want}`); bad++; }
  }
  const verdictCases = [
    ["Report approved, +$0.05", "approved"],
    ["Report rejected. Reason: your report was rejected because the account was either blocked", "rejected"],
    ["Report rejected: account blocked", "rejected"],
    ["Your report has been received! Please wait.", null],
    ["Action cancelled.", null],
  ];
  for (const [text, want] of verdictCases) {
    const got = parseVerdict(text)?.verdict ?? null;
    if (got !== want) { log.error(`selftest: verdict "${text}" gave ${got}, wanted ${want}`); bad++; }
  }
  if (!parseVerdict("Report rejected: account blocked")?.accountBlocked) { log.error("selftest: 'account blocked' not flagged"); bad++; }
  if (parseVerdict("Report rejected. Reason: the account was either blocked or invalid")?.accountBlocked) { log.error("selftest: false 'account blocked' on the long-form rejection"); bad++; }
  // FIFO round trip. The whole verdict feature rests on this pairing, and it
  // rests on an ASSUMPTION, so it is exercised rather than asserted.
  const dir = path.join(os.tmpdir(), "opencode", `verdict-selftest-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  const pf = path.join(dir, "pending.json"), vf = path.join(dir, "verdicts.jsonl");
  await noteSubmission({ fp: "aaa", source: "a.xlsx", row: 1, phone: "111" }, pf);
  await noteSubmission({ fp: "bbb", source: "b.xlsx", row: 2, phone: "111" }, pf);
  await noteSubmission({ fp: "ccc", source: "c.xlsx", row: 3, phone: "111" }, pf);
  const v1 = recordVerdict({ verdict: "approved", amount: "0.05" }, "111", pf, vf);
  const v2 = recordVerdict({ verdict: "rejected", accountBlocked: true, reason: "x" }, "111", pf, vf);
  const v3 = recordVerdict({ verdict: "approved", amount: "0.05" }, "111", pf, vf);
  for (const [got, want, what] of [[v1.claim?.fp, "aaa", "1st verdict"], [v2.claim?.fp, "bbb", "2nd verdict"], [v3.claim?.fp, "ccc", "3rd verdict"]]) {
    if (got !== want) { log.error(`selftest: ${what} matched fp ${got}, wanted ${want}`); bad++; }
  }
  if (loadPending(pf).length !== 0) { log.error("selftest: pending queue not empty after all verdicts"); bad++; }
  const v4 = recordVerdict({ verdict: "approved", amount: "0.05" }, "111", pf, vf);
  if (v4.matched !== false) { log.error("selftest: a verdict with nothing pending should be unmatched"); bad++; }

  // The bug that made 2fa43 read as 38 approved when the balance proved 37.
  // TWO sessions, one shared queue. A verdict on session B must claim session
  // B's submission even when session A's is older and sitting at the front -
  // and a session with nothing waiting must come back UNMATCHED rather than
  // consuming the other session's row.
  const pf2 = path.join(dir, "pending2.json"), vf2 = path.join(dir, "verdicts2.jsonl");
  await noteSubmission({ fp: "AAA", source: "2fa43.xlsx", row: 6, phone: "111" }, pf2);
  await noteSubmission({ fp: "BBB", source: "2fa100.xlsx", row: 99, phone: "222" }, pf2);
  const b1 = recordVerdict({ verdict: "approved", amount: "0.05" }, "222", pf2, vf2);
  if (b1.claim?.fp !== "BBB") { log.error(`selftest: session 222's verdict claimed fp ${b1.claim?.fp}, wanted BBB (its own row)`); bad++; }
  const b2 = recordVerdict({ verdict: "approved", amount: "0.05" }, "111", pf2, vf2);
  if (b2.claim?.fp !== "AAA") { log.error(`selftest: session 111's verdict claimed fp ${b2.claim?.fp}, wanted AAA (its own row)`); bad++; }
  // 222 has nothing left. It must NOT eat 111's next row.
  await noteSubmission({ fp: "CCC", source: "2fa49.xlsx", row: 1, phone: "111" }, pf2);
  const b3 = recordVerdict({ verdict: "approved", amount: "0.05" }, "222", pf2, vf2);
  if (b3.matched !== false) { log.error(`selftest: session 222 with nothing pending claimed ${b3.claim?.fp} - it stole another session's row`); bad++; }
  const left = loadPending(pf2);
  if (left.length !== 1 || left[0].fp !== "CCC") { log.error("selftest: the other session's pending row did not survive an empty verdict"); bad++; }
  log.info("selftest: verdict FIFO pairing checked, and two sessions no longer share a queue");
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp only */ }
  log.info(`selftest: ${bad === 0 ? "all provider-message cases passed" : bad + " provider-message case(s) wrong"}`);

  // The hardcoded Facebook password. SHARED_PASSWORD used to fall back to a
  // literal, which put a live credential in every commit. Two things must hold:
  // the value is never baked in, and an empty one is refused BEFORE the browser
  // opens rather than ten screen-walks later as a confusing form error.
  {
    const src = fs.readFileSync(fileURLToPath(import.meta.url), "utf8");
    const decl = src.match(/const SHARED_PASSWORD\s*=\s*([^;]+);/)?.[1] ?? "";
    // strip the env read, then complain about any string literal left over
    const literal = decl.replace(/process\.env\.[A-Z_0-9]+/g, "").match(/["'][^"']+["']/);
    if (literal) { log.error(`selftest: SHARED_PASSWORD has a literal fallback (${literal[0]}) - a secret is baked into source`); bad++; }
    // the real value must not appear anywhere in the file either
    const fbPw = process.env.FB_CURRENT_PASSWORD;
    if (fbPw && src.includes(fbPw)) { log.error("selftest: the real FB password appears in index.js source"); bad++; }
    // And the refusal itself, with no browser at all. If this throws something
    // other than Bail, or touches context, the guard is not where it claims to be.
    let refused = null;
    try { await changePassword({ context: null, currentPw: "", newPw: "x", targetUrl: "https://example.invalid" }); }
    catch (e) { refused = e; }
    if (!(refused instanceof Bail)) { log.error("selftest: an empty current password was NOT refused up front"); bad++; }
    else if (refused.message.includes("example.invalid")) { log.error("selftest: the guard ran after the browser opened"); bad++; }
    else log.info("selftest: no literal password fallback, and an empty one is refused before the browser opens");
  }

  if (!bad) log.success("selftest passed");
  return bad;
}

async function awaitCheckpoint(page, minutes = 10, targetUrl = null) {
  const kind = await classifyCheckpoint(page);
  if (kind === "banned") {
    // Terminal. Recorded in skipped.jsonl so it is never retried - a banned
    // account will still be banned tomorrow, and retrying it is exactly how a
    // ban gets escalated.
    const fp = curFp;
    if (fp) {
      await markSkipped({ fp, reason: "banned: facebook served a checkpoint saying the account is disabled", source: curXlsx, row: curRow });
      audit({ leg: "internal", what: "account", status: "banned", fp });
    }
    log.error("BANNED: Facebook says this account is disabled. Recorded in the ledger - it will not be retried.");
    return await bail(page, "account is banned");
  }
  // "We suspect automated..." / "To prevent your account from being hacked",
  // with a Dismiss button. This one IS dismissed and the row carries on.
  //
  // Checked BEFORE the human check on purpose. The two screens are different
  // and the difference is the whole point: this one closes on Dismiss, the
  // human check leads to a CAPTCHA and is not clicked. Neither regex matches
  // the other's wording (pinned in --selftest), so the order is a belt-and-
  // braces rather than the thing that makes it correct.
  if (await findAutoWarning(page)) {
    log.warn("Facebook served the 'we suspect automated' warning. Clicking Dismiss.");
    const btn = anyButton(page, /^Dismiss$/);
    await btn.click({ timeout: 5000 }).catch((e) => log.warn(`Dismiss would not click: ${e?.message ?? e}`));
    // anyButton here too, not mButton: detect, click and confirm must all be
    // looking at the same element, or the run dismisses one button and waits on
    // a different one that was never there.
    await waitForGone(anyButton(page, /^Dismiss$/), 4_000, "the automated-behaviour warning");
    audit({ leg: "internal", what: "checkpoint", status: "auto-warning-dismissed" });
    // After the click, Facebook does NOT go anywhere useful, and where it lands
    // is NOT fixed. Two measured outcomes on the same day, two accounts:
    //   m.facebook.com/gettingstarted/notifications/  "Turn on notifications"
    //     buttons: Skip | Turn on notifications
    //   m.facebook.com/?wtsid=...&_rdr                the plain home page
    // Neither matches a screen in this file, so the walk would sit there for
    // 30s and report "no known screen". The session is valid by this point, so
    // go straight back to where we were going rather than learning an
    // onboarding screen that only ever gets in the way.
    if (targetUrl) {
      log.info("Dismissed - returning to the password page");
      await page.goto(targetUrl, { waitUntil: "load" })
        .catch((e) => log.warn(`could not return to the target page: ${e?.message ?? e}`));
    }
    // Dismissed is not cleared. The walk loop re-detects whatever is on screen
    // now, so claiming the form is up here would be a guess.
    return;
  }
  // The human check: one button, Continue, no Dismiss.
  //
  // Continue is NOT clicked. Measured on 2fa100 row 9: it lands on a CAPTCHA
  // ("Enter the text from the image"), and a CAPTCHA is deliberately not solved
  // here - no image reading, no audio transcription, no code lookup. Clicking
  // would spend the account's clean screen to arrive at a dead end, and it
  // would leave `reachedForm` set while a CAPTCHA sat on top of the form.
  //
  // BailLogged, NOT BailGated: this is a stop, not a verdict. The account is
  // alive and a person clears it, so the row is retried and never skipped.
  if (await findHumanCheck(page)) {
    log.error("HUMAN CHECK: Facebook is asking to confirm we are human.");
    log.error("Continue is deliberately NOT clicked - it leads to a CAPTCHA, and a CAPTCHA is not solved here.");
    log.error("A person has to do it: bun index.js --codegen --xlsx <sheet> --row <n>");
    audit({ leg: "internal", what: "checkpoint", status: "human-check-encountered" });
    throw new BailLogged("human check: needs a person, Continue is not clicked");
  }
  // A CAPTCHA can also arrive without a human check in front of it. Same stop,
  // same reason - it is detected and handed to a person, never filled in.
  if (await captchaVisible(page)) {
    log.error("CAPTCHA: Facebook is asking for the text from an image. This is not solved here - a person has to do it.");
    log.error("Run: bun index.js --codegen --xlsx <sheet> --row <n>   and type it in by hand.");
    audit({ leg: "internal", what: "checkpoint", status: "captcha" });
    throw new BailLogged("captcha: needs a human");
  }
  log.warn("Facebook wants identity confirmation (a challenge, not a ban). Finish it in the browser window.");
  // With --hold, show it now instead of waiting ten minutes in silence: this
  // is the one screen whose wording decides whether an account gets written
  // off, and it is not in the DOM until the page has rendered.
  if (HOLD) return await holdForInspection(page, "checkpoint - challenge (not classified as a ban)");
  const deadline = Date.now() + minutes * 60_000;
  while (Date.now() < deadline) {
    if (page.isClosed()) throw new BailLogged("Browser closed during the checkpoint");
    if (await screens(page).passwordForm.loc.first().isVisible({ timeout: 500 }).catch(() => false)) {
      log.success("Checkpoint cleared - password form is up");
      return screens(page).passwordForm;
    }
    await sleep(POLL_MS);
  }
  await bail(page, "Checkpoint was not cleared in time");
}
async function bail(page, reason) {
  // --hold: never close on an unknown screen. Print it and keep the browser.
  if (HOLD) return await holdForInspection(page, reason);
  const dir = path.join(os.tmpdir(), "opencode");
  const file = path.join(dir, `pc-fail-${new Date().toISOString().replace(/[:.]/g, "-")}.png`);
  let text = "";
  try { text = (await page.locator("body").innerText({ timeout: 5000 })).replace(/\s+/g, " ").slice(0, 400); } catch { /* closed */ }
  log.error(reason);
  log.error(`Page text: ${text || "(unavailable)"}`);
  try { await page.screenshot({ path: file, fullPage: true }); log.error(`Screenshot: ${file}`); }
  catch { log.error("Screenshot failed (page closed?)"); }
  throw new BailLogged(reason);
}
async function tryClick(loc, label) {
  try { await loc.click({ timeout: 2000 }); }
  catch { log.warn(`Skipped optional click: ${label}`); }
}
// A click that times out is only a failure if the screen is STILL there.
// Facebook tears the old markup down while the click is in flight, so a
// timeout usually means the navigation already won the race - retrying then
// just throws on a button that no longer exists.
async function clickScreenAway(btn, screen, label) {
  try { await btn.click({ timeout: 5000 }); return; }
  catch (e) {
    if (await screen.loc.first().isVisible({ timeout: 1000 }).catch(() => false)) throw e;
    log.info(`${label}: screen already moved on, the click was not needed`);
  }
}
async function validationHints(page) {
  const hints = page.getByText(/must be different|do not match|at least \d+ characters|incorrect|wrong|required|try again/i);
  const out = new Set();
  const total = Math.min(await hints.count().catch(() => 0), 8);
  for (let i = 0; i < total; i++) {
    const t = (await hints.nth(i).innerText().catch(() => "")).replace(/\s+/g, " ").trim();
    if (t) out.add(t);
  }
  return [...out];
}
// A missing aria-disabled means enabled here - Facebook deletes the attribute
// rather than setting it to "false".
const isEnabled = (loc) =>
  loc.evaluate((el) => el.getAttribute("aria-disabled") !== "true" && !el.disabled).catch(() => false);

async function typeClean(page, loc, value, label) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (page.isClosed()) await bail(page, `Page closed while filling ${label}`);
    if (await codePromptVisible(page)) await bailCodePrompt((await codePromptText(page)) ?? "confirmation code");
    try { await loc.click({ timeout: 5000 }); }
    catch {
      if (await codePromptVisible(page)) await bailCodePrompt((await codePromptText(page)) ?? "confirmation code");
      await bail(page, `${label} could not be clicked - something is covering the form`);
    }
    await loc.fill("");
    await loc.pressSequentially(value, { delay: 20 });
    await page.waitForTimeout(POLL_MS);
    let got = "";
    try { got = await loc.inputValue({ timeout: 5000 }); }
    catch {
      if (await codePromptVisible(page)) await bailCodePrompt((await codePromptText(page)) ?? "confirmation code");
      await bail(page, `${label} disappeared while it was being filled`);
    }
    if (got === value) { log.success(`${label} field set (${value.length} chars)`); return; }
    log.warn(`${label} field mismatch (attempt ${attempt})`);
  }
  await bail(page, `${label} field would not accept the value (autofill fighting?)`);
}

export async function changePassword({ context, currentPw, newPw, targetUrl, dryRun = false }) {
  // Refused before the browser opens, and before anything is typed. This is the
  // one choke point every caller goes through, so it is the only place that can
  // be certain. Typing "" into the current-password field does not error - it
  // just fails the form, ten screen-walks later, with a message about the NEW
  // password being wrong.
  if (!currentPw) throw new Bail("Current Facebook password is empty. Pass -o <password> or set FB_CURRENT_PASSWORD in data/.env.");
  if (dryRun && !newPw) throw new Bail("A dry run needs a throwaway new password to validate against; refusing to type an empty one.");
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto("https://www.facebook.com/", { waitUntil: "load" });
  log.success("Established session on https://www.facebook.com/");
  await page.goto(targetUrl, { waitUntil: "load" });
  log.success(`Opened ${targetUrl}`);
  const S = screens(page);
  let picked = false;
  let reachedForm = false;
  // 10 steps, not 6: Continue -> password -> Log in -> Save is four hops
  // before the real form, and the old budget ran out mid-recovery.
  for (let step = 1; step <= 10; step++) {
    if (await codePromptVisible(page)) await bailCodePrompt((await codePromptText(page)) ?? "confirmation code");
    // Checked before the screen walk, the way the old FAF bot did. The URL
    // says "checkpoint" immediately, so a banned account costs no 30s screen
    // wait, and it is classified (ban vs challenge) before anything waits.
    // awaitCheckpoint returns the password form when one is actually up, and
    // undefined when it only dismissed a warning. Breaking on undefined would
    // claim the form was reached and start typing into whatever is on screen.
    if (isCheckpointUrl(page)) { if (await awaitCheckpoint(page, 10, targetUrl)) { reachedForm = true; break; } continue; }
    // loggedOut is last on purpose. The re-auth form also says "Log in", so
    // anything broader would file a recoverable session as a dead cookie.
    const here = await waitForScreen(page,
      [S.passwordForm, S.checkpoint, S.loggedOut, S.reauth, S.saveLogin, S.continueGate, S.accountChooser, S.hubChangePassword, S.accountHub],
      "the password form", 30_000);
    if (here === S.passwordForm) {
      if (!(await blockingDialog(page))) { reachedForm = true; break; }
      log.warn("A dialog is open over the password form — waiting for it to clear");
      await sleep(POLL_MS);
      continue;
    }
    if (here === S.loggedOut) await bail(page, "Session is logged out — the cookie is dead");
    // Not tryClick. A screen is only reported when it is already visible, so
    // a genuine failure must surface rather than warn and re-detect the same
    // screen until the budget runs out.
    if (here === S.continueGate) {
      log.info("Expired session - clicking Continue");
      await clickScreenAway(mButton(page, /^Continue$/), S.continueGate, "Continue");
      continue;
    }
    if (here === S.reauth) { await resumeSession(page, currentPw); continue; }
    if (here === S.saveLogin) {
      log.info("Facebook offered to save the login - accepting");
      await clickScreenAway(mButton(page, /^Save$/), S.saveLogin, "Save");
      continue;
    }
    if (here === S.checkpoint) {
      log.warn("A real identity-confirmation dialog is open.");
      if (await awaitCheckpoint(page, 10, targetUrl)) { reachedForm = true; break; }
      continue;
    }
    if (here === S.accountChooser) {
      if (picked) {
        const giveUpAt = Date.now() + 30_000;
        let formReady = false;
        while (Date.now() < giveUpAt) {
          if (await codePromptVisible(page)) await bailCodePrompt((await codePromptText(page)) ?? "confirmation code");
          if (!(await blockingDialog(page)) && (await S.passwordForm.loc.first().isVisible({ timeout: 400 }).catch(() => false))) { formReady = true; break; }
          await sleep(POLL_MS);
        }
        // BUG: this broke out of the loop without setting reachedForm, so the
        // one screen that DID work - form found right after picking the
        // account - fell through to "Never reached a usable password form".
        if (formReady) { reachedForm = true; break; }
        const sheetText = await accountSheet(page).innerText({ timeout: 2000 }).catch(() => "");
        if (/loading/i.test(sheetText) && !/current password/i.test(sheetText)) {
          log.error("Account sheet stuck on 'Loading...' - skipping row.");
          throw new BailGated("stuck: account sheet never left 'Loading...'");
        }
        log.info("Sheet still open after picking, no form yet — continuing");
        continue;
      }
      await pickAccount(page);
      picked = true;
      continue;
    }
    if (here === S.hubChangePassword) { log.info("On the hub — clicking 'Change password'"); await here.loc.first().click(); continue; }
    if (here === S.accountHub) { log.info("Opening the profile menu"); await here.loc.first().click(); continue; }
    if (!here) {
      if (HOLD) { await holdForInspection(page, `no known screen after ${step} step(s)`); }
      const text = await page.locator("body").innerText({ timeout: 5000 })
        .then((t) => t.replace(/\s+/g, " ").trim().slice(0, 500)).catch(() => "");
      log.error(`Step ${step}: no known screen after 30000ms. On screen: ${text || "(could not read)"}`);
      return { ok: false, verdict: text || "no known screen" };
    }
  }
  if (!reachedForm) {
    if (await codePromptVisible(page)) await bailCodePrompt((await codePromptText(page)) ?? "confirmation code");
    await bail(page, "Never reached a usable password form - see the screenshot");
  }
  const current = page.getByLabel("Current password", { exact: true });
  const next = page.getByLabel("New password", { exact: true });
  const retype = page.getByLabel("Retype new password", { exact: true });
  if (newPw === currentPw) await bail(page, "New password is identical to the current one — Facebook disables the button");
  await typeClean(page, current, currentPw, "Current password");
  await typeClean(page, next, newPw, "New password");
  await typeClean(page, retype, newPw, "Retype new password");
  const show = page.getByRole("button", { name: "Show password" });
  await tryClick(show.nth(2), "Show password #3");
  await tryClick(show.nth(1), "Show password #2");
  await tryClick(show.first(), "Show password #1");
  // getByRole("button", {name}) returns 0 here too - the accessible name is
  // stripped by the role=none wrapper, so match the DOM directly.
  //
  // Do NOT put [aria-disabled] in this selector. Facebook REMOVES that
  // attribute when the form becomes valid (measured: "true" -> absent), so
  // filtering on its presence made the button stop matching at the exact
  // moment it turned clickable, and isEnabled() then read false forever.
  //
  // Two role=button elements say "Change password": the sidebar nav tile
  // (y~179) and the real submit below the fields (y~748). The submit is last
  // in DOM order, and that held across every measured run.
  const submit = page.locator('[role="button"]').filter({ hasText: /^Change password$/ }).last();
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && !(await isEnabled(submit))) await page.waitForTimeout(POLL_MS);
  if (!(await isEnabled(submit))) {
    const hints = await validationHints(page);
    await bail(page, "Change password button stayed disabled. " + (hints.length ? `Page says: ${hints.join(" | ")}` : "No error text found."));
  }
  // --check-pw stops here on purpose: the form accepted both passwords and
  // Facebook enabled the button, which is everything that can be proven
  // without spending the change.
  if (dryRun) {
    log.success("CHECK PASSED: both fields accepted, 'Change password' is enabled");
    log.warn("NOT submitted - the password was not changed. Nothing was sent to the bot either.");
    return { ok: true, verdict: "dry run: form validated, submit not clicked" };
  }
  await submit.click();
  log.success("Clicked Change password — watching for the banner");
  const watchUntil = Date.now() + 15_000;
  const clean = (s) => s.replace(/\s+/g, " ").trim();
  // FIRST non-blank banner, kept for ever. The old code kept the LAST, so when
  // Facebook's banner vanished - which it does within a second or two - the empty
  // string overwrote the evidence and the change was reported as unconfirmed. The
  // log showed "banner: Your password is shown" and then "banner: |" two seconds
  // later, and it was that blank that decided the account was lost.
  let seenBanner = "";
  let verdict = "";
  const CONFIRMED = /your password is shown|you changed your facebook password|password (has been|was) (changed|updated)/i;
  while (Date.now() < watchUntil) {
    if (page.isClosed()) { log.warn("Page closed during watch — stopping early"); break; }
    if (await codePromptVisible(page)) await bailCodePrompt((await codePromptText(page)) ?? "confirmation code");
    const notices = await page.locator('[role="alert"], [role="status"], [aria-live]:not([aria-live="off"])')
      .allInnerTexts().then((list) => clean(list.join(" | "))).catch(() => "");
    if (notices) {
      if (notices !== seenBanner) { seenBanner = notices; log.info(`[${elapsed()}] banner: ${notices}`); }
      // The banner ITSELF is the confirmation - testing only the page body meant
      // reading it after the banner had already gone.
      if (CONFIRMED.test(notices) && !verdict) { verdict = notices; break; }
    }
    const body = await page.locator("body").innerText({ timeout: 2000 }).then(clean).catch(() => "");
    if (body) {
      const hit = body.match(/.{0,40}(your password is shown|you changed your facebook password[^.]{0,60}|password (has been|was) (changed|updated)[^.]{0,40}|(incorrect|wrong|does not|do not) match|incorrect password|try again|unable to (change|update)[^.]{0,40}).{0,40}/i);
      if (hit && !verdict) { verdict = clean(hit[0]); break; }
    }
    // 100ms, not POLL_MS. The banner is gone almost instantly, so a 500ms tick
    // can walk straight past it; this loop missed one that had definitely shown.
    await sleep(100);
  }
  if (!verdict && seenBanner) verdict = seenBanner;
  // "Your password is shown" IS the confirmation - Facebook is displaying the new
  // password BECAUSE it changed it.
  const ok = CONFIRMED.test(verdict);
  if (ok) log.success(`RESULT: ${verdict}`);
  else if (verdict) log.error(`RESULT: ${verdict}`);
  else log.warn("RESULT: no confirmation banner seen — sending anyway, flagged unconfirmed");
  return { ok, verdict };
}

// ---- Telegram ----
// Everything that is not code lives in ./data - the sheets, the Telegram
// sessions, the credentials and the docs. One place to look, and one rule for
// gitignore.
const SESSION_DIR = path.join(DATA_DIR, "sessions");
function bridgeEnv() {
  const out = {};
  for (const f of [path.join(__dirname, "..", "Backend", ".env"), path.join(DATA_DIR, ".env")]) {
    if (!fs.existsSync(f)) continue;
    for (const line of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
  return out;
}
export function normalizePhone(phone) {
  const p = phone.trim().replace(/[\s()\-.]/g, "");
  return p.startsWith("+") ? `+${p.slice(1).replace(/\D/g, "")}` : p.replace(/\D/g, "");
}
const sessionPath = (phone) => path.join(SESSION_DIR, `${normalizePhone(phone)}.session`);
export function listSessions() {
  if (!fs.existsSync(SESSION_DIR)) return [];
  return fs.readdirSync(SESSION_DIR).filter((f) => f.endsWith(".session"))
    .map((f) => f.slice(0, -".session".length)).sort();
}
import { createInterface } from "node:readline";
function ask(q) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(q, (a) => { rl.close(); resolve(a.trim()); }));
}
export function textFrom(update) {
  const m =
    update instanceof Api.UpdateNewMessage ? update.message
    : update instanceof Api.UpdateNewChannelMessage ? update.message
    : update instanceof Api.UpdateEditMessage ? update.message
    : update instanceof Api.UpdateEditChannelMessage ? update.message : null;
  return { text: String(m?.message ?? ""), msg: m };
}
export class Taskly {
  constructor(client) { this.client = client; this._window = []; this._lastSend = 0; }
  static async open(opts = {}) {
    const env = bridgeEnv();
    const apiId = Number(process.env.TG_API_ID ?? env.TG_API_ID);
    const apiHash = process.env.TG_API_HASH ?? env.TG_API_HASH;
    if (!apiId || !apiHash) throw new Error("TG_API_ID / TG_API_HASH missing (Backend/.env or .env)");
    const have = listSessions();
    const phone = opts.phone ?? process.env.TG_PHONE ?? (have.length === 1 ? have[0] : undefined);
    if (!phone) throw new Error(have.length
      ? `Several sessions exist (${have.join(", ")}). Pass -p <phone>.`
      : `No session yet. Create one: bun index.js --login <phone>`);
    const file = sessionPath(phone);
    const saved = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    const digits = normalizePhone(phone);
    const client = new TelegramClient(new StringSession(saved), apiId, apiHash, { connectionRetries: 3 });
    // gramJS logs its own connection chatter at INFO - which DC it dialled, the
    // layer it negotiated, disconnect notices. None of it is actionable and it
    // was a third of the screen. This must be set on the CLIENT: the static
    // Logger.setLevel is deprecated in 2.26 and does nothing.
    client.setLogLevel(process.env.TOOL_DEBUG ? "debug" : "error");
    const t = new Taskly(client);
    // Carried on the instance so the verdict watcher can restrict pairing to
    // submissions that went out on THIS session. See recordVerdict.
    t.phone = digits;
    // Where a verdict is written. "jsonl" pairs it with a sheet row; "db"
    // pairs it with the user who submitted it. One watcher, one sink.
    t.verdictSink = opts.verdictSink ?? "jsonl";
    await client.connect();
    if (!(await client.checkAuthorization())) {
      tlog.info(`Logging in as ${digits} (one time)`);
      await client.start({
        phoneNumber: digits,
        phoneCode: async () => ask("Telegram login code: "),
        password: async (hint) => ask(`Telegram 2FA password${hint ? ` (hint: ${hint})` : ""}: `),
        onError: (err) => { tlog.err(err.message); return true; },
      });
    }
    fs.mkdirSync(SESSION_DIR, { recursive: true });
    fs.writeFileSync(file, client.session.save(), "utf8");
    tlog.ok(`Session ready for ${digits}`);
    t.peer = await client.getEntity(process.env.TG_TARGET ?? env.TG_TARGET ?? "tasklyBux_bot");
    t.installVerdictWatcher();
    return t;
  }
  async close() { await this.client.disconnect().catch(() => {}); }
  // The provider rate-limits us and says how long to wait. Obeying it is the
  // whole handling - the message replaces the reply we wanted, so the account
  // is still available and only the wait is missing.
  // Returns {replies, waited}. The first attempt returned just the seconds,
  // which silently inverted every `if (!await obey(...))` at the call sites -
  // one of them reported a healthy group as "could not open". Both halves are
  // returned so a caller can pass the replies on AND branch on the wait.
  async obeyRateLimit(replies) {
    const s = rateLimitSeconds(replies);
    if (!s) return { replies, waited: 0 };
    log.warn(`Provider rate limit: waiting ${s}s as instructed`);
    audit({ leg: "internal", what: "rate-limit", waitSec: s });
    await sleep(s * 1000 + 500);
    return { replies, waited: s };
  }
  // True when the provider's own timer ran out. The account is already lost by
  // then, so the only thing to add is a clear reason.
  isTaskCancelled(replies) {
    return (Array.isArray(replies) ? replies : [replies]).some((t) => TASK_CANCELLED.test(String(t ?? "")));
  }
  // "Action cancelled." is OUR confirmation that pressing Cancel cleared a
  // modal state. Expected, not a failure - logged so it is not mistaken for a
  // rejected report or a provider timeout.
  noteActionCancelled(replies) {
    if (!(Array.isArray(replies) ? replies : [replies]).some((t) => ACTION_CANCELLED.test(String(t ?? "")))) return false;
    tlog.ok("Action cancelled - that was our own Cancel button clearing provider state");
    return true;
  }
  // Verdicts arrive unprompted and sometimes mid-action, so this handler lives
  // for the whole session rather than being attached per exchange.
  installVerdictWatcher() {
    this.client.addEventHandler(async (update) => {
      const { text, msg } = textFrom(update);
      if (!msg || !text || msg.out) return;
      if (!this.isFromPeer(msg.peerId)) return;
      const v = parseVerdict(text);
      if (!v) return;
      // Two sinks, one watcher. "db" is the user-facing path: the verdict is
      // bound to the user who sent the account. "jsonl" is the sheet path.
      // Never both, or one verdict would be written twice and counted twice.
      if (this.verdictSink === "db") {
        const { bindVerdict, STATUS } = await import("./db.js");
        const status = v.verdict === "approved" ? STATUS.APPROVED : STATUS.REJECTED;
        const row = await bindVerdict(this.phone, status, String(v.reason ?? "").slice(0, 200));
        if (row) {
          log.success(`Verdict ${v.verdict} -> submission ${row.id} (fp ${row.fp})`);
          audit({ leg: "internal", what: "verdict-db", status: v.verdict, fp: row.fp });
        } else {
          // Never claim another session's row. Say so loudly instead.
          log.error(`Verdict ${v.verdict} on session ...${String(this.phone ?? "").slice(-4)} with nothing in flight - unpaired, nobody was charged for it.`);
        }
        return;
      }
      const rec = recordVerdict(v, this.phone);
      const who = rec.claim
        ? `${path.basename(rec.claim.source ?? "")}:${rec.claim.row} (fp ${rec.claim.fp})`
        : `UNMATCHED - session ...${String(this.phone ?? "").slice(-4)} had nothing waiting`;
      if (v.verdict === "approved") log.success(`Verdict: APPROVED +$${v.amount} -> ${who}`);
      else log.error(`Verdict: REJECTED${v.accountBlocked ? " (says account blocked)" : ""} -> ${who}`);
      if (rec.claim) audit({ leg: "internal", what: "verdict", status: v.verdict, fp: rec.claim.fp, accountBlocked: !!v.accountBlocked });
    });
  }
  isConnected() {
    try { return this.client.connected === true; } catch { return false; }
  }
  resetWindow() { this._window = []; }
  _peerKey(p) {
    return `${Number(p?.channelId ?? 0)}:${Number(p?.chatId ?? 0)}:${Number(p?.userId ?? p?.id ?? 0)}`;
  }
  isFromPeer(p) { return this._peerKey(p) === this._peerKey(this.peer); }
  listen(seconds) {
    const got = [];
    tlog.info(`Listening ${seconds}s…`);
    return new Promise((resolve) => {
      const handler = (update) => {
        const { text, msg } = textFrom(update);
        if (!msg || !text || msg.out) return;
        if (!this.isFromPeer(msg.peerId)) return;
        got.push(text);
        this._window.push(msg);
        audit({ leg: "taskly->bot", what: "listen", text, buttons: this.labels() });
        tlog.raw(`  <- ${preview(text)}`);
      };
      this.client.addEventHandler(handler);
      setTimeout(() => { this.client.removeEventHandler(handler); resolve(got); }, seconds * 1000);
    });
  }
  async _throttle() {
    const since = Date.now() - this._lastSend;
    if (since < THROTTLE_MS) await sleep(THROTTLE_MS - since);
    this._lastSend = Date.now();
  }
  async latestId() {
    const msgs = await this.client.getMessages(this.peer, { limit: 1 });
    const rows = Array.isArray(msgs) ? msgs : [...msgs];
    return Number(rows[0]?.id ?? 0);
  }
  async freshSince(afterId, limit = 8) {
    const msgs = await this.client.getMessages(this.peer, { limit: limit * 2 });
    const rows = Array.isArray(msgs) ? msgs : [...msgs];
    return rows.filter((m) => !m.out && Number(m.id) > afterId)
      .map((m) => String(m.message ?? "")).filter(Boolean).reverse();
  }
  async sendRaw(what, text) {
    audit({ leg: "bot->taskly", what, text, chars: text.length });
    await this._throttle();
    tlog.info(`${what}: sending ${text.length} chars`);
    return this._exchange(what, () => this.client.sendMessage(this.peer, { message: text }));
  }
  async press(what, want) {
    const full = this.resolveLabel(want);
    if (!full) {
      audit({ leg: "internal", what, error: "no-match", want, onScreen: this.labels() });
      throw new Error(`no button matches "${want}"; on screen: ${this.labels().join(" | ") || "(nothing)"}`);
    }
    audit({ leg: "bot->taskly", what, text: full, pressed: want });
    await this._throttle();
    tlog.info(`${what}: press "${full}"`);
    return this._exchange(what, () => this.client.sendMessage(this.peer, { message: full }));
  }
  _exchange(what, send) {
    const got = [];
    let idle, hard, done;
    const finished = new Promise((r) => (done = r));
    const handler = (update) => {
      const { text, msg } = textFrom(update);
      if (!msg || !text || msg.out) return;
      if (!this.isFromPeer(msg.peerId)) return;
      got.push(text);
      this._window.push(msg);
      if (this._window.length > 12) this._window.shift();
      audit({ leg: "taskly->bot", what, text, chars: text.length, buttons: this.labels() });
      tlog.raw(`  <- ${preview(text)}`);
      clearTimeout(idle);
      idle = setTimeout(done, QUIET_MS);
    };
    this.client.addEventHandler(handler);
    return (async () => {
      try {
        // Telegram's flood wait arrives as a THROWN error from send, so it never
        // reaches obeyRateLimit (which only reads replies). Wait out exactly what
        // was asked, then retry the same send - nothing was delivered, so nothing
        // is lost and no row needs re-running. Anything that arrived while we had
        // sent nothing cannot be this exchange's reply, so it is dropped here
        // (the permanent verdict watcher still records verdicts separately).
        for (;;) {
          try { await send(); break; }
          catch (e) {
            const flood = floodWaitSeconds(e);
            if (!flood) throw e;
            const winMark = this._window.length;
            log.warn(`Telegram flood limit: waiting ${flood}s as instructed, then retrying ${what}`);
            audit({ leg: "internal", what: "telegram-flood-wait", waitSec: flood });
            await sleep(flood * 1000 + 500);
            got.length = 0;
            this._window.length = winMark;
          }
        }
        hard = setTimeout(done, HARD_MS); await finished;
      }
      finally { clearTimeout(idle); clearTimeout(hard); this.client.removeEventHandler(handler); }
      return got;
    })();
  }
  labels() {
    const out = [];
    for (let i = this._window.length - 1; i >= 0; i--) {
      for (const row of this._window[i]?.replyMarkup?.rows ?? [])
        for (const b of row?.buttons ?? []) {
          const t = b?.text ?? b?.label;
          if (t && !out.includes(t)) out.push(t);
        }
    }
    return out;
  }
  resolveLabel(want) {
    const q = want.trim().toLowerCase();
    return this.labels().find((l) => l.toLowerCase().includes(q)) ?? null;
  }
  hasButton(want) { return !!this.resolveLabel(want); }
  // Returns the replies so the caller can look for a rate limit in them.
  async ensureMainMenu() {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const replies = await this.sendRaw("knock", "/start");
      if (this.hasButton("Balance")) return replies;
      tlog.err(`attempt ${attempt}: not on the main menu, clearing provider state`);
      if (!this.hasButton("Cancel")) throw new Error("provider is not on the main menu and offers no Cancel");
      // "Action cancelled." is the expected confirmation of our own Cancel. It
      // is deliberately NOT treated as a failure - see ACTION_CANCELLED.
      this.noteActionCancelled(await this.press("clear state", "Cancel"));
    }
    throw new Error("could not return to the main menu after 3 attempts");
  }
}

// ---- Credentials from the bot ----
export function parseCreds(replies) {
  const text = replies.join("\n");
  const field = (name) =>
    text.match(new RegExp(`\\b${name}\\s*[:=]\\s*(\\S+)`, "i"))?.[1]?.trim() ?? null;
  return { firstName: field("first name"), lastName: field("last name"), password: field("password") };
}
async function changeFacebook(currentPw, newPw, url, cookieString, dryRun = false) {
  const browser = await launchBrowser();
  const context = await browser.newContext({ ...DEVICES_PHONE, locale: "en-US" });
  try {
    await context.addInitScript(STEALTH_INIT);
    // No clearCookies(): a fresh context is already empty. Keeping it would
    // suggest the context carries state, which is the bug this replaced.
    await context.addCookies(parseCookies(cookieString.trim(), process.env.COOKIE_DOMAIN ?? new URL(url).hostname));
    log.success("Cookies loaded");
    return await changePassword({ context, currentPw, newPw, targetUrl: url, dryRun });
  } finally {
    // A non-persistent context does not own the browser: close both.
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

// Expired-session recovery: Continue -> re-enter password -> Log in ->
// "Save your login info?" -> Save. The password here is the account's OWN
// current password (same one the change flow starts from), so this spends
// nothing and changes nothing. Only reached when the cookie still names an
// account - a cookie that resolves to nothing goes down the dead path instead.
async function resumeSession(page, currentPw) {
  log.warn("Session expired but the cookie still identifies the account - resuming");
  // Poll for the password field rather than sleeping a fixed second: the page
  // after Continue took anywhere from 2s to 5s in the measured runs.
  const field = page.locator('input[type="password"]').first();
  const hit = await waitForAny([field], 10_000, "the re-auth password field",
    () => bail(page, "Continue did not lead to the password form"));
  if (!hit) return;
  await typeClean(page, hit.loc, currentPw, "Re-auth password");
  // No Show password click: it is cosmetic, and every probe shows the label
  // absent on this form, so asking for it only produced a false warning.
  await tryClick(mButton(page, /^Log in$/), "Log in");
  // Do not sleep here waiting for the next screen: the walk loop re-detects it,
  // and waitForScreen already polls. That was the point - act when it is up.
}

// TWO automated-behaviour screens, handled in opposite ways. Confusing them is
// the bug this whole comment exists to prevent.
//
//   1. "confirm that you're human to use your account"  buttons: Continue
//      2fa100 row 9, via --hold. Continue is NOT clicked. Measured: it lands on
//      a CAPTCHA, and a CAPTCHA is not solved here. Stops and hands the row to
//      a person.
//
//   2. "We suspect automated" / "To prevent your account from being hacked"
//      buttons: Dismiss
//      2fa43 row 38. This one IS dismissed and the walk carries on.
//
// An earlier version of this file handled only (1) and described it as "click
// Dismiss" - which is what (2) actually is. A handler written from that
// description would have found no Dismiss on row 9 and clicked nothing. So both
// wordings are pinned in --selftest, including the assertion that neither regex
// matches the other's screen.
//
// Note (2) was first seen on a row whose password had been typed wrong by hand,
// and the checkpoint was reached by a manual page.goto the tool never performs.
// So the click is unproven on a natural run. It is audited
// (checkpoint/auto-warning-dismissed) so repeated dismissals on one account are
// visible if Facebook starts escalating.
//
//   bun index.js --check-pw --hold --xlsx data\sheet.xlsx --row <n> -o <pw>
//
// --hold is still the tool for the next unknown screen: it prints the url,
// text, buttons, links, inputs and dialogs, waits for the page to actually
// render before reporting it empty, and leaves the browser open to poke at.

// "Failed to load" is what m.facebook.com serves when the login POST comes back
// without a usable page. Measured on 2fa43 row 38, in this order:
//
//   Continue -> password -> Log in -> "Failed to load" -> reload
//     -> /checkpoint/ -> "We suspect automated" -> Dismiss
//
// Nothing in screens() matches it, so the walk used to sit there until the 30s
// screen wait expired and report "no known screen". Matched on the exact
// phrase only - "try again" also appears among the password form's own error
// hints and would fire on a perfectly healthy row.
//
// It has to be a SCREEN, not a one-off check at the top of the walk loop. The
// first version of --check-gate tested it once per iteration and then blocked in
// waitForScreen for 20s - and "Failed to load" arrived during that block, so it
// was reported as "unrecognised screen" with its own text printed right below
// the message saying it was unrecognised. A screen that appears DURING a wait
// has to be in the list that wait polls.
const FAILED_TO_LOAD = /failed to load/i;
// One reload is measured as enough. Capped because a page that keeps saying
// "Failed to load" after a reload is a different problem, and looping on it
// would just burn the step budget.
const MAX_RELOADS = 2;

// Exit codes, so a caller can branch without parsing the log.
//   0 reached the password form, no gate     3 auto-warning, Dismiss present
//   1 unrecognised screen                    4 auto-warning, Dismiss ABSENT
//   2 ran out of steps                       5 human check, Continue present
//   7 SMS gate / CAPTCHA                     6 human check, Continue absent
//   8 fully dead, logged out                 9 "Failed to load"
// Every non-zero here is a REPORT, not a failure. Nothing was changed.
const GATE = { FORM: 0, UNKNOWN: 1, STEPS: 2, DISMISS: 3, NO_DISMISS: 4, CONTINUE: 5, NO_CONTINUE: 6, GATED: 7, DEAD: 8, FAILED: 9, DISMISSED: 10 };

// Reports one gate and exits. dumpScreen prints the url, text, buttons, links,
// inputs and dialogs, so the answer is readable from the log alone.
async function reportGate(page, name, code, verdict) {
  log.error(`── GATE: ${name} ──`);
  log.error(`  verdict:  ${verdict}`);
  log.error(`  exit code: ${code}`);
  await dumpScreen(page, name);
  return code;
}

// --check-gate: walk one row as far as the screens allow and REPORT the gate it
// lands on. By default it clicks nothing that can change an account: no Dismiss,
// no human-check Continue, no Change password.
//
// --dismiss makes the ONE exception: it clicks Dismiss on the automated-behaviour
// warning, then reports what is on screen afterwards. --hold keeps the browser
// open at that point so the next screen can be watched and recorded. That pair
// is how a screen we have never seen gets learned: --hold dumps its url, text,
// buttons, links, inputs and dialogs and leaves the browser for the hand.
//
// It does type the password when the session has expired, because the
// automated-behaviour screen is DOWNSTREAM of the re-auth - there is no way to
// reach it otherwise. The clicks needed to get there (Continue on the session
// gate, Log in) are navigation rather than gate handling, and each is logged.
async function runCheckGate(args) {
  const { context, page, url, browser } = await openRowBrowser(args);
  const currentPw = argValue(args, ["--current-password", "-o"]) ?? process.env.FB_CURRENT_PASSWORD;
  const S = { ...screens(page), failedToLoad: { name: "Failed to load (reload)", loc: page.getByText(FAILED_TO_LOAD).first() } };
  // The m.facebook.com login wording. screens().loggedOut still carries the
  // older /Email or phone number/ pattern, which the real page does not use, so
  // the reporter matches the wording it was measured on rather than relying on
  // a detector that does not fire.
  const loginScreen = /log into facebook|email or phone number|mobile number or email/i;
  let reloads = 0;
  try {
    for (let step = 1; step <= 10; step++) {
      if (await codePromptVisible(page)) return await reportGate(page, "SMS gate", GATE.GATED, "Facebook wants a code by SMS - not solved here");
      if (isCheckpointUrl(page)) {
        const text = await pageText(page);
        // findAutoWarning / findHumanCheck POLL for the button; do not replace
        // these with a one-shot isVisible. Measured on 2fa43 row 38: a single
        // 400ms check reported "Dismiss is ABSENT" while dumpScreen, a moment
        // later, listed the Dismiss button on the very same page. The checkpoint
        // renders late (see the comment above findHumanCheck), so the button has
        // to be waited for, not sampled.
        if (AUTO_WARNING.test(text)) {
          const btn = await findAutoWarning(page);
          if (!btn) return await reportGate(page, "automated-behaviour warning", GATE.NO_DISMISS, "Dismiss never appeared - nothing to click");
          if (!args.includes("--dismiss")) {
            return await reportGate(page, "automated-behaviour warning", GATE.DISMISS,
              "DISMISS IS PRESENT - not clicked. Add --dismiss to click it, --hold to keep the browser open afterwards.");
          }
          // The one gate this tool clicks. Opt-in via --dismiss, and audited,
          // so repeated dismissals on one account are visible if Facebook ever
          // starts escalating.
          log.warn("--dismiss: clicking Dismiss on the automated-behaviour warning");
          audit({ leg: "internal", what: "checkpoint", status: "auto-warning-dismissed" });
          await btn.click({ timeout: 8000 }).catch((e) => log.warn(`Dismiss would not click: ${e?.message ?? e}`));
          await waitForGone(anyButton(page, /^Dismiss$/), 5_000, "the automated-behaviour warning");
          // Dismissed does not go anywhere useful, and the landing page is not
          // fixed - measured twice on the same day: gettingstarted/
          // notifications/ ("Turn on notifications") and plain m.facebook.com.
          // Neither matches a screen here, so the walk would report "no known
          // screen" and sit for 30s. Go back to the password page instead.
          log.success("Dismissed. Facebook dropped us on an onboarding page; going to the password page instead.");
          log.info(`  it landed on: ${page.url().slice(0, 110)}`);
          await page.goto(url, { waitUntil: "load" })
            .catch((e) => log.warn(`could not reach the target page: ${e?.message ?? e}`));
          if (HOLD) {
            log.success(`Now on the password page: ${page.url().slice(0, 110)}`);
            log.warn("Holding this browser open. Ctrl+C in this terminal to end.");
            await holdForInspection(page, "after Dismiss, back on the target page - held open by --hold");
          }
          continue;
        }
        if (HUMAN_CHECK.test(text)) {
          const btn = await findHumanCheck(page);
          return await reportGate(page, "human check", btn ? GATE.CONTINUE : GATE.NO_CONTINUE,
            btn ? "CONTINUE IS PRESENT - not clicked (dry run)" : "Continue never appeared");
        }
        if (await captchaVisible(page)) return await reportGate(page, "CAPTCHA", GATE.GATED, "not solved, by design");
        return await reportGate(page, "checkpoint, wording unrecognised", GATE.UNKNOWN, "neither wording matched");
      }
      if (await captchaVisible(page)) return await reportGate(page, "CAPTCHA", GATE.GATED, "not solved, by design");
      const body = await pageText(page);
      if (loginScreen.test(body)) return await reportGate(page, "LOGGED OUT (fully dead cookie)", GATE.DEAD, "wants an email/phone this sheet does not have");
      // failedToLoad leads the list: it is the one screen that turns up WHILE a
      // wait is already running, and it is unambiguous - no other screen is on
      // the page at the same time.
      const here = await waitForScreen(page,
        [S.failedToLoad, S.passwordForm, S.checkpoint, S.reauth, S.saveLogin, S.continueGate, S.accountChooser, S.hubChangePassword, S.accountHub],
        "a gate or the form", 20_000);
      if (!here) return await reportGate(page, "unrecognised screen", GATE.UNKNOWN, `nothing matched in 20s. Last text: ${body.slice(0, 120)}`);
      log.success(`[${elapsed()}] step ${step}: ${here.name}`);
      if (here === S.passwordForm) {
        if (await blockingDialog(page)) { log.warn("a dialog covers the form - waiting"); await sleep(POLL_MS); continue; }
        return await reportGate(page, "password change form", GATE.FORM, "NO GATE - this cookie walks straight through");
      }
      // The recovery, measured: a RELOAD is what takes "Failed to load" on to
      // the /checkpoint/ screen. Not a click - that page has no buttons on it.
      if (here === S.failedToLoad) {
        if (reloads >= MAX_RELOADS) return await reportGate(page, "Failed to load", GATE.FAILED, `still failing after ${reloads} reload(s) - reloading is not fixing it`);
        reloads++;
        log.warn(`"Failed to load" - reloading (${reloads}/${MAX_RELOADS}). This is what reaches the checkpoint.`);
        await page.reload({ waitUntil: "load" }).catch((e) => log.warn(`reload failed: ${e?.message ?? e}`));
        continue;
      }
      // Navigation only. Every click that RESOLVES a gate is deliberately absent.
      if (here === S.continueGate) { log.info("navigating: session-expired Continue"); await clickScreenAway(mButton(page, /^Continue$/), S.continueGate, "Continue"); continue; }
      if (here === S.reauth) { log.info("navigating: re-auth - types the password, because the gate is downstream of it"); await resumeSession(page, currentPw); continue; }
      if (here === S.saveLogin) { log.info("navigating: Save login"); await clickScreenAway(mButton(page, /^Save$/), S.saveLogin, "Save"); continue; }
      if (here === S.accountChooser) { await pickAccount(page); continue; }
      await here.loc.first().click();
    }
    return await reportGate(page, "ran out of steps", GATE.STEPS, "10 steps, no gate reached");
  } finally {
    await closeAll(browser, context);
  }
}

// ---- Codegen (manual browser with one row's cookie, no Telegram) ----
// cookieOverride lets a caller open the browser with a cookie that is not the
// one in the sheet - used by --refresh-cookie to retest a freshly issued
// session in a clean browser.
async function openRowBrowser(args, cookieOverride) {
  const sheets = argValues(args, "--xlsx");
  if (!sheets.length) throw new Bail("usage: bun index.js --codegen [--detect|--check-gate|--check-pw|--refresh-cookie] --xlsx <sheet> [--row N]");
  const pick = resolveRow(sheets[0], Number(argValue(args, ["--row"]) ?? "1"));
  const url = resolveUrl();
  const cookie = (cookieOverride ?? pick.cookie).trim();
  const browser = await launchBrowser();
  const context = await browser.newContext({ ...DEVICES_PHONE, locale: "en-US" });
  try {
    await context.addInitScript(STEALTH_INIT);
    await context.addCookies(parseCookies(cookie, process.env.COOKIE_DOMAIN ?? new URL(url).hostname));
    log.success(`${path.basename(sheets[0])}: row ${pick.row} (fp ${fingerprint(pick.cookie)})`);
    const page = await context.newPage();
    await page.goto("https://www.facebook.com/", { waitUntil: "load" });
    await page.goto(url, { waitUntil: "load" });
    return { context, page, url, browser };
  } catch (e) {
    await closeAll(browser, context);
    throw e;
  }
}
// A non-persistent context does not own the browser, so both must be closed.
// Getting this wrong leaks a Chrome process, which then holds the old profile
// lock and breaks the next run.
async function closeAll(browser, context) {
  await context?.close().catch(() => {});
  await browser?.close().catch(() => {});
}
async function runCodegen(args) {
  const { context, page, url, browser } = await openRowBrowser(args);
  try {
    log.success(`Opened ${url} - inspect, then close the window`);
    await page.pause();
  } finally {
    await closeAll(browser, context);
  }
}

// --detect: walks the same screens changePassword does and prints what it
// identifies. It clicks navigation tiles only - nothing is typed, nothing is
// submitted, so the account is untouched. Exit 0 = the form was found.
async function runDetect(args) {
  const { context, page, browser } = await openRowBrowser(args);
  const S = screens(page);
  const currentPw = argValue(args, ["--current-password", "-o"]) ?? SHARED_PASSWORD;
  // Without this the account row is clicked twice: the sheet stays detectable
  // while it closes, and pickAccount waits long enough to click a stale row.
  let picked = false;
  try {
    for (let step = 1; step <= 10; step++) {
      if (await codePromptVisible(page)) await bailCodePrompt((await codePromptText(page)) ?? "confirmation code");
      const here = await waitForScreen(page,
        [S.passwordForm, S.checkpoint, S.loggedOut, S.reauth, S.saveLogin, S.continueGate, S.accountChooser, S.hubChangePassword, S.accountHub],
        "the password form", 30_000);
      if (!here) {
        const text = await page.locator("body").innerText({ timeout: 5000 })
          .then((t) => t.replace(/\s+/g, " ").trim().slice(0, 300)).catch(() => "");
        log.error(`UNKNOWN: nothing matched in 30s. On screen: ${text || "(could not read)"}`);
        return 1;
      }
      log.success(`[${elapsed()}] step ${step}: ${here.name}`);
      if (here === S.passwordForm) {
        if (await blockingDialog(page)) { log.warn("a dialog covers the form - waiting for it"); await sleep(POLL_MS); continue; }
        log.success("DETECTED: the password change form. The run would type and submit here.");
        return 0;
      }
      if (here === S.loggedOut) { log.error("DEAD: logged out, the cookie is not a session"); return 1; }
      if (here === S.checkpoint) { log.error("CHECKPOINT: an identity dialog is open - a human has to clear it"); return 1; }
      // --detect does the navigation hops, including re-auth, because whether
      // those work IS the thing being detected. It never reaches the form,
      // which is where typing would start.
      if (here === S.continueGate) { await clickScreenAway(mButton(page, /^Continue$/), S.continueGate, "Continue"); continue; }
      if (here === S.reauth) { await resumeSession(page, currentPw); continue; }
      if (here === S.saveLogin) { await clickScreenAway(mButton(page, /^Save$/), S.saveLogin, "Save"); continue; }
      if (here === S.accountChooser) { if (!picked) { await pickAccount(page); picked = true; } continue; }
      await here.loc.first().click();
    }
    log.error("UNKNOWN: 10 steps and no password form");
    return 1;
  } finally {
    await closeAll(browser, context);
  }
}

// Facebook requires >=6 chars mixing letters, numbers and one of !$@%.
// randomBytes().toString("base64url") can emit - and _, which are NOT in
// that set, so it produced a password the form silently refused. Hex is
// letters and digits only; the trailing ! supplies the special character.
const throwawayPassword = () => `Chk${randomBytes(6).toString("hex")}9a!`;

// --check-pw: fills the real password form with a throwaway password and stops
// once Facebook enables the submit button. The button is never clicked, so the
// account password is unchanged and nothing is sent to the provider.
async function runCheckPw(args) {
  const currentPw = argValue(args, ["--current-password", "-o"]) ?? process.env.FB_CURRENT_PASSWORD;
  if (!currentPw) throw new Bail("--check-pw needs the current password: pass -o <password> or set FB_CURRENT_PASSWORD");
  // Facebook requires >=6 chars mixing letters, numbers and one of !$@%.
  // randomBytes().toString("base64url") can emit - and _, which are NOT in
  // that set, so it produced a password the form silently refused. Hex is
  // letters and digits only; the trailing ! supplies the special character.
  const newPw = argValue(args, ["--password", "-P"]) ?? throwawayPassword();
  if (newPw === currentPw) throw new Bail("--check-pw: the throwaway password equals the current one - Facebook disables the button");
  const { context, page, url, browser } = await openRowBrowser(args);
  try {
    const pick = resolveRow(argValues(args, "--xlsx")[0], Number(argValue(args, ["--row"]) ?? "1"));
    log.info(`Filling the form with a throwaway password (${newPw.length} chars). Nothing will be submitted.`);
    const r = await changePassword({ context, currentPw, newPw, targetUrl: url, dryRun: true });
    log.info(`row ${pick.row} / fp ${fingerprint(pick.cookie)}`);
    return r.ok ? 0 : 1;
  } finally {
    await closeAll(browser, context);
  }
}

const cookieNames = (c) => [...new Set(c.split(";").map((p) => p.split("=")[0].trim()).filter(Boolean))];
// Values are NEVER printed or logged - a cookie is a live credential. Only
// names, lengths and hashes are safe to show.
const cookieDigest = (c) => createHash("sha256").update(c).digest("hex").slice(0, 12);

// Rewrites column A of one row, leaving column B (the 2FA key) alone. The
// sheet is the source of truth for every account we own, so it is copied to
// .bak first and the write is read back before it is called a success.
function writeCookieToSheet(file, row, cookie) {
  const real = resolveFile(file);
  const bak = `${real}.bak`;
  if (!fs.existsSync(bak)) fs.copyFileSync(real, bak);
  const wb = XLSX.readFile(real);
  const name = wb.SheetNames[0];
  const sheet = wb.Sheets[name];
  const addr = XLSX.utils.encode_cell({ r: row - 1, c: 0 });
  if (!sheet[addr]) throw new Bail(`row ${row} column A is empty in ${path.basename(real)} - not writing`);
  XLSX.utils.sheet_add_aoa(sheet, [[cookie]], { origin: addr });
  XLSX.writeFile(wb, real);
  const back = String(XLSX.utils.sheet_to_json(XLSX.readFile(real).Sheets[name], { header: 1, raw: false })[row - 1]?.[0] ?? "");
  if (back.trim() !== cookie.trim()) throw new Bail(`write-back did not verify in ${path.basename(real)} - restore from ${path.basename(bak)}`);
  return bak;
}

// --refresh-cookie: does the Continue -> password -> Save login flow once, then
// reads the session Facebook hands back. A completed login should be more
// trusted than the cookie we started with, so this proves it: reopen a fresh
// browser with the NEW cookie only and see whether the Continue gate is gone.
//
// Read-only. It never writes the new cookie back to the sheet - it prints the
// comparison and leaves that decision to you.
async function runRefreshCookie(args) {
  const file = argValues(args, "--xlsx")[0];
  if (!file) throw new Bail("usage: bun index.js --refresh-cookie --xlsx <sheet> --row N [-o <currentPw>]");
  const row = Number(argValue(args, ["--row"]) ?? "1");
  const pick = resolveRow(file, row);
  const currentPw = argValue(args, ["--current-password", "-o"]) ?? process.env.FB_CURRENT_PASSWORD;
  if (!currentPw) throw new Bail("--refresh-cookie needs the current password: pass -o <password> or set FB_CURRENT_PASSWORD");
  const url = resolveUrl();
  const oldCookie = pick.cookie.trim();

  log.info(`Row ${pick.row}: logging in once to get a trusted cookie (nothing is submitted to Facebook)`);
  const { context, page, browser } = await openRowBrowser(args);
  let newCookie;
  try {
    // dryRun stops at the enabled button, which is past Save login and on the
    // password page - the point the new session cookie exists.
    const r = await changePassword({ context, currentPw, newPw: throwawayPassword(), targetUrl: url, dryRun: true });
    if (!r.ok) log.warn("the walk did not confirm the form - reading the cookie anyway");
    // Full URLs, not bare domains: the filter rejects anything that is not a
    // parseable URL ("Invalid URL").
    const jar = await context.cookies(["https://www.facebook.com/", "https://accountscenter.facebook.com/", "https://m.facebook.com/"]);
    newCookie = jar.map((c) => `${c.name}=${c.value}`).join("; ");
    if (!newCookie) throw new Bail("no .facebook.com cookies came back - nothing to compare");
  } finally {
    await closeAll(browser, context);
  }

  const before = cookieNames(oldCookie), after = cookieNames(newCookie);
  const added = after.filter((n) => !before.includes(n));
  const dropped = before.filter((n) => !after.includes(n));
  log.info("── cookie comparison ──");
  log.info(`  old: ${before.length} names, ${oldCookie.length} chars, fp ${cookieDigest(oldCookie)}`);
  log.info(`  new: ${after.length} names, ${newCookie.length} chars, fp ${cookieDigest(newCookie)}`);
  log.info(`  added:   ${added.join(", ") || "(none)"}`);
  log.info(`  dropped: ${dropped.join(", ") || "(none)"}`);
  // The markers that make a session "logged in" rather than "recognised".
  const trust = ["c_user", "xs", "session_id", "sd", "spin"];
  const gained = trust.filter((n) => after.includes(n) && !before.includes(n));
  log.info(`  trust markers gained: ${gained.join(", ") || "(none)"}`);

  // The actual question: does the NEW cookie still need the recovery flow?
  // Walk it the way a real run would and record which recovery hops it had to
  // take. Landing on the account chooser is NOT a failure - that is the normal
  // screen a healthy cookie gets, and the run handles it with no login.
  log.info("Reopening a clean browser with the NEW cookie only…");
  const probe = await openRowBrowser(args, newCookie);
  try {
    const S = screens(probe.page);
    const hops = [];
    let form = false;
    for (let step = 1; step <= 10 && !form; step++) {
      if (await codePromptVisible(probe.page)) { hops.push("SMS gate"); break; }
      const here = await waitForScreen(probe.page,
        [S.passwordForm, S.checkpoint, S.loggedOut, S.reauth, S.saveLogin, S.continueGate, S.accountChooser, S.hubChangePassword, S.accountHub],
        "the password form", 15_000);
      if (!here) break;
      if (here === S.passwordForm) { form = true; break; }
      if (here === S.loggedOut) { hops.push("logged out (dead cookie)"); break; }
      if (here === S.checkpoint) { hops.push("checkpoint"); break; }
      if (here === S.continueGate) {
        hops.push("Continue");
        await clickScreenAway(mButton(probe.page, /^Continue$/), S.continueGate, "Continue");
        continue;
      }
      if (here === S.reauth) { hops.push("re-auth password"); await resumeSession(probe.page, currentPw); continue; }
      if (here === S.saveLogin) {
        hops.push("Save login");
        await clickScreenAway(mButton(probe.page, /^Save$/), S.saveLogin, "Save");
        continue;
      }
      if (here === S.accountChooser) { await pickAccount(probe.page); continue; }
      await here.loc.first().click();
    }
    log.info(`recovery hops needed with the new cookie: ${hops.length ? hops.join(" -> ") : "(none)"}`);
    if (form && !hops.length) {
      log.success("TRUSTED: straight to the password form, no Continue and no re-auth");
      if (args.includes("--write-back")) {
        const bak = writeCookieToSheet(file, row, newCookie);
        log.success(`Wrote the refreshed cookie to ${path.basename(file)} row ${row} (backup: ${path.basename(bak)})`);
      } else {
        log.info("the sheet is unchanged - add --write-back to replace the cookie in place");
      }
      return 0;
    }
    if (form) {
      log.warn(`PARTIAL: it reaches the form but still needs ${hops.join(" -> ")}`);
      log.info("the sheet is unchanged - add --write-back to replace the cookie in place");
      return 1;
    }
    log.error(`NOT TRUSTED: the new cookie never reached the form (${hops.join(" -> ") || "nothing recognised"})`);
    log.info(`the sheet is unchanged; old fp ${cookieDigest(oldCookie)} still in use`);
    return 1;
  } finally {
    await closeAll(probe.browser, probe.context);
  }
}

// ---- Drain: user submissions -> taskly ----
// bot.js only writes rows. This is the other half: it waits for the job to be
// listed, then sends queued accounts and binds each verdict back to the user who
// sent it. Separate process on purpose - a taskly outage must not stop users
// submitting, and a bot restart must not lose a half-finished submission.
//
// The pairing is the whole point. A taskly verdict carries no identifier, so it
// is bound to the oldest INFLIGHT row for the session it arrived on, and to
// nothing else. bindVerdict returns null when that session has nothing waiting,
// which is the honest answer - the alternative is filing a verdict against
// somebody else's account, which is the bug that made 2fa43 read as 38
// approved when the balance proved 37.
async function runDrain(args) {
  const { migrate, totals, claimNextQueued, markSent, bindVerdict, releaseToQueued, markStatus, closeDb, STATUS } = await import("./db.js");
  await migrate();
  const limit = Number(argValue(args, ["--limit"]) ?? 0) || 0;   // 0 = until the queue is empty
  const phone = argValue(args, ["--phone", "-p"]) ?? process.env.TG_PHONE;
  const currentPw = argValue(args, ["--current-password", "-o"]) ?? SHARED_PASSWORD;
  const url = resolveUrl();
  const listOnly = args.includes("--list-queued");

  const before = await totals();
  log.info(`queue: ${before.queued} queued, ${before.inflight} in review, ${before.all} total`);
  if (listOnly) { log.info("--list-queued: nothing was sent"); return 0; }

  // Nothing is spent until the job is actually listed. Same rule as a real run.
  // The session opened here is also the one that will receive the verdicts, so
  // it is opened with the DB sink and kept for --watch.
  const watch = args.includes("--watch");
  let tg = null;
  if (!args.includes("--skip-task-check") || watch) {
    tg = await Taskly.open({ phone, verdictSink: "db" });
    try {
      const a = await taskAvailability(tg);
      if (a.on === false) {
        log.error(`"${JOB}" is not listed under ${GROUP}. ${before.queued} submission(s) stay queued.`);
        log.info("Re-check any time with: bun index.js --check-task");
        if (!watch) { await tg.close(); await closeDb(); return 1; }
        log.warn("--watch: staying up anyway. Verdicts from earlier sends will still be recorded.");
      } else if (a.on === null) log.warn(`Could not confirm the job is listed (${a.why}) - carrying on anyway`);
      else log.success(`Job is listed: ${a.listed.join(" | ")}`);
    } catch (e) {
      await tg.close().catch(() => {}); tg = null;
      if (!watch) throw e;
      log.warn(`Could not reach taskly: ${e.message}`);
    }
  }

  let sent = 0, released = 0, stopped = null;
  for (let i = 1; !limit || i <= limit; i++) {
    const job = await claimNextQueued();       // one statement, so two drains cannot collide
    if (!job) break;
    const tag = `row ${job.id} (fp ${job.fp}, uid ${maskUid(uidOf(job.cookie))})`;
    try {
      log.info(`── draining ${tag}`);
      const changed = await changeFacebook(currentPw, "", url, job.cookie, true);
      if (!changed.ok) throw new Bail(`facebook did not accept the form: ${changed.verdict}`);
      // It is with taskly now, so it counts as sent whatever happens next.
      await markSent(job.id, String(phone ?? ""), null);
      sent++;
      log.success(`Sent to taskly. Awaiting a verdict.`);
    } catch (e) {
      // Only release it if taskly never saw it. Once the credentials were
      // requested the account is gone, and a verdict may still be coming.
      const gone = /creds|Start|password after|no password|Task cancelled|rate limit/i.test(String(e?.message ?? ""));
      if (gone) {
        await markStatus(job.id, STATUS.DEAD, String(e.message).slice(0, 200));
        log.error(`Dead - recorded, never retried: ${e.message}`);
      } else {
        await releaseToQueued(job.id, String(e.message).slice(0, 200));
        released++;
        log.warn(`Back in the queue - taskly never saw it: ${e.message}`);
      }
      stopped = String(e.message);
    }
  }
  const after = await totals();
  log.info(`drained ${sent}, re-queued ${released}`);
  log.info(`queue now: ${after.queued} queued, ${after.inflight} in review, ${after.approved} approved, ${after.rejected} rejected`);
  if (stopped) log.info(`last problem: ${stopped}`);

  if (watch && tg) {
    // Verdicts land about 64 minutes after the send, so this process has to
    // outlive the sending. Ctrl+C ends it.
    log.info("--watch: listening for verdicts. They arrive about 64 minutes after each send.");
    log.info("Ctrl+C in this terminal to stop.");
    await new Promise(() => {});
  }
  await tg?.close().catch(() => {});
  await closeDb();
  return sent ? 0 : 1;
}

// ---- Pricing: what a user is owed per approved account, derived ----
//
// Moved here from pricing.js. That file was imported dynamically at three
// call sites, and every one of them only wanted two or three functions out of it, so
// the cost of the module boundary was three `await import(...)`s in the middle of
// money code and a second place for the 19% rule to be edited. It is one file now.
//
// The rule in one line: the provider pays us a price, we keep a fixed 19% and the
// user takes the rest, but never more than 5.00 BKT. So a price RISE is all ours, and
// a price DROP moves both sides down together and we cannot go negative.
//
//   user_payout = min(MAX_USER_BKT, (1 - OUR_CUT) * price_usd * bdt_rate)
//
// Why the round to 0.05: 0.81 * 6.15 = 4.98, so a flat 19% would pay 4.98 on the
// very day the headline number is meant to be 5.00. Rounding to the nearest 0.05
// makes 4.98 -> 5.00, so "5 tk" is what actually gets paid and the cap still
// binds above it. Measured at $0.050 and BDT 123: total 6.15, user 5.00, us 1.15.
export const OUR_CUT = 0.19;        // our share when the price falls
export const MAX_USER_BKT = 5.00;  // the user never gets more than this
export const ROUND_TO = 0.05;      // payment granularity

const round2 = (n) => Math.round(n * 100) / 100;

// Pure. No network, no database, so --selftest can pin every case.
export function payoutBkt(priceUsd, bdtRate) {
  const p = Number(priceUsd), r = Number(bdtRate);
  if (!Number.isFinite(p) || p <= 0) return { total: 0, user: 0, us: 0, cut: 0, why: "no price" };
  if (!Number.isFinite(r) || r <= 0) return { total: 0, user: 0, us: 0, cut: 0, why: "no rate" };
  const total = p * r;
  const rounded = Math.round((total * (1 - OUR_CUT)) / ROUND_TO) * ROUND_TO;
  const user = Math.min(MAX_USER_BKT, round2(rounded));
  return { total: round2(total), user, us: round2(total - user), cut: round2((total - user) / total) };
}

// ---- Live rate, cached ----
// Polled every 5 minutes. If a fetch fails we keep the last good value and NEVER
// fall back to 0: a zero rate makes every downstream check silently useless,
// which is exactly the trap the old bdt_rate guard fell into. A missing rate must
// fail loudly and stop a payout, not invent a number.
const RATE_FILE = path.join(__dirname, "data", "out", "rate.json");
const RATE_URLS = [
  "https://open.er-api.com/v6/latest/USD",
  "https://api.exchangerate-api.com/v4/latest/USD",
];
export const CACHE_MS = 5 * 60 * 1000;

export function cachedRate() {
  try {
    const c = JSON.parse(fs.readFileSync(RATE_FILE, "utf8"));
    const ageMs = Date.now() - new Date(c.at).getTime();
    return { ...c, ageMs, stale: ageMs > CACHE_MS };
  } catch { return null; }
}

export async function fetchRate(opts) {
  const force = !!(opts && opts.force);
  const cached = cachedRate();
  if (!force && cached && !cached.stale) return Object.assign({}, cached, { source: "cache" });
  for (const url of RATE_URLS) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) continue;
      const j = await res.json();
      const bdt = Number(j && j.rates && j.rates.BDT);
      if (!Number.isFinite(bdt) || bdt <= 0) continue;
      const rec = {
        rate: bdt,
        at: new Date().toISOString(),
        source: url,
        fetched: (j && (j.time_last_update_utc || j.date)) || null,
      };
      fs.mkdirSync(path.dirname(RATE_FILE), { recursive: true });
      fs.writeFileSync(RATE_FILE, JSON.stringify(rec, null, 1), "utf8");
      return Object.assign({}, rec, { ageMs: 0, stale: false, source: "live" });
    } catch { /* try the next source */ }
  }
  // Every source failed. Keep what we had and say so - never invent a number.
  if (cached) return Object.assign({}, cached, { stale: true, source: "stale-cache", error: "all rate sources failed" });
  return null;
}

// The price the provider is paying us right now for the job we sell. Read from
// the job list rather than hardcoded: it has already moved once ($0.0500 ->
// $0.0480) and the job is currently delisted entirely.
export function priceFromLabels(labels) {
  const job = String(process.env.TASK_NAME ?? "2FA:Create FB (No mail)").toLowerCase();
  for (const l of labels ?? []) {
    if (String(l).toLowerCase().includes(job)) {
      const m = String(l).match(/\$([\d.]+)/);
      if (m) return Number(m[1]);
    }
  }
  return null;
}
// The price the provider ACTUALLY paid us, read off the real verdicts rather
// than a constant. The verdicts are a JSONL file, not a table, and every
// approval has carried +$0.05 - a measured fact. The job list moves (it has
// already gone 0.0480 -> 0.0500) and the job is sometimes delisted entirely, so a
// hardcoded price is a standing invitation to quote a number that stopped being
// true days ago.
export function settledPriceUsd(file) {
  const f = file ?? path.join(__dirname, "data", "out", "verdicts.jsonl");
  try {
    const tally = new Map();
    for (const line of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
      if (!line) continue;
      let r; try { r = JSON.parse(line); } catch { continue; }
      if (r.verdict !== "approved" || r.amount == null) continue;
      tally.set(Number(r.amount), (tally.get(Number(r.amount)) ?? 0) + 1);
    }
    if (!tally.size) return null;
    return [...tally.entries()].sort((a, b) => b[1] - a[1])[0][0];
  } catch { return null; }
}
// ---- Money: balance and withdrawal ----
//
// SAFE BY CONSTRUCTION. A withdrawal is the only irreversible thing in this tool,
// so --withdraw PREVIEWS by default and only moves money when --confirm is
// passed. Nothing here is ever called by the drain or the bot: this is a command
// a person runs deliberately, not a step in a loop. That distinction is the
// whole point - automating this would mean a bug could empty the balance with
// nobody watching.
//
// The sequence is the bridge's (Backend/withdrawapi.go), because the provider
// only speaks in button presses:
//   Withdraw -> USDT -> <address> -> <amount>
// and the provider states its own fee and minimum on the method screen. Those
// are read live, never hardcoded - the fee has already moved once.
const money = {
  FEE: 0.025,
  MINIMUM: 0.20,
  fmt: (v) => Number(v).toFixed(4),
};

async function readProviderBalance(tg) {
  await tg.ensureMainMenu();
  const before = tg.latestId();
  const fresh = await tg.freshSince(before, 10);
  const replies = fresh.length ? fresh : await tg.press("read balance", "Balance");
  for (const r of replies) {
    const m = String(r).match(/\$([0-9]+(?:\.[0-9]+)?)/);
    if (m) return Number(m[1]);
  }
  return null; // unknown, never 0 - a zero balance would look like a real reading
}

// The provider's own terms, read from the method screen. A miss is an error, not
// a default: a guessed fee is a guessed fee charged against real money.
function parseTerms(text) {
  const fee = text.match(/Fee:\s*\$([0-9]+(?:\.[0-9]+)?)/i);
  const min = text.match(/min(?:imum)?[^0-9]*([0-9]+(?:\.[0-9]+)?)/i);
  if (!fee && !min) return null;
  return { fee: fee ? Number(fee[1]) : null, minimum: min ? Number(min[1]) : null };
}

async function runMoney(args) {
  const db = await import("./db.js");
  await db.migrate();
  const phone = argValue(args, ["--phone", "-p"]) ?? process.env.TG_PHONE;
  const tg = await Taskly.open({ phone });
  try {
    // --balance is read-only and spends nothing.
    if (args.includes("--balance")) {
      const bal = await readProviderBalance(tg);
      if (bal == null) { log.error("the provider did not state a balance - treating it as UNKNOWN, not zero"); await db.closeDb(); return 1; }
      const rate = await fetchRate();
      const paidBkt = await db.paidTotalBkt();
      log.info(`provider balance : $${bal.toFixed(4)}` + (rate ? `   (${(bal * rate.rate).toFixed(2)} BKT at ${rate.rate})` : "   (no rate available)"));
      log.info(`minimum withdraw : $${money.MINIMUM} (fee $${money.FEE})`);
      const netIfAll = bal - money.FEE;
      if (netIfAll >= money.MINIMUM) log.info(`withdrawable now: $${bal.toFixed(4)} gross -> $${netIfAll.toFixed(4)} after the fee`);
      else log.warn(`below the $${money.MINIMUM} minimum - nothing can be withdrawn yet`);
      log.info(`already paid out : ${paidBkt.toFixed(2)} BKT recorded in the ledger`);
      log.info("");
      log.info("Owed to users comes from: bun index.js --report");
      await db.closeDb();
      return 0;
    }

    if (args.includes("--withdraw")) {
      // the amount is the value straight after --withdraw; --amount also accepted
      const amount = Number(argValue(args, ["--withdraw", "--amount"]));
      const wallet = argValue(args, ["--wallet"]);
      const go = args.includes("--confirm");
      if (!Number.isFinite(amount) || amount <= 0) { log.error("usage: --withdraw <amount> --wallet <address> [--confirm]"); await db.closeDb(); return 1; }
      if (!wallet) { log.error("--wallet is required. The provider pays out to an address, so there is no default."); await db.closeDb(); return 1; }

      const bal = await readProviderBalance(tg);
      if (bal == null) { log.error("could not read the balance - refusing to guess"); await db.closeDb(); return 1; }
      if (!go) {
        log.info(`--withdraw without --confirm: PREVIEW ONLY, nothing will be sent.`);
        log.info(`  balance      $${bal.toFixed(4)}`);
        log.info(`  amount       $${amount.toFixed(4)}`);
        log.info(`  to           ${wallet}`);
        if (amount > bal) log.error(`  REFUSED: the amount is more than the balance.`);
        else if (amount < money.MINIMUM) log.error(`  REFUSED: below the $${money.MINIMUM} minimum.`);
        else log.info(`  looks payable. Add --confirm to actually send it.`);
        await db.closeDb();
        return 0;
      }
      // Past this point money moves. Everything above was a dry run.
      if (amount > bal) { log.error(`REFUSED: $${amount} is more than the $${bal.toFixed(4)} balance`); await db.closeDb(); return 1; }
      if (amount < money.MINIMUM) { log.error(`REFUSED: $${amount} is below the $${money.MINIMUM} minimum`); await db.closeDb(); return 1; }
      log.warn(`Sending $${amount.toFixed(4)} to ${wallet}. This cannot be undone.`);
      await tg.ensureMainMenu();
      await tg.press("withdraw", "Withdraw");
      const methodReplies = await tg.press("method", "USDT");
      const terms = parseTerms((methodReplies ?? []).join("\n"));
      if (!terms || terms.fee == null) { log.error("the provider did not state its fee - stopping before anything is sent"); await db.closeDb(); return 1; }
      log.info(`provider terms: fee $${terms.fee}` + (terms.minimum != null ? `, minimum $${terms.minimum}` : ""));
      log.info(`net after the fee: $${(amount - terms.fee).toFixed(4)}`);
      if (amount - terms.fee <= 0) { log.error("the fee eats the whole amount - stopping"); await db.closeDb(); return 1; }
      await tg.press("address", wallet);
      const done = await tg.press("amount", money.fmt(amount));
      const said = (done ?? []).join(" ");
      // The provider says "created". It never says "received". Do not upgrade it.
      if (!/created|Withdrawal/i.test(said)) { log.error("the provider did not confirm the withdrawal - do not assume it went through"); await db.closeDb(); return 1; }
      log.success("The provider accepted the request.");
      log.warn("\"created\" is not \"paid\" - the provider confirms a request, never that money arrived. Check your wallet.");
      audit({ leg: "internal", what: "withdraw", amount, fee: terms.fee, net: amount - terms.fee });
      await db.closeDb();
      return 0;
    }

    log.error("pass --balance or --withdraw <amount> --wallet <address> [--confirm]");
    await db.closeDb();
    return 1;
  } finally { await tg.close().catch(() => {}); }
}
// ---- Admin: report and pay ----
// Payments are made by hand, so the system's job is to RECORD them and to tell
// the user afterwards. Nothing here decides an amount - the admin does. What the
// system provides is the number that should drive the decision: approved minus
// already paid, derived from the ledger rather than stored as a balance.
async function runAdmin(args) {
  const db = await import("./db.js");
  await db.migrate();
  const t = await db.totals();
  const pad = (s, n) => String(s).padEnd(n);
  const rgt = (s, n) => String(s).padStart(n);

  if (args.includes("--report")) {
    const days = Number(argValue(args, ["--days"]) ?? 7) || 7;
    log.info("── queue ──");
    log.info(`  ${t.queued} queued, ${t.inflight} in review, ${t.approved} approved, ${t.rejected} rejected, ${t.dead} dead`);
    const byDay = await db.dailyStats(days);
    log.info("");
    log.info(`── daily submissions (last ${days}d) ──`);
    if (!byDay.length) log.info("  (none)");
    for (const d of byDay) {
      log.info(`  ${String(d.day).slice(0, 10)}  submitted ${rgt(d.submitted, 3)}   approved ${rgt(d.approved, 3)}   rejected ${rgt(d.rejected, 3)}   pending ${rgt(d.pending, 3)}`);
    }
    const pays = await db.dailyPayments(days);
    if (pays.length) {
      log.info("");
      log.info(`── daily payments (last ${days}d) ──`);
      for (const p of pays) log.info(`  ${String(p.day).slice(0, 10)}  ${rgt(p.n, 2)} payment(s)   total ${p.total}`);
    }
    const unpaid = await db.unpaidUsers();
    if (unpaid.length) {
      log.info("");
      log.info("── approved but never paid ──");
      for (const u of unpaid) log.info(`  ${pad(u.handle, 14)} tg=${u.tg_id}  ${rgt(u.approved, 3)} approved`);
    }
    await db.closeDb();
    return 0;
  }

  if (args.includes("--price")) {
    // What one approval is worth, right now: the live rate, the provider's
    // current price for OUR job, and the split between us and the user.
    const rate = await fetchRate();
    if (!rate) { log.error("no USD/BDT rate available - refusing to quote. A missing rate must never become 0."); await db.closeDb(); return 1; }
    const tg2 = await Taskly.open({ phone: argValue(args, ["--phone", "-p"]) ?? process.env.TG_PHONE });
    let price = null, labels = [];
    try { const a = await taskAvailability(tg2); labels = a.all ?? []; price = priceFromLabels(labels); }
    finally { await tg2.close(); }
    const settled = settledPriceUsd();
    const use = price ?? settled;
    log.info(`rate ${rate.rate} BKT/USD (${rate.source}, ${new Date(rate.at).toISOString()})`);
    log.info(`provider lists ${JOB}: ` + (price ? `$${price}` : "NOT LISTED"));
    log.info(`last settled price from real verdicts: ` + (settled ? `$${settled}` : "none recorded"));
    if (use == null) { log.error("no price available from either source - cannot quote a payout"); await db.closeDb(); return 1; }
    const p = payoutBkt(use, rate.rate);
    log.info(`one approval = ${p.total} BKT  ->  user ${p.user}, us ${p.us}  (our cut ${(p.cut * 100).toFixed(1)}%)`);
    await db.closeDb();
    return 0;
  }

  if (args.includes("--pay")) {
    const tg = Number(argValue(args, ["--pay"]) ?? argValue(args, ["--pay-to"]));
    const amount = argValue(args, ["--amount"]);
    const method = argValue(args, ["--method"]) ?? null;
    const reference = argValue(args, ["--ref"]) ?? null;
    const note = argValue(args, ["--note"]) ?? null;
    if (!Number.isFinite(tg) || !amount) throw new Bail("usage: --pay <tgId> --amount <n> [--method m] [--ref r] [--note text]");
    const u = await db.findUser(tg);
    if (!u) { log.error(`no user with telegram id ${tg}`); await db.closeDb(); return 1; }
    const rec = await db.recordPayment({ userId: u.id, amount, method, reference, note, adminTgId: Number(process.env.ADMIN_TG_ID) || null });
    log.success(`Recorded payment #${rec.id}: ${u.handle ?? "user"} (tg ${u.tg_id}) ${rec.amount}${method ? " via " + method : ""}`);
    log.info("  The user has not been told yet - the bot sends it on its next poll.");
    log.info("  Recorded, never edited. A mistake is corrected by recording the difference as another row.");
    await db.closeDb();
    return 0;
  }

  if (args.includes("--clear")) {
    const n = await db.clearExpiredExpect(Number(argValue(args, ["--older-than"]) ?? 30) || 30);
    log.success(`Cleared ${n} expired /submit wait(s).`);
    log.info("This is the only thing in the system that deletes anything.");
    await db.closeDb();
    return 0;
  }

  if (args.includes("--requeue")) {
    const n = await db.requeueStale(Number(argValue(args, ["--older-than"]) ?? 120) || 120);
    log.success(`Requeued ${n} row(s) claimed but never confirmed sent.`);
    log.warn("Only safe after a crash. A row taskly actually received must stay inflight - a verdict may still be coming for it.");
    await db.closeDb();
    return 0;
  }

  log.error("nothing to do - pass --report, --pay, --clear or --requeue");
  await db.closeDb();
  return 1;
}

// ---- Batch / group ----
let curFp = "", curXlsx, curRow = 0;
function resolveRow(file, row) {
  const accounts = readAccounts(file);
  const pick = accounts.find((a) => a.row === row);
  if (!pick) throw new Bail(`row ${row} not found. Usable rows: ${accounts.map((a) => a.row).join(", ")}`);
  return { cookie: pick.cookie, fa2Key: pick.fa2Key, row: pick.row, total: accounts.length };
}
async function runBatch(files, args) {
  const pass = args.filter((a) => !a.startsWith("--xlsx") && a !== "--all" && !files.includes(a));
  // THE LEDGER MUST BE LOADED HERE, IN THE PARENT, before the filter below.
  //
  // It used to be loaded only in runGroup - the CHILD. So this parent filtered
  // against an empty set, queued every row in the sheets, and each child then had
  // to discover for itself that its rows were already sold. On the 2026-09-30 run
  // that put 12 of 47 groups on rows that were sent weeks earlier, and the log
  // read as though accounts were being worked that had long since been paid for.
  //
  // One call here and the plan shrinks to the rows that can actually be run: the
  // same 47 groups became 35, with no Telegram round-trip spent on the rest.
  if (!ledgerDb.ready) {
    const l = await ledgerLoad();
    log.info(`Ledger: ${l.sent} already sent, ${l.skipped} already skipped`);
  }
  const queue = [];
  let readErrors = 0;
  for (const file of files) {
    let accounts;
    try { accounts = readAccounts(file); }
    catch (e) { log.error(e.message); readErrors++; continue; }
    for (const a of accounts) {
      const fp = fingerprint(a.cookie);
      if (isSent(fp) || isSkipped(fp)) continue;
      // The cookie rides along so the UID filter below does not re-read the
      // whole sheet once per row.
      queue.push({ file, row: a.row, cookie: a.cookie, fp });
    }
  }
  if (!queue.length) {
    if (files.length && readErrors === files.length) { log.error("no sheets could be read"); return 1; }
    log.success("nothing left to do - every row is sent or skipped"); return 0;
  }
  // Drop dead ACCOUNTS here, before any Telegram session opens. A blocked
  // account cannot be worked, so a bot password spent discovering that is a
  // waste - and the UID check costs one request for the whole batch.
  if (!args.includes("--no-uid-check")) {
    const live = await checkUids(queue.map((j) => uidOf(j.cookie)));
    if (live.size) {
      // Collected first, then recorded. A .filter() callback cannot await, and
      // the temptation to leave the write un-awaited is exactly the fire-and-
      // forget that lets a process exit with the record still in flight.
      const deadOnes = [];
      const alive = queue.filter((j) => {
        const hit = live.get(uidOf(j.cookie));
        if (!hit || hit.status === "valid") return true; // unknown -> keep it, never discard on a guess
        deadOnes.push(j);
        return false;
      });
      for (const j of deadOnes) {
        const hit = live.get(uidOf(j.cookie));
        await markSkipped({ fp: j.fp, reason: `account dead (uid check: ${hit.message ?? "not valid"})`, source: j.file, row: j.row });
        log.error(`${path.basename(j.file)}:${j.row} - account ${maskUid(uidOf(j.cookie))} is dead (${hit.message ?? "not valid"}), never retried`);
      }
      log.info(`UID check: ${queue.length - alive.length} of ${queue.length} account(s) are dead and were dropped`);
      queue.length = 0;
      queue.push(...alive);
      if (!queue.length) { log.success("every queued account is dead - nothing to do"); return 0; }
    } else {
      log.warn("UID check gave no usable answer - carrying on without it");
    }
  }
  const perSession = Math.max(1, Number(argValue(args, ["--per-session"]) ?? PER_SESSION) || PER_SESSION);
  const groups = [];
  for (let i = 0; i < queue.length; i += perSession) groups.push(queue.slice(i, i + perSession));
  log.info(`${queue.length} account(s) queued across ${files.length} sheet(s), ${groups.length} session(s)`);
  if (args.includes("--plan")) {
    groups.forEach((g, i) => log.info(`  session ${i + 1}: ${g.map((j) => `${path.basename(j.file)}:${j.row}`).join(", ")}`));
    log.success("--plan: nothing was run, nothing was spent");
    return 0;
  }
  let ok = 0;
  const failed = [];
  const self = fileURLToPath(import.meta.url);
  for (const [gi, group] of groups.entries()) {
    log.info(`── session ${gi + 1}/${groups.length}: ${group.map((j) => `${path.basename(j.file)}:${j.row}`).join(", ")}`);
    const r = spawnSync(process.execPath, [self, ...pass, "--rows", group.map((j) => `${j.file}#${j.row}`).join(",")], { stdio: "inherit" });
    // THE CIRCUIT BREAKER. A child that exits 75 was told by the provider to
    // stop, not that its three accounts were bad. The old loop recorded that as
    // three more failures and immediately spawned the next group into the same
    // rate limit - so one bad minute became 22 dead groups and 66 accounts that
    // were never attempted. A rate limit is a property of the WHOLE run, so it
    // ends the whole run.
    if (r.status === EXIT_RATE_LIMITED) {
      const left = groups.slice(gi).reduce((n, g) => n + g.length, 0);
      log.error("");
      log.error(`STOPPED: the provider rate-limited us. ${left} account(s) were not attempted.`);
      log.error("This is not a failure of those accounts - re-run the SAME command after the wait");
      log.error("and it resumes exactly where it stopped (completed rows are skipped automatically).");
      log.error("");
      return EXIT_RATE_LIMITED;
    }
    if (r.status === 0) ok += group.length;
    else failed.push(...group.map((j) => `${path.basename(j.file)}:${j.row}`));
  }
  log.info(`done: ${ok} passed, ${failed.length} failed`);
  if (failed.length) { log.error(`failed rows: ${failed.join(", ")}`); log.info("re-run the same command - completed rows are skipped automatically"); }
  return failed.length ? 1 : 0;
}

async function walkForPassword(tg, fp) {
  for (let attempt = 1; attempt <= MAX_START_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      log.warn(`No password within ${CRED_WAIT_MS}ms of Start - restarting (attempt ${attempt}/${MAX_START_ATTEMPTS})`);
      audit({ leg: "internal", what: "creds", status: "restart", attempt, fp });
      await tg.sendRaw("restart", "/start");
      await sleep(STEP_MS);
    }
    // Any of these can be rate limited. Wait as instructed rather than walking
    // away from an account that was still available.
    await tg.obeyRateLimit(await tg.ensureMainMenu());
    await sleep(STEP_MS);
    await tg.obeyRateLimit(await tg.press("open Tasks", "Tasks"));
    await sleep(STEP_MS);
    if (GROUP) await tg.obeyRateLimit(await tg.press(`open ${GROUP}`, GROUP));
    await sleep(STEP_MS);
    await tg.obeyRateLimit(await tg.press(`open job ${JOB}`, JOB));
    await sleep(STEP_MS);
    const beforeStart = await tg.latestId();
    const startReplies0 = await tg.press("click Start", "Start");
    // The rate limit is most often delivered in place of the credentials.
    if ((await tg.obeyRateLimit(startReplies0)).waited) {
      audit({ leg: "internal", what: "creds", status: "rate-limited-at-start", attempt, fp });
      continue;
    }
    // The provider's own timer. Length is unknown and assumed nowhere - all we
    // can honestly say is that this account is already gone.
    if (tg.isTaskCancelled(startReplies0)) {
      log.error("The provider's timer ran out on this task - the account is lost.");
      audit({ leg: "internal", what: "creds", status: "provider-timer-expired", attempt, fp });
      return null;
    }
    const deadline = Date.now() + CRED_WAIT_MS;
    let startReplies = startReplies0;
    let creds = { firstName: null, lastName: null, password: null };
    let limited = false;
    for (;;) {
      startReplies = await tg.freshSince(beforeStart, 6);
      tg.noteActionCancelled(startReplies);
      // Detect only, do NOT wait here: the wait is done once after the loop.
      // Waiting inside it would sleep on every poll tick.
      if (rateLimitSeconds(startReplies)) { limited = true; break; }
      if (tg.isTaskCancelled(startReplies)) { log.error("The provider's timer ran out on this task - the account is lost."); audit({ leg: "internal", what: "creds", status: "provider-timer-expired", attempt, fp }); return null; }
      creds = parseCreds(startReplies);
      if (creds.password) break;
      if (Date.now() >= deadline) break;
      await sleep(250);
    }
    if (limited) {
      await tg.obeyRateLimit(startReplies);
      audit({ leg: "internal", what: "creds", status: "rate-limited-at-start", attempt, fp });
      continue;
    }
    if (!creds.password) {
      log.error(`No credentials within ${CRED_WAIT_MS}ms of Start`);
      audit({ leg: "internal", what: "creds", status: "missing-at-start", attempt, fp });
      continue;
    }
    if (await isPasswordUsed(creds.password)) {
      log.warn("Bot re-issued an already-used password - walking again");
      audit({ leg: "internal", what: "creds", status: "already-used", attempt, fp });
      continue;
    }
    log.success(`Bot gave: ${creds.firstName ?? "?"} ${creds.lastName ?? "?"} / password ${creds.password.length} chars`);
    audit({ leg: "internal", what: "creds", status: "at-start", first: creds.firstName, last: creds.lastName, fp });
    return { creds, startReplies };
  }
  return null;
}

// ---- Counting from the conversation itself ----
//
// WHY THIS EXISTS. Every count we have ever trusted came out of the ledger, and
// the ledger pairs a verdict to a row by position. That pairing is where the
// 38-vs-37 disaster came from, and it stays wrong in a new way every time the
// tool is restarted or a verdict arrives while nothing is listening.
//
// Counting the provider's OWN words needs no pairing at all:
//
//   approved  = how many "Report approved" messages exist
//   rejected  = how many "Report rejected" messages exist
//   submitted = how many "your report has been received" messages exist
//
// There is no FIFO, no claimed_by, no pending queue and nothing to reconcile. It
// cannot drift, because it is recomputed from the source every time.
//
// AGENTS.md says "getHistory returns 0 messages, always". THAT IS NO LONGER
// TRUE - measured 2026-09-30: 1000 messages per session came back, 40 verdicts
// in a single page. So this is not a fallback, it is the better source, and it
// also catches verdicts that arrived while the tool was shut.
//
// The ledger is still the only thing that knows WHICH cookie an approval belongs
// to. This counts; it does not identify. That split is the point.
//
//   bun index.js --count-from-chat                 # every session on this machine
//   bun index.js --count-from-chat -p <phone>      # just one
//   bun index.js --count-from-chat --pages 20      # walk deeper (100 msgs/page)
const CHAT_PAGE = 100;
async function mineChat(tg, maxPages = 50) {
  const tally = { submitted: 0, approved: 0, rejected: 0, usd: 0, blocked: 0, oldestId: null, newestId: null, messages: 0 };
  // offsetId, NOT minId. Measured on this provider:
  //   offsetId=<oldest seen>  ->  returns the next 100 OLDER messages. Correct.
  //   minId=<oldest seen>     ->  returns the SAME newest messages again, so the
  //                              walk never advanced and the count came back as
  //                              one page no matter how many pages were asked for.
  let offsetId = 0;
  for (let page = 0; page < maxPages; page++) {
    const res = await tg.client.getMessages(tg.peer, offsetId ? { limit: CHAT_PAGE, offsetId } : { limit: CHAT_PAGE });
    const all = Array.isArray(res) ? res : [...res];
    if (!all.length) break;
    // Inbound only - our own presses are not evidence of anything.
    const rows = all.filter((m) => !m.out);
    for (const m of rows) {
      const t = String(m.message ?? "").replace(/\s+/g, " ");
      tally.messages++;
      if (/report has been received/i.test(t)) tally.submitted++;
      if (/report approved/i.test(t)) {
        tally.approved++;
        const usd = t.match(/\$([\d.]+)/)?.[1];
        if (usd) tally.usd += Number(usd);
      }
      if (/report rejected/i.test(t)) {
        tally.rejected++;
        if (/account blocked|either blocked/i.test(t)) tally.blocked++;
      }
    }
    const ids = all.map((m) => Number(m.id));
    const oldest = Math.min(...ids), newest = Math.max(...ids);
    // Both ends are tracked across EVERY page, not just the first. Setting the
    // oldest only on page one printed a 100-id range for a 600-message walk, which
    // reads as "we only looked at the last 100" when we had read all 600.
    tally.oldestId = tally.oldestId == null ? oldest : Math.min(tally.oldestId, oldest);
    tally.newestId = tally.newestId == null ? newest : Math.max(tally.newestId, newest);
    // A short page means the start of the chat. Without this the walk asks for
    // another page and gets nothing, one wasted call per run.
    if (all.length < CHAT_PAGE) break;
    offsetId = oldest;
  }
  return tally;
}

async function runCountFromChat(args) {
  const phones = argValue(args, ["--phone", "-p"]) ? [normalizePhone(argValue(args, ["--phone", "-p"]))] : listSessions().map(normalizePhone);
  const maxPages = Number(argValue(args, ["--pages"]) ?? 50) || 50;
  const total = { submitted: 0, approved: 0, rejected: 0, usd: 0 };
  for (const phone of phones) {
    const tg = await Taskly.open({ phone, verdictSink: "none" });
    let t;
    try {
      t = await mineChat(tg, maxPages);
    } finally {
      await tg.close();
    }
    log.success(`session ...${phone.slice(-4)}: ${t.submitted} submitted, ${t.approved} approved, ${t.rejected} rejected (${t.blocked} "account blocked")`);
    log.info(`  ${t.messages} messages scanned, ids ${t.oldestId}-${t.newestId}, approved worth $${t.usd.toFixed(2)}`);
    // The one number that cannot be argued with: the provider paid out this much
    // for these approvals. If it disagrees with the balance, the balance is wrong.
    if (t.usd > 0) log.info(`  money the provider says it paid: $${t.usd.toFixed(4)}`);
    for (const k of ["submitted", "approved", "rejected"]) total[k] += t[k];
    total.usd += t.usd;
  }
  if (phones.length > 1) {
    log.success(`TOTAL across ${phones.length} sessions: ${total.submitted} submitted, ${total.approved} approved, ${total.rejected} rejected, $${total.usd.toFixed(4)} paid`);
    log.info("These are the provider's own numbers. The ledger is only trusted for WHICH account, never for how many.");
  }
  // The database is not touched by this command at all - that is the point of
  // it - so there is no pool to close here. closeDb lives in db.js and is only
  // reachable through the other commands' own dynamic import.
  return 0;
}

// One UID check per fingerprint per group, not one per row: the same cookie
// can appear twice in a sheet and the answer will not have changed.
const uidChecked = new Set();

// ---- The queue worker: one process, one session, as many rows as it can get ----
//
// Deliberately a THIN wrapper. It claims a row and hands it to the very same
// runGroup machinery that has always done the work, so there is exactly one
// implementation of "walk taskly, change the facebook password, send the key,
// send the cookie" - not a second copy that drifts from the first.
//
//   bun index.js --work -p <phone> [--limit N] [--idle-exit SECONDS]
async function runQueueWorker(args, phone) {
  const db = await import("./db.js");
  await db.migrate();
  const limit = Number(argValue(args, ["--limit"]) ?? 0) || 0;
  const idleExit = Number(argValue(args, ["--idle-exit"]) ?? 0) || 0;   // 0 = keep going
  let sent = 0, released = 0, idle = 0;

  for (;;) {
    const row = await db.claimSheetRow(phone);
    if (!row) {
      // Nothing claimable. Either the queue is empty or every remaining row is
      // held by another worker - which is a healthy state, not an error.
      const { rows: busy } = await db.db().query(
        "SELECT count(*)::int n FROM sheet_rows WHERE status IN ('claimed','inflight')",
      );
      idle += 2;
      if (limit && sent >= limit) break;
      if (busy[0].n === 0) { log.info("Queue empty - nothing left to claim."); break; }
      if (idleExit && idle * 2 >= idleExit) { log.info(`No free row for ${idleExit}s and ${busy[0].n} are in progress elsewhere - stopping.`); break; }
      await sleep(2000);
      continue;
    }
    idle = 0;
    // The queue row carries its own cookie, so the sheet is not re-read here -
    // but runGroup resolves rows from files, so it is given a synthetic group
    // and the already-claimed fingerprint is honoured by the ledger.
    log.info(`── claimed ${row.source}:${row.row_no} (fp ${row.fp})`);
    const rc = await runGroup([{ file: row.source, row: row.row_no }], args, phone, { claimedFp: row.fp });
    if (rc === EXIT_RATE_LIMITED) {
      // Give the claim back BEFORE stopping: this worker is leaving, and a claim
      // held by a dead process is an account nobody will ever sell.
      await db.releaseSheetRow(row.fp, "worker stopped: rate limited");
      return EXIT_RATE_LIMITED;
    }
    if (rc === 0) sent++; else released++;
    if (limit && sent >= limit) break;
  }
  const c = await db.sheetCounts();
  log.info(`worker on ...${String(phone).slice(-4)}: ${sent} sent, ${released} not sent`);
  log.info(`queue: ${c.queued} queued, ${c.claimed} claimed, ${c.inflight} in review, ${c.approved} approved`);
  return 0;
}
async function runGroup(group, args, phone, pre = {}) {
  if (!group.length) { log.error("nothing to run - no rows given"); return 1; }
  const force = args.includes("--force");
  // --work: take rows from the shared queue instead of a hand-listed group.
  //
  // The claim is one UPDATE ... FOR UPDATE SKIP LOCKED, so N workers on N
  // sessions each get a DIFFERENT row and none of them can ever pick up the same
  // account. That is the entire difference between this working with several
  // processes and the old hand-listed groups, which only ever worked because
  // there was exactly one process.
  if (args.includes("--work")) return await runQueueWorker(args, phone);
  const dryRun = args.includes("--probe") || args.includes("--dry-run");
  const resumePw = argValue(args, ["--password", "-P"]);
  const url = resolveUrl();
  const currentPw = argValue(args, ["--current-password", "-o"]) ?? SHARED_PASSWORD;
  const runnable = group.filter((j) => {
    let fp = "";
    try { fp = fingerprint(resolveRow(j.file, j.row).cookie); }
    catch { return true; }
    if (!force && isSent(fp)) { log.info(`── ${path.basename(j.file)}:${j.row} already sent - skipped`); return false; }
    if (!force && isSkipped(fp)) { log.info(`── ${path.basename(j.file)}:${j.row} SMS-gated - skipped`); return false; }
    return true;
  });
  if (!runnable.length) { log.success("every row in this group is already sent or gated - nothing to do"); return 0; }
  log.info(`Running ${runnable.length} account(s) on one Telegram session`);
  // The ledger, before anything can be sent. Also adopts the old JSON files.
  if (!ledgerDb.ready) {
    const l = await ledgerLoad();
    log.info(`Ledger: ${l.sent} already sent, ${l.skipped} already skipped (adopted from the json ledgers on first run)`);
  }
  // ONE TELEGRAM SESSION, ONE PROCESS. Telegram delivers updates to exactly one
  // consumer of a session: two processes on the same MTProto session do not share
  // the work, they fight over it, and the loser reads the winner's messages as
  // its own replies. A Postgres advisory lock says "stop" here, with no lock file
  // to go stale and no manual cleanup after a crash.
  const lock = args.includes("--no-session-lock") ? { session: phone, release: async () => {} } : await (await import("./db.js")).holdSessionLock(phone);
  if (!lock) {
    log.error(`Session ${phone} is already in use by another process.`);
    log.error("Two processes on one Telegram session fight over its messages and each loses replies.");
    log.error("Give this one its own session with -p <phone>, or wait for the other to finish.");
    return 1;
  }
  log.info(`Session ${phone} locked for this process only.`);
  const tg = await Taskly.open({ phone });
  // Guard: if the job is not listed there is nothing to sell, so stop before
  // walking - not three presses into a walk that cannot finish. Reuses the
  // session we already opened, so it costs one /start and two button presses.
  //
  // "Could not tell" is deliberately NOT a stop. A flaky network is not
  // evidence that the provider delisted anything, and stopping on a guess
  // would refuse to run on a day the job is perfectly available.
  //
  // A RATE LIMIT is not "could not tell" and gets the opposite treatment: it is
  // a definite stop, with its own exit code, so the parent batch can halt
  // instead of spawning every remaining group into the same wall. Carrying on
  // "anyway" here meant sending into a provider that had just asked for 705
  // seconds, 22 times over.
  if (!args.includes("--skip-task-check")) {
    const avail = await taskAvailability(tg);
    if (avail.rateLimited) {
      log.error(`Rate limited: asked for ${avail.waitSec}s before the next message (${avail.why}).`);
      log.error(`Nothing was spent and no row was started. Wait ${avail.waitSec}s, then re-run the same command.`);
      log.error("This is NOT 'could not tell' - the answer was 'stop'.");
      await tg.close();
      await lock.release();
      return EXIT_RATE_LIMITED;
    }
    if (avail.on === false) {
      log.error(`The job "${JOB}" is not listed under ${GROUP} right now, so there is nothing to sell.`);
      log.error("Nothing was spent. Re-check any time with: bun index.js --check-task");
      const others = (avail.all ?? []).filter((l) => /\$[\d.]+/.test(l) && !l.toLowerCase().includes(GROUP.toLowerCase()));
      if (others.length) log.info(`listed instead: ${others.join(" | ")}`);
      await tg.close();
      await lock.release();
      return 1;
    }
    if (avail.on === null) log.warn(`Could not confirm the job is listed (${avail.why}) - carrying on anyway`);
    else log.success(`Job is listed: ${avail.listed.join(" | ")}`);
    // The check leaves us sitting on the job list; the walk expects the menu.
    // This send can itself hit Telegram's flood (the availability check just
    // did several). Uncaught it bubbles to the top handler as exit 1 and the
    // parent spawns every remaining group into the same wall - the 2026-09-30
    // run did exactly that 21 times. A flood here is the run's stop, code 75.
    try {
      await tg.ensureMainMenu();
    } catch (e) {
      const flood = floodWaitSeconds(e);
      if (flood) {
        log.error(`Telegram flood limit: ${flood}s. Nothing was spent and no row was started. Re-run the same command after the wait.`);
        await tg.close();
        await lock.release();
        return EXIT_RATE_LIMITED;
      }
      throw e;
    }
  }
  let ok = 0;
  const failed = [];
  // One bot password covers up to MAX_REUSE cookies; a success retires it.
  let pending = null; // {password, firstName, lastName, uses}
  try {
    for (const [i, job] of runnable.entries()) {
      const tag = `${path.basename(job.file)}:${job.row}`;
      log.info(`── [${i + 1}/${runnable.length}] ${tag}`);
      // Per-row, and reset every row: once the password has been changed this
      // account cannot be re-attempted, which is what the orphan rule keys on.
      let passwordChanged = false;
      let limited = false;
      try {
        tg.resetWindow();
        const pick = resolveRow(job.file, job.row);
        const fp = fingerprint(pick.cookie);
        curFp = fp; curXlsx = job.file; curRow = pick.row;
        log.success(`${path.basename(job.file)}: row ${pick.row} (fp ${fp})`);
        // A queue row was CLAIMED for this worker, so its own fingerprint must
        // not be treated as "already done" by the ledger check below - that
        // check exists to stop a hand-listed row being submitted twice, and the
        // claim is the stronger guarantee. Guarding on pre.claimedFp keeps the
        // skip for hand-listed runs and steps aside for claimed ones.
        const mine = pre.claimedFp === fp;
        if (!mine && isSent(fp) && !force) throw new Bail(`row ${pick.row} already sent. Use --force.`);
        if (!mine && isSkipped(fp) && !force) throw new Bail(`row ${pick.row} SMS-gated. Use --force.`);
        // Account liveness first, then the cookie. A dead account is skipped
        // outright; only a live one is worth spending a cookie probe on.
        if (!dryRun && !force && !uidChecked.has(fp)) {
          uidChecked.add(fp);
          const acc = await checkUid(pick.cookie);
          audit({ leg: "internal", what: "uid", status: acc.status, fp });
          if (acc.status === "dead") {
            await markSkipped({ fp, reason: `account dead (uid check: ${acc.message ?? "not valid"})`, source: job.file, row: pick.row });
            log.error(`Row ${pick.row}: account ${maskUid(acc.uid)} is dead - recorded in the ledger, never retried.`);
            throw new BailLogged(`row ${pick.row} account is dead.`);
          }
          log.info(`Row ${pick.row}: account ${maskUid(acc.uid)} is ${acc.status} - checking the cookie`);
        }
        if (!dryRun && !resumePw && !force && (await isCookieDead(pick.cookie))) {
          await markSkipped({ fp, reason: "cookie confirmed dead at accountscenter", source: job.file, row: pick.row });
          audit({ leg: "internal", what: "cookie", status: "dead-confirmed", fp });
          throw new Bail(`row ${pick.row} cookie is dead (confirmed twice).`);
        }
        if (!currentPw && !dryRun) throw new Bail("Current Facebook password missing. Pass -o <password>.");
        const fa2Key = argValue(args, ["--fa2"]) ?? pick.fa2Key;
        if (!fa2Key && !dryRun) throw new Bail("2FA key missing. Pass --fa2 <key>.");

        if (resumePw) {
          log.info("RESUME: changing Facebook first, then sending key");
          const result = await changeFacebook(currentPw, resumePw, url, pick.cookie);
          if (!result.ok) throw new Bail(`Facebook did not confirm the change: ${result.verdict}`);
          passwordChanged = true;
          const keyReplies = await tg.sendRaw("send 2FA key", fa2Key);
          // Branch on .waited, never on the returned object. See the note in the
          // main path below - the object is always truthy and this silently ate
          // the cookie send on every single row.
          if ((await tg.obeyRateLimit(keyReplies)).waited) throw new Bail("rate limited after the 2FA key - the cookie was NOT sent");
          if (tg.isTaskCancelled(keyReplies)) throw new Bail("the provider's timer ran out after the 2FA key");
          if (!keyReplies.some((r) => /cookie/i.test(r))) throw new Bail("expected a cookie prompt after the 2FA key");
          const cookieReplies = await tg.sendRaw("send cookie", pick.cookie.trim());
          if ((await tg.obeyRateLimit(cookieReplies)).waited) throw new Bail("rate limited after the cookie - the registration was NOT confirmed");
          if (!cookieReplies.some((r) => /confirm registration/i.test(r))) throw new Bail("no confirmation prompt after the cookie");
          const final = await tg.press("confirm registration", "Account registered");
          if (final.some((r) => /report has been received/i.test(r))) {
            await markSent({ fp, source: job.file, row: pick.row, job: JOB });
            // The receipt is not the outcome. Queue the row so the verdict that
            // arrives up to 64 minutes later can be matched to it.
            await noteSubmission({ fp, source: job.file, row: pick.row, phone: tg.phone });
            await markPasswordUsed(resumePw);
            ok++;
          } else failed.push(tag);
          continue;
        }

        if (pending && pending.uses >= MAX_REUSE) {
          log.info("Password reuse limit reached - will walk for a fresh one");
          pending = null;
        }
        let startReplies = [];
        if (!pending) {
          log.info(`Job: ${GROUP} -> ${JOB}`);
          const walked = await walkForPassword(tg, fp);
          if (!walked) throw new Bail(`no password after ${MAX_START_ATTEMPTS} Start attempts - stopped before the 2FA key`);
          if (walked.creds.password === currentPw) throw new Bail("bot gave the same password we already have — nothing to change");
          pending = { ...walked.creds, uses: 0 };
          startReplies = walked.startReplies;
          if (dryRun) {
            log.info("----- history after Start -----");
            startReplies.forEach((r) => log.info(r.replace(/\s+/g, " ").slice(0, 600)));
            log.success(`PASSWORD: ${pending.password} - DRY RUN, Facebook untouched`);
            pending = null;
            ok++;
            continue;
          }
        } else {
          log.info(`Reusing bot password (use ${pending.uses + 1}/${MAX_REUSE}) - no new Start`);
        }
        pending.uses++;

        let changed;
        try {
          changed = await changeFacebook(currentPw, pending.password, url, pick.cookie);
        } catch (e) {
          if (e instanceof BailGated) {
            await markSkipped({ fp, reason: String(e.message).slice(0, 200), source: job.file, row: pick.row });
            audit({ leg: "internal", what: "gated", status: "sms-required", fp });
            log.warn(`Gated - recorded in the ledger. Same password carries to next cookie (${pending.uses}/${MAX_REUSE})`);
            continue; // keep pending for the next cookie
          }
          throw e;
        }
        if (!changed.ok) {
          // SENT ANYWAY, on purpose. A blank banner is AMBIGUOUS, and blocking on
          // ambiguity throws the account away in exchange for certainty about
          // nothing. The only cost of sending is the provider's verdict on this one
          // account, which arrives in ~64 minutes either way - and a rejection is
          // information, not waste.
          //
          // It is recorded as unconfirmed so the question stays measurable: if
          // these verdicts come back approved the banner was noise, if they come
          // back rejected it was telling the truth.
          log.warn(`Facebook did NOT confirm the change ("${String(changed.verdict ?? "").slice(0, 120)}") - sending anyway, flagged unconfirmed`);
          audit({ leg: "internal", what: "pwchange", status: "unconfirmed-sent", fp });
        } else log.success("Facebook password changed to the bot's password");
        passwordChanged = true;
        await markPasswordUsed(pending.password);

        if (!fa2Key) throw new Bail("Bot wants a 2FA key but none was given (--fa2 / sheet col B)");
        const keyReplies = await tg.sendRaw("send 2FA key", fa2Key);
        // These three can each be replaced by a rate limit or the provider's
        // own timeout, both of which used to look like "no reply came back".
        //
        // Branch on .waited, never on the returned object. An object is ALWAYS
        // truthy, so `if (await obey(...)) continue;` fired on every row, the
        // cookie was never sent, and the row vanished as "0 passed, 0 failed"
        // with the Facebook password already changed. That is what lost
        // 2fa43.xlsx:1. A real rate limit now stops the row with a reason
        // instead of quietly moving on: the account is half-consumed at this
        // point, so there is no safe retry - the operator has to finish it.
        if ((await tg.obeyRateLimit(keyReplies)).waited) throw new Bail("rate limited after the 2FA key - the cookie was NOT sent");
        if (tg.isTaskCancelled(keyReplies)) throw new Bail("the provider's timer ran out after the 2FA key");
        if (!keyReplies.some((r) => /cookie/i.test(r))) throw new Bail("expected a cookie prompt after the 2FA key, got something else");
        const cookieReplies = await tg.sendRaw("send cookie", pick.cookie.trim());
        if ((await tg.obeyRateLimit(cookieReplies)).waited) throw new Bail("rate limited after the cookie - the registration was NOT confirmed");
        if (tg.isTaskCancelled(cookieReplies)) throw new Bail("the provider's timer ran out after the cookie");
        if (!cookieReplies.some((r) => /confirm registration/i.test(r))) throw new Bail("no confirmation prompt after the cookie");
        const final = await tg.press("confirm registration", "Account registered");
        if (final.some((r) => /report has been received/i.test(r))) {
          await markSent({ fp, source: job.file, row: pick.row, job: JOB });
          // The receipt is not the outcome - queue it so the verdict that
          // arrives up to 64 minutes later can be matched to this row.
          await noteSubmission({ fp, source: job.file, row: pick.row, phone: tg.phone });
          audit({ leg: "internal", what: "job", status: "received", fp });
          // NOT sent.jsonl. The write went to postgres hours ago and the message
          // kept naming the file, so the file stayed frozen at 67 while the ledger
          // said 69 - and a file that looks authoritative and is not will be
          // trusted over the database that is. Named where it actually lands.
          log.success(`Recorded in the ledger (fp ${fp}) - awaiting the provider's verdict`);
          ok++;
        } else {
          log.warn("Confirmation sent, but no 'report received' in the reply");
          audit({ leg: "internal", what: "job", status: "unconfirmed", fp });
          failed.push(tag);
        }
        pending = null; // a success retires the password
      } catch (err) {
        const message = String(err?.message ?? err);
        // A flood wait is not this row's failure, it is the run's. Recorded as a
        // failed row it would be retried immediately into the same wall, and the
        // "/start" reset below would throw it again - which is precisely how one
        // rate limit turned into 22 groups and 66 accounts that were never tried.
        const flood = floodWaitSeconds(err);
        if (flood) {
          log.error(`Telegram flood limit: ${flood}s. Stopping this group and the whole run.`);
          log.error("No further row is attempted. Re-run the same command after the wait.");
          return EXIT_RATE_LIMITED;
        }
        if (err instanceof BailGated && curFp) {
          await markSkipped({ fp: curFp, reason: message.slice(0, 200), source: curXlsx, row: curRow });
          audit({ leg: "internal", what: "gated", status: "sms-required", fp: curFp });
          ok++;
        } else if (passwordChanged && curFp) {
          // THE ORPHAN RULE. The password is already the bot's, so this account
          // can never be submitted by retrying it - the next attempt would fail
          // on the password change, forever, and the account would sit in
          // neither sent nor skipped. That is 2fa43:1 and 2fa49:23 right now:
          // password changed, 2FA key sent, cookie never delivered, and no
          // record anywhere. Recorded as skipped so it is never retried
          // blindly and never looks like a healthy row.
          await markSkipped({ fp: curFp, reason: `half-used: password changed, not delivered (${message.slice(0, 160)})`, source: curXlsx, row: curRow });
          audit({ leg: "internal", what: "job", status: "half-used", fp: curFp });
          log.error(`Recorded in the ledger as HALF-USED - the password is already changed, so this row cannot be retried. Finish it by hand or accept the loss.`);
          failed.push(tag);
        } else {
          if (!(err instanceof BailLogged)) log.error(message);
          failed.push(tag);
        }
        if (!tg.isConnected()) {
          log.error("Telegram connection dropped - stopping this group");
          failed.push(...runnable.slice(i + 1).map((j) => `${path.basename(j.file)}:${j.row}`));
          break;
        }
        await tg.sendRaw("reset after failure", "/start")
          .then(() => sleep(ACCOUNT_GAP_MS))
          .catch((e) => {
            if (floodWaitSeconds(e)) { log.error(`Telegram flood limit while resetting - stopping the run.`); limited = true; return; }
            log.warn(`could not reset provider state: ${e?.message ?? e}`);
          });
        if (limited) return EXIT_RATE_LIMITED;
        pending = null; // failures of unknown kind retire the password too
      }
    }
  } finally {
    await tg.close();
    await lock.release();
  }
  log.info(`group done: ${ok} passed, ${failed.length} failed`);
  // A claimed row that ends the group half-used is recorded by the orphan rule;
  // one that fails BEFORE taskly saw it goes back on the queue, because the
  // account is still perfectly sellable and nobody else is going to try it.
  if (pre.claimedFp) {
    const dbm = await import("./db.js");
    const { rows: st } = await dbm.db().query("SELECT status FROM sheet_rows WHERE fp = $1", [pre.claimedFp]);
    const status = st[0]?.status;
    if (status === "claimed") {
      await dbm.releaseSheetRow(pre.claimedFp, "attempt failed before taskly saw it");
      log.warn("Released the claim - that account is still sellable and is back on the queue.");
    } else {
      log.info(`Row recorded as '${status}'.`);
    }
  }
  return failed.length ? 1 : 0;
}

function printHelp() {
  console.log(`index.js - Taskly account submit + Facebook password change (bun)
Usage:
  bun index.js --xlsx a.xlsx b.xlsx [--row N] [--all] [-p phone] [-o currentPw]
  bun index.js --xlsx a.xlsx --row 5 -p <phone> -o <pw>
  bun index.js --xlsx a.xlsx --all -p <phone>          # whole sheet
  bun index.js -P <assignedPw> -o <current> --fa2 <k> --xlsx a.xlsx --row 5   # resume
  bun index.js --login <phone>                         # one-time Telegram sign-in
  bun index.js --selftest                              # offline checks, no browser, no network
  bun index.js --check-verdicts                        # what actually happened to every report we sent
  bun index.js --check-task                            # is the job listed right now? spends nothing
  bun index.js --check-pw --hold --xlsx a.xlsx --row 5 -o <curPw>   # on an unknown screen: dump it and keep the browser open
  bun index.js --codegen --xlsx a.xlsx --row 5         # open browser with that row's cookie, pause for inspector
  bun index.js --codegen --detect --xlsx a.xlsx --row 5   # walk to the form and report what was identified, type nothing
  bun index.js --check-pw --xlsx a.xlsx --row 5 -o <curPw>   # fill the form, prove the button enables, do NOT submit
  bun index.js --refresh-cookie --xlsx a.xlsx --row 5 -o <curPw>          # log in once, retest the new cookie, compare
  bun index.js --refresh-cookie --xlsx a.xlsx --row 5 -o <curPw> --write-back   # ...and save it if it is trusted
  bun index.js --codegen --check-gate --xlsx a.xlsx --row 5 -o <curPw>   # report which gate this row hits. Clicks no gate button.
  bun index.js --codegen --check-gate --dismiss --hold --xlsx a.xlsx --row 5   # ...click Dismiss, show what follows, leave the browser open
  bun index.js --balance                                  # what the provider actually holds. Read-only, spends nothing
  bun index.js --withdraw 0.4 --wallet <addr>            # PREVIEW only. Adds --confirm to actually send it
  bun index.js --price                                    # one approval: live rate, provider price, and the user/our split
  bun index.js --drain                                     # send queued user submissions, spend nothing
  bun index.js --drain --watch                             # ...and stay up to receive the verdicts (~64m)
  bun index.js --drain --list-queued                       # queue depth only, send nothing
  bun bot.js                                               # the user-facing Telegram bot (separate process)
Flags: --xlsx (repeatable/comma/space), --row, --rows f#r,.. (internal), --all,
  -p/--phone, -o/--current-password, -P/--password, --fa2, --per-session N,
  --plan, --force, --dry-run/--probe, --codegen, --detect, --check-pw,
  --check-gate, --dismiss, --refresh-cookie, --write-back, --hold, --selftest, --balance, --withdraw, --price,
  --check-verdicts, --check-task, --drain, --watch, --limit N, --list-queued,
  --no-uid-check, --skip-task-check, --login, --help
Rule: one bot password covers max ${MAX_REUSE} cookies and retires after 1 success.`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) { printHelp(); return; }
  if (args.includes("--selftest")) { process.exit((await selftest()) ? 1 : 0); }
  if (args.includes("--check-verdicts")) { process.exit(await checkVerdicts()); }
  if (args.includes("--count-from-chat")) { process.exit(await runCountFromChat(args)); }
  if (args.includes("--balance") || args.includes("--withdraw")) { process.exit(await runMoney(args)); }
  if (args.includes("--drain")) { process.exit(await runDrain(args)); }
  if (args.includes("--report") || args.includes("--pay") || args.includes("--price") || args.includes("--clear") || args.includes("--requeue")) {
    process.exit(await runAdmin(args));
  }
  if (args.includes("--check-task")) { process.exit(await runCheckTask()); }
  if (args.includes("--login")) {
    const p = argValue(args, ["--login"]) ?? argValue(args, ["--phone", "-p"]);
    const t = await Taskly.open({ phone: p });
    tlog.ok("Login OK");
    await t.close();
    return;
  }
  const phone = argValue(args, ["--phone", "-p"]) ?? process.env.TG_PHONE;
  if (args.includes("--codegen") || args.includes("--check-pw") || args.includes("--refresh-cookie") || args.includes("--check-gate")) {
    HOLD = args.includes("--hold");
    try {
      if (args.includes("--refresh-cookie")) process.exit(await runRefreshCookie(args));
      if (args.includes("--check-pw")) process.exit(await runCheckPw(args));
      if (args.includes("--check-gate")) process.exit(await runCheckGate(args));
      if (args.includes("--detect")) process.exit(await runDetect(args));
      await runCodegen(args);
      return;
    }
    catch (e) { if (!(e instanceof BailLogged)) log.error(e?.message ?? e); process.exit(1); }
  }
  // --work needs no sheet and no row list: it claims from the shared queue.
  // Routed here, before the sheet handling, because without it the code below
  // would find no --xlsx, print the help text and exit - which looks like a
  // silent no-op rather than a mistake.
  if (args.includes("--work")) { process.exit(await runQueueWorker(args, phone)); }
  const group = parseRows(argValue(args, ["--rows"]));
  if (group.length) { process.exit(await runGroup(group, args, phone)); }
  const sheets = argValues(args, "--xlsx");
  if (args.includes("--all") || sheets.length > 1) { process.exit(await runBatch(sheets, args)); }
  const single = sheets[0] ? [{ file: sheets[0], row: Number(argValue(args, ["--row"]) ?? "1") }] : [];
  if (!single.length) { printHelp(); process.exit(1); }
  process.exit(await runGroup(single, args, phone));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().then((code) => { if (typeof code === "number") process.exit(code); }).catch(async (err) => {
    const gated = err instanceof BailGated || /sms confirmation code|never left 'Loading/i.test(err?.message ?? "");
    if (gated && curFp) {
      // Awaited even here, on the way out. This handler is the last thing that
      // runs before the process dies, so an un-awaited write is the one most
      // likely to be lost - and a gate that was never recorded is a row that
      // gets retried and fails again for ever.
      await markSkipped({ fp: curFp, reason: (err.message ?? "gated").slice(0, 200), source: curXlsx, row: curRow }).catch(() => {});
      audit({ leg: "internal", what: "gated", status: "sms-required", fp: curFp });
      log.warn("Recorded in the ledger - this account will not be retried");
    } else if (!curFp) {
      // Not a lost row. No row was ever started, so there is nothing to record -
      // and saying "it will be retried next run" about a row that does not exist
      // is what made a rate-limited run look like it was dropping accounts.
      const flood = floodWaitSeconds(err);
      log.error(flood
        ? `Telegram flood limit: ${flood}s. No row was started, so nothing was lost.`
        : "Failed before any row was started - nothing was spent and nothing to record.");
    }
    if (!(err instanceof BailLogged)) log.error(err.message);
    // A flood thrown during setup (open, availability check, menu reset) never
    // reaches the per-row handler - it lands here with no row started. Exiting 1
    // tells the batch parent "one group failed", so it spawns the next group
    // into the same wall. Exit 75 and the parent stops the whole run instead.
    process.exit(floodWaitSeconds(err) ? EXIT_RATE_LIMITED : 1);
  });
}
