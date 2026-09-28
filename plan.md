# TasklyBridge — development plan

Where the project is, what comes next, and what is deliberately not being built
yet. Companion to `context.md` (facts) and `AGENTS.md` (rules).

**Last updated:** 2026-09-28, after the balance and withdraw inspections.

---

## Where we are

**Deployed and running** at https://opentask.up.railway.app, with a nine-page
admin dashboard behind Telegram Login Widget auth. One real account bound to one
test user.

Shipped and working:
- our bot `@OpenTasksBot` receives `/start` and shows the catalogue as buttons
- tapping a job joins it, drives the provider, and forwards the reply
- `/exitjob` leaves; state survives a restart
- every interaction is audited on all four legs
- price and availability alerts go to admins only
- **sessions**: created from the dashboard (phone → code → 2FA), listed with
  balances, deletable
- **withdrawals**: preview then execute on one endpoint, per-account lines, a
  totals block, and live SSE progress
- the operator CLI drives status, jobs, both stores, the catalogue and deploys

**Blocking the product right now:** the job we sell, `2FA:Create FB (No mail)`,
is **not currently listed** by the provider. The catalogue correctly resolves to
nothing, so users see "No jobs are available right now" and admins get an alert.
That is correct behaviour, not a bug.

**Also unbuilt:** the credential extraction. The provider asks for the user's
**2FA secret key** and no credential message has ever been seen, because the
flow stops at that prompt. The bridge forwards the provider's words verbatim
rather than guessing a parser.

**And the balance is $0.0000**, so a live withdrawal will be refused by the
provider's $0.20 minimum until the account is topped up.

---

## Milestone 1 — make one job sellable end to end

*Partly blocked: the provider is not offering the job.*

Built:
- the `/start` → list → join flow, with the join persisted
- `require_all` matching, so the right job is matched and the wrong variant is
  never substituted for it
- the availability alert that fires when the job is missing

Blocked on the provider:
1. Watch for the availability alert; confirm `require_all` matches on return
2. Walk the **full** 2FA flow with a real key and record every screen
3. Capture the credential message, then write the extractor against a **real
   sample** — never a guessed pattern
4. Relay it to the end user

**Done when:** a user taps the button, completes the task, and receives the
credential — with the provider's state intact on restart.

**Risk to resolve first:** how 2FA secrets are handled. The provider asks for a
TOTP seed, which is a live credential with no rotation. Encrypted at rest, or
relayed and forgotten? Who can see them? This is a security decision, not a
coding one.

---

## Milestone 2 — job status cache and a monitor account

*Planned, not started. See "Deferred" below for the full reasoning.*

Today every user action navigates the provider live: `/start` reads the job
list, and every tap walks `📋 Tasks → 🍪 Cookies → job → ▶️ Start`. Each of
those is 3–4 automated messages to the provider.

**Later we may want a dedicated monitor account that polls job status and
caches it for a few seconds, so every user gets an instant result.**

The intent: one account does the polling on a slow schedule, and user-facing
requests are served from a short-lived cache instead of each triggering a fresh
navigation.

### Why it is deferred, not dismissed

- **A second account doubles the ban surface.** Accounts are the scarcest
  resource here, and Telegram bans are permanent. A monitor is a second thing
  to protect, not a free helper.
- **Cache correctness is the hard part, and the failure is silent.** A stale
  cache does not error — it shows a price or availability that is no longer
  true, and a user can join a job that has just been withdrawn.
- **A few seconds only helps bursts.** At 1–10 users there is nothing to batch.
  The win appears at 20–30 users tapping `/start` at once.
- **There is a cheaper fix available first:** the bridge already holds the last
  job list in memory. The real problem is that a *fresh* process starts blind,
  which is what screen persistence and the catalogue address. Fixing that may
  remove most of the motivation.

### What it would take

- a second registered account, bound to no end user
- one poller owning provider access, with users reading from its cache
- a **short** TTL — seconds, not minutes — because availability is the thing
  that actually changes
- cache invalidation on any observed provider change, not just on expiry
- a guard so a stale entry is never presented as current
- flood budget shared between the poller and user actions

**Do it only when:** user actions are visibly hitting provider latency, or
concurrent `/start`s are colliding. Measure first.

---

## Milestone 3 — per-user account pool

The design is fixed at **1 account ↔ 1 end user**, because the provider keeps
per-chat state (balance, rank, execution count) that cannot be shared.

- registration and login flow for new accounts, one at a time, by hand
- an assignment table, replacing today's single bound user
- a pool health view: online, flood-wait, banned, last seen
- session storage in **Neon**, so a Railway redeploy cannot log everyone out
- reassignment when an account dies, with the user told plainly

**Blocking question:** how many accounts can be registered per week? That number
is the real capacity limit, and it is not a code question.

**Note:** when an account dies, the user loses their provider state. There is no
way to move a conversation between accounts. Decide now whether that is a
silent failover or an honest error — the default is an honest error.

---

## Milestone 4 — admin website — **DONE**

Built and deployed. Nine pages, TypeScript built by Bun to static files and
served by the Go binary, so one process and no second runtime.

- **Overview** — account health, users, job availability and margin, alerts
- **Accounts** — state, phone, balance, assigned user, flood-wait
- **Sessions** — stored sessions with balances and a total; create (phone → code
  → 2FA) and delete
- **Users** — joined job, message count, last seen
- **Tasks** — the catalogue: offered, hidden, provider cost versus sell price
- **Messages** — the live four-leg feed
- **Alerts** — price and availability history
- **Withdrawals** — the preview/execute flow plus history
- **Settings** — editable config; secrets are never returned by the API

Auth is the **Telegram Login Widget**, chosen over a password. A shared password
in front of a panel that can withdraw is the weakest link in the chain, and
there is now no secret of ours to leak or forget to rotate.

Still open here: the job catalogue is unreadable to users while the provider
withdraws the job, and the Overview cannot yet distinguish a balance that was
never read from one that is genuinely zero.

---

## Milestone 5 — deploy — **DONE**

- Neon `tasklybridge` holds the critical data: accounts, users, **sessions**,
  alerts, withdrawals, price baselines
- Railway Postgres holds the high-volume logs: messages, audit
- sessions in Neon via `session.Storage`, so Neon alone is a full restore point
- one Railway service, one process, one Dockerfile building Bun and Go
- `/healthz` reports ready only once an account is connected; the image's
  healthcheck runs `-status`, which explains a failure rather than just
  reporting one
- `task.json` is copied in as config rather than compiled in, so prices change
  without a rebuild

**Not yet done:** Railway sleep is not explicitly disabled, and the MTProto
session was pushed to Neon by hand via `cli session push` rather than by a
first-run bootstrap. A cold container with an empty store would start, log
"no session", and sit there serving the dashboard — which is deliberate, since
the dashboard is how a session gets added.

---

## Milestone 3b — admin withdrawal

*Flow verified and documented in `docs/withdraw.md`. Not started.*

The provider's withdrawal flow is fully known, so this is a design problem
rather than a discovery one:

```
📤 Withdraw → USDT (BEP-20) → [address] → [amount] → money moves
```

3 button presses, 2 free-text inputs, **zero confirmations**. Fee $0.025 flat,
minimum $0.20, deducted from the amount. BSC only — no bKash or Nagad.

### Decisions already taken

| Question | Answer |
|---|---|
| Destination wallet | **One fixed address**, configurable, used every time for now |
| Which accounts | **The admin picks one.** No automatic pool sweep |
| When | **On demand from the admin website.** No scheduled job |
| Failed payout detection | **None for now.** Accepted; may be added later |

These answers simplify the build. Because the admin selects a single account,
there is no pool loop and almost no interleaving risk — one flow, one account,
one `opMu` hold. The dangerous part is unchanged though: there is still no
confirmation step, so the amount is irreversible.

### Build it in this order — **DONE**

All four shipped. What actually differed from the plan:

1. **Withdrawal history**, with the provider's confirmation stored verbatim
2. **Preview mode** — reads balances, fee and minimum off the provider, sends
   nothing
3. **Single-account withdrawal**, admin-selected, with a preview showing debit,
   fee and net before the final button
4. **Address validation** — `0x` + 40 hex, and the network stated in plain
   words

Two things the plan did not anticipate:

- **Preview and execute had to be one endpoint**, chosen by a `confirm` flag.
  Two endpoints would mean the numbers an operator approves and the numbers that
  are used could come from different code paths.
- **The wallet was first threaded through a package variable.** With one
  withdrawal running that is fine; with two, one admin's payout could go to the
  other admin's address. It is now a parameter, and only one withdrawal may run
  at a time.

### Guardrails it keeps

- **Never enter the flow on a bare user message.** The provider holds
  conversational state, so a stray message mid-flow could be read as an amount
  and paid out.
- **Verify every screen before typing the next field.** A missing screen aborts
  that attempt; it never presses on.
- **Re-read fee and minimum every run.** The configured values are for the
  dashboard estimate only. The live screen always wins.
- **Show the network in plain words.** Most users hold USDT on Tron; a BSC
  address is unrecoverable money for them.

---

## Deferred, and why

| Item | Why not yet |
|---|---|
| Job status cache / monitor account | See Milestone 2. A second account doubles the ban surface; needs measurement first |
| SMS alerts | Telegram is built and free. SMS needs a paid gateway and per-message billing |
| Bulk account registration | Never, on purpose. Automated registration is how accounts get flagged |
| Inline `callback_data` mapping | Only needed for non-menu screens. The main menu is plain text, so the whole token table turned out unnecessary |
| Media passthrough | No media observed. The `📹 Video instruction` may force it |
| Rate limiting / sharding | 30 users is a hard ceiling. Skip until it isn't |
| Failed-payout detection | The provider never confirms arrival, so this needs a chain lookup. A separate integration |

Two entries were removed because they are done: **Neon for state** and
**the dashboard**.

---

## Known gaps

- **The job we sell is withdrawn by the provider**, so nothing is sellable
  until it returns. The list has churned within a single afternoon.
- **The account balance is $0.0000.** A live withdrawal is refused by the
  provider's $0.20 minimum until the account is topped up.
- **No margin.** Static 5tk against a provider cost that reached 5.20tk. The
  loss check alerts admins; it does not fix the pricing.
- **The 2FA secret is a live credential** with no rotation, and the handling
  policy is undecided. This is the largest open risk.
- **Rejection rate is unknown.** Rejections are presumably not refunded, so the
  real cost per *accepted* job is unknown.
- **Whether the charge lands at `Start` or at completion is unverified** — no
  balance check was sent after the one `Start`, on request.
- **The task steps are unknown.** The instruction video has never been watched
  and the on-page instruction is empty.
- **Failed payouts are undetectable.** The provider says "created" and never
  confirms arrival, so a transfer that fails downstream is invisible here.
- **Railway sleep is not explicitly disabled.** A frozen service would drop
  live MTProto connections, so it should be turned off in the dashboard.
