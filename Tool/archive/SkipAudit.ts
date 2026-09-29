/**
 * Do the recorded skips actually keep accounts out of the next run?
 *
 *   bun SkipAudit.ts
 *
 * Answering "the log said it recorded it" is not the same as "it will not be
 * retried", and this costs nothing - no Telegram, no browser, no $0.05. It
 * rebuilds the batch queue exactly as runBatch() does and reports what would
 * still be attempted.
 */
import { fingerprint, isSent, isSkipped, listSent, listSkipped } from "./sent.ts";
import { readAccounts, log } from "./PC.ts";

const files = process.argv.slice(2);
const sheets = files.length ? files : ["2fa [100].xlsx", "2fa 2 [49].xlsx"];

const sent = listSent();
const skipped = listSkipped();
const sentFps = new Set(sent.map((r) => r.fp));
const skipFps = new Set(skipped.map((r) => r.fp));

log.info(`sent.jsonl: ${sent.length} records, skipped.jsonl: ${skipped.length} records`);

let problems = 0;

for (const file of sheets) {
  let accounts;
  try {
    accounts = readAccounts(file);
  } catch (e: any) {
    log.error(`${file}: ${e?.message ?? e}`);
    continue;
  }

  // The same filter runBatch() uses to build its queue.
  const queued = accounts.filter((a) => {
    const fp = fingerprint(a.cookie);
    return !isSent(fp) && !isSkipped(fp);
  });

  const gatedHere = accounts.filter((a) => skipFps.has(fingerprint(a.cookie)));
  const deadHere = accounts.filter(
    (a) => skipped.find((s) => s.fp === fingerprint(a.cookie))?.reason?.includes("dead"),
  );

  log.info(
    `${file}: ${accounts.length} rows -> ${queued.length} would run ` +
      `(${gatedHere.length} skipped, of which ${deadHere.length} dead cookies)`,
  );

  // Every recorded skip must correspond to a real row, or it is a fingerprint
  // from a row that has since been edited out and the skip protects nothing.
  for (const s of skipped) {
    if (s.source === file && !accounts.some((a) => fingerprint(a.cookie) === s.fp)) {
      log.error(`  orphan skip: fp ${s.fp} (row ${s.row}) is not in this sheet any more`);
      problems++;
    }
  }
}

// A fp in BOTH ledgers means a skip is masking a real success, or vice versa.
for (const fp of sentFps) {
  if (skipFps.has(fp)) {
    log.error(`fp ${fp} is in BOTH sent.jsonl and skipped.jsonl - needs a human`);
    problems++;
  }
}

// Skips with no timestamp: the first entry predates the `at` field, so we cannot
// tell when it was written. Not fatal, but worth seeing.
for (const s of skipped) {
  if (!s.at) log.warn(`fp ${s.fp} has no timestamp (row ${s.row}) - older format`);
}

log.success(problems ? `${problems} problem(s) found` : "skip ledger is consistent and suppressing retries");
process.exit(problems ? 1 : 0);
