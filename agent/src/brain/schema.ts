/**
 * Tables of the Brain (brain/paper.ts, transitions.ts, state.ts, ledger.ts, quotes.ts): created here, like the runner tables,
 * not in the shared schema. Paper money and research only: the copy engine never reads them, and nothing here touches
 * copy_trades or positions. brain_transitions is the table the Mac trainer pulls (brain/spec/CONTRACT.md); the ledgers are the
 * server state brain/spec/features.yaml asks for ("new_server_state_required").
 */
import type { DB } from "@godseye/shared";

const SQL = `
-- One row per paper account: brain (the policy's own trades), explore (its exploration trades), baseline (today's real rules).
CREATE TABLE IF NOT EXISTS brain_paper_accounts (
  account TEXT PRIMARY KEY CHECK (account IN ('brain','explore','baseline')),
  bankroll_sol REAL NOT NULL,
  -- SOL not in a position: the bankroll, less what open positions cost (stake, fees, rent), plus what sells brought back
  cash_sol REAL NOT NULL,
  started_at TEXT NOT NULL,
  -- the UTC day day_loss_sol counts, and the realized loss on it (net of gains; negative = a net gain)
  day TEXT NOT NULL,
  day_loss_sol REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS brain_paper_positions (
  id INTEGER PRIMARY KEY,
  account TEXT NOT NULL CHECK (account IN ('brain','explore','baseline')),
  leader TEXT NOT NULL,
  mint TEXT NOT NULL,
  symbol TEXT,
  opened_at TEXT NOT NULL,
  closed_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('open','closed')),
  -- the stake as a fraction of COPY_MAX_TRADE_SOL (the policy's action)
  stake_frac REAL NOT NULL,
  -- SOL swapped into the coin; fees: every paper swap's network + priority fee; rent: the token account's, refunded on a full close
  cost_sol REAL NOT NULL,
  fee_sol REAL NOT NULL DEFAULT 0,
  rent_sol REAL NOT NULL DEFAULT 0,
  tokens REAL NOT NULL,
  tokens_left REAL NOT NULL,
  entry_price_sol REAL NOT NULL,
  last_price_sol REAL,
  last_price_ts TEXT,
  -- best price return seen, % (trailing stop, drawdown from the peak)
  peak_pct REAL,
  half_sold INTEGER NOT NULL DEFAULT 0,
  -- 1 once the leader sold this coin
  leader_sold INTEGER NOT NULL DEFAULT 0,
  -- SOL the sells quoted, before fees
  proceeds_sol REAL NOT NULL DEFAULT 0,
  -- net of every fee (and of the rent when it couldn't be refunded)
  pnl_sol REAL,
  pnl_pct REAL,
  exit_reason TEXT,
  model_version TEXT,
  explore INTEGER NOT NULL DEFAULT 0,
  -- what decides the exits: the real rule's name (baseline) or the exit network
  exit_rule TEXT,
  -- the leader's swap venue ("pumpswap (via bot)" …), and its holding right after the copied buy (balance before + bought)
  venue TEXT,
  leader_post_buy_tokens REAL,
  -- tokens the leader sold of this coin since the copied buy, and when it first sold
  leader_sold_tokens REAL NOT NULL DEFAULT 0,
  leader_sold_at TEXT,
  -- the last ok price from a tracked wallet's swap on the stream (last_price_ts also moves on a sell quote)
  last_tracked_price_ts TEXT,
  -- 1 when the latest sell quote found no route; quote_fails counts them in a row (3 = dead: written off)
  quote_failed INTEGER NOT NULL DEFAULT 0,
  quote_fails INTEGER NOT NULL DEFAULT 0,
  -- the latest sell quote that had a route, as SOL per token (sell_quote_ratio), and when
  quote_price_sol REAL,
  quote_ts TEXT
);
CREATE INDEX IF NOT EXISTS idx_brain_pos_open ON brain_paper_positions(status, account, mint);
CREATE INDEX IF NOT EXISTS idx_brain_pos_closed ON brain_paper_positions(account, closed_at);
CREATE INDEX IF NOT EXISTS idx_brain_pos_leader ON brain_paper_positions(leader, mint);

-- Each account's value (cash + open positions at their last price + refundable rent), every 10 minutes.
CREATE TABLE IF NOT EXISTS brain_paper_equity (
  account TEXT NOT NULL,
  ts TEXT NOT NULL,
  equity_sol REAL NOT NULL,
  PRIMARY KEY (account, ts)
);

-- One row per decision step, append-only (reward, done and position_id are filled in once known). Pulled by the Mac.
CREATE TABLE IF NOT EXISTS brain_transitions (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  account TEXT NOT NULL CHECK (account IN ('brain','explore','baseline')),
  kind TEXT NOT NULL CHECK (kind IN ('entry','exit')),
  position_id INTEGER,
  leader TEXT,
  mint TEXT,
  model_version TEXT,
  -- JSON array of the feature vector the decision saw
  features TEXT NOT NULL,
  -- entry: the stake fraction; exit: the index of hold / sell_half / sell_all
  action REAL NOT NULL,
  q TEXT,
  reward REAL,
  done INTEGER NOT NULL DEFAULT 0,
  info TEXT
);
CREATE INDEX IF NOT EXISTS idx_brain_tr_position ON brain_transitions(position_id, kind);
CREATE INDEX IF NOT EXISTS idx_brain_tr_account ON brain_transitions(account, ts);

-- THE MIRROR LEDGER (features.yaml cp_*): what a strict late copier got on each copy-eligible leader buy (an analyzed wallet,
-- >= MIN_LEADER_BUY_SOL). Entry: the first ok tracked swap by another wallet in [buy + 15 s, buy + 135 s] (none: y stays
-- null). Exit: the first ok tracked sell by another wallet from max(leader's first sell + 15 s, entry + 1 s); the first ok
-- price at or below −60% (stop, at that price); no exit by buy + 24 h: the next ok tracked price within 6 h (grounded),
-- else −1 (dead). y = exit / entry − 1 − 0.026; resolved_at = when y became known. Rows are kept 8 days.
CREATE TABLE IF NOT EXISTS mirror_ledger (
  id INTEGER PRIMARY KEY,
  leader TEXT NOT NULL,
  mint TEXT NOT NULL,
  buy_ts TEXT NOT NULL,
  buy_sig TEXT NOT NULL,
  leader_sol REAL,
  leader_price_sol REAL,
  entry_ts TEXT,
  entry_px REAL,
  leader_sell_ts TEXT,
  exit_ts TEXT,
  exit_px REAL,
  -- leader_sell · stop · grounded · dead · no_entry
  exit_kind TEXT,
  y REAL,
  -- ln(1 + clip(y, −0.99, 10)), summed by cp_lrshr_7d
  lr REAL,
  -- a Jupiter sell quote at the exit for what a COPY_MAX_TRADE_SOL copy held: quote / stake − 1 (logged only; null = none)
  y_quote REAL,
  resolved_at TEXT,
  -- tracked_active_wallets_1h when the row was written (density-dependent features are re-checked on it)
  n_tracked_wallets INTEGER,
  created_at TEXT NOT NULL,
  UNIQUE (buy_sig, leader, mint)
);
CREATE INDEX IF NOT EXISTS idx_mirror_leader_resolved ON mirror_ledger(leader, resolved_at);
CREATE INDEX IF NOT EXISTS idx_mirror_open ON mirror_ledger(buy_ts) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_mirror_buy_ts ON mirror_ledger(buy_ts);

-- ps_r_7d: what the coin did in the hour after the leader's first sell (one per copy-eligible buy, whatever became of its
-- mirror row): last ok tracked price in the hour after the sell minute / the sell minute's ok price − 1, clipped to [−1, 10];
-- no ok price in that hour at all = −1 (r stays null, dropped, only when the coin traded but not in the sell's first 3 minutes).
-- Written at the sell with r null; the delayed job fills r at avail_at = sell minute + 61 min (done = 1).
CREATE TABLE IF NOT EXISTS ps_ledger (
  id INTEGER PRIMARY KEY,
  leader TEXT NOT NULL,
  mint TEXT NOT NULL,
  buy_sig TEXT NOT NULL,
  sell_ts TEXT NOT NULL,
  avail_at TEXT NOT NULL,
  r REAL,
  done INTEGER NOT NULL DEFAULT 0,
  n_tracked_wallets INTEGER,
  UNIQUE (buy_sig, leader, mint)
);
CREATE INDEX IF NOT EXISTS idx_ps_leader_avail ON ps_ledger(leader, avail_at);
CREATE INDEX IF NOT EXISTS idx_ps_due ON ps_ledger(avail_at) WHERE done = 0;

-- dd_rate_7d: did the coin go silent an hour after a copy-eligible buy (no ok tracked swap in [buy + 60 min, buy + 120 min))?
-- Written at the buy with dead null; the delayed job fills it at avail_at = buy + 2 h 15 s.
CREATE TABLE IF NOT EXISTS dd_ledger (
  id INTEGER PRIMARY KEY,
  leader TEXT NOT NULL,
  mint TEXT NOT NULL,
  buy_sig TEXT NOT NULL,
  buy_ts TEXT NOT NULL,
  avail_at TEXT NOT NULL,
  dead INTEGER,
  done INTEGER NOT NULL DEFAULT 0,
  n_tracked_wallets INTEGER,
  UNIQUE (buy_sig, leader, mint)
);
CREATE INDEX IF NOT EXISTS idx_dd_leader_avail ON dd_ledger(leader, avail_at);
CREATE INDEX IF NOT EXISTS idx_dd_due ON dd_ledger(avail_at) WHERE done = 0;

-- Each coin's first sighting (brain/state.ts): its first tracked swap the server had (the stream's, or wallet_swaps' when
-- the stream first meets a coin already stored: source 'db'), the first ok price of a swap >= 0.01 SOL, the highest ok
-- price seen before the last hour (max_ok_price_at = its block time ts: dd_from_high's window is on ts), and the creator,
-- looked up once at first sighting ('' = looked up, none found).
-- Brain-owned: token_info is written by other code.
CREATE TABLE IF NOT EXISTS brain_token_first_seen (
  mint TEXT PRIMARY KEY,
  first_seen_at TEXT NOT NULL,
  source TEXT NOT NULL,
  first_ok_price REAL,
  first_ok_price_at TEXT,
  max_ok_price REAL,
  max_ok_price_at TEXT,
  creator TEXT,
  creator_resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_brain_first_seen_creator ON brain_token_first_seen(creator, first_seen_at);
CREATE INDEX IF NOT EXISTS idx_brain_first_seen_at ON brain_token_first_seen(first_seen_at);

-- tracked_active_wallets_1h (brain/state.ts): the distinct tracked wallets the stream delivered swaps of in each UTC hour
-- (by insert time), written only for an hour a process saw whole, so a restart reads the stream's count back. Kept 8 days.
CREATE TABLE IF NOT EXISTS brain_active_wallets_hourly (
  -- the hour's start, ISO
  hour TEXT PRIMARY KEY,
  wallets INTEGER NOT NULL
);

-- Research sell quotes (brain/quotes.ts), append-only: for a random sample of the Brain's paper candidates (bots and
-- pumpswap included), what selling a COPY_MAX_TRADE_SOL copy would get 5/15/30/60 s after the leader's buy and right after
-- its first sell, next to the last ok tracked price. ok · no_route (a quote with nothing back) · error · capped (over the
-- per-minute cap: not asked).
CREATE TABLE IF NOT EXISTS brain_shadow_quotes (
  id INTEGER PRIMARY KEY,
  leader TEXT NOT NULL,
  mint TEXT NOT NULL,
  buy_sig TEXT NOT NULL,
  venue TEXT,
  leader_ts TEXT NOT NULL,
  leader_price_sol REAL NOT NULL,
  tokens REAL NOT NULL,
  -- time ('time': a horizon of 5/15/30/60 s) or the leader's first sell ('leader_sell'); horizon_sec = seconds after the buy
  trigger TEXT NOT NULL CHECK (trigger IN ('time','leader_sell')),
  horizon_sec REAL NOT NULL,
  quoted_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok','no_route','error','capped')),
  sell_quote_sol REAL,
  error TEXT,
  tracked_price_sol REAL,
  tracked_price_age_sec REAL
);
CREATE INDEX IF NOT EXISTS idx_brain_quotes_mint ON brain_shadow_quotes(mint, quoted_at);
CREATE INDEX IF NOT EXISTS idx_brain_quotes_at ON brain_shadow_quotes(quoted_at);
`;

/** Columns added to a Brain table after it was first created on the server (CREATE TABLE IF NOT EXISTS won't add them). */
const ADDED_COLUMNS: Record<string, Record<string, string>> = {
  brain_paper_positions: {
    venue: "TEXT",
    leader_post_buy_tokens: "REAL",
    leader_sold_tokens: "REAL NOT NULL DEFAULT 0",
    leader_sold_at: "TEXT",
    last_tracked_price_ts: "TEXT",
    quote_failed: "INTEGER NOT NULL DEFAULT 0",
    quote_fails: "INTEGER NOT NULL DEFAULT 0",
    quote_price_sol: "REAL",
    quote_ts: "TEXT",
  },
};

function addColumns(db: DB): void {
  for (const [table, cols] of Object.entries(ADDED_COLUMNS)) {
    const have = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
    for (const [col, def] of Object.entries(cols)) if (!have.has(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
  }
}

const ensured = new WeakSet<DB>();
/** Create the Brain's paper tables (once per connection). */
export function ensureBrainTables(db: DB): void {
  if (ensured.has(db)) return;
  db.exec(SQL);
  addColumns(db);
  ensured.add(db);
}

/** True once the paper tables exist (readers such as the dashboard must not create them). */
export function brainTablesExist(db: DB): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='brain_paper_accounts'").get();
}
