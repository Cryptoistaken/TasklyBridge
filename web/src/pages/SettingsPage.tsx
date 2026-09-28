import { useEffect, useState } from "react";
import { get, put, type Settings } from "@/lib/api";
import { PageHeader } from "@/components/PageHeader";
import { StatusChip } from "@/components/StatusChip";
import { Field, FormCard, ReadOnly, Section, inputCls } from "@/components/Field";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

// Settings — the editable subset only. Secrets are never in the payload and
// are never rendered.

const SECRET_NAMES = ["BOT_TOKEN", "TG_API_HASH", "ADMIN_PASSWORD", "ADMIN_SESSION_SECRET"];
const MIN_WATCH_SECONDS = 300; // the bridge floor: 5 minutes

export function SettingsPage(): React.JSX.Element {
  const [s, setS] = useState<Settings | null>(null);
  const [error, setError] = useState("");

  const [bound, setBound] = useState("");
  const [adminIds, setAdminIds] = useState("");
  const [wallet, setWallet] = useState("");
  const [dryRun, setDryRun] = useState(true);
  const [watchInterval, setWatchInterval] = useState("");
  const [watchJob, setWatchJob] = useState("");
  const [saveErr, setSaveErr] = useState("");
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    get<Settings>("/api/settings")
      .then((v) => {
        if (!live) return;
        setS(v);
        setBound(String(v.bound_user_id));
        setAdminIds(v.admin_ids.join(", "));
        setWallet(v.withdraw_wallet);
        setDryRun(v.withdraw_dry_run);
        setWatchInterval(String(v.watch_interval_seconds));
        setWatchJob(v.watch_job);
      })
      .catch((e: unknown) => {
        if (live) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      live = false;
    };
  }, []);

  async function save(): Promise<void> {
    setSaveErr("");
    setSaved(false);

    const ids = adminIds
      .split(/[,\s]+/)
      .filter((x) => x.length > 0)
      .map(Number)
      .filter((n) => Number.isFinite(n));

    const body = {
      bound_user_id: Number(bound),
      admin_ids: ids,
      withdraw_wallet: wallet.trim(),
      withdraw_dry_run: dryRun,
      watch_interval_seconds: Number(watchInterval),
      watch_job: watchJob.trim(),
    };

    if (body.watch_interval_seconds < MIN_WATCH_SECONDS) {
      setSaveErr(`Watch interval must be at least ${MIN_WATCH_SECONDS} seconds — every provider poll sends three automated messages.`);
      return;
    }

    setSaving(true);
    try {
      const v = await put<Settings>("/api/settings", body);
      setS(v);
      setBound(String(v.bound_user_id));
      setAdminIds(v.admin_ids.join(", "));
      setWallet(v.withdraw_wallet);
      setDryRun(v.withdraw_dry_run);
      setWatchInterval(String(v.watch_interval_seconds));
      setWatchJob(v.watch_job);
      setSaved(true);
    } catch (e: unknown) {
      setSaveErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  if (error) {
    return (
      <div>
        <PageHeader title="Settings" />
        <Alert variant="destructive">{error}</Alert>
      </div>
    );
  }

  if (!s) {
    return (
      <div>
        <PageHeader title="Settings" sub="editable configuration · secrets are never sent by the API" />
        <Skeleton className="h-[320px]" />
      </div>
    );
  }

  return (
    <div>
      <PageHeader title="Settings" sub="editable configuration · secrets are never sent by the API" />
      <Section title="Editable">
        <FormCard>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(260px,1fr))] gap-[18px]">
            <Field label="Bound user id">
              <input className={inputCls} type="number" value={bound} onChange={(e) => setBound(e.target.value)} />
            </Field>
            <Field label="Admin ids (comma separated)">
              <input
                className={inputCls}
                type="text"
                value={adminIds}
                placeholder="1772093705"
                onChange={(e) => setAdminIds(e.target.value)}
              />
            </Field>
            <Field label="Withdrawal wallet (BEP-20 · BSC)">
              <input
                className={inputCls}
                type="text"
                value={wallet}
                spellCheck={false}
                onChange={(e) => setWallet(e.target.value)}
              />
            </Field>
            <Field label="Watch interval (seconds)">
              <input
                className={inputCls}
                type="number"
                min={String(MIN_WATCH_SECONDS)}
                step="60"
                value={watchInterval}
                onChange={(e) => setWatchInterval(e.target.value)}
              />
            </Field>
            <Field label="Watch job">
              <input className={inputCls} type="text" value={watchJob} onChange={(e) => setWatchJob(e.target.value)} />
            </Field>
            <div>
              <span className="mb-1.5 block text-[11px] tracking-[0.06em] text-muted-foreground uppercase">
                Withdraw dry run
              </span>
              <div className="flex flex-wrap items-center gap-3">
                <input
                  type="checkbox"
                  className="size-4 accent-white"
                  checked={dryRun}
                  onChange={(e) => {
                    setDryRun(e.target.checked);
                    setSaved(false);
                  }}
                />
                <span className="text-xs text-muted-foreground">walk the flow, send nothing</span>
              </div>
            </div>
          </div>
          {!dryRun ? (
            <Alert variant="destructive" className="mt-4">
              Turning this off enables real payouts. The provider has no confirmation step.
            </Alert>
          ) : null}
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button variant="default" onClick={() => void save()} disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
          {saveErr ? (
            <Alert variant="destructive" className="mt-3">
              {saveErr}
            </Alert>
          ) : null}
          {saved ? (
            <Alert className="mt-3">Saved.</Alert>
          ) : null}
        </FormCard>
      </Section>

      <Section title="Read only">
        <FormCard>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(260px,1fr))] gap-[18px]">
            <ReadOnly label="Catalog path" value={s.catalog_path} />
            <ReadOnly label="Audit retained days" value={String(s.audit_retained_days)} />
          </div>
        </FormCard>
      </Section>

      <Section title="Secrets">
        <p className="mb-2.5 text-xs text-muted-foreground">
          Present / not set cannot be shown: the API never returns whether a secret exists, so nothing sensitive can be
          rendered. All four live in <span className="font-mono">Backend/.env</span>.
        </p>
        <FormCard>
          <div className="flex flex-col gap-2">
            {SECRET_NAMES.map((n) => (
              <div key={n} className="flex flex-wrap items-center gap-3">
                <span className="font-mono">{n}</span>
                <StatusChip text="not exposed" tone="muted" />
              </div>
            ))}
          </div>
        </FormCard>
      </Section>
    </div>
  );
}
