// Proves the multi-instance guarantees with REAL processes, not mocks.
//
// Every claim here was a race before Postgres:
//   - two processes could claim the same sheet row
//   - two processes could both use the same bot password
//   - two processes could open the same telegram session
//   - a verdict could be filed against another session's row
//
// None of that can be checked in-process, because a single process cannot race
// itself. So this spawns real children and counts who got what.
//
//   bun concur.mjs            # run it
//   bun concur.mjs --keep     # leave the test rows behind
//
// It uses a dedicated fp prefix (concurtest) and its own telegram session names,
// so it can never collide with real work. Rows it claims are marked with a
// 'concurtest' note and can be deleted with --clean.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SELF = path.join(HERE, "concur-child.mjs");
const KEEP = process.argv.includes("--keep");

// ASYNC spawn, on purpose. The first version used spawnSync, which runs the
// children one after another - so the "contention" tests had no contention in
// them at all. Four processes each took the session lock in turn, released it,
// and the next one took it, and the test reported that all four had held it.
// A race test that does not race is worse than no test: it looks like evidence.
function runAll(argvList) {
  return Promise.all(argvList.map((a) => new Promise((res) => {
    const p = spawn(process.execPath, [SELF, ...a]);
    let out = "";
    p.stdout.on("data", (d) => { out += d; });
    p.on("close", () => res(out));
  })));
}

const db = await import("./db.js");
await db.migrate();

let bad = 0;
const ok = (cond, what) => { console.log(`  ${cond ? "PASS" : "FAIL"}  ${what}`); if (!cond) bad++; };

// ---- fixtures -------------------------------------------------------------
const TAG = "concurtest";
// THE TEST'S OWN QUEUE. Its workers must never see a live row: the first version
// of this file claimed 72 REAL accounts, because claimSheetRow had no idea a test
// was running and 72 of them were left in 'claimed' under the name "nobody".
const Q = "concurtest";
const KIDS = 6, EACH = 6;
const N = KIDS * EACH;   // exactly enough rows, so "every claim returned a row" is a real claim and not luck
const fps = Array.from({ length: N }, (_, i) => `concur${String(i).padStart(8, "0")}`);

await db.db().query("DELETE FROM sheet_rows WHERE queue = $1", [Q]);
for (let i = 0; i < N; i++) {
  await db.db().query(
    `INSERT INTO sheet_rows (fp, source, row_no, cookie, fa2_key, note, queue)
     VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (fp) DO NOTHING`,
    [fps[i], "concur.xlsx", 9000 + i, `c_user=${1000 + i}; xs=fake`, "FAKEFAKEFAKE", TAG, Q],
  );
}
console.log(`\n  seeded ${N} test rows\n`);

// ---- 1. can two processes claim the same row? -----------------------------
// 6 children each try to claim 6 rows. The total claimed must be exactly N and
// no fingerprint may appear twice. With read-modify-write (the old JSON ledger)
// this is precisely where a row went missing.
const outs = await runAll(Array.from({ length: KIDS }, (_, k) => ["claim", String(k), String(EACH)]));
const claimed = outs.flatMap((o) => o.split("\n").filter((l) => l.startsWith("CLAIM ")).map((l) => l.slice(6).trim()));
const dupes = [...new Set(claimed.filter((f, i) => claimed.indexOf(f) !== i))];
console.log(`  children claimed ${claimed.length} rows (expected ${KIDS * EACH})`);
ok(claimed.length === KIDS * EACH, `all ${KIDS * EACH} claims returned a row`);
ok(dupes.length === 0, `no fingerprint claimed twice${dupes.length ? ` - DOUBLES: ${dupes.join(",")}` : ""}`);

const { rows: gotAll } = await db.db().query("SELECT count(*)::int n FROM sheet_rows WHERE status = 'claimed' AND note = $1", [TAG]);
ok(gotAll[0].n === claimed.length, `every claim persisted (${gotAll[0].n} rows claimed)`);

// ---- 2. can two processes use the same bot password? ----------------------
// The old ledger was an array read then written, so both would see it free.
const pwh = "concurhash" + Date.now();
const pk = await runAll(Array.from({ length: 8 }, () => ["pw", pwh]));
const winners = pk.filter((r) => r.includes("WON")).length;
ok(winners === 1, `exactly one of 8 processes claimed the password (got ${winners})`);

// ---- 3. can two processes open the same telegram session? ------------------
// The whole reason the user asked for this. Telegram delivers updates to ONE
// consumer; two processes on one session fight and eat each other's replies.
// The children each hold the lock for 1.5s, so with async spawn they genuinely
// overlap - the first keeps it while the other three are refused.
const sess = "concur-session-" + Date.now();
const lk = await runAll(Array.from({ length: 4 }, () => ["lock", sess]));
const holders = lk.filter((r) => r.includes("HELD")).length;
ok(holders === 1, `exactly one of 4 SIMULTANEOUS processes locked ${sess} (got ${holders})`);

// ---- 4. can a verdict be filed against another session's row? --------------
// The 38-vs-37 bug, and the one that decides whether a payout figure is right.
//
// The sent_at values are set to EXPLICIT, well-separated offsets rather than
// "whatever now() happened to be", so session A's rows are unambiguously OLDER
// than session B's. Without that, a missing session filter can still pass by luck
// whenever the two sessions happen to be set up in an unlucky order - and a test
// that passes by luck is worse than no test at all.
//
// A(2 rows, older) then B(3 rows). Four verdicts arrive on B. The only correct
// answer is B's three rows in order, then null.
await db.db().query("UPDATE sheet_rows SET status = 'queued', taskly_session = NULL, sent_at = NULL WHERE note = $1", [TAG]);
const aRows = fps.slice(0, 2), bRows = fps.slice(2, 5);
// [session, rows] in that order. The first version built these as
// [[...aRows, "A"]] and destructured [group, session] - so "group" was a single
// fingerprint and "session" was the next fingerprint. Every UPDATE then matched
// zero rows and the test reported an empty queue, which reads exactly like a
// broken bindVerdict. Order the pair the obvious way and check the row count.
const layout = [["A", aRows], ["B", bRows]];
let secs = 500;
for (const [session, group] of layout) {
  for (const f of group) {
    const r = await db.db().query(
      "UPDATE sheet_rows SET status = 'inflight', taskly_session = $2, sent_at = now() - ($3 || ' seconds')::interval WHERE fp = $1",
      [f, session, secs],
    );
    if (r.rowCount !== 1) { console.log(`    SETUP ERROR: ${f} -> ${session} matched ${r.rowCount} rows`); bad++; }
    secs -= 100;   // strictly older each time, A's well before B's
  }
}
const { rows: ordered } = await db.db().query(
  "SELECT taskly_session, fp FROM sheet_rows WHERE status = 'inflight' ORDER BY sent_at",
);
const order = ordered.map((r) => `${r.taskly_session}:${r.fp.slice(-2)}`).join(" ");
ok(order.startsWith("A:"), `session A's rows really are the OLDEST inflight (order: ${order})`);

const taken = [];
for (let i = 0; i < 4; i++) taken.push(await db.bindSheetVerdict("B", i < 3 ? "approved" : "rejected", "verdict " + i));
const bGot = taken.filter(Boolean).map((t) => t.fp);
ok(bGot.length === 3, `session B's 3 verdicts each claimed a row (got ${bGot.length})`);
// EXACT sequence, not merely "none of them was an A row": a filter that returned
// B's rows in the wrong order would pass the weaker check and would mis-pair
// approvals to the wrong accounts.
ok(bGot.join(",") === bRows.join(","), `claimed exactly B's rows, in order${bGot.join(",") !== bRows.join(",") ? ` - GOT ${bGot.join(",")}, wanted ${bRows.join(",")}` : ""}`);
ok(taken[3] === null, `a 4th verdict on B with nothing left is unpaired, not stolen`);

const { rows: aLeft } = await db.db().query("SELECT count(*)::int n FROM sheet_rows WHERE status = 'inflight' AND taskly_session = 'A'");
ok(aLeft[0].n === 2, `session A's 2 rows survived untouched (${aLeft[0].n})`);

// ---- 5. a claim can be given back, and a dead worker's row is freed -------
// A crash must not strand a row in 'claimed' for ever, or the account is
// silently never sold and the queue looks shorter than it is.
//
// A row that actually IS claimed, chosen from the ones this test set to
// 'claimed' rather than to 'inflight' - releasing one of the latter is a no-op
// by design, and asserting on a no-op proves nothing.
const victim = fps[8];
await db.db().query("UPDATE sheet_rows SET status = 'claimed', claimed_at = now() WHERE fp = $1", [victim]);
ok((await db.releaseSheetRow(victim, "gave back")) === 1, "a claimed row can be given back");
const { rows: rel } = await db.db().query("SELECT status FROM sheet_rows WHERE fp = $1", [victim]);
ok(rel[0].status === "queued", `...and it is back in the queue (got '${rel[0].status}')`);
ok((await db.releaseSheetRow(victim, "again")) === 0, "releasing an already-queued row is a no-op, not a second claim");

await db.db().query("UPDATE sheet_rows SET status = 'claimed', claimed_at = now() - interval '3 hours' WHERE fp = $1", [victim]);
ok((await db.requeueStaleClaims(90)) === 1, "a claim held 3 hours by a dead worker is requeued");
const { rows: re2 } = await db.db().query("SELECT status FROM sheet_rows WHERE fp = $1", [victim]);
ok(re2[0].status === "queued", `...and it really is back in the queue (got '${re2[0].status}')`);

// A LIVE worker's claim must NOT be reaped, or a slow instance loses the row it
// is halfway through - which is how two processes end up on one Facebook account.
await db.db().query("UPDATE sheet_rows SET status = 'claimed', claimed_at = now() WHERE fp = $1", [victim]);
ok((await db.requeueStaleClaims(90)) === 0, "a claim taken 1 second ago is left alone");
ok((await db.releaseSheetRow(victim, "done")) === 1, "...and is still the owner's to release");

// ---- 6. an empty queue yields null, never a duplicate ---------------------
// By fp prefix, not by note: releaseSheetRow overwrites the note, so a
// note-based cleanup silently misses rows and this assertion tests the wrong
// thing - which is exactly what happened the first time.
await db.db().query("UPDATE sheet_rows SET status = 'approved' WHERE queue = $1", [Q]);
ok((await db.claimSheetRow("nobody", Q)) === null, "claiming an empty queue returns null");

// ---- cleanup --------------------------------------------------------------
if (KEEP) {
  console.log("\n  --keep: test rows left in place\n");
} else {
  await db.db().query("DELETE FROM sheet_rows WHERE queue = $1", [Q]);
  await db.db().query("DELETE FROM used_passwords WHERE pw_hash LIKE 'concurhash%'");
  console.log("\n  test rows removed\n");
}
await db.closeDb();

console.log(bad === 0 ? "  ALL CONCURRENCY GUARANTEES HOLD\n" : `  ${bad} GUARANTEE(S) BROKEN\n`);
process.exit(bad === 0 ? 0 : 1);
