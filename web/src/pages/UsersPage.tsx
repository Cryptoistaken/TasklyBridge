import { useEffect, useState } from "react";
import { get, type List, type User, type UserStatus } from "@/lib/api";
import { when } from "@/lib/format";
import { PageHeader } from "@/components/PageHeader";
import { StatGrid, StatTile } from "@/components/StatTile";
import { DataTable, Td } from "@/components/DataTable";
import { StatusChip } from "@/components/StatusChip";
import { Alert } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";

// Users — one row per end user with their joined job. Anyone with no account
// assigned shows as waiting.

function shownStatus(u: User): UserStatus {
  return u.account_id ? u.status : "waiting";
}

export function UsersPage(): React.JSX.Element {
  const [items, setItems] = useState<User[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    get<List<User>>("/api/users")
      .then((l) => {
        if (live) setItems(l.items);
      })
      .catch((e: unknown) => {
        if (live) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      live = false;
    };
  }, []);

  if (error) {
    return (
      <div>
        <PageHeader title="Users" />
        <Alert variant="destructive">{error}</Alert>
      </div>
    );
  }

  if (!items) {
    return (
      <div>
        <PageHeader title="Users" sub="end users and the job they joined" />
        <StatGrid>
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-[118px]" />
          ))}
        </StatGrid>
      </div>
    );
  }

  const n = (fn: (u: User) => boolean): number => items.filter(fn).length;

  return (
    <div>
      <PageHeader title="Users" sub="end users and the job they joined" />
      <StatGrid>
        <StatTile label="Total" value={String(items.length)} />
        <StatTile label="Joined" value={String(n((u) => u.status === "joined"))} />
        <StatTile label="Waiting" value={String(n((u) => !u.account_id || u.status === "waiting"))} />
        <StatTile label="Stopped" value={String(n((u) => u.status === "stopped"))} />
      </StatGrid>
      <div className="mt-7">
        <DataTable
          columns={[
            { label: "User" },
            { label: "Status" },
            { label: "Joined job" },
            { label: "Account" },
            { label: "Messages", num: true },
            { label: "Joined" },
            { label: "Last seen" },
          ]}
          empty={items.length === 0 ? "No users yet." : undefined}
        >
          {items.map((u) => {
            const shown = shownStatus(u);
            return (
              <tr key={u.id}>
                <Td>
                  <div>{u.name || "—"}</div>
                  {u.username ? <div className="font-mono text-xs text-muted-foreground">@{u.username}</div> : null}
                </Td>
                <Td>
                  <StatusChip text={shown} tone={shown === "joined" ? "ok" : "muted"} />
                </Td>
                <Td className="font-mono">{u.task_name || <span className="text-muted-foreground">—</span>}</Td>
                <Td className="whitespace-nowrap">
                  {u.account_id ? (
                    <span className="font-mono">{u.account_id}</span>
                  ) : (
                    <span className="text-xs text-muted-foreground">no account</span>
                  )}
                </Td>
                <Td num className="font-mono">
                  {u.messages}
                </Td>
                <Td className="font-mono whitespace-nowrap text-muted-foreground">{when(u.joined_at)}</Td>
                <Td className="font-mono whitespace-nowrap text-muted-foreground">{when(u.last_seen)}</Td>
              </tr>
            );
          })}
        </DataTable>
      </div>
    </div>
  );
}
