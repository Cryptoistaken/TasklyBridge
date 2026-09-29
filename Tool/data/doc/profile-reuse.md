# Browser Profile Reuse — Problem, Fix, Sources

Date: 2026-09-29
Repo: `TasklyBridge/Tool`
File: `Tool/index.js`
Profile: `Tool/profile/`

## 1. Problem

`index.js` reuses one on-disk Chrome profile for every account, every run.

- `PROFILE_DIR = path.join(__dirname, "profile")` — `index.js:43`
- `chromium.launchPersistentContext(PROFILE_DIR, ...)` in 2 places:
  - `changeFacebook()` — `index.js:1322`
  - `openRowBrowser()` (codegen / detect / check-pw) — `index.js:1399`
- Both use `channel: "chrome", headless: false, ...DEVICES_PHONE, locale: "en-US"` + `STEALTH_INIT`.
- Only cleanup per run:
  1. `clearStaleCrashFlag()` — resets `Default/Preferences: profile.exit_type Crashed -> Normal` — `index.js:66-79`, called at `index.js:1321,1398`
  2. `context.clearCookies()` + `context.addCookies(sheet cookie)` — `index.js:1488-1489` and second site
- `context.close()` does NOT wipe the folder. `Tool/profile/Default/`, `Local State`, `Cache`, `IndexedDB`, etc. persist.

Intent is documented in-code at `index.js:227-236`: "clear cookies but stay logged in" per provider rule (do NOT click logout). That part is correct — the implementation is not clean.

### Why cookie-swap != clean for Facebook

`clearCookies()` clears cookies only. It leaves:

- `localStorage / sessionStorage / IndexedDB` for `facebook.com`, `m.facebook.com`, `accountscenter.facebook.com`
- `Cache / Service Workers / HSTS / permissions`
- Profile IDs: `Preferences`, `Local State`, `Variations` seed, Chrome client IDs
- Same fingerprint every run: iPhone UA (`index.js:33-34`), `390x844, dsf 3, isMobile, hasTouch` (`index.js:35-41`), `locale en-US`, same `LAUNCH_ARGS`, same `STEALTH_INIT`, same IP, same machine fonts / canvas / WebGL / GPU

Result Facebook sees: **new `c_user/xs/fr` cookies, same device + same browser storage**. Accounts are linkable across runs; leftover storage from account A is readable during account B's run.

## 2. What Playwright docs expect

Source 1 — Isolation:
https://playwright.dev/docs/browser-contexts

> "Tests execute in isolated clean-slate environments called browser contexts... equivalent to incognito-like profiles. Fast and cheap... completely isolated."
> "Two strategies: start from scratch or cleanup in between... cleanup is easy to forget... some things impossible to clean up such as visited links."

Current code uses the discouraged pattern (persistent profile + cleanup-between).

Source 2 — `browser.newContext`:
https://playwright.dev/docs/api/class-browser#browser-new-context

> "Creates a new browser context. It won't share cookies/cache with other browser contexts."
> Official pattern: `launch() -> newContext() -> newPage() -> close()`.

Source 3 — `browserType.launchPersistentContext`:
https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context

> "`userDataDir` stores cookies and local storage. Pass an empty string to create a temporary directory."
> "Closing this context automatically closes the browser."
> Warning: never point at Chrome's main User Data; use a separate / empty folder.

Source 4 — Auth / clean state:
https://playwright.dev/docs/auth

> Clean = `browser.newPage({ storageState: undefined })`, reset = `storageState: { cookies: [], origins: [] }`.
> `storageState` covers cookies + `localStorage` (+ IndexedDB / WebAuthn notes) — i.e. exactly what `clearCookies()` misses.

Conclusion: for one-cookie-per-run automation, official pattern is **ephemeral context, inject cookie, close**. `launchPersistentContext` is only for when persistence is wanted.

## 3. Solution (minimal, recommended)

Stop reusing `./profile`. Use ephemeral browser + context. No new deps (`fs/os/path` already imported).

Replace both launch sites:

```js
// BEFORE
clearStaleCrashFlag();
const context = await chromium.launchPersistentContext(PROFILE_DIR, {
  ...DEVICES_PHONE, locale: "en-US", headless: false, channel: "chrome", args: LAUNCH_ARGS,
});

// AFTER
const browser = await chromium.launch({ channel: "chrome", headless: false, args: LAUNCH_ARGS });
const context = await browser.newContext({ ...DEVICES_PHONE, locale: "en-US", storageState: undefined });
```

Keep everything else identical:

```js
await context.addInitScript(STEALTH_INIT);
await context.addCookies(parseCookies(cookie, ...)); // keep, still needed
// ... existing work ...
// finally:
await context.close();
await browser.close();
```

Then:

1. Delete or archive `Tool/profile/` (keep a zip backup once). Add `profile/` to `.gitignore` if a tmp path is ever used.
2. Delete `clearStaleCrashFlag()` + its 2 calls — no persistent dir, no crash flag.
3. Keep `clearCookies()` out (redundant on fresh context) or keep harmlessly — `addCookies()` stays.
4. Keep `DEVICES_PHONE`, `locale`, `channel`, `LAUNCH_ARGS`, `STEALTH_INIT` unchanged so behavior/fingerprint is stable, just no longer shared storage.

### Alternative (if `launchPersistentContext` API must stay)

Fresh tmp dir per account, deleted after:

```js
import fs from "node:fs"; import os from "node:os";
const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "fb-"));
const context = await chromium.launchPersistentContext(tmp, { ... });
try { /* work */ } finally { await context.close(); await fs.promises.rm(tmp, { recursive: true, force: true }); }
```

Ephemeral `launch + newContext` is preferred: no tmp cleanup bugs, auto-cleaned.

## 4. What this fixes / does NOT fix

Fixes:

- Cross-account `localStorage / IndexedDB / cache / ServiceWorker` leakage
- `visited-links` and other uncleanable state Playwright warns about
- Crash-bubble handling (`--hide-crash-restore-bubble` + flag patch no longer needed)

Does NOT fix (out of scope for "a little more safe"):

- Same IP every run (needs proxy — separate decision)
- Same UA / viewport / locale (intentional, stable — changing per run looks more bot-like)
- Same machine canvas / WebGL / fonts (needs far heavier tooling, not minimal)
- Provider 2FA / checkpoint / captcha handling — unchanged

## 5. Test plan

1. `bun index.js --selftest` (offline classifier, must stay green)
2. `--detect --xlsx <sheet> --row <n>` on 2 rows — expect form found, no `profile/` recreated
3. `--codegen --xlsx <sheet> --row <n>` — browser opens, cookie works, close leaves no `Tool/profile/`
4. Full dry-run on 1 row, then 2 rows back-to-back — second run must not see first run's storage
5. Confirm no `exit_type=Crashed` bubble path triggers anymore

## 6. Rollback

- Restore `Tool/profile/` from backup zip, revert the 2 functions to `launchPersistentContext(PROFILE_DIR, ...)`.
- No sheet / `data/out/` / Telegram changes involved, so rollback is code-only.
