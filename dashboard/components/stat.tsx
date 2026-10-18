import { cn } from "@/lib/utils";

export function Stat({ label, value, sub, valueClass, className }: { label: string; value: React.ReactNode; sub?: React.ReactNode; valueClass?: string; className?: string }) {
  return (
    <div className={cn("min-w-0 border bg-card p-3", className)}>
      <p className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">{label}</p>
      <p className={cn("mt-1 truncate text-xl font-bold num sm:text-2xl", valueClass)}>{value}</p>
      {sub && <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{sub}</p>}
    </div>
  );
}
