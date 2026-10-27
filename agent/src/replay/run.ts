/** Feeds the copy-fill replay (model.ts) from the database: a leader's stored swaps, and every stored swap in the same tokens as the price tape. */
import { type DB, isNonMemecoinSymbol, NON_MEMECOIN_MINTS } from "@godseye/shared";
import { DEFAULT_PARAMS, type Episode, type LeaderSwap, MAX_PLAUSIBLE_RETURN_PCT, type Obs, type ReplayParams, simulateMint, Tape, median } from "./model";
import { type Summary, summarize } from "./summary";

interface SwapRow {
  signature: string;
  ts: string;
  mint: string;
  side: "buy" | "sell";
  token_amount: number;
  token_balance_before: number;
  sol_amount: number;
  price_sol: number;
}

/** The tape starts this long before a leader's first trade in a token, so the first entry has prices to work from. */
const TAPE_LEAD_MS = 10 * 60_000;

export interface WalletReplay {
  wallet: string;
  /** Leader's side of every episode (independent of delay). */
  ideal: Episode[];
  /** Episodes per delay. */
  real: Map<number, Episode[]>;
  /** Positions dropped because a return on either side was above MAX_PLAUSIBLE_RETURN_PCT (a pricing error). */
  implausible: number;
}

/** When the stored data ends (newest stored swap). */
export function dataEnd(db: DB): number {
  const row = db.prepare("SELECT ts FROM wallet_swaps ORDER BY id DESC LIMIT 1").get() as { ts: string } | undefined;
  return row ? Date.parse(row.ts) : Date.now();
}

const valid = (n: number) => Number.isFinite(n) && n > 0;

export function replayWallet(db: DB, wallet: string, delays: number[], base: Partial<ReplayParams> = {}, opts: { sinceMs?: number; untilMs?: number; endT?: number } = {}): WalletReplay {
  const params: ReplayParams = { ...DEFAULT_PARAMS, ...base };
  const endT = opts.endT ?? dataEnd(db);
  const since = new Date(opts.sinceMs ?? 0).toISOString();
  // Leader trades from before `until` only; the tape and the exits still run to the end of the data.
  const until = new Date(opts.untilMs ?? endT + 1000).toISOString();
  const rows = db
    .prepare(
      `SELECT signature, ts, mint, side, token_amount, token_balance_before, sol_amount, price_sol FROM wallet_swaps
       WHERE wallet = ? AND ts >= ? AND ts < ? ORDER BY ts, slot, id`,
    )
    .all(wallet, since, until) as SwapRow[];
  const byMint = new Map<string, SwapRow[]>();
  for (const r of rows) {
    if (!valid(r.price_sol) || !valid(r.sol_amount) || !valid(r.token_amount)) continue;
    const list = byMint.get(r.mint);
    if (list) list.push(r);
    else byMint.set(r.mint, [r]);
  }
  const symbolOf = db.prepare("SELECT symbol FROM token_info WHERE mint = ?");
  const tapeRows = db.prepare("SELECT signature, ts, side, sol_amount, price_sol FROM wallet_swaps WHERE mint = ? AND ts >= ? AND ts <= ? ORDER BY ts, slot, id");

  const result: WalletReplay = { wallet, ideal: [], real: new Map(delays.map((d) => [d, []])), implausible: 0 };
  for (const [mint, swaps] of byMint) {
    if (NON_MEMECOIN_MINTS.has(mint)) continue;
    const symbol = (symbolOf.get(mint) as { symbol: string | null } | undefined)?.symbol;
    if (symbol && isNonMemecoinSymbol(symbol)) continue;
    const from = new Date(Date.parse(swaps[0].ts) - TAPE_LEAD_MS).toISOString();
    const obs: Obs[] = (tapeRows.all(mint, from, new Date(endT).toISOString()) as { signature: string; ts: string; side: "buy" | "sell"; sol_amount: number; price_sol: number }[])
      .filter((o) => valid(o.price_sol) && valid(o.sol_amount))
      .map((o) => ({ t: Date.parse(o.ts), side: o.side, price: o.price_sol, sol: o.sol_amount, sig: o.signature }));
    const tape = new Tape(obs, params.feeBps, params.defaultDepthSol, params.depthWindowSec * 1000, params.fixedDepthSol);
    const leader: LeaderSwap[] = swaps.map((r) => ({
      t: Date.parse(r.ts),
      side: r.side,
      price: r.price_sol,
      solAmount: r.sol_amount,
      tokenAmount: r.token_amount,
      tokenBalanceBefore: r.token_balance_before,
      signature: r.signature,
    }));
    result.ideal.push(...simulateMint(tape, mint, leader, endT, { ...params, ideal: true }));
    for (const d of delays) result.real.get(d)!.push(...simulateMint(tape, mint, leader, endT, { ...params, ideal: false, delaySec: d }));
  }
  // One mispriced swap can read as millions of percent and swamp every average: drop that position on both sides, at every delay.
  const bad = new Set([result.ideal, ...result.real.values()].flat().filter((e) => !(e.retPct <= MAX_PLAUSIBLE_RETURN_PCT)).map((e) => e.entrySignature));
  if (bad.size) {
    result.implausible = bad.size;
    result.ideal = result.ideal.filter((e) => !bad.has(e.entrySignature));
    for (const [d, eps] of result.real) result.real.set(d, eps.filter((e) => !bad.has(e.entrySignature)));
  }
  return result;
}

export function summarizeWallet(r: WalletReplay): Summary[] {
  return [...r.real].map(([d, eps]) => summarize(d, eps, r.ideal));
}

/** Several wallets together, per delay. */
export function pool(rs: WalletReplay[], delays: number[]): Summary[] {
  const ideal = rs.flatMap((r) => r.ideal);
  return delays.map((d) => summarize(d, rs.flatMap((r) => r.real.get(d) ?? []), ideal));
}

/**
 * Real copies against the model: when GodsEye has filled copies, how late it really was and how far above
 * the leader's price it really bought — the numbers to set the replay's delay and costs from.
 */
export function calibration(db: DB): { n: number; medianLatencySec: number | null; medianDriftPct: number | null; medianFeeSol: number | null } {
  const rows = db
    .prepare(
      `SELECT c.latency_ms, c.price_sol, c.fee_sol, s.price_sol AS leader_price FROM copy_trades c
       LEFT JOIN wallet_swaps s ON s.signature = c.leader_signature AND s.wallet = c.leader AND s.mint = c.mint
       WHERE c.status = 'filled' AND c.side = 'buy' AND c.mode = 'real'`,
    )
    .all() as { latency_ms: number | null; price_sol: number | null; fee_sol: number | null; leader_price: number | null }[];
  const drifts = rows.flatMap((r) => (r.price_sol && r.leader_price ? [(r.price_sol / r.leader_price - 1) * 100] : []));
  return {
    n: rows.length,
    medianLatencySec: median(rows.flatMap((r) => (r.latency_ms === null ? [] : [r.latency_ms / 1000]))),
    medianDriftPct: median(drifts),
    medianFeeSol: median(rows.flatMap((r) => (r.fee_sol === null ? [] : [r.fee_sol]))),
  };
}
