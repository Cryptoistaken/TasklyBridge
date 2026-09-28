// Shared DOM helpers, formatters and the Page contract.
// No framework: these are the ~120 lines a framework would have replaced.

import type { Alert, Message } from "./api";

export type Attr = string | number | boolean | null | undefined | ((e: Event) => void);
export type Child = Node | string | number | null | undefined | false | Child[];

function add(el: Node, kid: Child): void {
  if (kid === null || kid === undefined || kid === false) return;
  if (kid instanceof Node) {
    el.appendChild(kid);
    return;
  }
  if (typeof kid === "object") {
    for (const k of kid) add(el, k);
    return;
  }
  el.appendChild(document.createTextNode(String(kid)));
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Record<string, Attr>,
  ...kids: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const k of Object.keys(attrs)) {
      const v = attrs[k];
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") el.className = String(v);
      else if (k === "text") el.textContent = String(v);
      else if (k === "value") (el as HTMLInputElement).value = String(v);
      else if (typeof v === "function") el.addEventListener(k.startsWith("on") ? k.slice(2).toLowerCase() : k, v);
      else el.setAttribute(k, v === true ? "" : String(v));
    }
  }
  for (const k of kids) add(el, k);
  return el;
}

// --- formatters -------------------------------------------------------------

/**
 * A dash for a figure that is not known, rather than a zero.
 *
 * These two formatters are called from about thirty-five places and every one
 * of them assumed a number would always be there. GET /api/overview once
 * omitted provider_cost and margin_bdt entirely, the Overview page called
 * toFixed on undefined, and the whole dashboard died with "Cannot read
 * properties of undefined (reading 'toFixed')" - while tsc, bun build, go vet
 * and the Go tests were all green.
 *
 * So a missing figure renders as unknown. It must never render as $0.0000:
 * a zero cost would read as the provider giving the job away free and would
 * quietly make a loss look like a profit.
 */
const UNKNOWN = "—";

/** Provider dollars, 4dp: $0.3750. This is our COST, never our sell price. */
export const usd = (n: number | null | undefined): string =>
  typeof n === "number" && Number.isFinite(n) ? "$" + n.toFixed(4) : UNKNOWN;

/** Our Taka figures, 2dp: 5.00tk. */
export const bdt = (n: number | null | undefined): string =>
  typeof n === "number" && Number.isFinite(n) ? n.toFixed(2) + "tk" : UNKNOWN;

export function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function fmtDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

// --- pieces -----------------------------------------------------------------

export type Tone = "ok" | "muted" | "bad";

export function chip(text: string, tone: Tone = "ok"): HTMLElement {
  return h("span", { class: "chip" + (tone === "ok" ? "" : " " + tone) }, text);
}

export function dot(tone: Tone = "ok"): HTMLElement {
  return h("span", { class: "dot" + (tone === "ok" ? "" : " " + tone) });
}

export function pageHead(title: string, sub?: string): HTMLElement {
  return h("header", { class: "page-head" }, h("h1", { text: title }), sub ? h("p", { text: sub }) : null);
}

export interface Stat {
  label: string;
  value: Child;
  sub?: Child;
  bad?: boolean;
}

export function statRow(stats: Stat[]): HTMLElement {
  return h(
    "div",
    { class: "stats" },
    ...stats.map((s) =>
      h(
        "div",
        { class: "card stat" + (s.bad ? " bad" : "") },
        h("div", { class: "label", text: s.label }),
        h("div", { class: "value" }, s.value),
        s.sub === undefined ? null : h("div", { class: "sub" }, s.sub),
      ),
    ),
  );
}

export interface Col {
  label: string;
  num?: boolean;
}

export function table(cols: Col[], rows: HTMLTableRowElement[]): HTMLElement {
  for (const tr of rows) {
    if (tr.cells.length !== cols.length) continue;
    cols.forEach((c, i) => {
      if (c.num) tr.cells[i].classList.add("num");
    });
  }
  return h(
    "table",
    {},
    h("thead", {}, h("tr", {}, ...cols.map((c) => h("th", { class: c.num ? "num" : null, text: c.label })))),
    h("tbody", {}, ...rows),
  );
}

export const td = (content: Child, cls?: string): HTMLTableCellElement => h("td", { class: cls }, content);

export const tr = (cls: string | undefined, ...cells: Child[]): HTMLTableRowElement =>
  h("tr", cls === undefined ? {} : { class: cls }, ...cells);

/** A full-width note row under a table row. Spans every column. */
export const subRow = (span: number, ...content: Child[]): HTMLTableRowElement =>
  tr("sub", h("td", { class: "sub-cell", colspan: String(span) }, ...content));

export const emptyRow = (span: number, text: string): HTMLTableRowElement =>
  tr(undefined, h("td", { class: "empty", colspan: String(span), text }));

export function wrapTable(t: HTMLElement): HTMLElement {
  return h("div", { class: "table-wrap" }, t);
}

export const label = (text: string): HTMLElement => h("div", { class: "label", text });

export function field(text: string, control: HTMLElement): HTMLElement {
  return h("label", { class: "field" }, h("span", { text }), control);
}

export function section(title: string, ...kids: Child[]): HTMLElement {
  return h("section", { class: "section" }, h("h2", { class: "h2", text: title }), ...kids);
}

export function errorBox(msg: string): HTMLElement {
  return h("div", { class: "card error" }, label("Error"), h("p", { text: msg }));
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// --- page contract ----------------------------------------------------------

/** One of the eight pages. `event` receives SSE frames, `resync` the reconnect refetch. */
export interface Page {
  mount(el: HTMLElement): void | Promise<void>;
  event?(type: string, data: unknown): void;
  resync?(messages: Message[], alerts: Alert[]): void;
  dispose?(): void;
}
