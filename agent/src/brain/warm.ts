/**
 * WARM START — the leader ledgers (ledger.ts: mirror_ledger, ps_ledger, dd_ledger) and the stream state's tables
 * (brain_token_first_seen, brain_active_wallets_hourly) filled from the swaps already stored, so the Brain's leader-history
 * inputs (cp_*, ps_r_7d, dd_rate_7d, the density features) aren't empty when the live stream comes back.
 *
 * The stored swaps go through the server's own code, in block-time order, on an injected clock: each swap is "seen" at
 * its block time, as the live stream sees it, and the ledgers' minute ticks run on the same clock. So a row is known only
 * from when the stream would have known it, and the features read nothing from its future. No network: no Jupiter quote
 * (y_quote stays empty) and no creator lookup (the stored creator is used when there is one).
 * Stored swaps are the tracked wallets' (the Mac's simulator ledger is built from the same table), so prices come from
 * fewer wallets than the full stream shows. Rows already there are kept (each row's key is its leader's buy).
 */
import type { DB } from "@godseye/shared";
import type { ParsedSwap } from "../chain/parse";
import { MirrorLedger } from "./ledger";
import { StreamState } from "./state";

interface SwapRow {
  id: number;
  wallet: string;
  signature: string;
  slot: number;
  ts: string;
  mint: string;
  side: "buy" | "sell";
  token_amount: number;
  token_balance_before: number;
  sol_amount: number;
  price_sol: number;
  venue: string | null;
  jito_tip: number;
  fee_lamports: number;
  quote: string;
  quote_amount: number | null;
  sol_usd: number | null;
  usd_amount: number | null;
}

const PAGE = 5_000;
const MINUTE = 60_000;

const asSwap = (r: SwapRow): ParsedSwap =>
  ({
    wallet: r.wallet, signature: r.signature, slot: r.slot, ts: r.ts, mint: r.mint, side: r.side, tokenAmount: r.token_amount,
    tokenBalanceBefore: r.token_balance_before, solAmount: r.sol_amount, priceSol: r.price_sol, venue: r.venue ?? "unknown",
    jitoTip: !!r.jito_tip, feeLamports: r.fee_lamports, quote: r.quote, quoteAmount: r.quote_amount ?? r.sol_amount, solUsd: r.sol_usd, usdAmount: r.usd_amount,
  }) as ParsedSwap;

/** Replays the stored swaps from `fromMs` to `toMs` through the ledgers. Returns how many swaps went in and the rows written. */
export async function warmLedgers(db: DB, opts: { fromMs: number; toMs: number; progress?: (done: number, at: number) => void }): Promise<{ swaps: number; mirrorRows: number }> {
  let clock = opts.fromMs;
  const state = new StreamState(db, { now: () => clock, lookupCreator: async () => null });
  const ledger = new MirrorLedger(db, state, { now: () => clock });
  const before = (db.prepare("SELECT COUNT(*) n FROM mirror_ledger").get() as { n: number }).n;
  const page = db.prepare(
    `SELECT id, wallet, signature, slot, ts, mint, side, token_amount, token_balance_before, sol_amount, price_sol, venue, jito_tip, fee_lamports,
            quote, quote_amount, sol_usd, usd_amount
     FROM wallet_swaps WHERE (ts, id) > (?, ?) AND ts < ? ORDER BY ts, id LIMIT ${PAGE}`,
  );
  let last = { ts: new Date(opts.fromMs).toISOString(), id: 0 };
  let ticked = opts.fromMs;
  let swaps = 0;
  for (;;) {
    const rows = page.all(last.ts, last.id, new Date(opts.toMs).toISOString()) as SwapRow[];
    if (!rows.length) break;
    for (const r of rows) {
      const at = Date.parse(r.ts);
      if (!Number.isFinite(at)) continue;
      // The ledgers' minute ticks, on the replay's clock, before the swap that crosses the minute.
      while (at - ticked >= MINUTE) {
        ticked += MINUTE;
        clock = ticked;
        await ledger.tick(ticked);
      }
      clock = Math.max(clock, at);
      state.onSwap(asSwap(r), clock);
      swaps++;
    }
    last = { ts: rows[rows.length - 1].ts, id: rows[rows.length - 1].id };
    opts.progress?.(swaps, Date.parse(last.ts));
  }
  clock = opts.toMs;
  await ledger.tick(opts.toMs);
  const after = (db.prepare("SELECT COUNT(*) n FROM mirror_ledger").get() as { n: number }).n;
  return { swaps, mirrorRows: after - before };
}
