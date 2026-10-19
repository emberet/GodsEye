"use client";
import { usePoll } from "@/lib/use-poll";
import type { LogRow } from "@/lib/types";
import { ago } from "@/lib/format";
import { cn } from "@/lib/utils";

const DOT: Record<string, string> = {
  win: "bg-violet",
  fee: "bg-violet",
  trade: "bg-lilac",
  learn: "bg-lilac",
  wallet: "bg-[#8E8D93]",
  loss: "bg-loss",
  error: "bg-loss",
  warn: "bg-[#E0B65A]",
};

/** What GodsEye just did, as a dark timeline strip. */
export function TerminalFeed({ limit = 14 }: { limit?: number }) {
  const { data } = usePoll<LogRow[]>("/api/logs", 10_000);
  const rows = (data ?? []).slice(0, limit);
  return (
    <section className="rounded-[28px] bg-frame p-5 text-[#F6F5F2] sm:p-6" aria-label="Activity">
      <h2 className="text-[22px] font-medium tracking-[-0.02em]">What GodsEye just did</h2>
      <ol className="mt-3" role="log" aria-live="polite">
        {rows.length === 0 && <li className="py-2 text-sm text-[#A9A8AE]">Waiting for the first event…</li>}
        {rows.map((r) => (
          <li key={r.id} className="flex gap-3 border-t border-white/10 py-2.5 text-sm first:border-t-0">
            <span className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", DOT[r.level] ?? "bg-[#8E8D93]")} aria-hidden />
            <span className="min-w-0 flex-1 break-words">{r.message}</span>
            <span className="shrink-0 text-xs text-[#A9A8AE] num" title={r.ts}>{ago(r.ts)}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
