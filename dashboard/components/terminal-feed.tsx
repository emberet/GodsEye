"use client";
import { usePoll } from "@/lib/use-poll";
import type { LogRow } from "@/lib/types";
import { ago } from "@/lib/format";
import { cn } from "@/lib/utils";

const DOT: Record<string, string> = {
  win: "bg-lime",
  fee: "bg-lime",
  trade: "bg-lilac",
  learn: "bg-lilac",
  wallet: "bg-chip",
  loss: "bg-coral",
  error: "bg-coral",
  warn: "bg-sun",
};

/** What GodsEye just did. */
export function TerminalFeed({ limit = 14, className }: { limit?: number; className?: string }) {
  const { data } = usePoll<LogRow[]>("/api/logs", 10_000);
  const rows = (data ?? []).slice(0, limit);
  return (
    <section className={cn("card", className)} aria-label="Activity">
      <h2 className="text-xl font-extrabold tracking-[-0.02em]">What GodsEye just did</h2>
      <ol className="mt-2" role="log" aria-live="off">
        {rows.length === 0 && <li className="py-2 text-sm text-muted-foreground">Waiting for the first event…</li>}
        {rows.map((r) => (
          <li key={r.id} className="line items-start text-sm">
            <span className={cn("mt-1 h-3 w-3 shrink-0 rounded-[4px] border-2 border-ink", DOT[r.level] ?? "bg-chip")} aria-hidden />
            <span className="sr-only">{r.level}: </span>
            <span className="min-w-0 flex-1 break-words">{r.message}</span>
            <span className="shrink-0 text-xs text-muted-foreground num" title={r.ts}>{ago(r.ts)}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
