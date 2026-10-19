"use client";
import { usePoll } from "@/lib/use-poll";
import type { Summary } from "@/lib/types";
import { cn } from "@/lib/utils";

/** One small tag, always honest about whether GodsEye is running and whether real money moves. */
export function ModeBanner() {
  const { data } = usePoll<Summary>("/api/summary", 30_000);
  if (!data) return null;
  const mode = data.paused ? "Paused" : data.copyMode === "real" ? "Real money" : "Paper";
  const tip = data.paused
    ? "Copying is paused: no new positions. Sells and stop-losses still run."
    : data.copyMode === "real"
      ? "GodsEye copies trades with real SOL from its own wallet. Memecoins are extremely risky; a wallet's past profit says nothing about the future."
      : "Copy trades are simulated with live Jupiter quotes. No real funds move.";
  return (
    <span title={tip} role="status" className="tag min-h-[32px] gap-2 rounded-[11px] bg-card px-3 shadow-hard-sm">
      <span className={cn("h-2.5 w-2.5 rounded-full border-2 border-ink", data.live ? "animate-pulsedot bg-lime" : "bg-coral")} aria-hidden />
      {data.live ? "Watching" : "Offline"} · {mode}
    </span>
  );
}
