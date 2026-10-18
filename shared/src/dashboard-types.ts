// Shapes of the dashboard's data feeds (used by the website and by GodsEye when publishing).
import type { Tier, WalletKind } from "./constants";

export interface Summary {
  live: boolean;
  heartbeat: string | null;
  agentStatus: string | null;
  copyMode: "real" | "paper";
  paused: boolean;
  wallet: { pubkey: string | null; balanceSol: number | null; checkedAt: string | null };
  closedPositions: number;
  wins: number;
  losses: number;
  winRate: number | null;
  realizedPnlSol: number;
  todayPnlSol: number;
  unrealizedPnlSol: number;
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
    status: string | null;
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
  last_analyzed_at: string | null;
  pnl_7d_sol: number | null;
  pnl_30d_sol: number | null;
  win_rate_30d: number | null;
  closed_30d: number | null;
  swaps_30d: number | null;
  /** How many tracked wallets share this wallet's funder (including itself). */
  group_size: number;
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
  closed_7d: number;
  closed_30d: number;
  wins_30d: number;
  win_rate_30d: number | null;
  best_trade_share: number | null;
  avg_buy_sol: number | null;
  avg_hold_minutes: number | null;
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
  error: string | null;
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
  copyClosed: number;
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
  members: Pick<WalletRow, "address" | "tier" | "kind" | "ai_score" | "is_fresh" | "pnl_30d_sol" | "chain_created_at">[];
}

export interface Leader {
  address: string;
  tier: Tier;
  kind: WalletKind;
  copy_weight: number;
  weight_reason: string | null;
  pnl_7d_sol: number | null;
  pnl_30d_sol: number | null;
  win_rate_30d: number | null;
  closed_30d: number | null;
  copy_pnl_sol: number;
  copy_closed: number;
  last_activity_at: string | null;
}

export interface LeadersData {
  leaders: Leader[];
  changes: WeightChange[];
  budgetSol: number;
}

export interface CopiesData {
  open: Position[];
  closed: Position[];
  trades: CopyTrade[];
}

export interface Performance {
  startingCapitalSol: number;
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
