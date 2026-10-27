// Shapes of the dashboard's data feeds (used by the website and by GodsEye when publishing).
import type { Tier, WalletKind } from "./constants";

/** waiting_for_ip = the gRPC provider rejects this connection's IP (allowlist). */
export type StreamStatus = "connected" | "reconnecting" | "waiting_for_ip" | "stopped";

export interface Summary {
  live: boolean;
  heartbeat: string | null;
  agentStatus: string | null;
  /** null = the agent hasn't reported its mode yet (shown as unknown, never assumed). */
  copyMode: "real" | "paper" | null;
  paused: boolean;
  wallet: { pubkey: string | null; balanceSol: number | null; checkedAt: string | null };
  closedPositions: number;
  wins: number;
  losses: number;
  /** Share of closed copies that made money, 0–1 (null before the first close). Current mode only. */
  winRate: number | null;
  realizedPnlSol: number;
  todayPnlSol: number;
  unrealizedPnlSol: number;
  /** GodsEye's own results in USD at settlement (unrealized at today's SOL price), current mode only, after
   *  recorded fees. null when a dollar value is unknown. "today" is the UTC day. */
  realizedPnlUsd: number | null;
  todayPnlUsd: number | null;
  unrealizedPnlUsd: number | null;
  /** Network fees, tips and rent paid on closed copies (SOL), and how many closed real copies have no fee record. */
  feesSol: number;
  feesUnrecorded: number;
  /** SOL's USD price now (from the agent). */
  solUsd: number | null;
  openPositions: number;
  maxPositions: number;
  copiesToday: number;
  walletsTracked: number;
  leaders: number;
  freshWallets24h: number;
  tierCounts: Record<Tier, number>;
  kindCounts: Record<WalletKind, number>;
  lastLearningAt: string | null;
  lastDiscoveryAt: string | null;
  stream: {
    enabled: boolean;
    status: StreamStatus | null;
    /** Connected, the agent is live and a trade arrived in the last 2 minutes: the only time to show it as live. */
    healthy: boolean;
    /** While waiting_for_ip: tries so far and how many different IPs they came from. */
    ipTries: number;
    ipDistinct: number;
    lastAt: string | null;
    txPerSec: number | null;
    swapsPerSec: number | null;
    walletsInMemory: number | null;
    walletsSeen24h: number;
    walletsSeenTotal: number;
  };
}

/** A wallet seen on the live gRPC stream (running totals, not a full analysis). */
export interface LiveWalletRow {
  address: string;
  first_seen_at: string;
  last_seen_at: string;
  swaps: number;
  buys: number;
  sells: number;
  volume_sol: number;
  live_pnl_sol: number;
  live_pnl_usd: number;
  live_closed: number;
  live_wins: number;
  live_kind: WalletKind;
  live_ai_score: number | null;
  promoted: number;
  tier: Tier | null;
}

export interface LiveQuery {
  sort?: "pnl" | "swaps" | "volume" | "recent";
  kind?: WalletKind | "all";
  limit?: number;
}

/** One row of the public wallet database. */
export interface WalletRow {
  address: string;
  tier: Tier;
  tier_reason: string | null;
  tier_changed_at: string | null;
  kind: WalletKind;
  ai_score: number | null;
  copy_weight: number;
  is_fresh: number;
  funder: string | null;
  discovered_via: string;
  first_seen_at: string;
  chain_created_at: string | null;
  age_is_lower_bound: number;
  last_activity_at: string | null;
  /** Where this wallet's stats start: the oldest transaction GodsEye read. Stats labelled "30 days" only cover from here. */
  history_from: string | null;
  last_analyzed_at: string | null;
  pnl_7d_sol: number | null;
  pnl_30d_sol: number | null;
  /** Realized P&L in USD, each trade valued when it settled. */
  pnl_7d_usd: number | null;
  pnl_30d_usd: number | null;
  win_rate_30d: number | null;
  closed_30d: number | null;
  swaps_30d: number | null;
  /** How many tracked wallets share this wallet's funder (including itself). */
  group_size: number;
  /** 1 if GodsEye currently counts it as smart money. */
  is_smart: number;
}

export interface WalletQuery {
  q?: string;
  tier?: Tier | "all";
  kind?: WalletKind | "all";
  fresh?: boolean;
  copied?: boolean;
  sort?: "pnl_30d" | "pnl_7d" | "weight" | "ai_score" | "last_activity" | "first_seen";
  limit?: number;
  offset?: number;
}

export interface WalletList {
  rows: WalletRow[];
  total: number;
}

export interface KindReason {
  points: number;
  reason: string;
}

export interface WalletStats {
  swaps_total: number;
  swaps_7d: number;
  swaps_30d: number;
  pnl_7d_sol: number;
  pnl_30d_sol: number;
  pnl_all_sol: number;
  pnl_7d_usd: number | null;
  pnl_30d_usd: number | null;
  pnl_all_usd: number | null;
  closed_7d: number;
  closed_30d: number;
  wins_30d: number;
  win_rate_30d: number | null;
  best_trade_share: number | null;
  avg_buy_sol: number | null;
  avg_buy_usd: number | null;
  avg_hold_minutes: number | null;
  median_hold_sec: number | null;
  same_block_round_trips: number;
  early_buys: number;
  early_buy_rate: number | null;
  first_trade_at: string | null;
  last_trade_at: string | null;
  computed_at: string;
}

export interface Evidence {
  id: number;
  kind: string;
  detail: string;
  mint: string | null;
  signature: string | null;
  ts: string;
}

export interface SwapRow {
  id: number;
  signature: string;
  ts: string;
  mint: string;
  symbol: string | null;
  side: "buy" | "sell";
  token_amount: number;
  sol_amount: number;
  price_sol: number;
  quote: string;
  quote_amount: number | null;
  usd_amount: number | null;
  venue: string | null;
  token_age_sec: number | null;
}

export interface WeightChange {
  id: number;
  wallet: string;
  ts: string;
  old_weight: number;
  new_weight: number;
  reason: string;
}

export interface CopyTrade {
  id: number;
  leader: string;
  leader_signature: string;
  leader_ts: string;
  mint: string;
  symbol: string | null;
  side: "buy" | "sell";
  mode: "real" | "paper";
  status: "pending" | "filled" | "failed" | "skipped";
  reason: string | null;
  weight: number | null;
  size_sol: number | null;
  token_amount: number | null;
  price_sol: number | null;
  signature: string | null;
  /** Shown publicly: IPs, keys and paths are stripped. */
  error: string | null;
  /** Network fees, tips and rent this trade cost (SOL); null = not recorded. */
  fee_sol: number | null;
  position_id: number | null;
  latency_ms: number | null;
  created_at: string;
  filled_at: string | null;
  proof_hash?: string | null;
}

export interface Position {
  id: number;
  mint: string;
  symbol: string | null;
  leader: string;
  mode: "real" | "paper";
  status: "open" | "closed";
  token_amount: number;
  tokens_bought: number;
  cost_sol: number;
  proceeds_sol: number;
  cost_usd: number | null;
  proceeds_usd: number;
  pnl_usd: number | null;
  /** Fees, tips and rent paid (SOL), already taken out of pnl_sol / pnl_usd; null = not recorded. */
  fee_sol: number | null;
  entry_price_sol: number;
  last_price_sol: number | null;
  last_price_ts: string | null;
  opened_at: string;
  closed_at: string | null;
  exit_reason: string | null;
  pnl_sol: number | null;
  pnl_pct: number | null;
  unrealized_sol?: number;
  unrealized_pct?: number;
  unrealized_usd?: number | null;
}

export interface WalletDetail {
  wallet: WalletRow;
  stats: WalletStats | null;
  evidence: Evidence[];
  kindReasons: KindReason[];
  swaps: SwapRow[];
  weightHistory: WeightChange[];
  group: WalletRow[];
  copies: CopyTrade[];
  copyPnlSol: number;
  copyPnlUsd: number | null;
  copyClosed: number;
  /** Smart-money status and what its buys did next (null if never considered). */
  smart: SmartWalletRow | null;
}

export interface WalletGroup {
  funder: string;
  funder_tier: Tier | null;
  size: number;
  ai: number;
  human: number;
  unknown: number;
  fresh: number;
  newest_at: string | null;
  likely_exchange: boolean;
  members: Pick<WalletRow, "address" | "tier" | "kind" | "ai_score" | "is_fresh" | "pnl_30d_sol" | "pnl_30d_usd" | "chain_created_at">[];
}

export interface Leader {
  address: string;
  tier: Tier;
  kind: WalletKind;
  copy_weight: number;
  weight_reason: string | null;
  pnl_7d_sol: number | null;
  pnl_30d_sol: number | null;
  pnl_7d_usd: number | null;
  pnl_30d_usd: number | null;
  win_rate_30d: number | null;
  closed_30d: number | null;
  copy_pnl_sol: number;
  copy_pnl_usd: number | null;
  copy_closed: number;
  last_activity_at: string | null;
  /** Where this wallet's stats start: the oldest transaction GodsEye read. Stats labelled "30 days" only cover from here. */
  history_from: string | null;
}

/** A threshold GodsEye learns from outcomes instead of having it fixed. */
export interface LearnedParam {
  key: string;
  value: number;
  target: number | null;
  samples: number;
  reason: string | null;
  updated_at: string;
}

export interface ParamChange {
  id: number;
  key: string;
  ts: string;
  old_value: number;
  new_value: number;
  reason: string;
}

export interface LeadersData {
  leaders: Leader[];
  changes: WeightChange[];
  budgetSol: number;
  /** The learned minimum win rate to follow a wallet (null before the first learning cycle). */
  followBar: LearnedParam | null;
  followBarHistory: ParamChange[];
}

export interface CopiesData {
  open: Position[];
  closed: Position[];
  trades: CopyTrade[];
}

/** COWBOT's results in USD (each closed position valued when it settled). */
export interface Performance {
  startingCapitalUsd: number;
  equity: { ts: string; equity: number; cumPnl: number; drawdownPct: number }[];
  rollingWinRate: { day: string; winRate: number; trades: number }[];
  monthly: { month: string; pnlSol: number; returnPct: number }[];
  drawdown: { maxDrawdownPct: number; maxDrawdownSol: number; peakTs: string | null; troughTs: string | null };
  currentDrawdownPct: number;
  avgWinPct: number | null;
  avgLossPct: number | null;
  profitFactor: number | null;
}

export interface ProofEntryRow {
  id: number;
  kind: string;
  payload: string;
  prev_hash: string;
  hash: string;
  committed_at: string;
}

export interface ProofData {
  entries: ProofEntryRow[];
  total: number;
  chain: { ok: boolean; checked: number; brokenAtId?: number };
}

export interface LogRow {
  id: number;
  ts: string;
  level: string;
  message: string;
}

export interface RugCheckEntry {
  mint: string;
  symbol: string;
  verdict: "pass" | "blocked";
  blocks: string[];
  warnings: string[];
  rugcheck_score: number | null;
  checked_at: string;
}

/** Smart money moving into / out of one token. */
export interface SmartFlowRow {
  mint: string;
  symbol: string | null;
  buy_usd_1h: number;
  sell_usd_1h: number;
  buy_usd_24h: number;
  sell_usd_24h: number;
  buyers_24h: number;
  sellers_24h: number;
  first_smart_buy_at: string | null;
  /** Price change since the first smart buy in the last 24h (%), from prices seen on the stream. */
  change_since_first_buy: number | null;
  last_trade_at: string;
  /** "organic": a broad, independent crowd traded it; "unverified": too early to say, or not judged yet. Tokens judged thin or wash are not listed. */
  organic: "organic" | "unverified";
  /** Different wallets the stream has seen trade it (at least this many), and a 0-100 score of how broad its crowd is. */
  traders: number | null;
  organic_score: number | null;
}

export interface SmartSignalRow {
  id: number;
  ts: string;
  mint: string;
  symbol: string | null;
  kind: "accumulate" | "exit";
  wallet_count: number;
  usd: number;
  token_age_min: number | null;
  ret_1h: number | null;
  ret_6h: number | null;
  ret_24h: number | null;
  organic: "organic" | "unverified";
}

/** How well signals have worked so far (the learning). */
export interface SignalScore {
  kind: "accumulate" | "exit";
  horizon: "1h" | "6h" | "24h";
  signals: number;
  measured: number;
  /** Share that went the predicted way (up for accumulate, down for exit). */
  hit_rate: number | null;
  median_ret: number | null;
}

export interface SmartWalletRow {
  address: string;
  source: "analyzed" | "live";
  pnl_usd: number | null;
  closed: number | null;
  win_rate: number | null;
  lead_n: number;
  lead_hit_rate: number | null;
  lead_median_6h: number | null;
  active: number;
  reason: string | null;
  tier: Tier | null;
  kind: WalletKind | null;
}

export interface SmartMoneyData {
  followBar: LearnedParam | null;
  activeWallets: number;
  droppedWallets: number;
  flows: SmartFlowRow[];
  signals: SmartSignalRow[];
  scorecard: SignalScore[];
  wallets: SmartWalletRow[];
  /** Smart trades recorded in the last 24h. */
  trades24h: number;
}
