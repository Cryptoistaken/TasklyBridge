import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sessionState, setSession } from "./store.js";
import { holder, isAlive } from "./lock.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, "..", "data", "sessions");
export const dstDir = path.join(here, "..", "data", "cli", "sessions");

// Copies, never shares. cli/ reads data/sessions/*.session once at startup
// and uses only its own, so both tools can run at once on the same Telegram
// accounts without fighting over the session files. Seeding reads the COPIES:
// a session the CLI does not own must never appear available.
export function prepare() {
  fs.mkdirSync(dstDir, { recursive: true });
  const out = [];
  if (!fs.existsSync(srcDir)) return out;
  for (const f of fs.readdirSync(srcDir).filter((f) => f.endsWith(".session"))) {
    fs.copyFileSync(path.join(srcDir, f), path.join(dstDir, f));
    out.push(f.slice(0, -".session".length));
  }
  return out.sort();
}

export function seed(s, phones) {
  let n = 0;
  for (const p of phones ?? []) {
    if (!sessionState(s, p)) setSession(s, { phone: p, label: `...${String(p).slice(-4)}` });
    n++;
  }
  return n;
}

const free = (row) => {
  if (!row.enabled) return false;
  if (row.rate_limit_until && new Date(row.rate_limit_until) > new Date()) return false;
  const pid = holder(row.phone);
  if (pid != null && isAlive(pid)) return false;
  return true;
};

// Enabled, unlocked, not rate-limited, least-recently-used. "max" takes every
// candidate. No free session throws — an empty list would silently run nothing.
export function pick(s, threads = 1) {
  const cands = sessionState(s).filter(free)
    .sort((a, b) => (a.last_used_at ?? "") < (b.last_used_at ?? "") ? -1 : 1);
  if (!cands.length) throw new Error("no free session — all are locked, rate-limited, or disabled");
  const list = threads === "max" ? cands : cands.slice(0, Math.max(1, Number(threads) || 1));
  for (const c of list) {
    s.query("UPDATE session_state SET last_used_at=datetime('now') WHERE phone=?").run(c.phone);
  }
  return list.map((c) => c.phone);
}
