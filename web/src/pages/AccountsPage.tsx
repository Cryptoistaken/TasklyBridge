import { useEffect, useState } from "react";
import { get, type Account, type List, type SseAccount } from "@/lib/api";
import { fmtDuration, usd, when } from "@/lib/format";
import { subscribe } from "@/lib/bus";
import { PageHeader } from "@/components/PageHeader";
import { StatGrid, StatTile } from "@/components/StatTile";
import { DataTable, Td } from "@/components/DataTable";
import { StatusChip, toneForState } from "@/components/StatusChip";
import { Alert } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";

// Accounts — the state column is the point of this page. An account about to
// die is the single most expensive thing here, so state is never subtle.

function FloodWait({ seconds }: { seconds: number }): React.JSX.Element {
  if (seconds <= 0) return <span className="text-muted-foreground">—</span>;
  // Shell ticks every [data-until] each second; no polling loop here.
  return (
    <span className="font-mono text-muted-foreground" data-until={String(Date.now() + seconds * 1000)}>
      {fmtDuration(seconds)}
    </span>
  );
}

export function AccountsPage(): React.JSX.Element {
  const [items, setItems] = useState<Account[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    get<List<Account>>("/api/accounts")
      .then((l) => {
        if (live) setItems(l.items);
      })
      .catch((e: unknown) => {
        if (live) setError(e instanceof Error ? e.message : String(e));
      });
    // Live state patches from the one SSE connection owned by App.
    const off = subscribe((type, data) => {
      if (type !== "account") return;
      const upd = data as SseAccount;
      setItems((prev) => (prev ? prev.map((a) => (a.id === upd.id ? { ...a, ...upd } : a)) : prev));
    });
    return () => {
      live = false;
      off();
    };
  }, []);

  if (error) {
    return (
      <div>
        <PageHeader title="Accounts" />
        <Alert variant="destructive">{error}</Alert>
      </div>
    );
  }

  if (!items) {
    return (
      <div>
        <PageHeader title="Accounts" sub="one row per phone number · state is what costs money" />
        <StatGrid>
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-[118px]" />
          ))}
        </StatGrid>
      </div>
    );
  }

  const n = (fn: (a: Account) => boolean): number => items.filter(fn).length;
  const bad = n((a) => a.state === "banned" || a.state === "dead");

  return (
    <div>
      <PageHeader title="Accounts" sub="one row per phone number · state is what costs money" />
      <StatGrid>
        <StatTile label="Total" value={String(items.length)} />
        <StatTile label="Connected" value={String(n((a) => a.state === "connected"))} />
        <StatTile label="Free" value={String(n((a) => a.state === "free"))} />
        <StatTile label="Degraded" value={String(n((a) => a.state === "degraded"))} sub="flood-wait or at risk" />
        <StatTile label="Banned / dead" value={String(bad)} bad={bad > 0} />
      </StatGrid>
      <div className="mt-7">
        <DataTable
          columns={[
            { label: "State" },
            { label: "Phone" },
            { label: "Balance", num: true },
            { label: "Assigned user" },
            { label: "Sent", num: true },
            { label: "Flood-wait", num: true },
            { label: "Last seen" },
            { label: "Note" },
          ]}
          empty={items.length === 0 ? "No accounts yet." : undefined}
        >
          {items.map((a) => (
            <tr key={a.id}>
              <Td>
                <StatusChip text={a.state} tone={toneForState(a.state)} />
              </Td>
              <Td className="font-mono whitespace-nowrap">{a.phone || "—"}</Td>
              <Td num className="font-mono">
                {usd(a.balance)}
              </Td>
              <Td>
                {a.assigned_user_id ? (
                  <div>
                    <div>{a.assigned_user_name || "—"}</div>
                    <div className="font-mono text-xs text-muted-foreground">{a.assigned_user_id}</div>
                  </div>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </Td>
              <Td num className="font-mono">
                {a.messages_sent}
              </Td>
              <Td num>
                <FloodWait seconds={a.flood_wait_seconds} />
              </Td>
              <Td className="font-mono whitespace-nowrap text-muted-foreground">{when(a.last_seen)}</Td>
              <Td className="text-xs text-muted-foreground">{a.note || <span>—</span>}</Td>
            </tr>
          ))}
        </DataTable>
      </div>
    </div>
  );
}
