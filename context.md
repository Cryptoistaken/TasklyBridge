# TasklyBridge — working context

Everything learned so far, so a new session does not have to rediscover it.
Facts only, with the evidence they came from.

**Status:** deployed and running at **https://opentask.up.railway.app**, with a
nine-page admin dashboard. One real Telegram account, bound to one test user,
selling one job. The account's balance is **$0.0000**, and the job we sell is
**not currently listed by the provider**, so the bot correctly offers nothing.

**Update log**
- v1 — probe learned the provider's menu and the 2FA key prompt.
- v2 — bridge built: our bot, audit trail, the label bug, price watcher.
- v3 — single-instance bug, the catalogue (`task.json`), static BDT pricing,
  `require_all` job matching, admin-only alerts, and a live finding that the
  job we sell is **currently not listed by the provider**.
- v4 — deployed to Railway, Neon for critical data and Railway Postgres for the
  high-volume logs, the operator CLI, and Telegram Login Widget auth.
- v5 — live balances, the full withdrawal flow with preview and SSE progress,
  session creation from the dashboard, and **two UI centring bugs** that every
  build check reported as green.

## Where it runs

| | |
| --- | --- |
| Dashboard | https://opentask.up.railway.app |
| Railway project / service | `TasklyBridge` · `5d244153-…` / `361b378a-…` |
| Critical store | Neon `tasklybridge` · `lingering-lake-46859788` |
| Log store | Railway `Postgres` · `5e82eaf9-…` |
| Our bot | `@OpenTasksBot` · id `8730058124` |
| Bound user | `1772093705` |
| Admins | `8447133985`, `1772093705` |

The Railway CLI reads its token from `user.token` in `~/.railway/config.json`,
**not** from `RAILWAY_TOKEN`; it rejected a valid token until that was written
there.

### Two stores, split by write volume

Neon scales to zero when idle, so a write on every interaction keeps waking it
and paying for the privilege. Neon holds the critical, infrequent data
(accounts, users, session blobs, withdrawals, alerts, price baselines) so
deleting the whole Railway project is recoverable. Railway Postgres holds the
message and audit logs: the bulk of the writes, and the cheapest thing to lose.

---

## 1. What this project is

A middleman for Telegram. An end user messages **our** bot; the bridge relays
that through a **real Telegram user account** to `@TasklyBux_bot`, and relays
replies back.

```
End user ──▶ @OpenTasksBot ──▶ bridge ──▶ real Telegram account ──▶ @TasklyBux_bot
   ▲            (Bot API)                    (MTProto)                  provider
   └──────────────────────────── replies ──────────────────────────────┘
```

### The constraint that forces the whole design

**A Telegram bot cannot message another bot.** The Bot API blocks bot-to-bot
sends. So the relay cannot use the Bot API — it needs **real user accounts over
MTProto**. That is why `gotd/td` is in the stack, and why accounts are the
scarce, risky resource.

---

## 2. Decisions locked

| Area | Decision |
|---|---|
| Location | `C:\Users\Ratul\Studio\Tools\TasklyBridge` |
| Backend | **Go**, one binary, both sides |
| MTProto | `github.com/gotd/td` **v0.162.0** |
| Our bot | **`@OpenTasksBot`** (id `8730058124`), webhook, no library |
| Dashboard | **React 19 + Vite + Tailwind v4 + shadcn/ui**, built by Bun to static files, served by Go (not built) |
| Database | **Neon Postgres** (new project) — not wired; JSON files stand in |
| Hosting | One Railway service, one process |
| Sessions | In Neon via `session.Storage`, not a Railway volume (not wired) |
| Scale | ~10 → 30 users, 30 treated as a hard ceiling |
| Binding | **1 account ↔ 1 end user** — the provider keeps per-chat state |
| Bound user | `1772093705` (also the MTProto account owner) |
| Job sold | **`2FA:Create FB (No mail)`** only, matched by `require_all` |
| Display price | **static `5tk`** on the button. No markup calculation |
| Message text | `Available jobs` only. Name and price live on the **buttons** |
| Currency shown | Taka (`5tk`). Provider cost stays in dollars, admin-only |
| Alerts | Telegram, to **admins only**, never end users |

### Why Go for the backend, Bun only for the build

One process. Go drives MTProto, the Bot API, and the storage layer. Bun only
*builds* the dashboard. Two backend runtimes would mean two processes, an IPC
channel and two crash paths — pure overhead at 30 users.

### Railway gotchas identified

1. **Sleep must be disabled** — a frozen service drops live MTProto connections.
2. **Sessions must not live on the container filesystem** — wiped every
   redeploy, logging every account out. Neon removes the need for a volume.

---

## 3. `gotd` v0.162.0 facts

These cost several build cycles. The schema is **newer than the classic one**.

| Fact | Detail |
|---|---|
| Constructor | `telegram.NewClient(appID int, appHash string, opt Options)` — **no dispatcher** |
| Options carry | `SessionStorage`, `UpdateHandler`, `Device`, `NoUpdates` |
| Service methods are **flat** | `api.MessagesSendMessage(...)`, **not** `api.Messages().SendMessage(...)` |
| Login | `auth.Client` → `Status`, `SendCode`, `SignIn(phone, code, codeHash)`, `Password` |
| 2FA detection | `auth.ErrPasswordAuthNeeded` |
| Session hook | `session.Storage` — the Neon integration point |
| Entities | `MessageEntityClass` gives `TypeName()`, `GetOffset()`, `GetLength()` — no switch needed |
| Buttons | **Not an interface hierarchy.** `KeyboardButton{Text, Type ButtonTypeClass}` |
| Callback data | `InlineButtonTypeCallback{Data []byte, RequiresPassword bool}` |
| URL buttons | `InlineButtonTypeURL{URL string}` — capital `URL` |
| Update families | `UpdateNewMessage` is an **`UpdateClass`**, nested in an `UpdatesClass` |
| Short updates | `UpdateShortMessage.Message` is a **plain string**, not `*tg.Message` |
| Only one client | Telegram delivers updates **only to the running client** |

---

## 4. What the provider does

All verified by observation.

### Main menu — a **reply keyboard**, no inline buttons

```
💰 Balance      📋 Tasks
📤 Withdraw     👤 Profile
🏆 Top          👥 My Referrals
🌍 Language
```

**The most useful discovery.** Every menu button is a plain text label with no
`callback_data`; tapping one is just sending its label. So the bridge needs **no
callback-token mapping table** for menus.

Inline callbacks do exist elsewhere: `my_rank` on a leaderboard screen.

### Live job list, as of 14:05 on 2026-09-28

```
📋 Tasks
├── 📱 Create Inst (2FA)  ($0.0180)
└── 🍪 Cookies ($0.0480)
      ├── 🐦 Create Twitter                     $0.0260
      ├── 🐦 Create Twitter (No follow)         $0.0270
      └── 🌟Create FB (2FA)                     $0.0480
```

### ⚠️ The job we sell is not on that list

`2FA:Create FB (No mail)` was present earlier today at **$0.0500** and is
**now absent**. The only Facebook entry is `Create FB (2FA)` at $0.0480 — a
**different product**, not a substitute.

With `require_all: ["2FA:Create FB", "No mail"]`, the catalogue correctly
resolves to **nothing**, so:

- users see *"No jobs are available right now"*
- admins get the availability alert

This is the designed behaviour, not a bug. Falling back to `Create FB (2FA)`
would sell a different product under the name "Facebook 2fa".

### Prices move and jobs vanish

- Cookies group: **$0.0500 → $0.0480** within one day.
- `2FA:Create FB (No mail)` vanished entirely.
- Never hardcode the list. Read it live, and treat *absent* as a third state
  distinct from *price changed*.

### ⚠️ Button labels must be sent whole

The provider matches **exact keyboard text**. Sending the bare fragment
`Tasks` or `cookie` matches no button, falls into its cancel handler, and
returns `👍 Action cancelled.`

```
press 📋 Tasks              {matched=Tasks}
press 🍪 Cookies ($0.0480)  {matched=cookie}
```

The bridge resolves the fragment against the on-screen keyboard, sends the
**full** label, and **refuses to send** if nothing matches. Found by the
operator, not by reading code.

### ⚠️ The provider has a modal state

Once a job is started, the provider sits in a task state where ordinary menu
labels are read as cancel. `ensureMainMenu` proves it is on the main menu (by
looking for `Balance`) and clears with `❌ Cancel` if not.

### `getHistory` returns nothing

**0 messages, every time**, regardless of limit. Never read history to find a
menu — take the keyboard from the **live reply** to a press.

### `/start` is the only way in

It re-sends the welcome and **resets state**, so a user mid-job would be
dumped out. The bridge must decide whether a user's `/start` forwards upstream.

### The target job page

```
⏳ Review time: 64 min ⏳
📋 Task: 🌟2FA:Create FB (No mail)
📄 Description: 🔐 REQUIRED!
   You must use the information provided by the Telegram bot to register.
❗ If you use your own information, your application will be REJECTED.

▶️ Start
📹 Video instruction
❌ Cancel
```

Clicking `▶️ Start` replies:

```
🔑 Please enter your 2FA key to get the code:
  ❓ How to set up 2FA?
  ❌ Cancel
```

### The biggest open finding

The provider asks the worker for their **2FA secret key** (the TOTP seed), not
a phone number, and generates the 6-digit codes itself.

- **End users must hand over a 2FA secret.** Anyone holding it can generate
  that account's codes indefinitely, with no rotation. This is the biggest
  trust and security question in the product.
- The relay carries **free-form secret text**, so logging must treat it
  accordingly.
- **No credential message has ever been seen**, because the flow stops at the
  key prompt. The password extraction is deliberately **not** written: a regex
  matching nothing, presented as a parser, is worse than forwarding the
  provider's words verbatim. The bridge forwards the reply untouched.

### Confirmed stateful

- Balance is per-user. **$0.3750** was the last verified figure.
- Rank and execution count are tracked: `🏅 You are in 1413 place (5 executions).`
- Therefore **one account per end user is mandatory.**

### Asynchronous review

`Review time: 64 min` means a reply can arrive **an hour later**. The bridge
must survive an idle period, a restart and a redeploy.

### Never inspected

- `📤 Withdraw` — on the destructive list; the guard refused it every time.
- `📹 Video instruction` — a video, which cannot be read. The on-page report
  instruction is literally `.`, so the video likely holds the real steps.

---

## 5. The catalogue (`Backend/task.json`)

The bridge's commercial layer: which jobs we sell, what we call them, and what
users pay. **Edit this file, not code.**

```json
{
  "jobs": [
    {
      "require_all": ["2FA:Create FB", "No mail"],
      "name": "Facebook 2fa",
      "sell_bdt": 5,
      "group": "cookie",
      "enabled": true
    }
  ],
  "bdt_rate": 104
}
```

| Field | Meaning |
|---|---|
| `require_all` | **every** term must appear in the provider's name. This is the job's identity |
| `name` | what users see. Falls back to the provider's name if empty |
| `sell_bdt` | the static Taka price shown on the button |
| `group` | which provider sub-menu holds it |
| `enabled` | `false` hides a job without deleting it |
| `bdt_rate` | used **only** to warn admins about losses. Never shown to users |

### Why `require_all` and not one substring

The provider lists near-identical products:

```
2FA:Create FB (No mail)   <- we support this one
Create FB (2FA)          <- a DIFFERENT product
```

A single substring of `Create FB` matches both, and the wrong job would be sold
under the name "Facebook 2fa". Requiring **every** term means the provider's own
wording decides availability, and **price is free to move** because it is not
part of the match. Verified by self-test in both directions.

### The static price, and the loss it can hide

`sell_bdt: 5` is **static**. It was chosen when the provider cost was about
$0.048, which at 104tk/$ is **4.99tk** — a hair under 5tk.

At the price the job was listed at earlier, **$0.050**, the cost is
**5.20tk**, which is **over** the 5tk we charge. So:

- `bdt_rate` exists purely to catch this: `sellingAtLoss` compares the provider
  cost against `sell_bdt` and alerts **admins only** when we are underwater.
- With `bdt_rate: 0` the check is silent rather than guessing a conversion.

**There is currently no markup.** The bridge resells at cost, so the only
margin is whatever `sell_bdt` exceeds the provider price by. At $0.050 that
margin is **negative**.

### Display rules

- Message text: **`Available jobs`** — and nothing else.
- Buttons only: **`Facebook 2fa 5tk`**. No separator, no dollar sign.
- The provider's dollar price is a **cost** and must never reach a user
  (`AGENTS.md` rule 5; asserted by `selfTestCatalog`).

---

## 6. The bridge (`Backend/`)

| File | Responsibility |
|---|---|
| `main.go` | config, MTProto lifecycle, run loop, self-tests |
| `taskly.go` | everything that talks to the provider |
| `ourbot.go` | our Bot API bot: `/start`, job buttons, `/exitjob` |
| `catalog.go` | `task.json`: what we sell, our names, our prices |
| `watch.go` | price and availability alerts |
| `store.go` | who is in which job, survives restart |
| `audit.go` | the interaction log |
| `lock.go` | single-instance guard |
| `task.json` | the sellable catalogue |

### User flow as built

1. `/start` → `Available jobs` + one button per supported job
2. Tap → **✅ You have joined *Facebook 2fa* task** + `Price: 5tk`, plus a
   `🚪 Exit job` button. Persisted to disk.
3. The bridge drives the provider: knock → `📋 Tasks` → `🍪 Cookies` → job → `▶️ Start`
4. Whatever the provider says is forwarded **verbatim**
5. The user stays in the job — every message is relayed upstream — until `/exitjob`
6. Non-bound users are told plainly that no account is free

### The audit trail

Every interaction, both directions, both sides, in
`Backend/out/audit-<date>.jsonl` and the console.

| Leg | Meaning |
|---|---|
| `user->bot` | an end user pressed a button or sent text |
| `bot->user` | our bot replied |
| `bot->taskly` | our bot drove the real account |
| `taskly->bot` | the provider answered |
| `internal` | connection, errors, poll results, filtering, cost lines |

### Reply attribution

Arrivals carry a sequence number, and every action stamps the counter before
sending. Only messages arriving **after** that stamp count as the reply, so a
message landing while idle is never mistaken for the answer to the next action.

### Price and availability alerts

Polls the live list on an interval and alerts **admins only**:

| Event | Alert |
|---|---|
| price moved | `💰 <job> price changed $0.0500 -> $0.0480 (-4.00%)` |
| job appeared | `🆕 <job> is available again at $0.0480` |
| job gone | `❌ <job> is no longer listed (was $0.0500)` |
| **supported job absent** | `🚨 <job> is NOT available right now. The provider is not offering it, so the bot will show no jobs.` |
| **supported job back** | `✅ <job> is available again: Facebook 2fa 5tk (provider cost $0.0500)` |
| **selling at a loss** | `⚠️ <job> costs about 5.2tk at the provider but we charge 5tk. We are losing money on it.` |

- The **first snapshot is recorded silently**; a restart does not re-announce.
- Baselines persist in `out/prices.json` and `out/availability.json`.
- **Default interval 15 minutes, 5-minute floor.** Each poll is three
  automated messages; polling fast is how an account gets banned. Jitter is
  added so a fixed interval is not a machine signature.

---

## 7. The probe (`Test/`)

Throwaway tool for learning the provider. **Not part of the product.**

### Design rules

1. **No blind actions, no sleeps.** Each action waits for the real reply and
   returns when the bot goes quiet (`TG_QUIET`, default 0.35s).
2. **Every action prints the resulting screen** — reply plus every clickable
   label — so the next plan line comes from facts.
3. **A plan is a file.** A blind crawler was written and then deleted for this.
4. **Screen persistence** to `Test/out/screen.json`, atomic, keyed on the bot
   username, refused if corrupt or from another bot.

### Plan language

`note`, `click`, `!click`, `text`, `pressdata`, `shot`, `history`. Deliberately
**no `wait`** — raise `TG_REPLY_TIMEOUT` instead. A `click` matching nothing is
not fatal: it prints the live labels and continues.

### Speed

Pre-action gap 2.5s → **0.4s**, skipped entirely on the first action; reply
settle 1.5s → **0.35s**. A 4-step plan went from **14s to ~4s**.

The floor was not deleted: those delays exist because Telegram bans accounts
for rapid automated sends, and accounts are the scarcest resource here.

---

## 8. Accounts, money, environment

| Item | Value |
|---|---|
| Test account | **MD REZAUL ISLAM RABBI**, `+8801XXXXXXXXX`, id `1772093705` |
| Provider peer | `user:8661341341` |
| Our bot | `@OpenTasksBot`, id `8730058124` |
| Session | `Test/sessions/probe.session` (gitignored) |
| Balance last **verified** | **$0.3750** |
| Total spent | **$0.05** — one `▶️ Start` on `2FA:Create FB (No mail)` |
| Balance **after** Start | **not verified.** No Balance check was sent, on request. It is unknown whether the provider debits at Start or only on completion |

Credentials live in `Backend/.env` (gitignored) with `.env.example` committed.
Deliberately **not** in the global `MEMORY.md`.

---

## 9. Bugs found and fixed

Each was found by running the thing, not by reading it.

**Probe**
1. **Chat filter was a denylist** — let ~100 channel messages per run bury the
   transcript in 6000 lines. Fixed to an **allowlist**.
2. **A cold run could not click anything** — button memory was process-local
   and history is empty, so three runs no-op'd. Fixed with screen persistence.
3. **Saved buttons serialised as `{}`** — unexported struct fields.
4. **The stale-screen guard could never fire** — keyed on the numeric bot id,
   which is `0` when the first screen is written. Re-keyed on the bot username.
5. **Screen write was not atomic.** Now temp-file + rename.
6. **`shot` blocked for the full timeout.** Reading a screen never waits now.
7. **Every reply written to the transcript twice.** One authoritative copy now.
8. **My own regex mistakes** — an inverted lookbehind matched nothing, and one
   pass mangled an unrelated local variable.

**Bridge**
9. **Bare labels sent instead of full button labels** — found by the operator.
   The root cause of every `👍 Action cancelled.` Now resolves and sends the
   whole label, refusing when nothing matches.
10. **Task list read from `getHistory`**, which returns 0 on this chat. Now
    read from the live reply.
11. **Modal state not cleared before navigating.** Now proves it is on the main
    menu first.
12. **A new MTProto client per update** would stack connections. Now one client
    for the process.
13. **Replies not attributed to actions** — arrivals now carry a sequence.
14. **A leftover duplicate line in `compare`** made the first snapshot announce
    every job as appeared. Caught by a self-test.
15. **Two bridge instances ran at once.** They shared one MTProto session and
    one provider chat: one consumed the other's replies, and the provider read
    the stray message as a cancel. The visible symptom was an unhelpful
    *"could not read the job list"*, which sent the investigation sideways.
    Fixed with a lock file, a 60s backoff on Telegram's `Conflict: terminated
    by other getUpdates request`, and splitting the two locks into `opMu`
    (whole operation) and `seqMu` (counter only, or it deadlocks).
16. **`task.json` silently loaded zero jobs** because it still had the old
    `match` key and JSON ignores unknown keys. Caught by a self-test that
    requires the shipped catalogue to match a live job.
17. **The login page posted to `/api/login`, which does not exist.** The
    frontend was built against an early password contract; the backend had
    already switched to the Telegram widget. **Nobody could sign in at all.**
    Found by reading the page, not by a test.
18. **The dashboard shell was gated behind auth**, so the login page needed a
    session to be reached. A lockout dressed up as a security measure.
19. **Two UI centring bugs, both invisible to every check.** The stylesheet
    had `.login { min-height: 100vh; place-items: center }` and no element
    ever carried that class, so the rule was dead for the whole life of the
    project. After adding the wrapper, grid still placed the group above the
    middle, because `place-items` centres each item in its own auto-height row
    rather than the group. `tsc`, `bun run build`, `go vet`, `gofmt` and 24
    unit tests were green throughout. **Two screenshots found what the whole
    chain missed** — now `AGENTS.md` rule 9.
20. **My own kill command never matched the process.** The pattern
    `^(go|bridge)\.exe$` does not match `Backend.exe`, so a stale instance
    survived, kept the `getUpdates` lock, and quietly degraded production for
    twenty minutes while I debugged the wrong thing. Startup now refuses to
    run when another instance already holds that lock.
21. **The login callback was wired and the token was never read.** The official
    widget does not hand the token to a JavaScript callback in the usual flow:
    it navigates away to Telegram and returns with the result in the URL
    fragment as `#tgAuthResult=<base64url>`. `window.onTelegramAuth` was
    declared, named in `data-onauth` and assigned — and never fired. Login
    looked completely dead: approve in Telegram, come back, nothing happens, no
    error, no network request. `tsc` and `bun run build` were both clean,
    because the code was well-formed and simply never called. Fixed by reading
    the fragment on load, base64url-decoding it and exchanging it, with the
    callback kept as a second path. The shape came from SheetSubmit's
    `LoginScreen`, and **reading the working reference is what surfaced it** —
    I had guessed the API from memory twice and guessed wrong twice. This is
    rule 9 again: a wired handler is not a reached one.
22. **The single-instance lock lived on a Railway volume, so no deploy could
    ever start.** Railway runs the new container alongside the old one and only
    moves traffic once the new one is healthy, so the new container found
    `bridge.lock` on `/data`, `O_EXCL` failed, and the process exited on the
    first line of `run()`. The deployment sat in INITIALIZING for ten minutes
    with **no log output at all** while the previous version kept serving
    `healthz`. The two tells were the lock file being visible in
    `railway service files ls /data/out` and every log line carrying the *old*
    deployment's timestamps. The lock now lives in the OS temp directory, which
    is the right scope for it anyway: two bridges on one machine.
23. **The two stores were wired backwards, and the label hid it.** Production
    ran with `DATABASE_URL` pointing at Railway Postgres while `NEON_DATABASE_URL`
    sat set and unread. `-status` printed `critical (Neon)` throughout, so the
    one command meant to report the configuration was confidently wrong about
    the store holding the session. Meanwhile Railway Postgres lost every table
    when its own deployment failed, so the flip to Neon was not tidiness — it
    restored the only surviving copy of the MTProto session.
24. **The split has no writer on the log side.** `messages` and `audit` are
    declared in the schema and nothing inserts into either; the audit is a JSONL
    file on the volume. So the Messages page was always empty, and the
    high-volume-write problem the split exists to solve is not happening. Both
    stores now come from one constant instead of two literals, but the honest
    answer for now is a single Neon database.
25. **A number that was never known, presented as a real one - four times over.**
    This is the bug class that cost the most, and it wore a different disguise
    each time:
      - `GET /api/overview` omitted `provider_cost` and `margin_bdt` entirely,
        and the page called `toFixed` on undefined: a white screen
      - `/api/tasks` sent `provider_price: 0.0` and `margin_bdt` equal to the
        sell price, so the Tasks page showed the provider giving the job away
        free and `selling_at_loss` could never be true
      - `jobAvailable()` read the `job_availability` table, which nothing has
        ever written - the watcher writes `availability.json` - so every job
        read as UNAVAILABLE from an empty table
      - and after fixing that, my own reader treated a withdrawn job's timestamp
        as proof its zero cost was known, which would have shown a fabricated
        +5.00tk margin on a job nobody can buy
    The fix that holds is `*_known` flags plus a dash for unknown, in the API and
    in `usd()`/`bdt()`. A zero cost reads as a profit; absence has to look like
    absence.
26. **`checkSupported` existed, was documented as though it ran, and had no
    caller.** So the "job unavailable" admin alert had never fired and the
    snapshot the dashboard depends on had never been written. Dead code with a
    convincing comment is worse than no code, because the comment is what stops
    anyone looking. The alerting rule in `AGENTS.md` was true on paper only.
27. **The dashboard moved from vanilla TypeScript to React 19 + shadcn/ui, and
    from a hash router to real paths.** The URL read `/#/accounts`, which reads
    as a mistake in the address rather than as a routing choice.
    `BrowserRouter` needed nothing from the server, because `dashboardHandler`
    already fell back to `index.html` for unknown paths - written for the hash
    router and exactly what a real router needs. That fallback is load-bearing
    and is now called out as such. The cost is real and stated: 41 KB of
    hand-rolled DOM became 301 KB of React, 96 KB gzipped, for an admin panel
    with a hard ceiling of 30 users.

### A process failure worth recording

A plan comment asserted *"the tool remembers the screen from the last run"* and
was run without checking. It was false. Three runs and about $0.00 later, the
operator asked why the plan restarted from the beginning, which exposed it.
**Verify a claim before putting it in a comment the next run depends on.** The
lesson recurred: the speedup was measured rather than asserted, and every fix
since carries a self-test.

---

## 10. Open questions

**Provider**
1. **What are the real task steps?** The video is unwatched and the on-page
   instruction is empty.
2. **Does the charge land at `Start` or at completion?**
3. **What is the rejection rate?** Rejections are presumably not refunded, which
   makes the real cost per *accepted* job unknown.
4. **What comes back after supplying a 2FA key?** Is that the credential?
5. **Will `2FA:Create FB (No mail)` come back?** It vanished today.
6. **What is on the `📤 Withdraw` screen?** Never inspected.
7. **Does the 64-minute review produce a reply that must be relayed?**

**Product**
8. **How are 2FA secrets handled?** The largest open risk.
9. **Is there any margin at all?** Currently none: static 5tk against a cost
   that reached 5.20tk.
10. SMS or Telegram for alerts? Telegram is built.
11. One `api_id` for all accounts, or one per account?
12. Do end users get told this is a third-party relay?
13. Dashboard auth: password or Telegram Login Widget?
14. How many accounts can be registered this week? Currently exactly one.

---

## 11. Risks worth keeping visible

- **Accounts are the real limit.** One registered phone number per end user.
  30 users means 30 accounts.
- **Bans are permanent.** The dashboard's most important job is warning which
  account is about to die.
- **A 64-minute review window** means long-lived idle state — the hardest thing
  to keep correct across restarts and redeploys.
- **A static price cannot follow the market.** Only the loss check stands
  between a provider price rise and silently selling below cost.
- **Datacenter IPs** (Railway) are treated more harshly by Telegram.
- **A single `api_id` across all accounts** correlates every account.
- **The accounts created via this flow are a compliance exposure**, and a
  bridge multiplies it across other users' accounts.
- **State lives in JSON files**, not Neon. Fine for one user, wrong for thirty.
