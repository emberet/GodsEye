import { cn } from "@/lib/utils";

/** A small label over a big bold number. Pass `tile` (e.g. "bg-lime") to make it a coloured block. */
export function Stat({ label, value, unit, sub, valueClass, className, tile }: { label: string; value: React.ReactNode; unit?: string; sub?: React.ReactNode; valueClass?: string; className?: string; tile?: string }) {
  return (
    <div className={cn("min-w-0", tile && cn("tile", tile), className)}>
      <p className={cn("text-xs font-bold", tile ? "text-ink/75" : "text-muted-foreground")}>{label}</p>
      <p className={cn("big mt-2 truncate num", valueClass)}>
        {value}
        {unit && <span className="unit">{unit}</span>}
      </p>
      {sub && <p className={cn("mt-2 line-clamp-2 text-xs font-medium", tile ? "text-ink/75" : "text-muted-foreground")}>{sub}</p>}
    </div>
  );
}

/** A row of stats. */
export function Stats({ children, className }: { children: React.ReactNode; className?: string }) {
  return <section className={cn("grid grid-cols-2 gap-4 lg:grid-cols-4", className)}>{children}</section>;
}
