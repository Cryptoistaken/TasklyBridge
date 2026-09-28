# Test — bot format crawler

Throwaway tool. One job: work out how a Telegram bot actually behaves, so the
real bridge is built against facts instead of guesses.

It signs in as a real account, opens the chat, **crawls the bot's menus by
itself**, and writes a format report the backend can be built against.

Nothing about any particular bot is hardcoded. The target, limits and probe
text all come from the environment, so the same tool works on any bot.

## Run

Two steps. You do the first, the tool does the rest.

**1. Make the session** — run this once, in a real terminal, paste the code
Telegram sends the account:

```powershell
cd C:\Users\Ratul\Studio\Tools\TasklyBridge
go run ./Test -login
```

It signs in, saves the session, and stops. No message is sent to any bot.

**2. Crawl the bot** — afterwards, and any time you want:

```powershell
go run ./Test -crawl-only
```

That crawls the menus, writes the report and exits, so it can be run unattended.

| Flag | Effect |
| --- | --- |
| `-login` | sign in, save the session, exit. Does not contact the bot |
| `-crawl-only` | crawl, write the report, exit. No interactive prompt |
| `-no-crawl` | skip the crawl, just the interactive prompt |
| `-selftest` | offline checks, no network and no login |
| *(none)* | crawl, then hand over to an interactive prompt |

## What it does, in order

1. Sends `/start`, records the reply
2. Probes free text (`hi` by default) — some bots only answer buttons
3. Breadth-first walk of every button it finds, pressing each one and following
   the buttons that appear, to a depth cap
4. **Statefulness test** — sends a random nonce, re-runs a command, checks
   whether the nonce comes back. This answers "does the bot remember this user"
   by observation rather than guesswork
5. Writes `Test/out/report.md`

## Safety rails

An unattended run against a real account needs limits, so it only ever does two
things: **send text**, or **press a button by its raw `callback_data`**.

- **Destructive buttons are never pressed.** Anything containing
  delete/remove/pay/buy/confirm/withdraw/cancel/reset and similar is logged as
  *skipped*, not clicked. Override with `TG_ALLOW_RISKY=1` if you want it to.
- **It will not share anything.** Web-view, "share phone number" and
  "share location" buttons are reported, never triggered.
- **It is rate-limited** to one action every 2.5s, and aborts on `FLOOD_WAIT`.
- It stops at 40 actions or depth 3, whichever comes first.

Nothing irreversible can be triggered without you seeing it in the report first.

## Output

Rewritten every run, so each run is one clean set of files.

| File | What it is |
| --- | --- |
| `Test/out/report.md` | **start here** — verdict, action log, button inventory, what the backend must do |
| `Test/out/transcript.txt` | every message in full, human readable |
| `Test/out/transcript.jsonl` | same data, one JSON object per line |

A transcript entry looks like:

```
2026-09-28 12:00:01  IN  id=1234  peer=user:777
   text: Choose a task
   fmt:  messageEntityBold[0:6]
   btn:  r0 c0 inline callback text="Add" data="task:add" hex=7461736b3a616464 needs_password=false
   btn:  r1 c0 inline url text="Help" -> "https://example.com"
```

`data=` is the button's callback payload, `hex=` the same bytes for when they
do not print. Anything unrecognised prints as `UNKNOWN <type>` rather than
being dropped — a silently missing button is the failure that costs hours.

## Settings

All optional, read from `Test/.env` or the real environment.

| Variable | Default | Meaning |
| --- | --- | --- |
| `TG_TARGET` | *required* | bot to explore, e.g. `tasklyBux_bot` |
| `TG_MAX_STEPS` | `40` | hard cap on actions |
| `TG_MAX_DEPTH` | `3` | how deep into menus to follow buttons |
| `TG_DELAY` | `2.5` | seconds between actions |
| `TG_REPLY_TIMEOUT` | `12` | seconds to wait for a reply before moving on |
| `TG_ALLOW_RISKY` | `0` | set `1` to allow destructive buttons |
| `TG_PROBE_TEXT` | `hi` | free-text probe message |
| `TG_PROBE_COMMANDS` | — | comma list, e.g. `/help,/menu` |
| `TG_HISTORY` | `20` | existing messages to dump first, `0` to skip |

`Test/.env` and the session file are gitignored. Do not commit them.
