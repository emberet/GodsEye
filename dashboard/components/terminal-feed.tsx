"use client";
import { usePoll } from "@/lib/use-poll";
import type { CopiesData, LogRow } from "@/lib/types";
import { ago, pct, shortAddr, signedUsd } from "@/lib/format";
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

type Row = Pick<LogRow, "id" | "ts" | "level" | "message">;

/**
 * The public API hides the agent's raw log, so a public site would wait forever for it: there the feed is built from
 * the copy trades instead (already public), newest first. Buys, and each closed position with its result.
 */
export function copyActivity(c: CopiesData | undefined): Row[] {
  if (!c) return [];
  const coin = (s: string | null, mint: string) => s ?? shortAddr(mint);
  const buys: Row[] = c.trades
    .filter((t) => t.side === "buy" && t.status === "filled")
    .map((t) => ({ id: t.id, ts: t.filled_at ?? t.created_at, level: "trade", message: `Copied ${shortAddr(t.leader)}: bought ${coin(t.symbol, t.mint)} for ${(t.size_sol ?? 0).toFixed(3)} SOL` }));
  const closes: Row[] = c.closed
    .filter((p) => p.closed_at)
    .map((p) => ({
      id: -p.id,
      ts: p.closed_at!,
      level: (p.pnl_sol ?? 0) >= 0 ? "win" : "loss",
      message: `Closed ${coin(p.symbol, p.mint)}: ${p.pnl_usd !== null ? signedUsd(p.pnl_usd) : `${(p.pnl_sol ?? 0).toFixed(4)} SOL`} (${pct(p.pnl_pct, 1)})${p.exit_reason ? ` — ${p.exit_reason}` : ""}`,
    }));
  return [...buys, ...closes].sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
}

/** What GodsEye just did. */
export function TerminalFeed({ limit = 14, className }: { limit?: number; className?: string }) {
  const { data } = usePoll<LogRow[]>("/api/logs", 10_000);
  const logs = data ?? [];
  const { data: copies } = usePoll<CopiesData>("/api/copies", 15_000);
  const rows: Row[] = (logs.length ? logs : copyActivity(copies ?? undefined)).slice(0, limit);
  return (
    <section className={cn("card", className)} aria-label="Activity">
      <h2 className="text-xl font-extrabold tracking-[-0.02em]">What GodsEye just did</h2>
      <ol className="mt-2" role="log" aria-live="off">
        {rows.length === 0 && <li className="py-2 text-sm text-muted-foreground">{data === null || (!logs.length && copies === null) ? "Loading…" : "No trades yet."}</li>}
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
