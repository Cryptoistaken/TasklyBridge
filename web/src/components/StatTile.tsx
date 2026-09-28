import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";

export interface StatTileProps {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  bad?: boolean;
}

/** One stat tile: uppercase label, mono value, muted sub-line. */
export function StatTile({ label, value, sub, bad }: StatTileProps): React.JSX.Element {
  return (
    <Card className={cn("gap-0", bad && "border-destructive")}>
      <div className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">{label}</div>
      <div className={cn("mt-2 font-mono text-[26px] leading-none font-medium tracking-[-0.02em] tabular-nums", bad && "text-destructive")}>
        {value}
      </div>
      {sub !== undefined ? <div className="mt-1 text-xs text-muted-foreground">{sub}</div> : null}
    </Card>
  );
}

export function StatGrid({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(190px,1fr))]">{children}</div>;
}
