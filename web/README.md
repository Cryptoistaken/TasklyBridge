# TasklyBridge dashboard (web/)

Vanilla TypeScript, nine pages, one SSE connection. Built by Bun into static
files that the Go binary serves. No framework, no CSS framework, no HTTP
library — the platform is enough for nine pages of tables.

Contract: `../docs/api.md` (endpoints) and `../docs/design.md` (tokens, layout,
page rules).

## Build

```powershell
cd web
bun install          # typescript + @types/bun only
bunx tsc --noEmit    # must be clean
bun run build        # -> dist/index.html + hashed js/css
```

`bun run build` runs `bun build ./src/index.html --outdir ./dist --minify`,
which bundles `src/main.ts`, its imports and `src/style.css` into `dist/`.

Serve `dist/` from the Go binary. Hash routing means the server only ever needs
`/` plus the asset files — no SPA fallback route is required.

## Run `bun dev` against the local Go backend

`bun dev` starts a dev server that rebuilds when `src/` changes and proxies the
API to the Go backend, so the browser sees one origin and the `HttpOnly`
session cookie works.

```powershell
# terminal 1 — the bridge
cd ..\Backend
go run ./Backend

# terminal 2 — the dashboard
cd web
bun dev
```

Defaults: dashboard on `http://localhost:5173`, proxying `http://127.0.0.1:8080`.
Override with environment variables if the Go binary listens elsewhere:

```powershell
$env:GO_ORIGIN = "http://127.0.0.1:9000"
$env:WEB_PORT  = "5173"
bun dev
```

`/api/*` and `/healthz` are proxied to `GO_ORIGIN`; everything else is served
from `dist/`, rebuilt on first request and whenever any `src/` file is newer
than `dist/index.html`.

## File layout

```
web/
  package.json        build / dev / typecheck scripts
  tsconfig.json       strict, DOM + ES2022, bun types for dev.ts
  dev.ts              dev server: rebuild-on-change + API proxy
  src/
    index.html        the only entry point (Bun HTML entry)
    style.css         design tokens from docs/design.md + own reset
    api.ts            every API type + fetch client + 401 hook
    ui.ts             h(), formatters, chips, table, the Page contract
    main.ts           boot, auth gate, hash router, shell, SSE + resync
    login.ts          the centred login card
    pages/
      overview.ts     job availability, accounts, margin, loss banner
      accounts.ts     state column, flood-wait countdown
      sessions.ts     stored sessions, three-step create form (no upload)
      users.ts        end users and their joined job
      tasks.ts        sell vs provider cost, margin, hidden list
      messages.ts     live four-leg feed, provider pairs grouped
      alerts.ts       severity ordered, unread first
      withdrawals.ts  preview then confirm, history verbatim
      settings.ts     editable subset, read-only config, secrets
  dist/               build output (gitignored)
```

## Behaviour worth knowing

- **Live updates** come from `GET /api/events` (SSE), opened once on load.
  On reconnect the dashboard resyncs from `GET /api/messages` and
  `GET /api/alerts`. There is no polling timer.
- **Provider cost vs sell price.** Tasks shows `5.00tk` (what we charge) and
  `$0.0500` (what the provider costs us) in different units and different
  colours. Provider dollars never appear in a sell-price slot.
- **Withdrawals are preview-then-confirm.** The confirm button does not exist
  until `POST /api/withdrawals/preview` has run, and it disables itself the
  moment the inputs change. `created` is labelled "provider accepted; arrival
  not confirmed" because the provider never confirms arrival.
- **`selling_at_loss`** puts a red full-width banner at the top of Overview.
- **Sessions are created in three steps** — phone, login code, 2FA password,
  one `POST /api/sessions` per step, replacing the old file upload. The code
  and the password are read from the input, sent once and cleared; they are
  never held in module state, the URL or storage. Only the attempt id is held
  (in memory) to tie the steps together. A stored session the service is not
  using is flagged destructive on the list, because it is a trap.
- **Deleting a session takes two clicks** — the first arms the row and spells
  out that the account must be signed in again and the service will need a new
  session (loudest for the `in use` row); the second confirms. A fast
  double-click does not count, because one accidental deletion logs the account
  out and cannot be undone.
