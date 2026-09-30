// cli/test/cli.test.ts
import { test, expect } from "bun:test";
import { parseArgs } from "../index.js";

test("--thread max stays a string", () => {
  expect(parseArgs(["--user", "r", "--file", "f", "--thread", "max"]).thread).toBe("max");
});

test("--thread 2 becomes a number", () => {
  expect(parseArgs(["--user", "r", "--file", "f", "--thread", "2"]).thread).toBe(2);
});

test("--pay takes handle and amount", () => {
  const o = parseArgs(["--pay", "rakib", "25", "--method", "bkash"]);
  expect(o.command).toBe("pay");
  expect(o.pay).toEqual({ handle: "rakib", bkt: "25" });
  expect(o.method).toBe("bkash");
});

test("--transfer takes uid and --to", () => {
  const o = parseArgs(["--transfer", "1001", "--to", "karim"]);
  expect(o.command).toBe("transfer");
  expect(o.transfer).toEqual({ uid: "1001", to: "karim" });
});

test("--user --file is repeatable with --row", () => {
  const o = parseArgs(["--user", "r", "--file", "a.xlsx", "--file", "b.xlsx", "--row", "7"]);
  expect(o.command).toBe("submit");
  expect(o.files).toEqual(["a.xlsx", "b.xlsx"]);
  expect(o.row).toBe(7);
});

test("nothing to do is a usage error", () => {
  expect(parseArgs([]).command).toBeNull();
});
