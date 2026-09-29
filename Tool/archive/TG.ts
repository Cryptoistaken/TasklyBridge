/**
 * Talking to @tasklyBux_bot.
 *
 * This is NOT the Bot API — a bot cannot be messaged by a bot. The provider is
 * reached as a Telegram *user* over MTProto, which is what TasklyBridge's Go
 * code does with gotd. Ported rules, each from taskly.go / context.md §4:
 *
 *  - getHistory returns 0 messages, always. Replies come off the live update
 *    stream, never from history.
 *  - The handler is registered BEFORE sending, so a fast reply cannot be missed
 *    (the Go version does the same with its sequence stamp).
 *  - Waiting is "500ms of silence from the bot", not a fixed sleep.
 *  - Button labels must be sent WHOLE. The provider matches exact keyboard
 *    text, and a bare fragment lands in its cancel handler.
 *  - The provider has a modal state: after Start, menu labels read as cancel.
 *    ensureMainMenu() proves it is on the main menu by looking for "Balance".
 */
import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions";
import { audit, preview } from "./audit.ts";
import { createInterface } from "node:readline";
import { config } from "dotenv";
import chalk from "chalk";
import path from "path";
import fs from "node:fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
config();

const BRIDGE_ENV = "C:\\Users\\Ratul\\Studio\\Tools\\TasklyBridge\\Backend\\.env";
const SESSION_DIR = path.join(__dirname, "sessions");
// The bot sends a reply as SEPARATE messages - credentials first, then the
// 2FA prompt - with a gap between them. At 500ms the wait returned after the
// first message and the second was never seen, which is why the password
// looked like it did not exist. 2s is comfortably longer than that gap.
const QUIET_MS = 2000; // bot has been silent this long => it is done
const HARD_MS = 60_000; // never wait longer than this for one reply
const THROTTLE_MS = 1000; // minimum gap between two sends to the provider

/**
 * Canonical form of a phone number: digits only, keeping a leading +.
 *
 * Both the session filename and the sign-in call use this, so "+880 18 462
 * 91929" and "8801846291929" resolve to the SAME session instead of quietly
 * creating two files for one account.
 */
export function normalizePhone(phone: string): string {
  const p = phone.trim().replace(/[\s()\-.]/g, "");
  return p.startsWith("+") ? `+${p.slice(1).replace(/\D/g, "")}` : p.replace(/\D/g, "");
}

/** One file per phone number, so several accounts can be driven separately. */
const sessionPath = (phone: string) => path.join(SESSION_DIR, `${normalizePhone(phone)}.session`);

/** Phone numbers we hold a session for. */
export function listSessions(): string[] {
  if (!fs.existsSync(SESSION_DIR)) return [];
  return fs
    .readdirSync(SESSION_DIR)
    .filter((f) => f.endsWith(".session"))
    .map((f) => f.slice(0, -".session".length))
    .sort();
}

export const tlog = {
  info: (m: string) => console.log(chalk.blue("TG"), chalk.white(m)),
  ok: (m: string) => console.log(chalk.green("TG"), chalk.white(m)),
  err: (m: string) => console.log(chalk.red("TG"), chalk.white(m)),
  raw: (m: string) => console.log(chalk.gray("TG"), chalk.gray(m)),
};

/** Asks a question on the terminal. Bun has no readline/promises. */
function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Pulls text out of any update that carries a message.
 *
 * This matters more than it looks. The provider may EDIT its prompt into the
 * credentials rather than sending a new message, so listening only for
 * UpdateNewMessage misses them - and the "ignored VirtualClass" lines in the
 * logs were exactly that. Channel messages are handled too, because a job
 * report can arrive in a group rather than the private chat.
 */
export function textFrom(update: any): { text: string; msg: any } {
  const m =
    update instanceof Api.UpdateNewMessage
      ? update.message
      : update instanceof Api.UpdateNewChannelMessage
        ? update.message
        : update instanceof Api.UpdateEditMessage
          ? update.message
          : update instanceof Api.UpdateEditChannelMessage
            ? update.message
            : null;
  return { text: String(m?.message ?? ""), msg: m };
}

/** Reads TG_* keys from TasklyBridge's .env without importing dotenv twice. */
export function bridgeEnv(): Record<string, string> {
  if (!fs.existsSync(BRIDGE_ENV)) {
    throw new Error(`TasklyBridge .env not found at ${BRIDGE_ENV}`);
  }
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(BRIDGE_ENV, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

export class Taskly {
  client: TelegramClient;
  peer: any;
  private window: any[] = []; // recent replies, for label resolution
  private lastSend = 0; // for throttle()

  private constructor(client: TelegramClient) {
    this.client = client;
  }

  /**
   * Opens (or creates) the session for one phone number. Each number gets its
   * own file under sessions/, so several Telegram accounts can be driven
   * separately and none of them is the Go bridge's session.
   *
   * Phone resolution: explicit arg -> TG_PHONE -> the only session we have.
   * With several sessions and no choice given, it refuses rather than guessing.
   */
  static async open(opts: { phone?: string } = {}) {
    const env = bridgeEnv();
    const apiId = Number(env.TG_API_ID);
    const apiHash = env.TG_API_HASH;
    if (!apiId || !apiHash) throw new Error("TG_API_ID / TG_API_HASH missing from Bridge .env");

    const have = listSessions();
    const phone = opts.phone ?? process.env.TG_PHONE ?? (have.length === 1 ? have[0] : undefined);
    if (!phone) {
      throw new Error(
        have.length
          ? `Several sessions exist (${have.join(", ")}). Pass -p <phone> to pick one.`
          : `No session yet. Create one: bun TG.ts <phone>`,
      );
    }
    const file = sessionPath(phone);
    const saved = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    const digits = normalizePhone(phone);

    const client = new TelegramClient(new StringSession(saved), apiId, apiHash, {
      connectionRetries: 3,
    });
    const t = new Taskly(client);

    await client.connect();
    // checkAuthorization() is the v2 way. client.user is NOT populated from a
    // saved session, so testing it always looked like "no session".
    if (!(await client.checkAuthorization())) {
      tlog.info(`Logging in as ${digits} (one time)`);
      // GramJS v2: start() runs the phone -> code -> 2FA flow.
      // onError is required; returning true aborts the attempt.
      await client.start({
        phoneNumber: digits,
        phoneCode: async () => ask("Telegram login code: "),
        password: async (hint?: string) =>
          ask(`Telegram 2FA password${hint ? ` (hint: ${hint})` : ""}: `),
        onError: (err: Error) => {
          tlog.err(err.message);
          return true; // stop, do not retry blindly
        },
      });
    }
    fs.mkdirSync(SESSION_DIR, { recursive: true });
    fs.writeFileSync(file, client.session.save(), "utf8");
    tlog.ok(`Session ready for ${digits}`);

    t.peer = await client.getEntity(env.TG_TARGET ?? "tasklyBux_bot");
    tlog.ok(`Peer resolved: ${env.TG_TARGET}`);
    return t;
  }

  async close() {
    await this.client.disconnect().catch(() => {});
  }

  /**
   * Is the connection still usable?
   *
   * A long run keeps ONE client open across several accounts, so a dropped
   * connection has to be distinguishable from a provider-side failure -
   * otherwise every later account fails for the same reason and looks like a
   * bad cookie.
   *
   * Uses `connected`, not `isConnected()`: that method does not exist on
   * telegram 2.26.x (checked against the installed package), and calling it
   * returned undefined - falsy - so every failure was misread as a dead
   * connection and aborted the group after one row.
   */
  isConnected(): boolean {
    try {
      return (this.client as any).connected === true;
    } catch {
      return false;
    }
  }

  /**
   * Forget the recent-message window.
   *
   * The window backs label resolution. Carrying it across accounts is a real
   * hazard, not a tidiness one: labels() scans newest-first but falls through
   * to older messages, so a button that only exists on the PREVIOUS account's
   * keyboard can still be resolved and pressed on the next one. That is a
   * silent wrong-keyboard press against a paid provider.
   */
  resetWindow() {
    this.window = [];
  }

  /**
   * One comparable key for "which chat is this".
   *
   * A PeerUser (what arrives on a message) carries `userId`, but the resolved
   * entity is a full User, which carries `id`. Comparing them field-for-field
   * gave 0:0:0 vs 0:123:0 and silently dropped every reply.
   */
  private peerKey(p: any): string {
    const userId = Number(p?.userId ?? p?.id ?? 0);
    const chatId = Number(p?.chatId ?? 0);
    const channelId = Number(p?.channelId ?? 0);
    return `${channelId}:${chatId}:${userId}`;
  }
  isFromPeer(p: any) {
    return this.peerKey(p) === this.peerKey(this.peer);
  }

  /**
   * Live read-only view of the chat. Sends nothing, presses nothing, and never
   * calls /start - so it cannot reset a job that is already in progress.
   * Runs until Ctrl+C.
   */
  watch() {
    const t = this;
    tlog.ok("Watching the chat. READ-ONLY: nothing is sent. Ctrl+C to stop.");
    t.client.addEventHandler((update: Api.Update) => {
      const { text, msg } = textFrom(update);
      if (!msg || !text || msg.out) return;
      const buttons = (msg.replyMarkup?.rows ?? [])
        .flatMap((r: any) => r?.buttons ?? [])
        .map((b: any) => b?.text ?? b?.label)
        .filter(Boolean);
      const tag = t.isFromPeer(msg.peerId) ? "PROVIDER" : "other-chat";
      const at = new Date().toLocaleTimeString();
      audit({ leg: "taskly->bot", what: "watch", text, buttons, from: t.peerKey(msg.peerId) });
      console.log(chalk.cyan(`[${at}] ${tag}: `), chalk.white(text));
      if (buttons.length) {
        console.log(chalk.cyan(`[${at}]   buttons: `), chalk.yellow(buttons.join(" | ")));
      }
      t.window.push(msg);
      if (t.window.length > 12) t.window.shift();
    });
    return new Promise<void>(() => {}); // never resolves; Ctrl+C ends it
  }

  /**
   * Keeps listening for `seconds` and returns anything the bot says.
   *
   * Needed after "Your report has been received! Please wait." — the provider
   * reviews asynchronously (64 min) and the credentials may arrive after the
   * confirm, not with the 2FA key. Disconnecting on the confirm alone missed
   * them.
   */
  listen(seconds: number): Promise<string[]> {
    const got: string[] = [];
    tlog.info(`Listening ${seconds}s for anything further…`);
    return new Promise((resolve) => {
      const handler = (update: Api.Update) => {
        const { text, msg } = textFrom(update);
        if (!msg || !text || msg.out) return;
        if (!this.isFromPeer(msg.peerId)) {
          audit({ leg: "taskly->bot", what: "listen", text, from: this.peerKey(msg.peerId), note: "other-chat" });
          tlog.raw(`  <- [other chat] ${preview(text)}`);
          return;
        }
        got.push(text);
        this.window.push(msg);
        audit({ leg: "taskly->bot", what: "listen", text, buttons: this.labels() });
        tlog.raw(`  <- ${preview(text)}`);
      };
      this.client.addEventHandler(handler);
      setTimeout(() => {
        this.client.removeEventHandler(handler);
        resolve(got);
      }, seconds * 1000);
    });
  }

  /**
   * Waits until at least THROTTLE_MS has passed since the previous send.
   *
   * The provider is a bot with its own modal state, and firing presses at it
   * back to back is how a screen gets half-updated and a label gets read
   * against the wrong keyboard.
   */
  private async throttle() {
    const since = Date.now() - this.lastSend;
    if (since < THROTTLE_MS) {
      await new Promise((r) => setTimeout(r, THROTTLE_MS - since));
    }
    this.lastSend = Date.now();
  }

  /**
   * Last N messages from the provider, newest first, incoming only.
   *
   * This is the reliable way to read a reply. The live update handler proved
   * unreliable for multi-part replies: after Start the bot sends the
   * credentials and the 2FA prompt in the same second, and the credentials
   * were being dropped. History has them every time. context.md says history
   * returns nothing for this peer, but that was measured through gotd - GramJS
   * reads it fine.
   */
  async recent(limit = 8): Promise<string[]> {
    const msgs = await this.client.getMessages(this.peer, { limit });
    const rows: any[] = Array.isArray(msgs) ? msgs : [...(msgs as any)];
    return rows
      .filter((m) => !m.out)
      .map((m) => String(m.message ?? ""))
      .filter(Boolean)
      .reverse(); // oldest first, so parseCreds sees them in order
  }

  /** Id of the newest message, used to mark where "now" is. */
  async latestId(): Promise<number> {
    const msgs = await this.client.getMessages(this.peer, { limit: 1 });
    const rows: any[] = Array.isArray(msgs) ? msgs : [...(msgs as any)];
    return Number(rows[0]?.id ?? 0);
  }

  /**
   * Incoming messages newer than `afterId`, oldest first.
   *
   * MUST be used instead of recent() when reading a reply to something we just
   * sent. An unscoped recent() will happily return a credential the bot issued
   * on an earlier, abandoned run of the same job - which is exactly what
   * happened on row 5, where a leftover name was taken for the live one and the
   * account's password was set from it.
   */
  async freshSince(afterId: number, limit = 8): Promise<string[]> {
    const msgs = await this.client.getMessages(this.peer, { limit: limit * 2 });
    const rows: any[] = Array.isArray(msgs) ? msgs : [...(msgs as any)];
    return rows
      .filter((m) => !m.out && Number(m.id) > afterId)
      .map((m) => String(m.message ?? ""))
      .filter(Boolean)
      .reverse();
  }

  /** Sends text verbatim. Only for commands and free text, never a label. */
  async sendRaw(what: string, text: string) {
    // Recorded in full: without it the flow cannot be replayed or debugged.
    audit({ leg: "bot->taskly", what, text, chars: text.length });
    await this.throttle();
    tlog.info(`${what}: sending ${text.length} chars`);
    // GramJS v2 takes an options object, not a bare string.
    return this.exchange(what, () => this.client.sendMessage(this.peer, { message: text }));
  }

  /** Sends the WHOLE on-screen label containing `want`. Refuses if none match. */
  async press(what: string, want: string) {
    const full = this.resolveLabel(want);
    if (!full) {
      audit({ leg: "internal", what, error: "no-match", want, onScreen: this.labels() });
      throw new Error(
        `no button matches "${want}"; on screen: ${this.labels().join(" | ") || "(nothing)"}`,
      );
    }
    audit({ leg: "bot->taskly", what, text: full, pressed: want });
    await this.throttle();
    tlog.info(`${what}: press "${full}"`);
    return this.exchange(what, () => this.client.sendMessage(this.peer, { message: full }));
  }

  /** Sends, then collects replies until the bot has been silent 500ms. */
  private async exchange(what: string, send: () => Promise<any>) {
    const got: string[] = [];
    let idle: any;
    let hard: any;
    let done: () => void;
    const finished = new Promise<void>((r) => (done = r));

    // Registered BEFORE the send, so a reply cannot arrive unobserved.
    const handler = (update: Api.Update) => {
      const { text, msg } = textFrom(update);
      const cls = update?.constructor?.name ?? "?";
      if (!msg || !text) {
        tlog.raw(`  (ignored ${cls})`);
        return;
      }
      // Telegram echoes our own outgoing messages back to us. Without this the
      // script records its own presses as if the bot had sent them.
      if (msg.out) return;
      if (!this.isFromPeer(msg.peerId)) {
        audit({ leg: "taskly->bot", what, text, from: this.peerKey(msg.peerId), note: "other-chat" });
        tlog.raw(`  <- [other chat] ${preview(text)}`);
        return;
      }
      got.push(text);
      this.window.push(msg);
      if (this.window.length > 12) this.window.shift();
      audit({ leg: "taskly->bot", what, text, chars: text.length, buttons: this.labels(), via: cls });
      tlog.raw(`  <- ${preview(text)}`);
      clearTimeout(idle);
      idle = setTimeout(done, QUIET_MS);
    };
    this.client.addEventHandler(handler);

    try {
      await send();
      hard = setTimeout(done, HARD_MS);
      await finished;
    } finally {
      clearTimeout(idle);
      clearTimeout(hard);
      this.client.removeEventHandler(handler);
    }

    // Replies are printed live in the handler, as they arrive. Do not print
    // them again here or every message appears twice.
    return got;
  }

  /** Full labels on the newest keyboard, newest first. */
  private labels(): string[] {
    const out: string[] = [];
    for (let i = this.window.length - 1; i >= 0; i--) {
      const m: any = this.window[i];
      const rows = m?.replyMarkup?.rows ?? [];
      for (const row of rows) {
        for (const b of row?.buttons ?? []) {
          const t = b?.text ?? b?.label;
          if (t && !out.includes(t)) out.push(t);
        }
      }
    }
    return out;
  }

  /** Whole label of the newest button containing `want`. */
  resolveLabel(want: string): string | null {
    const q = want.trim().toLowerCase();
    const all = this.labels();
    return all.find((l) => l.toLowerCase().includes(q)) ?? null;
  }

  /** Every label on the current keyboard, for the --probe readout. */
  screenLabels(): string[] {
    return this.labels();
  }

  hasButton(want: string): boolean {
    return !!this.resolveLabel(want);
  }

  /**
   * Proves we are on the main menu. Once a job is started the provider sits in
   * a modal state where menu labels are read as cancel, so this clears with
   * Cancel when Balance is missing. /start re-sends the welcome and resets.
   */
  async ensureMainMenu(): Promise<void> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const replies = await this.sendRaw("knock", "/start");
      void replies;
      if (this.hasButton("Balance")) return;
      tlog.err(`attempt ${attempt}: not on the main menu, clearing provider state`);
      if (!this.hasButton("Cancel")) {
        throw new Error("provider is not on the main menu and offers no Cancel");
      }
      await this.press("clear state", "Cancel");
    }
    throw new Error("could not return to the main menu after 3 attempts");
  }
}

// Standalone: bun TG.ts <phone>   |   bun TG.ts --list   |   bun TG.ts --watch [-p phone]
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const flag = (name: string) => {
    const i = args.indexOf(name);
    return i === -1 ? undefined : args[i + 1];
  };
  if (args.includes("--list")) {
    const have = listSessions();
    console.log(have.length ? `Sessions: ${have.join(", ")}` : "No sessions yet.");
  } else if (args.includes("--watch")) {
    const t = await Taskly.open({ phone: flag("-p") });
    await t.watch();
  } else {
    const t = await Taskly.open({ phone: args[0] });
    tlog.ok(`Login OK for ${args[0] ?? process.env.TG_PHONE ?? listSessions().join(",")}`);
    await t.close();
  }
}
