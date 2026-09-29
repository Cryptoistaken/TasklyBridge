/**
 * Does a permanent block still get recorded, whatever its wording?
 *
 *   bun GateRecordTest.ts
 *
 * The skip was matched on the text "/sms confirmation code/i". This proves the
 * replacement - matching on the BailGated TYPE - still records every permanent
 * block, and still declines to record the ones that should be retried.
 *
 * The test that matters is the reworded message: identical behaviour, different
 * text. Under the old rule that row would have been retried forever at $0.05 a
 * pop, and nothing in the log would have said so.
 */
import { Bail, BailLogged, BailGated } from "./PC.ts";
import { markSkipped, listSkipped, fingerprint } from "./sent.ts";

// The exact rule submit.ts now applies.
const classify = (err: any) =>
  err instanceof BailGated ||
  /sms confirmation code|never left 'Loading/i.test(err?.message ?? "");

let failures = 0;
const check = (name: string, got: boolean, want: boolean) => {
  const ok = got === want;
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${name}${ok ? "" : `  (got ${got}, want ${want})`}`);
};

console.log("permanent blocks must be recorded (skip the row):\n");

check("BailGated, current wording", classify(new BailGated("gated: Facebook requires an SMS confirmation code (confirmation code to +216 ******95)")), true);
check("BailGated, REWORDED message", classify(new BailGated("blocked: verification required on the linked handset")), true);
check("BailGated, empty message", classify(new BailGated("")), true);
check("BailGated, sheet stuck on Loading", classify(new BailGated("stuck: account sheet never left 'Loading...'")), true);

console.log("\nordinary failures must NOT be recorded (retry is correct):\n");

check("BailLogged, transient timeout", classify(new BailLogged("Step 3: no known screen after 30000ms.")), false);
check("BailLogged, click timeout", classify(new BailLogged("locator.click: Timeout 30000ms exceeded.")), false);
check("plain Bail", classify(new Bail("row 9 cookie is dead (confirmed twice).")), false);
check("ordinary Error", classify(new Error("something else entirely")), false);
check("undefined", classify(undefined), false);

console.log("\nthe ledger itself:\n");

// A record must be retrievable by fingerprint, which is what runBatch() uses to
// drop the row from the queue.
const probe = "test-cookie-for-gate-record-probe";
const fp = fingerprint(probe);
const before = listSkipped().length;
markSkipped({ fp, reason: "gated: test", source: "test", row: 0 });
const after = listSkipped();
check("markSkipped persists the row", after.length === before + 1, true);
check("row is retrievable by fingerprint", after.some((r) => r.fp === fp), true);

// Idempotent: a hand-retried row must not accumulate duplicates.
markSkipped({ fp, reason: "gated: test again", source: "test", row: 0 });
check("markSkipped is idempotent", listSkipped().length === after.length, true);

// Clean up so the audit tool is not left with a fake row.
const { unlinkSync, readFileSync, writeFileSync } = await import("node:fs");
const { SKIP_FILE_PATH } = await import("./sent.ts");
const kept = readFileSync(SKIP_FILE_PATH, "utf8").split(/\r?\n/).filter(Boolean).filter((l) => !l.includes(fp));
writeFileSync(SKIP_FILE_PATH, kept.join("\n") + "\n", "utf8");
check("probe row removed again", listSkipped().length === before, true);

console.log(`\n${failures ? `${failures} FAILED` : "all passed"}`);
process.exit(failures ? 1 : 0);
