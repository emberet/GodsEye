"use client";
import { useState } from "react";
import { AlertCircle, Check } from "lucide-react";
import type { Summary } from "@/lib/types";

/** The single most important thing to know right now, as a dark pill. Nothing shows when all is well. */
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
    <section role="status" className="flex flex-wrap items-center gap-3 rounded-[28px] bg-frame py-2 pl-4 pr-2 text-[#F6F5F2] sm:rounded-full sm:pl-5">
      <span className="dot h-[34px] w-[34px] bg-lilac text-ink" aria-hidden>
        <AlertCircle size={16} strokeWidth={2} />
      </span>
      <p className="min-w-0 flex-1 basis-60 py-1 text-[15px]">{msg}</p>
      {empty && s.wallet.pubkey && (
        <button type="button" onClick={copy} className="btn min-h-[44px]" title={s.wallet.pubkey}>
          {copied ? (
            <>
              <Check size={16} aria-hidden /> Copied
            </>
          ) : (
            "Copy wallet address"
          )}
        </button>
      )}
    </section>
  );
}
