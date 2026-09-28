// Tasks — the catalogue. Our sell price and the provider's cost are deliberately
// shown side by side, in different units and different colours, because the gap
// between them is the whole business.

import { get, post, type Task, type TaskList } from "../api";
import { bdt, chip, emptyRow, h, pageHead, statRow, subRow, table, td, usd, wrapTable, type Page } from "../ui";

const COLUMNS = 6;

let view: HTMLElement | null = null;
let errEl: HTMLElement | null = null;
let items: Task[] = [];
let bdtRate = 0;

function stateChip(t: Task): HTMLElement {
  if (!t.enabled) return chip("hidden", "muted");
  if (!t.available) return chip("unavailable", "bad");
  return chip("offered", "ok");
}

function showErr(msg: string): void {
  if (!errEl) return;
  errEl.textContent = msg;
  errEl.hidden = false;
}

async function toggle(t: Task): Promise<void> {
  if (errEl) errEl.hidden = true;
  try {
    await post(`/api/tasks/${encodeURIComponent(t.id)}/enabled`, { enabled: !t.enabled });
    const list = await get<TaskList>("/api/tasks");
    items = list.items;
    bdtRate = list.bdt_rate;
    paint();
  } catch (e) {
    showErr(e instanceof Error ? e.message : String(e));
  }
}

function row(t: Task): HTMLTableRowElement[] {
  const cells = [
    td(
      h(
        "div",
        {},
        h("div", { text: t.name }),
        h("div", { class: "mono muted small", text: t.id }),
      ),
    ),
    // Our static price. Taka, bright: this is what a user is charged.
    td(bdt(t.sell_bdt), "num mono"),
    // The provider's dollar cost. Muted, dollar signs: our cost, never a sell
    // price. It reads as unknown rather than $0.0000 when the watcher has no
    // snapshot, because a zero here would look like a healthy margin.
    td(usd(t.provider_price_known ? t.provider_price : null), "num mono muted"),
    td(
      bdt(t.margin_known ? t.margin_bdt : null),
      "num mono" + (t.margin_known && t.margin_bdt < 0 ? " warn" : ""),
    ),
    td(stateChip(t)),
    td(
      h("button", {
        class: "btn sm",
        type: "button",
        text: t.enabled ? "Hide" : "Show",
        onclick: () => void toggle(t),
      }),
    ),
  ];
  return [
    h("tr", { "data-id": t.id }, ...cells),
    subRow(
      COLUMNS,
      h(
        "div",
        {},
        h(
          "div",
          { class: "mono" },
          `match ${t.require_all.map((r) => `"${r}"`).join(" + ")}`,
          t.provider_name ? ` → provider "${t.provider_name}"` : " → no provider job matched",
        ),
        h(
          "div",
          {},
          t.hidden.length
            ? `withheld: ${t.hidden.join(" · ")}`
            : "nothing withheld from this job",
        ),
      ),
    ),
  ];
}

function tableBody(): HTMLElement {
  return table(
    [
      { label: "Our job" },
      { label: "Sell price", num: true },
      { label: "Provider cost (USD)", num: true },
      { label: "Margin", num: true },
      { label: "State" },
      { label: "" },
    ],
    items.length
      ? items.flatMap(row)
      : [emptyRow(COLUMNS, "The catalogue is empty — nothing is offered.")],
  );
}

function paint(): void {
  if (!view) return;
  const losses = items.filter((t) => t.margin_bdt < 0).length;
  errEl = h("p", { class: "notice bad", hidden: true });
  view.replaceChildren(
    pageHead("Tasks", bdtRate ? `bdt rate ${bdtRate} tk/$ · margin = sell price minus provider cost in Taka` : "margin = sell price minus provider cost in Taka"),
    statRow([
      { label: "Offered", value: String(items.filter((t) => t.enabled && t.available).length) },
      { label: "Unavailable", value: String(items.filter((t) => t.enabled && !t.available).length), bad: items.some((t) => t.enabled && !t.available) },
      { label: "Hidden", value: String(items.filter((t) => !t.enabled).length), sub: "we do not sell these" },
      { label: "At a loss", value: String(losses), sub: "negative margin", bad: losses > 0 },
    ]),
    h(
      "div",
      { class: "section" },
      errEl,
      h(
        "p",
        { class: losses ? "warn small" : "muted small", style: "margin-bottom:10px" },
        losses
          ? "Negative margin is destructive red: we lose money on every sale."
          : "No job is currently at a loss.",
      ),
      wrapTable(tableBody()),
    ),
  );
}

export const tasks: Page = {
  async mount(el) {
    view = el;
    const list = await get<TaskList>("/api/tasks");
    items = list.items;
    bdtRate = list.bdt_rate;
    paint();
  },
  dispose() {
    view = null;
    items = [];
  },
};
