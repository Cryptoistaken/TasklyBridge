// cli/sessions.test.ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as store from "../store.js";
import { seed, pick } from "../sessions.js";
import { acquire } from "../lock.js";

const A = "15550101", B = "15550102";
let s, lockTmp, savedEnv;

beforeEach(() => {
  s = store.open(":memory:");
  store.migrate(s);
  lockTmp = fs.mkdtempSync(path.join(os.tmpdir(), "cli-lock-"));
  savedEnv = process.env.CLI_LOCK_DIR;
  process.env.CLI_LOCK_DIR = lockTmp;
  store.setSession(s, { phone: A });
  store.setSession(s, { phone: B });
  s.run("UPDATE session_state SET last_used_at='2020-01-01 00:00:00' WHERE phone=?", [A]);
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env.CLI_LOCK_DIR;
  else process.env.CLI_LOCK_DIR = savedEnv;
  s.close();
  fs.rmSync(lockTmp, { recursive: true, force: true });
});

test("least-recently-used wins", () => {
  expect(pick(s, 1)).toEqual([A]);
});

test("a rate-limited session is skipped", () => {
  store.setSession(s, { phone: A, rate_limit_until: new Date(Date.now() + 3600e3).toISOString() });
  expect(pick(s, 1)).toEqual([B]);
});

test("max returns all free", () => {
  expect(pick(s, "max").sort()).toEqual([A, B]);
});

test("a locked session is never returned", () => {
  const l = acquire(A);
  expect(pick(s, "max")).toEqual([B]);
  l.release();
});

test("no free session throws rather than running nothing", () => {
  const l1 = acquire(A), l2 = acquire(B);
  expect(() => pick(s, 1)).toThrow(/no free session/i);
  l1.release();
  l2.release();
});

test("seed registers each session once", () => {
  expect(seed(s, [A, B, A])).toBe(3);
  expect(store.sessionState(s).length).toBe(2);
});
