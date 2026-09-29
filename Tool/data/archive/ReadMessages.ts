/**
 * Read the last N messages from @tasklyBux_bot.
 *
 * TasklyBridge's notes say getHistory returns 0 messages for this peer, always
 * - but that was observed through gotd. This checks whether GramJS can see
 * them, which would also mean a missed credential message is recoverable
 * instead of lost.
 *
 *   bun ReadMessages.ts -p <phone> -n 10
 */
import path from "path";
import { fileURLToPath } from "url";
import { Taskly, bridgeEnv } from "./TG.ts";

const args = process.argv.slice(2);
const flag = (name: string, fallback?: string) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};

const limit = Number(flag("-n", "10"));
const phone = flag("-p") ?? process.env.TG_PHONE;

const t = await Taskly.open({ phone });
try {
  const target = bridgeEnv().TG_TARGET ?? "tasklyBux_bot";
  const msgs = await t.client.getMessages(t.peer, { limit });
  const rows: any[] = Array.isArray(msgs) ? msgs : [...(msgs as any)];

  console.log(`asked for ${limit}, got ${rows.length} from @${target}\n`);
  if (!rows.length) {
    console.log("History is empty for this peer - same as the Go client reported.");
  }
  for (const m of rows) {
    const text = String(m.message ?? "").replace(/\s+/g, " ").slice(0, 400);
    const when = m.date ? new Date(m.date * 1000).toLocaleString() : "?";
    const dir = m.out ? "OUT" : "IN ";
    console.log(`${when}  ${dir}  ${text}`);
  }
} finally {
  await t.close();
}
