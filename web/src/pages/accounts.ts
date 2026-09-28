// Accounts — the state column is the point of this page. An account about to
// die is the single most expensive thing here, so state is never subtle.

import { get, type Account, type List, type SseAccount } from "../api";
import {
  dot,
  emptyRow,
  fmtDuration,
  h,
  pageHead,
  statRow,
  table,
  td,
  usd,
  when,
  wrapTable,
  type Page,
} from "../ui";

const COLUMNS = 8;

let view: HTMLElement | null = null;
let items: Account[] = [];

function stateChip(a: Account): HTMLElement {
  const tone = a.state === "banned" || a.state === "dead" ? "bad" : a.state === "degraded" ? "muted" : "ok";
  return h("span", { class: "chip " + (tone === "ok" ? "" : tone) }, dot(tone), a.state);
}

function row(a: Account): HTMLTableRowElement {
  const flood = a.flood_wait_seconds > 0;
  const user = a.assigned_user_id;
  return h(
    "tr",
    { "data-id": a.id },
    td(stateChip(a)),
    td(a.phone || "—", "mono nowrap"),
    td(usd(a.balance), "num mono"),
    td(
      user
        ? h(
            "div",
            {},
            h("div", { text: a.assigned_user_name || "—" }),
            h("div", { class: "mono muted small", text: String(user) }),
          )
        : h("span", { class: "muted", text: "—" }),
    ),
    td(String(a.messages_sent), "num mono"),
    td(
      flood
        ? h("span", {
            class: "mono muted",
            "data-until": String(Date.now() + a.flood_wait_seconds * 1000),
            text: fmtDuration(a.flood_wait_seconds),
          })
        : h("span", { class: "muted", text: "—" }),
    ),
    td(when(a.last_seen), "mono nowrap muted"),
    td(a.note || h("span", { class: "muted", text: "—" }), "muted small"),
  );
}

function tableBody(): HTMLElement {
  return table(
    [
      { label: "State" },
      { label: "Phone" },
      { label: "Balance", num: true },
      { label: "Assigned user" },
      { label: "Sent", num: true },
      { label: "Flood-wait", num: true },
      { label: "Last seen" },
      { label: "Note" },
    ],
    items.length ? items.map(row) : [emptyRow(COLUMNS, "No accounts yet.")],
  );
}

function stats(): HTMLElement {
  const n = (fn: (a: Account) => boolean): number => items.filter(fn).length;
  return statRow([
    { label: "Total", value: String(items.length) },
    { label: "Connected", value: String(n((a) => a.state === "connected")) },
    { label: "Free", value: String(n((a) => a.state === "free")) },
    { label: "Degraded", value: String(n((a) => a.state === "degraded")), sub: "flood-wait or at risk" },
    { label: "Banned / dead", value: String(n((a) => a.state === "banned" || a.state === "dead")), bad: n((a) => a.state === "banned" || a.state === "dead") > 0 },
  ]);
}

function paint(): void {
  if (!view) return;
  view.replaceChildren(
    pageHead("Accounts", "one row per phone number · state is what costs money"),
    stats(),
    h("div", { class: "section" }, wrapTable(tableBody())),
  );
}

export const accounts: Page = {
  async mount(el) {
    view = el;
    const list = await get<List<Account>>("/api/accounts");
    items = list.items;
    paint();
  },
  event(type, data) {
    if (type !== "account" || !view) return;
    const upd = data as SseAccount;
    const i = items.findIndex((a) => a.id === upd.id);
    if (i < 0) return;
    items[i] = { ...items[i], ...upd };
    const tr = view.querySelector(`tr[data-id="${CSS.escape(upd.id)}"]`);
    tr?.replaceWith(row(items[i]));
  },
  dispose() {
    view = null;
    items = [];
  },
};
