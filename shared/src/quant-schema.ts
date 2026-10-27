/**
 * Tables written by the offline Python quant job (quant/, `python -m quant.run`).
 * The Python job creates them with the same SQL; TypeScript only reads them.
 * Timestamps (computed_at, valid_until) are unix seconds.
 */
import type { DB } from "./db";

export const QUANT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS wallet_skill (
  wallet TEXT PRIMARY KEY,
  computed_at INTEGER NOT NULL,
  n_trades INTEGER NOT NULL,
  win_rate REAL,
  median_return REAL,
  ci_low REAL,
  ci_high REAL,
  p_value REAL,
  q_value REAL,
  deflated_sharpe REAL,
  persistence_rho REAL,
  skill_score REAL,
  verdict TEXT NOT NULL CHECK (verdict IN ('skill','luck','insufficient'))
);
CREATE TABLE IF NOT EXISTS sizing_params (
  leader TEXT PRIMARY KEY,
  computed_at INTEGER NOT NULL,
  valid_until INTEGER NOT NULL,
  n INTEGER NOT NULL,
  edge REAL,
  vol REAL,
  kelly_full REAL,
  kelly_mult REAL NOT NULL DEFAULT 0 CHECK (kelly_mult >= 0 AND kelly_mult <= 1),
  max_drawdown REAL,
  risk_of_ruin REAL
);
`;

export type SkillVerdict = "skill" | "luck" | "insufficient";

export interface WalletSkillRow {
  wallet: string;
  computed_at: number;
  n_trades: number;
  win_rate: number | null;
  median_return: number | null;
  ci_low: number | null;
  ci_high: number | null;
  p_value: number | null;
  q_value: number | null;
  deflated_sharpe: number | null;
  persistence_rho: number | null;
  skill_score: number | null;
  verdict: SkillVerdict;
}

export interface SizingParamsRow {
  leader: string;
  computed_at: number;
  valid_until: number;
  n: number;
  edge: number | null;
  vol: number | null;
  kelly_full: number | null;
  kelly_mult: number;
  max_drawdown: number | null;
  risk_of_ruin: number | null;
}

const missingTable = (e: unknown) => e instanceof Error && /no such table/i.test(e.message);

/** The leader's sizing row, or null if the job never ran or has no row for it. */
export function readSizingParams(db: DB, leader: string): SizingParamsRow | null {
  try {
    return (db.prepare("SELECT * FROM sizing_params WHERE leader = ?").get(leader) as SizingParamsRow | undefined) ?? null;
  } catch (e) {
    if (missingTable(e)) return null;
    throw e;
  }
}

/** The wallet's skill row, or null if the job never ran or has no row for it. */
export function readWalletSkill(db: DB, wallet: string): WalletSkillRow | null {
  try {
    return (db.prepare("SELECT * FROM wallet_skill WHERE wallet = ?").get(wallet) as WalletSkillRow | undefined) ?? null;
  } catch (e) {
    if (missingTable(e)) return null;
    throw e;
  }
}
