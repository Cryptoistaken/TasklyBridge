// cli/test/submit.test.ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import * as XLSX from "xlsx";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readAccounts, uidOf } from "../../index.js";
import * as store from "../store.js";
import { run } from "../submit.js";

let s, tmp, lockTmp, outTmp, savedLock, savedOut;
const cookie = (uid) => `c_user=${uid}; xs=abc; datr=xyz`;
const sheet = (uids) => {
  const f = path.join(tmp, `s${Date.now()}${Math.random().toString(16).slice(2)}.xlsx`);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb,
    XLSX.utils.aoa_to_sheet(uids.map((u) => [cookie(u), `KEY${u}`])), "s");
  XLSX.writeFile(wb, f);
  return f;
};
// What cli/index.js will do before run(): read the sheet, key rows by uid.
const enqueueSheet = (f, userId) =>
  store.enqueue(s, readAccounts(f).map((a) => ({ uid: uidOf(a.cookie), source: f, row_no: a.row })), userId);

const fakeTg = (receipt = true) => ({
  client: { addEventHandler: () => {}, removeEventHandler: () => {} },
  sendRaw: async (what) => (/2FA/i.test(what) ? ["send your cookie"] : ["confirm registration"]),
  press: async () => (receipt ? ["your report has been received! please wait"] : ["hmm, try again"]),
  obeyRateLimit: async (replies) => ({ replies, waited: 0 }),
  isTaskCancelled: () => false,
  isConnected: () => true,
  ensureMainMenu: async () => [],
  isFromPeer: () => true,
  close: async () => {},
});

const engineBase = {
  readAccounts,
  checkUid: async (c) => ({ uid: c.match(/c_user=(\d+)/)?.[1] ?? null, status: "valid" }),
  isCookieDead: async () => false,
  fingerprint: (c) => "fp-" + c.length,
  uidOf,
  walkForPassword: async () => ({ creds: { firstName: "T", lastName: "U", password: "NewPass123" }, startReplies: [] }),
  changeFacebook: async () => ({ ok: true, verdict: "Your password is shown" }),
  parseVerdict: () => null,
  textFrom: () => ({ text: "", msg: null }),
  resolveUrl: () => "https://example.invalid/",
  taskAvailability: async () => ({ on: true }),
  mineChat: async () => ({ submitted: 0, approved: 0, rejected: 0 }),
  Taskly: null,
};

const runOne = (f, userId, engine, events) => run({ s, threads: 1, currentPw: "cur-pw",
  openSession: async () => fakeTg(true), engine, onStep: (e) => events.push(e) });

beforeEach(() => {
  s = store.open(":memory:");
  store.migrate(s);
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cli-submit-"));
  lockTmp = fs.mkdtempSync(path.join(os.tmpdir(), "cli-slock-"));
  outTmp = fs.mkdtempSync(path.join(os.tmpdir(), "cli-sout-"));
  savedLock = process.env.CLI_LOCK_DIR;
  savedOut = process.env.CLI_OUTPUT_DIR;
  process.env.CLI_LOCK_DIR = lockTmp;
  process.env.CLI_OUTPUT_DIR = outTmp;
  store.setSession(s, { phone: "15550101" });
});
afterEach(() => {
  if (savedLock === undefined) delete process.env.CLI_LOCK_DIR;
  else process.env.CLI_LOCK_DIR = savedLock;
  if (savedOut === undefined) delete process.env.CLI_OUTPUT_DIR;
  else process.env.CLI_OUTPUT_DIR = savedOut;
  s.close();
  for (const d of [tmp, lockTmp, outTmp]) fs.rmSync(d, { recursive: true, force: true });
});

test("a successful row renders seven ok steps and lands inflight", async () => {
  const u = store.registerUser(s, "rakib");
  enqueueSheet(sheet(["7001"]), u.id);
  const events = [];
  const r = await runOne(null, u.id, engineBase, events);
  expect(r.sent).toBe(1);
  expect(r.failed).toBe(0);
  const last = events.filter((e) => !e.locked).pop();
  expect(last.done).toHaveLength(7);
  expect(last.done.every((d) => d.status === "ok")).toBe(true);
  const rows = store.userRows(s, u.id, ["inflight"]);
  expect(rows).toHaveLength(1);
  expect(rows[0].uid).toBe("7001");
  expect(rows[0].taskly_session).toBe("15550101");
});

test("a row with no password fails exactly one step and goes back on the queue", async () => {
  const u = store.registerUser(s, "rakib");
  enqueueSheet(sheet(["7002"]), u.id);
  const events = [];
  const r = await runOne(null, u.id, { ...engineBase, walkForPassword: async () => null }, events);
  expect(r.sent).toBe(0);
  expect(r.failed).toBe(1);
  const fails = events.filter((e) => !e.locked).flatMap((e) => e.done).filter((d) => d.status === "fail");
  expect(fails).toHaveLength(1);
  expect(fails[0].label).toBe("provider password");
  expect(store.userRows(s, u.id, ["queued"])).toHaveLength(1);
});

test("a dead account is recorded dead, never retried", async () => {
  const u = store.registerUser(s, "rakib");
  enqueueSheet(sheet(["7003"]), u.id);
  const dead = { ...engineBase, checkUid: async () => ({ uid: "7003", status: "dead", message: "not valid" }) };
  const r = await runOne(null, u.id, dead, []);
  expect(r.failed).toBe(1);
  expect(store.userRows(s, u.id, ["dead"])).toHaveLength(1);
  expect(store.userRows(s, u.id, ["queued"])).toHaveLength(0);
});
