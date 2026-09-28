// Withdrawals — preview then confirm. The provider flow has no confirmation
// step at all, so the preview is the only place a mistake gets caught.

import {
  get,
  post,
  type Account,
  type List,
  type Preview,
  type Settings,
  type SseWithdrawal,
  type Terms,
  type Withdrawal,
} from "../api";
import {
  chip,
  dot,
  emptyRow,
  errorMessage,
  field,
  h,
  pageHead,
  section,
  subRow,
  table,
  td,
  usd,
  when,
  wrapTable,
  type Child,
  type Page,
} from "../ui";

const COLUMNS = 7;

let view: HTMLElement | null = null;
let historySlot: HTMLElement | null = null;
let previewSlot: HTMLElement | null = null;
let resultSlot: HTMLElement | null = null;
let accountSel: HTMLSelectElement | null = null;
let amountInput: HTMLInputElement | null = null;
let confirmBtn: HTMLButtonElement | null = null;
let staleEl: HTMLElement | null = null;

let items: Withdrawal[] = [];
let accounts: Account[] = [];
let terms: Terms | null = null;
let wallet = "";
let dryRun = false;
let preview: { key: string; amount: number; data: Preview } | null = null;

// --- rendering --------------------------------------------------------------

function kv(rows: [string, Child, boolean?][]): HTMLElement {
  return h(
    "dl",
    { class: "kv" },
    ...rows.flatMap(([k, v, bad]) => [h("dt", { text: k }), h("dd", bad ? { class: "bad" } : {}, v)]),
  );
}

function statusChip(w: Withdrawal): HTMLElement {
  if (w.status === "failed") return chip("failed", "bad");
  return h("span", { class: "chip" }, dot("ok"), "created");
}

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
            td(
              h(
                "div",
                {},
                statusChip(w),
                w.status === "created"
                  ? h("p", { class: "result-caption", text: "provider accepted; arrival not confirmed" })
                  : h("p", { class: "result-caption warn", text: "the provider refused this" }),
              ),
            ),
          ),
          ...(w.confirmation
            ? [subRow(COLUMNS, h("span", { class: "label", text: "provider confirmation · verbatim" }), h("div", { class: "confirmation", text: w.confirmation }))]
            : []),
        ])
      : [emptyRow(COLUMNS, "No withdrawals yet.")],
  );
}

function renderHistory(): void {
  historySlot?.replaceChildren(wrapTable(historyTable()));
}

function currentKey(): string {
  return `${accountSel?.value ?? ""}:${Number(amountInput?.value ?? 0)}`;
}

function refreshConfirm(): void {
  const ok = preview !== null && preview.key === currentKey();
  if (confirmBtn) confirmBtn.disabled = !ok;
  if (staleEl) staleEl.hidden = ok || preview === null;
}

function previewFailed(msg: string): void {
  preview = null;
  if (confirmBtn) confirmBtn.disabled = true;
  previewSlot?.replaceChildren(h("p", { class: "notice bad", style: "margin-top:14px", text: msg }));
}

function renderPreview(): void {
  if (!preview || !previewSlot) return;
  const p = preview.data;

  staleEl = h("p", { class: "notice bad", hidden: true, text: "Inputs changed since the preview. Run the preview again." });
  confirmBtn = h("button", {
    class: "btn primary",
    type: "button",
    text: "Send the withdrawal",
    disabled: true,
    onclick: () => void runConfirm(),
  });

  previewSlot.replaceChildren(
    h(
      "div",
      { class: "card preview-box", style: "margin-top:14px" },
      h("div", { class: "label", text: "Preview · dry run · nothing was sent" }),
      h(
        "div",
        { style: "margin-top:10px" },
        kv([
          ["Amount", usd(preview.amount)],
          ["Fee", usd(p.fee)],
          ["Minimum", usd(p.minimum)],
          ["Balance", usd(p.balance)],
          ["Net you receive", usd(p.net), p.net < p.balance],
        ]),
      ),
      p.fee_heavy
        ? h("p", { class: "warn small", style: "margin-top:10px", text: "Fee is heavy: it takes a large share of this amount." })
        : null,
      p.warnings && p.warnings.length
        ? h("ul", { class: "warning-list", style: "margin-top:10px" }, ...p.warnings.map((w) => h("li", { text: w })))
        : null,
      h("p", { class: "muted small", style: "margin-top:10px", text: "Only this preview stands between a typo and money that cannot be recovered." }),
      staleEl,
      h("div", { class: "row end", style: "margin-top:12px" }, confirmBtn),
    ),
  );
  refreshConfirm();
}

// --- actions ----------------------------------------------------------------

async function runPreview(): Promise<void> {
  if (!accountSel || !amountInput) return;
  const account_id = accountSel.value;
  const amount = Number(amountInput.value);
  if (!account_id) {
    previewFailed("Choose an account.");
    return;
  }
  if (!amount || amount <= 0) {
    previewFailed("Enter an amount greater than zero.");
    return;
  }
  try {
    const p = await post<Preview>("/api/withdrawals/preview", { account_id, amount });
    preview = { key: `${account_id}:${amount}`, amount, data: p };
    renderPreview();
  } catch (e) {
    previewFailed(errorMessage(e));
  }
}

async function runConfirm(): Promise<void> {
  if (!accountSel || !amountInput || !preview) return;
  const account_id = accountSel.value;
  const amount = Number(amountInput.value);
  if (`${account_id}:${amount}` !== preview.key) return;
  if (confirmBtn) confirmBtn.disabled = true;

  try {
    const r = await post<Withdrawal | List<Withdrawal>>("/api/withdrawals", { account_id, amount });
    const w = "items" in r ? r.items[0] : r;
    preview = null;
    if (w) {
      items = [w, ...items.filter((x) => x.id !== w.id)];
      resultSlot?.replaceChildren(
        h(
          "div",
          { class: "card", style: "margin-top:14px" },
          h("div", { class: "label", text: "Result" }),
          h("div", { class: "row", style: "margin-top:8px" }, statusChip(w)),
          h("p", {
            class: "result-caption",
            text:
              w.status === "created"
                ? "provider accepted; arrival not confirmed. The provider never says the money arrived."
                : "the provider refused this withdrawal.",
          }),
        ),
      );
    }
    previewSlot?.replaceChildren();
    renderHistory();
  } catch (e) {
    previewFailed(errorMessage(e));
  }
}

// --- page -------------------------------------------------------------------

function actionCard(): HTMLElement {
  const options = accounts.length
    ? accounts.map((a) => h("option", { value: a.id, text: `${a.phone || a.id} · ${a.id} · ${usd(a.balance)}` }))
    : [h("option", { value: "", text: "No accounts", disabled: true })];

  accountSel = h("select", { class: "input", onchange: refreshConfirm }, ...options);
  amountInput = h("input", {
    class: "input",
    type: "number",
    step: "0.0001",
    min: "0",
    placeholder: "0.0000",
    inputmode: "decimal",
    oninput: refreshConfirm,
  });
  previewSlot = h("div", {});
  resultSlot = h("div", {});

  return h(
    "div",
    { class: "card" },
    h("div", { class: "label", text: "Provider terms · read from the provider's message, never configured" }),
    terms
      ? h(
          "div",
          { style: "margin-top:10px" },
          kv([
            ["Method", terms.method],
            ["Network", terms.network],
            ["Fee", usd(terms.fee)],
            ["Minimum", usd(terms.minimum)],
            ["Source", terms.source],
          ]),
        )
      : h("p", { class: "notice", style: "margin-top:10px", text: "Provider terms are unreachable right now. The preview still reads fee and minimum before anything can be sent." }),
    h(
      "div",
      { class: "stack", style: "margin-top:16px" },
      h("div", { class: "label", text: "Destination wallet · BEP-20 (BSC) · in full, because a wrong address is unrecoverable" }),
      h("div", { class: "wallet", text: wallet || "not configured" }),
    ),
    dryRun
      ? h("p", { class: "notice bad", style: "margin-top:14px", text: "WITHDRAW_DRY_RUN is on. The backend refuses the real call with 409; only previews go through." })
      : h("p", { class: "notice bad", style: "margin-top:14px", text: "WITHDRAW_DRY_RUN is off. Real payouts are enabled." }),
    h(
      "div",
      { class: "form-grid", style: "margin-top:18px" },
      field("Account (one at a time)", accountSel),
      field("Amount (USD)", amountInput),
      h("div", { class: "field" }, h("span", { text: "Step 1 — preview" }), h("button", { class: "btn primary", type: "button", text: "Preview", onclick: () => void runPreview() })),
    ),
    previewSlot,
    resultSlot,
  );
}

export const withdrawals: Page = {
  async mount(el) {
    view = el;
    const [list, accs, s] = await Promise.all([
      get<List<Withdrawal>>("/api/withdrawals"),
      get<List<Account>>("/api/accounts"),
      get<Settings>("/api/settings"),
    ]);
    items = list.items;
    accounts = accs.items;
    wallet = s.withdraw_wallet;
    dryRun = s.withdraw_dry_run;
    terms = await get<Terms>("/api/withdrawals/terms").catch(() => null);
    preview = null;

    historySlot = h("div", {});
    el.replaceChildren(
      pageHead("Withdrawals", "preview first, then confirm · the provider never confirms arrival"),
      actionCard(),
      section("History", historySlot),
    );
    renderHistory();
  },

  event(type, data) {
    if (type !== "withdrawal" || !view) return;
    const d = data as SseWithdrawal;
    const i = items.findIndex((w) => w.id === d.id);
    if (i >= 0) {
      items[i] = { ...items[i], ...d };
    } else {
      void get<List<Withdrawal>>("/api/withdrawals")
        .then((l) => {
          items = l.items;
          renderHistory();
        })
        .catch(() => undefined);
      return;
    }
    renderHistory();
  },

  dispose() {
    view = null;
    historySlot = null;
    previewSlot = null;
    resultSlot = null;
    accountSel = null;
    amountInput = null;
    confirmBtn = null;
    staleEl = null;
    items = [];
    accounts = [];
    terms = null;
    preview = null;
  },
};
