// Alerts — price and availability history. Severity ordered, unread first,
// full message always visible.

import { get, type Alert, type AlertLevel, type List, type SseAlert } from "../api";
import { dot, emptyRow, h, pageHead, statRow, table, td, when, wrapTable, type Page } from "../ui";

const COLUMNS = 5;
const RANK: Record<AlertLevel, number> = { critical: 0, warning: 1, info: 2 };

let view: HTMLElement | null = null;
let items: Alert[] = [];

function levelChip(a: Alert): HTMLElement {
  const tone = a.level === "critical" ? "bad" : a.level === "warning" ? "muted" : "ok";
  return h(
    "span",
    { class: "chip " + (tone === "ok" ? "" : tone) },
    dot(a.read ? tone : "ok"),
    a.level,
  );
}

function row(a: Alert): HTMLTableRowElement {
  return h(
    "tr",
    { "data-id": a.id },
    td(levelChip(a)),
    td(a.kind, "mono nowrap" + (a.level === "critical" ? " alert-critical" : "")),
    td(a.job || "—", "mono nowrap muted"),
    td(a.message, a.level === "critical" ? "alert-critical" : undefined),
    td(when(a.at), "mono nowrap muted"),
  );
}

function sorted(): Alert[] {
  return [...items].sort((a, b) => {
    if (a.read !== b.read) return a.read ? 1 : -1;
    if (RANK[a.level] !== RANK[b.level]) return RANK[a.level] - RANK[b.level];
    return b.at.localeCompare(a.at);
  });
}

function paint(): void {
  if (!view) return;
  const rows = sorted();
  view.replaceChildren(
    pageHead("Alerts", "critical first among unread · availability alerts are critical"),
    statRow([
      { label: "Unread", value: String(items.filter((a) => !a.read).length), bad: items.some((a) => !a.read && a.level === "critical") },
      { label: "Critical", value: String(items.filter((a) => a.level === "critical").length), bad: items.some((a) => a.level === "critical") },
      { label: "Warning", value: String(items.filter((a) => a.level === "warning").length) },
      { label: "Total", value: String(items.length) },
    ]),
    h(
      "div",
      { class: "section" },
      h("p", { class: "muted small", style: "margin-bottom:10px" }, "The API exposes no mark-as-read route, so read state is display only."),
      wrapTable(
        table(
          [
            { label: "Level" },
            { label: "Kind" },
            { label: "Job" },
            { label: "Message" },
            { label: "Time" },
          ],
          rows.length ? rows.map(row) : [emptyRow(COLUMNS, "No alerts.")],
        ),
      ),
    ),
  );
}

export const alerts: Page = {
  async mount(el) {
    view = el;
    const list = await get<List<Alert>>("/api/alerts");
    items = list.items;
    paint();
  },
  event(type, data) {
    if (type !== "alert") return;
    const d = data as SseAlert;
    const at = d.at ?? new Date().toISOString();
    items.unshift({
      id: d.id ?? at,
      level: d.level,
      kind: d.kind,
      job: d.job ?? "",
      message: d.message,
      read: d.read ?? false,
      at,
    });
    paint();
  },
  resync(_messages, alerts) {
    items = alerts;
    paint();
  },
  dispose() {
    view = null;
    items = [];
  },
};
