import { useEffect, useRef, useState } from "react";
import {
  ApiError,
  get,
  post,
  type List,
  type SessionList,
  type Settings,
  type Terms,
  type Withdrawal,
} from "@/lib/api";
import { usd, when } from "@/lib/format";
import { subscribe } from "@/lib/bus";
import { PageHeader } from "@/components/PageHeader";
import { StatGrid, StatTile } from "@/components/StatTile";
import { DataTable, Td } from "@/components/DataTable";
import { StatusChip, toneForState } from "@/components/StatusChip";
import { FormCard, Kv, Section, inputCls } from "@/components/Field";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

// Withdrawals — four steps, because this is the one screen that moves money:
// balances, preview, confirm, live progress.
//
// Two rules shape every line here. The provider deducts the fee from the
// amount, so `net` is only ever rendered as the server returned it — never
// recomputed on this side. And `created` means the provider accepted the
// request, which is not the money arriving, so no wording here may imply it.

// The shapes below mirror docs/api.md's POST /api/withdrawals section. They
// live here rather than in lib/api so this page's contract changes stay local.
interface PreviewLine {
  account_id: string;
  phone: string;
  balance: number;
  amount: number;
  fee: number;
  net: number;
  problem?: string;
}

interface PreviewTotals {
  accounts: number;
  total_balance: number;
  total_amount: number;
  total_fee: number;
  total_net: number;
  known_balance: boolean;
}

interface PreviewData {
  wallet: string;
  method: string;
  network: string;
  fee: number;
  minimum: number;
  lines: PreviewLine[];
  totals: PreviewTotals;
  warnings: string[];
}

interface ExecuteResult {
  account_id: string;
  phone: string;
  amount: number;
  fee: number;
  net: number;
  status: string;
  detail?: string;
}

interface ExecuteResponse {
  results: ExecuteResult[];
  totals: { amount: number; fee: number; net: number };
  note: string;
}

interface Progress {
  step: string;
  state: string;
  account?: string;
  phone?: string;
  amount?: number;
  fee?: number;
  net?: number;
  detail?: string;
}

interface Row {
  id: string;
  phone: string;
  state: string;
  inUse: boolean;
  balance: number;
  balanceKnown: boolean;
}

// A confirm that moves money gets the same two-step arm as the session
// delete: a fast double-click must land as one action, not two.
const ARM_DELAY = 750;

type Stage = "select" | "amounts" | "running" | "result";

/** `created` is never left standing on its own: the caption is the point. */
function StatusCell({ status }: { status: string }): React.JSX.Element {
  return (
    <div>
      <StatusChip text={status} tone={toneForState(status)} />
      {status === "created" ? (
        <p className="text-xs text-muted-foreground">provider accepted; arrival not confirmed</p>
      ) : status === "failed" ? (
        <p className="text-xs text-destructive">the provider refused this</p>
      ) : null}
    </div>
  );
}

/** An unknown balance is "unread", never a confident $0.0000. */
function Balance({ n, known }: { n: number; known: boolean }): React.JSX.Element {
  return known ? <span className="font-mono">{usd(n)}</span> : <span className="font-mono text-muted-foreground">unread</span>;
}

/** History wallets render truncated: the full address is only ever shown at
 *  the preview/confirm step, where the operator must verify the destination. */
function shortWallet(w: string): string {
  return w.length > 18 ? `${w.slice(0, 10)}…${w.slice(-6)}` : w;
}

export function WithdrawalsPage(): React.JSX.Element {
  const [rows, setRows] = useState<Row[] | null>(null);
  // The server's own count and total: rendered as sent, never recomputed here.
  const [totalBalance, setTotalBalance] = useState(0);
  const [balanceKnown, setBalanceKnown] = useState(true);
  const [selected, setSelected] = useState<string[]>([]);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [terms, setTerms] = useState<Terms | null>(null);
  const [wallet, setWallet] = useState("");
  const [dryRun, setDryRun] = useState(false);
  const [items, setItems] = useState<Withdrawal[] | null>(null);
  const [error, setError] = useState("");

  const [stage, setStage] = useState<Stage>("select");
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [stalePreview, setStalePreview] = useState(false);
  const [result, setResult] = useState<ExecuteResponse | null>(null);
  const [err, setErr] = useState("");
  const [progressErr, setProgressErr] = useState("");
  const [armed, setArmed] = useState(false);
  const [armedAt, setArmedAt] = useState(0);
  const [busy, setBusy] = useState(false);

  const [runStart, setRunStart] = useState<Progress | null>(null);
  const [runRows, setRunRows] = useState<Record<string, Progress>>({});
  const [runDone, setRunDone] = useState<Progress | null>(null);
  // Bumped on unmount so an in-flight confirm from an earlier visit cannot
  // write its result into this one.
  const runToken = useRef(0);

  useEffect(() => {
    let live = true;
    Promise.all([get<SessionList>("/api/sessions"), get<Settings>("/api/settings"), get<List<Withdrawal>>("/api/withdrawals")])
      .then(([ses, s, list]) => {
        if (!live) return;
        // The session list carries each balance and the server's own total; a
        // balance the server flags as unknown renders as "unread", never as a
        // confident $0.0000.
        setRows(
          ses.items.map((x) => ({
            id: x.id,
            phone: x.phone,
            state: x.state,
            inUse: x.in_use,
            balance: x.balance,
            balanceKnown: x.balance_known,
          })),
        );
        setTotalBalance(ses.total_balance);
        setBalanceKnown(ses.balance_known);
        setWallet(s.withdraw_wallet);
        setDryRun(s.withdraw_dry_run);
        setItems(list.items);
        return get<Terms>("/api/withdrawals/terms")
          .then((t) => {
            if (live) setTerms(t);
          })
          .catch(() => undefined);
      })
      .catch((e: unknown) => {
        if (live) setError(e instanceof Error ? e.message : String(e));
      });
    // Live progress frames from the one SSE connection owned by App.
    const off = subscribe((type, data) => {
      if (type !== "withdrawal") return;
      const p = (data as { progress?: Progress }).progress;
      if (!p) return;
      if (p.step === "start") setRunStart(p);
      else if (p.step === "done") setRunDone(p);
      else if (p.account) setRunRows((prev) => ({ ...prev, [p.account as string]: p }));
    });
    return () => {
      live = false;
      runToken.current++;
      off();
    };
  }, []);

  const rowOf = (id: string): Row | undefined => rows?.find((r) => r.id === id);

  function requestBody(confirm: boolean): {
    account_ids: string[];
    wallet: string;
    amounts: Record<string, number>;
    confirm: boolean;
  } {
    const amt: Record<string, number> = {};
    for (const id of selected) {
      const n = Number(amounts[id]);
      if (Number.isFinite(n) && n > 0) amt[id] = n;
    }
    // The wallet is sent explicitly so the address previewed is the address
    // that runs, even if settings change between the two calls.
    return { account_ids: [...selected], wallet, amounts: amt, confirm };
  }

  function toggle(id: string, on: boolean): void {
    setSelected((prev) => (on ? [...prev, id] : prev.filter((x) => x !== id)));
    setPreview(null); // the selection changed, so the numbers on screen no longer describe it
    setStalePreview(false);
    setArmed(false);
  }

  function onAmount(id: string, v: string): void {
    setAmounts((prev) => ({ ...prev, [id]: v }));
    // An amount changed, so the preview no longer describes it. The numbers
    // approved must be the numbers that run: flag it stale, do not clear it,
    // so the operator sees what changed against.
    if (preview) {
      setStalePreview(true);
      setArmed(false);
    }
  }

  async function runPreview(): Promise<void> {
    if (!selected.length) return;
    setErr("");
    setStalePreview(false);
    try {
      // Preview and execute are the SAME endpoint, distinguished by `confirm`.
      // Fee, minimum and balances are read live by the server on every call —
      // never cached here.
      const r = await post<{ preview: PreviewData }>("/api/withdrawals", requestBody(false));
      setPreview(r.preview);
    } catch (e: unknown) {
      setPreview(null);
      setArmed(false);
      setErr(e instanceof Error ? e.message : String(e)); // a 409 arrives here as the server's own message
    }
  }

  async function execute(): Promise<void> {
    if (busy || !preview) return;
    if (!armed) {
      setArmed(true);
      setArmedAt(Date.now());
      return;
    }
    if (Date.now() - armedAt < ARM_DELAY) return; // a double-click is one action

    setBusy(true);
    setArmed(false);
    setErr("");
    setProgressErr("");
    setRunStart(null);
    setRunRows({});
    setRunDone(null);
    setStage("running");

    const mine = ++runToken.current;
    try {
      const r = await post<ExecuteResponse>("/api/withdrawals", requestBody(true));
      if (mine !== runToken.current) return;
      setResult(r);
      setStage("result");
      setBusy(false);
      get<List<Withdrawal>>("/api/withdrawals")
        .then((l) => {
          if (mine !== runToken.current) return;
          setItems(l.items);
        })
        .catch(() => undefined);
    } catch (e: unknown) {
      if (mine !== runToken.current) return;
      setBusy(false);
      const status = e instanceof ApiError ? e.status : 0;
      if (status === 0) {
        // Unknown outcome: the request may have reached the server, so the live
        // rows stay on screen instead of pretending nothing started.
        setStage("running");
        setProgressErr(e instanceof Error ? e.message : String(e));
      } else {
        // Refused before anything ran (400 validation, 409 dry-run or busy).
        // The server's message is shown as it arrived; nothing is retried.
        setStage("amounts");
        setErr(e instanceof Error ? e.message : String(e));
      }
    }
  }

  function reset(): void {
    setStage("select");
    setSelected([]);
    setAmounts({});
    setPreview(null);
    setStalePreview(false);
    setResult(null);
    setErr("");
    setProgressErr("");
    setArmed(false);
    setBusy(false);
    setRunStart(null);
    setRunRows({});
    setRunDone(null);
  }

  if (error) {
    return (
      <div>
        <PageHeader title="Withdrawals" />
        <Alert variant="destructive">{error}</Alert>
      </div>
    );
  }

  if (!rows || !items) {
    return (
      <div>
        <PageHeader
          title="Withdrawals"
          sub="balances → preview → confirm → live progress · the provider never confirms arrival"
        />
        <StatGrid>
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-[118px]" />
          ))}
        </StatGrid>
      </div>
    );
  }

  const flow = stage === "select" || stage === "amounts";

  return (
    <div>
      <PageHeader
        title="Withdrawals"
        sub="balances → preview → confirm → live progress · the provider never confirms arrival"
      />

      {flow ? (
        <Section title="Step 1 · balances">
          <StatGrid>
            <StatTile label="Accounts" value={String(rows.length)} sub="with a stored session" />
            <StatTile label="Selected" value={String(selected.length)} />
            <StatTile
              label="Total balance"
              value={usd(balanceKnown ? totalBalance : null)}
              bad={!balanceKnown}
              sub={balanceKnown ? "as the server reported it" : "incomplete — at least one balance is unread"}
            />
          </StatGrid>
          <div className="mt-3">
            <DataTable
              columns={[
                { label: "" },
                { label: "Account" },
                { label: "Phone" },
                { label: "State" },
                { label: "In use" },
                { label: "Balance", num: true },
              ]}
              empty={rows.length === 0 ? "No sessions stored — create one on the Sessions page." : undefined}
            >
              {rows.map((r) => (
                <tr key={r.id}>
                  <Td>
                    <input
                      type="checkbox"
                      className="size-4 accent-white"
                      checked={selected.includes(r.id)}
                      onChange={(e) => toggle(r.id, e.target.checked)}
                    />
                  </Td>
                  <Td className="font-mono whitespace-nowrap">{r.id}</Td>
                  <Td className="font-mono whitespace-nowrap">{r.phone || "—"}</Td>
                  <Td>
                    <StatusChip text={r.state} tone={toneForState(r.state)} />
                  </Td>
                  <Td>{r.inUse ? <StatusChip text="in use" tone="ok" /> : <span className="text-muted-foreground">—</span>}</Td>
                  <Td num>
                    <Balance n={r.balance} known={r.balanceKnown} />
                  </Td>
                </tr>
              ))}
            </DataTable>
          </div>
          <div className="mt-3.5 flex flex-wrap items-center gap-3">
            {stage === "select" ? (
              <Button
                variant="default"
                disabled={selected.length === 0}
                onClick={() => {
                  if (selected.length) setStage("amounts");
                }}
              >
                {selected.length ? `Continue with ${selected.length} account(s)` : "Select at least one account"}
              </Button>
            ) : (
              <Button
                onClick={() => {
                  setStage("select");
                  setPreview(null);
                  setStalePreview(false);
                  setArmed(false);
                  setErr("");
                }}
              >
                Back to the account list
              </Button>
            )}
          </div>
        </Section>
      ) : null}

      {stage === "amounts" ? (
        <Section title="Step 2 · amounts, then preview">
          <FormCard>
            <div className="text-[11px] tracking-[0.08em] text-muted-foreground uppercase">Amount per selected account</div>
            {terms ? (
              <p className="mt-2.5 rounded-[var(--radius)] border border-border bg-background px-3 py-2.5 text-[13px] text-muted-foreground">
                {`Provider terms, read from the provider's message: ${terms.method} on ${terms.network}, fee ${usd(terms.fee)} deducted from every amount, minimum ${usd(terms.minimum)}.`}
              </p>
            ) : (
              <p className="mt-2.5 rounded-[var(--radius)] border border-border bg-background px-3 py-2.5 text-[13px] text-muted-foreground">
                Provider terms are unreachable right now. The preview still reads the fee and minimum before anything can run.
              </p>
            )}
            <div className="mt-3">
              <DataTable
                columns={[
                  { label: "Account" },
                  { label: "Phone" },
                  { label: "Balance", num: true },
                  { label: "Amount (USD)", num: true },
                ]}
              >
                {selected.map((id) => {
                  const r = rowOf(id);
                  return (
                    <tr key={id}>
                      <Td className="font-mono whitespace-nowrap">{id}</Td>
                      <Td className="font-mono whitespace-nowrap">{r?.phone || "—"}</Td>
                      <Td num>{r ? <Balance n={r.balance} known={r.balanceKnown} /> : <Balance n={0} known={false} />}</Td>
                      <Td num>
                        <input
                          className={inputCls}
                          type="number"
                          step="0.0001"
                          min="0"
                          inputMode="decimal"
                          placeholder="0.0000"
                          value={amounts[id] ?? ""}
                          onChange={(e) => onAmount(id, e.target.value)}
                        />
                      </Td>
                    </tr>
                  );
                })}
              </DataTable>
            </div>
            <div className="mt-3.5 flex flex-wrap items-center gap-3">
              <Button variant="default" onClick={() => void runPreview()}>
                Run the preview
              </Button>
            </div>
            {err ? (
              <Alert variant="destructive" className="mt-3">
                {err}
              </Alert>
            ) : null}
            {stalePreview ? (
              <Alert variant="destructive" className="mt-3">
                An amount changed, so the preview no longer describes it. Run the preview again — the numbers you approve
                are the numbers that run.
              </Alert>
            ) : null}
            {preview ? <PreviewCard p={preview} stale={stalePreview} /> : null}
            {preview && !stalePreview ? (
              <ConfirmCard
                p={preview}
                dryRun={dryRun}
                armed={armed}
                busy={busy}
                onRun={() => void execute()}
              />
            ) : null}
          </FormCard>
        </Section>
      ) : null}

      {stage === "running" || stage === "result" ? (
        <ProgressSection
          selected={selected}
          rowOf={rowOf}
          runStart={runStart}
          runRows={runRows}
          runDone={runDone}
          progressErr={progressErr}
          onBack={() => {
            setStage("amounts");
            setProgressErr("");
          }}
        />
      ) : null}

      {stage === "result" && result ? <ResultSection r={result} onReset={reset} /> : null}

      <Section title="History">
        <DataTable
          columns={[
            { label: "When" },
            { label: "Account" },
            { label: "Amount", num: true },
            { label: "Fee", num: true },
            { label: "Net", num: true },
            { label: "Wallet" },
            { label: "Status" },
          ]}
          empty={items.length === 0 ? "No withdrawals yet." : undefined}
        >
          {items.flatMap((w) => {
            const main = (
              <tr key={w.id}>
                <Td className="font-mono whitespace-nowrap">{when(w.at)}</Td>
                <Td className="font-mono whitespace-nowrap">{w.account_id}</Td>
                <Td num className="font-mono">
                  {usd(w.amount)}
                </Td>
                <Td num className="font-mono text-muted-foreground">
                  {usd(w.fee)}
                </Td>
                <Td num className="font-mono">
                  {usd(w.net)}
                </Td>
                <Td className="font-mono whitespace-nowrap">{shortWallet(w.wallet)}</Td>
                <Td>
                  <StatusCell status={w.status} />
                </Td>
              </tr>
            );
            return w.confirmation
              ? [
                  main,
                  <tr key={`${w.id}-conf`}>
                    <Td colSpan={7} className="bg-background pt-0 pb-3">
                      <div className="text-[11px] tracking-[0.06em] text-muted-foreground uppercase">
                        provider confirmation · verbatim
                      </div>
                      <div className="font-mono text-xs wrap-anywhere whitespace-pre-wrap text-muted-foreground">
                        {w.confirmation}
                      </div>
                    </Td>
                  </tr>,
                ]
              : [main];
          })}
        </DataTable>
      </Section>
    </div>
  );
}

function PreviewCard({ p, stale }: { p: PreviewData; stale: boolean }): React.JSX.Element {
  const refused = p.lines.some((l) => l.problem);
  return (
    <div className={`mt-3.5 rounded-[var(--radius)] border border-muted-foreground bg-card p-4 ${stale ? "opacity-60" : ""}`}>
      <div className="text-[11px] tracking-[0.08em] text-muted-foreground uppercase">Preview · dry run · nothing was sent</div>
      <div className="mt-3 flex flex-col gap-2">
        <div className="text-[11px] tracking-[0.08em] text-muted-foreground uppercase">
          Destination · in full, because a wrong address is unrecoverable
        </div>
        <div className="font-mono text-[13px] wrap-anywhere whitespace-normal">{p.wallet || "not configured"}</div>
      </div>
      <p className="mt-3 rounded-[var(--radius)] border border-border bg-background px-3 py-2.5 text-[13px] text-muted-foreground">
        {`The money moves as ${p.method} on the ${p.network} network. This is a ${p.network} address, not a Tron (TRC-20) address: USDT held on Tron cannot be sent to it, so be sure this is the address you intend.`}
      </p>
      <div className="mt-3">
        <Kv
          pairs={[
            ["Method", p.method],
            ["Network", p.network],
            ["Fee per account", usd(p.fee)],
            ["Minimum", usd(p.minimum)],
          ]}
        />
      </div>
      <div className="mt-4 text-[11px] tracking-[0.08em] text-muted-foreground uppercase">One row per account</div>
      <div className="mt-2">
        <DataTable
          columns={[
            { label: "Account" },
            { label: "Balance", num: true },
            { label: "Amount", num: true },
            { label: "Fee", num: true },
            { label: "Net", num: true },
            { label: "Problem" },
          ]}
        >
          {p.lines.map((l) => (
            <tr key={l.account_id}>
              <Td>
                <div className="font-mono">{l.account_id}</div>
                <div className="font-mono text-xs text-muted-foreground">{l.phone}</div>
              </Td>
              <Td num className="font-mono">
                {l.balance > 0 ? usd(l.balance) : <span className="text-muted-foreground">unread</span>}
              </Td>
              <Td num className="font-mono">
                {usd(l.amount)}
              </Td>
              <Td num className="font-mono text-muted-foreground">
                {usd(l.fee)}
              </Td>
              <Td num className="font-mono">
                {usd(l.net)}
              </Td>
              <Td className="text-xs">{l.problem ? <span className="text-destructive">{l.problem}</span> : <span className="text-muted-foreground">none</span>}</Td>
            </tr>
          ))}
        </DataTable>
      </div>
      <div className="mt-4">
        <div className="text-[11px] tracking-[0.08em] text-muted-foreground uppercase">Totals</div>
        <div className="mt-2">
          <Kv
            pairs={[
              ["Accounts", String(p.totals.accounts)],
              ["Total balance", usd(p.totals.total_balance)],
              ["Total amount", usd(p.totals.total_amount)],
              ["Total fee", usd(p.totals.total_fee)],
              ["Total net", usd(p.totals.total_net)],
            ]}
          />
        </div>
        {!p.totals.known_balance ? (
          <Alert variant="destructive" className="mt-2.5">
            At least one balance could not be read, so these totals are incomplete — not a final figure.
          </Alert>
        ) : null}
        {refused ? (
          <Alert className="mt-2.5">
            A refused line contributes nothing to these totals; the server has already excluded it.
          </Alert>
        ) : null}
      </div>
      {p.warnings.length ? (
        <div className="mt-3.5">
          <div className="text-[11px] tracking-[0.08em] text-muted-foreground uppercase">Warnings · verbatim</div>
          <ul className="mt-2 flex list-none flex-col gap-1.5">
            {p.warnings.map((w) => (
              <li key={w} className="text-[13px] text-destructive">
                {w}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function ConfirmCard({
  p,
  dryRun,
  armed,
  busy,
  onRun,
}: {
  p: PreviewData;
  dryRun: boolean;
  armed: boolean;
  busy: boolean;
  onRun: () => void;
}): React.JSX.Element {
  return (
    <div className="mt-3 rounded-[var(--radius)] border border-border bg-card p-4">
      <div className="text-[11px] tracking-[0.08em] text-muted-foreground uppercase">Step 3 · confirm and run</div>
      <div className="mt-2.5">
        <Kv
          pairs={[
            ["Accounts", String(p.totals.accounts)],
            ["Total net", usd(p.totals.total_net)],
            ["Total fee", usd(p.totals.total_fee)],
            ["Destination", <div className="font-mono text-[13px] wrap-anywhere whitespace-normal">{p.wallet || "not configured"}</div>],
          ]}
        />
      </div>
      <Alert variant="destructive" className="mt-2.5">
        The fee is deducted from each amount, not added to it. There is no confirmation step on the provider&apos;s side:
        running this IS the withdrawal.
      </Alert>
      {dryRun ? (
        <Alert variant="destructive" className="mt-2.5">
          WITHDRAW_DRY_RUN is on. The backend refuses the run with 409 and sends nothing.
        </Alert>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button variant="destructive" disabled={busy} onClick={onRun}>
          {armed ? "Confirm — run it now" : "Run the withdrawal"}
        </Button>
      </div>
      {armed ? (
        <Alert variant="destructive" className="mt-2.5">
          Armed. One more click runs it — check the net total and the destination above first.
        </Alert>
      ) : null}
    </div>
  );
}

function ProgressSection({
  selected,
  rowOf,
  runStart,
  runRows,
  runDone,
  progressErr,
  onBack,
}: {
  selected: string[];
  rowOf: (id: string) => Row | undefined;
  runStart: Progress | null;
  runRows: Record<string, Progress>;
  runDone: Progress | null;
  progressErr: string;
  onBack: () => void;
}): React.JSX.Element {
  return (
    <Section title="Step 4 · live progress">
      {progressErr ? (
        <Alert variant="destructive" className="mb-3">
          {progressErr}
        </Alert>
      ) : null}
      {runStart ? (
        <div className="mb-3 rounded-[var(--radius)] border border-border bg-background px-3 py-2.5">
          <div className="text-[11px] tracking-[0.08em] text-muted-foreground uppercase">Run start · the server&apos;s wording</div>
          <div className="mt-1.5 font-mono text-xs">{runStart.detail || ""}</div>
        </div>
      ) : null}
      <DataTable
        columns={[
          { label: "Account" },
          { label: "Amount", num: true },
          { label: "Fee", num: true },
          { label: "Net", num: true },
          { label: "State" },
        ]}
      >
        {selected.flatMap((id) => {
          const r = rowOf(id);
          const who = (
            <div>
              <div className="font-mono">{id}</div>
              <div className="font-mono text-xs text-muted-foreground">{r?.phone ?? ""}</div>
            </div>
          );
          const p = runRows[id];
          if (!p) {
            return [
              <tr key={id}>
                <Td>{who}</Td>
                <Td num className="font-mono text-muted-foreground">—</Td>
                <Td num className="font-mono text-muted-foreground">—</Td>
                <Td num className="font-mono text-muted-foreground">—</Td>
                <Td>
                  <StatusChip text="waiting" tone="muted" />
                </Td>
              </tr>,
            ];
          }
          const cells = (
            <tr key={id}>
              <Td>{who}</Td>
              <Td num className="font-mono">{p.amount ? usd(p.amount) : "—"}</Td>
              <Td num className="font-mono text-muted-foreground">{p.fee ? usd(p.fee) : "—"}</Td>
              <Td num className="font-mono">{p.net ? usd(p.net) : "—"}</Td>
              <Td>
                <StatusCell status={p.state} />
              </Td>
            </tr>
          );
          return p.detail
            ? [
                cells,
                <tr key={`${id}-detail`}>
                  <Td colSpan={5} className="bg-background pt-0 pb-3">
                    <div className="text-[11px] tracking-[0.06em] text-muted-foreground uppercase">verbatim</div>
                    <div className="font-mono text-xs wrap-anywhere whitespace-pre-wrap text-muted-foreground">{p.detail}</div>
                  </Td>
                </tr>,
              ]
            : [cells];
        })}
      </DataTable>
      {runDone ? (
        <div className="mt-3 rounded-[var(--radius)] border border-border bg-card p-4">
          <div className="text-[11px] tracking-[0.08em] text-muted-foreground uppercase">
            Run finished · the server&apos;s summary, verbatim
          </div>
          <div className="mt-2 font-mono text-xs wrap-anywhere whitespace-pre-wrap text-muted-foreground">{runDone.detail || ""}</div>
        </div>
      ) : null}
      {progressErr ? (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button onClick={onBack}>Back to the preview</Button>
        </div>
      ) : null}
    </Section>
  );
}

function ResultSection({ r, onReset }: { r: ExecuteResponse; onReset: () => void }): React.JSX.Element {
  return (
    <Section title="Result">
      <FormCard>
        <div className="text-[11px] tracking-[0.08em] text-muted-foreground uppercase">note · verbatim from the server</div>
        <div className="mt-2 font-mono text-xs wrap-anywhere whitespace-pre-wrap text-muted-foreground">{r.note}</div>
        <div className="mt-3.5">
          <Kv
            pairs={[
              ["Total amount", usd(r.totals.amount)],
              ["Total fee", usd(r.totals.fee)],
              ["Total net", usd(r.totals.net)],
            ]}
          />
        </div>
        <div className="mt-4 text-[11px] tracking-[0.08em] text-muted-foreground uppercase">One row per account</div>
        <div className="mt-2">
          <DataTable
            columns={[
              { label: "Account" },
              { label: "Amount", num: true },
              { label: "Fee", num: true },
              { label: "Net", num: true },
              { label: "Status" },
            ]}
            empty={r.results.length === 0 ? "The server returned no per-account results." : undefined}
          >
            {r.results.flatMap((x) => {
              const cells = (
                <tr key={x.account_id}>
                  <Td>
                    <div className="font-mono">{x.account_id}</div>
                    <div className="font-mono text-xs text-muted-foreground">{x.phone}</div>
                  </Td>
                  <Td num className="font-mono">{usd(x.amount)}</Td>
                  <Td num className="font-mono text-muted-foreground">{usd(x.fee)}</Td>
                  <Td num className="font-mono">{usd(x.net)}</Td>
                  <Td>
                    <StatusCell status={x.status} />
                  </Td>
                </tr>
              );
              return x.detail
                ? [
                    cells,
                    <tr key={`${x.account_id}-detail`}>
                      <Td colSpan={5} className="bg-background pt-0 pb-3">
                        <div className="text-[11px] tracking-[0.06em] text-muted-foreground uppercase">verbatim</div>
                        <div className="font-mono text-xs wrap-anywhere whitespace-pre-wrap text-muted-foreground">{x.detail}</div>
                      </Td>
                    </tr>,
                  ]
                : [cells];
            })}
          </DataTable>
        </div>
        <div className="mt-3.5 flex flex-wrap items-center gap-3">
          <Button onClick={onReset}>Start another withdrawal</Button>
        </div>
      </FormCard>
    </Section>
  );
}
