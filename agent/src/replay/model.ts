/**
 * THE COPY-FILL REPLAY — what would copying a leader have earned at GodsEye's real delay?
 *
 * A leader's own P&L says nothing about a follower's: GodsEye enters after the leader's swap has
 * already moved the price, pays fees and a landing tip, and exits after the leader's sell has moved
 * it again. This replays each leader's recorded trades the way the copy engine would have taken
 * them, at a chosen delay, against the price tape of every swap GodsEye has stored for that token.
 *
 * Model (all of it is an approximation, and the assumptions are visible in ReplayParams):
 *   • Tape: every stored swap on the token (any tracked wallet). Prices are average execution
 *     prices that include the DEX fee, so each is turned into a fee-free MID price (buy ÷ (1+fee),
 *     sell ÷ (1−fee)). Price only changes when someone trades, so the price at time T is the price
 *     after the last stored swap at or before T. Swaps by wallets GodsEye doesn't track are missing:
 *     the tape is thin, so delay costs found here are a LOWER bound.
 *   • Depth: the pool is treated as constant-product. Its effective SOL reserve is estimated from
 *     how the tape's price moved with the flow of recent swaps (median over pairs), falling back to
 *     a default. Depth turns a swap's size into price impact: the leader's own trade (so we enter
 *     after it) and ours.
 *   • Fill: buy at mid × (1+fee) × (1 + size ÷ depth); sell at mid × (1−fee) ÷ (1 + value ÷ depth);
 *     plus a flat transaction cost (priority fee / tip) per transaction.
 *   • Same rules as the copy engine: one position per token, leader buys under MIN_LEADER_BUY_SOL
 *     skipped, a leader sell of X% sells X% of ours (≥ 90% sells everything), and GodsEye's own
 *     stop-loss / take-profit / max-hold checked on a one-minute grid.
 *   • "Ideal" mode is the leader's side of the same episodes: the leader's own fills, no costs, no
 *     delay. Ideal minus real is what copying cost.
 * Not replayed: rug and holder checks, budget / position-count / daily-loss limits.
 *
 * Pure functions only — no database, no network.
 */

export interface Obs {
  /** Block time, ms. */
  t: number;
  side: "buy" | "sell";
  /** Average execution price in SOL per token, DEX fee included. */
  price: number;
  /** SOL spent (buy) or received (sell). */
  sol: number;
  sig?: string;
}

export interface LeaderSwap {
  t: number;
  side: "buy" | "sell";
  price: number;
  solAmount: number;
  tokenAmount: number;
  tokenBalanceBefore: number;
  signature: string;
}

export interface ReplayParams {
  /** Leader's block time → our fill lands, seconds. */
  delaySec: number;
  /** Our own exit check → fill lands, seconds (stop-loss, take-profit, max hold). */
  landSec: number;
  sizeSol: number;
  /** One-way DEX fee, basis points (assumption; the tape's prices include it). */
  feeBps: number;
  /** Priority fee / tip / base fee per transaction, SOL (assumption until real fills exist). */
  txCostSol: number;
  /** Effective SOL reserve when the tape can't tell. 30 = a fresh pump.fun curve. */
  defaultDepthSol: number;
  depthWindowSec: number;
  /** Use this depth for every token instead of estimating it from the tape. null = estimate. */
  fixedDepthSol: number | null;
  minLeaderBuySol: number;
  stopLossPct: number;
  takeProfitPct: number;
  maxHoldHours: number;
  checkEverySec: number;
  /** The leader's side: leader fills, no costs, no delay. */
  ideal: boolean;
}

export const DEFAULT_PARAMS: ReplayParams = {
  delaySec: 5,
  landSec: 2,
  sizeSol: 0.1,
  feeBps: 100,
  txCostSol: 0.0005,
  defaultDepthSol: 30,
  depthWindowSec: 600,
  fixedDepthSol: null,
  minLeaderBuySol: 0.2,
  stopLossPct: 35,
  takeProfitPct: 300,
  maxHoldHours: 48,
  checkEverySec: 60,
  ideal: false,
};

/** Price impact is capped here (size ÷ depth) so one bad depth estimate can't invent a 100× move. */
const MAX_IMPACT = 3;
const MIN_DEPTH = 1;
const MAX_DEPTH = 5000;
/** Consecutive swaps further apart than this say nothing about depth. */
const PAIR_MAX_GAP_MS = 60_000;
/** Moves smaller than this (log) are rounding noise, not impact. */
const PAIR_MIN_MOVE = 0.001;
const MIN_DEPTH_PAIRS = 3;
const FALLBACK_LOOKBACK = 400;

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export class Tape {
  private depthCache = new Map<number, number>();
  /** `obs` must be sorted by time (ties in the order the swaps happened). */
  constructor(
    readonly obs: Obs[],
    private feeBps: number,
    private defaultDepth: number,
    private depthWindowMs: number,
    /** Skip the estimate and use this depth everywhere (for testing how much the depth assumption matters). */
    private fixedDepth: number | null = null,
  ) {}

  /** Fee-free price of an observation. */
  mid(o: Obs): number {
    const f = this.feeBps / 1e4;
    return o.side === "buy" ? o.price / (1 + f) : o.price / (1 - f);
  }

  /** Index of the last observation at or before t (−1 if none). */
  lastAtOrBefore(t: number): number {
    let lo = 0;
    let hi = this.obs.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (this.obs[m].t <= t) lo = m + 1;
      else hi = m;
    }
    return lo - 1;
  }

  /** Index of the first observation at or after t (obs.length if none). */
  firstAtOrAfter(t: number): number {
    let lo = 0;
    let hi = this.obs.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (this.obs[m].t < t) lo = m + 1;
      else hi = m;
    }
    return lo;
  }

  /** Effective SOL reserve around observation i, from swaps up to and including it. */
  depthAt(i: number): number {
    if (this.fixedDepth !== null) return this.fixedDepth;
    const cached = this.depthCache.get(i);
    if (cached !== undefined) return cached;
    const from = this.firstAtOrAfter(this.obs[i].t - this.depthWindowMs);
    let est = this.estimateDepth(from, i);
    if (est === null) est = this.estimateDepth(Math.max(0, i - FALLBACK_LOOKBACK), i);
    const depth = est ?? this.defaultDepth;
    this.depthCache.set(i, depth);
    return depth;
  }

  /**
   * Constant product: price ∝ reserve², so a net flow F moves ln(price) by about F ÷ reserve. For
   * consecutive swaps i, j (mid-trade prices) that gives reserve ≈ (flow_i + flow_j) ÷ Δln(price).
   * Swaps by untracked wallets are missing, which inflates Δln(price) and so UNDERestimates depth
   * (more impact, the cautious side). The median shrugs off the worst pairs.
   */
  private estimateDepth(from: number, to: number): number | null {
    const xs: number[] = [];
    for (let k = from; k < to; k++) {
      const a = this.obs[k];
      const b = this.obs[k + 1];
      if (b.t - a.t > PAIR_MAX_GAP_MS) continue;
      const dln = Math.log(this.mid(b) / this.mid(a));
      const flow = (a.side === "buy" ? a.sol : -a.sol) + (b.side === "buy" ? b.sol : -b.sol);
      if (!Number.isFinite(dln) || Math.abs(dln) < PAIR_MIN_MOVE || flow * dln <= 0) continue;
      xs.push(flow / dln);
    }
    if (xs.length < MIN_DEPTH_PAIRS) return null;
    const m = median(xs)!;
    return Math.min(MAX_DEPTH, Math.max(MIN_DEPTH, m));
  }

  /**
   * The pool's fee-free price at time t: the price after the last swap at or before t. That swap's own
   * impact is added (its stored price is the average over the trade, not the price it left behind).
   */
  midAt(t: number): { mid: number; ageSec: number; depth: number } | null {
    const i = this.lastAtOrBefore(t);
    if (i < 0) return null;
    const o = this.obs[i];
    const depth = this.depthAt(i);
    const impact = Math.min(MAX_IMPACT, o.sol / depth);
    const m = this.mid(o);
    return { mid: o.side === "buy" ? m * (1 + impact) : m / (1 + impact), ageSec: (t - o.t) / 1000, depth };
  }

  /** Swaps by other wallets within ±windowMs of t — how well the tape sees this moment. */
  density(t: number, windowMs: number, excludeSig?: string): number {
    const a = this.firstAtOrAfter(t - windowMs);
    const b = this.lastAtOrBefore(t + windowMs);
    let n = 0;
    for (let k = a; k <= b; k++) if (!excludeSig || this.obs[k].sig !== excludeSig) n++;
    return n;
  }
}

export function buyFill(mid: number, solIn: number, depth: number, feeBps: number): { price: number; tokens: number } {
  const price = mid * (1 + feeBps / 1e4) * (1 + Math.min(MAX_IMPACT, solIn / depth));
  return { price, tokens: solIn / price };
}

export function sellFill(mid: number, tokens: number, depth: number, feeBps: number): { price: number; sol: number } {
  const value = tokens * mid;
  const price = (mid * (1 - feeBps / 1e4)) / (1 + Math.min(MAX_IMPACT, value / depth));
  return { price, sol: tokens * price };
}

export interface Episode {
  mint: string;
  /** Leader's entry swap. */
  entrySignature: string;
  entryT: number;
  leaderEntryPrice: number;
  /** Our average entry price (SOL per token). */
  entryPrice: number;
  /** Our entry price ÷ the leader's − 1. */
  entryDrift: number;
  /** SOL spent including the entry transaction cost. */
  costSol: number;
  proceedsSol: number;
  pnlSol: number;
  /** Return on cost, %. */
  retPct: number;
  /** False = still open when the data ended; marked at the last price with exit costs. */
  closed: boolean;
  exitReason: string;
  /** Seconds from the leader's entry to the first leader sell, if there was one. */
  leaderFirstSellSec: number | null;
  /** Swaps by other wallets within ±2 min of the entry: how well the tape sees it. */
  density: number;
  /** Price age at our entry (seconds since the last stored swap). */
  priceAgeSec: number;
}

interface Position {
  entryT: number;
  fillT: number;
  tokens: number;
  tokensBought: number;
  heldCost: number;
  sizeSol: number;
  costSol: number;
  proceeds: number;
  entryPrice: number;
  leaderEntryPrice: number;
  entrySignature: string;
  leaderT: number;
  firstSell: number | null;
  density: number;
  priceAge: number;
  /** Where the next risk scan starts. */
  scanT: number;
}

/**
 * Replay one leader's swaps in one token. Returns one Episode per position the copy engine would have opened
 * (swaps must be in time order). `endT` = when the data ends.
 */
export function simulateMint(tape: Tape, mint: string, swaps: LeaderSwap[], endT: number, p: ReplayParams): Episode[] {
  const out: Episode[] = [];
  const lagMs = p.ideal ? 0 : p.delaySec * 1000;
  const landMs = p.ideal ? 0 : p.landSec * 1000;
  const txCost = p.ideal ? 0 : p.txCostSol;
  const checkMs = p.checkEverySec * 1000;
  const holdMs = p.maxHoldHours * 3_600_000;
  // Closures below change the open position, so it lives in a holder (TypeScript can't see those changes on a plain variable).
  const st: { pos: Position | null } = { pos: null };

  const finish = (closed: boolean, reason: string) => {
    const x = st.pos!;
    const pnl = x.proceeds - x.costSol;
    out.push({
      mint,
      entrySignature: x.entrySignature,
      entryT: x.leaderT,
      leaderEntryPrice: x.leaderEntryPrice,
      entryPrice: x.entryPrice,
      entryDrift: x.entryPrice / x.leaderEntryPrice - 1,
      costSol: x.costSol,
      proceedsSol: x.proceeds,
      pnlSol: pnl,
      retPct: x.costSol > 0 ? (pnl / x.costSol) * 100 : 0,
      closed,
      exitReason: reason,
      leaderFirstSellSec: x.firstSell === null ? null : (x.firstSell - x.leaderT) / 1000,
      density: x.density,
      priceAgeSec: x.priceAge,
    });
    st.pos = null;
  };

  /** Sell `tokens` of the open position at time `at` (the moment the sell lands). Leader sells pass the leader's price. */
  const sell = (tokens: number, at: number, leaderPrice?: number): boolean => {
    const x = st.pos!;
    let sol: number;
    if (p.ideal && leaderPrice !== undefined) sol = tokens * leaderPrice;
    else {
      const r = tape.midAt(at);
      if (!r) return false;
      sol = p.ideal ? tokens * r.mid : sellFill(r.mid, tokens, r.depth, p.feeBps).sol;
    }
    x.proceeds += sol - txCost;
    x.heldCost *= (x.tokens - tokens) / x.tokens;
    x.tokens -= tokens;
    return true;
  };

  /**
   * GodsEye's own exits between `from` and `to`: stop-loss, take-profit and max-hold, checked on a grid
   * from the entry (price can only change when a swap happens, so only those moments are looked at).
   * Returns the reason if it sold everything.
   */
  const riskScan = (to: number): string | null => {
    const x = st.pos!;
    const deadline = x.fillT + holdMs;
    const limit = Math.min(to, deadline);
    let i = tape.firstAtOrAfter(x.scanT);
    while (i < tape.obs.length && tape.obs[i].t <= limit) {
      const g = x.fillT + Math.ceil((tape.obs[i].t - x.fillT) / checkMs) * checkMs;
      if (g > limit) break;
      const r = tape.midAt(g);
      if (r && x.heldCost > 0) {
        const pct = ((x.tokens * r.mid - x.heldCost) / x.heldCost) * 100;
        const reason = pct <= -p.stopLossPct ? "stop-loss" : pct >= p.takeProfitPct ? "take-profit" : null;
        if (reason && sell(x.tokens, g + landMs)) return reason;
      }
      i = tape.lastAtOrBefore(g) + 1;
    }
    x.scanT = Math.max(x.scanT, limit);
    if (deadline <= to && sell(x.tokens, deadline + landMs)) return "max-hold";
    return null;
  };

  for (const ev of swaps) {
    const at = ev.t + lagMs;
    if (st.pos) {
      const reason = riskScan(at);
      if (reason) finish(true, reason);
    }
    if (ev.side === "buy") {
      if (st.pos || ev.solAmount < p.minLeaderBuySol) continue;
      let price: number;
      let age = 0;
      let tokens: number;
      if (p.ideal) {
        price = ev.price;
        tokens = p.sizeSol / price;
      } else {
        const r = tape.midAt(at);
        if (!r) continue;
        const f = buyFill(r.mid, p.sizeSol, r.depth, p.feeBps);
        price = f.price;
        tokens = f.tokens;
        age = r.ageSec;
      }
      st.pos = {
        entryT: ev.t,
        fillT: at,
        tokens,
        tokensBought: tokens,
        heldCost: p.sizeSol,
        sizeSol: p.sizeSol,
        costSol: p.sizeSol + txCost,
        proceeds: 0,
        entryPrice: price,
        leaderEntryPrice: ev.price,
        entrySignature: ev.signature,
        leaderT: ev.t,
        firstSell: null,
        density: tape.density(ev.t, 120_000, ev.signature),
        priceAge: age,
        scanT: at,
      };
    } else if (st.pos) {
      const pos = st.pos;
      pos.firstSell ??= ev.t;
      const fraction = ev.tokenBalanceBefore > 0 ? Math.min(1, ev.tokenAmount / ev.tokenBalanceBefore) : 1;
      const all = fraction >= 0.9;
      const amount = all ? pos.tokens : pos.tokens * fraction;
      if (!sell(amount, at, ev.price)) continue;
      pos.scanT = at;
      if (all || pos.tokens <= pos.tokensBought * 0.01) finish(true, all ? "leader sold" : "leader sold (rest dust)");
    }
  }
  if (st.pos) {
    const reason = riskScan(endT);
    if (reason) finish(true, reason);
    else {
      // Still open when the data ended: mark at the last price, with the exit's costs.
      const r = tape.midAt(endT);
      const x = st.pos;
      if (r) x.proceeds += (p.ideal ? x.tokens * r.mid : sellFill(r.mid, x.tokens, r.depth, p.feeBps).sol) - txCost;
      finish(false, "still open");
    }
  }
  return out;
}
