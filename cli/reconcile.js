import { Taskly, mineChat } from "../index.js";

// Verdicts arrive unprompted ~64 minutes after a send, and only reach a
// connected client. Anything that lands while the CLI is stopped is invisible
// until the next walk, so every submit run starts with catchUp and --reconcile
// runs it on demand. Binding is per session, oldest inflight first, capped at
// what is actually inflight — anything beyond is surplus: reported, never
// attached, never paid. Rejections bind the same FIFO way; the reason is
// unknown from a tally, so the note says where it came from.
export function catchUp(s, phone, tally = null) {
  if (!tally) throw new Error("catchUp needs a chat tally — use run() for the live chat");
  const p = String(phone);
  const led = (st) => Number(s.query("SELECT count(*) AS n FROM rows WHERE status=? AND taskly_session=?").get(st, p)?.n ?? 0);
  const remaining = () =>
    s.query("SELECT uid FROM rows WHERE status='inflight' AND taskly_session=? ORDER BY sent_at").all(p).map((r) => r.uid);
  const bind = (uid, verdict, note) => {
    s.query("UPDATE rows SET status=?, verdict_at=datetime('now'), note=? WHERE uid=?").run(verdict, note, uid);
  };
  let matched = 0, surplus = 0;
  const needA = Math.max(0, Number(tally.approved ?? 0) - led("approved"));
  const giveA = remaining().slice(0, needA);
  for (const uid of giveA) bind(uid, "approved", "reconciled: approved in provider chat");
  matched += giveA.length;
  surplus += needA - giveA.length;
  const needR = Math.max(0, Number(tally.rejected ?? 0) - led("rejected"));
  const giveR = remaining().slice(0, needR);
  for (const uid of giveR) bind(uid, "rejected", "reconciled: rejected in provider chat");
  matched += giveR.length;
  surplus += needR - giveR.length;
  return { found: { approved: Number(tally.approved ?? 0), rejected: Number(tally.rejected ?? 0) }, matched, surplus };
}

// Live walk, one session at a time: history reads are Telegram traffic, and a
// walk during an active submit can extend a provider rate limit.
export async function run(s, phones, { pages = 50 } = {}) {
  const out = [];
  for (const phone of phones ?? []) {
    const tg = await Taskly.open({ phone, verdictSink: "none" });
    try {
      const tally = await mineChat(tg, pages);
      out.push({ phone, tally, ...catchUp(s, phone, tally) });
    } finally {
      await tg.close().catch(() => {});
    }
  }
  return out;
}
