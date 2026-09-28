// Overview — answers one question in one glance: is the service working, and
// am I losing money on it. selling_at_loss leads.

import { get, takeOverview, type Overview } from "../api";
import { bdt, h, pageHead, statRow, usd, when, type Page } from "../ui";

let view: HTMLElement | null = null;

/** The provider's cost in Taka. The payload has no rate, so invert the margin. */
function costBdt(o: Overview): number {
  return o.task.sell_bdt - o.task.margin_bdt;
}

function lossBanner(o: Overview): HTMLElement | null {
  const t = o.task;
  if (!t.selling_at_loss) return null;
  const loss = Math.abs(t.margin_bdt);
  return h(
    "div",
    { class: "banner", role: "alert" },
    h("span", { class: "banner-tag", text: "SELLING AT LOSS" }),
    h("span", { class: "banner-text" }, `${t.name}: we charge ${bdt(t.sell_bdt)} but pay ${bdt(costBdt(o))} (provider ${usd(t.provider_cost)}).`),
    h("span", { class: "banner-text" }, `Losing ${bdt(loss)} on every sale.`),
  );
}

function body(o: Overview): HTMLElement {
  const t = o.task;
  const a = o.accounts;
  const dead = a.banned + a.dead;

  return h(
    "div",
    {},
    pageHead("Overview", `last checked ${when(o.last_checked)}`),
    lossBanner(o),
    statRow([
      {
        label: "Job",
        value: t.available ? "AVAILABLE" : "UNAVAILABLE",
        sub: t.name || "no job configured",
        bad: !t.available,
      },
      {
        label: "Accounts",
        value: `${a.connected} / ${a.total}`,
        sub: `${a.degraded} degraded · ${a.banned} banned · ${a.dead} dead`,
        bad: dead > 0,
      },
      {
        label: "Margin",
        value: bdt(t.margin_bdt),
        sub: `sell ${bdt(t.sell_bdt)} · cost ${usd(t.provider_cost)} ≈ ${bdt(costBdt(o))}`,
        bad: t.margin_bdt < 0,
      },
      {
        label: "Users",
        value: `${o.users.joined} joined`,
        sub: `${o.users.total} total · ${o.users.waiting} waiting`,
      },
      { label: "Balance", value: usd(o.balance_total), sub: "provider balance" },
      { label: "Alerts", value: String(o.alerts_unread), sub: "unread" },
      {
        label: "Withdrawals",
        value: o.withdraw_dry_run ? "DRY RUN" : "LIVE",
        sub: o.withdraw_dry_run ? "nothing is sent" : "real payouts enabled",
        bad: !o.withdraw_dry_run,
      },
    ]),
    h(
      "p",
      { class: "muted small", style: "margin-top:16px" },
      h("span", { class: "mono", text: usd(t.provider_cost) }),
      " is the provider's cost in dollars — our cost, not our sell price. Sell price is the static Taka figure.",
    ),
  );
}

async function refresh(): Promise<void> {
  const o = takeOverview() ?? (await get<Overview>("/api/overview"));
  view?.replaceChildren(body(o));
}

export const overview: Page = {
  mount(el) {
    view = el;
    return refresh();
  },
  async event(type) {
    if (!view) return;
    if (type !== "account" && type !== "alert" && type !== "withdrawal") return;
    try {
      const o = await get<Overview>("/api/overview");
      view.replaceChildren(body(o));
    } catch {
      // keep the last good snapshot rather than blanking the page
    }
  },
  dispose() {
    view = null;
  },
};
