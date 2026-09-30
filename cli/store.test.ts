// cli/store.test.ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import * as store from "./store.js";

let s;
beforeEach(() => { s = store.open(":memory:"); store.migrate(s); });
afterEach(() => s.close());

test("a user registers once, case-insensitively", () => {
  expect(store.registerUser(s, "@Rakib").handle).toBe("rakib");
  expect(() => store.registerUser(s, "RAKIB")).toThrow(/already/i);
});

test("two cookies for one uid are one account, blocked always, reported loudly", () => {
  const u = store.registerUser(s, "rakib");
  const v = store.registerUser(s, "karim");
  const a = { uid: "1001", source: "x.xlsx", row_no: 1 };
  const b = { uid: "1001", source: "y.xlsx", row_no: 5 };
  expect(store.enqueue(s, [a], u.id).added).toBe(1);
  const r = store.enqueue(s, [b], v.id);
  expect(r.added).toBe(0);
  expect(r.duplicates).toHaveLength(1);
  expect(r.duplicates[0].owner).toBe("rakib");
});

test("a cookie with no c_user is invalid, never queued", () => {
  const u = store.registerUser(s, "rakib");
  const r = store.enqueue(s, [{ uid: null, source: "x.xlsx", row_no: 9 }], u.id);
  expect(r.added).toBe(0);
  expect(r.invalid).toHaveLength(1);
});

test("sold_guard is permanent — no path around it", () => {
  const u = store.registerUser(s, "rakib");
  s.run("INSERT INTO sold_guard (uid) VALUES ('888')");
  const r = store.enqueue(s, [{ uid: "888", source: "x", row_no: 1 }], u.id);
  expect(r.added).toBe(0);
});

test("a wrong-user row moves only via transfer", () => {
  const a = store.registerUser(s, "rakib");
  const b = store.registerUser(s, "karim");
  store.enqueue(s, [{ uid: "1001", source: "x.xlsx", row_no: 1 }], a.id);
  store.transferRow(s, "1001", b.id);
  expect(store.userRows(s, b.id, ["queued"])).toHaveLength(1);
  expect(store.userRows(s, a.id, ["queued"])).toHaveLength(0);
});

test("a claim that failed before Telegram goes back on the queue", () => {
  const u = store.registerUser(s, "rakib");
  store.enqueue(s, [{ uid: "1001", source: "x.xlsx", row_no: 1 }], u.id);
  store.claimRow(s, "A");
  expect(store.releaseRow(s, "1001", "attempt failed before taskly saw it")).toBe(1);
  expect(store.claimRow(s, "B").uid).toBe("1001");
});

test("a half-used row is terminal and never re-queued", () => {
  const u = store.registerUser(s, "rakib");
  store.enqueue(s, [{ uid: "1001", source: "x.xlsx", row_no: 1 }], u.id);
  store.claimRow(s, "A");
  store.markHalfUsed(s, "1001", "password changed, cookie never delivered");
  expect(store.releaseRow(s, "1001")).toBe(0);
  s.run("UPDATE rows SET claimed_at=datetime('now', '-3 hours') WHERE uid='1001'");
  expect(store.requeueStaleClaims(s, 90)).toBe(0);
  expect(store.claimRow(s, "B")).toBeNull();
});

test("a stale claim (dead worker, password untouched) goes back on the queue", () => {
  const u = store.registerUser(s, "rakib");
  store.enqueue(s, [{ uid: "1001", source: "x.xlsx", row_no: 1 }], u.id);
  store.claimRow(s, "A");
  s.run("UPDATE rows SET claimed_at=datetime('now', '-3 hours') WHERE uid='1001'");
  expect(store.requeueStaleClaims(s, 90)).toBe(1);
  expect(store.claimRow(s, "B").uid).toBe("1001");
});

test("two claims never return the same row", () => {
  const u = store.registerUser(s, "rakib");
  store.enqueue(s, [1, 2, 3].map((n) => ({ uid: String(n), source: "x.xlsx", row_no: n })), u.id);
  expect(store.claimRow(s, "A").uid).not.toBe(store.claimRow(s, "B").uid);
});

test("a verdict binds only to its own session's row", () => {
  const u = store.registerUser(s, "rakib");
  store.enqueue(s, [{ uid: "1", source: "x", row_no: 1 },
                    { uid: "2", source: "x", row_no: 2 }], u.id);
  store.markSent(s, store.claimRow(s, "A").uid, "A");
  store.markSent(s, store.claimRow(s, "B").uid, "B");
  expect(store.bindVerdict(s, "B", "approved").uid).toBe("2");
  expect(store.bindVerdict(s, "B", "approved")).toBeNull();
  expect(store.totals(s).inflight).toBe(1);
});

test("a password can only be claimed once", () => {
  expect(store.claimPassword(s, "h1")).toBe(true);
  expect(store.claimPassword(s, "h1")).toBe(false);
});

test("one session is locked to one live pid; a dead pid releases", () => {
  expect(store.tryLock(s, "880", process.pid)).toBe(true);
  expect(store.tryLock(s, "880", 99999999)).toBe(false);
  s.run("UPDATE session_locks SET pid=99999998 WHERE phone='880'");
  expect(store.tryLock(s, "880", 99999999)).toBe(true);
});

test("a sold uid is never claimable and never enqueued", () => {
  const u = store.registerUser(s, "rakib");
  s.run("INSERT INTO sold_guard (uid) VALUES ('777')");
  const r = store.enqueue(s, [{ uid: "777", source: "x", row_no: 1 }], u.id);
  expect(r.added).toBe(0);
  expect(r.duplicates[0].where).toBe("sold_guard");
  expect(store.claimRow(s, "A")).toBeNull();
});

test("owed is derived, never stored", () => {
  const u = store.registerUser(s, "rakib");
  store.enqueue(s, [{ uid: "1", source: "x", row_no: 1 }], u.id);
  store.markSent(s, "1", "A");
  store.bindVerdict(s, "A", "approved");
  expect(store.owedFor(s, u.id, 6.15).owed).toBeCloseTo(5);
  store.recordPayment(s, { userId: u.id, amount_bkt: 5 });
  expect(store.owedFor(s, u.id, 6.15).owed).toBeCloseTo(0);
});
