import { useEffect, useState } from "react";
import { get, post, type Account, type List, type SseAccount } from "@/lib/api";
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
  // drafts holds the in-progress user id per account row, and busy marks the
  // row whose assignment is in flight. Neither belongs in the item itself:
  // typing must not round-trip through the server on every keystroke.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string>("");
  const [flash, setFlash] = useState("");

  // assign binds an account to an end user, or releases it with 0.
  //
  // This is the control that makes more than one user possible. The server
  // refuses when that user is already served by another account, and the reason
  // is shown rather than swallowed: two accounts serving one user is how the
  // provider ends up reading one person's job as another's cancel.
  const assign = async (accountID: string, userID: number): Promise<void> => {
    setBusy(accountID);
    setFlash("");
    setError("");
    try {
      await post(`/api/accounts/${encodeURIComponent(accountID)}/assign`, { user_id: userID });
      const fresh = await get<List<Account>>("/api/accounts");
      setItems(fresh.items);
      setDrafts((p) => ({ ...p, [accountID]: "" }));
      setFlash(
        userID
          ? `${accountID} now serves user ${userID}. The bot will route their messages to it.`
          : `${accountID} released. Nobody is served by it until it is assigned.`,
      );
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  };

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

  if (error && !items) {
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
      <PageHeader
        title="Accounts"
        sub="one row per Telegram account · each one serves exactly one end user"
      />
      <StatGrid>
        <StatTile label="Total" value={String(items.length)} />
        <StatTile
          label="Assigned"
          value={String(n((a) => Boolean(a.assigned_user_id)))}
          sub="accounts with an end user"
        />
        <StatTile
          label="With session"
          value={String(n((a) => a.has_session))}
          sub="ready to connect"
        />
        <StatTile label="Free" value={String(n((a) => a.state === "free"))} />
        <StatTile
          label="Banned / dead"
          value={String(bad)}
          bad={bad > 0}
        />
      </StatGrid>
      {error ? <Alert variant="destructive" className="mt-5">{error}</Alert> : null}
      {flash ? (
        <p className="mt-5 text-sm text-muted-foreground" role="status">
          {flash}
        </p>
      ) : null}
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
                {/* A balance nobody has read is not $0.0000. The API says so
                    with balance_known, and this cell was printing the zero
                    underneath it anyway - the one page in the dashboard that
                    turned "unknown" into a real-looking number, which is the
                    exact thing the flags exist to prevent. */}
                {a.balance_known ? usd(a.balance) : <span className="muted">unread</span>}
              </Td>
              <Td>
                {a.assigned_user_id ? (
                  <div>
                    <div className="font-mono text-xs">{a.assigned_user_id}</div>
                    <button
                      className="text-xs text-muted-foreground underline"
                      type="button"
                      onClick={() => void assign(a.id, 0)}
                      disabled={busy === a.id}
                    >
                      release
                    </button>
                  </div>
                ) : (
                  <div>
                    <span className="text-muted-foreground">unassigned</span>
                    <div className="mt-1 flex items-center gap-1">
                      <input
                        className="w-24 rounded-[var(--radius)] border border-border bg-background px-1.5 py-0.5 font-mono text-xs"
                        placeholder="telegram id"
                        value={drafts[a.id] ?? ""}
                        inputMode="numeric"
                        onChange={(e) => setDrafts((p) => ({ ...p, [a.id]: e.target.value }))}
                      />
                      <button
                        className="rounded-[var(--radius)] border border-border px-1.5 py-0.5 text-xs"
                        type="button"
                        disabled={busy === a.id || !(drafts[a.id] ?? "").trim()}
                        onClick={() => void assign(a.id, Number((drafts[a.id] ?? "").trim()))}
                      >
                        {busy === a.id ? "…" : "assign"}
                      </button>
                    </div>
                  </div>
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
