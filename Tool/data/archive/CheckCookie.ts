/**
 * Cookie health check - one HTTP request per row, no browser, no Telegram job.
 *
 * A dead cookie is expensive to discover: submitting it costs $0.05 and burns a
 * credential before failing at the Facebook login page. This screens a sheet
 * for pennies first.
 *
 *   bun CheckCookie.ts            # every row in the sheet
 *   bun CheckCookie.ts 13 33 38   # just these rows
 *   bun CheckCookie.ts "sheet.xlsx"
 *
 * The call
 * --------
 * GET accountscenter.facebook.com/profiles with the cookie, iOS headers,
 * redirects followed. This is the same request SheetSubmit's pageSimple()
 * makes (backend/src/worker/runner.ts), so the behaviour is already proven in
 * production there.
 *
 * Why name and phone, and not a status code
 * -----------------------------------------
 * Every dead cookie returns HTTP 200 with ~168KB of login page, and a live one
 * returns 200 with ~800KB of settings. Status alone cannot separate them, and
 * neither can SheetSubmit's `challenged()` regex - it flags row 6, which really
 * does work. What a live session carries and a login wall cannot is the
 * account's own identity:
 *
 *   live  "full_name":"Angie Schafer"
 *         "navigation_row_subtitle":"+8562059160893"
 *         the cookie's own c_user appears in the body
 *
 *   dead  user_id:""  name:""   no full_name, no phone, c_user absent
 *
 * Verified against ground truth: row 30 submits successfully, rows 13/33/38/42
 * land on the login page.
 *
 * A UNKNOWN is reported rather than guessed. Facebook rate-limits and
 * challenges under volume, and calling a throttled response DEAD would throw
 * away good accounts - so anything ambiguous is left for a re-check.
 */
import fs from "fs";
import { config } from "dotenv";
import { readAccounts, log } from "./PC.ts";

config();

const URL = "https://accountscenter.facebook.com/profiles";
const UA_IOS =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
const TIMEOUT_MS = 20_000;

type Verdict = "ALIVE" | "DEAD" | "UNKNOWN";

interface Result {
  verdict: Verdict;
  note: string;
  name?: string | null;
  phone?: string | null;
}

async function check(cookie: string): Promise<Result> {
  const cUser = cookie.match(/c_user=(\d+)/)?.[1];
  if (!cUser) return { verdict: "UNKNOWN", note: "no c_user in cookie" };

  let html: string;
  let status: number;
  try {
    const res = await fetch(URL, {
      headers: {
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        cookie,
        "sec-ch-ua-mobile": "?1",
        "sec-ch-ua-platform": '"iOS"',
        "sec-fetch-dest": "document",
        "sec-fetch-mode": "navigate",
        "sec-fetch-site": "same-origin",
        "upgrade-insecure-requests": "1",
        "user-agent": UA_IOS,
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: "follow",
    });
    status = res.status;
    html = await res.text();
  } catch (e) {
    // Network trouble is not a verdict. Reporting it as DEAD would discard
    // working accounts over a flaky connection.
    return { verdict: "UNKNOWN", note: (e as Error).message.slice(0, 50) };
  }

  if (status !== 200) return { verdict: "UNKNOWN", note: `status ${status}` };
  if (!html) return { verdict: "UNKNOWN", note: "empty body" };

  // A rate-limit or block page is not the same as a dead cookie.
  if (/temporarily blocked|security check|unusual activity|too many requests/i.test(html)) {
    return { verdict: "UNKNOWN", note: "throttled or challenged" };
  }

  const name = html.match(/"full_name"\s*:\s*"([^"]+)"/)?.[1] ?? null;
  const phone = html.match(/"navigation_row_subtitle"\s*:\s*"\+?\d[\d\s-]{6,}"/)?.[0]
    .replace(/"/g, "")
    .trim();
  const selfEcho = html.includes(cUser);
  const hasIdentity = Boolean(name) || Boolean(phone) || selfEcho;

  if (hasIdentity) {
    return {
      verdict: "ALIVE",
      note: name ?? "(no name)",
      name,
      phone: phone ?? null,
    };
  }
  // No identity anywhere in the body: this is the login wall.
  return { verdict: "DEAD", note: `login wall, ${(html.length / 1024) | 0}KB` };
}

const args = process.argv.slice(2);
const file =
  args.find((a) => a.toLowerCase().endsWith(".xlsx")) ??
  fs.readdirSync(".").find((n) => n.includes("ffpp")) ??
  "";
if (!file || !fs.existsSync(file)) {
  log.error("no xlsx found - pass one explicitly or drop the sheet in this folder");
  process.exit(1);
}

const accounts = readAccounts(file);
const wanted = args.filter((a) => /^\d+$/.test(a)).map(Number);
const rows = wanted.length ? accounts.filter((a) => wanted.includes(a.row)) : accounts;

if (!rows.length) {
  log.error("no matching rows");
  process.exit(1);
}

log.info(`${file}: screening ${rows.length} row(s), one request each`);
const t0 = Date.now();
const tally: Record<Verdict, number> = { ALIVE: 0, DEAD: 0, UNKNOWN: 0 };
const dead: number[] = [];
const unknown: number[] = [];
const people: string[] = [];

for (const a of rows) {
  const r = await check(a.cookie);
  tally[r.verdict]++;
  if (r.verdict === "DEAD") dead.push(a.row);
  if (r.verdict === "UNKNOWN") unknown.push(a.row);
  if (r.name) people.push(`row ${a.row}: ${r.name}${r.phone ? ` (${r.phone})` : ""}`);

  const tag = r.verdict === "ALIVE" ? log.success : r.verdict === "DEAD" ? log.error : log.warn;
  tag(`row ${String(a.row).padStart(3)}  ${r.verdict.padEnd(7)} ${r.note}`);
}

const secs = ((Date.now() - t0) / 1000).toFixed(1);
log.info(
  `done in ${secs}s - ${tally.ALIVE} alive, ${tally.DEAD} dead, ${tally.UNKNOWN} unknown`,
);
if (people.length) {
  log.success(`${people.length} account(s) identified:`);
  people.forEach((p) => log.info(`  ${p}`));
}
if (dead.length) log.error(`replace these cookies: rows ${dead.join(", ")}`);
if (unknown.length) log.warn(`re-check these, not conclusive: ${unknown.join(", ")}`);
if (!dead.length && !unknown.length) log.success("every row looks live - safe to submit");
