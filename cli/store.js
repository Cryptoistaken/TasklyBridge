import { Database } from "bun:sqlite";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { OUR_CUT, MAX_USER_BKT, ROUND_TO } from "../index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const defaultFile = () => path.join(here, "..", "data", "cli", "cli.sqlite");

export function open(file) {
  const f = file ?? defaultFile();
  if (f !== ":memory:") fs.mkdirSync(path.dirname(f), { recursive: true });
  const s = new Database(f, { create: true });
  s.exec("PRAGMA journal_mode = WAL;");
  return s;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id         INTEGER PRIMARY KEY,
  handle     TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS rows (
  uid             TEXT PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id),
  source          TEXT NOT NULL,
  row_no          INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'queued',
  note            TEXT,
  new_password    TEXT,
  claimed_by      TEXT,
  claimed_at      TEXT,
  taskly_session  TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at         TEXT,
  verdict_at      TEXT,
  UNIQUE (source, row_no)
);
CREATE INDEX IF NOT EXISTS rows_claim    ON rows(status, created_at) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS rows_inflight ON rows(taskly_session, sent_at) WHERE status = 'inflight';
CREATE INDEX IF NOT EXISTS rows_user     ON rows(user_id, status);

CREATE TABLE IF NOT EXISTS session_locks (
  phone       TEXT PRIMARY KEY,
  pid         INTEGER NOT NULL,
  acquired_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS session_state (
  phone            TEXT PRIMARY KEY,
  label            TEXT,
  enabled          INTEGER NOT NULL DEFAULT 1,
  balance_usd      REAL,
  balance_at       TEXT,
  rate_limit_until TEXT,
  last_used_at     TEXT
);

CREATE TABLE IF NOT EXISTS used_passwords (
  pw_hash TEXT PRIMARY KEY,
  at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sold_guard (
  uid    TEXT PRIMARY KEY,
  source TEXT,
  row_no INTEGER,
  at     TEXT
);

CREATE TABLE IF NOT EXISTS payments (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  amount_bkt  REAL NOT NULL,
  method      TEXT,
  reference   TEXT,
  note        TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  notified_at TEXT
);
CREATE INDEX IF NOT EXISTS payments_unnotified ON payments(created_at) WHERE notified_at IS NULL;
`;

export function migrate(s) {
  s.exec(SCHEMA);
  return true;
}

const cleanHandle = (h) => String(h ?? "").trim().replace(/^@+/, "").toLowerCase();

export function registerUser(s, handle) {
  const h = cleanHandle(handle);
  if (!h) throw new Error("handle must not be empty");
  try {
    return s.query("INSERT INTO users (handle) VALUES (?) RETURNING id, handle").get(h);
  } catch {
    throw new Error(`user @${h} is already registered`);
  }
}

export function listUsers(s) {
  return s.query("SELECT id, handle, created_at FROM users ORDER BY id").all();
}

const ownerOf = (s, uid) =>
  s.query(`SELECT r.source AS ownerSource, r.row_no AS ownerRow, r.status, u.handle AS owner
             FROM rows r JOIN users u ON u.id = r.user_id WHERE r.uid = ?`).get(uid) ?? null;

// Loud by design: returns { added, duplicates, invalid }, never silent.
// duplicates[] = { uid, source, row_no, owner, ownerSource, ownerRow, status, where }.
// where is 'rows' | 'sold_guard' | 'source_row'. No force flag: duplicates are
// never queueable; the wrong-user fix is transferRow, the only move path.
export function enqueue(s, rows, userId) {
  const out = { added: 0, duplicates: [], invalid: [] };
  const ins = s.query("INSERT INTO rows (uid, user_id, source, row_no) VALUES (?, ?, ?, ?)");
  for (const r of rows ?? []) {
    const uid = r?.uid == null || r.uid === "" ? null : String(r.uid);
    if (!uid) { out.invalid.push({ uid: null, source: r?.source ?? null, row_no: r?.row_no ?? null }); continue; }
    if (s.query("SELECT 1 AS x FROM sold_guard WHERE uid = ?").get(uid)) {
      out.duplicates.push({ uid, source: r.source, row_no: r.row_no, owner: null,
        ownerSource: null, ownerRow: null, status: "sold", where: "sold_guard" });
      continue;
    }
    const own = ownerOf(s, uid);
    if (own) {
      out.duplicates.push({ uid, source: r.source, row_no: r.row_no, owner: own.owner,
        ownerSource: own.ownerSource, ownerRow: own.ownerRow, status: own.status, where: "rows" });
      continue;
    }
    const clash = s.query("SELECT uid FROM rows WHERE source = ? AND row_no = ?").get(r.source, r.row_no);
    if (clash) {
      const o = ownerOf(s, clash.uid);
      out.duplicates.push({ uid, source: r.source, row_no: r.row_no, owner: o?.owner ?? null,
        ownerSource: o?.ownerSource ?? null, ownerRow: o?.ownerRow ?? null,
        status: o?.status ?? "unknown", where: "source_row" });
      continue;
    }
    ins.run(uid, userId, r.source, r.row_no);
    out.added++;
  }
  return out;
}

// Best-effort audit line. Audit never fails the run.
function auditLine(rec) {
  try {
    const dir = path.join(here, "..", "data", "cli");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, `audit-${new Date().toISOString().slice(0, 10)}.jsonl`),
      JSON.stringify({ at: new Date().toISOString(), ...rec }) + "\n", "utf8");
  } catch { /* audit never fails the run */ }
}

// The only move path for a wrong-user row. Moves the row, keeps payments
// history with the old user (money already paid is corrected with payment
// rows, never by editing).
export function transferRow(s, uid, toUserId) {
  const cur = s.query("SELECT user_id FROM rows WHERE uid = ?").get(String(uid));
  if (!cur) throw new Error(`no row for uid ${uid}`);
  if (cur.user_id === toUserId) return 0;
  const from = s.query("SELECT handle FROM users WHERE id = ?").get(cur.user_id);
  const to = s.query("SELECT handle FROM users WHERE id = ?").get(toUserId);
  if (!to) throw new Error(`no user with id ${toUserId}`);
  s.query("UPDATE rows SET user_id = ?, note = COALESCE(note, 'transferred') WHERE uid = ?").run(toUserId, String(uid));
  auditLine({ what: "transfer", uid: String(uid), from: from?.handle ?? cur.user_id, to: to.handle });
  return 1;
}

// Sold uids are joined here, not filtered afterwards: a sold row must never
// be handed out even for one second.
export function claimRow(s, session) {
  return s.query(`
    UPDATE rows SET status='claimed', claimed_by=?, claimed_at=datetime('now')
     WHERE uid = (SELECT r.uid FROM rows r
                   LEFT JOIN sold_guard g ON g.uid = r.uid
                  WHERE r.status='queued' AND g.uid IS NULL
                  ORDER BY r.created_at LIMIT 1)
    RETURNING uid, source, row_no, user_id`).get(session) ?? null;
}

// Back on the queue only when the claim is still untouched. Anything the
// worker changed (inflight, half-used, verdicts) never comes back here.
export function releaseRow(s, uid, note = null) {
  const r = s.query(`UPDATE rows SET status='queued', claimed_by=NULL, claimed_at=NULL,
            note=COALESCE(?, note) WHERE uid=? AND status='claimed'`).run(note, String(uid));
  return Number(r?.changes ?? 0);
}

// Dead-worker reaper: claimed long ago with the password untouched. Half-used
// and inflight rows are never touched — a verdict may still be coming, and a
// changed password can never be retried.
export function requeueStaleClaims(s, olderThanMinutes = 90) {
  const r = s.query(`UPDATE rows SET status='queued', claimed_by=NULL, claimed_at=NULL,
            note=COALESCE(note, 'requeued: the worker holding it stopped responding')
       WHERE status='claimed' AND claimed_at < datetime('now', '-' || ? || ' minutes')`)
    .run(Number(olderThanMinutes));
  return Number(r?.changes ?? 0);
}

export function markSent(s, uid, session) {
  const r = s.query(`UPDATE rows SET status='inflight', taskly_session=?, sent_at=datetime('now')
       WHERE uid=? AND status IN ('queued','claimed')`).run(String(session ?? ""), String(uid));
  return Number(r?.changes ?? 0);
}

// Terminal: the password is already the provider's, so retrying can never
// work. Recorded, never re-queued, never sold-guard (it was never delivered).
export function markHalfUsed(s, uid, reason) {
  const r = s.query(`UPDATE rows SET status='half-used', note=?
       WHERE uid=? AND status IN ('queued','claimed','inflight')`)
    .run(String(reason ?? "half-used: password changed, not delivered").slice(0, 300), String(uid));
  return Number(r?.changes ?? 0);
}

// Oldest inflight for THIS session only. Null when the session has nothing
// outstanding, so a verdict never steals another session's row.
export function bindVerdict(s, session, verdict) {
  return s.query(`
    UPDATE rows SET status=?, verdict_at=datetime('now')
     WHERE uid = (SELECT uid FROM rows WHERE status='inflight' AND taskly_session=?
                      ORDER BY sent_at LIMIT 1)
    RETURNING uid, source, row_no, user_id`).get(verdict, session) ?? null;
}

// One INSERT decides it: two callers racing get one true and one false.
export function claimPassword(s, pwHash) {
  const r = s.query("INSERT INTO used_passwords (pw_hash) VALUES (?) ON CONFLICT (pw_hash) DO NOTHING")
    .run(String(pwHash));
  return Number(r?.changes ?? 0) > 0;
}

export function recordPayment(s, { userId, amount_bkt, method = null, reference = null, note = null }) {
  const n = Number(amount_bkt);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`amount_bkt must be a positive number, got ${amount_bkt}`);
  return s.query(`INSERT INTO payments (user_id, amount_bkt, method, reference, note, notified_at)
       VALUES (?, ?, ?, ?, ?, datetime('now')) RETURNING id, user_id, amount_bkt, method, reference, note`)
    .get(userId, n, method, reference, note);
}

// Per approval, at the live total: user = min(cap, rounded(total * (1 - cut))).
// Same rule as the plan's money model; constants imported, never copied.
export function split(totalBkt) {
  const t = Number(totalBkt);
  const user = Math.min(MAX_USER_BKT, Math.round((t * (1 - OUR_CUT)) / ROUND_TO) * ROUND_TO);
  return { total: t, user, us: t - user, cut: (t - user) / t };
}

// Derived, never stored: approvals earn, payments settle, the difference is owed.
export function owedFor(s, userId, totalBktPerApproval) {
  const a = s.query("SELECT count(*) AS n FROM rows WHERE user_id=? AND status='approved'").get(userId);
  const p = s.query("SELECT COALESCE(sum(amount_bkt),0) AS t FROM payments WHERE user_id=?").get(userId);
  const earned = Number(a?.n ?? 0) * split(totalBktPerApproval).user;
  const paid = Number(p?.t ?? 0);
  return { approved: Number(a?.n ?? 0), paid, owed: Math.max(0, earned - paid) };
}

const COUNT_KEYS = ["queued", "claimed", "inflight", "approved", "rejected", "dead", "gated", "half-used"];

export function totals(s) {
  const t = { all: 0 };
  for (const k of COUNT_KEYS) t[k] = 0;
  for (const r of s.query("SELECT status, count(*) AS n FROM rows GROUP BY status").all()) {
    if (r.status in t) t[r.status] = Number(r.n);
    t.all += Number(r.n);
  }
  return t;
}

export function userRows(s, userId, statuses) {
  const list = (statuses ?? []).map(String);
  if (!list.length) return [];
  const ph = list.map(() => "?").join(",");
  return s.query(`SELECT uid, source, row_no, status, note, new_password, taskly_session, sent_at, verdict_at
       FROM rows WHERE user_id=? AND status IN (${ph}) ORDER BY created_at`).all(userId, ...list);
}

const isPidAlive = (pid) => {
  try { process.kill(Number(pid), 0); return true; }
  catch { return false; }
};

// One phone, one live pid. A holder whose pid is dead releases, so a killed
// process can never lock a session permanently.
export function tryLock(s, phone, pid, alive = isPidAlive) {
  const cur = s.query("SELECT pid FROM session_locks WHERE phone=?").get(String(phone));
  if (!cur) {
    s.query("INSERT INTO session_locks (phone, pid) VALUES (?, ?)").run(String(phone), Number(pid));
    return true;
  }
  if (Number(cur.pid) === Number(pid)) return true;
  if (alive(cur.pid)) return false;
  s.query("UPDATE session_locks SET pid=?, acquired_at=datetime('now') WHERE phone=?").run(Number(pid), String(phone));
  return true;
}

export function unlock(s, phone, pid = null) {
  const r = pid == null
    ? s.query("DELETE FROM session_locks WHERE phone=?").run(String(phone))
    : s.query("DELETE FROM session_locks WHERE phone=? AND pid=?").run(String(phone), Number(pid));
  return Number(r?.changes ?? 0);
}

export function holdLocks(s) {
  return s.query("SELECT phone, pid, acquired_at FROM session_locks ORDER BY phone").all();
}

export function setSession(s, { phone, label = null, enabled = 1, balance_usd = null, rate_limit_until = null }) {
  s.query(`INSERT INTO session_state (phone, label, enabled, balance_usd, balance_at, rate_limit_until, last_used_at)
     VALUES (?, ?, ?, ?, datetime('now'), ?, datetime('now'))
     ON CONFLICT (phone) DO UPDATE SET label=COALESCE(excluded.label, label),
       enabled=excluded.enabled, balance_usd=COALESCE(excluded.balance_usd, balance_usd),
       balance_at=CASE WHEN excluded.balance_usd IS NOT NULL THEN datetime('now') ELSE balance_at END,
       rate_limit_until=COALESCE(excluded.rate_limit_until, rate_limit_until),
       last_used_at=datetime('now')`)
    .run(String(phone), label, enabled ? 1 : 0, balance_usd, rate_limit_until);
  return sessionState(s, phone);
}

export function sessionState(s, phone = null) {
  if (phone == null) return s.query("SELECT * FROM session_state ORDER BY phone").all();
  return s.query("SELECT * FROM session_state WHERE phone=?").get(String(phone)) ?? null;
}

export function soldUids(s) {
  return new Set(s.query("SELECT uid FROM sold_guard").all().map((r) => r.uid));
}
