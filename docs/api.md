# Admin API contract

Single source of truth. The Go backend implements it; the dashboard consumes
it. Neither side invents a field the other has not agreed on.

Base: same origin, served by the Go binary. All JSON, all UTC timestamps as
RFC3339.

## Auth

Sign-in is the **Telegram Login Widget**, and it is the only method. There is
no password, no `ADMIN_PASSWORD`, and no fallback: a shared password on a panel
that can move money is the weakest link in the chain.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/auth/telegram/config` | `{"clientId": 8730058124}`, cacheable 1h |
| `POST` | `/api/auth/telegram/login` | `{"id_token":"..."}` → session cookie |

The page loads `https://oauth.telegram.org/js/telegram-login.js`, calls
`Telegram.Login.auth({client_id, scope:["profile","phone"]}, cb)`, and POSTs the
`id_token` from the callback.

The server verifies the token as an RS256 JWT against
`https://oauth.telegram.org/.well-known/jwks.json`, checks the audience is our
bot id, then checks the uid is in `ADMIN_USER_IDS`. Only then is a cookie
issued. Every other `/api/*` route requires that cookie; without it →
`401 {"error":"unauthorized"}`.

A **403** on the login endpoint means the token was valid but the uid is not an
admin, so no session is created. `401` means only "not authenticated" anywhere
in this API.

The cookie is `HttpOnly; SameSite=Strict; Path=/; Secure` over HTTPS, 30 days,
HMAC-signed with `ADMIN_SESSION_SECRET`.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/healthz` | 200 when at least one account is connected |
| `POST` | `/webhook` | Telegram update delivery — **see below** |
| `POST` | `/api/logout` | clears the cookie |
| `GET` | `/api/sessions` | list stored Telegram sessions |
| `POST` | `/api/sessions` | start or continue creating a session |
| `DELETE` | `/api/sessions/{id}` | remove a stored session |
| `GET` | `/api/overview` | everything for the Overview page, one call |
| `GET` | `/api/accounts` | the account pool |
| `GET` | `/api/users` | end users and their joined job |
| `GET` | `/api/tasks` | the catalogue: offered, hidden, cost vs sell |
| `POST` | `/api/tasks/{id}/enabled` | `{"enabled":false}` hides a job |
| `GET` | `/api/messages` | recent messages, newest first, `?limit=` `?before=` |
| `GET` | `/api/alerts` | price and availability history |
| `GET` | `/api/withdrawals` | withdrawal history with the provider's confirmation |
| `GET` | `/api/withdrawals/terms` | the provider's live fee and minimum |
| `POST` | `/api/withdrawals` | preview with `confirm:false`, execute with `confirm:true` |
| `GET` | `/api/settings` | non-secret configuration |
| `PUT` | `/api/settings` | the editable subset |
| `GET` | `/api/sessions` | list stored Telegram sessions |
| `POST` | `/api/sessions` | start or continue creating a session |
| `DELETE` | `/api/sessions/{id}` | remove a stored session |
| `GET` | `/api/session` | plain status check for the create flow |
| `GET` | `/api/events` | **SSE** live feed |
| `POST` | `/api/logout` | clears the cookie |

`Backend/apicontract_test.go` calls every row of this table against a real
Postgres and fails if one is not routed, so this list and the router cannot
drift apart again without a test going red. Two rows that used to be here —
`GET /api/accounts/{id}` and `GET /api/users/{id}` — were never implemented and
nothing ever called them. They were removed rather than built.

## `POST /webhook`

Telegram's delivery endpoint, and the only route on this service that is public
without a session — Telegram is the caller and cannot hold one.

The bot **registers this itself on every boot**, from `RAILWAY_PUBLIC_DOMAIN`
(Railway injects it) with `WEBHOOK_BASE_URL` as an optional override. It is not
set once at setup, because Railway hands out a different domain whenever the
service is recreated, and a webhook pointing at a dead URL is a silent failure:
the process looks healthy and simply never hears anything again. After
`setWebhook`, `getWebhookInfo` is read back and a `last_error_message` there
fails startup rather than being logged and ignored.

| Situation | Result |
| --- | --- |
| `WEBHOOK_SECRET` set, header missing or wrong | `403`, body not parsed |
| `GET` instead of `POST` | `405` |
| Secret ok, update well-formed | `200` **immediately**, work continues after |

The `200` is sent before the update is handled. A provider navigation takes
seconds, and answering late would make Telegram redeliver the same update
repeatedly. Rule 4 still applies: the handler must not block.

**Webhook and long polling are mutually exclusive.** Telegram refuses
`getUpdates` while a webhook is set, so when a webhook registers the poller does
not start. The startup banner says which one is live (`updates : webhook` or
`updates : long polling`) because being in the wrong one produces no error at
all — only silence. For the same reason the duplicate-instance probe
(`getUpdates`-based) runs **only** on the polling path, and **after**
registration: probing `getUpdates` in webhook mode fails every single boot.

Without `WEBHOOK_SECRET` one is generated per process. That still works, because
registration re-runs on boot, but the log says so — a silently rotating secret
is a miserable thing to debug.

## Payloads

Every list endpoint returns `{"items":[...], "total":N}`.

### `/api/overview`

```json
{
  "items": [],
  "accounts": {
    "total": 1, "connected": 1, "degraded": 0, "banned": 0, "dead": 0
  },
  "users": { "total": 1, "joined": 1, "waiting": 0 },
  "task": {
    "available": false,
    "name": "Facebook 2fa",
    "sell_bdt": 5,
    "provider_cost": 0.05,
    "cost_known": true,
    "margin_bdt": -0.2,
    "margin_known": true,
    "selling_at_loss": true
  },
  "balance_total": 0.0,
  "alerts_unread": 0,
  "withdraw_dry_run": true,
  "last_checked": "2026-09-28T14:05:44Z"
}
```

`selling_at_loss` is `true` when `provider_cost` converts to more Taka than
`sell_bdt`. **It is the single most important field on this page.**

### The `*_known` flags

`provider_cost`, `margin_bdt` and `selling_at_loss` come from the price
watcher's last poll, and **every one of them is genuinely unknown until that
poll has run.** The keys are always present and always numbers, so the page can
never crash on them, and the flags say whether to believe them:

| Flag | `false` means |
| --- | --- |
| `cost_known` | the watcher has written no snapshot yet, so there is no provider price |
| `margin_known` | the cost is unknown, **or** no `bdt_rate` is configured to convert dollars to Taka |

`/api/tasks` carries the same pair as `provider_price_known` and `margin_known`.

**A flag is never collapsed into a zero.** This is not a style preference. The
page formats money with `value.toFixed(2)`, so when `/api/overview` omitted
these keys entirely the whole dashboard died with *"Cannot read properties of
undefined (reading 'toFixed')"* — while `tsc`, `bun build`, `go vet` and the Go
tests were all green. Worse, the earlier version of `/api/tasks` sent
`provider_price: 0.0` and `margin_bdt` equal to the sell price, which renders as
a provider giving the job away free and makes `selling_at_loss` impossible to
trigger. Unknown must read as unknown.

`apicontract_test.go` enforces this: it fails on a missing key, on a non-number
where a number is documented, and on **any JSON null anywhere in a response**,
because the dashboard has no null handling at all.

### `/api/accounts`

```json
{
  "items": [
    {
      "id": "a1",
      "phone": "+8801XXXXXXXXX",
      "state": "connected",
      "balance": 0.0,
      "assigned_user_id": 1772093705,
      "assigned_user_name": "MD REZAUL ISLAM RABBI",
      "messages_sent": 412,
      "flood_wait_seconds": 0,
      "last_seen": "2026-09-28T14:11:48Z",
      "note": ""
    }
  ],
  "total": 1
}
```

`state` is one of `free`, `connected`, `degraded`, `banned`, `dead`.

### `/api/users`

```json
{
  "items": [
    {
      "id": 1772093705,
      "name": "MD REZAUL ISLAM RABBI",
      "username": "",
      "status": "joined",
      "account_id": "a1",
      "task_name": "Facebook 2fa",
      "messages": 38,
      "joined_at": "2026-09-28T13:30:00Z",
      "last_seen": "2026-09-28T14:11:48Z"
    }
  ],
  "total": 1
}
```

`status` is one of `waiting`, `joined`, `stopped`.

### `/api/tasks`

```json
{
  "items": [
    {
      "id": "create-fb",
      "require_all": ["2FA:Create FB", "No mail"],
      "name": "Facebook 2fa",
      "sell_bdt": 5,
      "enabled": true,
      "available": true,
      "provider_name": "2FA:Create FB (No mail)",
      "provider_price": 0.05,
      "margin_bdt": 0.0,
      "hidden": []
    }
  ],
  "total": 1,
  "bdt_rate": 104
}
```

`margin_bdt` is `sell_bdt` minus the provider cost in Taka. **Negative means
we lose money on every sale.** `hidden` lists provider jobs we do not sell, so
the admin can see what is being withheld.

### `/api/sessions`

Creating a Telegram session from the dashboard, in steps. This replaces a file
upload: a new account has no session file, so the whole sign-in happens here.

```json
{
  "items": [
    {
      "id": "primary",
      "phone": "+8801XXXXXXXXX",
      "state": "connected",
      "bytes": 4197,
      "updated_at": "2026-09-28T14:05:44Z",
      "in_use": true,
      "balance": 0.375,
      "balance_known": true
    }
  ],
  "total": 1,
  "total_balance": 0.375,
  "balance_known": true
}
```

`in_use` is true when the service is actually connected with that session, not
merely when a row exists. `bytes` is the size of the credential blob; **the
blob itself is never returned**.

`balance` is the last figure read from the provider, so it is a fact with an
expiry rather than a stored truth. `balance_known` is **false** when the balance
is zero, because a zero is ambiguous: it could be an account that really is
empty, or one nothing has ever read. `total_balance` and the top-level
`balance_known` are provided so a page shows the count, the per-account balances
and the total without recomputing any of it.

#### `POST /api/sessions`

One endpoint, three steps, chosen by what the body carries.

**Step 1 — send a code.** `{"phone": "+8801..."}`
```json
{ "attempt": "k3m9x2p7qw4d", "phone": "+8801...", "step": "code",
  "note": "Telegram has sent a login code. Enter it here, or in the Telegram app." }
```

**Step 2 — the code.** `{"attempt": "k3m9x2p7qw4d", "code": "12345"}`

Either the session is created:
```json
{ "ok": true, "bytes": 4197, "phone": "+8801...",
  "note": "session created and stored. The service is reconnecting." }
```

Or the account has 2FA, and the same attempt continues:
```json
{ "attempt": "k3m9x2p7qw4d", "step": "password", "needs_password": true,
  "note": "this account has 2FA. Enter its password." }
```

**Step 3 — the 2FA password.** `{"attempt": "k3m9x2p7qw4d", "password": "..."}`
Returns the same `{"ok": true, "bytes": N, ...}` as a completed step 2.

The `attempt` id is what ties the steps together, so two admins cannot
interleave into one login. It expires after 15 minutes.

**The code and the password are never returned, stored or logged.** Only the
phone number is recorded, because it is what makes a failed sign-in
diagnosable and it is not a secret.

Errors: `400` bad phone or missing field, `403` code or password rejected,
`404` the attempt expired, `429` too many attempts (5 per hour).

#### `DELETE /api/sessions/{id}`

Removes a stored session. This signs the account out and cannot be undone: the
service is left with no session and a new one must be created.

```json
{ "ok": true, "note": "the service will need a new session" }
```

`404` if there is no such session. The client should confirm before calling,
and say plainly when the session being removed is the one currently in use.

**`401` means exactly one thing: not authenticated.** A rejected login code or
2FA password is `403`, never `401`, so a client can treat every `401` as a dead
admin session without having to inspect the body. An earlier draft of this
document used `401` for both, which made a wrong code indistinguishable from an
expired cookie and would have logged an admin out mid-task.

### `POST /api/withdrawals`

One endpoint, two behaviours, chosen by `confirm`. The same call previews or
executes, so the numbers an operator approves are the numbers that are used.

```json
{
  "account_ids": ["primary"],
  "wallet": "0x...",
  "amounts": { "primary": 0.375 },
  "confirm": false
}
```

Balances and the provider's fee and minimum are **read live** for every call, so
a preview is never built on a stored number. Nothing is sent beyond reading.

**Preview** (`confirm` false, or omitted):

```json
{
  "dry_run": true,
  "preview": {
    "wallet": "0x...",
    "method": "USDT (BEP-20)",
    "network": "BSC",
    "fee": 0.025,
    "minimum": 0.2,
    "lines": [
      {
        "account_id": "primary",
        "phone": "+8801...",
        "balance": 0.375,
        "amount": 0.375,
        "fee": 0.025,
        "net": 0.35,
        "problem": ""
      }
    ],
    "totals": {
      "accounts": 1,
      "total_balance": 0.375,
      "total_amount": 0.375,
      "total_fee": 0.025,
      "total_net": 0.35,
      "known_balance": true
    },
    "warnings": [
      "The fee is charged per account, so withdrawing from several accounts costs several fees.",
      "There is no confirmation on the provider's side. Sending the amount IS the withdrawal."
    ]
  }
}
```

Field notes that matter for the display:

- `net` is `amount - fee`, because the provider **deducts** the fee from the
  amount rather than adding it. $0.3750 arrives as $0.3500.
- `problem` is set on a line that cannot be withdrawn, with the reason. An
  unwithdrawable line contributes **nothing** to the totals, so the summary
  never promises money that will not arrive.
- `known_balance` is `false` when any balance could not be read. A total built on
  a partial picture must not be presented as complete.

**Execute** (`confirm` true). Returns `409` when `WITHDRAW_DRY_RUN` is on.

```json
{
  "ok": true,
  "results": [
    { "account_id": "primary", "phone": "+8801...", "amount": 0.375,
      "fee": 0.025, "net": 0.35, "status": "created",
      "detail": "✅ Withdrawal request created! ..." }
  ],
  "totals": { "amount": 0.375, "fee": 0.025, "net": 0.35 },
  "note": "the provider accepted these. It does not confirm arrival, so nothing here proves the money landed."
}
```

`status` is `created`, `skipped` or `failed`. Accounts are processed one at a
time and a failure on one does not stop the others.

`409` also when a withdrawal is already running. Only one may run at a time:
two concurrent flows would interleave two provider conversations and could pay
the wrong amount.

#### Live progress

An executing withdrawal pushes progress on the existing SSE stream, so the
dashboard updates without polling:

```
event: message
data: {"type":"withdrawal","progress":{
  "step":"account","state":"running","account":"primary",
  "phone":"+8801...","amount":0.375,"fee":0.025,"net":0.35}}

event: message
data: {"type":"withdrawal","progress":{"step":"done","state":"done",
  "detail":"$0.3750 requested, $0.0250 in fees, $0.3500 to arrive"}}
```

`state` is `running`, `created`, `skipped`, `failed` or `done`. `step` is
`start`, `account`, `skip` or `done`.

**`created` means the provider accepted the request. It is not a receipt.** The
provider never confirms the money arrived, and nothing in this API can.

### `/api/messages`

```json
{
  "items": [
    {
      "id": "a1:176755",
      "account_id": "a1",
      "user_id": 1772093705,
      "leg": "taskly->bot",
      "direction": "in",
      "text": "💰 Your balance: $0.3750",
      "buttons": ["💰 Balance", "📋 Tasks"],
      "at": "2026-09-28T14:11:49Z"
    }
  ],
  "total": 1
}
```

`leg` is `user->bot`, `bot->user`, `bot->taskly`, `taskly->bot`, `internal`.
The **provider's dollar price appears in these records** — the dashboard must
never render `text` from `taskly->bot` inside a user-facing price slot, and the
frontend has no end-user view at all, so this is safe here.

### `/api/alerts`

```json
{
  "items": [
    {
      "id": "2026-09-28T14:05:44Z",
      "level": "critical",
      "kind": "unavailable",
      "job": "Facebook 2fa",
      "message": "Facebook 2fa is NOT available right now.",
      "read": false,
      "at": "2026-09-28T14:05:44Z"
    }
  ],
  "total": 1
}
```

`level` is `info`, `warning`, `critical`. `kind` is `price`, `appeared`,
`gone`, `unavailable`, `available`, `loss`.

### `/api/withdrawals`

```json
{
  "items": [
    {
      "id": "w1",
      "account_id": "a1",
      "wallet": "<withdraw-wallet>",
      "amount": 0.375,
      "fee": 0.025,
      "net": 0.35,
      "dry_run": false,
      "status": "created",
      "confirmation": "✅ Withdrawal request created! ...",
      "at": "2026-09-28T14:40:00Z"
    }
  ],
  "total": 1
}
```

`status` is `created` (the provider accepted it) or `failed`. **There is no
`received` status**, because the provider never says the money arrived. The
dashboard must not imply otherwise.

### `/api/withdrawals/terms`

```json
{
  "fee": 0.025,
  "minimum": 0.2,
  "method": "USDT (BEP-20)",
  "network": "BSC",
  "source": "provider-message"
}
```

Read from the provider's own message on every call. `source` is always
`provider-message` — the numbers are never configured.

### `GET /api/withdrawals/terms`

Read from the provider's own message on every call, by navigating the provider.
`source` is always `provider-message` — the numbers are never configured. It
moves nothing.

```json
{ "fee": 0.025, "minimum": 0.2, "method": "USDT (BEP-20)",
  "network": "BSC", "source": "provider-message" }
```

**There is no `POST /api/withdrawals/preview` and no separate
`POST /api/withdrawals`.** Previewing and executing are the same endpoint,
`POST /api/withdrawals`, chosen by `confirm`. An earlier draft of this document
described them separately; that draft was wrong, because two endpoints would
mean the numbers an operator approved and the numbers that are used could come
from different code paths.

### `/api/settings`

```json
{
  "bound_user_id": 1772093705,
  "admin_ids": [1772093705],
  "withdraw_wallet": "WALLET",
  "withdraw_dry_run": true,
  "watch_interval_seconds": 900,
  "watch_job": "2FA:Create FB",
  "catalog_path": "Backend/task.json",
  "audit_retained_days": 30
}
```

`PUT` accepts only the editable subset. **Secrets are never returned**:
`BOT_TOKEN`, `TG_API_HASH` and the session key are not in
this payload and must not be added to it.

## `/api/events` — SSE

```
event: message
data: {"account_id":"a1","leg":"user->bot","text":"...","at":"..."}

event: account
data: {"id":"a1","state":"degraded","flood_wait_seconds":30}

event: alert
data: {"level":"critical","kind":"unavailable","message":"..."}

event: message
data: {"type":"withdrawal","progress":{"step":"account","state":"created",
  "account":"primary","amount":0.375,"fee":0.025,"net":0.35}}
```

Withdrawal progress arrives as a **`message` event whose data has
`type: "withdrawal"`**, not as a separate `withdrawal` event. An earlier draft of
this document documented a bare `{id, status, net}` frame; no such frame is ever
emitted, and a client listening for one would sit waiting.

The dashboard opens this once on load and updates in place. A reconnect
resyncs via `GET /api/messages`, `GET /api/alerts` and `GET /api/withdrawals`.

## Errors

```json
{ "error": "human readable", "field": "amount" }
```

`400` validation, `401` no session, `404` unknown id, `409` conflict (dry run
on, account busy), `429` provider refused, `502` provider unreachable.
