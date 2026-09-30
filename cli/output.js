import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import * as XLSX from "xlsx";
import { readAccounts, uidOf } from "../index.js";
import { userRows } from "./store.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const outRoot = path.join(here, "..", "data", "cli", "output");
const base = (p) => String(p ?? "").split(/[\\/]/).pop();

export function outputDir(handle, date = new Date()) {
  const day = (date instanceof Date ? date : new Date(date)).toISOString().slice(0, 10);
  return path.join(outRoot, "users", String(handle), day);
}

// Rewrites the user's file for one source from what SQLite says succeeded.
// Credentials come from the sheet, joined on row_no — never from SQLite, so
// a moved or edited sheet fails loudly instead of writing a stale cookie.
export function writeFor(s, userId, source, now = new Date()) {
  const u = s.query("SELECT handle FROM users WHERE id=?").get(userId);
  if (!u) throw new Error(`no user with id ${userId}`);
  const d = now instanceof Date ? now : new Date(now);
  const dir = outputDir(u.handle, d);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = d.toISOString().slice(11, 19).replace(/:/g, "");
  const file = path.join(dir, `${base(source)}-${stamp}.xlsx`);
  const succeeded = userRows(s, userId, ["inflight", "approved"])
    .filter((r) => base(r.source) === base(source));
  let creds;
  try {
    creds = new Map(readAccounts(source).map((a) => [a.row, a]));
  } catch (e) {
    throw new Error(`cannot re-read sheet ${source}: ${e?.message ?? e}`);
  }
  const data = [["cookie", "2fa_key", "password", "uid"]];
  const seen = new Set();
  for (const r of succeeded) {
    if (seen.has(r.uid)) continue;
    seen.add(r.uid);
    const c = creds.get(r.row_no);
    if (!c) throw new Error(`row ${r.row_no} of ${source} is gone from the sheet — refusing a stale cookie`);
    data.push([c.cookie, c.fa2Key, r.new_password, uidOf(c.cookie) ?? r.uid]);
  }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(data), "accounts");
  XLSX.writeFile(wb, file);
  return file;
}
