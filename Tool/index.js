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
const SHARED_PASSWORD = process.env.FB_CURRENT_PASSWORD ?? "dgddigital";
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
export const log = {
  info: (m) => console.log(chalk.blue("INFO"), chalk.white(m)),
  success: (m) => console.log(chalk.green("SUCCESS"), chalk.white(m)),
  error: (m) => console.log(chalk.red("ERROR"), chalk.white(m)),
  warn: (m) => console.log(chalk.yellow("WARN"), chalk.white(m)),
  // Off unless TOOL_DEBUG is set, so the per-tick wait tracing does not drown
  // the run by default.
  debug: (m) => { if (process.env.TOOL_DEBUG) console.log(chalk.gray("DEBUG"), chalk.gray(m)); },
};
const tlog = {
  info: (m) => console.log(chalk.blue("TG"), chalk.white(m)),
  ok: (m) => console.log(chalk.green("TG"), chalk.white(m)),
  err: (m) => console.log(chalk.red("TG"), chalk.white(m)),
  raw: (m) => { if (process.env.TOOL_DEBUG) console.log(chalk.gray("TG"), chalk.gray(m)); },
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
const SENT_FILE = path.join(OUT_DIR, "sent.jsonl");
const SKIP_FILE = path.join(OUT_DIR, "skipped.jsonl");
const USEDPW_FILE = path.join(OUT_DIR, "used-passwords.json");
function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter((r) => !!r?.fp);
}
const listSent = () => readJsonl(SENT_FILE);
const isSent = (fp) => listSent().some((r) => r.fp === fp);
function markSent(rec) {
  fs.mkdirSync(path.dirname(SENT_FILE), { recursive: true });
  fs.appendFileSync(SENT_FILE, JSON.stringify({ at: new Date().toISOString(), ...rec }) + "\n", "utf8");
}
const listSkipped = () => readJsonl(SKIP_FILE);
const isSkipped = (fp) => listSkipped().some((r) => r.fp === fp);
function markSkipped(rec) {
  if (isSkipped(rec.fp)) return;
  fs.mkdirSync(path.dirname(SKIP_FILE), { recursive: true });
  fs.appendFileSync(SKIP_FILE, JSON.stringify({ at: new Date().toISOString(), ...rec }) + "\n", "utf8");
}
const hashPw = (pw) => createHash("sha256").update(String(pw)).digest("hex");
function listUsedPw() {
  try {
    const a = JSON.parse(fs.readFileSync(USEDPW_FILE, "utf8"));
    return Array.isArray(a) ? a : [];
  } catch { return []; }
}
const isPasswordUsed = (pw) => listUsedPw().includes(hashPw(pw));
function markPasswordUsed(pw) {
  const h = hashPw(pw);
  const l = listUsedPw();
  if (l.includes(h)) return;
  l.push(h);
  fs.mkdirSync(path.dirname(USEDPW_FILE), { recursive: true });
  fs.writeFileSync(USEDPW_FILE, JSON.stringify(l, null, 1), "utf8");
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
const PENDING_FILE = path.join(OUT_DIR, "pending.json");
const VERDICTS_FILE = path.join(OUT_DIR, "verdicts.jsonl");
// The file arguments exist so --selftest can drive this against a temp dir
// instead of the real ledgers.
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
// Called the moment the provider acknowledges a report.
function noteSubmission({ fp, source, row, phone = null }, file = PENDING_FILE) {
  const list = loadPending(file);
  list.push({ at: new Date().toISOString(), fp, source, row, phone });
  savePending(list, file);
  return list.length;
}
// phone is the session the verdict arrived on. Without it this shifts the
// globally-oldest entry, which is how a verdict got filed against the wrong
// sheet. Entries with no phone (written before this change) are only claimable
// when there is nothing else, and never by a different session's verdict.
function recordVerdict(v, phone = null, pendingFile = PENDING_FILE, verdictsFile = VERDICTS_FILE) {
  const list = loadPending(pendingFile);
  let idx = -1;
  if (phone) idx = list.findIndex((e) => e.phone === phone);
  // No entry for this session. Do NOT fall back to another session's row -
  // consuming it would silently reassign a real submission. Record and move on.
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
// Returns {on: true|false|null, ...}. null means "could not tell" and MUST NOT
// stop a run - only a definitive absence of the job is a reason to stop, because
// a flaky network is not evidence that the provider delisted anything.
async function taskAvailability(tg) {
  try {
    await tg.obeyRateLimit(await tg.ensureMainMenu());
    await sleep(STEP_MS);
    await tg.obeyRateLimit(await tg.press("open Tasks", "Tasks"));
    await sleep(STEP_MS);
    const opened = await tg.obeyRateLimit(await tg.press(`open ${GROUP}`, GROUP));
    if (opened.waited) return { on: null, listed: [], why: "rate limited opening the group" };
    await sleep(STEP_MS);
    const all = tg.labels();
    const listed = all.filter((l) => l.toLowerCase().includes(JOB.toLowerCase()));
    return { on: listed.length > 0, listed, all };
  } catch (e) {
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
function checkVerdicts() {
  const v = listVerdicts();
  const pending = loadPending();
  const approved = v.filter((r) => r.verdict === "approved");
  const rejected = v.filter((r) => r.verdict === "rejected");
  const unmatched = v.filter((r) => !r.matched);
  log.info(`verdicts recorded : ${v.length}`);
  log.info(`  approved        : ${approved.length}  ${approved.reduce((s, r) => s + Number(r.amount ?? 0), 0).toFixed(4)}`);
  log.info(`  rejected        : ${rejected.length}`);
  log.info(`  unmatched       : ${unmatched.length}${unmatched.length ? " - more verdicts than submissions, the queue was empty" : ""}`);
  log.info(`  awaiting verdict: ${pending.length}`);
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
  const sent = fs.existsSync(SENT_FILE) ? readJsonl(SENT_FILE).length : 0;
  log.info(`sent.jsonl says ${sent} sent. ${sent - rejected.length} of those are not known to be rejected.`);
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
  // The user-facing bot's own rules, exercised without Telegram. Pinned because
  // the message style is a requirement, not a preference: inline keyboards only,
  // no emoji beyond the two that carry meaning, and nothing that runs long.
  const { parseSubmission: parseSub, text: botText, kb: botKb } = await import("./bot.js");
  // Must clear the 200-char floor the parser enforces, or every case below would
  // fail as "not-a-cookie" and the real rules would go untested. Real cookies run
  // 900+; this is just long enough to be realistic.
  const C = ("datr=SYNTHETICabc123456; sb=SYNTHETICdef456789; c_user=100000000000001; fr=SYNTHETICghi789012; " +
    "xs=SYNTHETICjkl012mno345678; pas=100000000000001%3AABCDEFGHIJKLMNOP; ps_l=1; ps_n=1; wd=491x675; dpr=2.2; " +
    "x-referer=eyJyIjoiL21yZWN0IiwicmMiOiJodHRwczovL2wuZmFjZWJvb2suY29tL3dyaXRlLzEiLCJkIjoiaGFrZXIifQ%3D%3D");
  const K = "LO4E WXSP MGT4 MJMU PMGM NBIL QLR6 E332";
  for (const [got, want, what] of [
    [parseSub(C + "\n" + K).ok, true, "two-line submission"],
    [parseSub(C + "\t" + K).ok, true, "tab-pasted submission"],
    [parseSub(K + "\n" + C).why, "not-a-cookie", "key sent first"],
    [parseSub(C).why, "format", "cookie only"],
    [parseSub("").why, "empty", "empty message"],
    [parseSub("datr=x\n" + K).why, "not-a-cookie", "truncated cookie"],
    [parseSub(C + "\nshort").why, "bad-key", "bad 2FA key"],
  ]) {
    if (got !== want) { log.error(`selftest: bot parse - ${what} gave ${got}, wanted ${want}`); bad++; }
  }
  const botMsgs = [botText.start(), botText.prompt(), botText.badFormat(), botText.notACookie(), botText.badKey(),
    botText.accepted(1), botText.duplicate(), botText.cancelled(), botText.idle(),
    botText.status({ queued: 1, inflight: 1, approved: 1, rejected: 1 })];
  const strayEmoji = [...new Set(botMsgs.join("\n").match(/\p{Extended_Pictographic}/gu) ?? [])]
    .filter((e) => !["✅", "❌", "▸"].includes(e));
  if (strayEmoji.length) { log.error(`selftest: bot uses emoji it should not: ${strayEmoji.join(" ")}`); bad++; }
  const longest = Math.max(...botMsgs.map((m) => m.length));
  if (longest > 90) { log.error(`selftest: a bot message runs to ${longest} chars - too long`); bad++; }
  if (!Object.values(botKb).every((f) => f().rows?.length)) { log.error("selftest: a bot keyboard has no rows"); bad++; }
  // /start is the only command. If a user never types anything they must still be
  // able to reach submit and status, so both have to be buttons.
  const { BUTTONS: botButtons } = await import("./bot.js");
  const targets = new Set(Object.values(botButtons).flat().map(([, d]) => d));
  for (const need of ["submit", "status", "menu"]) {
    if (!targets.has(need)) { log.error(`selftest: no inline button reaches "${need}" - the user would have to type a command`); bad++; }
  }
  if (botText.start().includes("/")) { log.error("selftest: the /start reply advertises a command"); bad++; }
  log.info(`selftest: bot parse, style and keyboards checked (longest ${longest} chars, no stray emoji, buttons reach submit/status/menu)`);
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
  noteSubmission({ fp: "aaa", source: "a.xlsx", row: 1, phone: "111" }, pf);
  noteSubmission({ fp: "bbb", source: "b.xlsx", row: 2, phone: "111" }, pf);
  noteSubmission({ fp: "ccc", source: "c.xlsx", row: 3, phone: "111" }, pf);
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
  noteSubmission({ fp: "AAA", source: "2fa43.xlsx", row: 6, phone: "111" }, pf2);
  noteSubmission({ fp: "BBB", source: "2fa100.xlsx", row: 99, phone: "222" }, pf2);
  const b1 = recordVerdict({ verdict: "approved", amount: "0.05" }, "222", pf2, vf2);
  if (b1.claim?.fp !== "BBB") { log.error(`selftest: session 222's verdict claimed fp ${b1.claim?.fp}, wanted BBB (its own row)`); bad++; }
  const b2 = recordVerdict({ verdict: "approved", amount: "0.05" }, "111", pf2, vf2);
  if (b2.claim?.fp !== "AAA") { log.error(`selftest: session 111's verdict claimed fp ${b2.claim?.fp}, wanted AAA (its own row)`); bad++; }
  // 222 has nothing left. It must NOT eat 111's next row.
  noteSubmission({ fp: "CCC", source: "2fa49.xlsx", row: 1, phone: "111" }, pf2);
  const b3 = recordVerdict({ verdict: "approved", amount: "0.05" }, "222", pf2, vf2);
  if (b3.matched !== false) { log.error(`selftest: session 222 with nothing pending claimed ${b3.claim?.fp} - it stole another session's row`); bad++; }
  const left = loadPending(pf2);
  if (left.length !== 1 || left[0].fp !== "CCC") { log.error("selftest: the other session's pending row did not survive an empty verdict"); bad++; }
  log.info("selftest: verdict FIFO pairing checked, and two sessions no longer share a queue");
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp only */ }
  log.info(`selftest: ${bad === 0 ? "all provider-message cases passed" : bad + " provider-message case(s) wrong"}`);
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
      markSkipped({ fp, reason: "banned: facebook served a checkpoint saying the account is disabled", source: curXlsx, row: curRow });
      audit({ leg: "internal", what: "account", status: "banned", fp });
    }
    log.error("BANNED: Facebook says this account is disabled. Recorded in skipped.jsonl - it will not be retried.");
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
  log.success("Clicked Change password — watching the screen for 10s");
  const watchUntil = Date.now() + 10_000;
  const clean = (s) => s.replace(/\s+/g, " ").trim();
  let lastNotices = "";
  let verdict = "";
  while (Date.now() < watchUntil) {
    if (page.isClosed()) { log.warn("Page closed during watch — stopping early"); break; }
    if (await codePromptVisible(page)) await bailCodePrompt((await codePromptText(page)) ?? "confirmation code");
    const notices = await page.locator('[role="alert"], [role="status"], [aria-live]:not([aria-live="off"])')
      .allInnerTexts().then((list) => clean(list.join(" | "))).catch(() => "");
    if (notices && notices !== lastNotices) { lastNotices = notices; log.info(`[${elapsed()}] banner: ${notices}`); }
    const body = await page.locator("body").innerText({ timeout: 2000 }).then(clean).catch(() => "");
    if (body) {
      const hit = body.match(/.{0,40}(you changed your facebook password[^.]{0,60}|password (has been|was) (changed|updated)[^.]{0,40}|(incorrect|wrong|does not|do not) match|incorrect password|try again|unable to (change|update)[^.]{0,40}).{0,40}/i);
      if (hit && !verdict) { verdict = clean(hit[0]); break; }
    }
    await sleep(POLL_MS);
  }
  if (!verdict && lastNotices) verdict = lastNotices;
  const ok = /you changed|password (has been|was) (changed|updated)/i.test(verdict);
  if (ok) log.success(`RESULT: ${verdict}`);
  else if (verdict) log.error(`RESULT: ${verdict}`);
  else log.warn("RESULT: no confirmation banner seen within 10s — check the browser");
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
      try { await send(); hard = setTimeout(done, HARD_MS); await finished; }
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
      const alive = queue.filter((j) => {
        const hit = live.get(uidOf(j.cookie));
        if (!hit || hit.status === "valid") return true; // unknown -> keep it, never discard on a guess
        markSkipped({ fp: j.fp, reason: `account dead (uid check: ${hit.message ?? "not valid"})`, source: j.file, row: j.row });
        log.error(`${path.basename(j.file)}:${j.row} - account ${maskUid(uidOf(j.cookie))} is dead (${hit.message ?? "not valid"}), never retried`);
        return false;
      });
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
    if (isPasswordUsed(creds.password)) {
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

// One UID check per fingerprint per group, not one per row: the same cookie
// can appear twice in a sheet and the answer will not have changed.
const uidChecked = new Set();
async function runGroup(group, args, phone) {
  if (!group.length) { log.error("nothing to run - no rows given"); return 1; }
  const force = args.includes("--force");
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
  const tg = await Taskly.open({ phone });
  // Guard: if the job is not listed there is nothing to sell, so stop before
  // walking - not three presses into a walk that cannot finish. Reuses the
  // session we already opened, so it costs one /start and two button presses.
  //
  // "Could not tell" is deliberately NOT a stop. A flaky network is not
  // evidence that the provider delisted anything, and stopping on a guess
  // would refuse to run on a day the job is perfectly available.
  if (!args.includes("--skip-task-check")) {
    const avail = await taskAvailability(tg);
    if (avail.on === false) {
      log.error(`The job "${JOB}" is not listed under ${GROUP} right now, so there is nothing to sell.`);
      log.error("Nothing was spent. Re-check any time with: bun index.js --check-task");
      const others = (avail.all ?? []).filter((l) => /\$[\d.]+/.test(l) && !l.toLowerCase().includes(GROUP.toLowerCase()));
      if (others.length) log.info(`listed instead: ${others.join(" | ")}`);
      await tg.close();
      return 1;
    }
    if (avail.on === null) log.warn(`Could not confirm the job is listed (${avail.why}) - carrying on anyway`);
    else log.success(`Job is listed: ${avail.listed.join(" | ")}`);
    // The check leaves us sitting on the job list; the walk expects the menu.
    await tg.ensureMainMenu();
  }
  let ok = 0;
  const failed = [];
  // One bot password covers up to MAX_REUSE cookies; a success retires it.
  let pending = null; // {password, firstName, lastName, uses}
  try {
    for (const [i, job] of runnable.entries()) {
      const tag = `${path.basename(job.file)}:${job.row}`;
      log.info(`── [${i + 1}/${runnable.length}] ${tag}`);
      try {
        tg.resetWindow();
        const pick = resolveRow(job.file, job.row);
        const fp = fingerprint(pick.cookie);
        curFp = fp; curXlsx = job.file; curRow = pick.row;
        log.success(`${path.basename(job.file)}: row ${pick.row} (fp ${fp})`);
        if (isSent(fp) && !force) throw new Bail(`row ${pick.row} already in sent.jsonl. Use --force.`);
        if (isSkipped(fp) && !force) throw new Bail(`row ${pick.row} SMS-gated. Use --force.`);
        // Account liveness first, then the cookie. A dead account is skipped
        // outright; only a live one is worth spending a cookie probe on.
        if (!dryRun && !force && !uidChecked.has(fp)) {
          uidChecked.add(fp);
          const acc = await checkUid(pick.cookie);
          audit({ leg: "internal", what: "uid", status: acc.status, fp });
          if (acc.status === "dead") {
            markSkipped({ fp, reason: `account dead (uid check: ${acc.message ?? "not valid"})`, source: job.file, row: pick.row });
            log.error(`Row ${pick.row}: account ${maskUid(acc.uid)} is dead - recorded in skipped.jsonl, never retried.`);
            throw new BailLogged(`row ${pick.row} account is dead.`);
          }
          log.info(`Row ${pick.row}: account ${maskUid(acc.uid)} is ${acc.status} - checking the cookie`);
        }
        if (!dryRun && !resumePw && !force && (await isCookieDead(pick.cookie))) {
          markSkipped({ fp, reason: "cookie confirmed dead at accountscenter", source: job.file, row: pick.row });
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
          const keyReplies = await tg.sendRaw("send 2FA key", fa2Key);
          if (await tg.obeyRateLimit(keyReplies)) continue;
          if (tg.isTaskCancelled(keyReplies)) throw new Bail("the provider's timer ran out after the 2FA key");
          if (!keyReplies.some((r) => /cookie/i.test(r))) throw new Bail("expected a cookie prompt after the 2FA key");
          const cookieReplies = await tg.sendRaw("send cookie", pick.cookie.trim());
          if (await tg.obeyRateLimit(cookieReplies)) continue;
          if (!cookieReplies.some((r) => /confirm registration/i.test(r))) throw new Bail("no confirmation prompt after the cookie");
          const final = await tg.press("confirm registration", "Account registered");
          if (final.some((r) => /report has been received/i.test(r))) {
            markSent({ fp, source: job.file, row: pick.row, job: JOB });
            // The receipt is not the outcome. Queue the row so the verdict that
            // arrives up to 64 minutes later can be matched to it.
            noteSubmission({ fp, source: job.file, row: pick.row, phone: tg.phone });
            markPasswordUsed(resumePw);
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
            markSkipped({ fp, reason: String(e.message).slice(0, 200), source: job.file, row: pick.row });
            audit({ leg: "internal", what: "gated", status: "sms-required", fp });
            log.warn(`Gated - recorded in skipped.jsonl. Same password carries to next cookie (${pending.uses}/${MAX_REUSE})`);
            continue; // keep pending for the next cookie
          }
          throw e;
        }
        if (!changed.ok) throw new Bail(`Facebook did not confirm the change: ${changed.verdict}`);
        log.success("Facebook password changed to the bot's password");
        markPasswordUsed(pending.password);

        if (!fa2Key) throw new Bail("Bot wants a 2FA key but none was given (--fa2 / sheet col B)");
        const keyReplies = await tg.sendRaw("send 2FA key", fa2Key);
        // These three can each be replaced by a rate limit or the provider's
        // own timeout, both of which used to look like "no reply came back".
        if (await tg.obeyRateLimit(keyReplies)) continue;
        if (tg.isTaskCancelled(keyReplies)) throw new Bail("the provider's timer ran out after the 2FA key");
        if (!keyReplies.some((r) => /cookie/i.test(r))) throw new Bail("expected a cookie prompt after the 2FA key, got something else");
        const cookieReplies = await tg.sendRaw("send cookie", pick.cookie.trim());
        if (await tg.obeyRateLimit(cookieReplies)) continue;
        if (tg.isTaskCancelled(cookieReplies)) throw new Bail("the provider's timer ran out after the cookie");
        if (!cookieReplies.some((r) => /confirm registration/i.test(r))) throw new Bail("no confirmation prompt after the cookie");
        const final = await tg.press("confirm registration", "Account registered");
        if (final.some((r) => /report has been received/i.test(r))) {
          markSent({ fp, source: job.file, row: pick.row, job: JOB });
          // The receipt is not the outcome - queue it so the verdict that
          // arrives up to 64 minutes later can be matched to this row.
          noteSubmission({ fp, source: job.file, row: pick.row, phone: tg.phone });
          audit({ leg: "internal", what: "job", status: "received", fp });
          log.success(`Recorded in sent.jsonl (fp ${fp}) - awaiting the provider's verdict`);
          ok++;
        } else {
          log.warn("Confirmation sent, but no 'report received' in the reply");
          audit({ leg: "internal", what: "job", status: "unconfirmed", fp });
          failed.push(tag);
        }
        pending = null; // a success retires the password
      } catch (err) {
        const message = String(err?.message ?? err);
        if (err instanceof BailGated && curFp) {
          markSkipped({ fp: curFp, reason: message.slice(0, 200), source: curXlsx, row: curRow });
          audit({ leg: "internal", what: "gated", status: "sms-required", fp: curFp });
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
        await tg.sendRaw("reset after failure", "/start")
          .then(() => sleep(ACCOUNT_GAP_MS))
          .catch((e) => log.warn(`could not reset provider state: ${e?.message ?? e}`));
        pending = null; // failures of unknown kind retire the password too
      }
    }
  } finally {
    await tg.close();
  }
  log.info(`group done: ${ok} passed, ${failed.length} failed`);
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
  bun index.js --drain                                     # send queued user submissions, spend nothing
  bun index.js --drain --watch                             # ...and stay up to receive the verdicts (~64m)
  bun index.js --drain --list-queued                       # queue depth only, send nothing
  bun bot.js                                               # the user-facing Telegram bot (separate process)
Flags: --xlsx (repeatable/comma/space), --row, --rows f#r,.. (internal), --all,
  -p/--phone, -o/--current-password, -P/--password, --fa2, --per-session N,
  --plan, --force, --dry-run/--probe, --codegen, --detect, --check-pw,
  --check-gate, --dismiss, --refresh-cookie, --write-back, --hold, --selftest,
  --check-verdicts, --check-task, --drain, --watch, --limit N, --list-queued,
  --no-uid-check, --skip-task-check, --login, --help
Rule: one bot password covers max ${MAX_REUSE} cookies and retires after 1 success.`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) { printHelp(); return; }
  if (args.includes("--selftest")) { process.exit((await selftest()) ? 1 : 0); }
  if (args.includes("--check-verdicts")) { process.exit(checkVerdicts()); }
  if (args.includes("--drain")) { process.exit(await runDrain(args)); }
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
  main().then((code) => { if (typeof code === "number") process.exit(code); }).catch((err) => {
    const gated = err instanceof BailGated || /sms confirmation code|never left 'Loading/i.test(err?.message ?? "");
    if (gated && curFp) {
      markSkipped({ fp: curFp, reason: (err.message ?? "gated").slice(0, 200), source: curXlsx, row: curRow });
      audit({ leg: "internal", what: "gated", status: "sms-required", fp: curFp });
      log.warn("Recorded in skipped.jsonl - this account will not be retried");
    } else if (!curFp) {
      log.error("Could not record the skip: no fingerprint for this row. It will be retried next run.");
    }
    if (!(err instanceof BailLogged)) log.error(err.message);
    process.exit(1);
  });
}
