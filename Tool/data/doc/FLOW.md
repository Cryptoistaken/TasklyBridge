# Flow (`index.js`)

Proven against live captures; anything else is marked UNVERIFIED.

## Bot (one Start per password, not per cookie)

Four provider replies that used to look like failures, all real (see
`What the provider says back` in README):

- `You are making requests too often. Please wait N sec.` -> wait N, press
  again. It replaces the reply we wanted, so the account is still there.
- `Time's up! Task cancelled.` -> the provider's own timer, minutes not
  seconds, and the length varies. The account is already lost; say so.
- `Action cancelled.` -> OURS. Confirmation that pressing Cancel cleared a
  modal state. Expected, never a failure.
- `Report approved, +$0.05` / `Report rejected...` -> the real verdict, up to
  64 min later and out of band. Recorded to `data/out/verdicts.jsonl` and matched to
  its row by order. `--check-verdicts` reports it.

1. `/start` raw -> welcome. Buttons must include Balance or Cancel-clear and retry (3x).
2. Press whole `Tasks` label -> task list.
3. Press whole `Cookies` label -> job list.
4. Press whole `2FA:Create FB (No mail)` label -> job card. Never match bare `Create FB` (different product).
5. Press whole `Start` label -> `Please enter your 2FA key`. Poll history 5s for `First/Last name:/Password:` (colon mandatory). No password after 3 walks = stop, nothing sent.
6. Change Facebook FIRST (below). Only then send the row's 2FA key raw -> expect a cookie prompt.
7. Send cookie raw -> expect a confirm-registration prompt. The cookie alone never finishes the job.
8. Press whole `Account registered` label -> `report has been received` = receipt, NOT the outcome. Queue the row for its verdict.

## Reuse (saves one Start per failed cookie)

One password covers max 3 cookies, retires after 1 success (hash in `used-passwords.json`). Gated/dead/stuck cookie -> `skipped.jsonl`, same password carries to the next cookie with no new Start. Unknown failures retire the password.

## Facebook (`changePassword`)

1. `facebook.com` first (settle session), then `TARGET_URL`.
2. Loop: SMS-gate check first, then detect screen (form / checkpoint / chooser / hub tile / hub / logged-out).
3. Chooser: pick by `Facebook` label, then name regex. Stuck on `Loading...` = gated skip.
4. Gate detectors sweep page + all iframes (the prompt lives in an iframe) and `blockingDialog()` rejects a form covered by another dialog (`isVisible` ignores occlusion).
5. Fill current/new/retype (clear, type key by key, read back, 3 tries). New equal to current is refused upfront.
6. Submit polls `aria-disabled`, clicks, watches alert/status/live regions 10s for `you changed your facebook password`.

## Failures

| Symptom | Handling |
| --- | --- |
| Dead cookie (probe DEAD twice) | Skip before browser/Telegram; nothing spent |
| SMS gate at any point (incl. mid-fill, mid-watch) | `BailGated` -> `skipped.jsonl`, never retried |
| `/checkpoint/` says "confirm we're human" | Click Continue once, then a CAPTCHA appears - stop, a human does it |
| `/checkpoint/` shows a CAPTCHA | Not solved. Row stops, is NOT marked dead, retry or `--codegen` by hand |
| `/checkpoint/` says disabled/blocked/violates terms | Banned -> `skipped.jsonl`, never retried |
| `/checkpoint/` says "confirm your identity" and the rest | Challenge, not a ban; wait for a human, then continue |
| Button disabled / field mismatch / no known screen | Bail with screenshot + page text; row retried next run |
| Dropped Telegram connection | Group stops; later rows fail closed and retry next run |

A checkpoint is deliberately split into those two rows. Facebook uses the same URL
for a ban and for an ordinary challenge, and the wording decides. Wrong the other way
is not symmetric: waiting on a banned account costs minutes, calling a live account
banned costs the account. `--selftest` asserts the split on 12 real wordings.

