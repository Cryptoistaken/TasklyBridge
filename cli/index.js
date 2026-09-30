// cli/index.js — entry: arg parsing, dispatch, one error handler.
// dotenv loads BEFORE any engine module evaluates: index.js reads data/.env
// at import time and dotenv never overrides, so the CLI's own file is loaded
// first and its values win. Everything below is dynamically imported for
// exactly that reason.
const { config } = await import("dotenv");
config({ path: new URL("../data/cli/.env", import.meta.url) });

const store = await import("./store.js");
const render = await import("./render.js");
const sessions = await import("./sessions.js");
const submit = await import("./submit.js");
const balance = await import("./balance.js");
const reconcile = await import("./reconcile.js");
const lock = await import("./lock.js");
const engine = await import("../index.js");
const { EXIT } = await import("./exit.js");

const base = (p) => String(p ?? "").split(/[\\/]/).pop();

export function parseArgs(argv) {
  const a = [...(argv ?? [])];
  const has = (...ns) => ns.some((n) => a.includes(n));
  const val = (...names) => {
    for (const n of names) {
      const eq = a.find((x) => typeof x === "string" && x.startsWith(n + "="));
      if (eq !== undefined) return eq.slice(n.length + 1);
      const i = a.indexOf(n);
      if (i !== -1 && a[i + 1] !== undefined && !String(a[i + 1]).startsWith("-")) return a[i + 1];
    }
    return undefined;
  };
  const vals = (name) => {
    const out = [];
    for (let i = 0; i < a.length; i++) {
      if (a[i] === name) {
        while (a[i + 1] !== undefined && !String(a[i + 1]).startsWith("-")) {
          out.push(...String(a[++i]).split(",").map((x) => x.trim()).filter(Boolean));
        }
      } else if (typeof a[i] === "string" && a[i].startsWith(name + "=")) {
        out.push(...a[i].slice(name.length + 1).split(",").map((x) => x.trim()).filter(Boolean));
      }
    }
    return out;
  };
  const positionalsAfter = (flag, n) => {
    const i = a.indexOf(flag);
    if (i === -1) return [];
    const out = [];
    for (let j = i + 1; j < a.length && out.length < n; j++) {
      if (String(a[j]).startsWith("-")) break;
      out.push(a[j]);
    }
    return out;
  };
  const o = {
    help: has("--help", "-h"),
    debug: has("--debug"),
    register: val("--register"),
    users: has("--users"),
    user: val("--user"),
    files: vals("--file"),
    row: val("--row"),
    thread: val("--thread") ?? "1",
    balance: has("--balance"),
    refresh: has("--refresh"),
    sessions: has("--sessions"),
    queue: has("--queue"),
    report: has("--report"),
    reconcile: has("--reconcile"),
    allowMidRun: has("--allow-mid-run"),
    pages: Number(val("--pages") ?? 50) || 50,
    method: val("--method") ?? null,
    ref: val("--ref") ?? null,
    note: val("--note") ?? null,
    to: val("--to"),
  };
  const payArgs = positionalsAfter("--pay", 2);
  o.pay = has("--pay") ? { handle: payArgs[0], bkt: payArgs[1] } : null;
  const trArgs = positionalsAfter("--transfer", 1);
  o.transfer = has("--transfer") ? { uid: trArgs[0], to: o.to } : null;
  if (has("--register")) o.command = "register";
  else if (o.users) o.command = "users";
  else if (o.user) o.command = "submit";
  else if (o.balance) o.command = "balance";
  else if (o.sessions) o.command = "sessions";
  else if (o.queue) o.command = "queue";
  else if (has("--pay")) o.command = "pay";
  else if (o.report) o.command = "report";
  else if (o.reconcile) o.command = "reconcile";
  else if (has("--transfer")) o.command = "transfer";
  else o.command = null;
  if (o.thread !== "max") o.thread = Math.max(1, Number(o.thread) || 1);
  if (o.row !== undefined) o.row = Number(o.row);
  return o;
}

const HELP = `cli — per-user submits against auto-chosen Telegram sessions
USAGE
  bun cli/index.js --register <handle>
  bun cli/index.js --user <handle> --file <sheet> [--file <sheet>] [--row <n>] [--thread max|<n>]
  bun cli/index.js --transfer <uid> --to <handle>
  bun cli/index.js --balance [--refresh] | --sessions | --queue | --users | --report | --reconcile
  bun cli/index.js --pay <handle> <bkt> [--method m] [--ref r] [--note t]
OPTIONS
  --debug          detailed row-level output
  --allow-mid-run  let --refresh/--reconcile run while a submit holds sessions
  --help           this text`;

const usage = (toStderr) => (toStderr ? console.error(HELP) : console.log(HELP));
const findUser = (s, handle) =>
  store.listUsers(s).find((u) => u.handle === String(handle ?? "").trim().replace(/^@+/, "").toLowerCase()) ?? null;

// History reads and balance reads are Telegram traffic on the same chat, so
// they refuse while a submit holds sessions — unless explicitly overridden.
const midRunGuard = () => {
  const live = lock.liveHolders();
  if (live.length) {
    throw Object.assign(new Error(`refusing: a submit holds ${live.map((h) => `...${h.phone.slice(-4)}`).join(", ")} — pass --allow-mid-run to force`),
      { exitCode: EXIT.FAILURE });
  }
};

const printEvent = (e) => {
  if (e.locked) {
    console.log(`session ...${String(e.session).slice(-4)} is held by pid ${lock.holder(e.session) ?? "?"} — each session runs one worker`);
    return;
  }
  const d = e.done[e.done.length - 1];
  if (!d) return;
  console.log(`${base(e.source)}:${e.row}  ${e.done.length}/7 ${d.label} … ${d.detail}  ${d.status === "fail" ? "FAIL" : "ok"}`);
};

async function cmdSubmit(s, o) {
  const u = findUser(s, o.user);
  if (!u) {
    console.error(`unknown user @${o.user} — register first: bun cli/index.js --register ${o.user}`);
    return EXIT.USAGE;
  }
  if (!o.files.length) {
    console.error("no sheets given — pass --file <sheet> (repeatable)");
    return EXIT.USAGE;
  }
  let exitHint = EXIT.OK;
  for (const file of o.files) {
    let accounts;
    try {
      accounts = engine.readAccounts(file);
    } catch (e) {
      console.error(`${base(file)}: ${e?.message ?? e}`);
      exitHint = EXIT.FAILURE;
      continue;
    }
    const wanted = o.row !== undefined && !Number.isNaN(o.row) ? accounts.filter((x) => x.row === o.row) : accounts;
    if (!wanted.length) {
      console.error(`${base(file)}: no rows${o.row !== undefined ? ` matching --row ${o.row}` : ""}`);
      exitHint = EXIT.FAILURE;
      continue;
    }
    const r = store.enqueue(s, wanted.map((x) => ({ uid: engine.uidOf(x.cookie), source: file, row_no: x.row })), u.id);
    console.log(`${base(file)}: enqueued ${r.added}, duplicates ${r.duplicates.length}, invalid ${r.invalid.length}`);
    for (const d of [...r.duplicates, ...r.invalid]) {
      const who = d.owner ? `owned by @${d.owner} (${base(d.ownerSource ?? "")}:${d.ownerRow ?? "?"} ${d.status ?? ""})` : (d.where === "sold_guard" ? "already sold" : "no c_user");
      console.error(`DUPLICATE ***${String(d.uid ?? "").slice(-4)} ${base(d.source ?? file)}:${d.row_no ?? "?"} — ${who}`);
    }
    if (r.duplicates.length || r.invalid.length) exitHint = EXIT.USAGE;
  }
  sessions.prepare();
  sessions.seed(s, sessions.prepare());
  let result;
  try {
    result = await submit.run({ s, threads: o.thread, debug: o.debug, onStep: printEvent });
  } catch (e) {
    console.error(e?.message ?? e);
    return e?.exitCode ?? EXIT.FAILURE;
  }
  if (result.fatal) {
    console.error(result.fatal);
    return EXIT.FAILURE;
  }
  if (result.rateLimited) {
    console.error("STOPPED: the provider rate-limited us. Re-run the same command after the wait — completed rows are skipped automatically.");
    return EXIT.RATE_LIMITED;
  }
  const left = store.totals(s).queued;
  console.log(render.summary({ sent: result.sent, failed: result.failed, left, eta: "—" }).replace(/\x1b\[[0-9;]*m/g, ""));
  return result.failed ? EXIT.FAILURE : exitHint;
}

async function cmdBalance(s, o) {
  if (o.refresh) {
    midRunGuard();
    for (const row of store.sessionState(s)) {
      const tg = await engine.Taskly.open({ phone: row.phone, verdictSink: "none" });
      try {
        const usd = await engine.readProviderBalance(tg);
        if (usd != null) store.setSession(s, { phone: row.phone, balance_usd: usd });
      } finally {
        await tg.close().catch(() => {});
      }
    }
  }
  const rate = await engine.fetchRate().catch(() => null);
  const data = balance.report(s, { rate: rate?.rate ?? null, priceUsd: engine.settledPriceUsd() });
  const sessRows = data.sessions.map((x) => [
    `...${x.phone.slice(-4)}`, x.enabled ? "ok" : "off",
    x.usd == null ? "?" : x.usd.toFixed(4), x.bkt == null ? "?" : x.bkt.toFixed(2),
    x.limitedUntil ?? "—"]);
  console.log("PROVIDER BALANCE");
  console.log(render.table(["session", "status", "usd", "bkt", "limited until"], sessRows));
  console.log(`TOTAL ${data.totalBalanceUsd.toFixed(4)} usd = ${data.totalBalanceBkt.toFixed(2)} bkt`);
  const userRows = data.users.map((x) => [x.handle, x.submitted, x.approved, x.rejected,
    x.owed == null ? "?" : x.owed.toFixed(2), x.paid.toFixed(2), x.unpaid == null ? "?" : x.unpaid.toFixed(2)]);
  console.log("USER POSITIONS");
  console.log(render.table(["user", "submitted", "approved", "rejected", "owed", "paid", "unpaid"], userRows));
  if (data.cut) {
    console.log(`OUR CUT  revenue ${data.cut.revenue.toFixed(2)} bkt, owed ${data.cut.owed.toFixed(2)}, ours ${data.cut.ours.toFixed(2)} (${data.cut.pct.toFixed(1)}%, target 19.0%)`);
  } else {
    console.log("OUR CUT  unknown — no rate or price");
  }
  if (data.warning) console.log("WARNING: balance is LESS than what is owed — top up before the next run");
  return EXIT.OK;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.debug) process.env.TOOL_DEBUG = "1";
  if (o.help) {
    usage(false);
    return EXIT.OK;
  }
  if (!o.command) {
    usage(true);
    return EXIT.USAGE;
  }
  const s = store.open();
  store.migrate(s);
  try {
    switch (o.command) {
      case "register": {
        try {
          const u = store.registerUser(s, o.register);
          console.log(`registered @${u.handle}`);
          return EXIT.OK;
        } catch (e) {
          console.error(e?.message ?? e);
          return EXIT.FAILURE;
        }
      }
      case "users": {
        for (const u of store.listUsers(s)) {
          const c = store.userCounts(s, u.id);
          const submitted = (c.inflight ?? 0) + (c.approved ?? 0) + (c.rejected ?? 0) + (c["half-used"] ?? 0);
          console.log(`@${u.handle}  queued ${c.queued ?? 0}  submitted ${submitted}  approved ${c.approved ?? 0}  rejected ${c.rejected ?? 0}  paid ${store.paidFor(s, u.id).total.toFixed(2)}`);
        }
        return EXIT.OK;
      }
      case "submit":
        return await cmdSubmit(s, o);
      case "balance":
        return await cmdBalance(s, o);
      case "sessions": {
        console.log(render.table(["session", "label", "on", "usd", "limited until", "lock"],
          store.sessionState(s).map((r) => {
            const pid = lock.holder(r.phone);
            return [`...${r.phone.slice(-4)}`, r.label ?? "—", r.enabled ? "yes" : "no",
              r.balance_usd == null ? "?" : Number(r.balance_usd).toFixed(4),
              r.rate_limit_until ?? "—", pid == null ? "—" : `held by ${pid}`];
          })));
        return EXIT.OK;
      }
      case "queue": {
        const t = store.totals(s);
        console.log(`queued ${t.queued}  claimed ${t.claimed}  inflight ${t.inflight}  approved ${t.approved}  rejected ${t.rejected}  dead ${t.dead}  gated ${t.gated}  half-used ${t["half-used"]}`);
        console.log(render.table(["uid", "user", "source:row", "status", "worker"],
          store.queueDetail(s).map((r) => [`***${r.uid.slice(-4)}`, `@${r.handle}`,
            `${base(r.source)}:${r.row_no}`, r.status, r.claimed_by ?? r.taskly_session ?? "—"])));
        return EXIT.OK;
      }
      case "pay": {
        if (!o.pay?.handle || o.pay?.bkt == null) {
          console.error("usage: --pay <handle> <bkt> [--method m] [--ref r] [--note t]");
          return EXIT.USAGE;
        }
        const u = findUser(s, o.pay.handle);
        if (!u) {
          console.error(`unknown user @${o.pay.handle}`);
          return EXIT.FAILURE;
        }
        try {
          const rec = store.recordPayment(s, { userId: u.id, amount_bkt: Number(o.pay.bkt),
            method: o.method, reference: o.ref, note: o.note });
          console.log(`Recorded payment #${rec.id}: @${u.handle} ${rec.amount_bkt} bkt${o.method ? ` via ${o.method}` : ""} — recorded, never edited.`);
          return EXIT.OK;
        } catch (e) {
          console.error(e?.message ?? e);
          return EXIT.FAILURE;
        }
      }
      case "report": {
        const rate = await engine.fetchRate().catch(() => null);
        const price = engine.settledPriceUsd();
        const total = rate?.rate && price ? price * rate.rate : null;
        console.log(render.table(["user", "submitted", "approved", "rejected", "owed", "paid"],
          store.listUsers(s).map((u) => {
            const c = store.userCounts(s, u.id);
            const submitted = (c.inflight ?? 0) + (c.approved ?? 0) + (c.rejected ?? 0) + (c["half-used"] ?? 0);
            const m = total == null ? null : store.owedFor(s, u.id, total);
            return [`@${u.handle}`, submitted, c.approved ?? 0, c.rejected ?? 0,
              m == null ? "?" : m.owed.toFixed(2), (m?.paid ?? store.paidFor(s, u.id).total).toFixed(2)];
          })));
        if (total == null) console.log("no rate or price — owed unknown");
        return EXIT.OK;
      }
      case "reconcile": {
        midRunGuard();
        const phones = store.sessionState(s).map((r) => r.phone);
        if (!phones.length) {
          console.error("no sessions registered — run a submit once so the registry seeds");
          return EXIT.FAILURE;
        }
        const out = await reconcile.run(s, phones, { pages: o.pages });
        for (const r of out) {
          console.log(`...${r.phone.slice(-4)}: approved ${r.found.approved}, rejected ${r.found.rejected} in chat — matched ${r.matched}, surplus ${r.surplus}`);
        }
        return EXIT.OK;
      }
      case "transfer": {
        if (!o.transfer?.uid || !o.transfer?.to) {
          console.error("usage: --transfer <uid> --to <handle>");
          return EXIT.USAGE;
        }
        const to = findUser(s, o.transfer.to);
        if (!to) {
          console.error(`unknown user @${o.transfer.to}`);
          return EXIT.FAILURE;
        }
        try {
          store.transferRow(s, o.transfer.uid, to.id);
          console.log(`moved ***${o.transfer.uid.slice(-4)} to @${to.handle}`);
          return EXIT.OK;
        } catch (e) {
          console.error(e?.message ?? e);
          return EXIT.FAILURE;
        }
      }
      default:
        usage(true);
        return EXIT.USAGE;
    }
  } finally {
    s.close();
  }
}

if (import.meta.main) {
  main().then((code) => process.exit(code)).catch((e) => {
    console.error(`ERROR ${e?.message ?? e}`);
    process.exit(e?.exitCode ?? EXIT.FAILURE);
  });
}
