import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center justify-center gap-1.5 rounded-[var(--radius)] border border-border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap transition-colors outline-none",
  {
    variants: {
      variant: {
        default: "bg-muted text-foreground",
        muted: "bg-muted text-muted-foreground",
        destructive: "text-destructive border-destructive bg-transparent",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps): React.JSX.Element {
  return <span data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
