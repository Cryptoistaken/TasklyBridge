import { cn } from "@/lib/utils";

export interface Column {
  label: string;
  num?: boolean;
}

/**
 * Data table shell for phase-2 pages: card wrapper, uppercase header row,
 * right-aligned numeric columns with tabular-nums. Rows are plain React
 * children so each page owns its cells.
 */
export function DataTable({
  columns,
  children,
  empty,
}: {
  columns: Column[];
  children: React.ReactNode;
  empty?: string;
}): React.JSX.Element {
  return (
    <div className="overflow-x-auto rounded-[var(--radius)] border border-border bg-card">
      <table className="w-full border-collapse">
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c.label}
                className={cn(
                  "border-b border-border px-3.5 py-2.5 text-left text-[11px] font-medium whitespace-nowrap text-muted-foreground uppercase tracking-[0.06em]",
                  c.num && "text-right",
                )}
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {children}
          {empty ? (
            <tr>
              <td colSpan={columns.length} className="px-3.5 py-6 text-center text-muted-foreground">
                {empty}
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

export function Td({
  children,
  className,
  num,
  colSpan,
}: {
  children?: React.ReactNode;
  className?: string;
  num?: boolean;
  colSpan?: number;
}): React.JSX.Element {
  return (
    <td colSpan={colSpan} className={cn("border-b border-border px-3.5 py-2.5 align-top last:[tr>&]:border-b-0", num && "text-right tabular-nums", className)}>
      {children}
    </td>
  );
}
