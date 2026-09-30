import { createHash } from "node:crypto";
import {
  Taskly, readAccounts, checkUid, isCookieDead, fingerprint, uidOf,
  walkForPassword, changeFacebook, parseVerdict, textFrom, resolveUrl,
  taskAvailability, mineChat, BailGated,
} from "../index.js";
import { STEP_LABELS, mask } from "./render.js";
import {
  claimRow, releaseRow, markSent, markStatus, markHalfUsed, claimPassword,
  requeueStaleClaims, bindVerdict, totals,
} from "./store.js";
import { acquire } from "./lock.js";
import { pick } from "./sessions.js";
import { writeFor } from "./output.js";
import { catchUp } from "./reconcile.js";
import { EXIT } from "./exit.js";

const TG_FLOOD = /a wait of (\d+) seconds is required/i;
const ACCOUNT_GAP_MS = 2000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (v) => createHash("sha256").update(String(v)).digest("hex");
const base = (p) => String(p ?? "").split(/[\\/]/).pop();

const realEngine = {
  Taskly, readAccounts, checkUid, isCookieDead, fingerprint, uidOf,
  walkForPassword, changeFacebook, parseVerdict, textFrom, resolveUrl,
  taskAvailability, mineChat,
};

// One row, seven steps. Returns { status, defer?, rateLimited? } where
// status is sent | failed, and defer carries a uid that failed BEFORE
// Telegram ever saw it — still sellable, released at the end of the run
// (never mid-run, or the shared queue hands it straight back).
async function workRow(ctx, row, index, total) {
  const { s, tg, phone, E, currentPw, url, emit } = ctx;
  const done = [];
  let cur = 0;
  const at = (i, status, detail = "") => {
    cur = i;
    done[i] = { label: STEP_LABELS[i], status, detail };
    emit({ session: phone, index, total, source: row.source, row: row.row_no,
      uid: row.uid, userId: row.user_id, done: done.filter(Boolean).map((d) => ({ ...d })) });
  };
  const fail = (i, reason) => at(i, "fail", String(reason ?? "").slice(0, 120));
  const failed = (extra = {}) => ({ status: "failed", ...extra });
  let passwordChanged = false;
  const tag = `${base(row.source)}:${row.row_no}`;

  try {
    at(0, "ok", mask(row.uid));

    let pick;
    try {
      const accounts = E.readAccounts(row.source);
      pick = accounts.find((a) => a.row === row.row_no);
      if (!pick) throw new Error(`row ${row.row_no} is gone from the sheet`);
      if (!pick.fa2Key) throw new Error("2FA key missing from the sheet");
    } catch (e) {
      fail(1, e?.message ?? e);
      return failed({ defer: row.uid });
    }
    at(1, "ok", tag);

    const acc = await E.checkUid(pick.cookie);
    if (acc.uid && acc.uid !== row.uid) {
      fail(2, "uid changed in the sheet");
      return failed({ defer: row.uid });
    }
    if (acc.status === "dead") {
      markStatus(s, row.uid, "dead", `account dead (uid check: ${acc.message ?? "not valid"})`);
      fail(2, "account dead");
      return failed();
    }
    if (await E.isCookieDead(pick.cookie)) {
      markStatus(s, row.uid, "dead", "cookie confirmed dead at accountscenter");
      fail(2, "cookie dead");
      return failed();
    }
    at(2, "ok", acc.status);

    const walked = await E.walkForPassword(tg, E.fingerprint(pick.cookie));
    if (!walked?.creds?.password) {
      fail(3, "no password after Start attempts");
      return failed({ defer: row.uid });
    }
    if (walked.creds.password === currentPw) {
      fail(3, "bot gave the password we already have");
      return failed({ defer: row.uid });
    }
    at(3, "ok", `${walked.creds.firstName ?? "?"} ${walked.creds.lastName ?? "?"} · ${walked.creds.password.length} chars`);

    let changed;
    try {
      changed = await E.changeFacebook(currentPw, walked.creds.password, url, pick.cookie);
    } catch (e) {
      if (e instanceof BailGated) {
        markStatus(s, row.uid, "gated", String(e.message).slice(0, 200));
        fail(4, e.message);
        return failed();
      }
      throw e;
    }
    passwordChanged = true;
    claimPassword(s, sha256(walked.creds.password));
    at(4, "ok", changed.ok ? String(changed.verdict ?? "changed").slice(0, 60) : "unconfirmed — sending anyway");

    const keyReplies = await tg.sendRaw("send 2FA key", pick.fa2Key);
    if ((await tg.obeyRateLimit(keyReplies)).waited) throw new Error("rate limited after the 2FA key");
    if (tg.isTaskCancelled(keyReplies)) throw new Error("provider timer ran out after the 2FA key");
    if (!keyReplies.some((r) => /cookie/i.test(r))) throw new Error("expected a cookie prompt after the 2FA key");
    const cookieReplies = await tg.sendRaw("send cookie", pick.cookie.trim());
    if ((await tg.obeyRateLimit(cookieReplies)).waited) throw new Error("rate limited after the cookie");
    if (tg.isTaskCancelled(cookieReplies)) throw new Error("provider timer ran out after the cookie");
    if (!cookieReplies.some((r) => /confirm registration/i.test(r))) throw new Error("no confirmation prompt after the cookie");
    const final = await tg.press("confirm registration", "Account registered");
    if (!final.some((r) => /report has been received/i.test(r))) {
      markHalfUsed(s, row.uid, "sent but unconfirmed — password already changed");
      fail(5, "confirmation sent, no receipt");
      return failed();
    }
    markSent(s, row.uid, phone);
    at(5, "ok", "receipt received");

    writeFor(s, row.user_id, row.source);
    at(6, "ok", "awaiting verdict");
    return { status: "sent" };
  } catch (e) {
    const msg = String(e?.message ?? e);
    if (TG_FLOOD.test(msg)) {
      if (passwordChanged) markHalfUsed(s, row.uid, `flood mid-row: ${msg.slice(0, 160)}`);
      fail(cur, `telegram flood — stopping (${msg.slice(0, 60)})`);
      return failed({ rateLimited: true });
    }
    if (passwordChanged) markHalfUsed(s, row.uid, msg.slice(0, 200));
    else fail(cur, msg);
    return failed(passwordChanged ? {} : { defer: row.uid });
  }
}

// One session, every row it can claim. Verdicts that arrive mid-run bind
// live through the watcher; anything missed is caught by the next catchUp.
async function workSession(ctx, phone) {
  const { s, E, emit, total, open, pages, skipTaskCheck } = ctx;
  const lock = acquire(phone);
  if (!lock) {
    emit({ session: phone, locked: true });
    return { sent: 0, failed: 0, locked: true };
  }
  const tg = await open(phone);
  const handler = async (update) => {
    try {
      const { text, msg } = E.textFrom(update);
      if (!msg || !text || msg.out) return;
      if (!tg.isFromPeer(msg.peerId)) return;
      const v = E.parseVerdict(text);
      if (!v) return;
      bindVerdict(s, phone, v.verdict);
    } catch { /* a verdict must never break a send */ }
  };
  tg.client.addEventHandler(handler);
  try {
    if (!skipTaskCheck) {
      const avail = await E.taskAvailability(tg);
      if (avail.rateLimited) return { sent: 0, failed: 0, rateLimited: true, waitSec: avail.waitSec };
      if (avail.on === false) return { sent: 0, failed: 0, fatal: "job not listed — nothing to sell" };
      try {
        await tg.ensureMainMenu();
      } catch (e) {
        if (TG_FLOOD.test(String(e?.message ?? e))) return { sent: 0, failed: 0, rateLimited: true };
        throw e;
      }
    }
    try {
      catchUp(s, phone, await E.mineChat(tg, pages));
    } catch { /* a failed catch-up never stops a run; --reconcile reports it */ }
    let sent = 0, failed = 0, i = 0;
    const deferred = [];
    for (;;) {
      const row = claimRow(s, phone);
      if (!row) break;
      i++;
      const r = await workRow({ ...ctx, tg, phone }, row, i, total);
      if (r.status === "sent") sent++;
      else {
        failed++;
        if (r.defer) deferred.push(r.defer);
      }
      if (r.rateLimited) return { sent, failed, deferred, rateLimited: true };
      if (!tg.isConnected()) break;
      await sleep(ACCOUNT_GAP_MS);
    }
    return { sent, failed, deferred };
  } finally {
    try { tg.client.removeEventHandler(handler); } catch { /* already gone */ }
    await tg.close().catch(() => {});
    lock.release();
  }
}

// Drain the shared queue across the picked sessions. Rows that failed before
// Telegram are released only after every session is done, so the shared
// queue can never hand them straight back mid-run.
export async function run({ s, threads = 1, debug = false, currentPw = null,
  onStep = null, engine = null, openSession = null, pages = 20, skipTaskCheck = false } = {}) {
  const E = engine ?? realEngine;
  const pw = currentPw ?? process.env.FB_CURRENT_PASSWORD ?? "";
  if (!pw) {
    throw Object.assign(new Error("Current Facebook password missing. Pass currentPw or set FB_CURRENT_PASSWORD in data/cli/.env."),
      { exitCode: EXIT.USAGE });
  }
  const url = E.resolveUrl();
  requeueStaleClaims(s, 90);
  const phones = pick(s, threads);
  const total = totals(s).queued;
  const emit = onStep ?? (() => {});
  const open = openSession ?? ((p) => E.Taskly.open({ phone: p, verdictSink: "none" }));
  const ctx = { s, E, debug, emit, pages, skipTaskCheck, currentPw: pw, url, total, open };
  const results = await Promise.all(phones.map((phone) => workSession(ctx, phone)));
  const deferred = [...new Set(results.flatMap((r) => r.deferred ?? []))];
  for (const uid of deferred) releaseRow(s, uid, "attempt failed before taskly saw it");
  return {
    sent: results.reduce((n, r) => n + (r.sent ?? 0), 0),
    failed: results.reduce((n, r) => n + (r.failed ?? 0), 0),
    rateLimited: results.some((r) => r.rateLimited),
    locked: results.map((r, i) => (r.locked ? phones[i] : null)).filter(Boolean),
    fatal: results.find((r) => r.fatal)?.fatal ?? null,
  };
}
