"use client";
import { usePoll } from "@/lib/use-poll";
import type { LogRow } from "@/lib/types";
import { cn } from "@/lib/utils";

const COLOR: Record<string, string> = {
  win: "text-win",
  fee: "text-win",
  loss: "text-loss",
  error: "text-loss",
  warn: "text-amber",
  trade: "text-cyan-300",
  learn: "text-fuchsia-300",
  wallet: "text-sky-300",
};

export function TerminalFeed({ limit = 14 }: { limit?: number }) {
  const { data } = usePoll<LogRow[]>("/api/logs", 10_000);
  const rows = (data ?? []).slice(0, limit);
  return (
    <div className="h-full min-h-[220px] bg-black p-3 text-[12px] leading-relaxed" role="log" aria-live="polite">
      {rows.length === 0 && <p className="text-muted-foreground">godseye&gt; waiting for the first event…</p>}
      {rows.map((r) => (
        <p key={r.id} className="break-words">
          <span className="text-muted-foreground">{r.ts.slice(11, 19)}</span>{" "}
          <span className={cn(COLOR[r.level] ?? "text-foreground")}>{r.message}</span>
        </p>
      ))}
      <p className="text-win">
        godseye&gt; <span className="animate-blink">█</span>
      </p>
    </div>
  );
}
