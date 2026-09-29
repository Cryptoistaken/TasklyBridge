/**
 * Append-only interaction log, one JSON object per line.
 *
 * Shaped like TasklyBridge's audit log: `leg` says which way a message went,
 * so a whole conversation can be replayed afterwards. Secrets are recorded
 * because the flow cannot be debugged without them, which is why `out/` is
 * gitignored - this file holds live cookies and 2FA secrets.
 */
import fs from "node:fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "out");

export type Leg = "bot->taskly" | "taskly->bot" | "internal";

export function auditPath(): string {
  fs.mkdirSync(OUT, { recursive: true });
  return path.join(OUT, `audit-${new Date().toISOString().slice(0, 10)}.jsonl`);
}

export function audit(rec: { leg: Leg; what: string; text?: string; [k: string]: unknown }) {
  const line = JSON.stringify({ at: new Date().toISOString(), ...rec });
  fs.appendFileSync(auditPath(), line + "\n", "utf8");
}

/** Compact one-line view of a reply, for the terminal. Never prints secrets. */
export function preview(text: string, n = 300): string {
  return text.replace(/\s+/g, " ").slice(0, n);
}
