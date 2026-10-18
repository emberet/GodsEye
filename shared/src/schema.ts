/**
 * The database layout. One SQLite file (data/godseye.db) is shared by the
 * agent (writes) and the dashboard (reads).
 * "CREATE TABLE IF NOT EXISTS" means it's safe to run every startup.
 */
export const SCHEMA_SQL = /* sql */ `
-- Key/value facts about the agent: heartbeat, wallet address, mode...
CREATE TABLE IF NOT EXISTS agent_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- GodsEye's diary (shown as the terminal feed on the dashboard)
CREATE TABLE IF NOT EXISTS agent_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  level TEXT NOT NULL,
  message TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_log_ts ON agent_log(ts);

-- Rug checks on every token GodsEye considers buying (cached a few hours)
CREATE TABLE IF NOT EXISTS rug_checks (
  mint TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('pass','blocked')),
  blocks TEXT NOT NULL,
  warnings TEXT NOT NULL,
  rugcheck_score REAL,
  checked_at TEXT NOT NULL
);

-- Tamper-evident chain of every decision GodsEye makes (see proof.ts)
CREATE TABLE IF NOT EXISTS proof_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  committed_at TEXT NOT NULL
);

-- Every wallet GodsEye has found and analyzed (the public wallet database)
CREATE TABLE IF NOT EXISTS wallets (
  address TEXT PRIMARY KEY,
  first_seen_at TEXT NOT NULL,
  -- how GodsEye found it: top_pool_trader · funded_by_tracked · manual
  discovered_via TEXT NOT NULL,
  discovered_detail TEXT,
  -- when the wallet itself was created on Solana (its first transaction), if known
  chain_created_at TEXT,
  -- true if the history goes back further than GodsEye looked (age is a lower bound)
  age_is_lower_bound INTEGER NOT NULL DEFAULT 0,
  is_fresh INTEGER NOT NULL DEFAULT 0,
  -- the wallet that sent this wallet its first SOL; wallets with the same funder form a group
  funder TEXT,
  tier TEXT NOT NULL DEFAULT 'unrated',
  tier_reason TEXT,
  tier_changed_at TEXT,
  kind TEXT NOT NULL DEFAULT 'unknown',
  ai_score REAL,
  -- all transactions (not just swaps) per hour, measured on first look
  tx_per_hour REAL,
  kind_reasons TEXT NOT NULL DEFAULT '[]',
  copy_weight REAL NOT NULL DEFAULT 0,
  weight_reason TEXT,
  last_analyzed_at TEXT,
  last_activity_at TEXT,
  -- newest signature GodsEye has read for this wallet (so it only reads new ones next time)
  last_signature TEXT,
  analyze_errors INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_wallets_tier ON wallets(tier);
CREATE INDEX IF NOT EXISTS idx_wallets_funder ON wallets(funder);
CREATE INDEX IF NOT EXISTS idx_wallets_weight ON wallets(copy_weight);
CREATE INDEX IF NOT EXISTS idx_wallets_analyzed ON wallets(last_analyzed_at);

-- Every swap GodsEye has seen a tracked wallet make (SOL-priced)
CREATE TABLE IF NOT EXISTS wallet_swaps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet TEXT NOT NULL,
  signature TEXT NOT NULL,
  slot INTEGER NOT NULL,
  ts TEXT NOT NULL,
  mint TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('buy','sell')),
  token_amount REAL NOT NULL,
  -- the wallet's token balance before this swap (used to copy partial sells)
  token_balance_before REAL NOT NULL DEFAULT 0,
  sol_amount REAL NOT NULL,
  price_sol REAL NOT NULL,
  venue TEXT,
  jito_tip INTEGER NOT NULL DEFAULT 0,
  fee_lamports INTEGER NOT NULL DEFAULT 0,
  -- seconds since the token's first pool was created, if known
  token_age_sec REAL,
  UNIQUE (signature, wallet, mint)
);
CREATE INDEX IF NOT EXISTS idx_swaps_wallet_ts ON wallet_swaps(wallet, ts);
CREATE INDEX IF NOT EXISTS idx_swaps_mint ON wallet_swaps(mint);

-- Rolled-up performance per wallet (recomputed on every analysis)
CREATE TABLE IF NOT EXISTS wallet_stats (
  wallet TEXT PRIMARY KEY,
  computed_at TEXT NOT NULL,
  swaps_total INTEGER NOT NULL,
  swaps_7d INTEGER NOT NULL,
  swaps_30d INTEGER NOT NULL,
  pnl_7d_sol REAL NOT NULL,
  pnl_30d_sol REAL NOT NULL,
  pnl_all_sol REAL NOT NULL,
  closed_7d INTEGER NOT NULL,
  closed_30d INTEGER NOT NULL,
  wins_30d INTEGER NOT NULL,
  win_rate_30d REAL,
  best_trade_share REAL,
  avg_buy_sol REAL,
  avg_hold_minutes REAL,
  early_buys INTEGER NOT NULL DEFAULT 0,
  early_buy_rate REAL,
  first_trade_at TEXT,
  last_trade_at TEXT
);

-- Why a wallet got its tier (shown publicly on its page)
CREATE TABLE IF NOT EXISTS wallet_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet TEXT NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT NOT NULL,
  mint TEXT,
  signature TEXT,
  ts TEXT NOT NULL,
  UNIQUE (wallet, kind, mint, signature)
);
CREATE INDEX IF NOT EXISTS idx_evidence_wallet ON wallet_evidence(wallet);

-- The learning loop's memory: every time a wallet's copy weight changes
CREATE TABLE IF NOT EXISTS weight_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet TEXT NOT NULL,
  ts TEXT NOT NULL,
  old_weight REAL NOT NULL,
  new_weight REAL NOT NULL,
  reason TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_weight_history_wallet ON weight_history(wallet, ts);

-- Facts about tokens (symbol, decimals, launch time, creator), cached
CREATE TABLE IF NOT EXISTS token_info (
  mint TEXT PRIMARY KEY,
  symbol TEXT,
  decimals INTEGER,
  pool_created_at TEXT,
  creator TEXT,
  checked_at TEXT NOT NULL
);

-- Every copy GodsEye made (or decided not to make)
CREATE TABLE IF NOT EXISTS copy_trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  leader TEXT NOT NULL,
  leader_signature TEXT NOT NULL,
  leader_ts TEXT NOT NULL,
  mint TEXT NOT NULL,
  symbol TEXT,
  side TEXT NOT NULL CHECK (side IN ('buy','sell')),
  mode TEXT NOT NULL CHECK (mode IN ('real','paper')),
  status TEXT NOT NULL CHECK (status IN ('pending','filled','failed','skipped')),
  reason TEXT,
  weight REAL,
  size_sol REAL,
  token_amount REAL,
  price_sol REAL,
  signature TEXT,
  error TEXT,
  position_id INTEGER,
  latency_ms INTEGER,
  proof_id INTEGER,
  created_at TEXT NOT NULL,
  filled_at TEXT,
  UNIQUE (leader_signature, mint)
);
CREATE INDEX IF NOT EXISTS idx_copy_trades_created ON copy_trades(created_at);

-- GodsEye's own positions, opened by copying a leader
CREATE TABLE IF NOT EXISTS positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mint TEXT NOT NULL,
  symbol TEXT,
  leader TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('real','paper')),
  status TEXT NOT NULL CHECK (status IN ('open','closed')),
  token_amount REAL NOT NULL,
  tokens_bought REAL NOT NULL,
  cost_sol REAL NOT NULL,
  proceeds_sol REAL NOT NULL DEFAULT 0,
  entry_price_sol REAL NOT NULL,
  last_price_sol REAL,
  last_price_ts TEXT,
  opened_at TEXT NOT NULL,
  closed_at TEXT,
  exit_reason TEXT,
  pnl_sol REAL,
  pnl_pct REAL
);
CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);
CREATE INDEX IF NOT EXISTS idx_positions_leader ON positions(leader);

-- Every wallet seen swapping on the live gRPC stream (running totals; full swaps
-- are only stored for wallets in the wallets table)
CREATE TABLE IF NOT EXISTS wallet_activity (
  address TEXT PRIMARY KEY,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  swaps INTEGER NOT NULL,
  buys INTEGER NOT NULL,
  sells INTEGER NOT NULL,
  volume_sol REAL NOT NULL,
  live_pnl_sol REAL NOT NULL DEFAULT 0,
  live_closed INTEGER NOT NULL DEFAULT 0,
  live_wins INTEGER NOT NULL DEFAULT 0,
  live_kind TEXT NOT NULL DEFAULT 'unknown',
  live_ai_score REAL,
  promoted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_activity_last_seen ON wallet_activity(last_seen_at);
CREATE INDEX IF NOT EXISTS idx_activity_pnl ON wallet_activity(live_pnl_sol);
`;
