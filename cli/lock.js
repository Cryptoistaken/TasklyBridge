import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizePhone } from "../index.js";

const here = path.dirname(fileURLToPath(import.meta.url));

// One lock file, honoured by BOTH tools. index.js and cli/ cannot share a
// Postgres advisory lock with a SQLite store and expect to see each other,
// so both agree on data/locks/<phone>.lock holding the owner's pid.
// CLI_LOCK_DIR exists for tests only, so the suite never touches real locks.
export const lockDir = path.join(here, "..", "data", "locks");
export const lockPath = (phone) =>
  path.join(process.env.CLI_LOCK_DIR ?? lockDir, `${normalizePhone(String(phone))}.lock`);

export function isAlive(pid) {
  try { process.kill(Number(pid), 0); return true; }
  catch { return false; }
}

export function holder(phone) {
  try {
    const pid = Number(fs.readFileSync(lockPath(phone), "utf8").trim());
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch { return null; }
}

// Live cross-tool holders, for refusing Telegram traffic mid-run. Stale
// (dead pid) files are someone else's cleanup, not an active run.
export function liveHolders() {
  let files = [];
  try {
    files = fs.readdirSync(process.env.CLI_LOCK_DIR ?? lockDir).filter((f) => f.endsWith(".lock"));
  } catch { return []; }
  const out = [];
  for (const f of files) {
    const phone = f.slice(0, -".lock".length);
    const pid = holder(phone);
    if (pid != null && isAlive(pid)) out.push({ phone, pid });
  }
  return out;
}

const handle = (phone) => {
  let out = false;
  return {
    phone: normalizePhone(String(phone)),
    release: () => {
      if (out) return;
      out = true;
      try { fs.unlinkSync(lockPath(phone)); } catch { /* already gone */ }
    },
  };
};

// Atomic creation wins the race: two processes creating the same file means
// exactly one gets it. A holder whose pid is dead releases, so a killed
// process can never lock a session permanently.
export function acquire(phone) {
  const file = lockPath(phone);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(file, `${process.pid}\n`, { flag: "wx" });
    return handle(phone);
  } catch (e) {
    if (e?.code !== "EEXIST") throw e;
    const pid = holder(phone);
    if (pid != null && isAlive(pid)) return null;
    fs.writeFileSync(file, `${process.pid}\n`, "utf8");
    return handle(phone);
  }
}
