/**
 * Replaying many exit rule sets over the same leaders and price tapes: `npm run strategy` (research) and the exit tuner
 * (learning/exits.ts, `npm run tune-exits`) share it.
 *
 * Only buys of coins the rug screen would let through count (learning/copyable.ts's rule): what the copy engine could
 * actually have bought. The window is split at the median entry (most candidates are new wallets, so calendar halves
 * would be lopsided) and each half is scored apart, so a rule that only wins in one half shows it.
 */
import { type DB, isNonMemecoinSymbol, NON_MEMECOIN_MINTS } from "@godseye/shared";
import { DEFAULT_PARAMS, type Episode, type LeaderSwap, MAX_PLAUSIBLE_RETURN_PCT, median, type Obs, type ReplayParams, simulateMint, Tape } from "./model";
import { dataEnd } from "./run";

export interface Book {
  wallet: string;
  mint: string;
  tape: Tape;
  swaps: LeaderSwap[];
  /** Leader's buy size ÷ its median buy size, by signature (conviction). */
  conviction: Map<string, number>;
}

export interface SweepData {
  wallets: string[];
  books: Book[];
  since: number;
  endT: number;
  /** Median entry time: the split between the two halves. */
  mid: number;
  loadSec: number;
}

export interface RuleScore {
  name: string;
  n: number;
  wins: number;
  medianPct: number | null;
  meanPct: number;
  /** Mean return with the best 1% of copies left out: one 100× coin must not decide the rule. */
  trimmedMeanPct: number;
  pnlSol: number;
  firstHalfSol: number;
  secondHalfSol: number;
  firstHalfTrimmedPct: number;
  secondHalfTrimmedPct: number;
  firstHalfN: number;
  secondHalfN: number;
}

const valid = (n: number) => Number.isFinite(n) && n > 0;

/** The learning loop's ranked candidates (wallets passing every gate) and current leaders, best 7-day profit first. */
export function rankedCandidates(db: DB, max: number): string[] {
  return (
    db
      .prepare(
        `SELECT w.address FROM wallets w JOIN wallet_stats s ON s.wallet = w.address
          WHERE w.copy_weight > 0 OR w.weight_reason LIKE '%of its buys copyable%' ORDER BY COALESCE(s.pnl_7d_usd, 0) DESC LIMIT ?`,
      )
      .all(max) as { address: string }[]
  ).map((r) => r.address);
}

/** Every copyable wallet-coin book of these wallets over the last `days`, with each coin's tape loaded once. */
export function loadBooks(db: DB, wallets: string[], days: number): SweepData {
  const t0 = Date.now();
  const endT = dataEnd(db);
  const since = endT - days * 86_400_000;
  const passed = new Set((db.prepare("SELECT mint FROM rug_checks WHERE verdict = 'pass'").all() as { mint: string }[]).map((r) => r.mint));
  const blocked = new Set((db.prepare("SELECT mint FROM rug_checks WHERE verdict = 'blocked'").all() as { mint: string }[]).map((r) => r.mint));
  const copyable = (mint: string) => passed.has(mint) || (!blocked.has(mint) && mint.endsWith("pump"));
  const swapRows = db.prepare(
    "SELECT signature, ts, mint, side, token_amount, token_balance_before, sol_amount, price_sol FROM wallet_swaps WHERE wallet = ? AND ts >= ? ORDER BY ts, slot, id",
  );
  const tapeRows = db.prepare("SELECT signature, ts, side, sol_amount, price_sol FROM wallet_swaps WHERE mint = ? AND ts >= ? AND ts <= ? ORDER BY ts, slot, id");
  const symbolOf = db.prepare("SELECT symbol FROM token_info WHERE mint = ?");
  const tapes = new Map<string, Tape>();
  const books: Book[] = [];
  for (const wallet of wallets) {
    const rows = (swapRows.all(wallet, new Date(since).toISOString()) as {
      signature: string; ts: string; mint: string; side: "buy" | "sell"; token_amount: number; token_balance_before: number; sol_amount: number; price_sol: number;
    }[]).filter((r) => valid(r.price_sol) && valid(r.sol_amount) && valid(r.token_amount));
    const typical = median(rows.filter((r) => r.side === "buy").map((r) => r.sol_amount)) ?? 1;
    const byMint = new Map<string, typeof rows>();
    for (const r of rows) {
      if (!copyable(r.mint) || NON_MEMECOIN_MINTS.has(r.mint)) continue;
      (byMint.get(r.mint) ?? byMint.set(r.mint, []).get(r.mint)!).push(r);
    }
    for (const [mint, list] of byMint) {
      const symbol = (symbolOf.get(mint) as { symbol: string | null } | undefined)?.symbol;
      if (symbol && isNonMemecoinSymbol(symbol)) continue;
      let tape = tapes.get(mint);
      if (!tape) {
        const obs: Obs[] = (tapeRows.all(mint, new Date(since - 10 * 60_000).toISOString(), new Date(endT).toISOString()) as {
          signature: string; ts: string; side: "buy" | "sell"; sol_amount: number; price_sol: number;
        }[])
          .filter((o) => valid(o.price_sol) && valid(o.sol_amount))
          .map((o) => ({ t: Date.parse(o.ts), side: o.side, price: o.price_sol, sol: o.sol_amount, sig: o.signature }));
        tape = new Tape(obs, DEFAULT_PARAMS.feeBps, DEFAULT_PARAMS.defaultDepthSol, DEFAULT_PARAMS.depthWindowSec * 1000, null);
        tapes.set(mint, tape);
      }
      books.push({
        wallet, mint, tape,
        swaps: list.map((r) => ({ t: Date.parse(r.ts), side: r.side, price: r.price_sol, solAmount: r.sol_amount, tokenAmount: r.token_amount, tokenBalanceBefore: r.token_balance_before, signature: r.signature })),
        conviction: new Map(list.filter((r) => r.side === "buy").map((r) => [r.signature, r.sol_amount / typical])),
      });
    }
  }
  const entries = books.flatMap((b) => b.swaps.filter((s) => s.side === "buy" && s.t >= since).map((s) => s.t));
  return { wallets, books, since, endT, mid: median(entries) ?? since + (endT - since) / 2, loadSec: (Date.now() - t0) / 1000 };
}

/** Episodes of one rule set over the given books (default: all), entries inside the window, pricing errors dropped. */
export function runRule(d: SweepData, p: ReplayParams, books = d.books): Episode[] {
  return books.flatMap((b) => simulateMint(b.tape, b.mint, b.swaps, d.endT, p).filter((e) => e.entryT >= d.since && e.retPct <= MAX_PLAUSIBLE_RETURN_PCT));
}

const trimmedMean = (rets: number[]): number => {
  const s = rets.slice().sort((a, b) => a - b);
  const kept = s.slice(0, s.length - Math.floor(s.length * 0.01));
  return kept.reduce((a, x) => a + x, 0) / (kept.length || 1);
};

export function scoreRule(name: string, eps: Episode[], mid: number): RuleScore {
  const rets = eps.map((e) => e.retPct);
  const a = eps.filter((e) => e.entryT < mid);
  const b = eps.filter((e) => e.entryT >= mid);
  const sum = (xs: Episode[]) => xs.reduce((s, e) => s + e.pnlSol, 0);
  return {
    name, n: eps.length, wins: eps.filter((e) => e.pnlSol > 0).length, medianPct: median(rets),
    meanPct: rets.reduce((s, x) => s + x, 0) / (rets.length || 1), trimmedMeanPct: trimmedMean(rets),
    pnlSol: sum(eps), firstHalfSol: sum(a), secondHalfSol: sum(b),
    firstHalfTrimmedPct: trimmedMean(a.map((e) => e.retPct)), secondHalfTrimmedPct: trimmedMean(b.map((e) => e.retPct)), firstHalfN: a.length, secondHalfN: b.length,
  };
}
