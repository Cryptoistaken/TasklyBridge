# AGENTS.md — rules for working in this repo

Read this before changing anything. Every rule here exists because breaking it
has already happened, not because it sounds tidy.

**Facts about the provider live in `context.md`. Do not rediscover them here.**
**The API contract lives in `docs/api.md`. The dashboard's rules in
`docs/design.md`.** If code and a document disagree, the document is usually
right and the code is the bug — but check, because `docs/api.md` has been wrong
three times and a build passing proves nothing about either.

## Where it runs

| | |
| --- | --- |
| Dashboard | **https://opentask.up.railway.app** |
| Railway project | `TasklyBridge` — `5d244153-60e5-4ccc-9d5d-efb5d954a31c` |
| App service | `TasklyBridge` — `361b378a-c542-4f7e-8ccc-6fb9e1cfc35b` |
| Environment | `production` — `2882a7ab-5888-498f-a3ae-ff6f0f81d671` |
| Critical store | Neon `tasklybridge` — `lingering-lake-46859788` |
| Log store | Railway `Postgres` — `5e82eaf9-6fd3-42fc-b577-d97c75cf1611` |
| Our bot | `@OpenTasksBot` — id `8730058124` |

`railway` and `gh` are on PATH and authenticated. The Railway **CLI reads its
token from `user.token` in `~/.railway/config.json`**, not from
`RAILWAY_TOKEN`; the CLI was rejecting a perfectly valid token until that was
written there.

---

## The five rules that are never broken

### 1. Never run two copies of the bridge

Two processes sharing one MTProto session and one provider chat break each
other: one consumes the other's replies, and the provider reads the stray
message as a **cancel**. The visible symptom was an unhelpful *"could not read
the job list"*, which sent the investigation in the wrong direction for a while.

`Backend/lock.go` enforces this with an exclusive lock file. If startup reports
another bridge running, **stop that process** — do not delete the lock and
carry on. Telegram's own signal is `Conflict: terminated by other getUpdates
request`; that is fatal, not transient, so the loser backs off 60s rather than
retrying.

### 2. Never send a bare fragment to the provider

The provider matches on the **exact keyboard text**. Sending `Tasks` or `cookie`
matches no button and lands in its cancel handler.

```go
// wrong - this is what caused every "Action cancelled."
t.press("open Tasks", "Tasks")

// right - resolve the fragment, send the WHOLE label, refuse if no match
t.press("open Tasks", "Tasks")   // sends "📋 Tasks"
```

`press` resolves and refuses. **Never bypass that with `sendRaw`** for anything
button-shaped; `sendRaw` is only for commands like `/start` and for text
forwarded from a user.

### 3. Never let a claim stand unverified

This has already cost real time. A plan comment asserted *"the tool remembers
the screen from the last run"* — it was false, and three runs no-op'd before
the operator spotted it.

**Measure, don't assert.** Run it, read the log, then write the comment. Every
non-trivial change needs a self-test that fails without the fix.

### 4. Never block Telegram's read loop

The update handler must never block. A full channel **drops and counts** the
message; it never stalls. Same for the audit log: a failure there degrades to
console-only rather than taking the bridge down.

### 5. Never leak the provider's price to an end user

The provider price is **our cost and the basis of our margin**. It goes in the
audit log and to admins. It must never appear in a user-facing message or a
button label. `selfTestCatalog` asserts this.

Concretely: buttons read **`Facebook 2fa 5tk`** — our name and the static Taka
price. Message text is **`Available jobs`** and nothing else. No dollar signs,
no separator, no provider name.

### 6. Never substitute one provider job for another

`2FA:Create FB (No mail)` and `Create FB (2FA)` are different products at
different prices. Matching is by **`require_all`** — every listed term must
appear in the provider's name:

```json
{ "require_all": ["2FA:Create FB", "No mail"], "sell_bdt": 5 }
```

A single substring of `Create FB` matches both, and the wrong job gets sold
under the right name. When the real job is withdrawn, the catalogue must
resolve to **nothing** so users see "no jobs available". Returning the other
variant is the bug this rule exists to prevent.

**Price is deliberately not part of the match**, so the provider can move it
freely without breaking availability.

### 7. Never let a static price hide a loss

`sell_bdt` is static and cannot follow the market. `bdt_rate` exists solely so
`sellingAtLoss` can tell an admin when the provider's cost exceeds what we
charge. It is **never** shown to a user, and the displayed price never depends
on it. With `bdt_rate: 0` the check stays silent rather than inventing a
conversion.

Note the current arithmetic: at the job's earlier price of **$0.050**, cost is
about **5.20tk** against a **5tk** sell price. There is currently **no margin**.

### 8. Never send alerts to an end user

Price and availability alerts go to **`ADMIN_USER_IDS` only**. They state the
provider's cost, which is this bridge's margin. `botNotifier` refuses to send
when no admin is configured, so an alert fails loudly instead of leaking.

### 9. Never claim a UI works because a build passed

This is the rule that would have saved three fixes.

The login card sat in the top-left of the page for the whole life of the project.
The stylesheet had `.login { min-height: 100vh; place-items: center }` and the
code never created an element with that class, so the rule was **dead CSS**. Then
when the wrapper was added, grid placed the group above the middle because
`place-items` centres each item within its own auto-height row rather than the
group. Two real bugs, in the same place, both invisible to every check I ran:

```
tsc          clean
bun run build  clean
go vet       clean
gofmt        clean
go test      24 passing
```

**All of those verify the code is well-formed. None verify the page looks
right.** A dead CSS rule and a correctly-compiled program are indistinguishable
to all of them. Two screenshots found what the entire chain missed.

**So: look at it before saying it works.** Render it and check. When a class in
the stylesheet has no counterpart in the code, one of them is wrong — verify
which, do not assume. And when a brief says "run tsc and bun build", that is
the floor of the verification, never the ceiling.

A cheap static check that would have caught the first one: list every
structural class in the CSS, and confirm the code creates each one.

---

## Provider facts that will bite you

All of these cost debugging time. They are established, not guesses.

| Fact | Consequence |
|---|---|
| `getHistory` returns **0 messages**, always | Never read history to find a menu. Take the keyboard from the **live reply** to a press. |
| `/start` is the only way in | It re-sends the welcome and **resets state**, so a user mid-job would be dumped out. |
| The provider has a **modal state** | After `Start`, menu labels are read as cancel. `ensureMainMenu` proves it is on the main menu (looks for `Balance`) and clears with `❌ Cancel` if not. |
| The menu is a **reply keyboard** | Tapping = sending the label as text. No `callback_data` to route for menus. |
| **Prices move and jobs vanish** | `2FA:Create FB (No mail)` disappeared; the Cookies group went $0.0500 → $0.0480. Never hardcode the list. |
| **Absent ≠ free** | A job not listed must resolve to nothing, never to a price of zero. |
| **`Create FB (2FA)` is a DIFFERENT product** | From `2FA:Create FB (No mail)`. Never substitute one for the other. Match with `require_all`, never a single substring. |
| **The job we sell is currently not listed** | The catalogue correctly resolves to nothing. Users see "no jobs available", admins get an alert. That is correct, not a bug. |
| `Review time: 64 min` | Replies can arrive an hour later, possibly after a restart. |
| It asks for a **2FA secret key** | The biggest open risk. See `context.md` §4. |

---

## Two stores, split by write volume

Not tidiness. **Neon scales to zero when idle**, so a write on every
interaction keeps waking it and paying for the privilege, over an internet round
trip.

| Store | Holds | Why |
| --- | --- | --- |
| **Neon** (`DATABASE_URL`) | `accounts`, `users`, `sessions`, `alerts`, `withdrawals`, `price_baseline`, `job_availability` | Critical and infrequent. Deleting the whole Railway project must be recoverable from here |
| **Railway Postgres** (`LOGS_DATABASE_URL`) | `messages`, `audit` | The bulk of the writes, and the cheapest thing to lose: a transcript of things the accounts table already describes |

`sessions` holds the MTProto auth keys. **The blob is a live credential** — it is
never logged, never printed, never returned by an API, and never committed. Only
its size and presence are ever reported. `claude`-style mistakes here are
permanent account compromise, so the store is treated as a secret and the CLI's
plain output excludes it.

`LOGS_DATABASE_URL` falls back to the critical store when unset, so a
single-database setup still works.

## Concurrency

One MTProto client for the process. Telegram delivers updates **only to the
running client**, so a second client on the same session is blind and fights
over the auth key.

Two locks on `target`, for two different reasons — do not merge them:

- **`opMu`** held for a *whole operation* (`fetchTasks`, `joinTask`, `forward`).
  The price watcher and a user tapping a job both navigate the same chat, and
  overlapping navigations interleave into nonsense.
- **`seqMu`** guards the arrival counter only. It **must not** be `opMu`: the
  update handler bumps it while an operation holds `opMu` and is waiting for
  that same arrival. Sharing the lock deadlocks.

Every action stamps the sequence **before** sending, so only messages arriving
after that stamp count as the reply. A message that lands while idle must never
be read as the answer to the next action.

## Money

`POST /api/withdrawals` is the only endpoint that can spend, and the only place
in the codebase that sends a withdrawal amount.

- **Preview and execute are the same endpoint**, chosen by `confirm`. Two
  endpoints would mean the numbers an operator approves and the numbers that
  are used could come from different code paths.
- **Balances, fee and minimum are read live from the provider** on every call.
  The fee has already moved once ($0.025, minimum $0.20) and a stored copy would
  show an admin a number that is not what they will be charged.
- The wallet is **threaded as a parameter**, never a package variable. Two
  concurrent withdrawals would otherwise send one payout to the other's address.
- One withdrawal at a time, guarded by `withdrawing`. Two provider
  conversations interleaved could pay a wrong amount.
- **"created" is not "paid".** The provider confirms a request was created and
  never confirms arrival. Nothing in this system can prove the money landed.
- A **zero balance is ambiguous** — an empty account, or one nothing has read.
  It is reported as unread and never as `$0.0000`, and it marks any total it
  contributes to as incomplete.

## Secrets

Nothing sensitive is committed. `Backend/.env` and the Telegram session are
gitignored, and a scan of every staged file runs before each commit against the
live bot token, `api_hash`, the Neon password, the phone number, the Railway
token and the withdrawal wallet.

**That scan has caught four real leaks** — a phone number in a test file, a
wallet address in a test constant, and two others. It is not ceremony; it earns
its place. Test fixtures use synthetic values (`+15550100`, `0x1111…`).

---

## `gotd` v0.162.0

The schema is **newer than the classic one**. Before assuming an API shape,
check it:

```
go doc github.com/gotd/td/tg MessagesSendMessageRequest
```

The ones that will catch you out:

- Service methods are **flat**: `api.MessagesSendMessage(...)`, not `api.Messages().SendMessage(...)`.
- `NewClient(appID, appHash, Options)` — **no dispatcher argument**.
- Buttons are **not** an interface hierarchy: `KeyboardButton{Text, Type ButtonTypeClass}`.
- `InlineButtonTypeURL{URL string}` — capital `URL`, not `Url`.
- `UpdateNewMessage` is an `UpdateClass`, nested inside an `UpdatesClass`.
- `UpdateShortMessage.Message` is a **plain string**, not `*tg.Message`.
- `MessageEntityClass` gives `TypeName()`, `GetOffset()`, `GetLength()` — no switch needed.

---

## Working safely with the account

**The account is the product.** One registered phone number per end user, and
Telegram bans are permanent.

- **No bulk registration tooling.** Accounts are created by hand, slowly.
- **Throttle.** Every provider poll is 3 automated messages. `WATCH_INTERVAL`
  defaults to 15 minutes with a **5 minute floor**. Don't lower it to "just
  test something".
- **Never** automate `Withdraw`, or anything paying money. The probe's guard
  refuses destructive labels; `!click` overrides.
- The test account is in many channels. Keep the **allowlist** filter on the
  provider peer — a denylist let ~100 messages a run bury the transcript.

---

## Commands

```powershell
go build ./...                                  # both binaries
go vet ./... && gofmt -l .                      # must be clean
go run ./Backend -selftest                      # offline, no network, no login
go run ./Backend -list                          # read the provider's live job list
go run ./Backend                                # run the bridge
go run ./Test -selftest                         # probe checks
go run ./Test -login                            # sign in once, save session
go run ./Test -plan Test/plan.txt               # run a probe plan
```

`-selftest` needs no network and no login. **Run it before claiming anything
works.**

---

## Layout

```
Backend/
  main.go        config, MTProto lifecycle, run loop, self-tests
  taskly.go      everything that talks to the provider
  ourbot.go      our Bot API bot: /start, job buttons, /exitjob
  catalog.go     task.json: what we sell, our names, our prices
  watch.go       price and availability alerts
  store.go       who is in which job, survives restart
  audit.go       the four-leg interaction log
  lock.go        single-instance guard
  task.json      the sellable catalogue — edit this, not code
  .env           credentials (gitignored)
  out/           audit logs, state, price baseline, lock
Test/            throwaway probe (NOT part of the product)
context.md       provider facts, decisions, open questions
```

---

## Where things still need work

- **The job we sell is withdrawn by the provider.** `2FA:Create FB (No mail)` is
  not listed, so the catalogue correctly resolves to nothing and the bot offers
  no jobs. The provider's list churned within a single afternoon.
- **The account balance is $0.0000.** A live withdrawal will be refused by the
  provider's $0.20 minimum, which is correct behaviour. Top up before testing.
- **The 2FA secret handling is undecided.** The provider asks each worker for a
  TOTP seed — a live credential with no rotation. That is a security decision,
  not a coding one, and it is the largest open risk.
- **No multi-user.** One bound user, one account. The 1:1 model is enforced
  because the provider keeps per-chat state that cannot be shared.
- See `context.md` §10 for the full open list.
