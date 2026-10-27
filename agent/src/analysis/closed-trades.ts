/**
 * Keeps the closed_trades table (shared/src/closed-trades.ts) in step with wallet_swaps, using the same
 * round-trip logic as the wallet stats (realize in ./pnl). Upserts only, so it is safe to run any number of times.
 */
import { checkpointWal, getMeta, isoToEpochSec, setMeta, upsertClosedTrades, type ClosedTradeRow, type DB } from "@godseye/shared";
import type { ClosedPosition, SwapLite } from "./pnl";
import { realize } from "./pnl";

export function closedTradeRows(wallet: string, closed: ClosedPosition[]): ClosedTradeRow[] {
  return closed.map((c) => {
    const entry = isoToEpochSec(c.openedAt);
    const exit = isoToEpochSec(c.closedAt);
    return {
      wallet,
      mint: c.mint,
      entry_slot: c.openedSlot ?? null,
      entry_ts: entry,
      exit_ts: exit,
      entry_sol: c.costSol,
      exit_sol: c.proceedsSol,
      pnl_sol: c.pnlSol,
      return_pct: c.costSol > 0 ? (c.pnlSol / c.costSol) * 100 : null,
      hold_sec: exit - entry,
      token_age_sec_at_entry: c.openedTokenAgeSec === null || c.openedTokenAgeSec === undefined ? null : Math.round(c.openedTokenAgeSec),
      venue_entry: c.openedVenue ?? null,
      jito_tip_entry: c.openedJitoTip ?? null,
      entry_price_sol: c.openedPriceSol ?? null,
    };
  });
}

/** Store one wallet's closed round trips (called from recomputeStats on every analysis). */
export function syncClosedTrades(db: DB, wallet: string, closed: ClosedPosition[]): number {
  return upsertClosedTrades(db, closedTradeRows(wallet, closed));
}

const SWAPS_SQL =
  "SELECT signature, slot, ts, mint, side, token_amount, sol_amount, usd_amount, price_sol, venue, jito_tip, token_age_sec FROM wallet_swaps WHERE wallet = ? ORDER BY ts";

export const BACKFILL_META_KEY = "closed_trades_backfill_v1";

/**
 * Rebuild closed_trades for every wallet with stored swaps. Idempotent: re-running changes nothing.
 * `force` reruns even if it already completed once.
 */
export function backfillClosedTrades(db: DB, earlyBuySeconds: number, opts: { force?: boolean } = {}): { wallets: number; trades: number; skipped: boolean } {
  if (!opts.force && getMeta(db, BACKFILL_META_KEY) === "done") return { wallets: 0, trades: 0, skipped: true };
  const wallets = (db.prepare("SELECT DISTINCT wallet FROM wallet_swaps").all() as { wallet: string }[]).map((r) => r.wallet);
  const read = db.prepare(SWAPS_SQL);
  let trades = 0;
  for (const w of wallets) {
    const swaps = read.all(w) as SwapLite[];
    const closed = realize(swaps, earlyBuySeconds).closed;
    syncClosedTrades(db, w, closed);
    trades += closed.length;
  }
  setMeta(db, BACKFILL_META_KEY, "done");
  checkpointWal(db);
  return { wallets: wallets.length, trades, skipped: false };
}
