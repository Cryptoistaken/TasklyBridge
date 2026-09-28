// Boot, auth gate, hash routing, the shell, and the one SSE connection.

import { ApiError, api, get, setUnauthorized, stashOverview, type Alert, type List, type Message, type Overview } from "./api";
import { errorMessage, errorBox, h, type Page } from "./ui";
import { mountLogin } from "./login";
import { overview } from "./pages/overview";
import { accounts } from "./pages/accounts";
import { sessions } from "./pages/sessions";
import { users } from "./pages/users";
import { tasks } from "./pages/tasks";
import { messages } from "./pages/messages";
import { alerts } from "./pages/alerts";
import { withdrawals } from "./pages/withdrawals";
import { settings } from "./pages/settings";

const PAGES: Record<string, Page> = {
  "/": overview,
  "/accounts": accounts,
  "/sessions": sessions,
  "/users": users,
  "/tasks": tasks,
  "/messages": messages,
  "/alerts": alerts,
  "/withdrawals": withdrawals,
  "/settings": settings,
};

const NAV: [string, string][] = [
  ["/", "Overview"],
  ["/accounts", "Accounts"],
  ["/sessions", "Sessions"],
  ["/users", "Users"],
  ["/tasks", "Tasks"],
  ["/messages", "Messages"],
  ["/alerts", "Alerts"],
  ["/withdrawals", "Withdrawals"],
  ["/settings", "Settings"],
];

let active: Page | null = null;
let source: EventSource | null = null;
let token = 0;
let wired = false;

function route(): string {
  const r = location.hash.replace(/^#/, "") || "/";
  return r in PAGES ? r : "/";
}

function shell(): HTMLElement {
  return h(
    "div",
    { class: "shell" },
    h(
      "aside",
      { class: "side" },
      h("div", { class: "wordmark" }, "Taskly", h("span", { text: "Bridge" })),
      h(
        "nav",
        { class: "nav" },
        ...NAV.map(([path, text]) => h("a", { href: "#" + path, "data-path": path, text })),
      ),
      h(
        "div",
        { class: "conn", id: "conn", "data-state": "connecting" },
        h("span", { class: "dot" }),
        h("span", { class: "conn-text", text: "connecting" }),
      ),
    ),
    h("main", { class: "view", id: "view" }),
  );
}

function markNav(r: string): void {
  for (const a of document.querySelectorAll<HTMLAnchorElement>(".nav a")) {
    a.classList.toggle("active", a.dataset.path === r);
  }
}

function setConn(state: "connecting" | "live" | "reconnecting"): void {
  const el = document.getElementById("conn");
  if (!el) return;
  el.dataset.state = state;
  const d = el.querySelector(".dot");
  if (d) d.className = "dot" + (state === "live" ? " ok" : state === "reconnecting" ? " muted" : "");
  const t = el.querySelector(".conn-text");
  if (t) t.textContent = state;
}

async function render(): Promise<void> {
  const r = route();
  const view = document.getElementById("view");
  if (!view) return;

  const mine = ++token;
  active?.dispose?.();
  active = null;
  markNav(r);
  window.scrollTo(0, 0);

  // A fresh container per navigation: if a slow page resolves late, it writes
  // into a node that has already been detached instead of into the new page.
  const box = h("div", { class: "page" });
  view.replaceChildren(box);

  const page = PAGES[r];
  active = page;
  try {
    await page.mount(box);
  } catch (e) {
    if (mine !== token) return;
    if (e instanceof ApiError && e.status === 401) return;
    box.replaceChildren(errorBox(errorMessage(e)));
  }
}

// --- live feed --------------------------------------------------------------

async function resync(): Promise<void> {
  try {
    const [m, a] = await Promise.all([
      get<List<Message>>("/api/messages?limit=200"),
      get<List<Alert>>("/api/alerts"),
    ]);
    active?.resync?.(m.items, a.items);
  } catch {
    // Stale until the next event or manual reload. Never poll to paper over it.
  }
}

function startLive(): void {
  if (source) return;
  const es = new EventSource("/api/events");
  source = es;
  let first = true;

  es.onopen = () => {
    setConn("live");
    if (first) {
      first = false;
      return;
    }
    void resync();
  };
  es.onerror = () => setConn("reconnecting");

  for (const type of ["message", "account", "alert", "withdrawal"]) {
    es.addEventListener(type, (ev) => {
      let data: unknown = null;
      try {
        data = JSON.parse((ev as MessageEvent).data);
      } catch {
        return;
      }
      active?.event?.(type, data);
    });
  }
}

function stopLive(): void {
  source?.close();
  source = null;
  setConn("connecting");
}

// Flood-wait countdowns tick locally. No network traffic, no polling loop.
function tickFlood(): void {
  const now = Date.now();
  for (const el of document.querySelectorAll<HTMLElement>("[data-until]")) {
    const left = Math.max(0, Math.round((Number(el.dataset.until) - now) / 1000));
    el.textContent = left > 0 ? `${left}s` : "released";
    if (left <= 0) delete el.dataset.until;
  }
}

// --- shell lifecycle --------------------------------------------------------

function startApp(): void {
  const root = document.getElementById("app");
  if (!root) return;
  root.replaceChildren(shell());

  if (!wired) {
    wired = true;
    window.addEventListener("hashchange", () => void render());
    setInterval(tickFlood, 1000);
  }
  if (!location.hash) history.replaceState(null, "", "#/");

  startLive();
  void render();
}

function showLogin(): void {
  const root = document.getElementById("app");
  if (!root || root.querySelector(".login")) return;
  stopLive();
  active?.dispose?.();
  active = null;
  token++;
  root.replaceChildren();
  mountLogin(root, () => {
    history.replaceState(null, "", "#/");
    startApp();
  });
}

async function boot(): Promise<void> {
  // Registered before the first request: a session that dies later must swap
  // back to the login card even if the boot request itself was the 401.
  setUnauthorized(showLogin);
  try {
    stashOverview(await api<Overview>("GET", "/api/overview"));
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      showLogin();
      return;
    }
    // Backend down or errored: show the shell and let the page report it.
  }
  startApp();
}

void boot();
