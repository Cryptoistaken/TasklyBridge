// Messages — the live four-leg feed, newest first. The provider's dollar
// figures appear here and only here: this page is admin-only.

import { get, type Leg, type List, type Message, type SseMessage } from "../api";
import { errorMessage, h, pageHead, type Page } from "../ui";

const LIMIT = 200;

let view: HTMLElement | null = null;
let feedEl: HTMLElement | null = null;
let pillEl: HTMLElement | null = null;
let noticeEl: HTMLElement | null = null;
let items: Message[] = [];
let total = 0;
let unseen = 0;
let busy = false;

function norm(m: SseMessage): Message {
  return {
    id: m.id ?? `${m.account_id}:${m.at}`,
    account_id: m.account_id,
    user_id: m.user_id ?? 0,
    leg: m.leg,
    direction: m.direction ?? (m.leg === "user->bot" || m.leg === "taskly->bot" ? "in" : "out"),
    text: m.text,
    buttons: m.buttons,
    at: m.at,
  };
}

function isProvider(leg: Leg): boolean {
  return leg === "bot->taskly" || leg === "taskly->bot";
}

function msgRow(m: Message): HTMLElement {
  return h(
    "div",
    { class: "msg" + (isProvider(m.leg) ? " provider" : m.leg === "internal" ? " internal" : "") },
    h(
      "div",
      { class: "meta" },
      h("span", { class: "leg", text: m.leg }),
      h("span", { class: "muted", text: m.at ? fmt(m.at) : "" }),
      h("span", { class: "muted", text: m.account_id + (m.user_id ? " · " + m.user_id : "") }),
    ),
    h(
      "div",
      { class: "body" },
      h("div", { class: "txt", text: m.text }),
      m.buttons && m.buttons.length
        ? h("div", { class: "btns" }, ...m.buttons.map((b) => h("span", { class: "chip", text: b })))
        : null,
    ),
  );
}

function fmt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** bot->taskly and taskly->bot are one conversation, so they share a block. */
function blocks(): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (let i = 0; i < items.length; i++) {
    const m = items[i];
    const next = items[i + 1];
    if (m.leg === "taskly->bot" && next && next.leg === "bot->taskly") {
      out.push(h("div", { class: "pair" }, msgRow(m), msgRow(next)));
      i++;
    } else {
      out.push(msgRow(m));
    }
  }
  return out;
}

function renderFeed(): void {
  feedEl?.replaceChildren(...blocks());
}

function updatePill(): void {
  if (!pillEl) return;
  pillEl.hidden = unseen === 0;
  pillEl.textContent = `${unseen} new — show latest`;
}

function notice(msg: string): void {
  if (!noticeEl) return;
  noticeEl.textContent = msg;
  noticeEl.hidden = false;
}

async function older(): Promise<void> {
  if (busy || !view || items.length === 0) return;
  busy = true;
  if (noticeEl) noticeEl.hidden = true;
  const before = items[items.length - 1].at;
  try {
    const page = await get<List<Message>>(`/api/messages?limit=50&before=${encodeURIComponent(before)}`);
    const seen = new Set(items.map((m) => m.id));
    items = items.concat(page.items.filter((m) => !seen.has(m.id)));
    total = page.total;
    renderFeed();
  } catch (e) {
    notice(errorMessage(e));
  } finally {
    busy = false;
  }
}

export const messages: Page = {
  async mount(el) {
    view = el;
    const list = await get<List<Message>>(`/api/messages?limit=${LIMIT}`);
    items = list.items;
    total = list.total;
    unseen = 0;

    feedEl = h("div", { class: "feed" });
    pillEl = h("button", {
      class: "btn sm",
      type: "button",
      hidden: true,
      onclick: () => {
        unseen = 0;
        updatePill();
        window.scrollTo({ top: 0 });
        renderFeed();
      },
    });
    noticeEl = h("p", { class: "notice bad", hidden: true });

    el.replaceChildren(
      h(
        "div",
        {},
        pageHead("Messages", `live four-leg feed · showing ${items.length}${total > items.length ? ` of ${total}` : ""}`),
        h(
          "div",
          { class: "row", style: "margin-bottom:12px" },
          pillEl,
          h("button", { class: "btn sm", type: "button", text: "Older", onclick: () => void older() }),
          h("span", { class: "muted small", text: "provider dollar figures appear on this page only" }),
        ),
        noticeEl,
        feedEl,
      ),
    );
    renderFeed();
  },

  event(type, data) {
    if (type !== "message" || !feedEl) return;
    items.unshift(norm(data as SseMessage));
    total++;
    if (window.scrollY < 8) {
      renderFeed();
      return;
    }
    unseen++;
    updatePill();
  },

  resync(messages) {
    items = messages;
    unseen = 0;
    updatePill();
    renderFeed();
  },

  dispose() {
    view = null;
    feedEl = null;
    pillEl = null;
    noticeEl = null;
    items = [];
    unseen = 0;
  },
};
