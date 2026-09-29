/**
 * Live check: does the fixed detector see the gate on the REAL page?
 *
 *   bun GateProbe.ts --xlsx "2fa [100].xlsx" --row 5
 *
 * Same walk InspectPrompt.ts does, and it calls the SAME exported detectors the
 * batch run uses - so this cannot pass while the run fails, the way a private
 * copy of the matchers could. Costs nothing: no Telegram, no job, no credential.
 * Read-only apart from the clicks needed to reach the screen.
 *
 * Unlike InspectPrompt.ts this EXITS with a verdict instead of page.pause(), so
 * it can be run unattended.
 */
import { chromium } from "playwright";
import path from "path";
import { fileURLToPath } from "url";
import {
  parseCookies,
  readAccounts,
  resolveUrl,
  log,
  argValue,
  codePromptVisible,
  blockingDialog,
  DEVICES_PHONE,
} from "./PC.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

const file = argValue(args, ["--xlsx"]) ?? "2fa [100].xlsx";
const want = Number(argValue(args, ["--row"]) ?? "5");
const waitMs = Number(argValue(args, ["--wait"]) ?? "45000");

const accounts = readAccounts(file);
const acct = accounts.find((a) => a.row === want);
if (!acct) {
  log.error(`row ${want} not found in ${file}`);
  process.exit(1);
}

const context = await chromium.launchPersistentContext(path.join(__dirname, "profile"), {
  ...DEVICES_PHONE,
  locale: "en-US",
  headless: false,
  channel: "chrome",
  args: ["--disable-blink-features=AutomationControlled"],
});

const page = context.pages()[0] ?? (await context.newPage());
// A persistent profile can open with a leftover tab from a killed run. Use the
// page we actually navigate, not whatever happened to be first.
let exit = 0;

try {
  // The profile is shared with the batch runs, so clear it first - otherwise
  // Facebook serves the previous account's session instead.
  await context.clearCookies();
  await context.addCookies(parseCookies(acct.cookie.trim(), "www.facebook.com"));
  log.success(`Cookies loaded for row ${want} of ${file}`);

  const fresh = await context.newPage();
  await fresh.goto("https://www.facebook.com/", { waitUntil: "load" });
  await fresh.goto(resolveUrl(), { waitUntil: "load" });
  log.success(`Opened ${resolveUrl()}`);

  const page = fresh;

  // Picking the account is what makes Facebook demand the code.
  const sheet = page.getByRole("dialog").first();
  const row = sheet.getByText("Facebook", { exact: true }).first();
  if (await row.isVisible({ timeout: 8000 }).catch(() => false)) {
    await row.click({ timeout: 5000 }).catch(() => {});
    log.success("Picked the account from the chooser sheet");
  } else {
    log.warn("No account row appeared - probing anyway");
  }

  // Poll: the prompt can take seconds to mount, and the verdict we care about is
  // "was it EVER visible", not "was it visible at one arbitrary instant".
  const deadline = Date.now() + waitMs;
  let seen = false;
  let sawBlocking = false;
  while (Date.now() < deadline) {
    if (await codePromptVisible(page)) {
      seen = true;
      if (!sawBlocking) sawBlocking = await blockingDialog(page);
      break;
    }
    await page.waitForTimeout(500);
  }

  // Which frame carried it? This is the whole point of the fix.
  const frames = page.frames();
  log.info(`frames on the page: ${frames.length}`);
  for (const f of frames) {
    const t = await f
      .locator("body")
      .innerText({ timeout: 1500 })
      .then((s) => s.replace(/\s+/g, " "))
      .catch(() => "");
    if (/enter (the )?(confirmation |verification |security )?code|authenticity verification|we can send a new code/i.test(t)) {
      const main = f === page.mainFrame();
      log.success(`  gate text is in the ${main ? "MAIN frame" : "child frame"}: ${f.url().slice(0, 90) || "(no url)"}`);
      log.info(`  frame text: ${t.slice(0, 220)}`);
    }
  }

  const body = await page
    .locator("body")
    .innerText({ timeout: 3000 })
    .then((s) => s.replace(/\s+/g, " "))
    .catch(() => "");
  log.info(`page text (first 260): ${body.slice(0, 260) || "(empty)"}`);

  if (seen) {
    log.success(`VERDICT: gate DETECTED (blocking dialog: ${sawBlocking}) - the run will skip this row`);
  } else {
    log.warn("VERDICT: gate not detected in " + waitMs + "ms. This screen may be different - send the page text above.");
    exit = 2;
  }
} catch (e: any) {
  log.error(`probe failed: ${e?.message ?? e}`);
  exit = 1;
} finally {
  await context.close().catch(() => {});
}
process.exit(exit);
