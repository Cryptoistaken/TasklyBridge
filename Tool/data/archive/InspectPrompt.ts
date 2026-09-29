/**
 * Reproduce the SMS-prompt screen and pause for inspection.
 *
 *   bun InspectPrompt.ts --xlsx "2fa [100].xlsx" --row 5
 *
 * Why this exists: the prompt only appears AFTER an account is picked from the
 * chooser sheet, so codegen.js (which pauses straight after navigation) never
 * shows it. This walks the same steps submit.ts does, waits for the prompt, and
 * then calls page.pause(), which opens the Playwright Inspector - pick the
 * element there and copy its locator.
 *
 * Costs nothing: no Telegram, no job, no credential. Read-only apart from the
 * clicks needed to reach the screen.
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
  DEVICES_PHONE,
} from "./PC.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

const file = argValue(args, ["--xlsx"]) ?? "2fa [100].xlsx";
const want = Number(argValue(args, ["--row"]) ?? "5");
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

try {
  // Clear first: the profile is shared with the batch runs, so without this the
  // previous account's session is still active and Facebook serves that instead.
  await context.clearCookies();
  await context.addCookies(parseCookies(acct.cookie.trim(), "www.facebook.com"));
  log.success(`Cookies loaded for row ${want} of ${file}`);

  // Same two-step navigation changePassword() uses.
  await page.goto("https://www.facebook.com/", { waitUntil: "load" });
  await page.goto(resolveUrl(), { waitUntil: "load" });
  log.success(`Opened ${resolveUrl()}`);

  // Pick the account, which is what makes Facebook demand the code.
  const sheet = page.getByRole("dialog").first();
  const row = sheet.getByText("Facebook", { exact: true }).first();
  if (await row.isVisible({ timeout: 8000 }).catch(() => false)) {
    await row.click({ timeout: 5000 }).catch(() => {});
    log.success("Picked the account from the chooser sheet");
  } else {
    log.warn("No account row appeared - pausing anyway, inspect what is on screen");
  }

  // Give the prompt time to render, then report whether it is there at all.
  // Uses the SAME detector the batch run uses. This file used to carry its own
  // copy of the matchers, which is how the two drifted apart and how a prompt
  // that the run could not see still looked "found" here.
  await page.waitForTimeout(6000);
  const body = await page
    .locator("body")
    .innerText({ timeout: 3000 })
    .then((t) => t.replace(/\s+/g, " "))
    .catch(() => "");
  const found = await codePromptVisible(page);
  log.info(`codePromptVisible() says the prompt is showing: ${found}`);
  log.info(`body.innerText (first 400): ${body.slice(0, 400) || "(empty)"}`);

  // The prompt usually renders inside an Accounts Center iframe, which is why
  // the detector sweeps frames - so report which one carries it.
  const frames = page.frames();
  log.info(`frames: ${frames.length}`);
  for (const f of frames) {
    const t = await f
      .locator("body")
      .innerText({ timeout: 1500 })
      .catch(() => "");
    if (/enter (the )?(confirmation |security |verification )?code|authenticity verification|we can send a new code/i.test(t)) {
      log.success(`  ^ prompt text found in frame: ${f.url().slice(0, 90) || "(about:blank)"}`);
    }
  }

  log.info("Opening the Playwright Inspector - pick the element and copy its locator.");
  log.info("Press Ctrl+C here when done.");
  await page.pause();
} finally {
  await context.close().catch(() => {});
}
