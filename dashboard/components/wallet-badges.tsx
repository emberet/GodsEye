import Link from "next/link";
import { TIER_DESCRIPTIONS, TIER_LABELS } from "@godseye/shared/constants";
import type { Tier, WalletKind } from "@/lib/types";
import { shortAddr, solscanAccount } from "@/lib/format";
import { cn } from "@/lib/utils";

export const TIER_STYLE: Record<Tier, string> = {
  insider: "border-fuchsia-400/50 bg-fuchsia-400/10 text-fuchsia-300",
  lucky_streak: "border-amber/50 bg-amber/10 text-amber",
  needs_attention: "border-orange-400/50 bg-orange-400/10 text-orange-300",
  quitter: "border-border bg-transparent text-muted-foreground",
  proven: "border-win/50 bg-win/10 text-win",
  unrated: "border-border bg-muted text-muted-foreground",
};

const TIER_ICON: Record<Tier, string> = { insider: "🕵", lucky_streak: "🍀", needs_attention: "⚠", quitter: "💤", proven: "🏆", unrated: "·" };

export function TierBadge({ tier, className }: { tier: Tier; className?: string }) {
  return (
    <span title={TIER_DESCRIPTIONS[tier]} className={cn("inline-flex items-center gap-1 whitespace-nowrap border px-1.5 py-0.5 text-[11px] font-bold uppercase tracking-wider", TIER_STYLE[tier], className)}>
      <span aria-hidden>{TIER_ICON[tier]}</span>
      {TIER_LABELS[tier]}
    </span>
  );
}

export function KindBadge({ kind, score, className }: { kind: WalletKind; score: number | null; className?: string }) {
  const label = kind === "ai" ? "AI / bot" : kind === "human" ? "Human" : "Undecided";
  const style = kind === "ai" ? "border-cyan-400/50 bg-cyan-400/10 text-cyan-300" : kind === "human" ? "border-sky-200/40 bg-sky-200/10 text-sky-100" : "border-border text-muted-foreground";
  return (
    <span title={score === null ? "Not enough swaps to judge" : `AI score ${score}/100 (≥65 AI/bot, ≤35 human)`} className={cn("inline-flex items-center gap-1 whitespace-nowrap border px-1.5 py-0.5 text-[11px] font-bold uppercase tracking-wider", style, className)}>
      <span aria-hidden>{kind === "ai" ? "🤖" : kind === "human" ? "🧑" : "?"}</span>
      {label}
      {score !== null && <span className="font-normal opacity-70 num">{Math.round(score)}</span>}
    </span>
  );
}

/** A wallet address: links to its GodsEye page, with a Solscan link beside it. */
export function Addr({ address, n = 4, internal = true, className }: { address: string; n?: number; internal?: boolean; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1 font-mono", className)}>
      {internal ? (
        <Link href={`/wallets/${address}`} className="text-foreground underline decoration-dotted underline-offset-2 hover:text-win" title={address}>
          {shortAddr(address, n)}
        </Link>
      ) : (
        <span title={address}>{shortAddr(address, n)}</span>
      )}
      <a href={solscanAccount(address)} target="_blank" rel="noreferrer" className="text-[10px] text-muted-foreground hover:text-win" aria-label={`${address} on Solscan`}>
        ↗
      </a>
    </span>
  );
}
