// cli/reconcile.test.ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import * as store from "../store.js";
import { catchUp } from "../reconcile.js";

let s, u;
const inflight = (uid, session) => {
  store.enqueue(s, [{ uid: String(uid), source: "x.xlsx", row_no: Number(uid) }], u.id);
  store.markSent(s, String(uid), session);
};

beforeEach(() => {
  s = store.open(":memory:");
  store.migrate(s);
  u = store.registerUser(s, "rakib");
});
afterEach(() => s.close());

test("an approval found in the chat binds to an inflight row", () => {
  inflight("1", "A");
  inflight("2", "A");
  expect(catchUp(s, "A", { approved: 1, rejected: 0 }).matched).toBe(1);
  expect(store.totals(s).inflight).toBe(1);
  expect(store.totals(s).approved).toBe(1);
});

test("binding never crosses sessions", () => {
  inflight("1", "A");
  inflight("2", "B");
  const r = catchUp(s, "B", { approved: 1, rejected: 0 });
  expect(r.matched).toBe(1);
  expect(store.userRows(s, u.id, ["approved"])[0].uid).toBe("2");
});

test("a surplus verdict is reported, never silently attached", () => {
  inflight("1", "B");
  const r = catchUp(s, "B", { approved: 3, rejected: 0 });
  expect(r.matched).toBe(1);
  expect(r.surplus).toBe(2);
});

test("a chat with fewer verdicts than inflight rows changes nothing", () => {
  inflight("1", "C");
  inflight("2", "C");
  const before = store.totals(s).inflight;
  const r = catchUp(s, "C", { approved: 0, rejected: 0 });
  expect(r.matched).toBe(0);
  expect(store.totals(s).inflight).toBe(before);
});

test("catchUp without a tally tells you to use run()", () => {
  expect(() => catchUp(s, "A")).toThrow(/tally/i);
});
