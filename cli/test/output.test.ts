// cli/output.test.ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import * as XLSX from "xlsx";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as store from "../store.js";
import { writeFor } from "../output.js";

let s, tmp;
beforeEach(() => {
  s = store.open(":memory:");
  store.migrate(s);
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cli-out-"));
});
afterEach(() => {
  s.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const cookie = (uid) => `c_user=${uid}; xs=abc; datr=xyz`;
const sheet = (uids) => {
  const f = path.join(tmp, `t${Date.now()}${Math.random().toString(16).slice(2)}.xlsx`);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb,
    XLSX.utils.aoa_to_sheet(uids.map((u) => [cookie(u), `KEY${u}`])), "s");
  XLSX.writeFile(wb, f);
  return f;
};
const readSheet = (f) => {
  const wb = XLSX.readFile(f);
  return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 });
};
const succeed = (uid, file, rowNo, pw = "pw-" + uid) => {
  const u = s.query("SELECT id FROM users LIMIT 1").get();
  store.enqueue(s, [{ uid: String(uid), source: file, row_no: rowNo }], u.id);
  store.markSent(s, String(uid), "A");
  s.query("UPDATE rows SET new_password=? WHERE uid=?").run(pw, String(uid));
};
const at = (iso) => new Date(iso);

test("only successful rows reach the file", () => {
  const u = store.registerUser(s, "rakib");
  const f = sheet(["1", "2", "3", "4"]);
  store.enqueue(s, ["1", "2", "3", "4"].map((uid, i) => ({ uid, source: f, row_no: i + 1 })), u.id);
  store.markSent(s, "1", "A");
  store.markSent(s, "2", "A");
  s.query("UPDATE rows SET status='rejected' WHERE uid='2'").run();
  const rows = store.userRows(s, u.id, ["inflight", "approved"]);
  expect(rows).toHaveLength(1);
  expect(rows[0].uid).toBe("1");
});

test("the password column is present and populated", () => {
  const u = store.registerUser(s, "rakib");
  const f = sheet(["9001"]);
  succeed("9001", f, 1, "Abc12345");
  const ws = readSheet(writeFor(s, u.id, f));
  expect(ws[0]).toEqual(["cookie", "2fa_key", "password", "uid"]);
  expect(ws[1][2]).toBe("Abc12345");
  expect(ws[1][3]).toBe("9001");
});

test("the file is rewritten, not appended, and keeps one row per uid", () => {
  const u = store.registerUser(s, "rakib");
  const f = sheet(["9001", "9002"]);
  succeed("9001", f, 1);
  writeFor(s, u.id, f);
  succeed("9002", f, 2);
  const ws = readSheet(writeFor(s, u.id, f));
  expect(ws.length).toBe(3);
});

test("re-running the same sheet the same minute does not clobber", () => {
  const u = store.registerUser(s, "rakib");
  const f = sheet(["9001"]);
  succeed("9001", f, 1);
  expect(writeFor(s, u.id, f, at("2026-09-30T10:00:00")))
    .not.toBe(writeFor(s, u.id, f, at("2026-09-30T10:00:01")));
});
