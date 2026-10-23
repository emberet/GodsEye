import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { TIER_DESCRIPTIONS, TIER_LABELS } from "@godseye/shared/constants";
import type { Tier, WalletKind } from "@/lib/types";
import { dexscreenerToken, shortAddr, solscanAccount } from "@/lib/format";
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

/** A wallet address that opens the wallet on Solscan, in a new tab. */
export function WalletLink({ address, n = 4, className }: { address: string; n?: number; className?: string }) {
  return (
    <a
      href={solscanAccount(address)}
      target="_blank"
      rel="noreferrer"
      title={`${address} on Solscan`}
      className={cn("font-mono underline-offset-2 hover:text-accent hover:underline", className)}
    >
      {shortAddr(address, n)}
    </a>
  );
}

/** The arrow button on a wallet row: GodsEye's own page for the wallet (its label and the evidence). */
export function WalletPageLink({ address, className }: { address: string; className?: string }) {
  return (
    <Link href={`/wallets/${address}`} title="GodsEye's page for this wallet: its label and the evidence" aria-label={`GodsEye's page for ${shortAddr(address)}`} className={cn("dot h-9 w-9 shrink-0 bg-cream shadow-hard-sm hover:bg-lilac", className)}>
      <ChevronRight size={16} strokeWidth={2.6} aria-hidden />
    </Link>
  );
}

/** A coin that opens its chart on DexScreener, in a new tab. */
export function TokenLink({ mint, symbol, className }: { mint: string; symbol: string | null | undefined; className?: string }) {
  return (
    <a
      href={dexscreenerToken(mint)}
      target="_blank"
      rel="noreferrer"
      title={`${symbol ?? mint} on DexScreener`}
      className={cn("underline-offset-2 hover:text-accent hover:underline", className)}
    >
      {symbol ?? shortAddr(mint)}
    </a>
  );
}

/** A wallet address (opens Solscan). Kept for older call sites. */
export const Addr = ({ address, n = 4, className }: { address: string; n?: number; internal?: boolean; className?: string }) => <WalletLink address={address} n={n} className={className} />;
