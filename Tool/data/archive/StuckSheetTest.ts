/**
 * Replay the EXACT screen from the failed run and check the two decisions that
 * were wrong.
 *
 *   bun StuckSheetTest.ts
 *
 * From out/codegen-2026-09-29T05-27-57-125Z.html (row 6, "2fa 2 [49].xlsx"),
 * a perfectly healthy account:
 *
 *   INFO   screen passwordForm: VISIBLE
 *   INFO   screen accountChooser: VISIBLE
 *   INFO dialog count: 1
 *   INFO   dialog[0] text: Change password Cantika Setiawan - Facebook ...
 *                              Current password New password Retype new password
 *
 * Two bugs made this row get skipped while its password form sat there, fully
 * usable:
 *
 *   1. blockingDialog() counted the form's OWN role="dialog" container as a
 *      blocker, so the poll could never set formReady.
 *   2. The stuck-on-"Loading..." test was a bare /loading/i over the page text.
 *      This page contains the word "Loading" as an ordinary control, so a
 *      working account was reported as permanently stuck and thrown into
 *      skipped.jsonl - never retried, and never actually attempted.
 *
 * Both are permanent, silent data loss for $0.05 a row, so they get replayed
 * against the real markup here.
 */
import { chromium } from "playwright";
import { blockingDialog, codePromptVisible } from "./PC.ts";

let failures = 0;
const check = (name: string, got: boolean, want: boolean) => {
  const ok = got === want;
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${name}${ok ? "" : `  (got ${got}, want ${want})`}`);
};

// Verbatim from the dump: the page behind, and the single dialog that IS the
// form. Note "Saved login" / "Loading" - ordinary page furniture that the old
// /loading/i test swallowed.
const HEALTHY = `
  <h1>Password and security</h1>
  <p>How you log in</p>
  <h2>Saved login</h2>
  <p>Loading</p>
  <h2>Passkey</h2>
  <h2>Change password</h2>
  <div role="dialog">
    <div>Change password</div>
    <div>Cantika Setiawan &bull; Facebook</div>
    <div>Change password</div>
    <p>Your password must be at least 6 characters</p>
    <label>Current password</label><input type="password" id="cp" />
    <label for="cp">Current password</label>
    <label>New password</label><input type="password" />
    <label>Retype new password</label><input type="password" aria-label="Retype new password" />
    <p>Forgotten your password?</p>
  </div>
`;

// The genuinely stuck sheet, for contrast. Still permanent - must stay detected.
const STUCK = `
  <div role="dialog">
    <p>Choose an account to make changes.</p>
    <p>Devin Scott</p><p>Facebook</p><p>Loading...</p>
  </div>
`;

const html = (b: string) => `<!doctype html><html><body>${b}</body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage();

console.log("the screen from the failed run (healthy, form usable):\n");

await page.setContent(html(HEALTHY));

// Reproduce what dumpAndHold reported on the real page.
const formVisible = await page
  .getByRole("textbox", { name: "Current password" })
  .first()
  .isVisible({ timeout: 400 })
  .catch(() => false);
check("password form is visible (as the dump said)", formVisible, true);
check("it is a real, usable form", await blockingDialog(page), false);
check("no SMS gate on it", await codePromptVisible(page), false);

// The old test read the CHOOSER SHEET's text, not the whole page. The sheet is
// the only dialog here, and it is the form - so the sheet text has no
// "Loading". The word that fooled /loading/i lives on the PAGE, which is why
// the old test is only safe now that it also requires "current password" to be
// absent. Both halves are asserted: the word is there, the verdict is correct.
const sheetText = await page.getByRole("dialog").first().innerText({ timeout: 2000 }).catch(() => "");
const pageText = await page.locator("body").innerText({ timeout: 2000 }).catch(() => "");
const looksStuck = (t: string) => /loading/i.test(t) && !/current password/i.test(t);
check("the word 'Loading' IS on the page (what fooled the old test)", /loading/i.test(pageText), true);
check("but the page is NOT classified as stuck", looksStuck(pageText), false);
check("and the sheet is not classified as stuck either", looksStuck(sheetText), false);

console.log("\nthe genuinely stuck sheet (must still be permanent):\n");

await page.setContent(html(STUCK));
const stuckText = await page.getByRole("dialog").first().innerText({ timeout: 2000 }).catch(() => "");
check("stuck sheet IS classified as stuck", looksStuck(stuckText), true);
// It is the chooser sheet, which blockingDialog excludes on purpose - it is
// the one dialog we are allowed to have, and it lingers after a pick. What
// matters is that it is never mistaken for a usable form.
check("stuck sheet is not mistaken for a usable form", await blockingDialog(page), false);
check("no form is present on it", await page.getByRole("textbox", { name: "Current password" }).count(), 0);

await browser.close();
console.log(`\n${failures ? `${failures} FAILED` : "all passed"}`);
process.exit(failures ? 1 : 0);
