# Admin API contract

Single source of truth. The Go backend implements it; the dashboard consumes
it. Neither side invents a field the other has not agreed on.

Base: same origin, served by the Go binary. All JSON, all UTC timestamps as
RFC3339.

## Auth

`POST /api/login` with `{"password":"..."}` → sets an HMAC-signed cookie.
Every other `/api/*` route except `/api/login` and `/healthz` requires it.
Unauthenticated → `401 {"error":"unauthorized"}`.

The password is `ADMIN_PASSWORD` in the environment. The cookie is
`HttpOnly; SameSite=Strict; Path=/`. The signing key is `ADMIN_SESSION_SECRET`.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/healthz` | 200 when at least one account is connected |
| `POST` | `/api/login` | password in, cookie out |
| `POST` | `/api/logout` | clears the cookie |
| `GET` | `/api/overview` | everything for the Overview page, one call |
| `GET` | `/api/accounts` | the account pool |
| `GET` | `/api/accounts/{id}` | one account, with its recent traffic |
| `GET` | `/api/users` | end users and their joined job |
| `GET` | `/api/users/{id}` | one user, with their message history |
| `GET` | `/api/tasks` | the catalogue: offered, hidden, cost vs sell |
| `POST` | `/api/tasks/{id}/enabled` | `{"enabled":false}` hides a job |
| `GET` | `/api/messages` | recent messages, newest first, `?limit=` `?before=` |
| `GET` | `/api/alerts` | price and availability history |
| `GET` | `/api/withdrawals` | withdrawal history with the provider's confirmation |
| `GET` | `/api/withdrawals/terms` | the provider's live fee and minimum |
| `POST` | `/api/withdrawals/preview` | dry run, see the screen, send nothing |
| `POST` | `/api/withdrawals` | actually withdraw from one account |
| `GET` | `/api/settings` | non-secret configuration |
| `PUT` | `/api/settings` | the editable subset |
| `GET` | `/api/events` | **SSE** live feed |

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
    "margin_bdt": -0.2,
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

### `POST /api/withdrawals/preview`

```json
{ "account_id": "a1", "amount": 0.375 }
```

```json
{
  "dry_run": true,
  "fee": 0.025,
  "minimum": 0.2,
  "net": 0.35,
  "fee_heavy": false,
  "balance": 0.375,
  "warnings": ["Fee is deducted from the amount.", "No confirmation step exists."]
}
```

Walks the flow and sends **nothing**. This is the only place a mistake gets
caught, so the dashboard must call it before offering the real button.

### `POST /api/withdrawals`

Same body. Returns the same shape as `/withdrawals` for the created record.
`400` when `amount` is below the minimum, exceeds the balance, or the wallet
fails validation. `409` when `WITHDRAW_DRY_RUN` is on.

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
`BOT_TOKEN`, `TG_API_HASH`, `ADMIN_PASSWORD` and the session key are not in
this payload and must not be added to it.

## `/api/events` — SSE

```
event: message
data: {"account_id":"a1","leg":"user->bot","text":"...","at":"..."}

event: account
data: {"id":"a1","state":"degraded","flood_wait_seconds":30}

event: alert
data: {"level":"critical","kind":"unavailable","message":"..."}

event: withdrawal
data: {"id":"w1","status":"created","net":0.35}
```

The dashboard opens this once on load and updates in place. A reconnect
resyncs via `GET /api/messages` and `GET /api/alerts`.

## Errors

```json
{ "error": "human readable", "field": "amount" }
```

`400` validation, `401` no session, `404` unknown id, `409` conflict (dry run
on, account busy), `429` provider refused, `502` provider unreachable.
