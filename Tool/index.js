import { chromium } from "playwright";
import { config } from "dotenv";
import path from "path";
import fs from "node:fs";
import os from "node:os";
import { createHash } from "node:crypto";
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

// ---- Log ----
export const log = {
  info: (m) => console.log(chalk.blue("INFO"), chalk.white(m)),
  success: (m) => console.log(chalk.green("SUCCESS"), chalk.white(m)),
  error: (m) => console.log(chalk.red("ERROR"), chalk.white(m)),
  warn: (m) => console.log(chalk.yellow("WARN"), chalk.white(m)),
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

// ---- Facebook screens ----
function accountSheet(page) {
  return page.getByRole("dialog").filter({ hasText: /choose an account|continue as/i }).first();
}
const screens = (page) => ({
  accountChooser: { name: "account chooser sheet", loc: accountSheet(page) },
  accountHub: { name: "account hub (profile picker)", loc: page.getByRole("button", { name: /Profile picture,/ }).first() },
  hubChangePassword: { name: "hub tile 'Change password'", loc: page.getByText("Change password", { exact: true }).first() },
  passwordForm: { name: "password change form", loc: page.getByRole("textbox", { name: "Current password" }) },
  loggedOut: { name: "LOGGED OUT / login screen", loc: page.getByText(/Log into Facebook|Email or phone number|Passcode or password/i).first() },
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
    if (await d.getByRole("textbox", { name: "Current password" }).first().isVisible({ timeout: 400 }).catch(() => false)) continue;
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
  for (const [label, loc] of candidates) {
    try {
      if (await loc.first().isVisible({ timeout: 500 })) {
        const who = (await loc.first().innerText({ timeout: 1000 })).trim();
        await loc.first().click({ timeout: 5000 });
        log.success(`Picked account "${who}" via ${label}`);
        return;
      }
    } catch { /* next candidate */ }
  }
  if (await codePromptVisible(page)) await bailCodePrompt((await codePromptText(page)) ?? "confirmation code");
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
    await sleep(POLL_MS);
  }
  return null;
}
async function awaitCheckpoint(page, minutes = 10) {
  log.warn("Facebook wants identity confirmation. Finish it in the browser window.");
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

export async function changePassword({ context, currentPw, newPw, targetUrl }) {
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto("https://www.facebook.com/", { waitUntil: "load" });
  log.success("Established session on https://www.facebook.com/");
  await page.goto(targetUrl, { waitUntil: "load" });
  log.success(`Opened ${targetUrl}`);
  const S = screens(page);
  let picked = false;
  let reachedForm = false;
  for (let step = 1; step <= 6; step++) {
    if (await codePromptVisible(page)) await bailCodePrompt((await codePromptText(page)) ?? "confirmation code");
    const here = await waitForScreen(page,
      [S.passwordForm, S.checkpoint, S.accountChooser, S.hubChangePassword, S.accountHub, S.loggedOut],
      "the password form", 30_000);
    if (here === S.passwordForm) {
      if (!(await blockingDialog(page))) { reachedForm = true; break; }
      log.warn("A dialog is open over the password form — waiting for it to clear");
      await sleep(POLL_MS);
      continue;
    }
    if (here === S.loggedOut) await bail(page, "Session is logged out — the cookie is dead");
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
        if (formReady) break;
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
  const current = page.getByRole("textbox", { name: "Current password" });
  const next = page.getByRole("textbox", { name: "New password", exact: true });
  const retype = page.getByRole("textbox", { name: "Retype new password" });
  if (newPw === currentPw) await bail(page, "New password is identical to the current one — Facebook disables the button");
  await typeClean(page, current, currentPw, "Current password");
  await typeClean(page, next, newPw, "New password");
  await typeClean(page, retype, newPw, "Retype new password");
  const show = page.getByRole("button", { name: "Show password" });
  await tryClick(show.nth(2), "Show password #3");
  await tryClick(show.nth(1), "Show password #2");
  await tryClick(show.first(), "Show password #1");
  const submit = page.getByRole("button", { name: "Change password" }).first();
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && !(await isEnabled(submit))) await page.waitForTimeout(POLL_MS);
  if (!(await isEnabled(submit))) {
    const hints = await validationHints(page);
    await bail(page, "Change password button stayed disabled. " + (hints.length ? `Page says: ${hints.join(" | ")}` : "No error text found."));
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
async function changeFacebook(currentPw, newPw, url, cookieString) {
  const context = await chromium.launchPersistentContext(path.join(__dirname, "profile"), {
    ...DEVICES_PHONE,
    locale: "en-US",
    headless: false,
    channel: "chrome",
    args: ["--disable-blink-features=AutomationControlled"],
  });
  try {
    await context.clearCookies();
    await context.addCookies(parseCookies(cookieString.trim(), process.env.COOKIE_DOMAIN ?? new URL(url).hostname));
    log.success("Cookies loaded");
    return await changePassword({ context, currentPw, newPw, targetUrl: url });
  } finally {
    await context.close();
  }
}

// ---- Codegen (manual browser with one row's cookie, no Telegram) ----
async function runCodegen(args) {
  const sheets = argValues(args, "--xlsx");
  if (!sheets.length) throw new Bail("usage: bun index.js --codegen --xlsx <sheet> [--row N]");
  const row = Number(argValue(args, ["--row"]) ?? "1");
  const pick = resolveRow(sheets[0], row);
  const url = resolveUrl();
  const context = await chromium.launchPersistentContext(path.join(__dirname, "profile"), {
    ...DEVICES_PHONE,
    locale: "en-US",
    headless: false,
    channel: "chrome",
    args: ["--disable-blink-features=AutomationControlled"],
  });
  try {
    await context.clearCookies();
    await context.addCookies(parseCookies(pick.cookie.trim(), process.env.COOKIE_DOMAIN ?? new URL(url).hostname));
    log.success(`${path.basename(sheets[0])}: row ${pick.row} (fp ${fingerprint(pick.cookie)})`);
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto("https://www.facebook.com/", { waitUntil: "load" });
    await page.goto(url, { waitUntil: "load" });
    log.success(`Opened ${url} - inspect, then close the window`);
    await page.pause();
  } finally {
    await context.close();
  }
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
  bun index.js --codegen --xlsx a.xlsx --row 5         # open browser with that row's cookie, pause for inspector
Flags: --xlsx (repeatable/comma/space), --row, --rows f#r,.. (internal), --all,
  -p/--phone, -o/--current-password, -P/--password, --fa2, --per-session N,
  --plan, --force, --dry-run/--probe, --codegen, --login, --help
Rule: one bot password covers max ${MAX_REUSE} cookies and retires after 1 success.`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) { printHelp(); return; }
  if (args.includes("--login")) {
    const p = argValue(args, ["--login"]) ?? argValue(args, ["--phone", "-p"]);
    const t = await Taskly.open({ phone: p });
    tlog.ok("Login OK");
    await t.close();
    return;
  }
  const phone = argValue(args, ["--phone", "-p"]) ?? process.env.TG_PHONE;
  if (args.includes("--codegen")) {
    try { await runCodegen(args); return; }
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
