import { useEffect, useRef, useState } from "react";

// Sign-in: the official Telegram Login Widget, and nothing else.
//
// Programmatic flow, matching the old login.ts exactly:
//   - the script is loaded BARE, with no data-client-id, data-onauth or
//     data-request-access. Those switch the widget into its legacy
//     self-binding mode, which swallowed the click.
//   - client_id is a NUMBER. The config endpoint hands back a string because
//     it is an environment variable; a string id is not a valid OIDC request,
//     so it is converted with Number() and checked with Number.isSafeInteger.
//   - the result arrives via callback OR via the #tgAuthResult= fragment
//     fallback (base64url decode, payload bare string or object). The fragment
//     is cleared before exchanging so a reload cannot replay it.
//   - 120s timeout so a callback that never arrives reports itself.
//   - the exchange POSTs with credentials: "include" (the Set-Cookie is the
//     whole point).
//   - on success: location.reload(), NOT a direct render. A reload re-runs the
//     boot fetch that reads the session cookie; rendering directly skipped it
//     and the app came up empty.
//   - the button class is "login-button", never "tg-auth-button": that name is
//     the legacy widget's hook for finding a button to bind to.

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

let scriptPromise: Promise<boolean> | null = null;

/** Load the widget script, bare. Never added twice. */
function loadWidget(): Promise<boolean> {
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise((resolve) => {
    const s = document.createElement("script");
    s.src = WIDGET_SRC;
    s.async = true;
    s.onload = () => resolve(true);
    s.onerror = () => resolve(false);
    document.head.appendChild(s);
  });
  return scriptPromise;
}

/**
 * Pull the id_token out of the redirect fragment, or "" when there is none.
 * base64url is restored to base64 and padded, because atob needs the padding.
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

export function Login(): React.JSX.Element {
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  const clientId = useRef(0);
  const busyRef = useRef(false);
  const [, forceBusy] = useState(0);

  const fail = (message: string): void => {
    setStatus("");
    setError(message);
    busyRef.current = false;
    forceBusy((n) => n + 1);
  };

  const busy = (message: string): void => {
    setStatus(message);
    setError("");
    busyRef.current = true;
    forceBusy((n) => n + 1);
  };

  const exchange = async (idToken: string): Promise<void> => {
    busy("Checking with the server...");
    let res: Response;
    try {
      res = await fetch("/api/auth/telegram/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id_token: idToken }),
        // The Set-Cookie on this response is the whole point of the call, so
        // it is asked for explicitly rather than left to the default.
        credentials: "include",
      });
    } catch {
      fail("Could not reach the server.");
      return;
    }
    if (res.ok) {
      location.reload();
      return;
    }
    const body = (await res.json().catch(() => ({}))) as { error?: string; name?: string };
    if (res.status === 403) {
      fail(body.error || "That Telegram account is not an administrator.");
      return;
    }
    fail(body.error || body.name || "Sign-in failed.");
  };
  const exchangeRef = useRef(exchange);
  exchangeRef.current = exchange;

  // Path 2 first: a page loaded with a result in the fragment has nothing to
  // do but spend it. Runs once on mount.
  useEffect(() => {
    const fromHash = tokenFromHash(window.location.hash);
    if (fromHash) {
      // Clear the fragment first, so a reload cannot replay the exchange and
      // the token does not linger in the address bar or in history.
      history.replaceState(null, "", window.location.pathname + window.location.search);
      void exchangeRef.current(fromHash);
      return;
    }
    // Everything the button needs, fetched before it is enabled so a click
    // can never arrive with the client id still unknown.
    void (async () => {
      try {
        const res = await fetch("/api/auth/telegram/config", { credentials: "include" });
        if (!res.ok) throw new Error("not configured");
        const body = (await res.json()) as { clientId?: string | number };
        // The endpoint returns a string because it is an environment variable.
        // The API wants a number, and a string id is a request that cannot work.
        const n = Number(String(body.clientId ?? "").trim());
        if (!Number.isSafeInteger(n) || n <= 0) throw new Error("no client id");
        clientId.current = n;
        setStatus("");
        if (!(await loadWidget())) {
          fail("Telegram sign-in could not be loaded. Check your connection.");
          return;
        }
        setReady(true);
      } catch {
        fail("Sign-in is not configured on the server.");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const signIn = (): void => {
    if (!ready || busyRef.current) return;
    const tgApi = window.Telegram?.Login;
    if (!tgApi) {
      fail("Telegram sign-in is not ready. Check your connection.");
      return;
    }
    if (!clientId.current) {
      fail("Sign-in is not configured on the server.");
      return;
    }
    const options: AuthOptions = { client_id: clientId.current, scope: ["profile"] };
    busy("Waiting for Telegram...");
    new Promise<void>((resolve, reject) => {
      // Without this a callback that never arrives leaves the button disabled
      // with no explanation.
      const timer = window.setTimeout(() => reject(new Error("Telegram login timed out. Try again.")), AUTH_TIMEOUT_MS);
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
        void exchangeRef.current(idToken).then(resolve);
      };
      try {
        if (tgApi.auth) {
          tgApi.auth(options, done);
        } else {
          // Older builds expose init/open instead of auth.
          tgApi.init?.(options, done);
          tgApi.open?.(done);
        }
      } catch (e) {
        window.clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    }).catch((e: unknown) => {
      fail(e instanceof Error ? e.message : String(e));
    });
  };

  // Just the button, centred on --background. No wordmark, no subtitle, no
  // card chrome. Status and error lines stay mounted but hidden until there is
  // something to say.
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background">
      <div className="flex justify-center">
        <button type="button" className="login-button" disabled={!ready || busyRef.current} onClick={signIn}>
          Sign in with Telegram
        </button>
      </div>
      <div className="mt-3.5 flex max-w-[380px] flex-col items-center gap-2 text-center">
        {status ? <p className="text-xs text-muted-foreground">{status}</p> : null}
        {error ? (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}
