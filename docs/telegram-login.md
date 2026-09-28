# Telegram Login for the admin panel

Adapted from the working implementation in `C:\Studio\Tools\SheetSubmit`
(`backend/src/lib/telegramOidc.ts` and `Pages/src/components/auth/LoginScreen.tsx`).
That project already does this correctly, so the approach is copied rather than
invented.

**This replaces the shared-password login** in `docs/api.md`.

---

## What it is

Telegram's official Login Widget, served from `oauth.telegram.org`. It is **not**
the old Bot API `initData` scheme. It is a real OIDC provider issuing a signed
JWT, verified against Telegram's published JWKS.

The old scheme (`data-onauth` + HMAC of a bot token) is deprecated and should
not be used.

## How it works

1. The page loads `https://oauth.telegram.org/js/telegram-login.js`
2. It exposes `window.Telegram.Login`
3. `Telegram.auth({ client_id, scope }, callback)` opens Telegram's auth flow
4. Telegram hands back an **id_token** — a JWT
5. The client POSTs that token to our backend
6. **The backend verifies the signature against `https://oauth.telegram.org/.well-known/jwks.json`**
7. Only then does it issue our own session cookie

The critical property: **we never trust the token's contents without checking
the signature.** Anyone can hand us a hand-made JWT claiming to be an admin.

---

## Configuration

```
TELEGRAM_LOGIN_CLIENT_ID=8730058124
ADMIN_USER_IDS=8447133985,1772093705
```

`TELEGRAM_LOGIN_CLIENT_ID` is the **bot id** that owns the widget, not a
username and not a token. For us that is `8730058124` (`@OpenTasksBot`).

`ADMIN_USER_IDS` is the allowlist of Telegram user ids permitted into the panel.
For us: `8447133985` and `1772093705`.

---

## Verification, step by step

Every one of these is a rejection, not a preference. The SheetSubmit code is
the reference.

| Check | Reject when |
| --- | --- |
| Issuer (`iss`) | not `https://oauth.telegram.org` (a trailing `/` is accepted) |
| Audience (`aud`) | not our bot id. May be a string or an array of strings |
| Expiry (`exp`) | in the past |
| Issued-at (`iat`) | more than 60s in the future — clock-skew tolerance |
| Algorithm | header `alg` is not `RS256`. Rejecting this blocks `alg: none` and HMAC confusion |
| Signature | does not verify against any key in the JWKS |
| Subject (`sub`) | not 3–20 digits |

Also: a token over 8192 bytes is rejected before any parsing.

### JWKS caching

Keys are cached for **1 hour** in memory. On a fetch failure the cache is
served if it exists; if there is no cache, the login fails rather than trusting
an unverified token. A login outage is much better than an auth bypass.

Keys are tried in `kid` order first, then any remaining RSA keys, deduplicated
by `kid` or `n:e`. This survives a key rotation mid-session.

---

## The two IDs, and why they are different

- `client_id` = **8730058124** — the bot that owns the widget. It is public and
  appears in the page source. It identifies the *application*.
- `ADMIN_USER_IDS` = **8447133985, 1772093705** — the humans allowed in. This is
  the security boundary.

Conflating them would mean anyone could register a widget for their own bot and
get in. The audience check ties the token to *our* bot, and the allowlist decides
who may actually use the panel.

## Endpoints

| Method | Path | Body | Result |
| --- | --- | --- | --- |
| `GET` | `/api/auth/telegram/config` | — | `{"clientId": 8730058124}`, cacheable 1h |
| `POST` | `/api/auth/telegram/login` | `{"id_token":"..."}` | `{"ok":true,"uid":"..."}` + session cookie |

A non-allowlisted uid is verified successfully and then **rejected with 403**,
logged as `login-denied`, and **no session cookie is issued**. The token is
still verified first, so an invalid token returns 401 rather than leaking
whether an id is on the allowlist.

Rate limited: **30 attempts per IP per 60 seconds**, returning 429.

---

## Session cookie

- `HttpOnly`, `SameSite=Strict`, `Path=/`
- `Secure` when the request is over HTTPS
- 30 days
- HMAC-signed with `ADMIN_SESSION_SECRET`

`Secure` is derived from `x-forwarded-proto`, because the app sits behind a
Railway proxy and the connection is plain HTTP internally.

---

## Client side

The page needs Telegram's script from `oauth.telegram.org`, so it should
`<link rel="preconnect" href="https://oauth.telegram.org" crossorigin>` in
`index.html`.

```ts
const clientId = await fetch("/api/auth/telegram/config").then(r => r.json());

// once loaded
const idToken = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("timed out")), 120_000);
  window.Telegram.Login.auth(
    { client_id: clientId.clientId, scope: ["profile", "phone"] },
    (data) => { clearTimeout(timer); resolve(data); reject(new Error(String(data?.error))); },
  );
});

await fetch("/api/auth/telegram/login", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ id_token: idToken }),
});
```

Note `client_id` is a **number** in the widget call, so it must parse to a safe
positive integer before being sent.

Scope is `["profile", "phone"]` — enough to show who is signed in. SheetSubmit
also requests `write`, which we do **not** need: this panel never writes to a
user's Telegram account, so the narrower scope is correct.

---

## Fallback

**There is none, deliberately.** The widget requires Telegram to be reachable,
and when it is not, nobody can sign in. That is the trade: a fallback password
is a shared secret in front of a panel that can move money, and the weakest link
in that chain should not be something we chose.

`ADMIN_PASSWORD` does not exist in this project. It was in an early draft of
this document and in the env template before the widget was wired up; both are
gone.

If Telegram being unreachable ever becomes a real problem, the answer is a
second bot with its own audience, not a password.

## What this removes

There is no shared secret of ours to leak, share, or forget to rotate. The
credential is a Telegram-issued JWT that the backend verifies and discards, and
what it issues instead is a signed session cookie keyed on
`ADMIN_SESSION_SECRET`.

That matters most on a panel that can withdraw: anyone who learns a shared
password can reach the withdrawal screen.
