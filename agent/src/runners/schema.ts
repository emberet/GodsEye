/**
 * Tables of the runner research (runners/, x/): created here, like the audit tables, not in the shared schema.
 * Observation only: nothing here is read by the copy engine.
 */
import type { DB } from "@godseye/shared";

const SQL = `
CREATE TABLE IF NOT EXISTS runner_tokens (
  mint TEXT PRIMARY KEY,
  -- stream: watched live from its pump.fun launch · backfill: read from the chain afterwards
  source TEXT NOT NULL,
  symbol TEXT,
  first_seen TEXT NOT NULL,
  first_slot INTEGER,
  -- the first price seen was the launch price (within 3x of pump.fun's starting price)
  launch_seen INTEGER NOT NULL DEFAULT 0,
  p0_sol REAL NOT NULL,
  -- peak of the minute medians (one odd print can't make a peak)
  peak_sol REAL NOT NULL,
  peak_at TEXT NOT NULL,
  -- the first minute whose median reached 3x the first price: calls on X before it are "early" (x/calls.ts)
  x3_at TEXT,
  multiple REAL NOT NULL,
  minutes_above_5x INTEGER NOT NULL DEFAULT 0,
  peak_mcap_usd REAL,
  buyers INTEGER NOT NULL,
  buys INTEGER NOT NULL,
  swaps INTEGER NOT NULL,
  -- set by the runner definition (runners/define.ts): 1 = a runner under the definition in force
  is_runner INTEGER NOT NULL DEFAULT 0,
  saved_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runner_tokens_first ON runner_tokens(first_seen);
CREATE INDEX IF NOT EXISTS idx_runner_tokens_runner ON runner_tokens(is_runner, first_seen);

-- The early buyers (first RUNNER_MAX_BUYERS) of every coin that came close to running.
CREATE TABLE IF NOT EXISTS runner_buyers (
  mint TEXT NOT NULL,
  wallet TEXT NOT NULL,
  rank INTEGER NOT NULL,
  ts TEXT NOT NULL,
  slot INTEGER,
  entry_sol REAL NOT NULL,
  sol REAL NOT NULL,
  tokens REAL NOT NULL,
  -- entry ÷ the coin's first price, and the coin's peak ÷ entry
  entry_x REAL NOT NULL,
  x_to_peak REAL NOT NULL,
  -- share of the tokens bought that were sold while watched, and SOL back ÷ SOL in on what was sold
  sold_pct REAL NOT NULL DEFAULT 0,
  exit_x REAL,
  -- the price a copy would have paid (the coin's price our copy delay later) ÷ the wallet's entry; null = unknown
  copy_x REAL,
  sniper INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL,
  PRIMARY KEY (mint, wallet)
);
CREATE INDEX IF NOT EXISTS idx_runner_buyers_wallet ON runner_buyers(wallet);

-- How many launches each wallet bought early, runner or not: the denominator of its hit rate.
CREATE TABLE IF NOT EXISTS runner_early_counts (
  wallet TEXT NOT NULL,
  day TEXT NOT NULL,
  early_buys INTEGER NOT NULL,
  PRIMARY KEY (wallet, day)
);

CREATE TABLE IF NOT EXISTS runner_catchers (
  wallet TEXT PRIMARY KEY,
  hits INTEGER NOT NULL,
  early_buys INTEGER NOT NULL,
  hit_rate REAL NOT NULL,
  hit_rate_lb REAL NOT NULL,
  base_rate REAL NOT NULL,
  days INTEGER NOT NULL,
  median_entry_x REAL,
  median_x_to_peak REAL,
  capture REAL,
  copyable_share REAL,
  label TEXT NOT NULL,
  x_handle TEXT,
  score REAL NOT NULL,
  qualifies INTEGER NOT NULL DEFAULT 0,
  first_added_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS x_searches (
  mint TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('runner','control')),
  window_from TEXT NOT NULL,
  window_to TEXT NOT NULL,
  -- when the coin reached 3x its first price (calls before it are "early"); null = never
  ran_at TEXT,
  tweets INTEGER NOT NULL,
  searched_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS x_posts (
  id TEXT PRIMARY KEY,
  mint TEXT NOT NULL,
  author_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  text TEXT NOT NULL,
  likes INTEGER, reposts INTEGER, replies INTEGER, quotes INTEGER, impressions INTEGER,
  fetched_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_x_posts_mint ON x_posts(mint, ts);
CREATE INDEX IF NOT EXISTS idx_x_posts_author ON x_posts(author_id, ts);

CREATE TABLE IF NOT EXISTS x_accounts (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  name TEXT,
  followers INTEGER,
  created_at TEXT,
  description TEXT,
  fetched_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS x_callers (
  author_id TEXT PRIMARY KEY,
  username TEXT,
  followers INTEGER,
  calls INTEGER NOT NULL,
  runner_calls INTEGER NOT NULL,
  early_runner_calls INTEGER NOT NULL,
  control_calls INTEGER NOT NULL,
  hit_rate_lb REAL NOT NULL,
  median_lead_min REAL,
  days INTEGER NOT NULL,
  linked_wallets TEXT,
  score REAL NOT NULL,
  updated_at TEXT NOT NULL
);

-- An X account tied to a wallet: the address is in its bio or a tweet, or the wallet keeps buying just before its calls.
CREATE TABLE IF NOT EXISTS x_wallet_links (
  author_id TEXT NOT NULL,
  wallet TEXT NOT NULL,
  how TEXT NOT NULL CHECK (how IN ('bio','tweet','timing')),
  n INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (author_id, wallet, how)
);
`;

const ensured = new WeakSet<DB>();
export function ensureRunnerTables(db: DB): void {
  if (ensured.has(db)) return;
  db.exec(SQL);
  ensured.add(db);
}

export function runnerTablesExist(db: DB): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='runner_tokens'").get();
}
