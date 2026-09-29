/**
 * Does the group encoding survive real sheet names?
 *
 *   bun GroupTest.ts
 *
 * runBatch() hands rows to a child as `--rows "sheet.xlsx#12,other.xlsx#13"`,
 * and the child splits on "," then takes the text before the LAST "#". Sheet
 * names here contain spaces, brackets and emoji, so the separators are the
 * thing most likely to break - and a mis-split row means charging $0.05 against
 * the wrong account, or re-running a row that already succeeded.
 *
 * This checks the encode/decode round trip and the grouping arithmetic, with
 * no network and no Telegram.
 */
import { parseRows } from "./submit.ts";

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  const ok = a === b;
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${name}${ok ? "" : `\n          got  ${a}\n          want ${b}`}`);
};

// The real decoder, imported from submit.ts. submit.ts guards its own main()
// behind an entry-point check, so importing it runs nothing.
console.log("round trip through the real parseRows():\n");

// The two real sheet names, plus the awkward ones.
const files = [
  "2fa [100].xlsx",
  "2fa 2 [49].xlsx",
  "23-27 sep \u{1F41E} dgddigital \u{1F41E}2fa with ffpp \u{1F4AF} pcs [43].xlsx",
  "no-extension",
  "hash#inside.xlsx",
];

for (const f of files) {
  check(`single: ${f}`, parseRows(`${f}#12`), [{ file: f, row: 12 }]);
}

const multi = files.slice(0, 3);
check(
  "multi across sheets",
  parseRows(`${multi[0]}#15,${multi[1]}#16,${multi[2]}#17`),
  [
    { file: multi[0], row: 15 },
    { file: multi[1], row: 16 },
    { file: multi[2], row: 17 },
  ],
);

// A "#" inside the FILENAME must not be mistaken for the separator.
check(
  "hash inside filename uses the LAST #",
  parseRows("hash#inside.xlsx#42"),
  [{ file: "hash#inside.xlsx", row: 42 }],
);

check("empty -> no rows", parseRows(""), []);
check("undefined -> no rows", parseRows(undefined), []);
check("trailing comma tolerated", parseRows("a.xlsx#1,"), [{ file: "a.xlsx", row: 1 }]);

console.log("\ngrouping arithmetic (every row appears exactly once):\n");

const group = <T,>(items: T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
  return out;
};

for (const [total, per] of [[128, 3], [128, 1], [10, 3], [1, 3], [7, 7], [49, 5]] as const) {
  const rows = Array.from({ length: total }, (_, i) => ({ file: "s.xlsx", row: i + 1 }));
  const groups = group(rows, per);
  const flat = groups.flat();
  const seen = new Set(flat.map((r) => r.row));
  const allPresent = seen.size === total && flat.every((r) => r.row >= 1 && r.row <= total);
  check(
    `${total} rows / ${per} per session -> ${groups.length} sessions, no row lost or repeated`,
    allPresent && flat.length === total,
    true,
  );
  check(
    `  no session exceeds ${per}`,
    groups.every((g) => g.length <= per),
    true,
  );
}

console.log(`\n${failures ? `${failures} FAILED` : "all passed"}`);
process.exit(failures ? 1 : 0);
