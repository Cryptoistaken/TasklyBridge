import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export type StatusTone = "ok" | "muted" | "bad";

/** Account/session/run states share one mapping: dead-ish is bad, waiting-ish is muted. */
export function toneForState(s: string): StatusTone {
  if (s === "banned" || s === "dead" || s === "failed") return "bad";
  if (s === "degraded" || s === "running" || s === "skipped" || s === "waiting" || s === "done") return "muted";
  return "ok";
}

/**
 * Status chip. Only three tones exist in the palette: ok (foreground on
 * muted), muted (for degraded/flood-wait), bad/destructive (banned/dead/loss).
 */
export function StatusChip({ text, tone = "ok", className }: { text: string; tone?: StatusTone; className?: string }): React.JSX.Element {
  return (
    <Badge variant={tone === "bad" ? "destructive" : tone === "muted" ? "muted" : "default"} className={className}>
      <span
        aria-hidden
        className={cn(
          "size-[7px] shrink-0 rounded-full",
          tone === "ok" ? "bg-primary" : tone === "bad" ? "bg-destructive" : "bg-muted-foreground",
        )}
      />
      {text}
    </Badge>
  );
}
