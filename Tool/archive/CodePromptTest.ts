/**
 * Does codePromptVisible() actually catch the screen Facebook shows?
 *
 *   bun CodePromptTest.ts
 *
 * Why this exists: on 2026-09-29 the detector had two locators and reported
 * "no code prompt" while the prompt was on screen, so the run walked past a
 * gated account and died 30s later on
 * `inputValue: Timeout 30000ms exceeded` against a covered field. Reading the
 * code proved nothing about whether the fix works - only running it does.
 *
 * The fixtures below are transcribed from the live screen (screenshot +
 * captured page text), not invented. Every one is a case the old detector missed
 * or could have got wrong:
 *
 *   1. gateAsRendered      - the real thing: dialog, heading, phone, a
 *                            placeholder-only input, a live countdown
 *   2. gateInIframe        - the dialog lives in an Accounts Center iframe, so
 *                            page-level locators cannot see it at all
 *   3. gateWithoutCodeWords- no "confirmation code" anywhere; only the
 *                            "Authenticity verification" section label
 *   4. hubHelpText         - MUST NOT match. The hub carries this same label as
 *                            static help text with no prompt on screen, and
 *                            gating on it would skip accounts that are fine
 *   5. passwordFormOnly    - MUST NOT match. The normal screen
 *   6. chooserSheet        - MUST NOT match, and MUST NOT count as blocking
 *
 * Exits non-zero on the first failure, so it is usable as a check.
 */
import { chromium } from "playwright";
import { codePromptVisible, blockingDialog } from "./PC.ts";

// The page behind the dialog, exactly as captured.
const FORM_BEHIND = `
  <h1>Change password</h1>
  <p>Your password must be at least 6 characters and should include a combination
     of numbers, letters and special characters (!$@%).</p>
  <label>Current password</label><input type="password" aria-label="Current password" />
  <label>New password</label><input type="password" aria-label="New password" />
  <label>Retype new password</label><input type="password" aria-label="Retype new password" />
`;

// The dialog, as rendered. Note the input carries a PLACEHOLDER and no
// accessible name - that is the detail the old getByRole(name:) relied on.
const GATE_DIALOG = `
  <div role="dialog" aria-modal="true">
    <button aria-label="Close">&#10005;</button>
    <div>Authenticity verification</div>
    <div>Devin Scott &bull; Facebook</div>
    <h2>Enter confirmation code</h2>
    <p>We&rsquo;ve sent a confirmation code to +216 ******95.</p>
    <input type="text" placeholder="Confirmation code" inputmode="numeric" />
    <p>We can send a new code in 00:48</p>
    <button>Next</button>
  </div>
`;

const CHOOSER = `
  <div role="dialog">
    <p>Choose an account to make changes.</p>
    <p>Devin Scott</p><p>Facebook</p>
  </div>
`;

const HUB_HELP = `
  <h1>Password and security</h1>
  <h2>How we confirm that it&rsquo;s you</h2>
  <p>Choose how you confirm your identity for secure login.</p>
  <h2>Authenticity verification</h2>
  <p>Review security issues by running checks across apps, devices and emails sent.</p>
`;

const page_html = (body: string) => `<!doctype html><html><body>${body}</body></html>`;

let failures = 0;
const check = (name: string, got: boolean, want: boolean) => {
  const ok = got === want;
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${name}${ok ? "" : `  (got ${got}, want ${want})`}`);
};

const browser = await chromium.launch();
const page = await browser.newPage();

console.log("codePromptVisible / blockingDialog\n");

// 1. The live screen, verbatim.
await page.setContent(page_html(FORM_BEHIND + GATE_DIALOG));
check("1. gate as rendered            -> detected", await codePromptVisible(page), true);
check("1. gate as rendered            -> blocking", await blockingDialog(page), true);

// 2. Same dialog, inside an iframe: page-level locators see nothing there.
await page.setContent(page_html(`${FORM_BEHIND}<iframe id="ac" srcdoc="${GATE_DIALOG.replace(/"/g, "&quot;")}"></iframe>`));
await page.waitForTimeout(400); // let the frame attach
check("2. gate inside an iframe       -> detected", await codePromptVisible(page), true);

// 3. A reworded prompt with none of the "code" words.
await page.setContent(
  page_html(`
    <div role="dialog">
      <div>Authenticity verification</div>
      <h2>Enter the 6 digits we sent you</h2>
      <p>We&rsquo;ve sent a confirmation code to +216 ******95.</p>
      <input type="text" placeholder="Code" />
    </div>`),
);
check("3. reworded gate               -> detected", await codePromptVisible(page), true);

// 4. The false positive this must not become. Same label, no prompt, no dialog.
await page.setContent(page_html(FORM_BEHIND + HUB_HELP));
check("4. hub help text               -> not gated", await codePromptVisible(page), false);
check("4. hub help text               -> not blocking", await blockingDialog(page), false);

// 5. The normal screen.
await page.setContent(page_html(FORM_BEHIND));
check("5. password form only          -> not gated", await codePromptVisible(page), false);
check("5. password form only          -> not blocking", await blockingDialog(page), false);

// 6. Our own chooser sheet must not be mistaken for a gate, and must not be
//    treated as blocking - it lingers in the DOM after a pick.
await page.setContent(page_html(CHOOSER));
check("6. chooser sheet               -> not gated", await codePromptVisible(page), false);
check("6. chooser sheet               -> not blocking", await blockingDialog(page), false);

// 7. The form's OWN container is a role="dialog". Observed 2026-09-29 on a
//    healthy account: the only dialog on the page is the form itself. Counting
//    it as blocking meant formReady could never be set, so a working form was
//    reported as "no form yet" and the row was skipped.
await page.setContent(
  page_html(`
    <div role="dialog">
      <div>Change password</div>
      <div>Cantika Setiawan &bull; Facebook</div>
      <label>Current password</label><input type="password" id="cp7" />
      <label for="cp7">Current password</label>
      <label>New password</label><input type="password" />
      <label>Retype new password</label><input type="password" />
    </div>`),
);
check("7. form in its own dialog      -> not blocking", await blockingDialog(page), false);
check("7. form in its own dialog      -> not gated", await codePromptVisible(page), false);

// 8. The genuinely stuck sheet: an account that never leaves "Loading...".
//    This one IS permanent, so it must still be recognised.
const stuckSheet = "Choose an account to make changes. Devin Scott Facebook Loading...";
const looksStuck = (t: string) => /loading/i.test(t) && !/current password/i.test(t);
check("8. stuck sheet IS stuck", looksStuck(stuckSheet), true);
check("8. healthy form is NOT stuck", looksStuck(`Change password Current password New password Loading...`), false);

await browser.close();
console.log(`\n${failures ? `${failures} FAILED` : "all passed"}`);
process.exit(failures ? 1 : 0);
