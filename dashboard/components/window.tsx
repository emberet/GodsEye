import { cn } from "@/lib/utils";

/** A plain panel: thin title row, content below. */
export function Window({
  title,
  icon,
  right,
  className,
  bodyClassName,
  children,
}: {
  title: string;
  icon?: string;
  right?: React.ReactNode;
  className?: string;
  bodyClassName?: string;
  children: React.ReactNode;
  inactive?: boolean;
}) {
  return (
    <section className={cn("flex min-w-0 flex-col border bg-card", className)}>
      <div className="flex min-h-8 items-center justify-between gap-2 border-b px-3 py-1">
        <h2 className="flex min-w-0 items-center gap-1.5 truncate text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
          {icon && <span aria-hidden>{icon}</span>}
          <span className="truncate">{title}</span>
        </h2>
        {right && <div className="flex shrink-0 items-center gap-2 text-xs">{right}</div>}
      </div>
      <div className={cn("flex-1", bodyClassName)}>{children}</div>
    </section>
  );
}
