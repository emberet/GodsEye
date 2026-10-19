import { cn } from "@/lib/utils";

/** A small label over a big light number. No box: stats sit straight on the panel or in a card. */
export function Stat({ label, value, unit, sub, valueClass, className }: { label: string; value: React.ReactNode; unit?: string; sub?: React.ReactNode; valueClass?: string; className?: string }) {
  return (
    <div className={cn("min-w-0", className)}>
      <p className="k">{label}</p>
      <p className={cn("big mt-1.5 truncate num", valueClass)}>
        {value}
        {unit && <span className="unit">{unit}</span>}
      </p>
      {sub && <p className="mt-1.5 line-clamp-2 text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}

/** A row of stats. */
export function Stats({ children, className }: { children: React.ReactNode; className?: string }) {
  return <section className={cn("grid grid-cols-2 gap-x-4 gap-y-5 px-1 lg:grid-cols-4", className)}>{children}</section>;
}
