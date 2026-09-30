// User -> account -> status, in Postgres. Two tables and nothing else.
//
// The hard part this solves: a taskly verdict carries no identifier, so the only
// way to know which of YOUR users an approval belongs to is to keep the mapping
// at the moment you send. So every submission is stored with the taskly session
// it went out on, and a verdict is bound to a row ONCE and never re-derived.
//
// Secrets: cookie and fa2_key are live credentials and live in here because the
// submitter needs them. They are never logged, never printed, and the report
// only ever shows the 12-char fingerprint.
import { config } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "url";
import pg from "pg";
import { createHash } from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.join(__dirname, "data", ".env") });

const fingerprint = (cookie) => createHash("sha256").update(String(cookie).trim()).digest("hex").slice(0, 12);
export const maskUid = (c) => (c.match(/c_user=(\d+)/)?.[1] ? "***" + c.match(/c_user=(\d+)/)[1].slice(-4) : "none");

// node-postgres returns BIGINT (OID 20) as a STRING, because such values can
// exceed a JS number. Every id here is a serial that never will, and the default
// cost is silent: `u.tg_id === Number(id)` is then always false, so the /status
// button would show every user zero, forever, with nothing in the logs to
// explain why. Parse them as numbers once, here, instead of remembering Number()
// at each of a dozen call sites.
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

// The lifecycle. "queued" is what a user sits in until the job opens.
// "inflight" is the only window where a verdict is ambiguous, and it is bounded
// per taskly session - which is why taskly_session is NOT NULL once sent.
export const STATUS = {
  QUEUED: "queued",     // accepted from the user, not sent to taskly yet
  INFLIGHT: "inflight", // sent to taskly, waiting for a verdict
  APPROVED: "approved", // verdict received
  REJECTED: "rejected", // verdict received
  DEAD: "dead",         // account or cookie dead - never worth sending
  GATED: "gated",       // needs a human (SMS / captcha) - not a verdict
};

let _pool = null;
export function db() {
  if (_pool) return _pool;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set in data/.env");
  _pool = new pg.Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 4 });
  return _pool;
}
export async function closeDb() { if (_pool) { await _pool.end(); _pool = null; } }

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id         BIGSERIAL PRIMARY KEY,
  tg_id      BIGINT UNIQUE NOT NULL,        -- telegram's own user id
  handle     TEXT,                          -- @username, for the admin report
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS submissions (
  id           BIGSERIAL PRIMARY KEY,
  user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fp           TEXT NOT NULL,                -- 12-char cookie fingerprint
  cookie       TEXT NOT NULL,                -- LIVE CREDENTIAL, never logged
  fa2_key      TEXT NOT NULL,                -- LIVE CREDENTIAL, never logged
  status       TEXT NOT NULL DEFAULT 'queued',
  note         TEXT,                         -- why dead/gated, or the raw verdict
  taskly_session TEXT,                       -- which taskly telegram session sent it
  taskly_row    INTEGER,                     -- sheet + row, for traceability
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at      TIMESTAMPTZ,
  verdict_at   TIMESTAMPTZ
);

-- The same cookie must never be queued twice, by anyone. That would submit one
-- account twice and make the verdict pairing wrong for both.
CREATE UNIQUE INDEX IF NOT EXISTS submissions_fp_uniq ON submissions(fp);
-- The drain query: oldest queued first, per run.
CREATE INDEX IF NOT EXISTS submissions_status_created ON submissions(status, created_at);
-- The report: everything for one user.
CREATE INDEX IF NOT EXISTS submissions_user ON submissions(user_id);
-- The verdict lookup: oldest inflight for one taskly session. Bounded by design.
CREATE INDEX IF NOT EXISTS submissions_inflight ON submissions(taskly_session, sent_at)
  WHERE status = 'inflight';

-- A user who has pressed /submit and not yet sent the account. Kept here rather
-- than in the bot's memory so a restart does not drop a half-finished submit.
CREATE TABLE IF NOT EXISTS chat_expect (
  chat BIGINT PRIMARY KEY,
  at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Payments. APPEND-ONLY, and that is the whole design.
--
-- A payment row is never edited and never deleted. A mistake is corrected by
-- recording another row, because an edited ledger is one nobody can trust later.
-- This is the one table where "just update it" is the wrong instinct.
--
-- notified_at is the outbox. It stays null until the user has actually been told,
-- so a payment recorded while the bot was down is still sent when it comes back.
-- One nullable timestamp is the whole retry mechanism - no queue table, no
-- worker, no separate notifications table to keep in step.
--
-- ON DELETE is deliberately NOT CASCADE: a user with payment history must not be
-- deletable by accident, or the money record goes with them.
CREATE TABLE IF NOT EXISTS payments (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id),
  amount      NUMERIC(12,2) NOT NULL,
  method      TEXT,                       -- bkash, nagad, bank, cash
  reference   TEXT,                       -- the transaction id you were given
  note        TEXT,
  admin_tg_id BIGINT,                     -- who recorded it
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  notified_at TIMESTAMPTZ                 -- null = the user has not been told
);
CREATE INDEX IF NOT EXISTS payments_user ON payments(user_id);
-- The outbox read: oldest unnotified first. Partial, because notified rows are
-- never looked at again and there is no reason to index them.
CREATE INDEX IF NOT EXISTS payments_unnotified ON payments(created_at) WHERE notified_at IS NULL;

-- ---- The operator's own inventory ----
--
-- NOT the submissions table, and that is deliberate. submissions is "accounts our
-- USERS gave us" - it drives owedFor(), the payout report and the money. This is
-- "accounts WE already own and sell for ourselves", and a user must never see a
-- single row of it. Merging the two would put 187 of the operator's own accounts
-- into every user's status button and into the payout arithmetic, silently, with
-- nothing in the logs to explain it. Two populations, two tables.
--
-- The ledger used to be JSON files, and that is what stopped several processes
-- running at once: noteSubmission was read-modify-write on one shared
-- pending.json, so two processes could each read 5 rows, each append one, and
-- the second write would delete the first's row. That is the same shape as the
-- 38-vs-37 verdict bug, one level down, and it loses submissions rather than
-- mis-filing them.
CREATE TABLE IF NOT EXISTS sheet_rows (
  fp            TEXT PRIMARY KEY,          -- 12-char cookie fingerprint: one row per account, ever
  source        TEXT NOT NULL,             -- '2fa49.xlsx'
  row_no        INTEGER NOT NULL,
  cookie        TEXT NOT NULL,             -- LIVE CREDENTIAL, never logged or printed
  fa2_key       TEXT,                      -- LIVE CREDENTIAL, same rule
  queue         TEXT NOT NULL DEFAULT 'live',   -- which queue: 'live', or a test's own name. See claimSheetRow.
  status        TEXT NOT NULL DEFAULT 'queued',
  note          TEXT,
  taskly_session TEXT,                     -- which telegram session sent it - the pairing key
  claimed_by    TEXT,                      -- which telegram session is working it right now
  claimed_at   TIMESTAMPTZ,                 -- when it was claimed, so a dead worker's row can be freed
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at       TIMESTAMPTZ,
  verdict_at    TIMESTAMPTZ,
  UNIQUE (source, row_no)
);

-- ADD COLUMN, not more CREATE TABLE IF NOT EXISTS. That clause means "create it
-- if the table is absent" and says nothing about a table that already exists, so
-- the first version of sheet_rows had no claimed_at and every claim after that
-- died on "column does not exist". A schema that cannot be changed is a schema
-- that cannot be corrected.
--
-- It has to sit HERE, above the indexes and not at the end of the script: an
-- index on a column that does not exist yet fails the whole multi-statement
-- query, and a failed migrate reads as "the database is broken" rather than
-- "the statement is in the wrong order".
ALTER TABLE sheet_rows ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;
ALTER TABLE sheet_rows ADD COLUMN IF NOT EXISTS queue TEXT NOT NULL DEFAULT 'live';

-- The claim query: oldest queued first, WITHIN one queue. The queue is part of
-- the key on purpose - see claimSheetRow for why a test must never see a live row.
CREATE INDEX IF NOT EXISTS sheet_rows_claim ON sheet_rows(queue, created_at) WHERE status = 'queued';
-- The dead-worker reaper.
CREATE INDEX IF NOT EXISTS sheet_rows_claimed ON sheet_rows(claimed_at) WHERE status = 'claimed';
-- The verdict lookup: oldest inflight for ONE telegram session. Bounded by design,
-- and per session, so a verdict can only ever claim its own session's row.
CREATE INDEX IF NOT EXISTS sheet_rows_inflight ON sheet_rows(taskly_session, sent_at)
  WHERE status = 'inflight';

-- A bot password must never be used for two Facebook accounts. In JSON this was
-- a read-then-write of an array, so two processes would both see a password as
-- free and both apply it. The primary key makes the claim atomic: the second
-- INSERT is rejected by the database, not by a hopeful check.
CREATE TABLE IF NOT EXISTS used_passwords (
  pw_hash TEXT PRIMARY KEY,
  at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ADD COLUMN, not more CREATE TABLE IF NOT EXISTS. That clause means "create it
-- if the table is absent" and says nothing about a table that already exists, so
-- the first version of sheet_rows had no claimed_at and every claim after that
-- died on "column does not exist". A schema that cannot be changed is a schema
-- that cannot be corrected.
ALTER TABLE sheet_rows ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;
`;

export async function migrate() {
  const c = await db();
  await c.query(SCHEMA);
  return true;
}

// Wipes everything. Used only when explicitly asked for - the tables hold every
// account a user has submitted, so this is not something a run may do on its own.
export async function wipe({ drop = false } = {}) {
  const c = await db();
  if (drop) { await c.query("DROP TABLE IF EXISTS submissions, users, chat_expect CASCADE"); return "dropped"; }
  await c.query("TRUNCATE submissions, users, chat_expect RESTART IDENTITY CASCADE");
  return "truncated";
}

export async function upsertUser(tgId, handle = null) {
  const { rows } = await db().query(
    `INSERT INTO users (tg_id, handle) VALUES ($1, $2)
     ON CONFLICT (tg_id) DO UPDATE SET handle = COALESCE(EXCLUDED.handle, users.handle)
     RETURNING id, tg_id, handle`,
    [tgId, handle],
  );
  return rows[0];
}

// Returns { created, submission } - created:false means this exact cookie was
// already known, whatever its status, so it is never queued twice.
export async function addSubmission(userId, cookie, fa2Key) {
  const fp = fingerprint(cookie);
  const c = await db();
  const dupe = await c.query("SELECT id, status FROM submissions WHERE fp = $1", [fp]);
  if (dupe.rowCount) return { created: false, existing: dupe.rows[0] };
  const { rows } = await c.query(
    `INSERT INTO submissions (user_id, fp, cookie, fa2_key, status)
     VALUES ($1, $2, $3, $4, 'queued') RETURNING id, fp, status, created_at`,
    [userId, fp, String(cookie).trim(), String(fa2Key).replace(/\s+/g, "")],
  );
  return { created: true, submission: rows[0] };
}

// Oldest queued row, and it is claimed in the SAME statement so two processes
// cannot pick up the same account.
export async function claimNextQueued() {
  const { rows } = await db().query(
    `UPDATE submissions SET status = 'inflight', sent_at = now()
     WHERE id = (SELECT id FROM submissions WHERE status = 'queued'
                 ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
     RETURNING id, user_id, fp, cookie, fa2_key`,
  );
  return rows[0] ?? null;
}

export async function markSent(id, tasklySession, tasklyRow = null) {
  await db().query("UPDATE submissions SET taskly_session = $2, taskly_row = $3 WHERE id = $1", [id, tasklySession, tasklyRow]);
}

// THE pairing. Oldest inflight for THIS taskly session only - never another
// session's row. Returns null when that session has nothing outstanding, so the
// verdict is recorded as unpaired instead of stealing somebody else's account.
export async function bindVerdict(tasklySession, verdict, note = null) {
  const { rows } = await db().query(
    `UPDATE submissions
        SET status = $2, verdict_at = now(), note = COALESCE($3, note)
      WHERE id = (SELECT id FROM submissions
                   WHERE status = 'inflight' AND taskly_session = $1
                   ORDER BY sent_at LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING id, user_id, fp`,
    [tasklySession, verdict, note],
  );
  return rows[0] ?? null;
}

// Undo a claim when the submit failed before taskly ever saw it. Anything that
// did reach taskly stays inflight, because a verdict may still be coming for it.
export async function releaseToQueued(id, note = null) {
  await db().query(
    "UPDATE submissions SET status = 'queued', sent_at = NULL, note = COALESCE($2, note) WHERE id = $1 AND status = 'inflight'",
    [id, note],
  );
}

export async function markStatus(id, status, note = null) {
  await db().query("UPDATE submissions SET status = $2, note = COALESCE($3, note) WHERE id = $1", [id, status, note]);
}

// The report the admin asked for: per user, how many of each status. Never
// touches cookie or fa2_key, so it is safe to print anywhere.
export async function report() {
  const { rows } = await db().query(
    `SELECT u.id AS user_id, u.tg_id, COALESCE(u.handle,'-') AS handle,
            s.status, count(*)::int AS n
       FROM submissions s JOIN users u ON u.id = s.user_id
      GROUP BY u.id, u.tg_id, u.handle, s.status
      ORDER BY u.id, s.status`,
  );
  const users = new Map();
  for (const r of rows) {
    if (!users.has(r.user_id)) users.set(r.user_id, { tg_id: r.tg_id, handle: r.handle, counts: {} });
    users.get(r.user_id).counts[r.status] = r.n;
  }
  return [...users.values()];
}

export async function totals() {
  const { rows } = await db().query("SELECT status, count(*)::int AS n FROM submissions GROUP BY status");
  const t = { queued: 0, inflight: 0, approved: 0, rejected: 0, dead: 0, gated: 0, all: 0 };
  for (const r of rows) { t[r.status] = r.n; t.all += r.n; }
  return t;
}

// ---- Payments (append-only) ----

// Resolves a telegram id to a user row, so an admin types the id a user sees
// rather than an internal one. Returns null rather than throwing, because "no
// such user" is a normal answer to a command and should print cleanly.
export async function findUser(tgId) {
  const { rows } = await db().query("SELECT id, tg_id, handle FROM users WHERE tg_id = $1", [tgId]);
  return rows[0] ?? null;
}

// Records a payment, still unnotified. It is never updated afterwards except to
// stamp notified_at - that one column is the whole notification lifecycle.
export async function recordPayment({ userId, amount, method = null, reference = null, note = null, adminTgId = null }) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`amount must be a positive number, got ${amount}`);
  const { rows } = await db().query(
    `INSERT INTO payments (user_id, amount, method, reference, note, admin_tg_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, user_id, amount, method, reference, note, created_at, notified_at`,
    [userId, n.toFixed(2), method, reference, note, adminTgId],
  );
  return rows[0];
}

// The outbox read. Locked and stamped in ONE statement, so two bot processes
// cannot send the same payment twice.
export async function claimUnnotified(limit = 10) {
  const { rows } = await db().query(
    `UPDATE payments SET notified_at = now()
      WHERE id IN (SELECT id FROM payments WHERE notified_at IS NULL
                   ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED)
      RETURNING id, user_id, amount, method, reference, note`,
    [limit],
  );
  return rows;
}

// Puts a payment back on the outbox after a failed send. Without this, a payment
// nobody was told about would be marked done and never retried - the one way an
// outbox can quietly lose work.
export async function unmarkNotified(id) {
  await db().query("UPDATE payments SET notified_at = NULL WHERE id = $1", [id]);
}

export async function userTgId(userId) {
  const { rows } = await db().query("SELECT tg_id FROM users WHERE id = $1", [userId]);
  return rows[0]?.tg_id ?? null;
}

// What has actually been paid to a user, and when. Derived from the ledger, never
// a stored balance - a stored balance drifts out of step with the approvals and
// then nobody trusts the number.
export async function paidFor(userId) {
  const { rows } = await db().query(
    `SELECT count(*)::int AS n, COALESCE(sum(amount),0) AS total, max(created_at) AS last_at
       FROM payments WHERE user_id = $1`,
    [userId],
  );
  return { count: rows[0].n, total: Number(rows[0].total), lastAt: rows[0].last_at };
}

// Approved-but-unpaid, which is the number that actually drives a payout. The
// rate is passed in rather than stored: pricing is a decision made at payout
// time, and a rate frozen into the schema goes stale silently.
export async function owedFor(userId, ratePerApproved) {
  const { rows } = await db().query(
    `SELECT
       (SELECT count(*) FROM submissions WHERE user_id = $1 AND status = 'approved') AS approved,
       COALESCE((SELECT sum(amount) FROM payments WHERE user_id = $1), 0) AS paid`,
    [userId],
  );
  const approved = Number(rows[0].approved), paid = Number(rows[0].paid);
  return { approved, paid, owed: Math.max(0, approved * Number(ratePerApproved) - paid) };
}

// Daily counts, straight from the submissions table. A query, not a rollup table:
// nothing to keep in step, nothing to migrate.
// Who has approved accounts and has never been paid. The list that should drive
// a payout session - it is the difference between "users exist" and "you owe
// these people money", and it is a query, so it can never go stale.
export async function unpaidUsers() {
  const { rows } = await db().query(
    `SELECT u.id, u.tg_id, COALESCE(u.handle,'-') AS handle, count(s.id)::int AS approved
       FROM users u
       JOIN submissions s ON s.user_id = u.id AND s.status = 'approved'
       LEFT JOIN payments p ON p.user_id = u.id
      WHERE p.id IS NULL
      GROUP BY u.id, u.tg_id, u.handle
      ORDER BY count(s.id) DESC`,
  );
  return rows;
}

export async function dailyStats(days = 7) {
  const { rows } = await db().query(
    `SELECT date_trunc('day', created_at)::date AS day,
            count(*)::int AS submitted,
            count(*) FILTER (WHERE status = 'approved')::int AS approved,
            count(*) FILTER (WHERE status = 'rejected')::int AS rejected,
            count(*) FILTER (WHERE status IN ('queued','inflight'))::int AS pending
       FROM submissions
      WHERE created_at > now() - ($1 || ' days')::interval
      GROUP BY 1 ORDER BY 1 DESC`,
    [String(days)],
  );
  return rows;
}

export async function dailyPayments(days = 30) {
  const { rows } = await db().query(
    `SELECT date_trunc('day', created_at)::date AS day,
            count(*)::int AS n, COALESCE(sum(amount),0) AS total
       FROM payments
      WHERE created_at > now() - ($1 || ' days')::interval
      GROUP BY 1 ORDER BY 1 DESC`,
    [String(days)],
  );
  return rows;
}

// ---- Routine housekeeping ----

// The ONE delete that runs on a schedule. Everything else transitions or appends.
export async function clearExpiredExpect(minutes = 30) {
  const { rowCount } = await db().query(
    "DELETE FROM chat_expect WHERE at < now() - ($1 || ' minutes')::interval", [String(minutes)],
  );
  return rowCount ?? 0;
}

// Crash recovery: rows claimed inflight by a process that died before taskly ever
// saw them. Those can go back in the queue. A row taskly DID receive cannot,
// because a verdict may still be coming for it - so the age threshold is the
// guard, and it is deliberately long.
export async function requeueStale(olderThanMinutes = 120) {
  const { rowCount } = await db().query(
    `UPDATE submissions SET status = 'queued', sent_at = NULL, taskly_session = NULL,
            note = COALESCE(note, 'requeued: claimed but never confirmed sent')
      WHERE status = 'inflight' AND sent_at < now() - ($1 || ' minutes')::interval`,
    [String(olderThanMinutes)],
  );
  return rowCount ?? 0;
}
// What the provider has already paid out, in BKT. The gate for the next payout
// is this against what is actually in the provider's balance: a payout can only
// come from money that really arrived, never from money that is merely expected.
export async function paidTotalBkt() {
  const { rows } = await db().query("SELECT COALESCE(sum(amount),0) AS t FROM payments");
  return Number(rows[0].t);
}

// ---- The operator's own inventory (./sheet_rows) ----
//
// Everything here is ONE statement per action, on purpose. The JSON ledger it
// replaced needed read-then-write, and read-then-write is exactly what breaks
// when a second process exists.

// Loads the sheet into the queue. Idempotent on (source, row_no) and on fp, so
// re-loading after a crash adds nothing and a row already sent is not requeued.
// Returns {added, known}.
export async function enqueueSheetRows(rows, queue = REAL_QUEUE) {
  const c = await db();
  let added = 0, known = 0;
  for (const r of rows) {
    const { rows: out } = await c.query(
      `INSERT INTO sheet_rows (fp, source, row_no, cookie, fa2_key, queue)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (fp) DO NOTHING
       RETURNING fp`,
      [r.fp, r.source, r.row_no, r.cookie, r.fa2_key ?? null, String(queue)],
    );
    if (out.length) added++; else known++;
  }
  return { added, known };
}

// THE claim. One UPDATE over a SKIP LOCKED subselect, so N processes can all
// call this at once and every one of them gets a DIFFERENT row - or null when
// the queue is empty. This is the whole reason several instances can run.
//
// The status MUST move to 'claimed' here. The first version only set claimed_by,
// which left the row 'queued' and therefore still claimable: six processes each
// walked away with the SAME row, 36 times over. concur.mjs caught it, and that
// symptom - every instance working the same account - is the exact failure this
// whole change exists to prevent.
export async function claimSheetRow(session) {
  const { rows } = await db().query(
    `UPDATE sheet_rows SET status = 'claimed', claimed_by = $1, claimed_at = now()
      WHERE fp = (SELECT fp FROM sheet_rows WHERE status = 'queued'
                   ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING fp, source, row_no, cookie, fa2_key`,
    [String(session ?? "")],
  );
  return rows[0] ?? null;
}

// ---- Test isolation ----
//
// concur.mjs spawns real workers, and those workers claim real rows. On a loaded
// queue they took 72 REAL accounts - every row in the queue at the time - and left
// two of them stuck in 'claimed' under the name "nobody", which is what a claim
// looks like when its worker died without releasing.
//
// So a queue row carries an explicit QUEUE ID, and claimSheetRow only ever sees
// rows in the queue it was asked about. The test names its own; the live workers
// use the real one. A test cannot touch a real account, and this function cannot
// pick one up by accident, which is the property that was missing.
export const REAL_QUEUE = "live";
export async function claimSheetRow(session, queue = REAL_QUEUE) {
  const { rows } = await db().query(
    `UPDATE sheet_rows SET status = 'claimed', claimed_by = $1, claimed_at = now()
      WHERE fp = (SELECT fp FROM sheet_rows WHERE status = 'queued' AND queue = $2
                   ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING fp, source, row_no, cookie, fa2_key`,
    [String(session ?? ""), String(queue)],
  );
  return rows[0] ?? null;
}

// Gives a claim back. Used when a row fails BEFORE taskly ever saw it, and when a
// process died holding one - otherwise a crash strands the row in 'claimed' for
// ever and the account is silently never sold.
export async function releaseSheetRow(fp, note = null) {
  const { rowCount } = await db().query(
    `UPDATE sheet_rows SET status = 'queued', claimed_by = NULL, claimed_at = NULL,
            note = COALESCE($2, note)
      WHERE fp = $1 AND status = 'claimed'`,
    [fp, note],
  );
  return rowCount ?? 0;
}

// Claims stranded by a worker that died mid-row. Deliberately long: a claim is
// only given up once it is near-certain the worker is gone, because a live worker
// that is merely slow looks identical from here.
export async function requeueStaleClaims(olderThanMinutes = 90) {
  const { rowCount } = await db().query(
    `UPDATE sheet_rows SET status = 'queued', claimed_by = NULL, claimed_at = NULL,
            note = COALESCE(note, 'requeued: the worker holding it stopped responding')
      WHERE status = 'claimed' AND claimed_at < now() - ($1 || ' minutes')::interval`,
    [String(olderThanMinutes)],
  );
  return rowCount ?? 0;
}

// Sent: taskly has it and has said so. One statement sets BOTH the status and
// the session, because the session is what a verdict will be matched against
// later - splitting them across two writes is a window where a verdict for this
// row cannot be paired to anything.
// Sent: taskly has it and has said so. One statement sets BOTH the status and
// the session, because the session is what a verdict will be matched against
// later - splitting them across two writes is a window where a verdict for this
// row cannot be paired to anything.
//
// It INSERTS when the row is unknown, which is the case for every account sent
// before this table existed. A bare UPDATE matches nothing for those and reports
// no error, so adoption looked like it worked while recording nothing at all -
// and the next run would submit all 67 already-sold accounts a second time.
//
// The cookie is a live credential, so it is inserted as an empty string rather
// than invented: the row's job is the STATUS and the SESSION, both of which are
// what the pairing and the payout arithmetic actually read. The fingerprint is
// enough to identify the account.
export async function markSheetSent(fp, session, source, rowNo) {
  await db().query(
    `INSERT INTO sheet_rows (fp, source, row_no, cookie, status, taskly_session, sent_at, note)
       VALUES ($1, $2, $3, '', 'inflight', $4, now(), 'adopted: sent before this ledger existed')
     ON CONFLICT (fp) DO UPDATE
       SET status = CASE WHEN sheet_rows.status = 'approved' THEN 'approved' ELSE 'inflight' END,
           taskly_session = COALESCE(NULLIF(sheet_rows.taskly_session, ''), $4),
           sent_at = COALESCE(sheet_rows.sent_at, now())`,
    [fp, source ?? "adopted", rowNo ?? 0, String(session ?? "")],
  );
}

export async function markSheetStatus(fp, status, note = null) {
  await db().query(
    "UPDATE sheet_rows SET status = $2, note = COALESCE($3, note) WHERE fp = $1",
    [fp, status, note],
  );
}

// A row that died, was gated, or was left half-used. Terminal on purpose: these
// are the accounts a later run must not touch again.
const DEAD_STATUSES = ["dead", "gated", "half-used"];
export async function markSheetSkipped(fp, reason, source = null, rowNo = null) {
  const c = await db();
  // "half-used" is its own status because it is a different fact from "dead":
  // the password WAS changed and the account is ours, it simply was never
  // delivered. Folding it into "dead" would lose the only clue that says the
  // password is now the bot's.
  const st = /^half-used/i.test(reason ?? "") ? "half-used" : "skipped";
  await c.query(
    `UPDATE sheet_rows SET status = $2, note = $3 WHERE fp = $1`,
    [fp, st, String(reason ?? "").slice(0, 300)],
  );
  // A row that only exists in the JSON ledgers (sent before this table) is
  // adopted rather than lost, so the new table is a superset of the old state.
  return st;
}

export async function sheetKnown() {
  const { rows } = await db().query(
    "SELECT fp, status FROM sheet_rows WHERE status IN ('inflight','approved','rejected','dead','gated','half-used','skipped')",
  );
  const sent = new Set(), skipped = new Set();
  for (const r of rows) {
    if (r.status === "inflight" || r.status === "approved" || r.status === "rejected") sent.add(r.fp);
    else skipped.add(r.fp);
  }
  return { sent, skipped };
}

export async function sheetCounts() {
  const { rows } = await db().query("SELECT status, count(*)::int AS n FROM sheet_rows GROUP BY status");
  const t = { queued: 0, claimed: 0, inflight: 0, approved: 0, rejected: 0, dead: 0, gated: 0, skipped: 0, "half-used": 0, all: 0 };
  for (const r of rows) { t[r.status] = r.n; t.all += r.n; }
  return t;
}

// THE verdict pairing, for a sheet row. Oldest inflight for THIS telegram
// session only, and FOR UPDATE SKIP LOCKED so two processes receiving verdicts
// on different sessions cannot claim the same row. Returns null when that
// session has nothing outstanding, so the verdict is recorded as unpaired
// rather than stealing another session's account.
export async function bindSheetVerdict(session, verdict, note = null) {
  const { rows } = await db().query(
    `UPDATE sheet_rows
        SET status = $2, verdict_at = now(), note = COALESCE($3, note)
      WHERE fp = (SELECT fp FROM sheet_rows
                   WHERE status = 'inflight' AND taskly_session = $1
                   ORDER BY sent_at LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING fp, source, row_no`,
    [String(session ?? ""), verdict, note],
  );
  return rows[0] ?? null;
}

export async function sheetPendingFor(session) {
  const { rows } = await db().query(
    "SELECT count(*)::int AS n FROM sheet_rows WHERE status = 'inflight' AND taskly_session = $1",
    [String(session ?? "")],
  );
  return rows[0].n;
}

// ---- Passwords: an atomic claim, not a hopeful check ----
//
// Returns true when this caller is the FIRST to claim the password. Two
// processes calling this at the same moment get one true and one false, decided
// by the primary key rather than by who read the file first.
export async function claimPassword(pwHash) {
  const { rows } = await db().query(
    "INSERT INTO used_passwords (pw_hash) VALUES ($1) ON CONFLICT (pw_hash) DO NOTHING RETURNING pw_hash",
    [String(pwHash)],
  );
  return rows.length > 0;
}
export async function passwordClaimed(pwHash) {
  const { rows } = await db().query("SELECT 1 FROM used_passwords WHERE pw_hash = $1", [String(pwHash)]);
  return rows.length > 0;
}

// ---- One telegram session, one process ----
//
// Telegram delivers updates to exactly ONE consumer of a session. Two processes
// on the same MTProto session do not share the work, they FIGHT over it: one
// eats the other's replies, and the loser sees its own messages come back as
// somebody else's answer. The Go bridge guards this with a lock file; this is
// the same guard, done properly.
//
// A Postgres ADVISORY lock, because it needs no lock file, works across machines,
// and is released automatically when the connection dies - so a killed process
// cannot leave a session permanently unusable, which a stale lock file can and
// did.
//
// It must be a DEDICATED connection: advisory locks belong to a session, and
// the pool hands out connections per query. Holding a client for the life of the
// process is the only correct way to own one.
export async function holdSessionLock(session) {
  const client = await db().connect();
  const { rows } = await client.query("SELECT pg_try_advisory_lock(hashtext($1)) AS ok", [String(session ?? "")]);
  if (!rows[0]?.ok) {
    client.release();
    return null;
  }
  return {
    session: String(session),
    release: async () => { try { await client.query("SELECT pg_advisory_unlock(hashtext($1))", [String(session)]); } catch { /* closing releases it anyway */ } client.release(); },
  };
}

// Which telegram sessions this machine actually has, read from the session files
// rather than configured, so an operator cannot point two instances at one.
export async function listKnownSessions() {
  const { rows } = await db().query("SELECT DISTINCT taskly_session FROM sheet_rows WHERE taskly_session IS NOT NULL ORDER BY 1");
  return rows.map((r) => r.taskly_session);
}