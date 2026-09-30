// cli/test/balance.test.ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import * as store from "../store.js";
import { report } from "../balance.js";

let s;
beforeEach(() => {
  s = store.open(":memory:");
  store.migrate(s);
});
afterEach(() => s.close());

const approve = (uid, session, userId) => {
  store.enqueue(s, [{ uid: String(uid), source: "x.xlsx", row_no: Number(uid) }], userId);
  store.markSent(s, String(uid), session);
  store.bindVerdict(s, session, "approved");
};

test("our cut is measured, not the 19% target", () => {
  store.setSession(s, { phone: "15550101", balance_usd: 0.9 });
  const u = store.registerUser(s, "rakib");
  approve("1", "15550101", u.id);
  approve("2", "15550101", u.id);
  const r = report(s, { rate: 122.98, priceUsd: 0.05 });
  expect(r.cut.approvals).toBe(2);
  expect(r.cut.ours).toBeCloseTo(2.3, 1);
  expect(r.cut.pct).toBeLessThan(19);
  expect(r.cut.pct).toBeGreaterThan(18);
  expect(r.warning).toBe(false);
});

test("the warning fires when owed exceeds cash held", () => {
  store.setSession(s, { phone: "15550101", balance_usd: 0 });
  const u = store.registerUser(s, "rakib");
  approve("1", "15550101", u.id);
  const r = report(s, { rate: 122.98, priceUsd: 0.05 });
  expect(r.totals.unpaid).toBeCloseTo(5);
  expect(r.warning).toBe(true);
});

test("an unpriced report still counts, with owed unknown", () => {
  const u = store.registerUser(s, "rakib");
  approve("1", "15550101", u.id);
  const r = report(s, { rate: null, priceUsd: null });
  expect(r.users[0].approved).toBe(1);
  expect(r.users[0].owed).toBeNull();
  expect(r.warning).toBe(false);
});
