/**
 * closed_trades: every closed round trip a wallet made, materialised from wallet_swaps.
 * The round-trip logic itself lives in agent/src/analysis/pnl.ts (realize); this module only
 * stores its output, keeps it idempotent, and holds the SQLite housekeeping (retention, WAL checkpoint).
 *
 * Time unit: wallet_swaps.ts is ISO-8601 UTC text. closed_trades.entry_ts / exit_ts are INTEGER
 * Unix epoch SECONDS (floor of the ISO time), so they sort and subtract cheaply.
 */
import type { DB } from "./db";

export interface ClosedTradeRow {
  wallet: string;
  mint: string;
  entry_slot: number | null;
  entry_ts: number;
  exit_ts: number;
  entry_sol: number;
  exit_sol: number;
  pnl_sol: number;
  return_pct: number | null;
  hold_sec: number;
  token_age_sec_at_entry: number | null;
  venue_entry: string | null;
  jito_tip_entry: number | null;
  /** Entry price (SOL per token), used to compute entry_price_rank; not stored. */
  entry_price_sol?: number | null;
}

/** ISO-8601 → Unix epoch seconds. */
export const isoToEpochSec = (iso: string): number => Math.floor(Date.parse(iso) / 1000);
export const epochSecToIso = (sec: number): string => new Date(sec * 1000).toISOString();

/** Fewest observed prices of a token before entry_price_rank is meaningful. */
export const MIN_PRICE_OBSERVATIONS = 5;

/**
 * Where the entry sits in the token's observed price path: share of observed swap prices of this mint
 * (all wallets, from the first observation up to the trade's exit) that were below the entry price.
 * 0 = bought at the lowest price GodsEye has seen, 1 = at the highest. Null if too few observations.
 */
export function entryPriceRank(db: DB, mint: string, entryPrice: number | null | undefined, exitTs: number): number | null {
  if (entryPrice === null || entryPrice === undefined || !(entryPrice > 0)) return null;
  const row = db
    .prepare(
      `SELECT COUNT(*) n, SUM(CASE WHEN price_sol < ? THEN 1 ELSE 0 END) below
         FROM wallet_swaps WHERE mint = ? AND ts <= ? AND price_sol > 0`,
    )
    .get(entryPrice, mint, epochSecToIso(exitTs + 1)) as { n: number; below: number | null };
  return row.n >= MIN_PRICE_OBSERVATIONS ? (row.below ?? 0) / row.n : null;
}

/** Insert or refresh closed trades. Idempotent: the same input twice leaves the table unchanged. */
export function upsertClosedTrades(db: DB, rows: ClosedTradeRow[]): number {
  if (!rows.length) return 0;
  const stmt = db.prepare(
    `INSERT INTO closed_trades (wallet, mint, entry_slot, entry_ts, exit_ts, entry_sol, exit_sol, pnl_sol, return_pct, hold_sec,
        token_age_sec_at_entry, venue_entry, jito_tip_entry, entry_price_rank)
     VALUES (@wallet, @mint, @entry_slot, @entry_ts, @exit_ts, @entry_sol, @exit_sol, @pnl_sol, @return_pct, @hold_sec,
        @token_age_sec_at_entry, @venue_entry, @jito_tip_entry, @entry_price_rank)
     ON CONFLICT(wallet, mint, entry_ts) DO UPDATE SET entry_slot=excluded.entry_slot, exit_ts=excluded.exit_ts,
        entry_sol=excluded.entry_sol, exit_sol=excluded.exit_sol, pnl_sol=excluded.pnl_sol, return_pct=excluded.return_pct,
        hold_sec=excluded.hold_sec, token_age_sec_at_entry=excluded.token_age_sec_at_entry, venue_entry=excluded.venue_entry,
        jito_tip_entry=excluded.jito_tip_entry, entry_price_rank=COALESCE(excluded.entry_price_rank, closed_trades.entry_price_rank)`,
  );
  let n = 0;
  db.transaction(() => {
    for (const r of rows) {
      const { entry_price_sol, ...rest } = r;
      n += stmt.run({ ...rest, entry_price_rank: entryPriceRank(db, r.mint, entry_price_sol, r.exit_ts) }).changes;
    }
  })();
  return n;
}

/** Drop a wallet's closed trades in these mints (e.g. non-memecoins removed from wallet_swaps). */
export function deleteClosedTradesForMints(db: DB, wallet: string, mints: string[]): number {
  if (!mints.length) return 0;
  return db.prepare(`DELETE FROM closed_trades WHERE wallet = ? AND mint IN (${mints.map(() => "?").join(",")})`).run(wallet, ...mints).changes;
}

export interface PruneOptions {
  /** Delete wallet_swaps older than this many days (0 = keep forever). */
  swapsDays: number;
  /** Delete wallet_activity rows (not promoted) not seen for this many days (0 = keep forever). */
  activityDays: number;
  now?: number;
}

/**
 * Retention pruning. closed_trades is NOT pruned: it is the long-term record, so round trips survive
 * after their raw swaps are gone. Swaps of wallets GodsEye currently copies (copy_weight > 0) or holds
 * an open position with are kept, so live P&L and exits are never computed from a truncated history.
 */
export function pruneHistory(db: DB, opts: PruneOptions): { swaps: number; activity: number } {
  const now = opts.now ?? Date.now();
  let swaps = 0;
  let activity = 0;
  if (opts.swapsDays > 0) {
    const before = new Date(now - opts.swapsDays * 86_400_000).toISOString();
    swaps = db
      .prepare(
        `DELETE FROM wallet_swaps WHERE ts < ?
           AND wallet NOT IN (SELECT address FROM wallets WHERE copy_weight > 0)
           AND wallet NOT IN (SELECT leader FROM positions WHERE status != 'closed' AND leader IS NOT NULL)`,
      )
      .run(before).changes;
  }
  if (opts.activityDays > 0) {
    const before = new Date(now - opts.activityDays * 86_400_000).toISOString();
    activity = db.prepare("DELETE FROM wallet_activity WHERE last_seen_at < ? AND promoted = 0").run(before).changes;
  }
  return { swaps, activity };
}

/** Fold the WAL back into the main file after a bulk job. PASSIVE never blocks the dashboard's readers. */
export function checkpointWal(db: DB): void {
  if (db.memory) return;
  db.pragma("wal_checkpoint(PASSIVE)");
}
