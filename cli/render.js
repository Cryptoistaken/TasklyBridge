import chalk from "chalk";

export const RIGHT = { align: "right" };

export const STEP_LABELS = [
  "claimed",
  "reading the sheet",
  "checking the account",
  "provider password",
  "facebook password changed",
  "key + cookie sent",
  "recorded",
];

const ANSI_RE = /\x1b\[[0-9;]*m/g;

// Chalk codes have no width, so padding by String.length breaks every column
// as soon as colour is on. Measure what the terminal shows instead.
const visLen = (s) => String(s ?? "").replace(ANSI_RE, "").length;

export function stripAnsi(s) {
  return String(s ?? "").replace(ANSI_RE, "");
}

const isRight = (opt) => opt === RIGHT || opt?.align === "right";

const pad = (cell, width, opt) => {
  const s = String(cell ?? "");
  const gap = " ".repeat(Math.max(0, width - visLen(s)));
  return isRight(opt) ? gap + s : s + gap;
};

export function table(headers, rows, opts = {}) {
  const head = (headers ?? []).map(String);
  const body = (rows ?? []).map((r) => (r ?? []).map(String));
  const cols = Math.max(head.length, ...body.map((r) => r.length));
  if (cols === 0) return "(none)";
  const widths = [];
  for (let i = 0; i < cols; i++) {
    widths.push(Math.max(visLen(head[i]), ...body.map((r) => visLen(r[i]))));
  }
  const line = (cells, colour) => {
    const out = [];
    for (let i = 0; i < cols; i++) out.push(pad(cells[i], widths[i], opts[i]));
    return colour ? colour(out.join(" | ")) : out.join(" | ");
  };
  const lines = [line(head, chalk.bold)];
  for (const r of body) lines.push(line(r));
  if (body.length === 0) lines.push(chalk.gray("(none)"));
  return lines.join("\n");
}

export function bkt(n) {
  return Number(n).toFixed(2);
}

export function usd(n) {
  return Number(n).toFixed(4);
}

export function mask(uid) {
  return `***${String(uid ?? "").slice(-4)}`;
}

const stepTag = (status) => {
  if (status === "fail") return chalk.red("FAIL");
  if (status === "ok") return chalk.green("OK");
  return chalk.gray("WAIT");
};

export function steps({ total, index, done }) {
  const lines = [`row ${index}/${total}`];
  for (const d of done ?? []) {
    const detail = d.detail ? ` ${d.detail}` : "";
    lines.push(`${stepTag(d.status)} ${d.label}${detail}`);
  }
  return lines.join("\n");
}

export function summary({ sent, failed, left, eta }) {
  return `${chalk.green(`sent ${sent}`)} | ${chalk.red(`failed ${failed}`)} | left ${left} | eta ${eta}`;
}
