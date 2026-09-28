import { useEffect, useState } from "react";
import { get, post, type Task, type TaskList } from "@/lib/api";
import { invalidateOverview } from "@/lib/bus";
import { bdt, usd } from "@/lib/format";
import { PageHeader } from "@/components/PageHeader";
import { StatGrid, StatTile } from "@/components/StatTile";
import { DataTable, Td } from "@/components/DataTable";
import { StatusChip } from "@/components/StatusChip";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

// Tasks — the catalogue. Our sell price and the provider's cost are
// deliberately shown side by side, in different units, because the gap between
// them is the whole business.

function stateOf(t: Task): { text: string; tone: "ok" | "muted" | "bad" } {
  if (!t.enabled) return { text: "hidden", tone: "muted" };
  if (!t.available) return { text: "unavailable", tone: "bad" };
  return { text: "offered", tone: "ok" };
}

export function TasksPage(): React.JSX.Element {
  const [items, setItems] = useState<Task[] | null>(null);
  const [bdtRate, setBdtRate] = useState(0);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");

  useEffect(() => {
    let live = true;
    get<TaskList>("/api/tasks")
      .then((l) => {
        if (!live) return;
        setItems(l.items);
        setBdtRate(l.bdt_rate);
      })
      .catch((e: unknown) => {
        if (live) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      live = false;
    };
  }, []);

  async function toggle(t: Task): Promise<void> {
    setActionError("");
    try {
      await post(`/api/tasks/${encodeURIComponent(t.id)}/enabled`, { enabled: !t.enabled });
      const l = await get<TaskList>("/api/tasks");
      setItems(l.items);
      setBdtRate(l.bdt_rate);
      // The Overview leads with this job, so hiding it here has to change the
      // Overview too or the two pages disagree until a reload.
      invalidateOverview();
    } catch (e: unknown) {
      setActionError(e instanceof Error ? e.message : String(e));
    }
  }

  if (error) {
    return (
      <div>
        <PageHeader title="Tasks" />
        <Alert variant="destructive">{error}</Alert>
      </div>
    );
  }

  if (!items) {
    return (
      <div>
        <PageHeader title="Tasks" sub="margin = sell price minus provider cost in Taka" />
        <StatGrid>
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-[118px]" />
          ))}
        </StatGrid>
      </div>
    );
  }

  const losses = items.filter((t) => t.margin_bdt < 0).length;
  const st = stateOf;

  return (
    <div>
      <PageHeader
        title="Tasks"
        sub={
          bdtRate
            ? `bdt rate ${bdtRate} tk/$ · margin = sell price minus provider cost in Taka`
            : "margin = sell price minus provider cost in Taka"
        }
      />
      <StatGrid>
        <StatTile label="Offered" value={String(items.filter((t) => t.enabled && t.available).length)} />
        <StatTile
          label="Unavailable"
          value={String(items.filter((t) => t.enabled && !t.available).length)}
          bad={items.some((t) => t.enabled && !t.available)}
        />
        <StatTile label="Hidden" value={String(items.filter((t) => !t.enabled).length)} sub="we do not sell these" />
        <StatTile label="At a loss" value={String(losses)} sub="negative margin" bad={losses > 0} />
      </StatGrid>
      <div className="mt-7">
        {actionError ? (
          <Alert variant="destructive" className="mb-3">
            {actionError}
          </Alert>
        ) : null}
        <p className={`mb-2.5 text-xs ${losses ? "text-destructive" : "text-muted-foreground"}`}>
          {losses ? "Negative margin is destructive red: we lose money on every sale." : "No job is currently at a loss."}
        </p>
        <DataTable
          columns={[
            { label: "Our job" },
            { label: "Sell price", num: true },
            { label: "Provider cost (USD)", num: true },
            { label: "Margin", num: true },
            { label: "State" },
            { label: "" },
          ]}
          empty={items.length === 0 ? "The catalogue is empty — nothing is offered." : undefined}
        >
          {items.flatMap((t) => {
            const s = st(t);
            // Unknown cost/margin render as a dash, never as a zero: a zero
            // cost would look like the provider giving the job away free.
            const neg = t.margin_known && t.margin_bdt < 0;
            return [
              <tr key={t.id}>
                <Td>
                  <div>{t.name}</div>
                  <div className="font-mono text-xs text-muted-foreground">{t.id}</div>
                </Td>
                <Td num className="font-mono">
                  {bdt(t.sell_bdt)}
                </Td>
                <Td num className="font-mono text-muted-foreground">
                  {usd(t.provider_price_known ? t.provider_price : null)}
                </Td>
                <Td num className={`font-mono ${neg ? "text-destructive" : ""}`}>
                  {bdt(t.margin_known ? t.margin_bdt : null)}
                </Td>
                <Td>
                  <StatusChip text={s.text} tone={s.tone} />
                </Td>
                <Td>
                  <Button size="sm" onClick={() => void toggle(t)}>
                    {t.enabled ? "Hide" : "Show"}
                  </Button>
                </Td>
              </tr>,
              <tr key={`${t.id}-sub`}>
                <Td colSpan={6} className="bg-background pt-0 pb-3 text-xs text-muted-foreground">
                  <div className="font-mono">
                    match {t.require_all.map((r) => `"${r}"`).join(" + ")}
                    {t.provider_name ? ` → provider "${t.provider_name}"` : " → no provider job matched"}
                  </div>
                  <div>{t.hidden.length ? `withheld: ${t.hidden.join(" · ")}` : "nothing withheld from this job"}</div>
                </Td>
              </tr>,
            ];
          })}
        </DataTable>
      </div>
    </div>
  );
}
