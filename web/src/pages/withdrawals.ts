// Withdrawals — four steps, because this is the one screen that moves money:
// balances, preview, confirm, live progress.
//
// Two rules shape every line here. The provider deducts the fee from the
// amount, so `net` is only ever rendered as the server returned it — never
// recomputed on this side. And `created` means the provider accepted the
// request, which is not the money arriving, so no wording here may imply it.

import {
  ApiError,
  get,
  post,
  type List,
  type SessionList,
  type Settings,
  type Terms,
  type Withdrawal,
} from "../api";
import {
  dot,
  emptyRow,
  errorMessage,
  h,
  pageHead,
  section,
  statRow,
  subRow,
  table,
  td,
  usd,
  when,
  wrapTable,
  type Child,
  type Page,
} from "../ui";

// The shapes below mirror docs/api.md's POST /api/withdrawals section. They
// live here rather than in ../api so this page's contract changes stay local.
interface PreviewLine {
  account_id: string;
  phone: string;
  balance: number;
  amount: number;
  fee: number;
  net: number;
  problem?: string;
}

interface PreviewTotals {
  accounts: number;
  total_balance: number;
  total_amount: number;
  total_fee: number;
  total_net: number;
  known_balance: boolean;
}

interface PreviewData {
  wallet: string;
  method: string;
  network: string;
  fee: number;
  minimum: number;
  lines: PreviewLine[];
  totals: PreviewTotals;
  warnings: string[];
}

interface ExecuteResult {
  account_id: string;
  phone: string;
  amount: number;
  fee: number;
  net: number;
  status: string;
  detail?: string;
}

interface ExecuteResponse {
  results: ExecuteResult[];
  totals: { amount: number; fee: number; net: number };
  note: string;
}

interface Progress {
  step: string;
  state: string;
  account?: string;
  phone?: string;
  amount?: number;
  fee?: number;
  net?: number;
  detail?: string;
}

interface Row {
  id: string;
  phone: string;
  state: string;
  inUse: boolean;
  balance: number;
  balanceKnown: boolean;
}

const COLUMNS = 7;
// A confirm that moves money gets the same two-step arm as the session
// delete: a fast double-click must land as one action, not two.
const ARM_DELAY = 750;

type Stage = "select" | "amounts" | "running" | "result";

let view: HTMLElement | null = null;
// Amount inputs survive repaints by living outside the paint() rebuild: an
// edit only rewrites this slot, so focus is never stolen mid-typing.
let previewSlot: HTMLElement | null = null;

let rows: Row[] = [];
// The server's own count and total: rendered as sent, never recomputed here.
let totalBalance = 0;
let balanceKnown = true;
let selected: string[] = [];
let amounts: Record<string, string> = {};
let terms: Terms | null = null;
let wallet = "";
let dryRun = false;
let items: Withdrawal[] = [];

let stage: Stage = "select";
let preview: PreviewData | null = null;
let result: ExecuteResponse | null = null;
let err = "";
let progressErr = "";
let armed = false;
let armedAt = 0;
let busy = false;

let runStart: Progress | null = null;
let runRows: Record<string, Progress> = {};
let runDone: Progress | null = null;
// Bumped on dispose so an in-flight confirm from an earlier visit cannot
// write its result into this one.
let runToken = 0;

// --- pieces -----------------------------------------------------------------

function kv(pairs: [string, Child][]): HTMLElement {
  return h("dl", { class: "kv" }, ...pairs.flatMap(([k, v]) => [h("dt", { text: k }), h("dd", {}, v)]));
}

function stateChip(s: string): HTMLElement {
  const tone =
    s === "banned" || s === "dead" || s === "failed"
      ? "bad"
      : s === "degraded" || s === "running" || s === "skipped" || s === "waiting" || s === "done"
        ? "muted"
        : "ok";
  return h("span", { class: "chip" + (tone === "ok" ? "" : " " + tone) }, dot(tone), s);
}

/** `created` is never left standing on its own: the caption is the point. */
function statusCell(status: string): HTMLElement {
  return h(
    "div",
    {},
    stateChip(status),
    status === "created"
      ? h("p", { class: "result-caption", text: "provider accepted; arrival not confirmed" })
      : status === "failed"
        ? h("p", { class: "result-caption warn", text: "the provider refused this" })
        : null,
  );
}

const detailRow = (span: number, label: string, text: string): HTMLTableRowElement =>
  subRow(
    span,
    h("div", {}, h("span", { class: "label", text: label }), h("div", { class: "confirmation", text })),
  );

/** An unknown balance is "unread", never a confident $0.0000. */
const balanceCell = (n: number, known: boolean): HTMLElement =>
  known ? h("span", { class: "mono" }, usd(n)) : h("span", { class: "mono muted" }, "unread");

const rowOf = (id: string): Row | undefined => rows.find((r) => r.id === id);

function requestBody(confirm: boolean): {
  account_ids: string[];
  wallet: string;
  amounts: Record<string, number>;
  confirm: boolean;
} {
  const amt: Record<string, number> = {};
  for (const id of selected) {
    const n = Number(amounts[id]);
    if (Number.isFinite(n) && n > 0) amt[id] = n;
  }
  // The wallet is sent explicitly so the address previewed is the address
  // that runs, even if settings change between the two calls.
  return { account_ids: [...selected], wallet, amounts: amt, confirm };
}

// --- step 1: balances -------------------------------------------------------

function step1Row(r: Row): HTMLTableRowElement {
  return h(
    "tr",
    {},
    td(h("input", { type: "checkbox", checked: selected.includes(r.id), onchange: (e: Event) => toggle(r.id, e) })),
    td(r.id, "mono nowrap"),
    td(r.phone || "—", "mono nowrap"),
    td(stateChip(r.state)),
    td(r.inUse ? h("span", { class: "chip" }, dot("ok"), "in use") : h("span", { class: "muted" }, "—")),
    td(balanceCell(r.balance, r.balanceKnown), "num"),
  );
}

function step1(): HTMLElement {
  return section(
    "Step 1 · balances",
    statRow([
      { label: "Accounts", value: String(rows.length), sub: "with a stored session" },
      { label: "Selected", value: String(selected.length) },
      {
        label: "Total balance",
        value: usd(totalBalance),
        bad: !balanceKnown,
        sub: balanceKnown ? "as the server reported it" : "incomplete — at least one balance is unread",
      },
    ]),
    wrapTable(
      table(
        [
          { label: "" },
          { label: "Account" },
          { label: "Phone" },
          { label: "State" },
          { label: "In use" },
          { label: "Balance", num: true },
        ],
        rows.length ? rows.map(step1Row) : [emptyRow(6, "No sessions stored — create one on the Sessions page.")],
      ),
    ),
    h(
      "div",
      { class: "row", style: "margin-top:14px" },
      stage === "select"
        ? h("button", {
            class: "btn primary",
            type: "button",
            text: selected.length ? `Continue with ${selected.length} account(s)` : "Select at least one account",
            disabled: selected.length === 0,
            onclick: goAmounts,
          })
        : h("button", { class: "btn", type: "button", text: "Back to the account list", onclick: goSelect }),
    ),
  );
}

function toggle(id: string, e: Event): void {
  const on = (e.target as HTMLInputElement).checked;
  selected = on ? [...selected, id] : selected.filter((x) => x !== id);
  preview = null; // the selection changed, so the numbers on screen no longer describe it
  armed = false;
  paint();
}

function goAmounts(): void {
  if (!selected.length) return;
  stage = "amounts";
  paint();
}

function goSelect(): void {
  stage = "select";
  preview = null;
  armed = false;
  err = "";
  paint();
}

// --- step 2: amounts, preview ----------------------------------------------

function amountRow(id: string): HTMLTableRowElement {
  const r = rowOf(id);
  return h(
    "tr",
    {},
    td(id, "mono nowrap"),
    td(r?.phone || "—", "mono nowrap"),
    td(r ? balanceCell(r.balance, r.balanceKnown) : balanceCell(0, false), "num"),
    td(
      h("input", {
        class: "input",
        type: "number",
        step: "0.0001",
        min: "0",
        inputmode: "decimal",
        placeholder: "0.0000",
        value: amounts[id] ?? "",
        oninput: (e: Event) => onAmount(id, e),
      }),
      "num",
    ),
  );
}

function onAmount(id: string, e: Event): void {
  amounts[id] = (e.target as HTMLInputElement).value;
  if (preview) {
    preview = null;
    armed = false;
    previewSlot?.replaceChildren(
      h("p", {
        class: "notice bad",
        style: "margin-top:14px",
        text: "An amount changed, so the preview no longer describes it. Run the preview again — the numbers you approve are the numbers that run.",
      }),
    );
  }
}

function previewCard(p: PreviewData): HTMLElement {
  const refused = p.lines.some((l) => l.problem);
  return h(
    "div",
    { class: "card preview-box", style: "margin-top:14px" },
    h("div", { class: "label", text: "Preview · dry run · nothing was sent" }),
    h(
      "div",
      { class: "stack", style: "margin-top:12px" },
      h("div", { class: "label", text: "Destination · in full, because a wrong address is unrecoverable" }),
      h("div", { class: "wallet", text: p.wallet || "not configured" }),
    ),
    h("p", {
      class: "notice",
      style: "margin-top:12px",
      text: `The money moves as ${p.method} on the ${p.network} network. This is a ${p.network} address, not a Tron (TRC-20) address: USDT held on Tron cannot be sent to it, so be sure this is the address you intend.`,
    }),
    h(
      "div",
      { style: "margin-top:12px" },
      kv([
        ["Method", p.method],
        ["Network", p.network],
        ["Fee per account", usd(p.fee)],
        ["Minimum", usd(p.minimum)],
      ]),
    ),
    h("div", { class: "label", style: "margin-top:16px", text: "One row per account" }),
    wrapTable(
      table(
        [
          { label: "Account" },
          { label: "Balance", num: true },
          { label: "Amount", num: true },
          { label: "Fee", num: true },
          { label: "Net", num: true },
          { label: "Problem" },
        ],
        p.lines.map((l) =>
          h(
            "tr",
            {},
            td(h("div", {}, h("div", { class: "mono", text: l.account_id }), h("div", { class: "mono muted small", text: l.phone }))),
            td(l.balance > 0 ? usd(l.balance) : h("span", { class: "muted" }, "unread"), "num mono"),
            td(usd(l.amount), "num mono"),
            td(usd(l.fee), "num mono muted"),
            td(usd(l.net), "num mono"),
            td(
              l.problem ? h("span", { class: "warn", text: l.problem }) : h("span", { class: "muted", text: "none" }),
              "small",
            ),
          ),
        ),
      ),
    ),
    h(
      "div",
      { style: "margin-top:16px" },
      h("div", { class: "label", text: "Totals" }),
      h(
        "div",
        { style: "margin-top:8px" },
        kv([
          ["Accounts", String(p.totals.accounts)],
          ["Total balance", usd(p.totals.total_balance)],
          ["Total amount", usd(p.totals.total_amount)],
          ["Total fee", usd(p.totals.total_fee)],
          ["Total net", usd(p.totals.total_net)],
        ]),
      ),
      p.totals.known_balance
        ? null
        : h("p", {
            class: "notice bad",
            style: "margin-top:10px",
            text: "At least one balance could not be read, so these totals are incomplete — not a final figure.",
          }),
      refused
        ? h("p", {
            class: "notice",
            style: "margin-top:10px",
            text: "A refused line contributes nothing to these totals; the server has already excluded it.",
          })
        : null,
    ),
    p.warnings.length
      ? h(
          "div",
          { style: "margin-top:14px" },
          h("div", { class: "label", text: "Warnings · verbatim" }),
          h("ul", { class: "warning-list", style: "margin-top:8px" }, ...p.warnings.map((w) => h("li", { text: w }))),
        )
      : null,
  );
}

function confirmCard(p: PreviewData): HTMLElement {
  return h(
    "div",
    { class: "card", style: "margin-top:12px" },
    h("div", { class: "label", text: "Step 3 · confirm and run" }),
    h(
      "div",
      { style: "margin-top:10px" },
      kv([
        ["Accounts", String(p.totals.accounts)],
        ["Total net", usd(p.totals.total_net)],
        ["Total fee", usd(p.totals.total_fee)],
        ["Destination", h("div", { class: "wallet", text: p.wallet || "not configured" })],
      ]),
    ),
    h("p", {
      class: "notice bad",
      style: "margin-top:10px",
      text: "The fee is deducted from each amount, not added to it. There is no confirmation step on the provider's side: running this IS the withdrawal.",
    }),
    dryRun
      ? h("p", {
          class: "notice bad",
          style: "margin-top:10px",
          text: "WITHDRAW_DRY_RUN is on. The backend refuses the run with 409 and sends nothing.",
        })
      : null,
    h(
      "div",
      { class: "row", style: "margin-top:12px" },
      h("button", {
        class: "btn danger",
        type: "button",
        text: armed ? "Confirm — run it now" : "Run the withdrawal",
        disabled: busy,
        onclick: () => void execute(),
      }),
    ),
    armed
      ? h("p", {
          class: "notice bad",
          style: "margin-top:10px",
          text: "Armed. One more click runs it — check the net total and the destination above first.",
        })
      : null,
  );
}

function fillPreview(): void {
  if (!previewSlot) return;
  const kids: HTMLElement[] = [];
  if (preview) kids.push(previewCard(preview), confirmCard(preview));
  previewSlot.replaceChildren(...kids);
}

function step2(): HTMLElement {
  previewSlot = h("div", {});
  fillPreview();
  return section(
    "Step 2 · amounts, then preview",
    h(
      "div",
      { class: "card" },
      h("div", { class: "label", text: "Amount per selected account" }),
      terms
        ? h("p", {
            class: "notice",
            style: "margin-top:10px",
            text: `Provider terms, read from the provider's message: ${terms.method} on ${terms.network}, fee ${usd(terms.fee)} deducted from every amount, minimum ${usd(terms.minimum)}.`,
          })
        : h("p", {
            class: "notice",
            style: "margin-top:10px",
            text: "Provider terms are unreachable right now. The preview still reads the fee and minimum before anything can run.",
          }),
      wrapTable(
        table(
          [
            { label: "Account" },
            { label: "Phone" },
            { label: "Balance", num: true },
            { label: "Amount (USD)", num: true },
          ],
          selected.map(amountRow),
        ),
      ),
      h(
        "div",
        { class: "row", style: "margin-top:14px" },
        h("button", { class: "btn primary", type: "button", text: "Run the preview", onclick: () => void runPreview() }),
      ),
      err ? h("p", { class: "notice bad", style: "margin-top:12px", text: err }) : null,
      previewSlot,
    ),
  );
}

async function runPreview(): Promise<void> {
  if (!selected.length) return;
  err = "";
  try {
    const r = await post<{ preview: PreviewData }>("/api/withdrawals", requestBody(false));
    preview = r.preview;
  } catch (e) {
    preview = null;
    armed = false;
    err = errorMessage(e); // a 409 arrives here as the server's own message
  }
  paint();
}

// --- step 3: confirm and run ------------------------------------------------

async function execute(): Promise<void> {
  if (busy || !preview) return;
  if (!armed) {
    armed = true;
    armedAt = Date.now();
    paint();
    return;
  }
  if (Date.now() - armedAt < ARM_DELAY) return; // a double-click is one action

  busy = true;
  armed = false;
  err = "";
  progressErr = "";
  runStart = null;
  runRows = {};
  runDone = null;
  stage = "running";
  paint();

  const mine = ++runToken;
  try {
    const r = await post<ExecuteResponse>("/api/withdrawals", requestBody(true));
    if (mine !== runToken) return;
    result = r;
    stage = "result";
    busy = false;
    paint();
    void get<List<Withdrawal>>("/api/withdrawals")
      .then((l) => {
        if (mine !== runToken) return;
        items = l.items;
        paint();
      })
      .catch(() => undefined);
  } catch (e) {
    if (mine !== runToken) return;
    busy = false;
    const status = e instanceof ApiError ? e.status : 0;
    if (status === 0) {
      // Unknown outcome: the request may have reached the server, so the live
      // rows stay on screen instead of pretending nothing started.
      stage = "running";
      progressErr = errorMessage(e);
    } else {
      // Refused before anything ran (400 validation, 409 dry-run or busy).
      // The server's message is shown as it arrived; nothing is retried.
      stage = "amounts";
      err = errorMessage(e);
    }
    paint();
  }
}

function reset(): void {
  stage = "select";
  selected = [];
  amounts = {};
  preview = null;
  result = null;
  err = "";
  progressErr = "";
  armed = false;
  busy = false;
  runStart = null;
  runRows = {};
  runDone = null;
  paint();
}

// --- step 4: live progress --------------------------------------------------

function progressRow(id: string): HTMLTableRowElement[] {
  const r = rowOf(id);
  const who = h(
    "div",
    {},
    h("div", { class: "mono", text: id }),
    h("div", { class: "mono muted small", text: r?.phone ?? "" }),
  );
  const p = runRows[id];
  if (!p) {
    return [
      h(
        "tr",
        {},
        td(who),
        td("—", "num mono muted"),
        td("—", "num mono muted"),
        td("—", "num mono muted"),
        td(stateChip("waiting")),
      ),
    ];
  }
  const cells = h(
    "tr",
    {},
    td(who),
    td(p.amount ? usd(p.amount) : "—", "num mono"),
    td(p.fee ? usd(p.fee) : "—", "num mono muted"),
    td(p.net ? usd(p.net) : "—", "num mono"),
    td(statusCell(p.state)),
  );
  return p.detail ? [cells, detailRow(5, "verbatim", p.detail)] : [cells];
}

function progressSection(): HTMLElement {
  return section(
    "Step 4 · live progress",
    progressErr ? h("p", { class: "notice bad", style: "margin-bottom:12px", text: progressErr }) : null,
    runStart
      ? h(
          "div",
          { class: "notice", style: "margin-bottom:12px" },
          h("div", { class: "label", text: "Run start · the server's wording" }),
          h("div", { class: "mono small", style: "margin-top:6px", text: runStart.detail || "" }),
        )
      : null,
    wrapTable(
      table(
        [
          { label: "Account" },
          { label: "Amount", num: true },
          { label: "Fee", num: true },
          { label: "Net", num: true },
          { label: "State" },
        ],
        selected.flatMap(progressRow),
      ),
    ),
    runDone
      ? h(
          "div",
          { class: "card", style: "margin-top:12px" },
          h("div", { class: "label", text: "Run finished · the server's summary, verbatim" }),
          h("div", { class: "confirmation", style: "margin-top:8px", text: runDone.detail || "" }),
        )
      : null,
    progressErr
      ? h(
          "div",
          { class: "row", style: "margin-top:12px" },
          h("button", {
            class: "btn",
            type: "button",
            text: "Back to the preview",
            onclick: () => {
              stage = "amounts";
              progressErr = "";
              paint();
            },
          }),
        )
      : null,
  );
}

// --- result -----------------------------------------------------------------

function resultRow(x: ExecuteResult): HTMLTableRowElement[] {
  const cells = h(
    "tr",
    {},
    td(h("div", {}, h("div", { class: "mono", text: x.account_id }), h("div", { class: "mono muted small", text: x.phone }))),
    td(usd(x.amount), "num mono"),
    td(usd(x.fee), "num mono muted"),
    td(usd(x.net), "num mono"),
    td(statusCell(x.status)),
  );
  return x.detail ? [cells, detailRow(5, "verbatim", x.detail)] : [cells];
}

function resultSection(): HTMLElement {
  const r = result;
  if (!r) return h("div", {});
  return section(
    "Result",
    h(
      "div",
      { class: "card" },
      h("div", { class: "label", text: "note · verbatim from the server" }),
      h("div", { class: "confirmation", style: "margin-top:8px", text: r.note }),
      h(
        "div",
        { style: "margin-top:14px" },
        kv([
          ["Total amount", usd(r.totals.amount)],
          ["Total fee", usd(r.totals.fee)],
          ["Total net", usd(r.totals.net)],
        ]),
      ),
      h("div", { class: "label", style: "margin-top:16px", text: "One row per account" }),
      wrapTable(
        table(
          [
            { label: "Account" },
            { label: "Amount", num: true },
            { label: "Fee", num: true },
            { label: "Net", num: true },
            { label: "Status" },
          ],
          r.results.length ? r.results.flatMap(resultRow) : [emptyRow(5, "The server returned no per-account results.")],
        ),
      ),
      h(
        "div",
        { class: "row", style: "margin-top:14px" },
        h("button", { class: "btn", type: "button", text: "Start another withdrawal", onclick: reset }),
      ),
    ),
  );
}

// --- history ----------------------------------------------------------------

function historyTable(): HTMLElement {
  return table(
    [
      { label: "When" },
      { label: "Account" },
      { label: "Amount", num: true },
      { label: "Fee", num: true },
      { label: "Net", num: true },
      { label: "Wallet" },
      { label: "Status" },
    ],
    items.length
      ? items.flatMap((w) => [
          h(
            "tr",
            { "data-id": w.id },
            td(when(w.at), "mono nowrap"),
            td(w.account_id, "mono nowrap"),
            td(usd(w.amount), "num mono"),
            td(usd(w.fee), "num mono muted"),
            td(usd(w.net), "num mono"),
            td(w.wallet, "mono nowrap"),
            td(statusCell(w.status)),
          ),
          ...(w.confirmation ? [detailRow(COLUMNS, "provider confirmation · verbatim", w.confirmation)] : []),
        ])
      : [emptyRow(COLUMNS, "No withdrawals yet.")],
  );
}

// --- page -------------------------------------------------------------------

function paint(): void {
  if (!view) return;
  previewSlot = null;
  const flow = stage === "select" || stage === "amounts";
  const kids = [
    pageHead("Withdrawals", "balances → preview → confirm → live progress · the provider never confirms arrival"),
    flow ? step1() : null,
    stage === "amounts" ? step2() : null,
    stage === "running" || stage === "result" ? progressSection() : null,
    stage === "result" ? resultSection() : null,
    section("History", wrapTable(historyTable())),
  ].filter((x): x is HTMLElement => x !== null);
  view.replaceChildren(...kids);
}

export const withdrawals: Page = {
  async mount(el) {
    view = el;
    stage = "select";
    rows = [];
    totalBalance = 0;
    balanceKnown = true;
    selected = [];
    amounts = {};
    preview = null;
    result = null;
    err = "";
    progressErr = "";
    armed = false;
    busy = false;
    runStart = null;
    runRows = {};
    runDone = null;

    const [ses, s, list] = await Promise.all([
      get<SessionList>("/api/sessions"),
      get<Settings>("/api/settings"),
      get<List<Withdrawal>>("/api/withdrawals"),
    ]);
    // The session list carries each balance and the server's own total; a
    // balance the server flags as unknown renders as "unread", never as a
    // confident $0.0000.
    rows = ses.items.map((x) => ({
      id: x.id,
      phone: x.phone,
      state: x.state,
      inUse: x.in_use,
      balance: x.balance,
      balanceKnown: x.balance_known,
    }));
    totalBalance = ses.total_balance;
    balanceKnown = ses.balance_known;
    wallet = s.withdraw_wallet;
    dryRun = s.withdraw_dry_run;
    items = list.items;
    terms = await get<Terms>("/api/withdrawals/terms").catch(() => null);
    paint();
  },

  // The one SSE connection is owned by main.ts; it hands us each withdrawal
  // frame here and stops the moment this page is disposed.
  event(type, data) {
    if (type !== "withdrawal" || !view || (stage !== "running" && stage !== "result")) return;
    const p = (data as { progress?: Progress }).progress;
    if (!p) return;
    if (p.step === "start") runStart = p;
    else if (p.step === "done") runDone = p;
    else if (p.account) runRows[p.account] = p;
    paint();
  },

  dispose() {
    runToken++;
    view = null;
    previewSlot = null;
    rows = [];
    totalBalance = 0;
    balanceKnown = true;
    selected = [];
    amounts = {};
    terms = null;
    items = [];
    stage = "select";
    preview = null;
    result = null;
    err = "";
    progressErr = "";
    armed = false;
    armedAt = 0;
    busy = false;
    runStart = null;
    runRows = {};
    runDone = null;
  },
};
