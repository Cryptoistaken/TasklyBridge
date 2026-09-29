import {
  chromium,
  type BrowserContext,
  type Frame,
  type Locator,
  type Page,
} from "playwright";
import * as XLSX from "xlsx";
import { config } from "dotenv";
import { fingerprint } from "./sent.ts";
import chalk from "chalk";
import path from "path";
import fs from "node:fs";
import os from "os";
import { fileURLToPath } from "url";

config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Hardcoded current password — edit here or override in the --html form.
const HARDCODED_CURRENT = "dgddigital";

// Same devices as codegen.js — phone is the default, pass -d for desktop.
export const DEVICES_PHONE = {
  userAgent:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
};

const DEVICES = {
  desktop: {
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
  },
  phone: {
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  },
};

export const log = {
  info: (msg: string) => console.log(chalk.blue("INFO"), chalk.white(msg)),
  success: (msg: string) => console.log(chalk.green("SUCCESS"), chalk.white(msg)),
  error: (msg: string) => console.log(chalk.red("ERROR"), chalk.white(msg)),
  warn: (msg: string) => console.log(chalk.yellow("WARN"), chalk.white(msg)),
};

const POLL_MS = 500; // checked twice a second, never a blind sleep
const WAIT_MS = 60_000; // how long a screen may take to show up

const T0 = Date.now();
export const elapsed = () => {
  const s = (Date.now() - T0) / 1000;
  return `${s.toFixed(1)}s`;
};
const stamp = (msg: string) => log.info(`[${elapsed()}] ${msg}`);

/** Thrown to stop the run. `Bail` is silent (caller logs it). */
export class Bail extends Error {}
/** Thrown after bail() already printed the reason + screenshot. */
export class BailLogged extends Bail {}

/**
 * Thrown when Facebook demands an SMS code to a phone we do not have.
 *
 * Its own TYPE, not just its message, because this is what marks an account
 * permanently un-runnable. submit.ts records the skip by catching this class;
 * it used to match on the text "/sms confirmation code/i" instead, so rewording
 * the log line would have silently stopped every gate from being recorded - and
 * each of those accounts costs $0.05 and a bot credential to rediscover, on
 * every run, forever.
 */
export class BailGated extends BailLogged {}

export function parseCookies(cookieString: string, domain: string) {
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

// ── Pre-flight cookie gate ─────────────────────────────────────────────────
//
// One HTTP request to the same accountscenter endpoint SheetSubmit's
// pageSimple() uses, BEFORE a browser is launched and before Telegram is
// contacted. A dead cookie is otherwise only discovered after $0.05 and a bot
// credential have already been spent.
//
// The verdict is NOT trusted on its own. Measured 2026-09-29: the same three
// cookies read DEAD on one run and ALIVE minutes later (row 1 named Karina
// Heinz and had already been submitted successfully), so a single DEAD is a
// transient - rate limiting or a session hiccup - not a verdict. A DEAD is
// therefore confirmed with a second request before anything is skipped, and
// only a confirmed DEAD is fatal. UNKNOWN never skips: the account is simply
// left to the browser flow, which is the ground truth.
const PROBE_URL = "https://accountscenter.facebook.com/profiles";
const PROBE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";

type ProbeVerdict = "ALIVE" | "DEAD" | "UNKNOWN";

async function probeOnce(cookie: string): Promise<ProbeVerdict> {
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
    // A block page is not the same as a dead cookie.
    if (/temporarily blocked|security check|unusual activity|too many requests/i.test(html)) {
      return "UNKNOWN";
    }
    // A live session carries the account's own identity; a login wall has
    // user_id:"" and no name, phone, or echoed c_user.
    const cUser = cookie.match(/c_user=(\d+)/)?.[1];
    const identified =
      /"full_name"\s*:\s*"[^"]+"/.test(html) ||
      /"navigation_row_subtitle"\s*:\s*"\+?\d/.test(html) ||
      (!!cUser && html.includes(cUser));
    return identified ? "ALIVE" : "DEAD";
  } catch {
    // Network trouble is not evidence of anything.
    return "UNKNOWN";
  }
}

/**
 * True only when the cookie is dead beyond doubt. Two agreeing DEAD results
 * with a pause between them; anything else lets the run continue.
 */
export async function isCookieDead(cookie: string): Promise<boolean> {
  const first = await probeOnce(cookie);
  if (first !== "DEAD") return false;
  log.info("Cookie probe says DEAD - confirming before skipping (a single DEAD can be transient)");
  await new Promise((r) => setTimeout(r, 3000));
  return (await probeOnce(cookie)) === "DEAD";
}

// Screens we know how to tell apart, so we never blind-click.
type Screen = { name: string; loc: Locator };

// The account chooser sheet, found by what it says rather than by being a
// dialog. Facebook keeps several dialogs in the DOM and .first() lands on an
// empty one often enough to break picking outright.
function accountSheet(page: Page): Locator {
  return page
    .getByRole("dialog")
    .filter({ hasText: /choose an account|continue as/i })
    .first();
}

const screens = (page: Page) => ({
  // The account picker sheet. Anchored on its own wording - "Choose an account
  // to make changes." / "Continue as" - NOT on getByRole("dialog").first().
  //
  // A bare .first() was matching a different, EMPTY dialog: the screen plainly
  // showed "Devin Scott / Facebook" while the log said the sheet was "(empty)"
  // and no account row could be found. Facebook keeps more than one dialog in
  // the DOM, so which one .first() lands on is not stable - which is why
  // picking sometimes worked and sometimes did not.
  accountChooser: {
    name: "account chooser sheet",
    loc: accountSheet(page),
  },
  // The profile menu button (name differs per account, so match the prefix).
  accountHub: {
    name: "account hub (profile picker)",
    loc: page.getByRole("button", { name: /Profile picture,/ }).first(),
  },
  // The hub's own "Change password" tile. Some accounts land on the hub
  // instead of the form, and this is the step that was missing.
  hubChangePassword: {
    name: "hub tile 'Change password'",
    loc: page.getByText("Change password", { exact: true }).first(),
  },
  passwordForm: {
    name: "password change form",
    loc: page.getByRole("textbox", { name: "Current password" }),
  },
  loggedOut: {
    name: "LOGGED OUT / login screen",
    loc: page
      .getByText(/Log into Facebook|Email or phone number|Passcode or password/i)
      .first(),
  },
  // MUST be scoped to a dialog. The hub page carries the static help text
  // "How we confirm that it's you / Choose how you confirm your identity for
  // secure login", and matching that on the page claimed a checkpoint that
  // does not exist - the script reported a block the user could not see.
  checkpoint: {
    name: "identity checkpoint dialog",
    loc: page
      .getByRole("dialog")
      .getByText(/confirm your identity|it's you|enter your password to confirm/i)
      .first(),
  },
  // Facebook sent a 6-digit code to a phone number and will not proceed without
  // it. Observed 2026-09-29: "Devin Scott - Facebook / Enter confirmation code /
  // We've sent a confirmation code to +216 ******95". It appears as soon as the
  // account is picked, and then lingers, so it must be ruled out on every pass
  // of the walk loop - see codePromptText() and its check at the top of the loop.
  // The session is ALIVE, so this is not a dead cookie.
});

// Clicks the account row inside the sheet. The row is labelled inconsistently:
// one account showed "Hani Cahyono / Facebook", another only "Cantika
// Setiawan". So try the "Facebook" sub-label, then a two-word capitalised name,
// and print the sheet's text if neither is there.
async function pickAccount(page: Page) {
  const sheet = accountSheet(page);
  const candidates: [string, Locator][] = [
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
    } catch {
      /* try the next candidate */
    }
  }
  const text = await sheet
    .innerText({ timeout: 2000 })
    .then((t) => t.replace(/\s+/g, " ").trim().slice(0, 200))
    .catch(() => "");
  // An empty or unrecognised sheet is what a code prompt looks like from here,
  // since both are dialogs. Rule it out before reporting a missing account row.
  if (await codePromptVisible(page)) {
    await bailCodePrompt((await codePromptText(page)) ?? "confirmation code");
  }
  log.error(`Could not find the account row in the sheet. Sheet says: ${text || "(empty)"}`);
}

// One place that reports an SMS gate, so every path that can hit one says the
// same thing. Leaves no browser open: nothing about this prompt can be finished
// by the operator, and a stray window per gated account would bury a long run.
async function bailCodePrompt(prompt: string): Promise<never> {
  log.error(
    `Facebook wants an SMS code (${prompt}). The cookie is VALID - this account is gated, not dead.`,
  );
  log.error("Skipping - no retry or replacement cookie can clear it; only that phone can.");
  // Carries `gated:` so the reason reads the same in skipped.jsonl, and is a
  // BailGated so submit.ts records the skip by type rather than by wording.
  throw new BailGated(`gated: Facebook requires an SMS confirmation code (${prompt})`);
}

/**
 * Wording Facebook uses on the SMS / authenticity gate.
 *
 * Observed 2026-09-29 on accountscenter.facebook.com, in a dialog headed
 * "Devin Scott - Facebook": "Authenticity verification / Enter confirmation
 * code / We've sent a confirmation code to +216 ******95." with an input
 * placeholder "Confirmation code" and a "We can send a new code in 00:48"
 * countdown.
 *
 * No apostrophes in the strong patterns: Facebook renders a curly one, which a
 * typed ' will not match.
 */
const CODE_PROMPT_STRONG = [
  /enter\s+(the\s+)?(confirmation|verification|security)?\s*code/i,
  /sent\s+(a\s+)?(confirmation|verification|security)?\s*code\s+to/i,
  /we\s+can\s+send\s+a\s+new\s+code/i,
  /confirmation\s+code\s+to\s*\+?[\d*]/i,
];

// Only trustworthy INSIDE a dialog. The hub page carries "Authenticity
// verification" as static help text with no prompt on screen, so matching this
// on the page at large would gate accounts that are perfectly fine - the same
// mistake the checkpoint matcher already documents.
const CODE_PROMPT_WEAK = [/authenticity\s+verification/i];

const CODE_PROMPT_LOCATORS = [
  (s: Page | Frame) => s.getByRole("textbox", { name: /confirmation code|security code|verification code/i }),
  (s: Page | Frame) => s.getByPlaceholder(/confirmation code|security code|verification code|enter.*code/i),
  (s: Page | Frame) => s.getByText(/enter (the )?(confirmation |verification |security )?code/i),
  (s: Page | Frame) => s.getByText(/we can send a new code in/i),
  (s: Page | Frame) => s.getByText(/sent (a )?(confirmation |verification |security )?code to/i),
];

/**
 * The page plus every frame.
 *
 * The gate renders inside an Accounts Center iframe, so page-level locators
 * cannot see it at all. InspectPrompt.ts already had to sweep frames to find
 * this prompt, which is the evidence that the frame scope is required.
 */
const scopes = (page: Page): (Page | Frame)[] => [
  page,
  ...page.frames().filter((f) => f !== page.mainFrame()),
];

/**
 * Is the SMS code prompt showing?
 *
 * Four layers, weakest last, because the earlier version had two locators and
 * the prompt still went unseen:
 *
 *   1. Locators, tried SEPARATELY. An earlier .or() chain resolved to several
 *      elements, isVisible() threw a strict-mode violation, and the .catch()
 *      around it turned that throw into a false "not visible" - a working
 *      detector reporting nothing while the prompt sat on screen. No .or() here.
 *      Widened from the two originals, and matched on PLACEHOLDER as well as
 *      accessible name, so a rewording or a missing label cannot silence it.
 *   2. Every frame, not just the page. This is what actually failed, and it is
 *      verified: replaying the live markup in the main frame, the two original
 *      locators both matched. Replayed inside an iframe - where Accounts Center
 *      really renders this dialog - the same two locators returned false while
 *      the prompt was plainly on screen. Page-level locators do not cross frame
 *      boundaries. InspectPrompt.ts had to sweep frames to find this prompt,
 *      which was the first hint that the frame scope was required.
 *   3. Rendered text, so a rename of the heading or the field cannot hide it.
 *
 * A throw is never read as "absent" - we keep looking.
 */
export async function codePromptVisible(page: Page): Promise<boolean> {
  for (const s of scopes(page)) {
    for (const make of CODE_PROMPT_LOCATORS) {
      try {
        if (await make(s).first().isVisible({ timeout: 400 })) return true;
      } catch {
        // Keep trying the next one.
      }
    }

    let text = "";
    try {
      text = await s.locator("body").innerText({ timeout: 1500 });
    } catch {
      continue; // frame detached mid-poll
    }
    if (!text) continue;
    if (CODE_PROMPT_STRONG.some((re) => re.test(text))) return true;
    try {
      for (let i = 0; i < Math.min(await s.getByRole("dialog").count().catch(() => 0), 6); i++) {
        const d = await s.getByRole("dialog").nth(i).innerText({ timeout: 800 }).catch(() => "");
        if (d && CODE_PROMPT_WEAK.some((re) => re.test(d))) return true;
      }
    } catch {
      /* dialog list raced a re-render */
    }
  }
  return false;
}

/**
 * Text of the SMS code prompt, or null if it is not showing.
 *
 * Prefers the sentence carrying the phone number, so the skip record says which
 * number Facebook wants. Falls back to the heading.
 */
async function codePromptText(page: Page): Promise<string | null> {
  for (const s of scopes(page)) {
    const text = await s
      .locator("body")
      .innerText({ timeout: 2000 })
      .then((t) => t.replace(/\s+/g, " "))
      .catch(() => "");
    if (!text) continue;
    const phone = text.match(
      /((confirmation|verification|security)\s+code\s+to\s*\+?[\d\s*]{6,}|we\s+can\s+send\s+a\s+new\s+code\s+in\s*\d+:\d+)/i,
    );
    if (phone) return phone[1].replace(/\s+/g, " ").trim();
    const heading = text.match(
      /(enter\s+(the\s+)?(confirmation|verification|security)?\s*code)/i,
    );
    if (heading) return heading[1].replace(/\s+/g, " ").trim();
  }
  return null;
}

/**
 * Is a dialog open that is NOT the account chooser sheet and NOT the form?
 *
 * This is the guard the walk loop was missing. isVisible() ignores occlusion, so
 * with the gate dialog on top, the "Current password" field behind it still
 * reports visible - the loop declared the form ready, walked off the end of its
 * six steps, and then died on `inputValue: Timeout 30000ms exceeded` against a
 * field nobody could reach.
 *
 * Two exclusions, both learned the hard way on 2026-09-29:
 *
 *   - The chooser sheet lingers in the DOM after a pick. It is the one dialog we
 *     are allowed to have.
 *   - The PASSWORD FORM ITSELF is wrapped in role="dialog". Observed markup for
 *     a perfectly healthy account: the only dialog on the page is
 *     "Change password / Cantika Setiawan / Current password / New password /
 *     Retype new password". Counting that as blocking meant formReady could
 *     never be set, so a working form was reported as "no form yet" and the row
 *     was skipped. A dialog that CONTAINS the form is the form, not a blocker.
 */
export async function blockingDialog(page: Page): Promise<boolean> {
  const dialogs = page.getByRole("dialog");
  const n = await dialogs.count().catch(() => 0);
  for (let i = 0; i < n; i++) {
    const d = dialogs.nth(i);
    if (!(await d.isVisible({ timeout: 300 }).catch(() => false))) continue;
    const text = await d
      .innerText({ timeout: 500 })
      .then((t) => t.replace(/\s+/g, " "))
      .catch(() => "");
    if (/choose an account|continue as/i.test(text)) continue; // our own sheet
    // The form's own container. Not a blocker - it IS the form.
    //
    // Matched the way the form itself is matched (accessible name, not
    // aria-label): the real inputs carry NO aria-label attribute - their name
    // comes from a wrapping <label> - so an attribute selector finds nothing
    // and every healthy account reads as blocked.
    if (
      await d
        .getByRole("textbox", { name: "Current password" })
        .first()
        .isVisible({ timeout: 400 })
        .catch(() => false)
    ) {
      continue;
    }
    return true;
  }
  return false;
}

// Set CODEGEN=1 to stop at the first stuck screen, dump everything useful
// about the page, and hold the browser open with the Playwright Inspector.
// Reading logs was not enough to settle what Facebook actually renders here.
//
// NOT a batch mode. page.pause() blocks until a human closes the Inspector, so
// leaving this on freezes a whole run on the first odd screen - observed
// 2026-09-29: a 42-account batch sat on one account for the entire session with
// a perfectly usable password form on screen, and the operator had no idea the
// script was waiting on them. Batch runs set CODEGEN_HOLD_ALLOWED to opt in;
// single-row debugging does not need to.
const INSPECT = !!process.env.CODEGEN;
const INSPECT_ALLOWED = !!process.env.CODEGEN_HOLD_ALLOWED;

/** May this run actually block on the Inspector? */
export function inspectAllowed(): boolean {
  return INSPECT && INSPECT_ALLOWED;
}

/**
 * Print what is on screen and hand control to the Inspector.
 *
 * Writes the dialog markup to out/codegen-<ts>.html as well, so the structure
 * can be read afterwards without transcribing it by hand. Never returns under
 * normal use - page.pause() blocks until the operator resumes, and resuming
 * still ends the account rather than continuing a flow we do not understand.
 */
async function dumpAndHold(page: Page, why: string): Promise<never> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const clean = (s: string) => s.replace(/\s+/g, " ").trim();
  const url = page.url();
  const body = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
  const dialogs = page.getByRole("dialog");
  const n = await dialogs.count().catch(() => 0);

  log.warn(`CODEGEN: stuck at "${why}" - dumping the page and holding the browser open`);
  log.info(`url: ${url}`);
  log.info(`body.innerText (${body.length} chars): ${clean(body).slice(0, 1200) || "(empty)"}`);
  log.info(`dialog count: ${n}`);

  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    const d = dialogs.nth(i);
    const text = clean(await d.innerText({ timeout: 2000 }).catch(() => ""));
    const html = await d.evaluate((el) => el.outerHTML).catch(() => "");
    log.info(`  dialog[${i}] text: ${text.slice(0, 300) || "(empty)"}`);
    parts.push(`<!-- dialog[${i}] text: ${text.slice(0, 300)} -->\n${html}`);
  }

  // Which known screens are present, and what they say. This is the fact that
  // settles "is the prompt here at all".
  const S = screens(page);
  for (const key of ["passwordForm", "accountChooser", "checkpoint", "loggedOut"] as const) {
    const visible = await S[key].loc
      .first()
      .isVisible({ timeout: 400 })
      .catch(() => false);
    log.info(`  screen ${key}: ${visible ? "VISIBLE" : "no"}`);
  }

  try {
    fs.mkdirSync(path.join(__dirname, "out"), { recursive: true });
    const file = path.join(__dirname, "out", `codegen-${stamp}.html`);
    fs.writeFileSync(
      file,
      `<!-- url: ${url} -->\n<!-- body: ${clean(body).slice(0, 2000)} -->\n${parts.join("\n\n")}\n`,
      "utf8",
    );
    log.info(`dialog markup written to ${file}`);
  } catch {
    /* the dump is a convenience; never fail the run over it */
  }

  // A batch must never block here. page.pause() waits for a human who may not
  // be watching, and the run silently stops: on 2026-09-29 a 42-account batch
  // sat on ONE account for a whole session, on a screen where the password form
  // was up and usable, and nothing in the log said the script was waiting.
  if (!inspectAllowed()) {
    log.warn(
      `CODEGEN is set but this is a batch run, so the Inspector will NOT be opened.`,
    );
    log.warn(`Everything needed is above and in ${path.join(__dirname, "out")} - reading the log is enough.`);
    log.warn(`Set CODEGEN_HOLD_ALLOWED=1 too if you really want to stop and look.`);
    throw new BailLogged(`CODEGEN: would have held the Inspector at "${why}" (batch run, not holding)`);
  }

  log.info("Pick an element in the Inspector and copy its locator. Ctrl+C to exit.");
  await page.pause();
  throw new BailLogged(`CODEGEN: released while stuck at "${why}"`);
}

// Polls every 500ms until one of `screens` shows up. Null = none appeared.
async function waitForScreen(
  page: Page,
  screens: Screen[],
  what: string,
  ms = WAIT_MS,
): Promise<Screen | null> {
  const deadline = Date.now() + ms;
  let lastUrl = "";
  while (Date.now() < deadline) {
    if (page.isClosed()) throw new BailLogged(`Browser closed while waiting for ${what}`);
    for (const s of screens) {
      try {
        if (await s.loc.first().isVisible({ timeout: 250 })) {
          log.success(`[${elapsed()}] Detected: ${s.name}`);
          return s;
        }
      } catch {
        /* page still loading — poll again */
      }
    }
    if (page.url() !== lastUrl) {
      lastUrl = page.url();
      stamp(`Waiting for ${what}… (${lastUrl})`);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  return null;
}

// A checkpoint needs a human. Bailing here just closed the browser and hid
// the screen, which is useless: the window stays open, the operator finishes
// the confirmation, and the flow carries on once the form appears.
async function awaitCheckpoint(page: Page, minutes = 10): Promise<Screen> {
  log.warn("Facebook wants identity confirmation for this account.");
  log.warn(`Finish it in the browser window. This script continues in ${minutes} min.`);
  const deadline = Date.now() + minutes * 60_000;
  while (Date.now() < deadline) {
    if (page.isClosed()) throw new BailLogged("Browser closed during the checkpoint");
    const form = await screens(page)
      .passwordForm.loc.first()
      .isVisible({ timeout: 500 })
      .catch(() => false);
    if (form) {
      log.success("Checkpoint cleared - password form is up");
      return screens(page).passwordForm;
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  await bail(page, "Checkpoint was not cleared in time");
}

// Fast, silent bail for a known-permanent block. Unlike bail() this takes no
// screenshot and leaves no browser open: an SMS gate cannot be cleared by
// anyone, so there is nothing for the operator to look at or finish, and
// leaving a window per gated account would bury the run in orphan browsers.
function skipFast(reason: string): never {
  throw new BailLogged(reason);
}

// Screenshot + page text to the temp dir, then give up. Never guess.
async function bail(page: Page, reason: string): Promise<never> {
  const dir = path.join(os.tmpdir(), "opencode");
  const file = path.join(
    dir,
    `pc-fail-${new Date().toISOString().replace(/[:.]/g, "-")}.png`,
  );
  let text = "";
  try {
    text = (await page.locator("body").innerText({ timeout: 5000 }))
      .replace(/\s+/g, " ")
      .slice(0, 400);
  } catch {
    /* page may be closed */
  }
  log.error(reason);
  log.error(`Page text: ${text || "(unavailable)"}`);
  try {
    await page.screenshot({ path: file, fullPage: true });
    log.error(`Screenshot: ${file}`);
  } catch {
    log.error("Screenshot failed (page closed?)");
  }
  throw new BailLogged(reason);
}

// Recorded reveal toggles are cosmetic; a layout change must not kill the run.
async function tryClick(loc: Locator, label: string) {
  try {
    await loc.click({ timeout: 2000 });
  } catch {
    log.warn(`Skipped optional click: ${label}`);
  }
}

// Facebook disables its submit button (aria-disabled) instead of showing an
// error, so surface the hint text it left on the page.
async function validationHints(page: Page): Promise<string[]> {
  const hints = page.getByText(
    /must be different|do not match|at least \d+ characters|incorrect|wrong|required|try again/i,
  );
  const out = new Set<string>();
  const total = Math.min(await hints.count().catch(() => 0), 8);
  for (let i = 0; i < total; i++) {
    const t = (await hints.nth(i).innerText().catch(() => ""))
      .replace(/\s+/g, " ")
      .trim();
    if (t) out.add(t);
  }
  return [...out];
}

const isEnabled = (loc: Locator) =>
  loc
    .evaluate((el: any) => el.getAttribute("aria-disabled") !== "true" && !el.disabled)
    .catch(() => false);

// Chrome autofill retypes saved passwords over fill(), so clear the field, type
// key by key, then read it back. Mismatch = bail with a screenshot.
// NOTE: no Escape key here — it closes the Accounts Center sheet and takes the
// page down with it.
async function typeClean(page: Page, loc: Locator, value: string, label: string) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (page.isClosed()) await bail(page, `Page closed while filling ${label}`);
    // Facebook can drop the gate dialog on top of the form between one field and
    // the next. Playwright's own 30s timeouts say nothing about what is on
    // screen, so name the real cause before touching the field.
    if (await codePromptVisible(page)) {
      await bailCodePrompt((await codePromptText(page)) ?? "confirmation code");
    }
    try {
      await loc.click({ timeout: 5000 });
    } catch {
      if (await codePromptVisible(page)) {
        await bailCodePrompt((await codePromptText(page)) ?? "confirmation code");
      }
      await bail(page, `${label} could not be clicked - something is covering the form`);
    }
    await loc.fill("");
    await loc.pressSequentially(value, { delay: 20 });
    await page.waitForTimeout(POLL_MS); // let autofill settle before checking
    let got = ""; // bail() in the catch always throws, so this is belt and braces
    try {
      got = await loc.inputValue({ timeout: 5000 });
    } catch {
      // The field detaching mid-fill is the dialog swapping in, not a field bug.
      if (await codePromptVisible(page)) {
        await bailCodePrompt((await codePromptText(page)) ?? "confirmation code");
      }
      await bail(page, `${label} disappeared while it was being filled`);
    }
    if (got === value) {
      log.success(`${label} field set (${value.length} chars)`);
      return;
    }
    log.warn(`${label} field mismatch (attempt ${attempt}): got "${got}"`);
  }
  await bail(page, `${label} field would not accept the value (autofill fighting?)`);
}

// --new-password <v> | -n <v>   and   --current-password <v> | -o <v>
// Also accepts --flag=value.
export function argValue(args: string[], names: string[]): string | undefined {
  for (const a of args) {
    for (const n of names) {
      if (a.startsWith(n + "=")) return a.slice(n.length + 1);
    }
  }
  for (const n of names) {
    const i = args.indexOf(n);
    if (i !== -1 && args[i + 1] && !args[i + 1].startsWith("-")) return args[i + 1];
  }
  return undefined;
}

/** One account from the xlsx: a Facebook cookie and its 2FA key. */
export type Account = { row: number; cookie: string; fa2Key: string };

/**
 * Reads accounts from a 2-column, header-less xlsx: column A is the Facebook
 * cookie, column B is the 2FA key. One account per row.
 */
export function readAccounts(file: string): Account[] {
  const wb = XLSX.readFile(file);
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) throw new Bail(`${file} has no sheets`);
  const rows = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, raw: false });
  const out: Account[] = [];
  rows.forEach((r, i) => {
    const cookie = String(r?.[0] ?? "").trim();
    // Keys arrive either bare (YFL7IWY...) or grouped for readability
    // ("LO4E WXSP MGT4 ..."). The bot wants the bare 32-char secret, and
    // sending it with spaces is a different, invalid value.
    const fa2Key = String(r?.[1] ?? "").replace(/\s+/g, "");
    // Skip blank rows rather than failing the whole run on one empty line.
    if (cookie && fa2Key) out.push({ row: i + 1, cookie, fa2Key });
  });
  if (!out.length) throw new Bail(`${file} had no usable rows (need cookie + 2FA key)`);
  return out;
}

export type ChangeResult = { ok: boolean; verdict: string };

/**
 * Changes the Facebook account password from currentPw to newPw using the
 * browser in `context`, then watches the result banner.
 *
 * Reusable: submit.ts calls this with the password the provider bot hands us.
 * Throws Bail (already logged, with a screenshot) when the page is not in a
 * state the flow understands.
 */
export async function changePassword(opts: {
  context: BrowserContext;
  currentPw: string;
  newPw: string;
  targetUrl: string;
}): Promise<ChangeResult> {
  const { context, currentPw, newPw, targetUrl } = opts;
  const page = context.pages()[0] ?? (await context.newPage());

  // Same 2-step navigation as codegen.js: establish session, then target
  await page.goto("https://www.facebook.com/", { waitUntil: "load" });
  log.success("Established session on https://www.facebook.com/");
  await page.goto(targetUrl, { waitUntil: "load" });
  log.success(`Opened ${targetUrl}`);

  const S = screens(page);

  // Walk forward until the form is up. Each step may be skipped, so this loops
  // rather than assuming an order. It never exits on an unfamiliar screen: it
  // reports what is actually on the page and keeps looking, because bailing
  // closed the browser and hid the screen from the operator.
  let picked = false; // the sheet stays in the DOM after a pick, so only pick once
  let reachedForm = false; // guards the fall-through below
  for (let step = 1; step <= 6; step++) {
    // Ruled out FIRST, on every pass, before any screen is considered. The
    // prompt is a dialog like the account sheet, so whichever screen the poll
    // matches first, this catches it - no ordering to get wrong.
    if (await codePromptVisible(page)) {
      await bailCodePrompt((await codePromptText(page)) ?? "confirmation code");
    }

    const here = await waitForScreen(
      page,
      [
        S.passwordForm,
        S.checkpoint,
        S.accountChooser,
        S.hubChangePassword,
        S.accountHub,
        S.loggedOut,
      ],
      "the password form",
      30_000,
    );

    if (here === S.passwordForm) {
      // isVisible() ignores occlusion. With the SMS dialog sitting on top, the
      // "Current password" field behind it still reports visible, so "the form is
      // up" has to mean "the form is reachable". This is the 2026-09-29 failure:
      // the gate was open the whole time and the loop walked straight past it.
      if (!(await blockingDialog(page))) {
        reachedForm = true;
        break;
      }
      log.warn("A dialog is open over the password form — waiting for it to clear");
      await new Promise((r) => setTimeout(r, POLL_MS));
      continue;
    }

    if (here === S.loggedOut) await bail(page, "Session is logged out — the cookie is dead");

    if (here === S.checkpoint) {
      log.warn("A real identity-confirmation dialog is open (not the hub's help text).");
      await awaitCheckpoint(page);
      reachedForm = true;
      break;
    }

    if (here === S.accountChooser) {
      if (picked) {
        // The sheet lingers after a pick, and waitForScreen returns instantly
        // while it is still there - so the old `continue` burned all six steps
        // in about 0.2s and then fell through to a 30s wait for a form it had
        // already stopped looking for. Observed: 6 iterations between 20.7s and
        // 20.9s, then "inputValue: Timeout 30000ms".
        //
        // So poll HERE, in place, for a real duration. Both things we are
        // waiting for can appear seconds after the pick: the password form, or
        // the SMS prompt. This is the read-every-500ms the screen needs.
        const giveUpAt = Date.now() + 30_000;
        let formReady = false;
        while (Date.now() < giveUpAt) {
          if (await codePromptVisible(page)) {
            await bailCodePrompt((await codePromptText(page)) ?? "confirmation code");
          }
          // Same occlusion trap as above: the form behind a dialog is not usable.
          const covered = await blockingDialog(page);
          if (!covered && (await S.passwordForm.loc.first().isVisible({ timeout: 400 }).catch(() => false))) {
            formReady = true;
            break;
          }
          await new Promise((r) => setTimeout(r, POLL_MS));
        }
        if (formReady) break;

        // The sheet is still up and neither the form nor a code prompt arrived.
        // Evidence from out/codegen-*.html on 2026-09-29: the sheet renders
        // "Choose an account to make changes. Devin Scott Facebook Loading..."
        // and stays there, with neither the password form nor the code prompt
        // anywhere in the DOM. So this is a page that never finished loading -
        // not a detection miss, and not something a retry of the same click
        // reliably fixes. Say so instead of timing out on a field that is not
        // there, which is what it used to do.
        //
        // "Loading" must be the WHOLE story, not a word somewhere on the page.
        // A bare /loading/i matched a healthy account whose page happened to
        // contain the word (its own "Loading..." control), and that row was
        // skipped as permanently stuck while its password form sat right there,
        // fully usable. Require the sheet to be nothing but the stuck state.
        const sheetText = await accountSheet(page)
          .innerText({ timeout: 2000 })
          .catch(() => "");
        const stuckSheet = /loading/i.test(sheetText) && !/current password/i.test(sheetText);
        if (stuckSheet) {
          log.error("Account sheet is stuck on 'Loading...' - Facebook never handed over to the form.");
          log.error("The cookie may authenticate but the account cannot be opened. Skipping this row.");
          // Also permanent, also must not be retried, so it carries the same type
          // the SMS gate does rather than a bare BailLogged.
          throw new BailGated("stuck: account sheet never left 'Loading...'");
        }
        if (INSPECT) await dumpAndHold(page, "account sheet stuck on Loading");
        log.info("Sheet still open after picking, no form yet — continuing");
        continue;
      }
      await pickAccount(page);
      picked = true;
      continue;
    }

    if (here === S.hubChangePassword) {
      log.info("On the hub — clicking its 'Change password' tile");
      await here.loc.first().click();
      continue;
    }

    if (here === S.accountHub) {
      log.info("Opening the profile menu");
      await here.loc.first().click();
      continue;
    }

    if (!here) {
      // Nothing recognised. Print the truth instead of guessing or exiting.
      const text = await page
        .locator("body")
        .innerText({ timeout: 5000 })
        .then((t) => t.replace(/\s+/g, " ").trim().slice(0, 500))
        .catch(() => "");
      log.error(`Step ${step}: no known screen after ${30_000}ms.`);
      log.error(`On screen: ${text || "(could not read)"}`);
      log.error("Leaving the browser open so you can look. Re-run to retry.");
      if (INSPECT) await dumpAndHold(page, `no known screen at step ${step}`);
      return { ok: false, verdict: text || "no known screen" };
    }
  }

  // The loop can run out of steps without ever reaching a usable form. It used
  // to fall straight through to typeClean(), which then burned 30s on
  // "inputValue: Timeout 30000ms exceeded" - an error naming a field, when the
  // screen that was actually there was something else entirely. Check the gate
  // one last time, then bail with a screenshot so the row is diagnosable and
  // the account is not silently retried forever.
  if (!reachedForm) {
    if (await codePromptVisible(page)) {
      await bailCodePrompt((await codePromptText(page)) ?? "confirmation code");
    }
    if (INSPECT) await dumpAndHold(page, "walk loop ended without a usable form");
    await bail(page, "Never reached a usable password form - see the screenshot");
  }

  const current = page.getByRole("textbox", { name: "Current password" });
  const next = page.getByRole("textbox", { name: "New password", exact: true });
  const retype = page.getByRole("textbox", { name: "Retype new password" });

  // Facebook silently disables submit when new === current. Catch it here.
  if (newPw === currentPw) {
    await bail(
      page,
      "New password is identical to the current one — Facebook disables the button",
    );
  }

  await typeClean(page, current, currentPw, "Current password");
  await typeClean(page, next, newPw, "New password");
  await typeClean(page, retype, newPw, "Retype new password");

  // Reveal toggles (from the recording) — cosmetic only.
  const show = page.getByRole("button", { name: "Show password" });
  await tryClick(show.nth(2), "Show password #3");
  await tryClick(show.nth(1), "Show password #2");
  await tryClick(
    page.locator("div").filter({ hasText: /^Current password$/ }).nth(3),
    "Current password label",
  );
  await tryClick(show.first(), "Show password #1");

  // Submit — the step the recording was missing. The button is a div with
  // aria-disabled, so wait for it to actually become clickable.
  const submit = page.getByRole("button", { name: "Change password" }).first();
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && !(await isEnabled(submit))) {
    await page.waitForTimeout(POLL_MS);
  }
  if (!(await isEnabled(submit))) {
    const hints = await validationHints(page);
    await bail(
      page,
      "Change password button stayed disabled. " +
        (hints.length ? `Page says: ${hints.join(" | ")}` : "No error text found."),
    );
  }
  const clickAt = elapsed();
  await submit.click();
  log.success("Clicked Change password — watching the screen for 10s");

  // Facebook confirms in a toast/live region at the END of the DOM, so read
  // those regions directly instead of truncating the whole page text.
  const WATCH_MS = 10_000;
  const watchUntil = Date.now() + WATCH_MS;
  const clean = (s: string) => s.replace(/\s+/g, " ").trim();
  let lastNotices = "";
  let verdict = "";

  while (Date.now() < watchUntil) {
    if (page.isClosed()) {
      log.warn("Page closed during watch — stopping early");
      break;
    }

    // 0. The code prompt can reappear at any point, including during the watch.
    if (await codePromptVisible(page)) {
      await bailCodePrompt((await codePromptText(page)) ?? "confirmation code");
    }

    // 1. The banner itself: aria-live / alert / toast regions.
    const notices = await page
      .locator('[role="alert"], [role="status"], [aria-live]:not([aria-live="off"])')
      .allInnerTexts()
      .then((list) => clean(list.join(" | ")))
      .catch(() => "");
    if (notices && notices !== lastNotices) {
      lastNotices = notices;
      log.info(`[${elapsed()}] banner: ${notices}`);
    }

    // 2. Fallback: hunt the verdict phrase anywhere on the page.
    const body = await page
      .locator("body")
      .innerText({ timeout: 2000 })
      .then(clean)
      .catch(() => "");
    if (body) {
      const hit = body.match(
        /.{0,40}(you changed your facebook password[^.]{0,60}|password (has been|was) (changed|updated)[^.]{0,40}|(incorrect|wrong|does not|do not) match|incorrect password|try again|unable to (change|update)[^.]{0,40}).{0,40}/i,
      );
      if (hit && !verdict) {
        verdict = clean(hit[0]);
        break; // definitive answer, stop watching
      }
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  if (!verdict && lastNotices) verdict = lastNotices;
  const ok = /you changed|password (has been|was) (changed|updated)/i.test(verdict);
  if (ok) log.success(`RESULT: ${verdict}`);
  else if (verdict) log.error(`RESULT: ${verdict}`);
  else log.warn("RESULT: no confirmation banner seen within 10s — check the browser");
  log.success(`Done in ${elapsed()} (submitted at ${clickAt})`);

  return { ok, verdict };
}

async function main() {
  const args = process.argv.slice(2);
  const useHtml = args.includes("--html");
  const useCookies = args.includes("-c") || args.includes("--c");
  const cliNewPw = argValue(args, ["--new-password", "-n"]);
  const cliCurrentPw = argValue(args, ["--current-password", "-o"]);
  const useDev = args.includes("-dev") || args.includes("--dev");

  const url = resolveUrl();
  const profileDir = path.join(__dirname, "profile");
  const useDesktop = args.includes("-d");

  const launch = (device: typeof DEVICES.phone) =>
    chromium.launchPersistentContext(profileDir, {
      ...device,
      locale: "en-US",
      headless: false,
      channel: "chrome",
      args: [
        "--disable-blink-features=AutomationControlled",
        ...(useDev ? ["--auto-open-devtools-for-tabs"] : []),
      ],
    });

  // The --html form always shows on desktop (wide, easy to fill).
  let context = await launch(
    useHtml ? DEVICES.desktop : useDesktop ? DEVICES.desktop : DEVICES.phone,
  );

  let currentPw = cliCurrentPw ?? HARDCODED_CURRENT;
  let newPw = cliNewPw ?? process.env.NEW_PASSWORD ?? "";
  let cookieString = "";
  let targetUrl = url;

  if (useHtml) {
    const ui = await context.newPage();
    await ui.goto("file:///" + path.join(__dirname, "pc.html").replace(/\\/g, "/"));
    await ui.fill("#current", currentPw);
    await ui.fill("#new", newPw);
    await ui.fill("#target", targetUrl);
    log.info("Fill the form in the browser, then click Run");
    try {
      await ui.waitForFunction(() => (window as any).__pcGo === true, undefined, {
        polling: POLL_MS,
        timeout: 0,
      });
    } catch {
      throw new Bail(
        ui.isClosed() ? "Browser closed before you clicked Run" : "Form never reached the Run step",
      );
    }
    currentPw = await ui.inputValue("#current");
    newPw = await ui.inputValue("#new");
    targetUrl = (await ui.inputValue("#target")) || url;
    cookieString = await ui.inputValue("#cookie");
    // Box wins; fall back to .env only if box is empty and -c/--c was passed.
    if (!cookieString && useCookies) cookieString = process.env.COOKIE_STRING ?? "";
    if (!useDesktop) {
      await context.close(); // close desktop form browser…
      context = await launch(DEVICES.phone); // …reopen as phone
      log.info("Relaunched browser in phone mode");
    } else {
      await ui.close();
    }
  } else if (args.includes("--xlsx")) {
    // Same source submit.ts uses, so PC.ts can act on any row of the sheet.
    const file = argValue(args, ["--xlsx"])!;
    const accounts = readAccounts(file);
    const want = Number(argValue(args, ["--row"]) ?? "1");
    const pick = accounts.find((a) => a.row === want);
    if (!pick) {
      throw new Bail(`row ${want} not found. Usable rows: ${accounts.map((a) => a.row).join(", ")}`);
    }
    cookieString = pick.cookie;
    log.success(`${path.basename(file)} row ${pick.row} (fp ${fingerprint(pick.cookie)})`);
  } else if (useCookies) {
    if (!process.env.COOKIE_STRING) throw new Bail("COOKIE_STRING is not set in .env");
    cookieString = process.env.COOKIE_STRING;
  }

  if (!newPw) {
    throw new Bail(
      "New password is empty — use --html and type it, or set NEW_PASSWORD in .env",
    );
  }

  if (cookieString) {
    const domain = process.env.COOKIE_DOMAIN ?? new URL(targetUrl).hostname;
    // Clear first: the profile is shared by every run, so without this each
    // account inherits the previous one's session and cookies just stack up.
    await context.clearCookies();
    await context.addCookies(parseCookies(cookieString.trim(), domain));
    log.success("Cookies loaded");
  }

  if (useDev) log.info("DevTools auto-open enabled");

  const page = context.pages()[0] ?? (await context.newPage());
  await changePassword({ context, currentPw, newPw, targetUrl });

  // Keep browser open for codegen (same as codegen.js). No context.close().
  await page.pause();
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    if (!(err instanceof BailLogged)) log.error(err.message);
    log.error(`Failed after ${elapsed()}`);
    process.exit(1);
  });
}
