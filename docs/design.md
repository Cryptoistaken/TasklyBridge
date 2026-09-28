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
| degraded, flood-wait, at risk | `--muted-foreground` chip, amber dot |
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

Eight pages. Nothing else.

| Page | Route | Shows |
| --- | --- | --- |
| **Overview** | `/` | Account health, users, the job's availability and margin, unread alerts |
| **Accounts** | `/accounts` | The pool: state, phone, balance, assigned user, flood-wait |
| **Users** | `/users` | End users, joined job, message count, last seen |
| **Tasks** | `/tasks` | The catalogue: offered, hidden, provider cost vs sell price |
| **Messages** | `/messages` | The live four-leg feed |
| **Alerts** | `/alerts` | Price and availability history |
| **Withdrawals** | `/withdrawals` | History, dry-run preview, single-account withdraw |
| **Settings** | `/settings` | Editable config, and read-only secrets |

## Page rules

**Overview** — the stat row leads with **whether the job is available**, then
accounts, then margin. `selling_at_loss` gets a destructive marker. This page
answers one question in one glance: *is the service working, and am I losing
money on it.*

**Accounts** — the state column is the point of this page. `connected` normal,
`degraded` amber with the flood-wait countdown, `banned` and `dead` in
destructive red. An account about to die is the single most expensive thing that
can happen here, so state is never a subtle colour shift.

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

**Withdrawals** — history with the provider's confirmation stored verbatim, and
one account's withdrawal at a time. The action area is a **preview then
confirm**: run `POST /api/withdrawals/preview`, show fee, minimum, net and the
warnings, and only then enable the real button. Show the wallet address in full,
in mono, because a wrong address is unrecoverable. The `created` status must not
read as success — add "the provider accepted this; arrival is not confirmed",
because the provider never confirms arrival.

**Settings** — editable: bound user, admin ids, withdrawal wallet, dry-run
switch, watch interval, watch job. Secrets are shown as **present / not set**
and are never returned by the API, so nothing sensitive can be rendered. The
dry-run switch carries a warning, because turning it off enables real payouts.

## Login

A single centred card on `--background`: wordmark, password field, button.
Nothing else. The session cookie is the only credential.
