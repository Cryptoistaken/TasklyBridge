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
