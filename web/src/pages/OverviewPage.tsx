import { useEffect, useState } from "react";
import { get, type Overview } from "@/lib/api";
import { bdt, usd, when } from "@/lib/format";
import { PageHeader } from "@/components/PageHeader";
import { StatGrid, StatTile } from "@/components/StatTile";
import { Alert } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";

// Overview — answers one question in one glance: is the service working, and
// am I losing money on it. selling_at_loss leads.

/**
 * The provider's cost in Taka, or null when it cannot be known yet.
 * Derived from the margin the backend already computed. Null rather than a
 * number when the margin is not known, because a zero here would say the job
 * is free.
 */
function costBdt(o: Overview): number | null {
  if (!o.task.margin_known) return null;
  return o.task.sell_bdt - o.task.margin_bdt;
}

function LossBanner({ o }: { o: Overview }): React.JSX.Element | null {
  const t = o.task;
  if (!t.selling_at_loss) return null;
  const loss = Math.abs(t.margin_bdt);
  return (
    <Alert variant="destructive" className="mb-5 flex flex-wrap items-center gap-3.5 px-[18px] py-4">
      <span className="text-base font-bold tracking-[0.04em]">SELLING AT LOSS</span>
      <span className="font-mono text-sm font-medium">
        {t.name}: we charge {bdt(t.sell_bdt)} but pay {bdt(costBdt(o))} (provider {usd(t.provider_cost)}).
      </span>
      <span className="font-mono text-sm font-medium">Losing {bdt(loss)} on every sale.</span>
    </Alert>
  );
}

export function OverviewPage({ initial }: { initial?: Overview | null }): React.JSX.Element {
  const [o, setO] = useState<Overview | null>(initial ?? null);
  const [error, setError] = useState("");

  useEffect(() => {
    // The boot request doubles as the auth probe; its result is handed in so
    // the first paint costs no extra round trip.
    if (initial) return;
    let live = true;
    get<Overview>("/api/overview")
      .then((v) => {
        if (live) setO(v);
      })
      .catch((e: unknown) => {
        if (live) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      live = false;
    };
  }, [initial]);

  if (error) {
    return (
      <div>
        <PageHeader title="Overview" />
        <Alert variant="destructive">
          <span className="text-[11px] tracking-[0.08em] text-destructive uppercase">Error</span>
          <p className="mt-1">{error}</p>
        </Alert>
      </div>
    );
  }

  if (!o) {
    return (
      <div>
        <PageHeader title="Overview" />
        <StatGrid>
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-[118px]" />
          ))}
        </StatGrid>
      </div>
    );
  }

  const t = o.task;
  const a = o.accounts;
  const dead = a.banned + a.dead;

  return (
    <div>
      <PageHeader title="Overview" sub={`last checked ${when(o.last_checked)}`} />
      <LossBanner o={o} />
      <StatGrid>
        <StatTile
          label="Job"
          value={t.available ? "AVAILABLE" : "UNAVAILABLE"}
          sub={t.name || "no job configured"}
          bad={!t.available}
        />
        <StatTile
          label="Accounts"
          value={`${a.connected} / ${a.total}`}
          sub={`${a.degraded} degraded · ${a.banned} banned · ${a.dead} dead`}
          bad={dead > 0}
        />
        <StatTile
          label="Margin"
          // Unknown until the watcher has polled. It must not read as a
          // healthy zero-margin while the cost is simply not known yet.
          value={bdt(t.margin_known ? t.margin_bdt : null)}
          sub={
            t.cost_known
              ? `sell ${bdt(t.sell_bdt)} · cost ${usd(t.provider_cost)} ≈ ${bdt(costBdt(o))}`
              : t.available
                ? `sell ${bdt(t.sell_bdt)} · provider cost not polled yet`
                : `sell ${bdt(t.sell_bdt)} · withdrawn, so the provider quotes no price`
          }
          bad={t.margin_known && t.margin_bdt < 0}
        />
        <StatTile label="Users" value={`${o.users.joined} joined`} sub={`${o.users.total} total · ${o.users.waiting} waiting`} />
        {/* A balance nobody has read from the provider is not $0.0000. The API
            sends balance_known; this tile was printing the zero underneath it,
            so a disconnected bridge looked like a broke one. */}
        <StatTile
          label="Balance"
          value={usd(o.balance_known ? o.balance_total : null)}
          sub={o.balance_known ? "provider balance" : "not read from the provider yet"}
        />
        <StatTile label="Alerts" value={String(o.alerts_unread)} sub="unread" />
        <StatTile
          label="Withdrawals"
          value={o.withdraw_dry_run ? "DRY RUN" : "LIVE"}
          sub={o.withdraw_dry_run ? "nothing is sent" : "real payouts enabled"}
          bad={!o.withdraw_dry_run}
        />
      </StatGrid>
      <p className="mt-4 text-xs text-muted-foreground">
        <span className="font-mono">{usd(t.cost_known ? t.provider_cost : null)}</span> is the provider&apos;s cost in
        dollars — our cost, not our sell price. Sell price is the static Taka figure.
      </p>
    </div>
  );
}
