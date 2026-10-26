"use client";
import { usePoll } from "@/lib/use-poll";
import type { Summary } from "@/lib/types";
import { cn } from "@/lib/utils";

/** One small tag, always honest about whether GodsEye is running and whether real money moves. */
export function ModeBanner() {
  const { data, error } = usePoll<Summary>("/api/summary", 30_000);
  if (!data) {
    if (!error) return null;
    return (
      <span role="status" title={error} className="tag min-h-[32px] gap-2 rounded-[11px] bg-card px-3 shadow-hard-sm">
        <span className="h-2.5 w-2.5 rounded-full border-2 border-ink bg-coral" aria-hidden />
        No data · status unknown
      </span>
    );
  }
  const mode = data.copyMode === "real" ? "Real money" : data.copyMode === "paper" ? "Paper" : "Mode unknown";
  const state = !data.live ? "Offline" : data.paused ? "Paused" : "Watching";
  const tip = !data.live
    ? `The agent isn't running${data.heartbeat ? ` (last seen ${new Date(data.heartbeat).toLocaleString()})` : ""}: nothing is watched or copied.`
    : data.paused
      ? "Copying is paused: no new positions. Sells and stop-losses still run."
      : data.copyMode === "real"
        ? "GodsEye copies trades with real SOL from its own wallet. Memecoins are extremely risky; a wallet's past profit says nothing about the future."
        : data.copyMode === "paper"
          ? "Copy trades are simulated with live Jupiter quotes. No real funds move."
          : "The agent hasn't reported whether it trades real money or paper.";
  return (
    <span title={tip} role="status" className="tag min-h-[32px] gap-2 rounded-[11px] bg-card px-3 shadow-hard-sm">
      <span className={cn("h-2.5 w-2.5 rounded-full border-2 border-ink", data.live && !data.paused ? "animate-pulsedot bg-lime" : data.live ? "bg-sun" : "bg-coral")} aria-hidden />
      {state} · {mode}
    </span>
  );
}
