/**
 * THE RUNNER TAPE — every pump.fun launch the live stream sees, from its first trade: its price path and its first buyers.
 *
 * A coin is followed only when its first swap seen is on the pump.fun bonding curve at (about) the launch price, so its
 * buyer list really starts at the start; coins first seen later (or after a restart) are left to the backfill
 * (cli/runners-backfill.ts). Per coin, in memory:
 *   • the first price (median of the first 5 swaps) and the peak of the minute medians: one odd print can't make a peak
 *   • minutes spent at 5x or more, and the SOL price at the peak (market cap = price × 1B supply, pump.fun's fixed supply)
 *   • the first RUNNER_MAX_BUYERS distinct buyers: when, at what price, how much; what they sold later; and the price a
 *     copy would have paid (the coin's first price our copy delay after their buy)
 * A coin is finished once it's dead (idle 30 min without reaching 3x), quiet (idle 2 h) or a day old. Finished coins are
 * written by saveCoins: every buyer's early buy is counted (the denominator of its hit rate), the coin's row is kept when it
 * had a real crowd, and its buyers when it came close to running. Which coins count as runners is decided later, from the
 * data (runners/define.ts).
 */
import { type DB, envNum, nowIso } from "@godseye/shared";
import type { ParsedSwap } from "../chain/parse";
import { ensureRunnerTables } from "./schema";

/** pump.fun's starting price: 30 virtual SOL against 1,073,000,000 virtual tokens. */
export const PUMP_LAUNCH_PRICE_SOL = 30 / 1_073_000_000;
export const PUMP_SUPPLY = 1_000_000_000;
/** No pump.fun coin goes this far above its launch price (~$1B from ~$5k): a higher price is a parsing unit error. */
export const MAX_PLAUSIBLE_X = 200_000;
export const plausiblePrice = (priceSol: number): boolean => priceSol > PUMP_LAUNCH_PRICE_SOL * 0.3 && priceSol < PUMP_LAUNCH_PRICE_SOL * MAX_PLAUSIBLE_X;

export const tapeSettings = {
  maxCoins: envNum("RUNNER_MAX_COINS", 40_000),
  maxBuyers: envNum("RUNNER_MAX_BUYERS", 100),
  /** The first price must be within this multiple of the launch price for the coin to be followed. */
  launchSeenMax: 3,
  /** An early buy: among the first buyers, at no more than this multiple of the first price. */
  earlyMaxX: envNum("RUNNER_EARLY_MAX_X", 3),
  deadIdleMin: 30,
  quietIdleMin: 120,
  maxAgeH: 24,
  /** Keep a coin's row with at least this many buyers (or once it ran 10x). */
  keepMinBuyers: 15,
  /** Keep a coin's buyers when it reached this multiple and this market cap: candidates for the runner definition. */
  candidateX: 10,
  candidateMcapUsd: envNum("RUNNER_CANDIDATE_MCAP_USD", 50_000),
};
export type TapeSettings = typeof tapeSettings;

interface Buyer {
  wallet: string;
  t: number;
  slot: number;
  price: number;
  sol: number;
  tokens: number;
  soldTokens: number;
  soldSol: number;
  /** Price of the first swap at or after t + the copy delay; null until one arrives. */
  copyPrice: number | null;
}

interface Coin {
  mint: string;
  first: number;
  firstSlot: number;
  last: number;
  seed: number[];
  p0: number | null;
  minute: number;
  minutePrices: number[];
  peak: number;
  peakAt: number;
  peakSolUsd: number | null;
  minutesAbove5: number;
  x3At: number | null;
  buyers: Map<string, Buyer>;
  waitingCopy: Buyer[];
  buys: number;
  swaps: number;
}

export interface FinishedCoin {
  mint: string;
  first: number;
  firstSlot: number;
  p0: number;
  peak: number;
  peakAt: number;
  x3At: number | null;
  multiple: number;
  minutesAbove5: number;
  peakMcapUsd: number | null;
  buyers: Buyer[];
  buys: number;
  swaps: number;
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export class RunnerTape {
  private coins = new Map<string, Coin>();
  private finished: FinishedCoin[] = [];
  /** GodsEye's copy delay (smart/copy-check.ts replayDelaySec), for the price a copy would have paid. */
  delayMs = 2_000;

  constructor(private s: TapeSettings = tapeSettings) {}

  get size(): number {
    return this.coins.size;
  }

  record(swap: ParsedSwap, now = Date.now()): void {
    if (!plausiblePrice(swap.priceSol)) return;
    const t = Date.parse(swap.ts);
    const at = Number.isFinite(t) ? t : now;
    let c = this.coins.get(swap.mint);
    if (!c) {
      // Only launches: a pump.fun curve swap at about the starting price.
      if (!swap.venue?.startsWith("pumpfun") || swap.priceSol > PUMP_LAUNCH_PRICE_SOL * this.s.launchSeenMax) return;
      if (this.coins.size >= this.s.maxCoins) this.evict(now, true);
      c = {
        mint: swap.mint, first: at, firstSlot: swap.slot, last: now, seed: [], p0: null, minute: Math.floor(at / 60_000), minutePrices: [],
        peak: 0, peakAt: at, peakSolUsd: swap.solUsd, minutesAbove5: 0, x3At: null, buyers: new Map(), waitingCopy: [], buys: 0, swaps: 0,
      };
      this.coins.set(swap.mint, c);
    }
    c.last = now;
    c.swaps++;
    if (c.seed.length < 5) {
      c.seed.push(swap.priceSol);
      if (c.seed.length === 5) c.p0 = median(c.seed);
    }
    const minute = Math.floor(at / 60_000);
    if (minute > c.minute) {
      this.closeMinute(c);
      c.minute = minute;
    }
    if (c.minutePrices.length < 200) c.minutePrices.push(swap.priceSol);
    else c.minutePrices[c.swaps % 200] = swap.priceSol;
    c.peakSolUsd ??= swap.solUsd;

    // The price a copy would have paid: the first swap at least the copy delay after each buy.
    while (c.waitingCopy.length && at >= c.waitingCopy[0].t + this.delayMs) c.waitingCopy.shift()!.copyPrice = swap.priceSol;

    const b = c.buyers.get(swap.wallet);
    if (swap.side === "buy") {
      c.buys++;
      if (b) {
        b.tokens += swap.tokenAmount;
        b.sol += swap.solAmount;
      } else if (c.buyers.size < this.s.maxBuyers) {
        const nb: Buyer = { wallet: swap.wallet, t: at, slot: swap.slot, price: swap.priceSol, sol: swap.solAmount, tokens: swap.tokenAmount, soldTokens: 0, soldSol: 0, copyPrice: null };
        c.buyers.set(swap.wallet, nb);
        c.waitingCopy.push(nb);
      }
    } else if (b) {
      b.soldTokens += swap.tokenAmount;
      b.soldSol += swap.solAmount;
    }
  }

  private closeMinute(c: Coin): void {
    if (!c.minutePrices.length) return;
    const m = median(c.minutePrices);
    c.minutePrices = [];
    const p0 = c.p0 ?? median(c.seed);
    if (m > c.peak) {
      c.peak = m;
      c.peakAt = c.minute * 60_000;
    }
    if (p0 > 0 && m >= 5 * p0) c.minutesAbove5++;
    if (p0 > 0 && m >= 3 * p0) c.x3At ??= c.minute * 60_000;
  }

  /** Finish coins that are dead, quiet or a day old (and the quietest 10% when `full`). */
  evict(now = Date.now(), full = false): void {
    const dead = this.s.deadIdleMin * 60_000;
    const quiet = this.s.quietIdleMin * 60_000;
    const old = this.s.maxAgeH * 3_600_000;
    for (const c of this.coins.values()) {
      const idle = now - c.last;
      const p0 = c.p0 ?? median(c.seed);
      const ran = c.peak >= 3 * p0 || Math.max(...c.minutePrices, 0) >= 3 * p0;
      if ((idle >= dead && !ran) || idle >= quiet || now - c.first >= old) this.finish(c);
    }
    if (full && this.coins.size >= this.s.maxCoins) {
      const byIdle = [...this.coins.values()].sort((a, b) => a.last - b.last);
      for (const c of byIdle.slice(0, Math.ceil(byIdle.length / 10))) this.finish(c);
    }
  }

  private finish(c: Coin): void {
    this.coins.delete(c.mint);
    this.closeMinute(c);
    const p0 = c.p0 ?? median(c.seed);
    if (!(p0 > 0)) return;
    const peak = Math.max(c.peak, p0);
    this.finished.push({
      mint: c.mint, first: c.first, firstSlot: c.firstSlot, p0, peak, peakAt: c.peakAt, x3At: c.x3At, multiple: peak / p0, minutesAbove5: c.minutesAbove5,
      peakMcapUsd: c.peakSolUsd ? peak * c.peakSolUsd * PUMP_SUPPLY : null, buyers: [...c.buyers.values()], buys: c.buys, swaps: c.swaps,
    });
  }

  takeFinished(): FinishedCoin[] {
    return this.finished.splice(0);
  }
}

/** One buyer of a finished coin as stored in runner_buyers (shared with the backfill). */
export interface BuyerRow {
  wallet: string;
  rank: number;
  t: number;
  slot: number | null;
  price: number;
  sol: number;
  tokens: number;
  soldTokens: number;
  soldSol: number;
  copyPrice: number | null;
}

/** A finished coin as stored (the tape's, or one rebuilt from the chain by the backfill). */
export interface CoinRecord {
  mint: string;
  source: "stream" | "backfill";
  symbol?: string | null;
  first: number;
  firstSlot: number | null;
  launchSeen: boolean;
  p0: number;
  peak: number;
  peakAt: number;
  x3At: number | null;
  minutesAbove5: number;
  peakMcapUsd: number | null;
  buyers: BuyerRow[];
  buys: number;
  swaps: number;
}

export function fromTape(c: FinishedCoin): CoinRecord {
  return {
    mint: c.mint, source: "stream", first: c.first, firstSlot: c.firstSlot, launchSeen: true, p0: c.p0, peak: c.peak, peakAt: c.peakAt, x3At: c.x3At,
    minutesAbove5: c.minutesAbove5, peakMcapUsd: c.peakMcapUsd, buys: c.buys, swaps: c.swaps,
    buyers: c.buyers.map((b, i) => ({ wallet: b.wallet, rank: i + 1, t: b.t, slot: b.slot, price: b.price, sol: b.sol, tokens: b.tokens, soldTokens: b.soldTokens, soldSol: b.soldSol, copyPrice: b.copyPrice })),
  };
}

/** Is this buy early: among the first buyers (any rank stored) at no more than RUNNER_EARLY_MAX_X the first price? */
export const isEarly = (price: number, p0: number, s: TapeSettings = tapeSettings): boolean => p0 > 0 && price / p0 <= s.earlyMaxX;

/**
 * Store finished coins. Every early buy the tape saw is counted per wallet and day (runner or not: a wallet that buys every
 * launch must show it); the coin's row is kept when it had a real crowd or ran; its buyers when it came close to running.
 * A coin already stored (the backfill and the tape can both see it) is replaced only by one with more buyers.
 */
export function saveCoins(db: DB, coins: CoinRecord[], s: TapeSettings = tapeSettings): { kept: number; candidates: number } {
  ensureRunnerTables(db);
  const count = db.prepare(
    `INSERT INTO runner_early_counts (wallet, day, early_buys) VALUES (?, ?, 1)
     ON CONFLICT(wallet, day) DO UPDATE SET early_buys = early_buys + 1`,
  );
  const have = db.prepare("SELECT buyers, source FROM runner_tokens WHERE mint = ?");
  const token = db.prepare(
    `INSERT OR REPLACE INTO runner_tokens (mint, source, symbol, first_seen, first_slot, launch_seen, p0_sol, peak_sol, peak_at, x3_at, multiple, minutes_above_5x,
       peak_mcap_usd, buyers, buys, swaps, is_runner, saved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT is_runner FROM runner_tokens WHERE mint = ?), 0), ?)`,
  );
  const dropBuyers = db.prepare("DELETE FROM runner_buyers WHERE mint = ?");
  const buyer = db.prepare(
    `INSERT OR REPLACE INTO runner_buyers (mint, wallet, rank, ts, slot, entry_sol, sol, tokens, entry_x, x_to_peak, sold_pct, exit_x, copy_x, sniper, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let kept = 0;
  let candidates = 0;
  const ts = nowIso();
  db.transaction(() => {
    for (const c of coins) {
      const prior = have.get(c.mint) as { buyers: number; source: string } | undefined;
      // The early buys were counted when the coin was first stored.
      if (prior && prior.buyers >= c.buyers.length) continue;
      const day = new Date(c.first).toISOString().slice(0, 10);
      // Only the tape sees every launch, runner or not; the backfill reads runners only, so its buys would inflate hit rates.
      if (!prior && c.source === "stream") for (const b of c.buyers) if (isEarly(b.price, c.p0, s)) count.run(b.wallet, day);
      const multiple = c.peak / c.p0;
      if (c.buyers.length < s.keepMinBuyers && multiple < s.candidateX) continue;
      kept++;
      token.run(
        c.mint, c.source, c.symbol ?? null, new Date(c.first).toISOString(), c.firstSlot, c.launchSeen ? 1 : 0, c.p0, c.peak, new Date(c.peakAt).toISOString(), c.x3At === null ? null : new Date(c.x3At).toISOString(), multiple,
        c.minutesAbove5, c.peakMcapUsd, c.buyers.length, c.buys, c.swaps, c.mint, ts,
      );
      if (multiple < s.candidateX || (c.peakMcapUsd ?? 0) < s.candidateMcapUsd) continue;
      candidates++;
      dropBuyers.run(c.mint);
      for (const b of c.buyers) {
        buyer.run(
          c.mint, b.wallet, b.rank, new Date(b.t).toISOString(), b.slot, b.price, b.sol, b.tokens, b.price / c.p0, c.peak / b.price,
          b.tokens > 0 ? Math.min(1, b.soldTokens / b.tokens) : 0,
          b.soldTokens > 0 && b.tokens > 0 ? b.soldSol / (b.sol * Math.min(1, b.soldTokens / b.tokens)) : null,
          b.copyPrice ? b.copyPrice / b.price : null,
          c.launchSeen && b.slot !== null && c.firstSlot !== null && b.slot <= c.firstSlot + 1 ? 1 : 0,
          c.source,
        );
      }
    }
  })();
  return { kept, candidates };
}
