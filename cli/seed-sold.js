// cli/seed-sold.js — one-time. Run once, then delete this file.
// A second run against a grown sent.jsonl is a silent trap: it would mark
// freshly sold rows as pre-sold. One run, verify, delete.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import pg from "pg";
import { readAccounts, uidOf } from "../index.js";
import { open, migrate } from "./store.js";

const here = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.join(here, "..", "data", ".env") });
const base = (p) => String(p ?? "").split(/[\\/]/).pop();

const s = open();
migrate(s);
const ins = s.prepare("INSERT OR IGNORE INTO sold_guard (uid, source, row_no, at) VALUES (?,?,?,?)");
let inserted = 0;
const stamp = () => new Date().toISOString();

// 1. sent.jsonl joined against the sheets on (basename, row).
const sold = new Set();
try {
  for (const line of fs.readFileSync(path.join(here, "..", "data", "out", "sent.jsonl"), "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      sold.add(`${base(r.source)}:${r.row}`);
    } catch { /* one bad line is not a failed seed */ }
  }
} catch { /* no legacy file — Postgres-only seed */ }

const sheets = {};
for (const file of ["2fa49.xlsx", "2fa100.xlsx", "2fa44.xlsx"]) {
  try {
    for (const a of readAccounts(file)) {
      if (!sold.has(`${base(file)}:${a.row}`)) continue;
      (sheets[base(file)] ??= new Map()).set(a.row, a.cookie);
      const uid = uidOf(a.cookie);
      if (!uid) {
        console.log(`SKIP (no c_user, never sellable): ${file}:${a.row}`);
        continue;
      }
      if (ins.run(uid, base(file), a.row, stamp()).changes > 0) inserted++;
    }
  } catch (e) {
    console.log(`SKIP sheet ${file}: ${e?.message ?? e}`);
  }
}

// 2. Accounts that exist only in Postgres — read before Postgres is retired.
if (process.env.DATABASE_URL) {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 2 });
  try {
    const { rows } = await pool.query(
      "SELECT fp, source, row_no, cookie FROM sheet_rows WHERE status IN ('inflight','approved','rejected')");
    for (const r of rows) {
      let uid = r.cookie ? uidOf(r.cookie) : null;
      if (!uid) {
        const hit = sheets[base(r.source)]?.get(r.row_no);
        uid = hit ? uidOf(hit) : null;
      }
      if (!uid) {
        console.log(`UNRECOVERABLE fp ${r.fp} (${r.source}:${r.row_no}) — resolve by hand into sold_guard`);
        continue;
      }
      if (ins.run(uid, base(r.source), r.row_no, stamp()).changes > 0) inserted++;
    }
    console.log(`postgres rows examined: ${rows.length}`);
  } finally {
    await pool.end();
  }
} else {
  console.log("no DATABASE_URL — Postgres leg skipped");
}

console.log(`sold_guard inserted: ${inserted}`);
s.close();
