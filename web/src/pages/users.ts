// Users — one row per end user with their joined job. Anyone with no account
// assigned shows as waiting.

import { get, type List, type User, type UserStatus } from "../api";
import { chip, emptyRow, h, pageHead, statRow, table, td, when, wrapTable, type Page } from "../ui";

const COLUMNS = 7;

let view: HTMLElement | null = null;
let items: User[] = [];

function statusChip(u: User): HTMLElement {
  const shown: UserStatus = u.account_id ? u.status : "waiting";
  return chip(shown, shown === "joined" ? "ok" : "muted");
}

function row(u: User): HTMLTableRowElement {
  return h(
    "tr",
    { "data-id": String(u.id) },
    td(
      h(
        "div",
        {},
        h("div", { text: u.name || "—" }),
        u.username ? h("div", { class: "mono muted small", text: "@" + u.username }) : null,
      ),
    ),
    td(statusChip(u)),
    td(u.task_name || h("span", { class: "muted", text: "—" }), "mono"),
    td(
      u.account_id
        ? h("span", { class: "mono", text: u.account_id })
        : h("span", { class: "muted small", text: "no account" }),
      "nowrap",
    ),
    td(String(u.messages), "num mono"),
    td(when(u.joined_at), "mono nowrap muted"),
    td(when(u.last_seen), "mono nowrap muted"),
  );
}

function tableBody(): HTMLElement {
  return table(
    [
      { label: "User" },
      { label: "Status" },
      { label: "Joined job" },
      { label: "Account" },
      { label: "Messages", num: true },
      { label: "Joined" },
      { label: "Last seen" },
    ],
    items.length ? items.map(row) : [emptyRow(COLUMNS, "No users yet.")],
  );
}

function paint(): void {
  if (!view) return;
  const n = (fn: (u: User) => boolean): number => items.filter(fn).length;
  view.replaceChildren(
    pageHead("Users", "end users and the job they joined"),
    statRow([
      { label: "Total", value: String(items.length) },
      { label: "Joined", value: String(n((u) => u.status === "joined")) },
      { label: "Waiting", value: String(n((u) => !u.account_id || u.status === "waiting")) },
      { label: "Stopped", value: String(n((u) => u.status === "stopped")) },
    ]),
    h("div", { class: "section" }, wrapTable(tableBody())),
  );
}

export const users: Page = {
  async mount(el) {
    view = el;
    const list = await get<List<User>>("/api/users");
    items = list.items;
    paint();
  },
  dispose() {
    view = null;
    items = [];
  },
};
