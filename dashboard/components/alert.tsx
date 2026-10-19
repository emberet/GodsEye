"use client";
import { useState } from "react";
import { AlertTriangle, Check, Copy } from "lucide-react";
import type { Summary } from "@/lib/types";

/** The single most important thing to know right now, as a yellow block. Nothing shows when all is well. */
export function TopAlert({ s }: { s: Summary | null }) {
  const [copied, setCopied] = useState(false);
  if (!s) return null;
  const empty = s.copyMode === "real" && s.wallet.balanceSol !== null && s.wallet.balanceSol < 0.01;
  const msg = !s.live
    ? "GodsEye isn't running. Start the agent to resume watching and copying."
    : s.paused
      ? "Copying is paused. Open trades still sell on their stop-loss and take-profit."
      : empty
        ? `Add SOL to start copying. ${s.leaders > 0 ? `${s.leaders} wallet${s.leaders === 1 ? "" : "s"} qualify, but` : "Once wallets qualify,"} GodsEye's wallet is empty.`
        : null;
  if (!msg) return null;
  const copy = async () => {
    if (!s.wallet.pubkey) return;
    await navigator.clipboard.writeText(s.wallet.pubkey).catch(() => undefined);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };
  return (
    <section role="status" className="flex flex-wrap items-center gap-3 rounded-[18px] border-[3px] border-ink bg-sun py-2.5 pl-3 pr-2.5 text-ink shadow-hard">
      <span className="dot h-10 w-10 bg-cream" aria-hidden>
        <AlertTriangle size={18} strokeWidth={2.6} />
      </span>
      <p className="min-w-0 flex-1 basis-60 py-1 text-[15px] font-bold">{msg}</p>
      {empty && s.wallet.pubkey && (
        <button type="button" onClick={copy} className="btn" title={s.wallet.pubkey}>
          {copied ? <Check size={16} strokeWidth={2.6} aria-hidden /> : <Copy size={16} strokeWidth={2.6} aria-hidden />}
          {copied ? "Copied" : "Copy wallet address"}
        </button>
      )}
    </section>
  );
}
