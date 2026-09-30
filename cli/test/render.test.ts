// cli/render.test.ts
import { test, expect } from "bun:test";
import { table, bkt, usd, mask, stripAnsi, steps, summary, STEP_LABELS, RIGHT } from "../render.js";

test("table columns line up", () => {
  const lines = stripAnsi(table(["a", "bb"], [["1", "22"], ["333", "4"]])).split("\n");
  const w = lines.map((l) => l.length);
  expect(new Set(w).size).toBe(1);
});

test("numbers right-align, text does not", () => {
  const [, r1, r2] = stripAnsi(table(["n", "s"], [["1", "a"], ["12345", "b"]], { 0: RIGHT })).split("\n");
  expect(r1.indexOf("1")).toBeGreaterThan(r2.indexOf("12345"));
});

test("bkt is 2dp, usd is 4dp", () => {
  expect(bkt(6.151)).toBe("6.15");
  expect(usd(0.45)).toBe("0.4500");
});

test("a uid is masked to its last four", () => {
  expect(mask("1000000000123456")).toBe("***3456");
});

test("an empty table says none rather than printing nothing", () => {
  expect(stripAnsi(table(["a"], []))).toContain("none");
});

test("exactly one step is marked FAIL when one fails", () => {
  const out = stripAnsi(steps({ total: 44, index: 3, done: STEP_LABELS.map((l, i) => ({
    label: l, status: i === 4 ? "fail" : "ok", detail: i === 4 ? "did not confirm" : "" })) }));
  expect((out.match(/FAIL/g) || []).length).toBe(1);
  expect(out).toContain("did not confirm");
});

test("summary fits sent, failed, left and eta on one line", () => {
  expect(stripAnsi(summary({ sent: 1, failed: 0, left: 43, eta: "~6h 12m" })))
    .toBe("sent 1 | failed 0 | left 43 | eta ~6h 12m");
});
