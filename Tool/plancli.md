# CLI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A CLI in a new `cli/` folder that registers users, submits each user's own spreadsheet against automatically chosen Telegram sessions, records everything in SQLite, and writes each user's new passwords to their own dated output file.

**Architecture:** The CLI is a *new shell* — argument parsing, tables, users, sessions, SQLite, output files — wrapped around the **existing submission engine in `index.js`**, which is imported, never rewritten. The engine holds ~2000 lines of measured gate handling (account chooser, checkpoints, CAPTCHA refusal, blank-banner confirmation, rate-limit breaker) and every fix cost real accounts to find. Rewriting it is the one unacceptable option.

**Tech Stack:** bun 1.4, `bun:sqlite` (built in), `chalk` (already a dependency), `xlsx` (already a dependency). **Zero new dependencies.**

---

## Global Constraints

- **Location:** everything lives in `Tool/cli/`. All state under `Tool/data/cli/`.
- **SQLite only.** `data/cli/cli.sqlite`. No Postgres anywhere in the CLI.
- **Zero new npm dependencies.**
- **The engine is imported, not reimplemented.** `cli/` must not contain a copy of `changePassword`, `walkForPassword`, or any screen-matching regex.
- **Rows are keyed by `uid`, not by cookie fingerprint.** See *Identity* below — this is a deliberate strengthening, not a simplification.
- **Two output modes.** Default = a 7-step overview, one line per step. `--debug` = detailed row-level logs.
- **Credentials are never printed to the terminal or the log.** Uids appear as `***last4`. The new password appears **only** in the user's own output xlsx.
- **A session is held by at most one worker at a time, across BOTH tools.** `index.js` and `cli/` both stay fully usable, so they can be running at once. They cannot both use Postgres advisory locks and SQLite locks and expect to see each other, so **both honour one shared lock file** at `data/locks/<phone>.lock`, holding the owner's PID. A lock whose PID is no longer running is stale and is taken over. See Task 4.
- **`--balance` never touches Telegram unless `--refresh` is passed.** A balance read during a submit run competes for the same chat and can extend a provider rate limit. This was measured, not assumed.
- **`data/cli/storage/` is the operator's.** The CLI never creates, reads or writes it.
- **Bun test runner:** `bun test`.

---

## Folder layout

```
Tool/cli/
  index.js        entry: arg parsing, dispatch, one error handler
  store.js        SQLite schema + every query. The only file that touches the DB.
  render.js       chalk tables, money formatting, the 7-step display
  sessions.js     registry, auto-selection, locks, cached balances
  submit.js       the worker: claim a row, drive the engine, report steps
  output.js       writes each user's new xlsx after every successful row
  balance.js      the --balance report
  *.test.ts       one test file per module

Tool/data/cli/
  .env            the CLI's own env (own path, never the root .env)
  cli.sqlite      the store
  sessions/       the CLI's OWN copies of the .session files
  output/users/<user>/<YYYY-MM-DD>/<source>-<HHMMSS>.xlsx
  storage/        OPERATOR'S. The CLI never creates, reads or writes it.

Tool/data/locks/<phone>.lock     shared by index.js and cli/ — see Task 4
```

`.gitignore` must exclude `data/cli/output/`, `data/cli/cli.sqlite` and `data/cli/sessions/` — the output files contain live passwords and the sessions are live credentials.

**Session files are copied, not shared.** `cli/` reads `data/sessions/*.session` once at startup and copies them to `data/cli/sessions/`, then uses only its own. That is what lets the CLI and `index.js` run at the same time on the same Telegram accounts without fighting over them. They go in `data/cli/sessions/` rather than `data/cli/storage/` because `storage/` is yours — tool-owned files do not belong in a folder the CLI promises never to touch.

---

## Identity: uid, not fingerprint

Chosen: **uid only**, fingerprint dropped.

This is **stronger** than the fingerprint for the one thing that matters. Two different cookies for the same account are the same account. A fingerprint treats them as two rows and can sell one account twice; a uid cannot. The fingerprint only ever proved "this exact cookie string has not been sold", which is a narrower claim than the one we actually need.

What is given up: you can no longer distinguish two cookie *strings* for the same uid. That only mattered for pairing a verdict to an exact cookie, and with uid-keyed rows there is only ever one row per account, so nothing depends on it.

The uid comes from `c_user=(\d+)` in the cookie. `index.js` already exports the parser used for this.

**Consequence for the sold-guard (Task 8):** `sent.jsonl` stores `fp`, not `uid`, so the guard cannot be read straight out of it. It is derived instead — see Task 8, which re-reads the sheets and joins on `(source, row)`.

---

## Commands

| Command | What it does |
|---|---|
| `--register <handle>` | Create a user. |
| `--users` | Users, their counts, what they are owed. |
| `--user <handle> --file <path>` | Submit that user's file. **Repeatable** — several files in one run. Session chosen automatically. |
| `--user <handle> --file <path> --row <n>` | Submit one specific row. |
| `--thread max \| <n>` | Workers to run. Default 1. `max` = every free session. |
| `--balance` | Money from cache. Three tables. |
| `--balance --refresh` | Read live balances, then report. |
| `--sessions` | Session health: balance, rate-limited-until, lock holder. |
| `--queue` | Backlog by status, and who is working what. |
| `--pay <handle> <bkt> [--method m] [--ref r]` | Record a payment; marks it owed-notified. |
| `--report` | Per user: submitted, approved, rejected, owed, paid. |
| `--reconcile` | Ledger vs `--count-from-chat`. Flags disagreement. |
| `--debug` | Detailed row-level output. |
| `--help` | Usage. |

Run it the same way you run the tool today — files and a user:

```
bun cli/index.js --user rakib --file data/2fa44.xlsx --file data/2fa49.xlsx
bun cli/index.js --user rakib --file data/2fa44.xlsx --thread 2
bun cli/index.js --balance
```

A user is **a name you assign** (`--register rakib`). No Telegram account, no bot: payment is manual bkash, so the CLI has no reason to know that Telegram users exist. The archived bot stays archived.

---

## The 7 steps shown by default

```
┌ 2fa44.xlsx ─ user @rakib ─ session ...1929 ────────────── 3 of 44 ┐
│  1  claimed                    ***3557                   ok      │
│  2  reading the sheet          2fa44.xlsx:7              ok      │
│  3  checking the account       alive                     ok      │
│  4  provider password          Emily Douglas · 12 chars  ok      │
│  5  facebook password changed  Teguh Haryanto            ok      │
│  6  key + cookie sent          receipt received          ok      │
│  7  recorded                   awaiting verdict          ok      │
└──────────────────────────────────────────────────────────────────┘
  1 sent · 0 failed · 43 left · ~6h 12m remaining
```

A failure marks one step red and names the reason:

```
│  5  facebook password changed  facebook did not confirm   FAIL    │
```

---

## Data model (SQLite)

```sql
CREATE TABLE users (
  id         INTEGER PRIMARY KEY,
  handle     TEXT NOT NULL UNIQUE,          -- lowercase, '@' stripped
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE rows (
  uid             TEXT PRIMARY KEY,        -- from c_user=. One row per ACCOUNT, ever.
  user_id         INTEGER NOT NULL REFERENCES users(id),
  source          TEXT NOT NULL,           -- '2fa44.xlsx'
  row_no          INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'queued',
                  -- queued | claimed | inflight | approved | rejected | dead | gated
  note            TEXT,
  new_password    TEXT,                    -- the password the provider issued. NEVER logged.
  claimed_by      TEXT,                    -- which session's worker
  claimed_at      TEXT,
  taskly_session  TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at         TEXT,
  verdict_at      TEXT,
  UNIQUE (source, row_no)
);
CREATE INDEX rows_claim    ON rows(status, created_at) WHERE status = 'queued';
CREATE INDEX rows_inflight ON rows(taskly_session, sent_at) WHERE status = 'inflight';
CREATE INDEX rows_user     ON rows(user_id, status);

-- One telegram session, one worker. Reclaimable: a row whose pid is no longer
-- running is stale and is taken over.
CREATE TABLE session_locks (
  phone       TEXT PRIMARY KEY,
  pid         INTEGER NOT NULL,
  acquired_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Cached provider balance. Never read live during a run.
CREATE TABLE session_state (
  phone            TEXT PRIMARY KEY,
  label            TEXT,
  enabled          INTEGER NOT NULL DEFAULT 1,
  balance_usd      REAL,
  balance_at       TEXT,
  rate_limit_until TEXT,
  last_used_at     TEXT
);

-- A provider-issued password must never touch two facebook accounts.
CREATE TABLE used_passwords (
  pw_hash TEXT PRIMARY KEY,
  at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Accounts already sold under the OLD tool. Fingerprints are irrelevant here;
-- this is a uid list, so nothing can be sold twice across the cutover.
CREATE TABLE sold_guard (
  uid    TEXT PRIMARY KEY,
  source TEXT,
  row_no INTEGER,
  at     TEXT
);

-- Append-only. A mistake is corrected by paying the difference, never by editing.
CREATE TABLE payments (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  amount_bkt  REAL NOT NULL,
  method      TEXT,
  reference   TEXT,
  note        TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  notified_at TEXT
);
CREATE INDEX payments_unnotified ON payments(created_at) WHERE notified_at IS NULL;
```

---

## The output xlsx

**Only rows that succeeded.** A row is written when its receipt comes back, and it carries the password that was actually applied.

Path: `data/cli/output/users/<user>/<YYYY-MM-DD>/<source>-<HHMMSS>.xlsx`
(`<HHMMSS>` because re-running the same sheet the same day must not clobber the first run's file.)

| cookie | 2fa_key | password | uid |
|---|---|---|---|

Two rules:

1. **Written after every successful row, not at the end.** A 44-row run is ~7 hours and the tool has died twice mid-run. Rewriting the file per row costs nothing and means a crash costs nothing. SQLite holds the authoritative copy either way; the xlsx is the human-readable one.
2. **The whole sheet is rewritten each time** from the rows SQLite says succeeded for that user. There is no append-only mode — xlsx is a zip and appending means rewriting it anyway. SQLite is the append-only record.

---

## Money model

Per approval, at the live rate:

```
total    = price_usd × rate          0.050 × 122.98 = 6.15 BKT
user     = min(5.00, total × 0.81)                = 5.00 BKT
us       = total − user                          = 1.15 BKT   (18.7%)
```

**Paid per approval, not per submission.** A rejected row earns nothing — with a ~90% approval rate, paying per row means paying ~10% for nothing.

`our cut` is reported **as measured, not as the 19% target**. If the price drops and the cap stops binding, the real cut falls and the report has to say so.

```js
export function split(totalBkt) {
  const user = Math.min(MAX_USER_BKT, Math.round((totalBkt * (1 - OUR_CUT)) / ROUND_TO) * ROUND_TO);
  return { total: totalBkt, user, us: totalBkt - user, cut: (totalBkt - user) / totalBkt };
}
```

---

## `--balance`

```
  PROVIDER BALANCE ─────────────────────────────────── as of 09:14:02 ─
  session        status        usd        bkt      rate-limited until
  ...1929        ok         0.0000      0.00      —
  ...2634        ok         0.9000    110.68      —
  ─────────────────────────────────────────────────────────────────
  TOTAL                     0.9000    110.68

  USER POSITIONS ────────────────────────────────────────────────────────
  user        submitted  approved  rejected  owed bkt  paid bkt  unpaid
  @rakib            44         38         3    190.00     60.00   130.00
  @testuser          4          4         0     20.00     20.00     0.00
  ───────────────────────────────────────────────────────────────────────
  TOTAL              48         42         3    210.00     80.00   130.00

  OUR CUT ───────────────────────────────────────────────────────────────
  revenue from approvals      42 × 6.15      258.30 BKT
  owed to users               42 × 5.00      210.00 BKT
  our cut                     48.30 BKT      18.7%   (target 19.0%)
  provider balance held                      110.68 BKT
  still owed before withdrawal               130.00 BKT
  ⚠ balance is LESS than what is owed — top up before the next run
```

That warning is the point of the command. Owed is a liability; the balance is cash. When owed exceeds cash the business is about to pay out money it does not have, and nothing else says so.

---

## Tasks

### Task 1 — Export the engine functions the CLI needs

`index.js` exports 33 symbols. Three it needs are not among them, so the CLI cannot drive a submit today.

**Files:** Modify `index.js` (three keywords) · Test `cli/engine.test.ts`

**Produces:** `changeFacebook`, `walkForPassword` exported from `index.js`.
(`changePassword`, `Taskly`, `readAccounts`, `parseCookies`, `resolveUrl`, `checkUid`, `checkUids`, `isCookieDead`, `fingerprint`, `normalizePhone`, `listSessions`, `payoutBkt`, `OUR_CUT`, `MAX_USER_BKT`, `cachedRate`, `fetchRate` are already exported.)

- [ ] **Step 1: Failing test**

```ts
// cli/engine.test.ts
import { test, expect } from "bun:test";
import * as engine from "../index.js";

test("the submission engine is importable", () => {
  for (const fn of ["changeFacebook", "walkForPassword", "taskAvailability",
                    "changePassword", "readAccounts", "checkUid", "resolveUrl"]) {
    expect(typeof (engine as any)[fn]).toBe("function");
  }
  expect(typeof engine.Taskly).toBe("function");
});
```

- [ ] **Step 2: Run** `bun test cli/engine.test.ts` → FAIL, `changeFacebook` undefined.
- [ ] **Step 3: Add `export `** to `changeFacebook`, `walkForPassword` and `taskAvailability` in `index.js`. Change nothing else.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: No regression:** `bun index.js --selftest` still passes; `bun test` green.
- [ ] **Step 6: Commit** `git add index.js cli/engine.test.ts && git commit -m "feat: export the submission engine for the cli"`

---

### Task 2 — `cli/render.js` — tables, money, steps

**Files:** Create `cli/render.js`, `cli/render.test.ts`
**Produces:** `table(headers, rows, opts)`, `bkt(n)`, `usd(n)`, `mask(uid)`, `stripAnsi(s)`, `steps({total, index, done})`, `summary({sent, failed, left, eta})`

- [ ] **Step 1: Failing tests**

```ts
test("table columns line up", () => {
  const lines = stripAnsi(table(["a", "bb"], [["1", "22"], ["333", "4"]])).split("\n");
  const w = lines.map((l) => l.length);
  expect(new Set(w).size).toBe(1);
});

test("numbers right-align, text does not", () => {
  const [, r1] = stripAnsi(table(["n", "s"], [["12345", "a"]], { 0: RIGHT })).split("\n");
  expect(r1.indexOf("12345")).toBeGreaterThan(r1.indexOf("a"));
});

test("bkt is 2dp, usd is 4dp", () => {
  expect(bkt(6.151)).toBe("6.15");
  expect(usd(0.45)).toBe("0.4500");
});

test("a uid is masked to its last four", () => {
  expect(mask("1000000000123456")).toBe("***3456");
});

test("an empty table says none rather than printing nothing", () => {
  expect(stripAnsi(table(["a"], []))).toContain("none");
});

test("exactly one step is marked FAIL when one fails", () => {
  const out = stripAnsi(steps({ total: 44, index: 3, done: STEP_LABELS.map((l, i) => ({
    label: l, status: i === 4 ? "fail" : "ok", detail: i === 4 ? "did not confirm" : "" })) }));
  expect((out.match(/FAIL/g) || []).length).toBe(1);
  expect(out).toContain("did not confirm");
});
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** `RIGHT = { align: "right" }`. Pad by *visible* width — `String(s).replace(/\x1b\[[0-9;]*m/g, "")` — because chalk codes have no width and padding by `String.length` breaks every column as soon as colour is on. That is the single most likely thing to get wrong in this module.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `git add cli/render.* && git commit -m "feat: chalk tables and the 7-step display"`

---

### Task 3 — `cli/store.js` — schema and queries

**Files:** Create `cli/store.js`, `cli/store.test.ts`
**Produces:** `open(file?)`, `migrate(s)`, `registerUser`, `listUsers`, `enqueue(s, rows, userId)`, `claimRow(s, session)`, `releaseRow`, `markSent(s, uid, session)`, `bindVerdict(s, session, verdict)`, `tryLock`, `unlock`, `holdLocks`, `claimPassword`, `recordPayment`, `owedFor`, `totals`, `sessionState`, `setSession`, `soldUids`, `userRows(s, userId, statuses)`

- [ ] **Step 1: Failing tests**

```ts
let s;
beforeEach(() => { s = store.open(":memory:"); store.migrate(s); });
afterEach(() => s.close());

test("a user registers once, case-insensitively", () => {
  expect(store.registerUser(s, "@Rakib").handle).toBe("rakib");
  expect(() => store.registerUser(s, "RAKIB")).toThrow(/already/i);
});

test("two cookies for one uid are one account, queued once", () => {
  const u = store.registerUser(s, "rakib");
  const a = { uid: "1001", source: "x.xlsx", row_no: 1, cookie: "c_user=1001; a=1" };
  const b = { uid: "1001", source: "y.xlsx", row_no: 5, cookie: "c_user=1001; a=2" };
  expect(store.enqueue(s, [a], u.id).added).toBe(1);
  expect(store.enqueue(s, [b], u.id).added).toBe(0);   // same ACCOUNT
});

test("two claims never return the same row", () => {
  const u = store.registerUser(s, "rakib");
  store.enqueue(s, [1,2,3].map((n) => ({ uid: String(n), source: "x.xlsx", row_no: n, cookie: "c" })), u.id);
  expect(store.claimRow(s, "A").uid).not.toBe(store.claimRow(s, "B").uid);
});

test("a verdict binds only to its own session's row", () => {
  const u = store.registerUser(s, "rakib");
  store.enqueue(s, [{ uid: "1", source: "x", row_no: 1, cookie: "c" },
                    { uid: "2", source: "x", row_no: 2, cookie: "c" }], u.id);
  store.markSent(s, store.claimRow(s, "A").uid, "A");
  store.markSent(s, store.claimRow(s, "B").uid, "B");
  expect(store.bindVerdict(s, "B", "approved").uid).toBe("2");
  expect(store.bindVerdict(s, "B", "approved")).toBeNull();
  expect(store.totals(s).inflight).toBe(1);
});

test("a password can only be claimed once", () => {
  expect(store.claimPassword(s, "h1")).toBe(true);
  expect(store.claimPassword(s, "h1")).toBe(false);
});

test("one session is locked to one live pid; a dead pid releases", () => {
  expect(store.tryLock(s, "880", 1111)).toBe(true);
  expect(store.tryLock(s, "880", 2222)).toBe(false);
  s.run("UPDATE session_locks SET pid=999999 WHERE phone='880'");
  expect(store.tryLock(s, "880", 2222)).toBe(true);
});

test("a sold uid is never claimable", () => {
  const u = store.registerUser(s, "rakib");
  s.run("INSERT INTO sold_guard (uid) VALUES ('777')");
  store.enqueue(s, [{ uid: "777", source: "x", row_no: 1, cookie: "c" }], u.id);
  expect(store.claimRow(s, "A")).toBeNull();
});

test("owed is derived, never stored", () => {
  const u = store.registerUser(s, "rakib");
  store.enqueue(s, [{ uid: "1", source: "x", row_no: 1, cookie: "c" }], u.id);
  store.markSent(s, "1", "A");
  store.bindVerdict(s, "A", "approved");
  expect(store.owedFor(s, u.id, 6.15).owed).toBeCloseTo(5);
  store.recordPayment(s, { userId: u.id, amount_bkt: 5 });
  expect(store.owedFor(s, u.id, 6.15).owed).toBeCloseTo(0);
});
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** the schema above. Two functions matter most, and both are **one statement**:

```js
export function claimRow(s, session) {
  // sold_guard is joined here, not filtered afterwards: a row that is already
  // sold must never be handed out even for one second.
  return s.prepare(`
    UPDATE rows SET status='claimed', claimed_by=?, claimed_at=datetime('now')
     WHERE uid = (SELECT r.uid FROM rows r
                   LEFT JOIN sold_guard g ON g.uid = r.uid
                  WHERE r.status='queued' AND g.uid IS NULL
                  ORDER BY r.created_at LIMIT 1)
    RETURNING uid, source, row_no, user_id`).get(session) ?? null;
}

export function bindVerdict(s, session, verdict) {
  return s.prepare(`
    UPDATE rows SET status=?, verdict_at=datetime('now')
     WHERE uid = (SELECT uid FROM rows WHERE status='inflight' AND taskly_session=?
                      ORDER BY sent_at LIMIT 1)
    RETURNING uid, source, row_no, user_id`).get(verdict, session) ?? null;
}
```

Single-process SQLite serialises writes, so no `SKIP LOCKED` is needed — an advantage over the Postgres version, not a compromise.

- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `git add cli/store.* && git commit -m "feat: sqlite store keyed by uid"`

---

### Task 4 — The shared session lock (both tools)

**This task modifies `index.js` as well as creating `cli/lock.js`.** It exists because both tools stay usable, so two processes can genuinely target one Telegram session at the same time — and Telegram delivers a session's updates to **one** consumer. The loser reads the winner's messages as replies to its own action and corrupts the run.

Today `index.js` uses a Postgres advisory lock and nothing else knows about it. A second tool with its own SQLite lock cannot see that. So both move to **one lock file**: `data/locks/<phone>.lock`, containing the owner's PID.

**Files:** Create `cli/lock.js`, `cli/lock.test.ts` · Modify `index.js` (replace the advisory-lock call)
**Produces:** `acquire(phone) → release | null`, `holder(phone) → pid | null`

- [ ] **Step 1: Failing tests**

```ts
// Synthetic numbers, on purpose. The real ones are in data/.env and must never
// reach a test file or a commit; Backend uses the same 1555 convention.
const PHONE = "15550100";

test("a second acquire on the same phone is refused", () => {
  const a = acquire(PHONE);
  expect(a).not.toBeNull();
  expect(acquire(PHONE)).toBeNull();
  a.release();
  expect(acquire(PHONE)).not.toBeNull();
});

test("a lock whose owner is dead is taken over", () => {
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(lockPath(PHONE), "999999\n");   // a pid that is not running
  expect(acquire(PHONE)).not.toBeNull();
});
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement `cli/lock.js`.** Write with the flag `wx` so creation is atomic — two processes racing to create the same file means exactly one wins. On `EEXIST`, read the PID and hand over if it is dead.
- [ ] **Step 4: Failing test for the cross-tool case** — a lock file placed by "index.js" is honoured by the CLI, and vice versa. Same path, same format, so this passes by construction; assert it anyway, because the whole point is that the two agree.
- [ ] **Step 5: Change `index.js` to use it.** Replace the `holdSessionLock(phone)` call in `runGroup` with `acquire(phone)` from `cli/lock.js`, and drop the Postgres advisory lock from that path. `db.holdSessionLock` stays in `db.js` — the drain uses it and it is still correct for a single-tool path.
- [ ] **Step 6: Run** `bun test` and `bun index.js --selftest` → both green.
- [ ] **Step 7: Prove it.** Start `bun index.js --xlsx 2fa44.xlsx --row 1 -p <phone>` and, while it runs, start a CLI worker on the same session. Expected: the CLI prints *"session ...1929 is held by pid N — each session runs one worker"* and exits 1 without sending anything.
- [ ] **Step 8: Commit** `git add cli/lock.* index.js && git commit -m "feat: one shared session lock honoured by both tools"`

---

### Task 5 — `cli/sessions.js` — auto-selection and locks

**Files:** Create `cli/sessions.js`, `cli/sessions.test.ts`
**Produces:** `prepare()` (copies sessions into `data/cli/sessions/`), `seed(s, phones)`, `pick(s, threads)`

**Selection order:** enabled → not locked → not rate-limited → least-recently-used. `"max"` = every candidate.

- [ ] **Step 1: Failing tests** — least-recently-used wins; a rate-limited session is skipped; `max` returns all free; a locked session is never returned; **no free session throws** rather than returning `[]` (an empty list silently runs nothing).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** `prepare()` copies `data/sessions/*.session` → `data/cli/sessions/` once, then seeds the registry from **the copies**. Seeding from the originals would let a session the CLI does not own appear available.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit.**

---

### Task 6 — `cli/output.js` — the user's xlsx

**Files:** Create `cli/output.js`, `cli/output.test.ts`
**Consumes:** `store.userRows(s, userId, ["inflight","approved"])`
**Produces:** `writeFor(s, userId, source, now) → path`, `outputDir(userId, date)`

- [ ] **Step 1: Failing tests**

```ts
test("only successful rows reach the file", () => {
  // seed: 2 inflight, 1 queued, 1 rejected
  const rows = store.userRows(s, u.id, ["inflight", "approved"]);
  expect(rows).toHaveLength(2);
});

test("the password column is present and populated", () => {
  const ws = readSheet(writeFor(s, u.id, "2fa44.xlsx"));
  expect(ws[0]).toEqual(["cookie", "2fa_key", "password", "uid"]);
  expect(ws[1][2]).toBe("Abc12345");
});

test("the file is rewritten, not appended, and keeps one row per uid", () => {
  writeFor(s, u.id, "2fa44.xlsx");
  writeFor(s, u.id, "2fa44.xlsx");            // called again after a second row
  const ws = readSheet(latest());
  expect(ws.length).toBe(3);                  // header + 2 rows, not header + 4
});

test("re-running the same sheet the same minute does not clobber", () => {
  expect(pathOf(writeFor(s, u.id, "x.xlsx", at("2026-09-30T10:00:00"))))
    .not.toBe(pathOf(writeFor(s, u.id, "x.xlsx", at("2026-09-30T10:00:01"))));
});
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** Directory `data/cli/output/users/<handle>/<YYYY-MM-DD>/`. Filename `<source>-<HHMMSS>.xlsx` — **the timestamp is required**, because two runs of the same sheet on the same day must not overwrite each other.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Confirm `.gitignore` covers `data/cli/output/` and `data/cli/cli.sqlite`** — these files contain live passwords.
- [ ] **Step 6: Commit.**

---

### Task 7 — `cli/submit.js` — the worker and the 7 steps

**Files:** Create `cli/submit.js`, `cli/submit.test.ts`
**Produces:** `run({ s, threads, debug })`

| # | Step | Engine call |
|---|---|---|
| 1 | claimed | `store.claimRow` |
| 2 | reading the sheet | `readAccounts` |
| 3 | checking the account | `checkUid` |
| 4 | provider password | `walkForPassword` |
| 5 | facebook password changed | `changeFacebook` |
| 6 | key + cookie sent | `tg.sendRaw` ×2 + `press("confirm registration")` |
| 7 | recorded | `store.markSent` |

- [ ] **Step 1: Failing test** — a successful row renders seven `ok` steps; a failure marks exactly one and names it.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** **Reuse the engine. Copy no screen-matching logic.** On step 6 success: store `new_password`, then call `output.writeFor` before moving to the next row — so the password is on disk within seconds of being applied.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit.**

---

### Task 8 — `cli/balance.js` — `--balance`

**Files:** Create `cli/balance.js`, `cli/balance.test.ts`
**Produces:** `report(s, { rate, priceUsd })`

- [ ] **Step 1: Failing tests** — our cut is *measured*, not the 19% target; the warning fires when owed exceeds cash held.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** Without `--refresh`, read `session_state` only. With it, read balances **session by session, sequentially**, recording `rate_limit_until` on any limit.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit.**

---

### Task 9 — `cli/index.js` — entry point

**Files:** Create `cli/index.js`, `cli/cli.test.ts`

- [ ] **Step 1: Failing test** — arg parsing, including `--thread max` as a string and `--thread 2` as a number.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** parse → dispatch → one error handler. **No `console.log` below the renderer.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Full gate:** `bun test` and `bun index.js --selftest` both green.
- [ ] **Step 6: Commit.**

---

### Task 10 — Verdict catch-up from the chat

A verdict arrives ~64 minutes after a send, and only reaches a connected client. Anything that lands while the CLI is stopped is invisible to it — and the row stays `inflight` for ever, quietly corrupting what a user is owed.

Measured 2026-09-30: the provider's history **does** return messages — 603 and 880 per session, containing 40 and 15 verdicts. `AGENTS.md`'s "getHistory returns 0 messages, always" is no longer true, and `--count-from-chat` proved it in about two minutes.

So the CLI walks each session's chat on startup, counts what it finds, and reconciles.

**Files:** Create `cli/reconcile.js`, `cli/reconcile.test.ts`
**Consumes:** `mineChat(tg)` — the same paging function that made `--count-from-chat` work
**Produces:** `mineChat(tg, maxPages)`, `catchUp(s, session) → { found, matched, surplus }`, `run(s, sessions)`

**Two facts about this that must not be forgotten — both were measured, not reasoned about:**

1. **`offsetId`, never `minId`.** `minId` returns the *same newest messages again*, so the walk never advances and reports one page no matter how many were requested. The first version of `--count-from-chat` had this bug and reported "1 approved" over 603 scanned messages.
2. **Keep the first non-blank banner.** The provider's confirmation appears and vanishes within about a second; keeping the *last* value lets a blank overwrite the evidence. That is what made a real password change read as unconfirmed and lost row 25.

- [ ] **Step 1: Failing tests**

```ts
test("a page walk reaches past the first hundred messages", () => {
  expect(mineChat(fakeChat(250)).messages).toBeGreaterThan(100);
});

test("a blank banner never overwrites a real one", () => {
  expect(keepFirst(["Your password is shown", "", ""])).toBe("Your password is shown");
});

test("an approval found in the chat binds to an inflight row", () => {
  expect(catchUp(s, "A").matched).toBe(1);
});

test("a surplus verdict is reported, never silently attached", () => {
  expect(catchUp(s, "B").surplus).toBeGreaterThan(0);   // more verdicts than rows inflight
});

test("a chat with fewer verdicts than inflight rows changes nothing", () => {
  const before = store.totals(s).inflight;
  catchUp(s, "C");
  expect(store.totals(s).inflight).toBe(before);
});
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement `mineChat`.** Page with `offsetId`, `CHAT_PAGE = 100`, inbound only (`!m.out`), tally `approved` / `rejected` / `submitted` and the approved dollar total.
- [ ] **Step 4: Implement `catchUp`.** Compare the chat's counts to the ledger **per session**. When the chat has more approvals than the ledger, bind the difference to the oldest `inflight` rows **for that session only**. When it has fewer, do nothing and say so. Never bind across sessions — that is the 38-vs-37 bug in its original form.
- [ ] **Step 5: Wire it** into `--reconcile` and into the start of every submit run.
- [ ] **Step 6: Run** `bun test` → PASS.
- [ ] **Step 7: Prove it against the real account.** `bun cli/index.js --reconcile` must report **38** approved for `...1929` and **24** for `...2634`. Those are the numbers that settled 38-vs-37; anything else means the walk or the binding is wrong.
- [ ] **Step 8: Commit** `git add cli/reconcile.* && git commit -m "feat: reconcile verdicts from the provider chat"`

---

### Task 11 — Seed the sold-account guard

**The one place old data enters.** A fresh SQLite has never heard of the accounts already sold under the old tool, and their rows are still sitting in `2fa49.xlsx` and `2fa100.xlsx`. Without this a first run would submit them again.

`sent.jsonl` records `fp`, **not `uid`**, so the guard cannot be read from it directly. It is derived by joining the sheets against it:

```ts
// cli/seed-sold.ts — one-time. Run once, then delete the script.
const sold = new Set(
  fs.readFileSync("data/out/sent.jsonl", "utf8").split(/\r?\n/).filter(Boolean)
    .map((l) => { const r = JSON.parse(l); return `${r.source}:${r.row}`; }));

for (const file of ["2fa49.xlsx", "2fa100.xlsx", "2fa44.xlsx"]) {
  for (const a of readAccounts(file)) {
    if (!sold.has(`${file}:${a.row}`)) continue;
    db.prepare("INSERT OR IGNORE INTO sold_guard (uid, source, row_no, at) VALUES (?,?,?,?)")
      .run(uidOf(a.cookie), file, a.row, new Date().toISOString());
  }
}
```

Plus **the accounts that exist only in Postgres** — read them out **before** Postgres is retired. Recount immediately before running and print what was inserted; the number is rising as the current runs finish.

- [ ] **Step 1: Failing test** — a uid in `sold_guard` is never claimable. *(Already covered in Task 3; this task adds the seeding.)*
- [ ] **Step 2: Write `cli/seed-sold.ts`**, join on `(source, row)`.
- [ ] **Step 3: Run it once.** Print the count. Cross-check against the ledger: it must be **at least** the number of `inflight` rows in Postgres, or the join missed something.
- [ ] **Step 4: Verify** `bun cli/index.js --queue` shows no sold uid as `queued`.
- [ ] **Step 5: Delete `cli/seed-sold.ts`** — one-time, and a second run against a grown `sold.jsonl` is a silent trap.
- [ ] **Step 6: Commit.**

---

## Sequencing and cutover

1. **Tasks 1–11 in order.** Each ends independently testable and green.
2. **Both tools stay usable, so both must honour one lock file** — Task 4. Until it lands, `index.js` and `cli/` can corrupt each other by taking the same session, because a Postgres advisory lock is invisible to SQLite.
3. **Two ledgers will exist, and they will disagree.** `index.js` writes Postgres; `cli/` writes SQLite. Neither can see the other's rows. That is the accepted cost of keeping both, and it is why **`--reconcile` and `--count-from-chat` matter more than usual** — they are the only way to know the truth when the two disagree. Pick one tool per account: an account submitted by `index.js` should not also be submitted by `cli/`, and `sold_guard` (Task 11) is what stops the overlap.
4. **Retire Postgres only when you stop using `index.js` for submitting.** Nothing requires it.

## Still open

1. **`data/cli/.env`** — assumed to hold the Telegram `TG_API_ID` / `TG_API_HASH` / `TG_PHONE` and the Facebook current password. The CLI reads its own copy of the session files, but the API credentials are the same.
2. **`--stale` sweep** — rows the provider never rules on currently stay `inflight` for ever. Task 10 catches up on verdicts that *arrived*; it does nothing for a row that was never ruled on at all.
3. **Whether `--reconcile` may run during an active submit.** Same reasoning as `--balance`: a history walk is Telegram traffic. The plan runs it at the start of a run and on demand, and refuses it mid-run unless forced.


