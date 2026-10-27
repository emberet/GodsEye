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
  -- why the wallet is junk (a bot, or copying it lost in the replay); the public dashboard leaves these out
  junk_reason TEXT,
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
  -- what the wallet paid / received: SOL, USDC, USDT, or SOL+USDC etc. (sol_amount is always in SOL)
  quote TEXT NOT NULL DEFAULT 'SOL',
  quote_amount REAL,
  -- SOL's USD price at the time of the swap
  sol_usd REAL,
  -- what the swap was worth in USD when it settled (exact for USDC/USDT, SOL × price for SOL)
  usd_amount REAL,
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
  -- the same in USD, each trade valued when it settled (null if prices were missing)
  pnl_7d_usd REAL,
  pnl_30d_usd REAL,
  pnl_all_usd REAL,
  closed_7d INTEGER NOT NULL,
  closed_30d INTEGER NOT NULL,
  wins_30d INTEGER NOT NULL,
  win_rate_30d REAL,
  best_trade_share REAL,
  avg_buy_sol REAL,
  avg_buy_usd REAL,
  avg_hold_minutes REAL,
  -- median seconds from first buy to closing sell, and positions bought and sold in the same block (30 days): bot signs
  median_hold_sec REAL,
  same_block_round_trips INTEGER NOT NULL DEFAULT 0,
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
  pool_address TEXT,
  checked_at TEXT NOT NULL
);

-- Did the price crash right after a wallet sold? One row per sale checked (see analysis/crash.ts)
CREATE TABLE IF NOT EXISTS crash_checks (
  signature TEXT NOT NULL,
  mint TEXT NOT NULL,
  -- how far the token fell below the sell price within the window (%), null if no candle data
  drop_pct REAL,
  minutes_to_low REAL,
  -- sold within 20% of the previous hour's high (not into a dump already under way)
  near_top INTEGER,
  checked_at TEXT NOT NULL,
  PRIMARY KEY (signature, mint)
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
  cost_usd REAL,
  proceeds_usd REAL NOT NULL DEFAULT 0,
  pnl_usd REAL,
  -- the leader's win rate when GodsEye copied it (what the follow bar is learned from)
  leader_win_rate REAL,
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
  live_pnl_usd REAL NOT NULL DEFAULT 0,
  live_closed INTEGER NOT NULL DEFAULT 0,
  live_wins INTEGER NOT NULL DEFAULT 0,
  live_kind TEXT NOT NULL DEFAULT 'unknown',
  live_ai_score REAL,
  promoted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_activity_last_seen ON wallet_activity(last_seen_at);
CREATE INDEX IF NOT EXISTS idx_activity_pnl ON wallet_activity(live_pnl_sol);

-- SOL's hourly USD close (for valuing USDC/USDT-priced swaps in SOL)
CREATE TABLE IF NOT EXISTS sol_price_hourly (
  hour INTEGER PRIMARY KEY,
  usd REAL NOT NULL
);

-- SMART MONEY (see agent/src/smart/): wallets GodsEye currently treats as smart money
CREATE TABLE IF NOT EXISTS smart_wallets (
  address TEXT PRIMARY KEY,
  -- analyzed (proven track record) or live (winning big on the stream right now)
  source TEXT NOT NULL,
  pnl_usd REAL,
  closed INTEGER,
  win_rate REAL,
  -- what its buys did next: how many were measured, share up after 6h, median 6h return (%)
  lead_n INTEGER NOT NULL DEFAULT 0,
  lead_hit_rate REAL,
  lead_median_6h REAL,
  -- 1 = currently counted as smart; 0 = dropped (reason says why)
  active INTEGER NOT NULL DEFAULT 1,
  reason TEXT,
  updated_at TEXT NOT NULL
);

-- What copying each smart-money candidate would have earned at GodsEye's real delay (copy-fill replay, agent/src/smart/copy-check.ts)
CREATE TABLE IF NOT EXISTS copy_replays (
  wallet TEXT PRIMARY KEY,
  delay_sec REAL NOT NULL,
  -- copies replayed, and of those the share where the tape saw other swaps nearby (low = can't tell)
  n INTEGER NOT NULL,
  coverage REAL,
  median_ret_pct REAL,
  mean_ret_pct REAL,
  win_rate REAL,
  -- the leader's own mean return on the same positions
  leader_ret_pct REAL,
  -- positions left out because a return read above 1,000x (a pricing error)
  implausible INTEGER NOT NULL DEFAULT 0,
  computed_at TEXT NOT NULL
);

-- Every memecoin trade a smart wallet made (from the live stream), and what the price did next
CREATE TABLE IF NOT EXISTS smart_flows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  signature TEXT NOT NULL,
  ts TEXT NOT NULL,
  wallet TEXT NOT NULL,
  mint TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('buy','sell')),
  usd REAL,
  price_usd REAL,
  -- the wallet's win rate when it made this trade (what the follow bar is learned from)
  wallet_win_rate REAL,
  ret_1h REAL,
  ret_6h REAL,
  ret_24h REAL,
  -- bits: 1 = 1h checked, 2 = 6h checked, 4 = 24h checked (a return can stay null if the price was unknown)
  checked INTEGER NOT NULL DEFAULT 0,
  UNIQUE (signature, wallet, mint)
);
CREATE INDEX IF NOT EXISTS idx_smart_flows_mint_ts ON smart_flows(mint, ts);
CREATE INDEX IF NOT EXISTS idx_smart_flows_wallet_ts ON smart_flows(wallet, ts);

-- "Smart money is moving": several smart wallets buying (or dumping) the same token within an hour
CREATE TABLE IF NOT EXISTS smart_signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  mint TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('accumulate','exit')),
  wallets TEXT NOT NULL,
  wallet_count INTEGER NOT NULL,
  usd REAL NOT NULL,
  price_usd REAL,
  token_age_min REAL,
  ret_1h REAL,
  ret_6h REAL,
  ret_24h REAL,
  checked INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_smart_signals_ts ON smart_signals(ts);

-- Latest USD price seen on the stream for tokens smart money touched
CREATE TABLE IF NOT EXISTS token_prices (
  mint TEXT PRIMARY KEY,
  price_usd REAL NOT NULL,
  ts TEXT NOT NULL,
  first_seen_at TEXT NOT NULL
);

-- SELF-ADJUSTING THRESHOLDS (agent/src/learning/adaptive.ts): current learned values…
CREATE TABLE IF NOT EXISTS learning_params (
  key TEXT PRIMARY KEY,
  value REAL NOT NULL,
  -- where the evidence points (the value moves toward it a step at a time)
  target REAL,
  samples INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  updated_at TEXT NOT NULL
);
-- …and every change, with why
CREATE TABLE IF NOT EXISTS param_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL,
  ts TEXT NOT NULL,
  old_value REAL NOT NULL,
  new_value REAL NOT NULL,
  reason TEXT NOT NULL
);

-- IPs the gRPC provider turned away (agent/src/stream/stream.ts): which ones come up most, to allowlist
CREATE TABLE IF NOT EXISTS stream_ip_seen (
  ip TEXT PRIMARY KEY,
  tries INTEGER NOT NULL DEFAULT 0,
  -- distinct minutes this IP was seen in
  minutes INTEGER NOT NULL DEFAULT 0,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL
);

-- SHADOW LOG (agent/src/shadow/): the first copyable leader buy of every token, what the rug screen saw in it, and what the
-- token did afterwards. Observation only: nothing here moves money or changes a copy decision, and it works with an empty wallet.
CREATE TABLE IF NOT EXISTS shadow_candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mint TEXT NOT NULL UNIQUE,
  symbol TEXT,
  leader TEXT NOT NULL,
  leader_signature TEXT NOT NULL,
  leader_ts TEXT NOT NULL,
  leader_weight REAL,
  seen_at TEXT NOT NULL,
  leader_sol REAL NOT NULL,
  -- what the leader paid per token: the price every later sample is compared with
  entry_price_sol REAL NOT NULL,
  entry_price_usd REAL,
  -- what a copy would have held (SOL), for quoting a sell at each mark
  sim_size_sol REAL,
  token_age_sec REAL,
  venue TEXT,
  -- what the copy engine did with this buy: bought · late · balance · paused · rug · unverified … (null until it decided)
  copy_outcome TEXT,
  -- the rug screen, run on arrival. pending · done · chain_unreadable · holders_failed · holders_timeout · queue_full · error
  screen_status TEXT NOT NULL DEFAULT 'pending',
  screened_at TEXT,
  screen_ms INTEGER,
  chain_ms INTEGER,
  rugcheck_ms INTEGER,
  holders_ms INTEGER,
  -- what the screen would have decided (pass / blocked), why, and the cutoffs in force at the time (JSON)
  verdict TEXT,
  blocks TEXT,
  warnings TEXT,
  limits TEXT,
  -- raw inputs, so cutoffs can be re-tuned later without re-reading the chain
  mint_authority TEXT,
  freeze_authority TEXT,
  extensions TEXT,
  rugcheck_ok INTEGER,
  rugcheck_score REAL,
  rugcheck_pools INTEGER,
  lp_locked_pct REAL,
  top10_pct REAL,
  launch_bundle_pct REAL,
  launch_buyers INTEGER,
  cluster_pct REAL,
  cluster_size INTEGER,
  cluster_from_creator INTEGER,
  insider_pct REAL
);
CREATE INDEX IF NOT EXISTS idx_shadow_candidates_seen ON shadow_candidates(seen_at);

-- What each candidate's price, liquidity and exit looked like 1 min … 24 h later. A missing price is recorded as a result
-- (no_price), not left as a gap: a token that stops being quoted is the rug a trade log can't see.
CREATE TABLE IF NOT EXISTS shadow_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id INTEGER NOT NULL,
  horizon_sec INTEGER NOT NULL,
  sampled_at TEXT NOT NULL,
  -- ok = priced · no_price = nobody quoted a price · missed = GodsEye wasn't running when this sample was due
  status TEXT NOT NULL CHECK (status IN ('ok','no_price','missed')),
  price_usd REAL,
  price_source TEXT,
  liquidity_usd REAL,
  -- selling what a copy would hold, as Jupiter quotes it right then: SOL back (null = no quote; the error says why)
  sell_quote_sol REAL,
  sell_quote_error TEXT,
  -- RugCheck asked again (first horizons only): how soon its report fills in for a new token
  rugcheck_ok INTEGER,
  rugcheck_score REAL,
  rugcheck_pools INTEGER,
  lp_locked_pct REAL,
  UNIQUE (candidate_id, horizon_sec)
);
`;
