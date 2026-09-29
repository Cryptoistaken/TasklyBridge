// User-facing Telegram bot. Listens for accounts, stores them in Postgres.
//
// STYLE - deliberate, keep it:
//   inline keyboards only, never reply keyboards
//   /start is the ONLY command. Everything else is a button. A user who never
//   types anything can still do the whole thing.
//   ✅ and ❌ only where the symbol itself carries the meaning
//   no other emoji anywhere in this file
//   one or two lines per message: the fact, the button, stop
//
// The bot never touches taskly. It only writes rows. Submission is a separate
// process (bun index.js --drain), so a taskly outage cannot affect users, and
// two processes sharing one Postgres is safe because every claim is a single
// UPDATE ... FOR UPDATE SKIP LOCKED.
import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "url";
import { config } from "dotenv";
import { upsertUser, addSubmission, report, db, closeDb } from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.join(__dirname, "data", ".env") });

const BOT_SESSION = path.join(__dirname, "data", "sessions", "userbot.session");

// ---- Pure helpers. Exported so they can be tested with no Telegram at all. ----

// A cookie is a long run of name=value pairs. The 2FA key is 8 groups of 4.
// Matching both is what tells the fields apart when a paste lands as one line.
export function parseSubmission(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return { ok: false, why: "empty" };

  const lines = s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let cookie = "", key = "";
  if (lines.length >= 2) [cookie, key] = lines;
  else {
    const cells = lines[0].split(/\t+/).map((c) => c.trim());
    if (cells.length === 2) [cookie, key] = cells;
  }
  if (!cookie || !key) return { ok: false, why: "format" };
  if (!/(?:^|;\s*)(?:datr|xs|fr|sb|c_user|sd|wd|dpr|csrf)=/.test(cookie) || cookie.length < 200) {
    return { ok: false, why: "not-a-cookie" };
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9\s]{20,}$/.test(key)) return { ok: false, why: "bad-key" };
  return { ok: true, cookie, key: key.replace(/\s+/g, "") };
}

// Button targets live here as plain data, and the Api markup is built from them.
// gramJS does not hand the callback data back on a constructed button, so this
// is also the only place --selftest can prove every action is reachable by a
// button rather than by typing.
export const BUTTONS = {
  start: [["Submit account", "submit"], ["My status", "status"]],
  prompt: [["Cancel", "menu"]],
  ok: [["OK", "menu"]],
  refresh: [["Refresh", "status"]],
};
// gramJS 2.26 exports no keyboard helper, so the inline markup is built from the
// raw Api classes. Callback data goes over the wire as a Buffer.
const markup = (lines) => new Api.ReplyInlineMarkup({
  rows: lines.map((line) => new Api.KeyboardButtonRow({
    buttons: line.map(([label, data]) => new Api.KeyboardButton({ text: label, data: Buffer.from(data) })),
  })),
});

export const kb = {
  start: () => markup(BUTTONS.start),
  prompt: () => markup(BUTTONS.prompt),
  ok: () => markup(BUTTONS.ok),
  refresh: () => markup(BUTTONS.refresh),
};

export const text = {
  start: () => "Send Facebook accounts for approval.",
  prompt: () => "Send the cookie and the 2FA key.\n\nFormat:\ncookie\n2FA key",
  badFormat: () => "Could not read that.\n\nCookie on the first line, 2FA key on the second.",
  notACookie: () => "The first line is not a cookie.\n\nA cookie is a long string of name=value pairs.",
  badKey: () => "The second line is not a 2FA key.",
  accepted: (n) => `Queued at position ${n}.`,
  duplicate: () => "Already submitted.",
  cancelled: () => "Cancelled.",
  // No command exists for this. The user just typed something, so point at the
  // button rather than listing commands they were never meant to learn.
  idle: () => "Use the button below.",
  // ✅ and ❌ appear here only because the row is a verdict and the symbol is the
  // fastest way to read a list. Nowhere else in this file.
  status: (c) => {
    const row = (mark, label, n) => `${mark} ${String(n).padStart(4)}   ${label}`;
    return [
      row("▸", "Queued", c.queued ?? 0),
      row("▸", "In review", c.inflight ?? 0),
      row("✅", "Approved", c.approved ?? 0),
      row("❌", "Rejected", c.rejected ?? 0),
    ].join("\n");
  },
};

export function mineFrom(reportRows, tgId) {
  return reportRows.find((u) => u.tg_id === Number(tgId))?.counts ?? {};
}

// ---- Awaiting a submission. A table, not an in-process Set, so a restart does
// not silently drop a user who was mid-submit. Self-expires after 30 minutes.
async function setExpecting(chat) {
  await db().query("INSERT INTO chat_expect (chat) VALUES ($1) ON CONFLICT (chat) DO UPDATE SET at = now()", [chat]);
}
async function clearExpecting(chat) {
  await db().query("DELETE FROM chat_expect WHERE chat = $1", [chat]);
}
async function isExpecting(chat) {
  const { rows } = await db().query("SELECT 1 FROM chat_expect WHERE chat = $1 AND at > now() - interval '30 minutes'", [chat]);
  return rows.length > 0;
}

async function queuePosition(id) {
  const { rows } = await db().query(
    `SELECT count(*)::int AS n FROM submissions
      WHERE status = 'queued'
        AND created_at <= (SELECT created_at FROM submissions WHERE id = $1)`,
    [id],
  );
  return rows[0].n;
}

// ---- Bot ----
let client;
const say = (chat, body, markup) =>
  client.invoke(new Api.messages.SendMessage({ peer: chat, message: body, reply_markup: markup }));

async function onCommand(m) {
  const chat = m.chatId;
  const body = String(m.message ?? "").trim();
  const tgId = Number(m.fromId?.userId ?? 0);
  if (!tgId) return;

  if (await isExpecting(chat)) {
    if (/^\/cancel$/i.test(body)) { await clearExpecting(chat); return say(chat, text.cancelled(), kb.ok()); }
    const p = parseSubmission(body);
    if (!p.ok) {
      const t = p.why === "not-a-cookie" ? text.notACookie() : p.why === "bad-key" ? text.badKey() : text.badFormat();
      return say(chat, t, kb.prompt());
    }
    const u = await upsertUser(tgId, null);
    const r = await addSubmission(u.id, p.cookie, p.key);
    await clearExpecting(chat);
    if (!r.created) return say(chat, text.duplicate(), kb.ok());
    return say(chat, text.accepted(await queuePosition(r.submission.id)), kb.ok());
  }

  if (/^\/start$/i.test(body)) return say(chat, text.start(), kb.start());
  // Nothing else is a command. A bare message with no pending submission gets
  // the menu rather than silence.
  if (body.startsWith("/")) return say(chat, text.start(), kb.start());
  return say(chat, text.idle(), kb.start());
}

async function onButton(q) {
  const chat = q.message?.chatId ?? q.peerId?.userId;
  if (!chat) return;
  await client.invoke(new Api.messages.GetBotCallbackAnswer({ peer: chat, msg_id: q.messageId, data: q.data })).catch(() => {});
  const tgId = Number(q.fromId?.userId ?? 0);
  if (q.data === "submit") { await setExpecting(chat); return say(chat, text.prompt(), kb.prompt()); }
  if (q.data === "status") { const all = await report(); return say(chat, text.status(mineFrom(all, tgId)), kb.refresh()); }
  if (q.data === "menu") { await clearExpecting(chat); return say(chat, text.start(), kb.start()); }
}

async function start() {
  const token = process.env.BOT_TOKEN;
  if (!token) throw new Error("BOT_TOKEN is not set in data/.env");
  if (!process.env.TG_API_ID || !process.env.TG_API_HASH) throw new Error("TG_API_ID / TG_API_HASH are not set in data/.env");

  const saved = fs.existsSync(BOT_SESSION) ? fs.readFileSync(BOT_SESSION, "utf8") : "";
  client = new TelegramClient(new StringSession(saved), Number(process.env.TG_API_ID), process.env.TG_API_HASH, { connectionRetries: 5 });
  client.setLogLevel(process.env.TOOL_DEBUG ? "debug" : "error");
  await client.connect();
  if (!(await client.checkAuthorization())) {
    await client.start({ botToken: token, onError: (e) => { console.error(e.message); return true; } });
  }
  fs.mkdirSync(path.dirname(BOT_SESSION), { recursive: true });
  fs.writeFileSync(BOT_SESSION, client.session.save(), "utf8");
  const me = await client.getMe();
  console.log("bot ready: @" + me.username);

  client.addEventHandler(async (u) => {
    if (u instanceof Api.UpdateBotCallbackQuery) return void (await onButton(u).catch((e) => console.error(e.message)));
    const m = u instanceof Api.UpdateNewMessage ? u.message : null;
    if (!m || m.out) return;
    // Only /start is a command. Telegram's own "Start" button on a private chat
    // arrives as /start, so that one still works.
    await onCommand(m).catch((e) => console.error(e.message));
  });

  await new Promise(() => {}); // idle: this process only ever writes rows
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  start().catch((e) => { console.error(e.message); process.exit(1); });
}
