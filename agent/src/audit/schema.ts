/**
 * Tables of the decision audit trail. Created by the agent code that writes them (not in shared/src/schema.ts), the same
 * CREATE TABLE IF NOT EXISTS way, so they appear the first time the agent runs. Append-only: rows are only ever added,
 * apart from the copy gate's result being attached to the decision it belongs to.
 */
import type { DB } from "@godseye/shared";

export const AUDIT_SQL = `
-- Why a wallet was in the state it was in, whenever that changed (and once a day for copied wallets).
CREATE TABLE IF NOT EXISTS wallet_evaluations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet TEXT NOT NULL,
  ts TEXT NOT NULL,
  -- copy: weight above 0 · watch: not copied now, and worth following · ignore: stopped trading or nothing to judge · block: on IGNORE_WALLETS.
  -- Derived from the weight gates only (state_version 1); a fuller state layer will replace it under a new version.
  state TEXT NOT NULL CHECK (state IN ('copy','watch','ignore','block')),
  state_version INTEGER NOT NULL DEFAULT 1,
  -- the first rule that decided it: ok · not_in_top · quitter · lucky_streak · few_closed · win_rate · pnl7 · copy_loss · bot · copy_replay · uncopyable · blocked
  gate TEXT NOT NULL,
  tier TEXT NOT NULL,
  tier_reason TEXT,
  weight REAL NOT NULL,
  weight_reason TEXT,
  -- copy mode the "our own copies of it" inputs were measured in
  mode TEXT NOT NULL,
  -- everything the weight was computed from, and the cutoffs it was compared with (JSON)
  inputs TEXT NOT NULL,
  cutoffs TEXT NOT NULL,
  -- the factors of the score before normalising (JSON): profit, confidence, win factor, multipliers
  components TEXT,
  -- how much of the wallet's history was actually seen (JSON): window start and length in days, transactions read, complete or not
  data_quality TEXT,
  evidence_for TEXT NOT NULL DEFAULT '[]',
  evidence_against TEXT NOT NULL DEFAULT '[]',
  -- what would change the state
  reassess TEXT,
  last_activity_at TEXT,
  -- 1 = written because something changed; 0 = the daily record of an unchanged copied wallet
  changed INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_wallet_evaluations_wallet ON wallet_evaluations(wallet, id);
CREATE INDEX IF NOT EXISTS idx_wallet_evaluations_ts ON wallet_evaluations(ts);

-- Every leader buy GodsEye considered copying: what was checked, in order, and what came of it.
CREATE TABLE IF NOT EXISTS copy_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  leader TEXT NOT NULL,
  leader_signature TEXT NOT NULL,
  leader_ts TEXT NOT NULL,
  mint TEXT NOT NULL,
  symbol TEXT,
  mode TEXT NOT NULL,
  -- bought · buy_failed · skipped:<why> (a check failed) · ignored:<why> (not a candidate, e.g. a position is already open)
  outcome TEXT NOT NULL,
  weight REAL,
  leader_sol REAL,
  leader_price_sol REAL,
  lateness_sec REAL,
  size_sol REAL,
  -- the checks in the order they ran (JSON): [{ check, result: pass | fail | error | na, detail }]
  checks TEXT NOT NULL,
  -- the rug screen's verdict for this token when it was consulted (JSON), if it was
  rug TEXT,
  -- the leader's latest wallet_evaluations row when the decision was made
  wallet_eval_id INTEGER,
  -- the copyability gate (log-only): quotes at our size, price impact, drift from the leader's price, round trip, fees (JSON)
  gate TEXT,
  -- pending · done · skipped (not run, with the reason in gate) · error
  gate_status TEXT NOT NULL DEFAULT 'skipped',
  copy_trade_id INTEGER,
  UNIQUE (leader_signature, mint)
);
CREATE INDEX IF NOT EXISTS idx_copy_decisions_ts ON copy_decisions(ts);
CREATE INDEX IF NOT EXISTS idx_copy_decisions_mint ON copy_decisions(mint);
CREATE INDEX IF NOT EXISTS idx_copy_decisions_leader ON copy_decisions(leader, ts);
`;

const done = new WeakSet<DB>();

/** Creates the audit tables once per connection (cheap to call again). */
export function ensureAuditTables(db: DB): void {
  if (done.has(db)) return;
  db.exec(AUDIT_SQL);
  done.add(db);
}

export const auditTablesExist = (db: DB): boolean =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'copy_decisions'").get() &&
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'wallet_evaluations'").get();
