import { useEffect, useRef, useState } from "react";
import { get, type Leg, type List, type Message, type SseMessage } from "@/lib/api";
import { subscribe } from "@/lib/bus";
import { PageHeader } from "@/components/PageHeader";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

// Messages — the live four-leg feed, newest first. The provider's dollar
// figures appear here and only here: this page is admin-only.

const LIMIT = 200;

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

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function MsgRow({ m }: { m: Message }): React.JSX.Element {
  return (
    <div className="grid grid-cols-[168px_minmax(0,1fr)] gap-x-4 gap-y-1 border-b border-border px-3.5 py-2.5 last:border-b-0">
      <div className="flex flex-col gap-[3px] text-[11px]">
        <span className={cn("font-mono", isProvider(m.leg) ? "text-muted-foreground" : "text-foreground")}>{m.leg}</span>
        <span className="text-muted-foreground">{m.at ? fmtTime(m.at) : ""}</span>
        <span className="text-muted-foreground">
          {m.account_id}
          {m.user_id ? ` · ${m.user_id}` : ""}
        </span>
      </div>
      <div>
        <div
          className={cn(
            "wrap-anywhere whitespace-pre-wrap",
            isProvider(m.leg) && "font-mono text-[13px]",
            m.leg === "internal" && "text-muted-foreground italic",
          )}
        >
          {m.text}
        </div>
        {m.buttons && m.buttons.length ? (
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {m.buttons.map((b) => (
              <span
                key={b}
                className="inline-flex items-center gap-1.5 rounded-[var(--radius)] border border-border bg-muted px-2.5 py-0.5 font-mono text-xs whitespace-nowrap"
              >
                {b}
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** bot->taskly and taskly->bot are one conversation, so they share a block. */
function Feed({ items }: { items: Message[] }): React.JSX.Element {
  const blocks: React.ReactNode[] = [];
  for (let i = 0; i < items.length; i++) {
    const m = items[i];
    const next = items[i + 1];
    if (m.leg === "taskly->bot" && next && next.leg === "bot->taskly") {
      blocks.push(
        <div key={m.id} className="border-b border-border border-l-2 border-l-muted-foreground bg-background">
          <MsgRow m={m} />
          <MsgRow m={next} />
        </div>,
      );
      i++;
    } else {
      blocks.push(<MsgRow key={m.id} m={m} />);
    }
  }
  return (
    <div className="overflow-hidden rounded-[var(--radius)] border border-border bg-card">
      {blocks.length ? (
        blocks
      ) : (
        <p className="px-3.5 py-6 text-center text-muted-foreground">No messages yet — nothing has moved through the bridge.</p>
      )}
    </div>
  );
}

export function MessagesPage(): React.JSX.Element {
  const [items, setItems] = useState<Message[] | null>(null);
  const [total, setTotal] = useState(0);
  const [unseen, setUnseen] = useState(0);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const busyRef = useRef(false);
  const itemsRef = useRef<Message[]>([]);
  itemsRef.current = items ?? [];

  useEffect(() => {
    let live = true;
    get<List<Message>>(`/api/messages?limit=${LIMIT}`)
      .then((l) => {
        if (!live) return;
        setItems(l.items);
        setTotal(l.total);
      })
      .catch((e: unknown) => {
        if (live) setError(e instanceof Error ? e.message : String(e));
      });
    const off = subscribe((type, data) => {
      if (type !== "message") return;
      const m = norm(data as SseMessage);
      setItems((prev) => (prev ? [m, ...prev] : prev));
      setTotal((t) => t + 1);
      // At the top: render straight in. Scrolled down: count it behind the pill.
      if (window.scrollY < 8) return;
      setUnseen((u) => u + 1);
    });
    return () => {
      live = false;
      off();
    };
  }, []);

  async function older(): Promise<void> {
    const cur = itemsRef.current;
    if (busyRef.current || cur.length === 0) return;
    busyRef.current = true;
    setBusy(true);
    setNotice("");
    try {
      const page = await get<List<Message>>(`/api/messages?limit=50&before=${encodeURIComponent(cur[cur.length - 1].at)}`);
      const seen = new Set(cur.map((m) => m.id));
      setItems((prev) => (prev ? prev.concat(page.items.filter((m) => !seen.has(m.id))) : prev));
      setTotal(page.total);
    } catch (e: unknown) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  function showLatest(): void {
    setUnseen(0);
    window.scrollTo({ top: 0 });
  }

  if (error) {
    return (
      <div>
        <PageHeader title="Messages" />
        <Alert variant="destructive">{error}</Alert>
      </div>
    );
  }

  if (!items) {
    return (
      <div>
        <PageHeader title="Messages" sub="live four-leg feed" />
        <Skeleton className="h-[400px]" />
      </div>
    );
  }

  return (
    <div>
      <PageHeader title="Messages" sub={`live four-leg feed · showing ${items.length}${total > items.length ? ` of ${total}` : ""}`} />
      <div className="mb-3 flex flex-wrap items-center gap-3">
        {unseen > 0 ? (
          <Button size="sm" onClick={showLatest}>
            {unseen} new — show latest
          </Button>
        ) : null}
        <Button size="sm" onClick={() => void older()} disabled={busy || items.length === 0}>
          Older
        </Button>
        <span className="text-xs text-muted-foreground">provider dollar figures appear on this page only</span>
      </div>
      {notice ? (
        <Alert variant="destructive" className="mb-3">
          {notice}
        </Alert>
      ) : null}
      <Feed items={items} />
    </div>
  );
}
