# index.js — every command, flag and method

The submitter for `2FA:Create FB (No mail)`. Single file, run with `bun`.

```
cd Tool
bun index.js --help          # built-in usage, always current
```

Nothing sensitive is ever printed. Cookies appear only as a 12-char fingerprint,
UIDs as `***last4`, passwords as a character count.

---

## Modes

Exactly one mode runs per invocation. The first one that matches wins.

| Mode | Command | Spends? | What it does |
| --- | --- | --- | --- |
| **Run** | `bun index.js --xlsx a.xlsx --row 5 -p <phone> -o <pw>` | yes | The real thing: Telegram walk → Facebook password change → submit |
| **Batch** | `bun index.js --xlsx a.xlsx b.xlsx --all` | yes | Same, over every unsent row, 3 per Telegram session |
| **Login** | `bun index.js --login <phone>` | no | One-time Telegram sign-in, writes the session file |
| **Task check** | `bun index.js --check-task` | no | Is the job listed right now? Walks the real menu |
| **Verdicts** | `bun index.js --check-verdicts` | no | Approved / rejected / pending for everything sent |
| **Selftest** | `bun index.js --selftest` | no | Offline. Message parsing + verdict FIFO round trip |
| **Codegen** | `bun index.js --codegen --xlsx a.xlsx --row 5` | no | Opens the browser on that row and pauses for the inspector |
| **Detect** | `bun index.js --codegen --detect --xlsx a.xlsx --row 5` | no | Walks every screen and names them, types nothing |
| **Check password** | `bun index.js --check-pw --xlsx a.xlsx --row 5 -o <pw>` | no | Fills the form, proves the button enables, never submits |
| **Refresh cookie** | `bun index.js --refresh-cookie --xlsx a.xlsx --row 5 -o <pw>` | no | Logs in once, retests the issued cookie, compares |
| **Help** | `bun index.js --help` / `-h` | no | Usage |

### Exit codes

`0` success · `1` failed / unavailable / not listed · `2` bad usage (implicit).

---

## Flags

### Selecting work

| Flag | Default | Meaning |
| --- | --- | --- |
| `--xlsx <file...>` | — | Sheet(s). Repeatable, comma-separated or space-separated. Falls back to `data/<name>` |
| `--row <n>` | `1` | Which row of the sheet |
| `--rows f#r,other#r` | — | Internal. Used by the batch runner to hand a group to a child process |
| `--all` | off | Every unsent row across the sheets |
| `--per-session <n>` | `3` | Accounts per Telegram session. One bot password covers 3 cookies |

Sheet layout: **column A = cookie, column B = 2FA key.** Row 1 is data, not a header.

### Credentials

| Flag | Default | Meaning |
| --- | --- | --- |
| `-o`, `--current-password <pw>` | `FB_CURRENT_PASSWORD` | The account's **own current** Facebook password. Needed for the re-auth step, not just the change |
| `-P`, `--password <pw>` | generated | The password to set. Normally the bot's; `--check-pw` generates a throwaway |
| `--fa2 <key>` | sheet column B | Override the 2FA key for this row |
| `-p`, `--phone <n>` | `TG_PHONE`, else the only session | Which Telegram session to use |
| `--login <phone>` | — | Sign in and save the session, then exit |

### Behaviour

| Flag | Meaning |
| --- | --- |
| `--plan` | Grouping only. **Nothing runs, nothing is spent.** Still records dead accounts |
| `--force` | Retry rows already in `sent.jsonl` / `skipped.jsonl` |
| `--dry-run`, `--probe` | Walk to Start, print the credentials, stop before Facebook |
| `--no-uid-check` | Skip the account-liveness filter |
| `--write-back` | With `--refresh-cookie`: save the new cookie into the sheet (makes a `.bak`) |
| `--hold` | On any unrecognised screen: dump the page and **keep the browser open** |

---

## The usual sequence for a sheet

```powershell
# 1. What have we got? Free — reads sheets, one API call, no Telegram or browser.
bun index.js --xlsx data\2fa49.xlsx --all --plan

# 2. Make cookies trustworthy. Optional for correctness, but it is what protects
#    you from the provider's timer: it takes the Continue/re-auth hops to zero.
bun index.js --refresh-cookie --xlsx data\2fa49.xlsx --row 6 -o <pw> --write-back

# 3. Is the job even listed? Free.
bun index.js --check-task

# 4. The real run. Start with --per-session 1: it has never run end to end.
bun index.js --xlsx data\2fa49.xlsx --all -p <phone> -o <pw> --per-session 1

# 5. What actually happened? The verdict arrives up to 64 min later.
bun index.js --check-verdicts
```

---

## Files

| Path | What |
| --- | --- |
| `data/*.xlsx` | The accounts. **Gitignored.** A `.bak` appears beside any sheet written to |
| `sessions/*.session` | Telegram auth keys. **Gitignored.** A live credential |
| `profile/` | Chrome profile. **Gitignored** |
| `out/sent.jsonl` | Rows we submitted and got a receipt for |
| `out/skipped.jsonl` | Rows never to retry: SMS-gated, dead account, dead cookie |
| `out/pending.json` | Submitted, verdict not back yet |
| `out/verdicts.jsonl` | Every verdict, paired to a row by order |
| `out/audit-<date>.jsonl` | Full four-leg interaction log |
| `out/used-passwords.json` | Hashed, so a bot password is never reused |
| `.env` | **Gitignored** |

---

## Exported API

Importable from `index.js`. Exported so they can be tested directly.

### Errors

| Symbol | Meaning |
| --- | --- |
| `Bail` | Base. A known, expected stop |
| `BailLogged` | Already reported to the user — do not log it twice |
| `BailGated` | An SMS gate. The cookie is **valid**; the account is recorded as gated, never retried |

### Data

| Symbol | Meaning |
| --- | --- |
| `readAccounts(file)` | Rows from a sheet: `{row, cookie, fa2Key}`. Resolves bare names to `data/` |
| `parseCookies(cookieString, domain)` | Cookie header → Playwright cookie objects |
| `parseRows(raw)` | `a.xlsx#5,b.xlsx#9` → `[{file, row}]` |
| `fingerprint(cookie)` | 12-char SHA-256. The only safe way to refer to a cookie |
| `parseCreds(replies)` | `First name: … Last name: … Password: …` → object |
| `parseVerdict(text)` | A provider message → `{verdict, amount?, reason?, accountBlocked?}` or `null` |
| `argValue(args, names)` | `--flag value` or `--flag=value` |
| `resolveUrl()` | The target page from `TARGET_URL` |
| `normalizePhone(phone)` | `+880 (1) 84…` → `+8801 84…` |
| `listSessions()` | Phone numbers with a saved session |
| `textFrom(update)` | gramJS update → `{text, msg}` |

### Liveness

| Symbol | Meaning |
| --- | --- |
| `checkUid(cookie)` | `{uid, status: valid\|dead\|unknown, message}`. `check.fb.tools`, no cookie sent |
| `checkUids(uids)` | Same, up to 500 at once. Returns a Map |
| `isCookieDead(cookie)` | Probes accountscenter, confirms twice 3s apart. A single DEAD can be transient |
| `listSessions()` | As above |

**`unknown` is never treated as dead.** An unreachable checker keeps the row.

### Facebook

| Symbol | Meaning |
| --- | --- |
| `changePassword({context, currentPw, newPw, targetUrl, dryRun})` | The whole screen walk + fill. `dryRun` stops with the button enabled and never clicks it |
| `codePromptVisible(page)` | An SMS / confirmation-code prompt is up, anywhere including iframes |
| `blockingDialog(page)` | A dialog covers the form |
| `changeFacebook(...)` | Launch, load the cookie, run the above, close |

### Telegram

`class Taskly`

| Method | Meaning |
| --- | --- |
| `Taskly.open({phone})` | Connect, sign in if needed, resolve the provider, install the verdict watcher |
| `t.close()` | Disconnect |
| `t.isConnected()` | Liveness check |
| `t.ensureMainMenu()` | `/start` until Balance appears, clearing modal state with `Cancel` if needed. Returns replies |
| `t.press(what, want)` | Press a button by **fragment**; sends the whole label or throws. Never sends a bare fragment |
| `t.sendRaw(what, text)` | Send literal text (`/start`, the 2FA key, the cookie) |
| `t.obeyRateLimit(replies)` | Wait exactly as long as the provider said. Returns `{replies, waited}` |
| `t.isTaskCancelled(replies)` | The provider's own timer expired — the account is already lost |
| `t.noteActionCancelled(replies)` | Confirms *our* Cancel worked. Expected, not a failure |
| `t.freshSince(afterId, limit)` | Messages received after an id, oldest first |
| `t.latestId()` | Newest message id, used to stamp a read window |
| `t.labels()` | Every button label seen recently |
| `t.resolveLabel(want)` / `t.hasButton(want)` | Label matching |
| `t.resetWindow()` | Forget the seen-buttons buffer between rows |
| `t.listen(seconds)` | Collect replies for a fixed window |
| `t.installVerdictWatcher()` | Permanent listener that records verdicts |

---

## Screens the walk understands

| Screen | Handling |
| --- | --- |
| Password change form | Fill and change (or stop, with `--check-pw`) |
| Account chooser sheet | Pick by `Facebook` label, then by name |
| `Continue` interstitial | Click it |
| Re-auth password form | Type the account's **own** password, click `Log in` |
| Save login info | Click `Save` |
| SMS / confirmation code | Gated. Valid cookie, recorded, never retried |
| CAPTCHA | **Not solved.** Stops and says so; the row is *not* marked dead |
| Human check ("confirm you're human") | One `Continue` click, then the CAPTCHA check |
| `/checkpoint/` says disabled | Banned → `skipped.jsonl`, never retried |
| `/checkpoint/` says confirm identity | Challenge — wait for a human |
| Logged out | Cookie dead |
| Anything else | Screenshot + page text, retried next run (`--hold` keeps the browser open instead) |

---

## Provider replies that are not failures

| Message | Meaning |
| --- | --- |
| `You are making requests too often. Please wait 9 sec.` | Wait exactly that long, then press again |
| `Time's up! Task cancelled.` | The **provider's** timer, minutes not seconds, length varies |
| `Action cancelled.` | **Ours** — the `Cancel` button cleared a modal state |
| `Report approved, +$0.05` | The real outcome, up to 64 min later |
| `Report rejected: account blocked` | The account is dead. Reported, **not** auto-skipped — the row pairing is FIFO |
| `Your report has been received! Please wait` | A **receipt**, not the outcome |

---

## Environment

| Variable | Meaning |
| --- | --- |
| `TG_API_ID`, `TG_API_HASH` | Telegram app credentials. Read from `Backend/.env` or `.env` |
| `TG_TARGET` | The provider. Default `tasklyBux_bot` |
| `TG_PHONE` | Default session to use |
| `TARGET_URL` | The Facebook page |
| `COOKIE_DOMAIN` | Default `.facebook.com` |
| `TASK_GROUP`, `TASK_NAME` | Which job to look for. **Every term must match** — `Create FB (2FA)` is a *different* product and must never be substituted |
| `FB_CURRENT_PASSWORD` | Default for `-o` |
| `CHECK_URL` | Override the UID checker |
| `TOOL_DEBUG=1` | Per-tick wait tracing |

---

## Not handled, on purpose

- **The CAPTCHA.** It exists to stop a program. No image reading, no audio
  transcription, no code lookup. Do not "fix" this.
- **Auto-skipping a rejected report.** The verdict carries no identifier, so rows
  are paired by arrival order. If that pairing is ever off by one, skipping would
  discard a good account. `--check-verdicts` prints the fingerprints instead.
- **The 6-digit one-time code** the provider sends after every 2FA key. Generated
  from the key, and we change the password instead, so it is not needed.
