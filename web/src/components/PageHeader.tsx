/** Page title plus the muted subtitle line underneath it. */
export function PageHeader({ title, sub }: { title: string; sub?: string }): React.JSX.Element {
  return (
    <header className="mb-5">
      <h1 className="text-xl font-semibold tracking-[-0.01em]">{title}</h1>
      {sub ? <p className="mt-1 text-[13px] text-muted-foreground">{sub}</p> : null}
    </header>
  );
}

/** Uppercase section heading. */
export function SectionTitle({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <h2 className="mb-2.5 text-[13px] font-medium tracking-[0.06em] text-muted-foreground uppercase">{children}</h2>;
}
