/**
 * Ledger of accounts already completed, so a re-run never re-sends one.
 *
 * Stores a *fingerprint* of the cookie, not the cookie. The full secret stays
 * in the xlsx; this file only has to answer "have I done this one already?",
 * and a row number alone is not enough because the sheet can be re-sorted
 * between runs.
 */
import fs from "node:fs";
import path from "path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LEDGER = path.join(__dirname, "out", "sent.jsonl");

/** Stable id for an account, without storing the secret. */
export function fingerprint(cookie: string): string {
  return createHash("sha256").update(cookie.trim()).digest("hex").slice(0, 12);
}

export type SentRecord = {
  fp: string;
  at: string;
  source?: string;
  row?: number;
  job?: string;
  password?: string;
};

export function listSent(): SentRecord[] {
  if (!fs.existsSync(LEDGER)) return [];
  return fs
    .readFileSync(LEDGER, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l) as SentRecord;
      } catch {
        return null; // a torn line must not break the run
      }
    })
    .filter((r): r is SentRecord => !!r?.fp);
}

export function isSent(fp: string): boolean {
  return listSent().some((r) => r.fp === fp);
}

export function markSent(rec: Omit<SentRecord, "at">) {
  fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
  fs.appendFileSync(LEDGER, JSON.stringify({ at: new Date().toISOString(), ...rec }) + "\n", "utf8");
}

export const SENT_FILE = LEDGER;

// ── Skipped accounts ────────────────────────────────────────────────────────
//
// An account Facebook gates behind an SMS code to a phone number we do not
// have can never succeed. Retrying it costs $0.05 and burns another bot
// credential, so it is recorded here and skipped up front on later runs.
//
// Kept in a SEPARATE file from sent.jsonl on purpose: sent.jsonl means "this
// job is done", this means "this can never be done". Merging them would make a
// permanent skip look like a success.
const SKIP_FILE = path.join(__dirname, "out", "skipped.jsonl");

export type SkippedRecord = {
  fp: string;
  at: string;
  reason: string;
  source?: string;
  row?: number;
};

export function listSkipped(): SkippedRecord[] {
  if (!fs.existsSync(SKIP_FILE)) return [];
  return fs
    .readFileSync(SKIP_FILE, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l) as SkippedRecord;
      } catch {
        return null;
      }
    })
    .filter((r): r is SkippedRecord => !!r?.fp);
}

export function isSkipped(fp: string): boolean {
  return listSkipped().some((r) => r.fp === fp);
}

export function markSkipped(rec: Omit<SkippedRecord, "at">) {
  if (isSkipped(rec.fp)) return; // idempotent; a row may be retried by hand
  fs.mkdirSync(path.dirname(SKIP_FILE), { recursive: true });
  fs.appendFileSync(SKIP_FILE, JSON.stringify({ at: new Date().toISOString(), ...rec }) + "\n", "utf8");
}

export const SKIP_FILE_PATH = SKIP_FILE;
