"use client";
import { usePoll } from "@/lib/use-poll";
import type { Summary } from "@/lib/types";
import { cn } from "@/lib/utils";

/** One small badge, always honest about whether real money is moving. */
export function ModeBanner() {
  const { data } = usePoll<Summary>("/api/summary", 30_000);
  if (!data) return null;
  const [label, tip, style] = data.paused
    ? ["paused", "Copying is paused: no new positions. Sells and stop-losses still run.", "border-amber/60 text-amber"]
    : data.copyMode === "real"
      ? ["real money", "GodsEye copies trades with real SOL from its own wallet. Memecoins are extremely risky; a wallet's past profit says nothing about the future.", "border-amber/60 text-amber"]
      : ["paper", "Copy trades are simulated with live Jupiter quotes. No real funds move.", "border-border text-muted-foreground"];
  return (
    <span title={tip} role="status" className={cn("border px-1.5 py-0.5 text-[10px] uppercase tracking-widest", style)}>
      {label}
    </span>
  );
}
