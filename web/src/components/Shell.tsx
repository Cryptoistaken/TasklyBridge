import { useEffect, useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { cn } from "@/lib/utils";

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

export type ConnState = "connecting" | "live" | "reconnecting";

function ConnDot({ state }: { state: ConnState }): React.JSX.Element {
  return (
    <span
      aria-hidden
      className={cn(
        "size-[7px] shrink-0 rounded-full",
        state === "live" ? "bg-primary" : state === "reconnecting" ? "bg-muted-foreground" : "bg-muted-foreground",
      )}
    />
  );
}

/**
 * App shell: sidebar with real-path NavLinks, content outlet, SSE connection
 * indicator bottom-left. Flood-wait countdowns ([data-until]) tick locally on
 * a 1s interval — no network traffic, no polling loop.
 */
export function Shell({ conn }: { conn: ConnState }): React.JSX.Element {
  useEffect(() => {
    const id = window.setInterval(() => {
      const now = Date.now();
      for (const el of document.querySelectorAll<HTMLElement>("[data-until]")) {
        const left = Math.max(0, Math.round((Number(el.dataset.until) - now) / 1000));
        el.textContent = left > 0 ? `${left}s` : "released";
        if (left <= 0) delete el.dataset.until;
      }
    }, 1000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <div className="grid min-h-screen [grid-template-columns:236px_minmax(0,1fr)]">
      <aside className="sticky top-0 flex h-screen flex-col gap-4 border-r border-border bg-card px-3 py-5">
        <div className="px-2 text-[15px] font-semibold tracking-[-0.01em]">
          Taskly<span className="text-muted-foreground">Bridge</span>
        </div>
        <nav className="flex flex-1 flex-col gap-0.5">
          {NAV.map(([path, text]) => (
            <NavLink
              key={path}
              to={path}
              end={path === "/"}
              className={({ isActive }: { isActive: boolean }) =>
                cn(
                  "flex items-center gap-2 rounded-[var(--radius)] px-2.5 py-2 text-[13px] text-muted-foreground",
                  "before:size-[5px] before:flex-none before:rounded-full before:bg-transparent before:content-['']",
                  "hover:bg-muted hover:text-foreground",
                  isActive && "bg-secondary text-foreground before:bg-primary",
                )
              }
            >
              {text}
            </NavLink>
          ))}
        </nav>
        <div className="flex items-center gap-2 border-t border-border px-2.5 pt-3 font-mono text-xs text-muted-foreground">
          <ConnDot state={conn} />
          <span>{conn}</span>
        </div>
      </aside>
      <main className="min-w-0 max-w-[1240px] px-8 pt-7 pb-[72px]">
        <Outlet />
      </main>
    </div>
  );
}

export function useSse(onEvent: (type: string, data: unknown) => void, onState: (s: ConnState) => void): void {
  const [handler] = useState(() => ({ onEvent, onState }));
  handler.onEvent = onEvent;
  handler.onState = onState;

  useEffect(() => {
    const es = new EventSource("/api/events");
    let first = true;
    es.onopen = () => {
      handler.onState("live");
      if (first) {
        first = false;
        return;
      }
      // Reconnect resync is owned by each page (phase 2); the shell only
      // reports the connection state.
    };
    es.onerror = () => handler.onState("reconnecting");
    const types = ["message", "account", "alert", "withdrawal"];
    const listeners = types.map((type) => {
      const fn = (ev: Event): void => {
        let data: unknown = null;
        try {
          data = JSON.parse((ev as MessageEvent).data);
        } catch {
          return;
        }
        handler.onEvent(type, data);
      };
      es.addEventListener(type, fn);
      return { type, fn };
    });
    return () => {
      for (const { type, fn } of listeners) es.removeEventListener(type, fn);
      es.close();
      handler.onState("connecting");
    };
  }, [handler]);
}
