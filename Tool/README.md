# Taskly Tool

Single-file submitter: takes accounts from xlsx, checks cookies, gets a bot password, changes the Facebook password, submits key + cookie. Why one file: the old 15-script split is archived in `archive/` and is not maintained.

## Setup

```
cd Tool
bun install
npx playwright install chromium
copy .env.example .env   # then fill in values
```

Put sheets in `data/` (gitignored, never committed).

## Run

```
bun index.js --xlsx data\a.xlsx --row 5 -p <phone> -o <currentPw>
bun index.js --xlsx data\a.xlsx data\b.xlsx --all -p <phone>
bun index.js --xlsx data\a.xlsx --all --plan -p <phone>   # grouping only, spends nothing
bun index.js -P <assignedPw> -o <current> --fa2 <key> --xlsx data\a.xlsx --row 5   # resume
bun index.js --login <phone>                              # one-time Telegram sign-in
bun index.js --codegen --xlsx data\a.xlsx --row 5        # open browser with that row's cookie, pause for inspector
bun index.js --codegen --detect --xlsx data\a.xlsx --row 5   # report which screen is detected, type nothing
bun index.js --check-pw --xlsx data\a.xlsx --row 5 -o <curPw>   # fill the form, prove the button enables, never submits
bun index.js --refresh-cookie --xlsx data\a.xlsx --row 5 -o <curPw>          # log in once, retest the new cookie, compare
bun index.js --refresh-cookie --xlsx data\a.xlsx --row 5 -o <curPw> --write-back   # ...and save it if it is trusted
bun index.js --selftest                             # offline checks, no browser, no network
```

`--detect` walks to the password form and names every screen it hits, typing nothing. `--check-pw` goes one step further: it fills all three fields with a throwaway password and confirms Facebook enables **Change password**, then stops. It never clicks it, so the account password is unchanged. `--refresh-cookie` does the Continue/re-auth flow once, then reopens a clean browser with the cookie Facebook issued and reports which recovery hops it still needs — measured, that is usually none. Both need the row's cookie and spend nothing.

`--selftest` checks the ban/challenge split offline. Run it after any change to those wordings, and before trusting a run that will mark accounts as banned.

## Waiting on the page

Nothing waits a fixed number of seconds for the UI. `waitForAny` polls for the expected element and acts the moment it is on screen; `waitForScreen` does the same for the walk. Set `TOOL_DEBUG=1` to see per-tick wait tracing. The Telegram side deliberately still sleeps — that is throttling, not UI waiting.

## Two screens that are not the same

A checkpoint is not one thing. Facebook uses `/checkpoint/` both for a **ban** and for an ordinary identity challenge, and guessing wrong is expensive in both directions — waiting ten minutes on a dead account, or discarding a live one. The page text decides: disabled / blocked / violates-our-terms means banned, and the row goes to `out/skipped.jsonl` so it is never retried. Everything else is treated as a challenge, which is the recoverable side.

## The automated-behaviour screen

Found for real, using `--hold`, on `2fa100` row 9. It is **not** what it was described as:

```
https://m.facebook.com/checkpoint/1501092823525282/
"Ge. Alissa Bayuk, confirm that you're human to use your account"
buttons: Continue
```

One `Continue` button and no `Dismiss` at all — a handler written from the description would have found nothing and clicked nothing. It is handled as a human check: the phrase **and** the button must both be present, so a bare `Continue` elsewhere is never clicked.

Clicking that `Continue` leads to a **CAPTCHA** ("Enter the text from the image / Hear this code / Type the text"). That is not solved here — no image reading, no audio transcription, no code lookup. The row stops and tells you to run `--codegen` and type it in. The account is *not* marked dead or skipped: that is a stop, not a verdict on the cookie.

## `--hold`

The tool for the next screen we do not recognise. When the walk gives up it prints the url, text, buttons, links, inputs and dialogs, **waits for the page to actually render first** (the first dump of a real checkpoint came back completely empty, because the page is blank for several seconds after the redirect), reads iframe text as well, then leaves the browser open to poke at. Ctrl+C in the terminal closes it.

```
bun index.js --check-pw --hold --xlsx data\2fa100.xlsx --row 9 -o <pw>
```

This is how the human check was found, and it is the fastest way to learn a new state.

## Anti-detection

`navigator.webdriver` is forced to `false` on every page, alongside the Blink flag. That is a start, not a disguise.

Flags: `--row N`, `--force` (retry sent/gated), `--dry-run` (walk + Start, stop before Facebook), `--per-session N` (default 3), `--fa2` (override sheet key).

## Two separate liveness checks

They answer different questions, so both run, cheap one first.

| Check | Asks | Cost | If it says no |
| --- | --- | --- | --- |
| **UID check** (`check.fb.tools`) | is the *account* still there? | one request, 500 UIDs per call | permanent — `skipped.jsonl`, never retried |
| **Cookie probe** (`accountscenter/profiles`) | is the *session* still valid? | a request to Facebook, confirmed twice, 3s apart | that cookie is spent, try another |

The UID check runs first, before any Telegram session opens and before the browser. A blocked account cannot be worked, so a bot password spent discovering that is a waste. Measured on `2fa100`: 1 of 86 queued accounts was `Blocked` and got dropped without opening a session. `--plan` shows the same drop, so it costs nothing to look.

**A captcha does not mean a banned account.** Row 9 shows a captcha *and* the UID check reports it `Blocked` — but the point is we now know that before opening a browser, so the row is skipped outright and the captcha is never reached. A captcha on its own is a bot check, and the account may be perfectly fine.

**Unknown is never treated as dead.** If the checker is unreachable, times out or returns something unreadable, the row is kept and the reason is logged. Guessing "dead" there would throw away working accounts.

`--no-uid-check` skips the filter if you want the old behaviour.

## Password reuse rule

One bot password covers max 3 cookies and retires after 1 success. A gated/dead cookie is recorded in `out/skipped.jsonl` and the same password carries to the next cookie with no new Start. Used passwords are hashed in `out/used-passwords.json`.

## Ledgers (`out/`)

`sent.jsonl` = done, `skipped.jsonl` = never retry, `audit-*.jsonl` = replay log. Only cookie fingerprints are stored, never cookies.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `cookie is dead (confirmed twice)` | Login wall on both probes | Replace cookie, or `--force` to try anyway |
| `gated: SMS confirmation code` | Facebook wants a phone code | Not retryable; row stays skipped |
| `no password after 3 Start attempts` | Bot issued no credentials | Retry later; nothing was sent |
| `no button matches` | Provider relabelled a button | Read `on screen:` list, update matcher |
| `not on the main menu` | Stuck modal state | Auto-clears with Cancel 3x, then aborts group |
| `button stayed disabled` | New equals current / too short | Page hint is printed; check password |
| `Telegram connection dropped` | Network/auth conflict | Group stops; re-run (done rows skip) |
