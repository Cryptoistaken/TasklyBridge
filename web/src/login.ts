// Sign-in: the official Telegram Login Widget, and nothing else.
//
// This is the programmatic flow, and it is the flow SheetSubmit uses, which is
// the flow that demonstrably works. The previous version loaded the script
// with data-client-id, data-onauth and data-request-access, and let the widget
// bind itself to an element carrying the tg-auth-button class. That is the
// legacy integration. With data-onauth present the widget takes over the click,
// so the callback we registered was never what drove the login, and approving
// in Telegram returned to a page that issued no request at all. tsc and
// bun build were clean the whole time, because the code was well-formed and
// simply was not called.
//
// Two details this gets right that the legacy version did not:
//
//   - the script is loaded bare, with no data-* attributes, so all it does is
//     expose window.Telegram.Login and nothing hijacks our button
//   - client_id is a NUMBER. The config endpoint hands back a string because it
//     is an environment variable, and a string is not a valid OIDC request, so
//     it is converted and then checked rather than passed through
//
// The result arrives one of two ways and both are handled, because relying on
// one of them is what broke this twice:
//
//   1. a callback from Telegram.Login.auth
//   2. a redirect back to this page carrying the token in the URL fragment as
//      #tgAuthResult=<base64url>
//
// Two deliberate choices:
//
//   - scope is ["profile"] only. This panel needs to know who is signing in.
//     Asking for write access would let the page act as the user, which is not
//     something a dashboard that can move money should request.
//   - there is no password. A shared password on a panel that can withdraw is
//     the weakest link in the chain, and this way there is no secret of ours to
//     leak, share, or forget to rotate.
//
// The id_token goes straight to the backend and is forgotten: never stored,
// never logged.

import { h } from "./ui";

const WIDGET_SRC = "https://oauth.telegram.org/js/telegram-login.js";

// Long enough for a real person to read the Telegram prompt and approve, short
// enough that a callback which never arrives reports itself instead of leaving
// the button disabled forever.
const AUTH_TIMEOUT_MS = 120_000;

interface AuthResult {
  id_token?: string;
  error?: string;
}

interface AuthOptions {
  client_id: number;
  scope: string[];
}

interface TelegramLoginApi {
  auth?: (opts: AuthOptions, cb: (data: AuthResult) => void) => void;
  init?: (opts: AuthOptions, cb: (data: AuthResult) => void) => void;
  open?: (cb?: (data: AuthResult) => void) => void;
}

declare global {
  interface Window {
    Telegram?: { Login?: TelegramLoginApi };
  }
}

let scriptLoading: Promise<boolean> | null = null;

/**
 * Load the widget script, bare.
 *
 * Deliberately no data-client-id, data-onauth or data-request-access. Those
 * switch the widget into its legacy self-binding mode, and that is the mode
 * that swallowed the click. Loading it bare gives us the API object and leaves
 * the button ours.
 */
function loadWidget(): Promise<boolean> {
  // Must not be added twice: a second copy would leave two handlers racing for
  // the same click.
  if (scriptLoading) return scriptLoading;

  scriptLoading = new Promise((resolve) => {
    const s = document.createElement("script");
    s.src = WIDGET_SRC;
    s.async = true;
    s.onload = () => resolve(true);
    s.onerror = () => resolve(false);
    document.head.appendChild(s);
  });
  return scriptLoading;
}

/**
 * Pull the id_token out of the redirect fragment, or "" when there is none.
 *
 * base64url is restored to base64 and padded, because atob needs the padding.
 * The decoded payload is either the token as a bare string or an object
 * carrying it. A decode failure returns "" rather than throwing, so a malformed
 * fragment degrades to "not signed in" rather than a blank page.
 */
function tokenFromHash(hash: string): string {
  const m = hash.match(/tgAuthResult=([^&]+)/);
  if (!m) return "";
  try {
    const b64 = m[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const payload: unknown = JSON.parse(atob(padded));
    if (typeof payload === "string") return payload;
    if (payload && typeof payload === "object") {
      const rec = payload as Record<string, unknown>;
      for (const key of ["result", "id_token", "token"]) {
        const v = rec[key];
        if (typeof v === "string" && v) return v;
      }
    }
    return "";
  } catch {
    return "";
  }
}

export function mountLogin(root: HTMLElement, onOk: () => void): void {
  const status = h("p", { class: "muted small" });
  const err = h("p", { class: "warn small", role: "alert" });
  err.hidden = true;

  // The class is deliberately not "tg-auth-button". That name is the legacy
  // widget's hook for finding a button to bind itself to, and using it is how
  // the widget ended up owning this click.
  const button = h(
    "button",
    { class: "login-button", type: "button", disabled: true },
    "Continue with Telegram",
  );
  button.disabled = true;

  // Just the button. No wordmark, no subtitle, no card chrome: the page has one
  // job and the sign-in is the whole of it.
  //
  // The status and error lines stay in the DOM because a failure has to be
  // visible, but they are hidden until there is something to say.
  root.replaceChildren(h(
    "div",
    { class: "login" },
    h("div", { class: "login-actions" }, button),
    h("div", { class: "login-aside" }, status, err),
  ));

  function fail(message: string): void {
    status.textContent = "";
    err.textContent = message;
    err.hidden = false;
    button.disabled = false;
  }

  function busy(message: string): void {
    status.textContent = message;
    err.hidden = true;
    button.disabled = true;
  }

  async function exchange(idToken: string): Promise<void> {
    busy("Checking with the server...");

    let res: Response;
    try {
      res = await fetch("/api/auth/telegram/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id_token: idToken }),
        // The Set-Cookie on this response is the whole point of the call, so it
        // is asked for explicitly rather than left to the default.
        credentials: "include",
      });
    } catch {
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

  // Path 2: the redirect back. Checked before anything else, because a page
  // loaded with a result in the fragment has nothing to do but spend it.
  const fromHash = tokenFromHash(window.location.hash);
  if (fromHash) {
    // Clear the fragment first, so a reload cannot replay the exchange and the
    // token does not linger in the address bar or in history.
    history.replaceState(null, "", window.location.pathname + window.location.search);
    void exchange(fromHash);
    return;
  }

  // Everything the button needs, fetched before it is enabled so a click can
  // never arrive with the client id still unknown.
  let clientId = 0;
  void (async () => {
    try {
      const res = await fetch("/api/auth/telegram/config", { credentials: "include" });
      if (!res.ok) throw new Error("not configured");
      const body = (await res.json()) as { clientId?: string | number };
      // The endpoint returns a string because it is an environment variable.
      // The API wants a number, and a string id is a request that cannot work.
      const n = Number(String(body.clientId ?? "").trim());
      if (!Number.isSafeInteger(n) || n <= 0) throw new Error("no client id");
      clientId = n;

      status.textContent = "";
      if (!(await loadWidget())) {
        fail("Telegram sign-in could not be loaded. Check your connection.");
        return;
      }
      button.disabled = false;
    } catch {
      fail("Sign-in is not configured on the server.");
    }
  })();

  // Path 1: the programmatic popup/redirect, with a callback.
  button.addEventListener("click", () => {
    if (button.disabled) return;

    const api = window.Telegram?.Login;
    if (!api) {
      fail("Telegram sign-in is not ready. Check your connection.");
      return;
    }
    if (!clientId) {
      fail("Sign-in is not configured on the server.");
      return;
    }

    const options: AuthOptions = { client_id: clientId, scope: ["profile"] };
    busy("Waiting for Telegram...");

    new Promise<void>((resolve, reject) => {
      // Without this a callback that never arrives leaves the button disabled
      // with no explanation, which is the failure this whole thing had twice.
      const timer = window.setTimeout(
        () => reject(new Error("Telegram login timed out. Try again.")),
        AUTH_TIMEOUT_MS,
      );
      const done = (data: AuthResult): void => {
        window.clearTimeout(timer);
        if (data?.error) {
          reject(new Error(String(data.error)));
          return;
        }
        const idToken = data?.id_token;
        if (typeof idToken !== "string" || !idToken) {
          reject(new Error("Telegram returned no token."));
          return;
        }
        void exchange(idToken).then(resolve);
      };

      try {
        if (api.auth) {
          api.auth(options, done);
        } else {
          // Older builds expose init/open instead of auth.
          api.init?.(options, done);
          api.open?.(done);
        }
      } catch (e) {
        window.clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    }).catch((e: unknown) => {
      fail(e instanceof Error ? e.message : String(e));
    });
  });
}
