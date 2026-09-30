// cli/lock.test.ts
import { test, expect } from "bun:test";
import fs from "node:fs";
import { acquire, holder, lockDir, lockPath } from "./lock.js";

// Synthetic numbers, on purpose. The real ones are in data/.env and must never
// reach a test file or a commit; Backend uses the same 1555 convention.
const PHONE = "15550100";

test("a second acquire on the same phone is refused", () => {
  const a = acquire(PHONE);
  expect(a).not.toBeNull();
  expect(acquire(PHONE)).toBeNull();
  a.release();
  const b = acquire(PHONE);
  expect(b).not.toBeNull();
  b.release();
});

test("a lock whose owner is dead is taken over", () => {
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(lockPath(PHONE), "99999999\n");
  const b = acquire(PHONE);
  expect(b).not.toBeNull();
  b.release();
});

test("a lock file placed by the other tool is honoured both ways", () => {
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(lockPath(PHONE), `${process.pid}\n`);
  expect(holder(PHONE)).toBe(process.pid);
  expect(acquire(PHONE)).toBeNull();
  fs.unlinkSync(lockPath(PHONE));
  expect(holder(PHONE)).toBeNull();
});
