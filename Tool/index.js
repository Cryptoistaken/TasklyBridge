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

config();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

const PROFILE_DIR = path.join(__dirname, "profile");
const LAUNCH_ARGS = [
  "--disable-blink-features=AutomationControlled",
  // Chrome's own crash-recovery UI. It is NOT a Playwright concern - the
  // docs do not mention it - it appears only when the profile was left with
  // exit_type=Crashed, which a force-kill does. Playwright's guidance for
  // that is handleSIGINT (default true): close the browser instead of killing
  // it. This flag just stops the leftover state from interrupting a run.
  "--hide-crash-restore-bubble",
];

// navigator.webdriver is still true even with the Blink feature flag off, so
// any page that reads the property sees us. The old FAF bot set both; we only
// had the flag. Cheap, and it is the one stealth measure that does not require
// guessing at Facebook's heuristics.
const STEALTH_INIT = () => {
  Object.defineProperty(Navigator.prototype, "webdriver", { get: () => false, configurable: true });
};

// exit_type=Crashed survives in the profile until Chrome next starts, and then
// every launch opens with a "Restore pages?" bubble over the page we are
// driving. Clearing it is safe: the worst case is losing a session we did not
// want restored anyway.
function clearStaleCrashFlag() {
  const prefs = path.join(PROFILE_DIR, "Default", "Preferences");
  if (!fs.existsSync(prefs)) return;
  try {
    const j = JSON.parse(fs.readFileSync(prefs, "utf8"));
    if (j?.profile?.exit_type !== "Crashed") return;
    j.profile.exit_type = "Normal";
    j.profile.exited_cleanly = true;
    fs.writeFileSync(prefs, JSON.stringify(j), "utf8");
    log.info("Cleared a stale Chrome crash flag left by a previous force-kill");
  } catch (e) {
    log.warn(`could not clear the Chrome crash flag: ${e?.message ?? e}`);
  }
}

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
  raw: (m) => console.log(chalk.gray("TG"), chalk.gray(m)),
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
const SENT_FILE = path.join(__dirname, "out", "sent.jsonl");
const SKIP_FILE = path.join(__dirname, "out", "skipped.jsonl");
const USEDPW_FILE = path.join(__dirname, "out", "used-passwords.json");
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
    const dir = path.join(__dirname, "out");
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, `audit-${new Date().toISOString().slice(0, 10)}.jsonl`);
    fs.appendFileSync(f, JSON.stringify({ at: new Date().toISOString(), ...rec }) + "\n", "utf8");
  } catch { /* audit never fails the run */ }
}
const preview = (t, n = 300) => String(t ?? "").replace(/\s+/g, " ").slice(0, n);

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
async function probeOnce(cookie) {
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
const mButton = (page, re) => page.locator('[role="button"]').filter({ hasText: re }).first();
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
  // Checked LAST and matched narrowly on purpose: the re-auth form also says
  // "Log in", so a broad /Log in/ here would file a recoverable session as a
  // dead cookie. This wants an actual email/phone field, which the re-auth
  // form does not have.
  loggedOut: { name: "LOGGED OUT / login screen", loc: page.getByText(/Log into Facebook|Email or phone number/i).first() },
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
const CHALLENGE_WORDS = /confirm your identity|it'?s you|enter your password to confirm|security check|confirm it'?s you|we detected|unusual login|confirm that you'?re human|are you a robot/i;
function isCheckpointUrl(page) {
  return /checkpoint/i.test(page.url());
}
// The "automated behaviour" interstitial, as --hold found it on 2fa100 row 9.
// One Continue button, no Dismiss. Requiring the phrase AND the button keeps a
// bare "Continue" on some other page from being clicked as a human check.
const HUMAN_CHECK = /confirm that you'?re human|are you a robot|verify you'?re human/i;
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
  log.info(`selftest: ${banned.length + challenge.length} checkpoint wordings checked, ${bad} wrong`);
  if (!bad) log.success("selftest passed");
  return bad;
}

async function awaitCheckpoint(page, minutes = 10) {
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
  // The human check found by --hold: one button, Continue, and no Dismiss.
  // It is a challenge, not a ban - the account works - so the row carries on
  // after the click. Logged loudly because an earlier version of this file
  // described the same screen as "click Dismiss", and that is not what it is.
  if (await findHumanCheck(page)) {
    log.warn("Facebook is asking to confirm we are human (one Continue button). Clicking it.");
    const btn = mButton(page, /^Continue$/);
    await btn.click({ timeout: 5000 }).catch((e) => log.warn(`Continue would not click: ${e?.message ?? e}`));
    await waitForGone(mButton(page, /^Continue$/), 4_000, "the human check");
    // Verified on 2fa100 row 9: that click lands on a CAPTCHA. Stop here
    // rather than filling a form the CAPTCHA is sitting on top of.
    for (let i = 0; i < 8; i++) {
      if (await captchaVisible(page)) {
        log.error("CAPTCHA: Facebook is asking for the text from an image. This is not solved here - a person has to do it.");
        log.error("Run: bun index.js --codegen --xlsx <sheet> --row <n>   and type it in by hand.");
        throw new BailLogged("captcha: needs a human");
      }
      await sleep(POLL_MS);
    }
    log.warn("Continued past the human check.");
    return;
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
    if (isCheckpointUrl(page)) { await awaitCheckpoint(page); reachedForm = true; break; }
    // loggedOut is last on purpose. The re-auth form also says "Log in", so
    // anything broader would file a recoverable session as a dead cookie.
    const here = await waitForScreen(page,
      [S.passwordForm, S.checkpoint, S.reauth, S.saveLogin, S.continueGate, S.accountChooser, S.hubChangePassword, S.accountHub, S.loggedOut],
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
      await awaitCheckpoint(page);
      reachedForm = true;
      break;
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
const SESSION_DIR = path.join(__dirname, "sessions");
function bridgeEnv() {
  const out = {};
  for (const f of [path.join(__dirname, "..", "Backend", ".env"), path.join(__dirname, ".env")]) {
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
    const t = new Taskly(client);
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
    return t;
  }
  async close() { await this.client.disconnect().catch(() => {}); }
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
  async ensureMainMenu() {
    for (let attempt = 1; attempt <= 3; attempt++) {
      await this.sendRaw("knock", "/start");
      if (this.hasButton("Balance")) return;
      tlog.err(`attempt ${attempt}: not on the main menu, clearing provider state`);
      if (!this.hasButton("Cancel")) throw new Error("provider is not on the main menu and offers no Cancel");
      await this.press("clear state", "Cancel");
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
  clearStaleCrashFlag();
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    ...DEVICES_PHONE,
    locale: "en-US",
    headless: false,
    channel: "chrome",
    args: LAUNCH_ARGS,
  });
  try {
    await context.addInitScript(STEALTH_INIT);
    await context.clearCookies();
    await context.addCookies(parseCookies(cookieString.trim(), process.env.COOKIE_DOMAIN ?? new URL(url).hostname));
    log.success("Cookies loaded");
    return await changePassword({ context, currentPw, newPw, targetUrl: url, dryRun });
  } finally {
    await context.close();
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

// DELIBERATELY UNHANDLED: the "we detected automated behaviour" interstitial.
//
// It was reported as happening "sometimes" and only ever described as "click
// Dismiss". --hold found the real screen (2fa100 row 9) and it does NOT match
// that description:
//
//   https://m.facebook.com/checkpoint/1501092823525282/
//   "Ge. Alissa Bayuk, confirm that you're human to use your account"
//   buttons: Continue
//
// One button, Continue, and no Dismiss at all. So the handler is named for what
// the screen actually is rather than what it was called: a human check with a
// single Continue. That fits the existing checkpoint path instead of adding a
// parallel one - the page already arrives at /checkpoint/.
//
// It is still a challenge, NOT a ban: the account is alive and usable, and
// clicking Continue is what the row needs. Verified on row 9, which then went
// on to the form. If Facebook ever relabels that button, this goes quiet and
// the row is retried - which is the safe direction, since a wrong guess here
// could mark a working account as gated.
//
//   bun index.js --check-pw --hold --xlsx data\sheet.xlsx --row <n> -o <pw>
//
// --hold is still the tool for the next unknown screen: it prints the url,
// text, buttons, links, inputs and dialogs, waits for the page to actually
// render before reporting it empty, and leaves the browser open to poke at.

// ---- Codegen (manual browser with one row's cookie, no Telegram) ----
// cookieOverride lets a caller open the browser with a cookie that is not the
// one in the sheet - used by --refresh-cookie to retest a freshly issued
// session in a clean browser.
async function openRowBrowser(args, cookieOverride) {
  const sheets = argValues(args, "--xlsx");
  if (!sheets.length) throw new Bail("usage: bun index.js --codegen [--detect|--check-pw|--refresh-cookie] --xlsx <sheet> [--row N]");
  const pick = resolveRow(sheets[0], Number(argValue(args, ["--row"]) ?? "1"));
  const url = resolveUrl();
  const cookie = (cookieOverride ?? pick.cookie).trim();
  clearStaleCrashFlag();
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    ...DEVICES_PHONE,
    locale: "en-US",
    headless: false,
    channel: "chrome",
    args: LAUNCH_ARGS,
  });
  try {
    await context.addInitScript(STEALTH_INIT);
    await context.clearCookies();
    await context.addCookies(parseCookies(cookie, process.env.COOKIE_DOMAIN ?? new URL(url).hostname));
    log.success(`${path.basename(sheets[0])}: row ${pick.row} (fp ${fingerprint(pick.cookie)})`);
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto("https://www.facebook.com/", { waitUntil: "load" });
    await page.goto(url, { waitUntil: "load" });
    return { context, page, url };
  } catch (e) {
    await context.close();
    throw e;
  }
}
async function runCodegen(args) {
  const { context, page, url } = await openRowBrowser(args);
  try {
    log.success(`Opened ${url} - inspect, then close the window`);
    await page.pause();
  } finally {
    await context.close();
  }
}

// --detect: walks the same screens changePassword does and prints what it
// identifies. It clicks navigation tiles only - nothing is typed, nothing is
// submitted, so the account is untouched. Exit 0 = the form was found.
async function runDetect(args) {
  const { context, page } = await openRowBrowser(args);
  const S = screens(page);
  const currentPw = argValue(args, ["--current-password", "-o"]) ?? SHARED_PASSWORD;
  try {
    for (let step = 1; step <= 10; step++) {
      if (await codePromptVisible(page)) await bailCodePrompt((await codePromptText(page)) ?? "confirmation code");
      const here = await waitForScreen(page,
        [S.passwordForm, S.checkpoint, S.reauth, S.saveLogin, S.continueGate, S.accountChooser, S.hubChangePassword, S.accountHub, S.loggedOut],
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
      if (here === S.accountChooser) { await pickAccount(page); continue; }
      await here.loc.first().click();
    }
    log.error("UNKNOWN: 10 steps and no password form");
    return 1;
  } finally {
    await context.close();
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
  const { context, page, url } = await openRowBrowser(args);
  try {
    const pick = resolveRow(argValues(args, "--xlsx")[0], Number(argValue(args, ["--row"]) ?? "1"));
    log.info(`Filling the form with a throwaway password (${newPw.length} chars). Nothing will be submitted.`);
    const r = await changePassword({ context, currentPw, newPw, targetUrl: url, dryRun: true });
    log.info(`row ${pick.row} / fp ${fingerprint(pick.cookie)}`);
    return r.ok ? 0 : 1;
  } finally {
    await context.close();
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
  const { context, page } = await openRowBrowser(args);
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
    await context.close();
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
        [S.passwordForm, S.checkpoint, S.reauth, S.saveLogin, S.continueGate, S.accountChooser, S.hubChangePassword, S.accountHub, S.loggedOut],
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
    await probe.context.close();
  }
}

// ---- Batch / group ----let curFp = "", curXlsx, curRow = 0;
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
      queue.push({ file, row: a.row });
    }
  }
  if (!queue.length) {
    if (files.length && readErrors === files.length) { log.error("no sheets could be read"); return 1; }
    log.success("nothing left to do - every row is sent or skipped"); return 0;
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
    let startReplies = [];
    let creds = { firstName: null, lastName: null, password: null };
    for (;;) {
      startReplies = await tg.freshSince(beforeStart, 6);
      creds = parseCreds(startReplies);
      if (creds.password) break;
      if (Date.now() >= deadline) break;
      await sleep(250);
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
          if (!keyReplies.some((r) => /cookie/i.test(r))) throw new Bail("expected a cookie prompt after the 2FA key");
          const cookieReplies = await tg.sendRaw("send cookie", pick.cookie.trim());
          if (!cookieReplies.some((r) => /confirm registration/i.test(r))) throw new Bail("no confirmation prompt after the cookie");
          const final = await tg.press("confirm registration", "Account registered");
          if (final.some((r) => /report has been received/i.test(r))) {
            markSent({ fp, source: job.file, row: pick.row, job: JOB });
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
        if (!keyReplies.some((r) => /cookie/i.test(r))) throw new Bail("expected a cookie prompt after the 2FA key, got something else");
        const cookieReplies = await tg.sendRaw("send cookie", pick.cookie.trim());
        if (!cookieReplies.some((r) => /confirm registration/i.test(r))) throw new Bail("no confirmation prompt after the cookie");
        const final = await tg.press("confirm registration", "Account registered");
        if (final.some((r) => /report has been received/i.test(r))) {
          markSent({ fp, source: job.file, row: pick.row, job: JOB });
          audit({ leg: "internal", what: "job", status: "received", fp });
          log.success(`Recorded in sent.jsonl (fp ${fp})`);
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
  bun index.js --check-pw --hold --xlsx a.xlsx --row 5 -o <curPw>   # on an unknown screen: dump it and keep the browser open
  bun index.js --codegen --xlsx a.xlsx --row 5         # open browser with that row's cookie, pause for inspector
  bun index.js --codegen --detect --xlsx a.xlsx --row 5   # walk to the form and report what was identified, type nothing
  bun index.js --check-pw --xlsx a.xlsx --row 5 -o <curPw>   # fill the form, prove the button enables, do NOT submit
  bun index.js --refresh-cookie --xlsx a.xlsx --row 5 -o <curPw>          # log in once, retest the new cookie, compare
  bun index.js --refresh-cookie --xlsx a.xlsx --row 5 -o <curPw> --write-back   # ...and save it if it is trusted
Flags: --xlsx (repeatable/comma/space), --row, --rows f#r,.. (internal), --all,
  -p/--phone, -o/--current-password, -P/--password, --fa2, --per-session N,
  --plan, --force, --dry-run/--probe, --codegen, --detect, --check-pw,
  --refresh-cookie, --write-back, --hold, --selftest, --login, --help
Rule: one bot password covers max ${MAX_REUSE} cookies and retires after 1 success.`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) { printHelp(); return; }
  if (args.includes("--selftest")) { process.exit((await selftest()) ? 1 : 0); }
  if (args.includes("--login")) {
    const p = argValue(args, ["--login"]) ?? argValue(args, ["--phone", "-p"]);
    const t = await Taskly.open({ phone: p });
    tlog.ok("Login OK");
    await t.close();
    return;
  }
  const phone = argValue(args, ["--phone", "-p"]) ?? process.env.TG_PHONE;
  if (args.includes("--codegen") || args.includes("--check-pw") || args.includes("--refresh-cookie")) {
    HOLD = args.includes("--hold");
    try {
      if (args.includes("--refresh-cookie")) process.exit(await runRefreshCookie(args));
      if (args.includes("--check-pw")) process.exit(await runCheckPw(args));
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
