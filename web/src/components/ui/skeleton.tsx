import { cn } from "@/lib/utils";

function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div data-slot="skeleton" className={cn("bg-muted animate-pulse rounded-[var(--radius)]", className)} {...props} />;
}

export { Skeleton };
