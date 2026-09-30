// One worker, for concur.mjs to spawn. Each mode does exactly one thing and
// prints one unambiguous line, so the parent can count winners by grepping.
//
// This exists as a separate FILE rather than a worker_threads loop because the
// failure being tested for is two PROCESSES on one resource. A thread inside
// one process shares nothing that matters here - advisory locks, connections and
// file handles are all per-process - so threads would prove nothing.

import { fileURLToPath } from "url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const db = await import(path.join(HERE, "db.js"));

const [mode, a, b] = process.argv.slice(2);

if (mode === "claim") {
  const want = Number(b ?? 1);
  const mine = [];
  for (let i = 0; i < want; i++) {
    // Scoped to the test's own queue. Without this the workers claimed REAL
    // accounts - 72 of them - because claimSheetRow defaults to the live queue.
    const row = await db.claimSheetRow("child-" + a, "concurtest");
    if (!row) break;
    mine.push(row.fp);
  }
  for (const f of mine) console.log("CLAIM " + f);
  await db.closeDb();
  process.exit(0);
}

if (mode === "pw") {
  const won = await db.claimPassword(a);
  if (won) console.log("WON");
  await db.closeDb();
  process.exit(0);
}

if (mode === "lock") {
  const held = await db.holdSessionLock(a);
  if (held) {
    console.log("HELD");
    // Hold it long enough that the siblings genuinely contend for the lock,
    // then release. A lock dropped instantly would prove nothing.
    await new Promise((r) => setTimeout(r, 1500));
    await held.release();
  }
  await db.closeDb();
  process.exit(0);
}

console.error("unknown mode: " + mode);
process.exit(2);
