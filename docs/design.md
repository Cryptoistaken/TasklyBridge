# Dashboard design system

Taken from the openmail.sh design tokens so the admin site matches the
reference. These are the actual values, not invented ones.

## Palette — near-black, monochrome

```css
--background:      #050505;   /* page */
--card:            #0a0a0a;   /* panels, slightly lifted */
--secondary:       #1a1a1a;   /* buttons, chips */
--muted:           #1a1a1a;   /* hover fills */
--accent:          #1a1a1a;
--border:          #262626;   /* hairlines, inputs */
--input:           #262626;
--foreground:      #e5e5e5;   /* primary text */
--muted-foreground:#6b7280;   /* secondary text, labels */
--primary:         #ffffff;   /* the one bright element */
--primary-foreground: #000000;
--ring:            #ffffff;
--destructive:     #ef4444;   /* banned, dead, lost money */
--radius:          0.625rem;
```

The whole design is **near-black with white text and no colour**, so status
carries the only colour on the page:

| Meaning | Token |
| --- | --- |
| connected, available, healthy | `--foreground` on `--muted` chip |
| degraded, flood-wait, at risk | `--muted-foreground` chip (there is no amber in the palette) |
| banned, dead, unavailable, loss | `--destructive` text or dot |
| primary action | solid `--primary` white button |

**Never introduce a new hue.** If a state needs colour, one of the three above
is the answer.

## Type

- UI: **Geist Sans**, then system sans stack
- All numbers, IDs, phone numbers, addresses, prices, and log text: **Geist Mono**

Mono is not decorative here. Every value an admin needs to compare or copy —
`0x40116e…`, `$0.3750`, `5tk`, account ids — is mono, so digits line up in
columns and addresses are selectable without wrapping errors.

```css
--font-sans: "Geist Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
--font-mono: "Geist Mono", ui-monospace, SFMono-Regular, "Roboto Mono", Menlo, monospace;
```

If neither is available, fall back to the system stack. **Do not fetch fonts
from a CDN** — the dashboard must render offline on a local machine.

## Shape

- `--radius: 0.625rem` on cards, inputs, buttons, chips
- 1px `--border` hairlines, never a heavy shadow
- No gradients, no glow, no rounded-blob decoration

## Layout

- A left sidebar for navigation, a single scrolling content column
- Sidebar: wordmark, then the page list, then the connection state at the bottom
- Content: a page title, then a row of stat cards, then the table or feed
- Tables are the default for accounts, users, tasks, alerts and withdrawals
- Generous vertical space between sections, tight inside a table

## Density

Admin-facing, so: comfortable rows, right-aligned numeric columns, and
`tabular-nums` so digits do not shift as values update live.

---

## Page map

Nine pages. Nothing else.

| Page | Route | Shows |
| --- | --- | --- |
| **Overview** | `/` | Account health, users, the job's availability and margin, unread alerts |
| **Accounts** | `/accounts` | The pool: state, phone, balance, assigned user, flood-wait |
| **Sessions** | `/sessions` | Stored Telegram sessions, each account's balance and the total, plus create and delete |
| **Users** | `/users` | End users, joined job, message count, last seen |
| **Tasks** | `/tasks` | The catalogue: offered, hidden, provider cost vs sell price |
| **Messages** | `/messages` | The live four-leg feed |
| **Alerts** | `/alerts` | Price and availability history |
| **Withdrawals** | `/withdrawals` | History, dry-run preview, single-account withdraw |
| **Settings** | `/settings` | Editable config, and read-only secrets |

Routes are hashes: `#/accounts`, `#/sessions`, and so on.

## Page rules

**Overview** — the stat row leads with **whether the job is available**, then
accounts, then margin. `selling_at_loss` gets a destructive marker. This page
answers one question in one glance: *is the service working, and am I losing
money on it.*

**Accounts** — the state column is the point of this page. `connected` normal,
`degraded` muted with the flood-wait countdown, `banned` and `dead` in
destructive red. An account about to die is the single most expensive thing that
can happen here, so state is never a subtle colour shift.

**Sessions** — the accounts themselves: phone, state, balance, size, last
updated, and whether one is **in use** right now. Creating a session is a
three-step form (phone, code, then 2FA password if the account has one).
Deleting is a two-step confirm, and the warning says plainly that the service
will be left with no session. **A balance of `0` is ambiguous** — an empty
account, or one nothing has read — so it renders as *unread*, never `$0.0000`,
and an unread balance makes the total render as incomplete.

**Users** — one row per end user with their joined job. Users with no account
assigned show as `waiting`.

**Tasks** — for each catalogue entry: our name, the static sell price, the
provider's cost, and the margin. **A negative margin is destructive red, not a
number to be read carefully.** Jobs the provider is not offering are marked
unavailable, and the hidden list is shown so the admin sees what is being
withheld.

**Messages** — the live feed, newest first, colour-coded by leg. `bot->taskly`
and `taskly->bot` sit together because that pair *is* one conversation. The
provider's dollar figures appear here and **only here** — this page is
admin-only and never shown to an end user.

**Alerts** — severity ordered, unread first, with the time and the full
message. Availability alerts are `critical`.

**Withdrawals** — a four-step flow, because this is the one screen that moves
money.

1. **Balances** — one row per account with a checkbox, the count, and the total.
2. **Preview** — `POST /api/withdrawals` with `confirm: false`. The wallet in
   full, in mono, and the network stated in plain words: most people hold USDT on
   Tron, and a BSC address to someone expecting TRC-20 arrives and is
   unreachable to them. Per account: balance, amount, fee, net, and any `problem`
   in destructive red. Then the totals: accounts, total balance, total amount,
   **total fee**, total net. Every warning verbatim.
3. **Confirm** — two-step arm that re-shows the net and the destination.
4. **Live progress** — per account from the SSE stream, then the results.

A refused line contributes **nothing** to the totals, and the page says so. The
`created` status must not read as success: the provider accepted the request and
never confirms arrival, so show the server's `note` verbatim. Never recompute
`net` client-side — the fee is deducted from the amount, not added to it.

**Settings** — editable: bound user, admin ids, withdrawal wallet, dry-run
switch, watch interval, watch job. Secrets are shown as **present / not set**
and are never returned by the API, so nothing sensitive can be rendered. The
dry-run switch carries a warning, because turning it off enables real payouts.

## How it is built

React 19 + TypeScript, bundled by Vite, styled with Tailwind v4, components from
**shadcn/ui**. The shadcn variables are filled from the palette above rather than
left at their defaults, so the app still looks like this document describes while
every control is a real reusable component instead of hand-rolled markup.

| Where | What |
| --- | --- |
| `web/src/components/ui/` | shadcn primitives - button, card, badge, alert, skeleton, separator |
| `web/src/components/` | the app's own reusable pieces - `DataTable`, `StatTile`, `PageHeader`, `StatusChip`, `Shell` |
| `web/src/pages/` | one component per route |
| `web/src/lib/format.ts` | `usd()` / `bdt()` - the dash-for-unknown contract |
| `web/src/globals.css` | the palette above, mapped onto shadcn's variables |

Two rules survive the port and are worth stating because both were bugs once:

**A figure that is not known renders as `—`, never as a number.** The API sends
`*_known` flags. When one is false the underlying value is a zero, and a zero
cost reads as "the provider gives it away free" and hides a loss. Everything
money-shaped goes through `usd()` / `bdt()`, which take `null` and return the
dash. Bypassing them with template literals reintroduces the bug.

**Routing is real paths, not fragments.** `BrowserRouter` on `/accounts`,
`/withdrawals` and so on, which is why URLs carry no `#`. The Go server already
falls back to `index.html` for unknown paths, so a hard refresh on a deep link
works; that fallback is what makes this possible, and it is load-bearing.

`bun run build` writes `web/dist`, which the Go binary serves as static files.
Bun is the package manager and script runner only - there is no Bun runtime in
production, and no second process to supervise.

## Login

**Only the Telegram sign-in button, centred on `--background`.** No wordmark, no
subtitle, no card border or padding.

The button is a Telegram-blue pill (`#119AF5`, white 16px/600, 22px radius, 44px
tall) styled by us from the tokens above. The widget script is loaded **bare** and
`Telegram.Login.auth` drives the flow, so nothing takes the click away from the
app. The button class must never be `tg-auth-button`: that is the legacy
widget's hook for finding a button to bind itself to, and using it is what broke
sign-in twice. See `AGENTS.md` and the commit that moved it.

A status line and an error line sit beneath it, **hidden until there is something
to say**, so a failed sign-in is still visible without cluttering the resting
page. The session cookie is the only credential of ours; there is no password.

Layout note that cost a fix: the wrapper is **flex with `align-items` and
`justify-content: center`** - in the port, `flex min-h-screen flex-col items-center
justify-center`. A grid with `min-height: 100vh` and more than one child stacks
the rows from the top and `place-items` only centres each item within its own
auto-height row, so the group ends up above the middle.
