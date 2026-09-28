// Sign-in: the Telegram Login Widget, and nothing else.
//
// There is no password field. A shared password on a panel that can move money
// is the weakest link in the chain, and this panel can withdraw. The widget
// proves identity to Telegram and Telegram proves it to us, so there is no
// secret of ours to leak, share, or forget to rotate.
//
// Flow, matching the implementation in C:\Studio\Tools\SheetSubmit:
//   1. fetch the client id from the backend
//   2. load https://oauth.telegram.org/js/telegram-login.js
//   3. Telegram.Login.auth({client_id, scope}, callback) hands back an id_token
//   4. POST it to the backend, which verifies the signature against Telegram's
//      JWKS before issuing a session cookie
//
// The id_token is never stored, never logged, and never persisted. It is
// handed straight to the backend and forgotten.

import { h } from "./ui";

const WIDGET_SRC = "https://oauth.telegram.org/js/telegram-login.js";
const AUTH_TIMEOUT_MS = 120_000;

declare global {
  interface Window {
    Telegram?: {
      Login?: {
        auth: (
          options: { client_id: number; scope: string[] },
          callback: (data: { id_token?: string; error?: string }) => void,
        ) => void;
        init?: (
          options: { client_id: number; scope: string[] },
          callback: (data: { id_token?: string; error?: string }) => void,
        ) => void;
        open?: (
          callback: (data: { id_token?: string; error?: string }) => void,
        ) => void;
      };
    };
  }
}

function loadWidget(): Promise<boolean> {
  // Telegram's own script may already be present when the page is opened from
  // inside the Telegram app, in which case re-adding it is pointless.
  if (window.Telegram?.Login) return Promise.resolve(true);

  return new Promise((resolve) => {
    const s = document.createElement("script");
    s.src = WIDGET_SRC;
    s.async = true;
    s.onload = () => resolve(Boolean(window.Telegram?.Login));
    s.onerror = () => resolve(false);
    document.head.appendChild(s);
  });
}

export function mountLogin(root: HTMLElement, onOk: () => void): void {
  const status = h("p", { class: "muted small" });
  const err = h("p", { class: "warn small", role: "alert" });
  err.hidden = true;

  const button = h("button", { class: "btn primary", type: "button" }, "Sign in with Telegram") as HTMLButtonElement;
  button.disabled = true;

  const card = h("div", { class: "card login-card" },
    h("h1", { class: "brand" }, "TasklyBridge"),
    h("p", { class: "muted small" }, "Admin dashboard"),
    h("div", { class: "login-actions" }, button),
    status,
    err,
  );
  root.replaceChildren(card);

  function fail(message: string): void {
    button.disabled = false;
    err.textContent = message;
    err.hidden = false;
  }

  async function signIn(): Promise<void> {
    button.disabled = true;
    err.hidden = true;
    status.textContent = "Opening Telegram...";

    // The client id is public: it names the application, not a user.
    let clientId: number;
    try {
      const res = await fetch("/api/auth/telegram/config");
      if (!res.ok) throw new Error("login is not configured on the server");
      const body = (await res.json()) as { clientId?: string | number };
      clientId = Number(body.clientId);
      if (!Number.isSafeInteger(clientId) || clientId <= 0) {
        throw new Error("the server returned an invalid client id");
      }
    } catch (e) {
      fail(e instanceof Error ? e.message : "Could not reach the sign-in service.");
      return;
    }

    if (!(await loadWidget())) {
      fail("Telegram sign-in could not be loaded. Check your connection.");
      return;
    }

    const widget = window.Telegram?.Login;
    if (!widget) {
      fail("Telegram sign-in is unavailable right now.");
      return;
    }

    status.textContent = "Waiting for Telegram...";

    let idToken: string;
    try {
      idToken = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Sign-in timed out.")), AUTH_TIMEOUT_MS);
        const done = (data: { id_token?: string; error?: string }) => {
          clearTimeout(timer);
          if (data?.error) return reject(new Error(String(data.error)));
          if (!data?.id_token) return reject(new Error("Telegram returned no token."));
          resolve(data.id_token);
        };
        try {
          const options = { client_id: clientId, scope: ["profile", "phone"] };
          if (widget.auth) widget.auth(options, done);
          else if (widget.init && widget.open) {
            widget.init(options, done);
            widget.open(done);
          } else {
            reject(new Error("Telegram sign-in is unavailable right now."));
          }
        } catch (e) {
          clearTimeout(timer);
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      });
    } catch (e) {
      fail(e instanceof Error ? e.message : "Sign-in failed.");
      status.textContent = "";
      return;
    }

    status.textContent = "Checking with the server...";

    let res: Response;
    try {
      res = await fetch("/api/auth/telegram/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id_token: idToken }),
      });
    } catch {
      fail("Could not reach the server.");
      status.textContent = "";
      return;
    }

    // The token is not kept past this point regardless of the outcome.
    idToken = "";

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

  button.addEventListener("click", () => void signIn());

  // Warm the widget up so the button is ready to use.
  void (async () => {
    try {
      const res = await fetch("/api/auth/telegram/config");
      if (!res.ok) throw new Error("not configured");
      const body = (await res.json()) as { clientId?: string | number };
      if (!Number.isSafeInteger(Number(body.clientId))) throw new Error("no client id");
      if (await loadWidget()) {
        button.disabled = false;
        status.textContent = "";
      } else {
        fail("Telegram sign-in could not be loaded. Check your connection.");
      }
    } catch {
      fail("Sign-in is not configured on the server.");
    }
  })();
}
