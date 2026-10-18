/**
 * ============================================================
 *  GodsEye — constants shared by every part of the app
 * ============================================================
 */

export const LAMPORTS_PER_SOL = 1_000_000_000;

/** Well-known Solana token addresses. */
export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";

/**
 * Wallet tiers shown on the public database. A wallet gets exactly one.
 * Order matters: the first tier whose rule matches wins (see agent/src/analysis/tiers.ts).
 */
export const TIERS = ["quitter", "insider", "lucky_streak", "needs_attention", "proven", "unrated"] as const;
export type Tier = (typeof TIERS)[number];

export const TIER_LABELS: Record<Tier, string> = {
  insider: "Insider pattern",
  lucky_streak: "Lucky streak",
  needs_attention: "Needs attention",
  quitter: "Quitter",
  proven: "Proven",
  unrated: "Unrated",
};

export const TIER_DESCRIPTIONS: Record<Tier, string> = {
  insider: "Trades look like early or inside knowledge: buys in a token's first minutes, money from the token's creator, or sells just before a crash. The evidence is listed on each wallet's page.",
  lucky_streak: "Profitable, but most of the profit came from one or two trades, or there are too few trades to call it skill.",
  needs_attention: "Something changed: a profitable wallet is now losing, a brand-new wallet is trading big, or it belongs to a large group of sibling wallets.",
  quitter: "Stopped trading.",
  proven: "Profitable over many trades, with profit spread across them. These are the wallets GodsEye copies most.",
  unrated: "Not enough trades yet to judge.",
};

/** AI / human verdicts from the behaviour classifier. */
export const WALLET_KINDS = ["ai", "human", "unknown"] as const;
export type WalletKind = (typeof WALLET_KINDS)[number];

/** The agent counts as "live" if it checked in within this many minutes. */
export const HEARTBEAT_STALE_MINUTES = 12;

export const PROOF_GENESIS_HASH = "0".repeat(64);

/** Absolute ceiling for a single copy trade, no matter what .env says. */
export const HARD_MAX_COPY_TRADE_SOL = 5 as const;
