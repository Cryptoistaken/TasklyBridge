// User-facing Telegram bot. Listens for accounts, stores them in Postgres.
//
// Telegraf, and that is not a style choice: Telegraf speaks the Bot API over
// HTTPS, so this process needs no MTProto session file and no TG_API_ID /
// TG_API_HASH. The only credential it holds is BOT_TOKEN. gramJS would have meant
// a .session blob next to the taskly ones - and a .session is a live credential.
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
import { Telegraf, Markup } from "telegraf";
import { config } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "url";
import { upsertUser, addSubmission, report, db, claimUnnotified, unmarkNotified, userTgId } from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.join(__dirname, "data", ".env") });

// ---- Pure helpers. Exported so --selftest can check them with no network. ----

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

// Button targets as plain data. The selftest checks these rather than the markup,
// because Telegraf's helper returns { inline_keyboard } and there is no reason to
// reach into it - what matters is that every action is reachable by a button
// rather than by typing a command.
export const BUTTONS = {
  start: [["Submit account", "submit"], ["My status", "status"]],
  prompt: [["Cancel", "menu"]],
  ok: [["OK", "menu"]],
  refresh: [["Refresh", "status"]],
};
// Markup.inlineKeyboard takes an array of ROWS, each row an array of buttons.
// BUTTONS is a flat list of [label, data] pairs, and each pair is its own row -
// one button per row. Getting this wrong is silent: map over the pair where a
// row is expected and destructuring turns "Submit account" into the two buttons
// "S" and "s", which passes any check that only asks whether text is a string.
const from = (name) => Markup.inlineKeyboard(
  BUTTONS[name].map(([label, data]) => [{ text: label, callback_data: data }]),
);

export const kb = {
  start: () => from("start"),
  prompt: () => from("prompt"),
  ok: () => from("ok"),
  refresh: () => from("refresh"),
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
  // No command exists for this. The user typed something, so point at the button
  // rather than list commands they were never meant to learn.
  idle: () => "Use the button below.",
  error: () => "Something went wrong. Try again.",
  paid: (amount) => `Payment received: ${amount}`,
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

// Awaiting a submission. A table rather than process memory, so a restart does
// not drop a half-finished submit. Self-expires after 30 minutes.
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
export function build(botToken) {
  const bot = new Telegraf(botToken);

  bot.start(async (ctx) => {
    await clearExpecting(ctx.chat.id);
    await ctx.reply(text.start(), kb.start());
  });

  bot.action("submit", async (ctx) => {
    await ctx.answerCbQuery();
    await setExpecting(ctx.chat.id);
    await ctx.reply(text.prompt(), kb.prompt());
  });

  bot.action("status", async (ctx) => {
    await ctx.answerCbQuery();
    const all = await report();
    await ctx.reply(text.status(mineFrom(all, ctx.from.id)), kb.refresh());
  });

  bot.action("menu", async (ctx) => {
    await ctx.answerCbQuery();
    await clearExpecting(ctx.chat.id);
    await ctx.reply(text.start(), kb.start());
  });

  bot.on("text", async (ctx) => {
    const body = ctx.message.text.trim();

    if (await isExpecting(ctx.chat.id)) {
      if (/^\/cancel$/i.test(body)) { await clearExpecting(ctx.chat.id); return ctx.reply(text.cancelled(), kb.ok()); }
      const p = parseSubmission(body);
      if (!p.ok) {
        const t = p.why === "not-a-cookie" ? text.notACookie() : p.why === "bad-key" ? text.badKey() : text.badFormat();
        return ctx.reply(t, kb.prompt());
      }
      const u = await upsertUser(ctx.from.id, ctx.from.username ?? null);
      const r = await addSubmission(u.id, p.cookie, p.key);
      await clearExpecting(ctx.chat.id);
      if (!r.created) return ctx.reply(text.duplicate(), kb.ok());
      return ctx.reply(text.accepted(await queuePosition(r.submission.id)), kb.ok());
    }

    // /start is the only command. Anything else typed at the bot gets the menu.
    return ctx.reply(text.idle(), kb.start());
  });

  // Anything that is not text (a photo, a sticker) gets the same short nudge, so
  // the bot is never silent.
  bot.on(["photo", "sticker", "document", "voice"], async (ctx) => {
    if (await isExpecting(ctx.chat.id)) return ctx.reply(text.badFormat(), kb.prompt());
    return ctx.reply(text.idle(), kb.start());
  });

  bot.catch((err, ctx) => {
    console.error("handler: " + (err?.message ?? err));
    return ctx?.reply(text.error(), kb.start()).catch(() => {});
  });

  // ---- Payment notifications (the outbox) ----
  // Payments are made by hand with --pay, which only writes a row. Telling the
  // user is a SEPARATE concern, because the bot may be down when a payment is
  // recorded. notified_at stays null until the message actually goes out, so
  // anything recorded while this was stopped is still sent on the next poll.
  // That one nullable column is the whole retry mechanism.
  const tick = async () => {
    const due = await claimUnnotified(10);
    for (const p of due) {
      const owner = await userTgId(p.user_id);
      if (!owner) { console.error(`payment ${p.id}: no telegram id for user ${p.user_id}`); continue; }
      try {
        await bot.telegram.sendMessage(owner, text.paid(p.amount));
        console.log(`payment ${p.id}: told user ${owner} about ${p.amount}`);
      } catch (e) {
        // Put it back so the next tick retries. A payment nobody was told about
        // must not be quietly lost just because the bot was unreachable.
        console.error(`payment ${p.id}: could not tell user ${owner} (${e.message}) - will retry`);
        await unmarkNotified(p.id);
      }
    }
  };
  tick().catch((e) => console.error("outbox: " + e.message));
  const poll = setInterval(() => tick().catch((e) => console.error("outbox: " + e.message)), 20_000);
  process.once("SIGINT", () => clearInterval(poll));
  process.once("SIGTERM", () => clearInterval(poll));

  return bot;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const token = process.env.BOT_TOKEN;
  if (!token) { console.error("BOT_TOKEN is not set in data/.env"); process.exit(1); }
  const bot = build(token);
  bot.telegram.getMe()
    .then((me) => console.log("bot ready: @" + me.username))
    .catch((e) => { console.error("could not reach Telegram: " + e.message); process.exit(1); });
  bot.launch().catch((e) => { console.error(e.message); process.exit(1); });
  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
}
