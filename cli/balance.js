import { sessionState, listUsers, userRows, owedFor } from "./store.js";

// Pure: session_state cache in, three tables of data out. Live reads never
// happen here — the entry refreshes the cache first when asked.
export function report(s, { rate, priceUsd }) {
  const r = Number(rate), p = Number(priceUsd);
  const priced = Number.isFinite(r) && r > 0 && Number.isFinite(p) && p > 0;
  const total = priced ? p * r : null;
  const sessions = sessionState(s).map((row) => ({
    phone: row.phone,
    label: row.label,
    enabled: !!row.enabled,
    usd: row.balance_usd,
    bkt: row.balance_usd == null || !Number.isFinite(r) ? null : row.balance_usd * r,
    limitedUntil: row.rate_limit_until ?? null,
    seenAt: row.balance_at ?? null,
  }));
  const users = listUsers(s).map((u) => {
    const n = (st) => userRows(s, u.id, st).length;
    const approved = n(["approved"]), rejected = n(["rejected"]);
    const submitted = approved + rejected + n(["inflight", "half-used"]);
    const money = priced ? owedFor(s, u.id, total) : { approved, paid: 0, owed: null };
    const paid = priced ? money.paid : 0;
    return { handle: u.handle, submitted, approved, rejected,
      owed: priced ? money.owed : null, paid, unpaid: priced ? money.owed : null };
  });
  const sum = (k) => users.reduce((t, u) => t + (u[k] ?? 0), 0);
  const approvals = sum("approved");
  const revenue = total == null ? null : approvals * total;
  const owed = total == null ? null : sum("owed");
  const cut = revenue == null ? null : {
    approvals, revenue,
    owed, ours: revenue - owed,
    pct: revenue > 0 ? ((revenue - owed) / revenue) * 100 : 0,
  };
  const cash = sessions.reduce((t, x) => t + (x.bkt ?? 0), 0);
  const balanceKnown = sessions.some((x) => x.bkt != null);
  return {
    asOf: new Date().toISOString(),
    rate: priced ? r : null,
    priceUsd: priced ? p : null,
    totalBktPerApproval: total,
    sessions,
    totalBalanceUsd: sessions.reduce((t, x) => t + (x.usd ?? 0), 0),
    totalBalanceBkt: cash,
    users,
    totals: { submitted: sum("submitted"), approved: approvals,
      rejected: sum("rejected"), owed, paid: sum("paid"), unpaid: owed },
    cut,
    warning: priced && balanceKnown && owed != null ? owed > cash : false,
  };
}
