import { useEffect, useState } from "react";
import { get, type Alert, type AlertLevel, type List, type SseAlert } from "@/lib/api";
import { when } from "@/lib/format";
import { subscribe } from "@/lib/bus";
import { PageHeader } from "@/components/PageHeader";
import { StatGrid, StatTile } from "@/components/StatTile";
import { DataTable, Td } from "@/components/DataTable";
import { StatusChip } from "@/components/StatusChip";
import { Alert as UiAlert } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";

// Alerts — price and availability history. Severity ordered, unread first,
// full message always visible.

const RANK: Record<AlertLevel, number> = { critical: 0, warning: 1, info: 2 };

function sorted(items: Alert[]): Alert[] {
  return [...items].sort((a, b) => {
    if (a.read !== b.read) return a.read ? 1 : -1;
    if (RANK[a.level] !== RANK[b.level]) return RANK[a.level] - RANK[b.level];
    return b.at.localeCompare(a.at);
  });
}

export function AlertsPage(): React.JSX.Element {
  const [items, setItems] = useState<Alert[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    get<List<Alert>>("/api/alerts")
      .then((l) => {
        if (live) setItems(l.items);
      })
      .catch((e: unknown) => {
        if (live) setError(e instanceof Error ? e.message : String(e));
      });
    const off = subscribe((type, data) => {
      if (type !== "alert") return;
      const d = data as SseAlert;
      const at = d.at ?? new Date().toISOString();
      setItems((prev) =>
        prev
          ? [
              {
                id: d.id ?? at,
                level: d.level,
                kind: d.kind ?? "price",
                job: d.job ?? "",
                message: d.message,
                read: d.read ?? false,
                at,
              },
              ...prev,
            ]
          : prev,
      );
    });
    return () => {
      live = false;
      off();
    };
  }, []);

  if (error) {
    return (
      <div>
        <PageHeader title="Alerts" />
        <UiAlert variant="destructive">{error}</UiAlert>
      </div>
    );
  }

  if (!items) {
    return (
      <div>
        <PageHeader title="Alerts" sub="critical first among unread · availability alerts are critical" />
        <StatGrid>
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-[118px]" />
          ))}
        </StatGrid>
      </div>
    );
  }

  const rows = sorted(items);
  const unreadCrit = items.some((a) => !a.read && a.level === "critical");

  return (
    <div>
      <PageHeader title="Alerts" sub="critical first among unread · availability alerts are critical" />
      <StatGrid>
        <StatTile label="Unread" value={String(items.filter((a) => !a.read).length)} bad={unreadCrit} />
        <StatTile
          label="Critical"
          value={String(items.filter((a) => a.level === "critical").length)}
          bad={items.some((a) => a.level === "critical")}
        />
        <StatTile label="Warning" value={String(items.filter((a) => a.level === "warning").length)} />
        <StatTile label="Total" value={String(items.length)} />
      </StatGrid>
      <div className="mt-7">
        <p className="mb-2.5 text-xs text-muted-foreground">
          The API exposes no mark-as-read route, so read state is display only.
        </p>
        <DataTable
          columns={[{ label: "Level" }, { label: "Kind" }, { label: "Job" }, { label: "Message" }, { label: "Time" }]}
          empty={rows.length === 0 ? "No alerts." : undefined}
        >
          {rows.map((a) => (
            <tr key={a.id}>
              <Td>
                <StatusChip text={a.level} tone={a.level === "critical" ? "bad" : a.level === "warning" ? "muted" : "ok"} />
              </Td>
              <Td className={`font-mono whitespace-nowrap ${a.level === "critical" ? "text-destructive" : ""}`}>{a.kind}</Td>
              <Td className="font-mono whitespace-nowrap text-muted-foreground">{a.job || "—"}</Td>
              <Td className={a.level === "critical" ? "text-destructive" : undefined}>{a.message}</Td>
              <Td className="font-mono whitespace-nowrap text-muted-foreground">{when(a.at)}</Td>
            </tr>
          ))}
        </DataTable>
      </div>
    </div>
  );
}
