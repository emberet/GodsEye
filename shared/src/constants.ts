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
 * Tokens that aren't memecoins: trading them isn't counted in any wallet's
 * P&L or copied (wrapped BTC/ETH, staked SOL, big DeFi tokens, other stablecoins).
 */
export const NON_MEMECOIN_MINTS = new Set([
  "cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij", // cbBTC
  "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh", // WBTC (Wormhole)
  "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs", // WETH (Wormhole)
  "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So", // mSOL
  "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn", // JitoSOL
  "bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1", // bSOL
  "jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v", // JupSOL
  "5oVNBeEEQvYi1cX3ir8Dx5n1P7pdxydbGF2X4TxVusJm", // INF
  "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", // JUP
  "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL", // JTO
  "HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3", // PYTH
  "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R", // RAY
  "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo", // PYUSD
  "HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr", // EURC
  "USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA", // USDS
  "USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB", // USD1
  "KMNo3nJsBXfcpJTVhZcXLW7RmTwTt4GVFE7suUBo9sS", // KMNO
  "DriFtupJYLTosbwoN8koMbEYSx54aFAVLddWsbksjwg7", // DRIFT
  "85VBFQZC9TZkfaptBWjvUw7YbZjy52A6mjtPGjstQAmQ", // W
  "rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof", // RENDER
  "hntyVP6YFm1Hg25TN9WGLqM12b8TQmcknKrdu1oxWux", // HNT
  "orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE", // ORCA
  "27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4", // JLP
]);

/** Symbols of non-memecoins: a safety net for tokens missing from NON_MEMECOIN_MINTS (also used to pick discovery pools). */
export const NON_MEMECOIN_SYMBOLS = new Set([
  "SOL", "WSOL", "USDC", "USDT", "USDS", "USD1", "PYUSD", "USDG", "FDUSD", "EURC", "USDE", "SUSDE",
  "JITOSOL", "MSOL", "BSOL", "JUPSOL", "INF", "BNSOL", "HSOL", "DSOL", "LST", "JLP",
  "ETH", "WETH", "BTC", "WBTC", "CBBTC", "TBTC", "ZBTC",
  "JUP", "JTO", "PYTH", "RAY", "ORCA", "DRIFT", "KMNO", "W", "RENDER", "HNT",
]);

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
