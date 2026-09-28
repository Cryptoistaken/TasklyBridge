// Money formatters. Same contract as the old ui.ts: unknown renders as a
// dash, never as a zero — a zero cost would read as the provider giving the
// job away free and would hide a loss.

const UNKNOWN = "—";

/** Provider dollars, 4dp: $0.3750. This is our COST, never our sell price. */
export const usd = (n: number | null | undefined): string =>
  typeof n === "number" && Number.isFinite(n) ? "$" + n.toFixed(4) : UNKNOWN;

/** Our Taka figures, 2dp: 5.00tk. */
export const bdt = (n: number | null | undefined): string =>
  typeof n === "number" && Number.isFinite(n) ? n.toFixed(2) + "tk" : UNKNOWN;

export function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function fmtDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}
