import { cn } from "@/lib/utils";

/** A card with a title row: the one container every page is built from. */
export function Window({
  title,
  icon,
  right,
  className,
  bodyClassName,
  children,
}: {
  title: React.ReactNode;
  icon?: React.ReactNode;
  right?: React.ReactNode;
  className?: string;
  bodyClassName?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={cn("card flex min-w-0 flex-col", className)}>
      <div className="flex min-h-11 flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <h2 className="flex min-w-0 items-center gap-2 text-[22px] font-medium tracking-[-0.02em]">
          {icon && <span aria-hidden>{icon}</span>}
          <span className="min-w-0">{title}</span>
        </h2>
        {right && <div className="flex max-w-full flex-wrap items-center gap-2 text-sm">{right}</div>}
      </div>
      <div className={cn("mt-3 flex-1", bodyClassName)}>{children}</div>
    </section>
  );
}

/** Friendly empty state, optionally with one of the GodsEye illustrations. */
export function Empty({ img, title, children, className }: { img?: "radar" | "wallet" | "eye"; title?: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex items-center gap-3 py-2", className)}>
      {img && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={`/img/${img}.png`} alt="" width={112} height={112} className="h-24 w-24 shrink-0 object-contain sm:h-28 sm:w-28" />
      )}
      <div className="min-w-0">
        {title && <p className="text-2xl font-light tracking-[-0.03em] sm:text-[28px]">{title}</p>}
        <p className="mt-1 max-w-md text-sm text-muted-foreground">{children}</p>
      </div>
    </div>
  );
}
