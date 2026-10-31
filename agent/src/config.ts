/**
 * All of GodsEye's settings, read from the .env file in the project root.
 * Every setting has a default, so the agent starts even with an empty .env.
 */
import { envBool, envNum, envStr, loadEnv, HARD_MAX_COPY_TRADE_SOL } from "@godseye/shared";

/** Stream promotion can be loosened in .env, but never below these. */
export const STREAM_PROMOTE_PNL_FLOOR_USD = 25;
export const STREAM_PROMOTE_MIN_CLOSED_FLOOR = 2;

loadEnv();

const list = (name: string) => envStr(name).split(",").map((s) => s.trim()).filter(Boolean);

export const config = {
  // ---- Mode ----
  /** "real" (default) = copy trades spend real SOL from GodsEye's wallet. "paper" = simulate fills with Jupiter quotes. */
  copyMode: (envStr("COPY_MODE", "real").toLowerCase() === "paper" ? "paper" : "real") as "real" | "paper",

  // ---- API keys ----
  heliusApiKey: envStr("HELIUS_API_KEY"),
  solanaRpcUrl: envStr("SOLANA_RPC_URL"),
  /** Shyft API key for token names (optional: taken from a Shyft SOLANA_RPC_URL otherwise). */
  shyftApiKey: envStr("SHYFT_API_KEY"),
  solanaWsUrl: envStr("SOLANA_WS_URL"),
  /** RPC for the copy path (leader transactions, rug checks, the agent wallet, sending trades), kept apart from
   *  history reads so analysis using up the main RPC's quota never slows a copy. Empty = Helius (with
   *  HELIUS_API_KEY), else SOLANA_RPC_URL. */
  copyRpcUrl: envStr("COPY_RPC_URL"),
  copyWsUrl: envStr("COPY_WS_URL"),
  birdeyeApiKey: envStr("BIRDEYE_API_KEY"),
  jupiterApiKey: envStr("JUPITER_API_KEY"),
  /** X (Twitter) API v2 app bearer token, for the runner research (x/): who posts coins before they run. Empty = off. */
  xBearerToken: envStr("X_BEARER_TOKEN"),
  /** Most tweets read in a calendar month (the plan's quota is shared with anything else using the key). */
  xMonthlyTweetCap: envNum("X_MONTHLY_TWEET_CAP", 500_000),
  /** Coins searched on X an hour (half runners, half non-runners as a control). */
  xCoinsPerHour: envNum("X_COINS_PER_HOUR", 100),

  // ---- Live gRPC stream (Shyft, Triton, Helius, QuickNode — Yellowstone protocol) ----
  /** e.g. https://grpc.ny.shyft.to — empty = no stream, GodsEye samples pools and polls instead. */
  /** Optional second RPC for reading wallet-history transactions (getTransaction only; signature lists stay on SOLANA_RPC_URL).
   *  Anything it refuses or doesn't return is read from SOLANA_RPC_URL, so a partial provider only saves load. */
  historyTxRpcUrl: envStr("HISTORY_TX_RPC_URL"),
  grpcUrl: envStr("GRPC_URL"),
  grpcToken: envStr("GRPC_TOKEN"),
  /** When the provider rejects this connection's IP (allowlist), try again this often: a home connection's
   *  IP keeps changing, and the stream holds on once it gets in from an allowlisted one. */
  streamIpRetryMs: envNum("STREAM_IP_RETRY_MS", 10_000),
  /** Programs whose swaps are streamed (default: the memecoin venues + Jupiter). */
  streamPrograms: list("STREAM_PROGRAMS"),
  /** Who parses the live stream: "ts" (default, unchanged), "rust" (events from ge-ingest over GE_INGEST_SOCKET),
   *  or "compare" (TS results are used; the Rust results are only compared and the differences logged). */
  streamParser: ((v) => (v === "rust" || v === "compare" ? v : "ts"))(envStr("STREAM_PARSER", "ts").toLowerCase()) as "ts" | "rust" | "compare",
  geIngestSocket: envStr("GE_INGEST_SOCKET", "/tmp/godseye-ingest.sock"),
  /** Promote a live wallet to full analysis once it has realized this much profit (USD at settlement) on the stream… */
  streamPromotePnlUsd: Math.max(STREAM_PROMOTE_PNL_FLOOR_USD, envNum("STREAM_PROMOTE_PNL_USD", 50)),
  /** …over at least this many closed trades (with ≥ 50% wins). Hard floors: $25 and 2 closed trades, whatever .env says. */
  streamPromoteMinClosed: Math.max(STREAM_PROMOTE_MIN_CLOSED_FLOOR, Math.round(envNum("STREAM_PROMOTE_MIN_CLOSED", 2))),
  /** Most wallets kept in memory at once (idle ones are forgotten first). */
  streamMaxWallets: envNum("STREAM_MAX_WALLETS", 300_000),
  /** Forget a wallet's in-memory swaps after this long without trading. */
  streamIdleHours: envNum("STREAM_IDLE_HOURS", 6),
  /** Keep wallet_activity rows for wallets seen in the last this-many days. */
  activityRetentionDays: envNum("ACTIVITY_RETENTION_DAYS", 30),

  // ---- Self-adjusting follow bar (see src/learning/adaptive.ts) ----
  /** Starting point for the learned minimum win rate a wallet needs to be followed… */
  followWinRateStart: envNum("FOLLOW_WIN_RATE_START", 0.5),
  /** …which learning keeps between these bounds… */
  followWinRateFloor: envNum("FOLLOW_WIN_RATE_FLOOR", 0.4),
  followWinRateCeiling: envNum("FOLLOW_WIN_RATE_CEILING", 0.8),
  /** …moving at most this much per learning cycle… */
  followMaxStep: envNum("FOLLOW_MAX_STEP", 0.05),
  /** …and only once it has this many measured outcomes. */
  followMinSamples: envNum("FOLLOW_MIN_SAMPLES", 20),

  // ---- Smart money (see src/smart/) ----
  /** A wallet winning on the stream counts as smart money from this realized profit (USD)… */
  smartLiveMinPnlUsd: envNum("SMART_LIVE_MIN_PNL_USD", 250),
  /** …over at least this many closed trades, with ≥ 55% wins. */
  smartLiveMinClosed: envNum("SMART_LIVE_MIN_CLOSED", 5),
  /** A signal fires when this many smart wallets buy (or dump) the same token… */
  smartSignalWallets: envNum("SMART_SIGNAL_WALLETS", 3),
  /** …within this many minutes… */
  smartSignalWindowMinutes: envNum("SMART_SIGNAL_WINDOW_MINUTES", 60),
  /** …for at least this much USD in total. */
  smartSignalMinUsd: envNum("SMART_SIGNAL_MIN_USD", 500),
  /** A wallet whose buys have this median 6-hour return (%) or worse, over ≥ 10 measured buys, stops counting as smart. */
  smartDropMedianRet6h: envNum("SMART_DROP_MEDIAN_RET_6H", -15),
  /** Bot gate: not smart money if its median hold is under this many seconds… */
  smartBotMinHoldSec: envNum("SMART_BOT_MIN_HOLD_SEC", 15),
  /** …or it makes more than this many transactions an hour… */
  smartBotMaxTxPerHour: envNum("SMART_BOT_MAX_TX_PER_HOUR", 20),
  /** …or more than this many of its positions were bought and sold in the same block (30 days). */
  smartBotMaxSameBlock: envNum("SMART_BOT_MAX_SAME_BLOCK", 0),
  /** Copy gate: copying it in the copy-fill replay must have a positive median return, over at least this many copies… */
  smartReplayMinCopies: envNum("SMART_REPLAY_MIN_COPIES", 10),
  /** …with the tape seeing other swaps near at least this share of entries (otherwise the replay can't tell). */
  smartReplayMinCoverage: envNum("SMART_REPLAY_MIN_COVERAGE", 0.5),
  /** Delay to replay at, seconds, until GodsEye has real copies to measure its own delay from. */
  smartReplayDelaySec: envNum("SMART_REPLAY_DELAY_SEC", 5),
  /** The copy must also pay at this multiple of that delay (the delay is a guess until real copies measure it); the worse of the two is what the gate sees. 1 = off. */
  /** A median copy return above this (%) is not believable (honest wallets sit well under it): the replay is pricing against a scripted tape, so it doesn't count. */
  smartReplayMaxMedianPct: envNum("SMART_REPLAY_MAX_MEDIAN_PCT", 100),
  smartReplayStressFactor: envNum("SMART_REPLAY_STRESS_FACTOR", 3),

  // ---- Discovery: finding wallets worth watching ----
  discoverCron: envStr("DISCOVER_CRON", "*/30 * * * *"),
  /** How many of Solana's busiest pools to read recent trades from. */
  discoverPools: envNum("DISCOVER_POOLS", 40),
  /** Only count trades at least this big (USD) when looking for traders. */
  discoverMinTradeUsd: envNum("DISCOVER_MIN_TRADE_USD", 300),
  /** Cap on brand-new wallets added per discovery run (keeps RPC usage sane). */
  discoverMaxNewPerRun: envNum("DISCOVER_MAX_NEW_PER_RUN", 100),

  // ---- Analysis: reading each wallet's history ----
  analyzeCron: envStr("ANALYZE_CRON", "*/10 * * * *"),
  analyzePerRun: envNum("ANALYZE_PER_RUN", 90),
  /** Wallets analyzed at the same time (each mostly waits on the network). */
  analyzeConcurrency: envNum("ANALYZE_CONCURRENCY", 12),
  /** First look at a wallet: read back this many days of its transactions… */
  historyDays: envNum("HISTORY_DAYS", 7),
  /** …but at most this many transactions on first look (busy bots trade thousands a day): breadth first. */
  historyTxLimit: envNum("HISTORY_TX_LIMIT", 1000),
  /** Promising wallets (copied, smart money, proven or profitable) are then read back up to this many in total. */
  historyDeepTxLimit: envNum("HISTORY_DEEP_TX_LIMIT", 5000),
  /** Wallets studied before deeper history existed: how many to read further back per analysis run. */
  historyDeepenPerRun: envNum("HISTORY_DEEPEN_PER_RUN", 6),
  /** Steady cap on history RPC requests per second (each transaction in a batch counts). Keep well under your plan's limit. */
  rpcMaxRps: envNum("RPC_MAX_RPS", 75),
  /** Share of RPC_MAX_RPS reserved for the copy engine (watcher, executor). Analysis is paced at the rest, and
   *  also yields whenever copy-engine calls go over their reserve. Clamped to 0.05..0.9. */
  rpcCopyReserve: Math.min(0.9, Math.max(0.05, envNum("RPC_COPY_RESERVE", 0.2))),
  /** Delete raw wallet_swaps older than this many days (closed_trades keeps the round trips). 0 = keep forever. */
  swapsRetentionDays: envNum("SWAPS_RETENTION_DAYS", 90),
  /** Raw swaps older than this many days move to compressed daily files in data/archive (shared/src/archive.ts); 0 = off.
   *  Wallet stats and the quant job look back 30 days, so keep it at 30 or more. */
  swapsHotDays: envNum("SWAPS_HOT_DAYS", 30),
  /** The same for junk wallets (bots, copy-replay rejects): never copied, re-read rarely. */
  swapsJunkHotDays: envNum("SWAPS_JUNK_HOT_DAYS", 7),
  archiveCron: envStr("ARCHIVE_CRON", "25 * * * *"),
  /** Daily SQLite housekeeping (retention pruning, then a WAL checkpoint), UTC. */
  pruneCron: envStr("PRUNE_CRON", "17 3 * * *"),
  /** Wallets younger than this many days count as "fresh". */
  freshWalletDays: envNum("FRESH_WALLET_DAYS", 3),
  /** Re-analyze a wallet at most this often (leaders are also updated live). */
  reanalyzeMinutes: envNum("REANALYZE_MINUTES", 60),
  /** …but a wallet the learning loop found to be a bot only this often (days). */
  botReanalyzeDays: envNum("BOT_REANALYZE_DAYS", 7),

  // ---- Tiers (see src/analysis/tiers.ts) ----
  quitAfterDays: envNum("QUIT_AFTER_DAYS", 7),
  /** A buy within this many seconds of the token's first pool counts as "early". */
  earlyBuySeconds: envNum("EARLY_BUY_SECONDS", 600),
  minClosedForProven: envNum("MIN_CLOSED_FOR_PROVEN", 10),
  /** "Sold before a crash" = the token fell at least this much (%)… */
  crashDropPct: envNum("CRASH_DROP_PCT", 50),
  /** …within this many minutes of the sale… */
  crashWindowMinutes: envNum("CRASH_WINDOW_MINUTES", 60),
  /** …and it counts as an insider pattern only with this many such exits… */
  crashMinExits: envNum("CRASH_MIN_EXITS", 3),
  /** …making up at least this share of the wallet's closed trades in 30 days. */
  crashMinShare: envNum("CRASH_MIN_SHARE", 0.25),

  // ---- Learning loop (see src/learning/weights.ts) ----
  learnCron: envStr("LEARN_CRON", "*/15 * * * *"),
  /** Copy at most this many wallets at once (the top earners). */
  maxLeaders: envNum("COPY_MAX_LEADERS", 10),
  /** The most of the copy budget one leader can hold (0.25 = a quarter); 1 = no cap. */
  maxLeaderShare: envNum("COPY_MAX_LEADER_SHARE", 0.25),
  /** A leader needs at least this share of its buys (14 days) in coins the rug screen passes, or it isn't copied; 0 = off. */
  minCopyableShare: envNum("COPY_MIN_COPYABLE_SHARE", 0.3),
  /** Our own copies of a leader must not lose more than this (SOL) over the last 14 days, or the leader is dropped. */
  copyLossDropSol: envNum("COPY_LOSS_DROP_SOL", 0.2),

  // ---- Copy trading (real money by default) ----
  /** Total SOL GodsEye may have in copy positions at once, shared out by weight. */
  copyBudgetSol: envNum("COPY_BUDGET_SOL", 1),
  copyMinTradeSol: envNum("COPY_MIN_TRADE_SOL", 0.01),
  copyMaxTradeSol: Math.min(HARD_MAX_COPY_TRADE_SOL, envNum("COPY_MAX_TRADE_SOL", 0.1)),
  maxPositions: envNum("COPY_MAX_POSITIONS", 5),
  /** Stop copying for the rest of the UTC day once realized losses hit this. */
  dailyLossLimitSol: envNum("COPY_DAILY_LOSS_LIMIT_SOL", 0.5),
  /** Always keep this much SOL for fees. */
  walletReserveSol: envNum("WALLET_RESERVE_SOL", 0.05),
  /** Our own safety exits, even if the leader never sells. */
  stopLossPct: envNum("COPY_STOP_LOSS_PCT", 35),
  takeProfitPct: envNum("COPY_TAKE_PROFIT_PCT", 300),
  maxHoldHours: envNum("COPY_MAX_HOLD_HOURS", 48),
  /** Ignore a leader's trade if GodsEye sees it later than this (price has moved on). */
  maxCopyDelaySeconds: envNum("COPY_MAX_DELAY_SECONDS", 60),
  /** Don't copy buys that are smaller than this (SOL) — dust or tests. */
  minLeaderBuySol: envNum("MIN_LEADER_BUY_SOL", 0.2),
  slippageBps: envNum("COPY_SLIPPAGE_BPS", 300),
  /** Most slippage a stop-loss / trailing-stop sell may allow after slippage failures (it steps 3% → 10% → 25%). */
  exitMaxSlippageBps: envNum("COPY_EXIT_MAX_SLIPPAGE_BPS", 2500),
  priorityFeeMaxLamports: envNum("PRIORITY_FEE_MAX_LAMPORTS", 1_000_000),
  positionCron: envStr("POSITION_CRON", "* * * * *"),
  /** Safety net for missed live events: re-read leaders' newest transactions this often. */
  pollSeconds: envNum("LEADER_POLL_SECONDS", 30),

  // ---- Rug checks (see src/market/rugcheck.ts) ----
  rugCheckEnabled: envBool("RUG_CHECK_ENABLED", true),
  rugBlockMintAuthority: envBool("RUG_BLOCK_MINT_AUTHORITY", true),
  rugMaxRiskScore: envNum("RUG_MAX_RISK_SCORE", 75),
  /** Skip Token-2022 coins that take at least this many basis points on every transfer (a tax on each buy and sell; 1000 = 10%). */
  rugMaxTransferFeeBps: envNum("RUG_MAX_TRANSFER_FEE_BPS", 1000),
  /** Skip coins whose pool liquidity isn't at least this % locked or burned (liquidity-weighted across pools; 0 = off). */
  lpMinLockedPct: envNum("LP_MIN_LOCKED_PCT", 90),
  /** Concentrated-liquidity pools (Orca, Raydium CLMM, Meteora DLMM) hold positions, not LP tokens, so "% locked" does not describe them: "block" counts them like any pool (default), "warn" leaves them out of the figure. */
  lpConcentratedPools: (envStr("LP_CONCENTRATED_POOLS", "block") === "warn" ? "warn" : "block") as "block" | "warn",
  rugAllowlist: list("RUG_ALLOWLIST"),
  rugCheckCacheHours: envNum("RUG_CHECK_CACHE_HOURS", 6),
  /** Bundled / clustered supply check before buying (see src/market/holders.ts). */
  holderCheckEnabled: envBool("HOLDER_CHECK_ENABLED", true),
  /** Block if more than this % of supply was bought in the coin's first two slots (a bundled launch). */
  bundleMaxPct: envNum("BUNDLE_MAX_PCT", 25),
  /** Block if top holders funded by one wallet (or by the creator) hold more than this %. */
  clusterMaxPct: envNum("CLUSTER_MAX_PCT", 15),
  /** Block if the top-10 holders (pools left out) hold more than this %. */
  top10MaxPct: envNum("TOP10_MAX_PCT", 50),
  /** Block if a RugCheck insider network holds more than this %. */
  insiderMaxPct: envNum("INSIDER_MAX_PCT", 20),
  /** Give up (and skip the buy) if the holder check takes longer than this. */
  holderCheckTimeoutMs: envNum("HOLDER_CHECK_TIMEOUT_MS", 8000),

  // ---- Shadow log (see src/shadow/): rug-screens and follows every copyable leader buy, with or without SOL ----
  shadowEnabled: envBool("SHADOW_ENABLED", true),
  /** Screens running at once, and how many may wait; beyond that a candidate is logged without a screen. */
  shadowMaxScreens: envNum("SHADOW_MAX_SCREENS", 2),
  shadowMaxQueue: envNum("SHADOW_MAX_QUEUE", 40),

  // ---- Misc ----
  /** Never track these wallets (exchanges, your own wallets…). */
  ignoreWallets: list("IGNORE_WALLETS"),
};

export type Config = typeof config;

/** Which Solana RPC to use: your own URL > Helius (free key) > public RPC. */
export function rpcUrl(): string {
  if (config.solanaRpcUrl) return config.solanaRpcUrl;
  if (config.heliusApiKey) return `https://mainnet.helius-rpc.com/?api-key=${config.heliusApiKey}`;
  return "https://api.mainnet-beta.solana.com";
}

export function wsUrl(): string | undefined {
  if (config.solanaWsUrl) return config.solanaWsUrl;
  if (!config.solanaRpcUrl && config.heliusApiKey) return `wss://mainnet.helius-rpc.com/?api-key=${config.heliusApiKey}`;
  return undefined; // web3.js derives it from the RPC URL
}

/** RPC for the copy path: COPY_RPC_URL > Helius (free key) > the main RPC. */
export function copyRpcUrl(): string {
  if (config.copyRpcUrl) return config.copyRpcUrl;
  if (config.heliusApiKey) return `https://mainnet.helius-rpc.com/?api-key=${config.heliusApiKey}`;
  return rpcUrl();
}

export function copyWsUrl(): string | undefined {
  if (config.copyWsUrl) return config.copyWsUrl;
  if (!config.copyRpcUrl && config.heliusApiKey) return `wss://mainnet.helius-rpc.com/?api-key=${config.heliusApiKey}`;
  return config.copyRpcUrl ? undefined : wsUrl();
}
