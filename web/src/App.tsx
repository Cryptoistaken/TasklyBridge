import { useEffect, useState } from "react";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { api, setUnauthorized, ApiError, type Overview } from "@/lib/api";
import { onOverviewInvalidated, publish } from "@/lib/bus";
import { Login } from "@/auth/Login";
import { Shell, useSse, type ConnState } from "@/components/Shell";
import { OverviewPage } from "@/pages/OverviewPage";
import { AccountsPage } from "@/pages/AccountsPage";
import { SessionsPage } from "@/pages/SessionsPage";
import { UsersPage } from "@/pages/UsersPage";
import { TasksPage } from "@/pages/TasksPage";
import { MessagesPage } from "@/pages/MessagesPage";
import { AlertsPage } from "@/pages/AlertsPage";
import { WithdrawalsPage } from "@/pages/WithdrawalsPage";
import { SettingsPage } from "@/pages/SettingsPage";

type Boot = { state: "loading" } | { state: "login" } | { state: "app"; overview: Overview | null };

function AuthedApp({ overview: initial }: { overview: Overview | null }): React.JSX.Element {
  const [conn, setConn] = useState<ConnState>("connecting");
  // The boot snapshot lives here rather than in Boot so it can be replaced.
  // A page that changes what the Overview shows - hiding a job, deleting the
  // in-use session - invalidates it, and the Overview re-reads instead of
  // rendering a value the operator has already changed.
  const [overview, setOverview] = useState<Overview | null>(initial);
  // The one SSE connection, owned here. Pages subscribe to frames through the
  // bus; each page unsubscribes on unmount so a dead page never repaints.
  useSse(publish, setConn);

  useEffect(
    () =>
      onOverviewInvalidated(() => {
        // A failure here leaves the previous snapshot in place rather than
        // blanking the page: a stale number beats no number.
        void api<Overview>("GET", "/api/overview")
          .then(setOverview)
          .catch(() => {});
      }),
    [],
  );

  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Shell conn={conn} />}>
          <Route index element={<OverviewPage initial={overview} />} />
          <Route path="accounts" element={<AccountsPage />} />
          <Route path="sessions" element={<SessionsPage />} />
          <Route path="users" element={<UsersPage />} />
          <Route path="tasks" element={<TasksPage />} />
          <Route path="messages" element={<MessagesPage />} />
          <Route path="alerts" element={<AlertsPage />} />
          <Route path="withdrawals" element={<WithdrawalsPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="*" element={<OverviewPage initial={overview} />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

function Boot(): React.JSX.Element {
  const [boot, setBoot] = useState<Boot>({ state: "loading" });

  useEffect(() => {
    // Registered before the first request: a session that dies later must
    // swap back to the login card even if the boot request itself was the 401.
    setUnauthorized(() => setBoot({ state: "login" }));
    let live = true;
    void (async () => {
      try {
        const o = await api<Overview>("GET", "/api/overview");
        if (live) setBoot({ state: "app", overview: o });
      } catch (e: unknown) {
        if (!live) return;
        // A 401 already swapped to login via setUnauthorized — nothing more
        // to do. Anything else means the backend is down or errored: show
        // the shell with no snapshot and let the page report it.
        if (e instanceof ApiError && e.status === 401) return;
        setBoot({ state: "app", overview: null });
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  if (boot.state === "login") return <Login />;
  if (boot.state === "app") return <AuthedApp overview={boot.overview} />;
  return <div className="min-h-screen bg-background" />;
}

export function App(): React.JSX.Element {
  return <Boot />;
}
