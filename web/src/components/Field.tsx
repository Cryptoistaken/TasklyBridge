import { Card } from "@/components/ui/card";
import { SectionTitle } from "@/components/PageHeader";

/**
 * Labelled form control, matching the old .field layout.
 *
 * hint is the small print under the control. It exists because some of these
 * fields have a consequence that is not obvious from the label - naming an
 * account decides which session it overwrites - and a field that quietly
 * destroys the previous one is worth a sentence.
 */
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[11px] tracking-[0.06em] text-muted-foreground uppercase">{label}</span>
      {children}
      {hint ? <span className="mt-1.5 block text-xs text-muted-foreground">{hint}</span> : null}
    </label>
  );
}

export const inputCls =
  "block w-full rounded-[var(--radius)] border border-input bg-background px-2.5 py-2 font-mono text-[13px] outline-none focus:border-ring";

/** Read-only label/value pair (settings page). */
export function ReadOnly({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div>
      <div className="text-[11px] tracking-[0.06em] text-muted-foreground uppercase">{label}</div>
      <div className="mt-1.5 font-mono">{value}</div>
    </div>
  );
}

/** Titled card section, matching the old section() helper. */
export function Section({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <section className="mt-7">
      <SectionTitle>{title}</SectionTitle>
      {children}
    </section>
  );
}

/** Definition list for money summaries (withdrawals page). */
export function Kv({ pairs }: { pairs: [string, React.ReactNode][] }): React.JSX.Element {
  return (
    <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-[18px] gap-y-1.5">
      {pairs.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-[11px] tracking-[0.06em] text-muted-foreground uppercase">{k}</dt>
          <dd className="font-mono tabular-nums">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Form card wrapper: bordered card with vertical stack. */
export function FormCard({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <Card className="gap-0">{children}</Card>;
}
