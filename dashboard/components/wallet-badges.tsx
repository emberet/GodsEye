import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { TIER_DESCRIPTIONS, TIER_LABELS } from "@godseye/shared/constants";
import type { Tier, WalletKind } from "@/lib/types";
import { shortAddr, solscanAccount } from "@/lib/format";
import { cn } from "@/lib/utils";

export const TIER_STYLE: Record<Tier, string> = {
  proven: "bg-lime text-ink",
  insider: "bg-lilac text-ink",
  lucky_streak: "bg-sun text-ink",
  needs_attention: "bg-coral text-ink",
  quitter: "bg-transparent text-muted-foreground",
  unrated: "bg-chip text-muted-foreground",
};

/** Avatar colour for a wallet, from its tier. */
export const TIER_DOT: Record<Tier, string> = {
  proven: "bg-lime",
  insider: "bg-lilac",
  lucky_streak: "bg-sun",
  needs_attention: "bg-coral",
  quitter: "bg-chip text-foreground",
  unrated: "bg-chip text-foreground",
};

export function TierBadge({ tier, className }: { tier: Tier; className?: string }) {
  return (
    <span title={TIER_DESCRIPTIONS[tier]} className={cn("tag", TIER_STYLE[tier], className)}>
      {TIER_LABELS[tier]}
    </span>
  );
}

export const kindLabel = (kind: WalletKind) => (kind === "ai" ? "Bot" : kind === "human" ? "Human" : "Undecided");

export function KindBadge({ kind, score, className }: { kind: WalletKind; score: number | null; className?: string }) {
  return (
    <span title={score === null ? "Not enough swaps to judge" : `Bot score ${Math.round(score)}/100 (65+ bot, 35 or less human)`} className={cn("tag", kind === "unknown" && "text-muted-foreground", className)}>
      {kindLabel(kind)}
      {score !== null && <span className="font-normal text-muted-foreground num">{Math.round(score)}</span>}
    </span>
  );
}

/** Round avatar with the first two characters of an address. */
export function WalletDot({ address, tier, className }: { address: string; tier?: Tier | null; className?: string }) {
  return (
    <span className={cn("dot text-[13px] font-semibold", tier ? TIER_DOT[tier] : "bg-chip text-foreground", className)} aria-hidden>
      {address.slice(0, 2)}
    </span>
  );
}

/** A wallet address: links to its GodsEye page, with a Solscan link beside it. */
export function Addr({ address, n = 4, internal = true, className }: { address: string; n?: number; internal?: boolean; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1 font-mono", className)}>
      {internal ? (
        <Link href={`/wallets/${address}`} className="text-ink hover:text-accent" title={address}>
          {shortAddr(address, n)}
        </Link>
      ) : (
        <span title={address}>{shortAddr(address, n)}</span>
      )}
      <a href={solscanAccount(address)} target="_blank" rel="noreferrer" className="inline-flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground hover:-translate-y-0.5 hover:text-accent" aria-label={`${address} on Solscan`}>
        <ArrowUpRight size={13} aria-hidden />
      </a>
    </span>
  );
}
