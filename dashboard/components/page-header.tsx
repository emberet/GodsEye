export function PageHeader({ title, kicker, children }: { title: string; kicker?: string; children?: React.ReactNode }) {
  return (
    <header className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-baseline gap-3">
        <h1 className="font-pixel text-3xl leading-none text-foreground">{title}</h1>
        {kicker && <p className="truncate text-[11px] text-muted-foreground">{kicker}</p>}
      </div>
      {children && <div className="flex flex-wrap items-center gap-2 text-xs">{children}</div>}
    </header>
  );
}
