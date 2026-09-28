// Sign-in: the official Telegram Login Widget, and nothing else.
//
// The widget script is loaded the way Telegram documents it, with
// data-client-id, data-onauth and a button carrying the tg-auth-button class.
// Telegram then renders and owns its own button, so the branding and the
// in-Telegram experience are the real thing rather than a lookalike.
//
// Two deliberate choices:
//
//   - data-request-access is "read", not "write". The panel only needs to know
//     who is signing in. Requesting write access would let this page act as the
//     user, which is not something a dashboard that can move money should ask
//     for.
//   - there is no password. A shared password on a panel that can withdraw is
//     the weakest link in the chain, and this way there is no secret of ours to
//     leak, share, or forget to rotate.
//
// The id_token is handed straight to the backend and forgotten: never stored,
// never logged, never put in a URL.

import { h } from "./ui";

const WIDGET_SRC = "https://oauth.telegram.org/js/telegram-login.js";

// The widget's data-onauth attribute names a global, so the callback has to
// exist on window rather than being a closure.
declare global {
  interface Window {
    onTelegramAuth?: (data: { id_token?: string; error?: string }) => void;
  }
}

let scriptLoading: Promise<boolean> | null = null;

function loadWidget(clientId: string): Promise<boolean> {
  // The script must exist before the widget can bind, and it must not be added
  // twice: a second copy would leave two widgets fighting over the click.
  if (scriptLoading) return scriptLoading;

  scriptLoading = new Promise((resolve) => {
    const s = document.createElement("script");
    s.src = WIDGET_SRC;
    s.async = true;
    s.dataset.clientId = clientId;
    s.dataset.onauth = "onTelegramAuth";
    s.dataset.requestAccess = "read";
    s.onload = () => resolve(true);
    s.onerror = () => resolve(false);
    document.head.appendChild(s);
  });
  return scriptLoading;
}

export function mountLogin(root: HTMLElement, onOk: () => void): void {
  // A previous mount may have left a callback behind. Clearing it first means a
  // stale token can never be posted by a page that has already gone.
  delete window.onTelegramAuth;

  const status = h("p", { class: "muted small" });
  const err = h("p", { class: "warn small", role: "alert" });
  err.hidden = true;

  // Telegram looks for this class and replaces the button's contents with its
  // own. Until the script arrives it is an ordinary disabled button.
  const button = h(
    "button",
    { class: "tg-auth-button", "data-style": "shine", type: "button", disabled: true },
    "Sign in with Telegram",
  );
  button.disabled = true;

  const card = h("div", { class: "card login-card" },
    h("h1", { class: "brand" }, "TasklyBridge"),
    h("p", { class: "muted small" }, "Admin dashboard"),
    h("div", { class: "login-actions" }, button),
    status,
    err,
  );
  // The centering lives on .login in the stylesheet, so the card has to sit
  // inside that wrapper. Replacing the root with the card alone left the card
  // pinned to the top-left of the page.
  root.replaceChildren(h("div", { class: "login" }, card));

  function fail(message: string): void {
    err.textContent = message;
    err.hidden = false;
  }

  async function exchange(idToken: string): Promise<void> {
    status.textContent = "Checking with the server...";

    let res: Response;
    try {
      res = await fetch("/api/auth/telegram/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id_token: idToken }),
      });
    } catch {
      status.textContent = "";
      fail("Could not reach the server.");
      return;
    }

    if (res.ok) {
      onOk();
      return;
    }
    status.textContent = "";
    const body = (await res.json().catch(() => ({}))) as { error?: string; name?: string };
    if (res.status === 403) {
      fail(body.error || "That Telegram account is not an administrator.");
      return;
    }
    fail(body.error || body.name || "Sign-in failed.");
  }

  window.onTelegramAuth = (data) => {
    if (data?.error) {
      err.hidden = false;
      err.textContent = String(data.error);
      status.textContent = "";
      return;
    }
    const idToken = data?.id_token;
    if (!idToken) {
      fail("Telegram returned no token.");
      return;
    }
    void exchange(idToken);
  };

  // The client id is public: it names the application, not a user.
  (async () => {
    try {
      const res = await fetch("/api/auth/telegram/config");
      if (!res.ok) throw new Error("not configured");
      const body = (await res.json()) as { clientId?: string | number };
      const clientId = String(body.clientId ?? "").trim();
      if (!clientId) throw new Error("no client id");

      status.textContent = "";
      if (!(await loadWidget(clientId))) {
        fail("Telegram sign-in could not be loaded. Check your connection.");
        return;
      }
      // The widget binds by looking for the button, so it is enabled once the
      // script is in place. Telegram replaces its label on first click.
      button.disabled = false;
    } catch {
      fail("Sign-in is not configured on the server.");
    }
  })();
}
