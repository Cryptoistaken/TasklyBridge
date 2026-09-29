# Submit flow

How `@tasklyBux_bot` behaves, step by step, and how `submit.ts` handles each
reply. Every "bot says" line below is a real capture from 2026-09-29, not a
reconstruction. Anything unproven is marked **UNVERIFIED**.

Run it:

```powershell
bun submit.ts -p <phone> -o <currentFbPassword> --fa2 <2faKey>   # full run
bun submit.ts -p <phone> --dry-run                                # walk + Start, then stop
bun submit.ts -p <phone> -P <assignedPassword> -o <current> --fa2 <key>   # resume
bun TG.ts --watch -p <phone>                                      # read-only live view
bun CodePromptTest.ts                                             # check the SMS-gate detector
bun GateRecordTest.ts                                            # check gated rows stay recorded
bun SkipAudit.ts                                                 # check skipped rows really suppress retries
bun InspectPrompt.ts --xlsx "2fa [100].xlsx" --row 5              # reproduce the gate, open Inspector
bun GateProbe.ts --xlsx "2fa [100].xlsx" --row 5                 # same, but exits with a verdict
```

`SkipAudit.ts` and `GateRecordTest.ts` cost nothing — no Telegram, no browser, no
job. Run them after touching anything that decides whether a row is retried.

---

## The conversation

### 1. Open the main menu

| | |
| --- | --- |
| We send | `/start` (raw text, never a bare fragment) |
| Bot replies | `👋 Welcome! ℹ️ This bot helps you earn money…` |
| Buttons | `💰 Balance` · `📋 Tasks` · `📤 Withdraw` · `👤 Profile` · `🏆 Top` · `👥 My Referrals` · `🌍 Language` |

**Handle:** confirm `Balance` is on screen. If it is not, the provider is in a
modal state and ordinary labels read as *cancel* — press `❌ Cancel` and retry,
3 times, then give up. `ensureMainMenu()` in `TG.ts` does this.

`/start` **resets job state**. Never call it while a job is in progress.

### 2. Open the job list

| | |
| --- | --- |
| We send | the whole label `📋 Tasks` |
| Bot replies | `👇 Please select a task:` |
| Buttons | `📱 Create Inst (2FA) ($0.0180)` · `🍪 Cookies ($0.0500)` · `❌ Cancel` |

### 3. Open the Cookies group

| | |
| --- | --- |
| We send | `🍪 Cookies ($0.0500)` |
| Bot replies | `🍪 Cookies:` |
| Buttons | `🌟2FA:Create FB (No mail) ($0.0500)` · `🍪 Create Inst (No mail) ($0.0230)` · `🐦 Create Twitter ($0.0260)` · `🐦 Create Twitter (No follow) ($0.0270)` · `🌟Create FB (2FA) ($0.0480)` · `🌟Create FB (No mail) ($0.0300)` · `❌ Cancel` |

### 4. Open the job

| | |
| --- | --- |
| We send | `🌟2FA:Create FB (No mail) ($0.0500)` |
| Bot replies | `⏳ Review time: 64 min ⏳ 📋 Task: 🌟2FA:Create FB (No mail) 📄 Description: 🔐 REQUIRED! You must use the information provided by the Telegram bot to register. ❗If you use your own information, your application will be REJECTED without verification.` |
| Buttons | `▶️ Start` · `📹 Video instruction` · `❌ Cancel` |

**Use `2FA:Create FB (No mail)` as the matcher, not `Create FB`.** These are
different products at different prices, and only the former contains that
substring — `🌟Create FB (No mail) ($0.0300)` does not. A loose matcher can
sell the wrong job under the right name.

### 5. Start — the bot asks for the 2FA key

| | |
| --- | --- |
| We send | `▶️ Start` |
| Bot replies | `🔑 Please enter your 2FA key to get the code:` |
| Buttons | `❓ How to set up 2FA?` · `❌ Cancel` |

**Handle:** warn that this may already have charged — it is not known whether
the cost lands at `Start` or at completion. Then send the 2FA key as **raw
text**, not a button.

### 6. Send the 2FA key — the bot asks for the cookie

| | |
| --- | --- |
| We send | the 2FA key (a base32 TOTP secret) |
| Bot replies | `🔑 Please send the account Cookie:` |
| Buttons | `❓ How to get Cookie?` · `❌ Cancel` |

**Handle:** send `COOKIE_STRING` from `.env` as raw text. Do not press a button
here — there is no button for it.

### 7. Send the cookie — the bot asks for a confirmation button

| | |
| --- | --- |
| We send | the Facebook cookie string |
| Bot replies | `🔑 Press the button to confirm registration or cancel the task:` |
| Buttons | `✅ Account registered` · `❌ Cancel` |

**This step is easy to miss and it hangs the job.** The cookie alone does *not*
finish it. The bot is waiting for a button press.

### 8. Confirm — done

| | |
| --- | --- |
| We send | the whole label `✅ Account registered` |
| Bot replies | `✅ Your report has been received! Please wait.` |
| Buttons | back to the main menu |

**Handle:** treat `Your report has been received` as the success signal. If the
reply is anything else, the report did not land.

---

## The Facebook password change

`PC.ts` handles this, and `submit.ts` calls the same function. It is a separate
browser flow against `accountscenter.facebook.com`.

1. Visit `facebook.com` first to settle the session cookies, then the change
   password URL.
2. Detect the screen. Three shapes are possible and the script tells them
   apart: the account chooser sheet, the profile menu, or the form itself.
3. Pick the account row by its `Facebook` label — **not** by profile name. The
   name differs per account (`Rafi Purnomo`, `Hani Cahyono`, `Gilang Sudirman`
   were all seen) and a name-based matcher breaks.
4. Fill *Current password*, *New password*, *Retype new password*.
5. Submit.

### Traps that cost real debugging time

| Trap | What happens | Handling |
| --- | --- | --- |
| Chrome autofill | Retypes the saved password over `fill()` | Clear the field, type key by key, then read the value back and compare |
| `Escape` key | Closes the Accounts Center sheet and takes the page down | Never press `Escape`; clear with `fill("")` |
| Submit is a `div` | Carries `aria-disabled`, so `click()` times out for 30s | Poll until `aria-disabled !== "true"`, then click |
| New equals current | Button is silently disabled, no error shown | Pre-check and refuse |
| Password in shell history | `-P`/`-n` leave credentials in history | Prefer env vars |
| **The gate lives in a frame** | Page-level locators cannot see the dialog, so `codePromptVisible()` returns false while the prompt is plainly on screen | Sweep `page.frames()` as well as the page — see below |
| **`isVisible()` ignores occlusion** | With the gate dialog on top, `Current password` *behind it* still reports visible, so the walk loop declared the form ready and died on `inputValue: Timeout 30000ms exceeded` | `blockingDialog()` — a form does not count as ready while another dialog covers it |
| Loop runs out of steps | Fell through to `typeClean()` against a form it never reached, naming a field instead of the real screen | `reachedForm` guard: bail with a screenshot instead |

### The SMS gate, and why detection failed twice

The screen is a dialog headed `Devin Scott - Facebook`:

```
Authenticity verification
Enter confirmation code
We've sent a confirmation code to +216 ******95.
[ Confirmation code ]           <- placeholder, and it lives in an iframe
We can send a new code in 00:48
```

Two separate bugs hid it, and both had to be fixed:

1. **Frame scope.** The dialog renders inside an Accounts Center **iframe**, so
   `page.getByText(...)` cannot reach it. Replaying the captured markup proves
   it: in the main frame the two original locators both matched; inside an
   iframe the same two locators returned `false`. The detector now sweeps
   `page.frames()`, and matches on placeholder as well as accessible name.
2. **Occlusion.** `isVisible()` reports `true` for a field that is covered by a
   modal. The password form is rendered *behind* the gate, so the walk loop
   matched `passwordForm`, considered itself finished, and spent 30s on a field
   nobody could reach. `blockingDialog()` now gates that.

`CodePromptTest.ts` replays the captured screen and the two false-positive
shapes — the hub's static "Authenticity verification" help text, and the
lingering account chooser sheet — so a future edit cannot quietly gate accounts
that are fine.

### Recording a gate, so it is never retried

A gate is permanent, so the row must not be attempted again: each attempt costs
$0.05 and a bot credential, forever. `PC.ts` throws a **`BailGated`**, and
`submit.ts` records the skip by catching that type.

It used to match on the message text — `/sms confirmation code/i` — which meant
rewording one log line would silently stop every gate from being recorded, and
none of those rows would ever look wrong in the output. The stuck-on-`Loading`
case had the same problem. Both are typed now; the text test is kept only as a
net for a gate raised by an older child process. `GateRecordTest.ts` pins this,
including the case that used to break: identical error, reworded message.

`markSkipped` appends synchronously (`appendFileSync`), so a skip survives a
crash mid-run, and it is idempotent. `SkipAudit.ts` rebuilds the batch queue the
way `runBatch()` does and confirms the recorded rows are genuinely excluded.

**Success is read from the banner, not the click.** After submitting, poll the
`role="alert"` / `role="status"` / `aria-live` regions and the page text for:

```
You changed your Facebook password for <name>
```

Do not trust a successful click — the banner is the only confirmation.

---

## Provider rules we must not break

| Rule | Why |
| --- | --- |
| Send **whole** labels | The provider matches exact keyboard text. A bare `Tasks` or `cookie` matches nothing and lands in the cancel handler |
| Never `getHistory` | It returns 0 messages, always. Read the live update stream instead |
| Register the handler before sending | Otherwise a fast reply is missed |
| Wait for 500ms of silence | Not a fixed sleep — a reply is never read half-finished |
| Never run two clients on one session | Telegram returns `Conflict: terminated by other getUpdates request` and the loser is killed permanently |

---

## Failure modes

| Symptom | Cause | Handling |
| --- | --- | --- |
| `no button matches "…"` | Wrong screen, or the label changed | `press()` refuses rather than sending a fragment; read `on screen:` |
| `not on the main menu` | Modal state from an earlier job | `ensureMainMenu()` presses `❌ Cancel` and retries 3x |
| `Change password button stayed disabled` | New equals current, or password too short | The page's own hint text is printed |
| `field mismatch (attempt N)` | Autofill fighting the script | 3 attempts, then bail with a screenshot |
| `Browser closed before you clicked Run` | Form window was closed | Explicit error, not a generic Playwright failure |
| No confirmation prompt after the cookie | Provider flow changed | Stop and report; **never** send a bare fragment to probe |

Every bail writes a full-page screenshot to `%LOCALAPPDATA%\Temp\opencode` and
prints the page text, so a failure is diagnosable without guessing.

---

## Verified vs unverified

**Verified by live capture:** steps 1–8 in full, both device states of the
Facebook flow, the label set and prices above.

**UNVERIFIED — the bot has never been seen sending credentials.** A message of
the form

```
First name: Haley
Last name: Hunter
Password: u5yZIeweLu
```

was seen once, but **not** during a capture of this job — this job's step 6 asks
for a cookie, not for a password. Where that message comes from is unknown, so
`parseCreds()` handles it opportunistically: if credentials appear, the password
is set on Facebook before the cookie is sent; if not, the run continues to the
cookie step. **This is the one part of the flow built on an unconfirmed
assumption.**

`scrapePassword()` originally had a "lone token on its own line" fallback. On the
real reply `🔑 Please enter your 2FA key to get the code:` it returned `Please`,
which would have been typed into Facebook as a password. It was removed. The
parser now requires an explicit `Field: value` line and rejects prompt text.

---

## Security

- The 2FA key is a TOTP **secret**. Anyone holding it generates that account's
  codes indefinitely, with no rotation. This is the largest open risk in the
  product.
- The Facebook cookie is a complete authenticated session. Anyone holding it is
  logged in as that account.
- Both are in `.env`, and `.env`, `sessions/` and `profile/` are gitignored.
  Prefer env vars over CLI flags so credentials stay out of shell history.
- Never print a cookie or key back to the terminal.
