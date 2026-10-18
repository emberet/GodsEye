/**
 * A wallet's realized profit, from its swaps alone (average-cost method):
 *   buy  → adds tokens and their cost
 *   sell → profit = what it received − average cost of the tokens sold
 * Tracked twice, side by side:
 *   USD — every buy and sell valued in dollars when it settled (USDC/USDT
 *         exactly, SOL × SOL's price at that hour). This is the headline
 *         figure: SOL's own price moves don't show up as trading profit.
 *   SOL — the same in SOL, for sizing and for GodsEye's own SOL accounting.
 * A "position" closes when (almost) all tokens of that coin are sold; a win
 * is a closed position that made money (in USD when known). Sells of tokens
 * GodsEye never saw bought are ignored, so they can't fake a profit.
 */

export interface SwapLite {
  signature: string;
  ts: string;
  mint: string;
  side: "buy" | "sell";
  token_amount: number;
  sol_amount: number;
  /** Value in USD when it settled; null if SOL's price at the time is unknown. */
  usd_amount: number | null;
  price_sol: number;
  venue: string | null;
  jito_tip: number;
  token_age_sec: number | null;
}

export interface ClosedPosition {
  mint: string;
  openedAt: string;
  closedAt: string;
  costSol: number;
  proceedsSol: number;
  pnlSol: number;
  pnlPct: number;
  /** Null if any buy or sell in the position couldn't be valued in USD. */
  costUsd: number | null;
  proceedsUsd: number | null;
  pnlUsd: number | null;
  lastSellSignature: string;
  lastSellPriceSol: number;
  /** True if the first buy of this position was "early" (soon after the token launched). */
  earlyEntry: boolean;
}

export interface RealizedEvent {
  ts: string;
  mint: string;
  pnlSol: number;
  pnlUsd: number | null;
}

export interface Realized {
  closed: ClosedPosition[];
  events: RealizedEvent[];
  open: Map<string, { qty: number; costSol: number; costUsd: number | null; openedAt: string }>;
  unmatchedSells: number;
}

const CLOSE_THRESHOLD = 0.01; // ≤1% of the peak holding left = closed

/** A closed position's result: USD when known, otherwise SOL. */
export const positionWon = (c: ClosedPosition): boolean => (c.pnlUsd ?? c.pnlSol) > 0;

export function realize(swaps: SwapLite[], earlyBuySeconds: number): Realized {
  const sorted = [...swaps].sort((a, b) => a.ts.localeCompare(b.ts) || (a.side === "buy" ? -1 : 1));
  type St = {
    qty: number; cost: number; costUsd: number; usdKnown: boolean; peak: number; openedAt: string;
    accCost: number; accProceeds: number; accCostUsd: number; accProceedsUsd: number; early: boolean;
  };
  const state = new Map<string, St>();
  const closed: ClosedPosition[] = [];
  const events: RealizedEvent[] = [];
  let unmatchedSells = 0;

  for (const s of sorted) {
    let st = state.get(s.mint);
    if (s.side === "buy") {
      if (!st || st.qty <= 0) {
        st = {
          qty: 0, cost: 0, costUsd: 0, usdKnown: true, peak: 0, openedAt: s.ts,
          accCost: 0, accProceeds: 0, accCostUsd: 0, accProceedsUsd: 0, early: s.token_age_sec !== null && s.token_age_sec <= earlyBuySeconds,
        };
        state.set(s.mint, st);
      }
      st.qty += s.token_amount;
      st.cost += s.sol_amount;
      if (s.usd_amount === null) st.usdKnown = false;
      else st.costUsd += s.usd_amount;
      st.peak = Math.max(st.peak, st.qty);
      continue;
    }
    if (!st || st.qty <= 0) {
      unmatchedSells++;
      continue;
    }
    const sold = Math.min(s.token_amount, st.qty);
    const share = sold / st.qty;
    const costPart = st.cost * share;
    const costUsdPart = st.costUsd * share;
    const proceedsPart = s.sol_amount * (sold / s.token_amount);
    const proceedsUsdPart = s.usd_amount === null ? null : s.usd_amount * (sold / s.token_amount);
    if (proceedsUsdPart === null) st.usdKnown = false;
    st.qty -= sold;
    st.cost -= costPart;
    st.costUsd -= costUsdPart;
    st.accCost += costPart;
    st.accProceeds += proceedsPart;
    st.accCostUsd += costUsdPart;
    st.accProceedsUsd += proceedsUsdPart ?? 0;
    events.push({ ts: s.ts, mint: s.mint, pnlSol: proceedsPart - costPart, pnlUsd: st.usdKnown && proceedsUsdPart !== null ? proceedsUsdPart - costUsdPart : null });
    if (st.qty <= st.peak * CLOSE_THRESHOLD) {
      const pnl = st.accProceeds - st.accCost;
      closed.push({
        mint: s.mint,
        openedAt: st.openedAt,
        closedAt: s.ts,
        costSol: st.accCost,
        proceedsSol: st.accProceeds,
        pnlSol: pnl,
        pnlPct: st.usdKnown && st.accCostUsd > 0 ? ((st.accProceedsUsd - st.accCostUsd) / st.accCostUsd) * 100 : st.accCost > 0 ? (pnl / st.accCost) * 100 : 0,
        costUsd: st.usdKnown ? st.accCostUsd : null,
        proceedsUsd: st.usdKnown ? st.accProceedsUsd : null,
        pnlUsd: st.usdKnown ? st.accProceedsUsd - st.accCostUsd : null,
        lastSellSignature: s.signature,
        lastSellPriceSol: s.price_sol,
        earlyEntry: st.early,
      });
      state.delete(s.mint);
    }
  }
  const open = new Map<string, { qty: number; costSol: number; costUsd: number | null; openedAt: string }>();
  for (const [mint, st] of state) if (st.qty > 0) open.set(mint, { qty: st.qty, costSol: st.cost, costUsd: st.usdKnown ? st.costUsd : null, openedAt: st.openedAt });
  return { closed, events, open, unmatchedSells };
}

export interface ComputedStats {
  swaps_total: number;
  swaps_7d: number;
  swaps_30d: number;
  pnl_7d_sol: number;
  pnl_30d_sol: number;
  pnl_all_sol: number;
  /** USD P&L over trades that could be valued in USD (null if none could). */
  pnl_7d_usd: number | null;
  pnl_30d_usd: number | null;
  pnl_all_usd: number | null;
  closed_7d: number;
  closed_30d: number;
  wins_30d: number;
  win_rate_30d: number | null;
  best_trade_share: number | null;
  avg_buy_sol: number | null;
  avg_buy_usd: number | null;
  avg_hold_minutes: number | null;
  early_buys: number;
  early_buy_rate: number | null;
  first_trade_at: string | null;
  last_trade_at: string | null;
}

const DAY = 86_400_000;

export function computeStats(swaps: SwapLite[], r: Realized, now: number, earlyBuySeconds: number): ComputedStats {
  const since = (days: number) => new Date(now - days * DAY).toISOString();
  const d7 = since(7);
  const d30 = since(30);
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const usdSum = (evs: RealizedEvent[]) => {
    const known = evs.filter((e) => e.pnlUsd !== null);
    return known.length ? sum(known.map((e) => e.pnlUsd as number)) : null;
  };
  const closed30 = r.closed.filter((c) => c.closedAt >= d30);
  const wins30 = closed30.filter(positionWon);
  const positive = wins30.map((c) => c.pnlUsd ?? c.pnlSol);
  const buys30 = swaps.filter((s) => s.side === "buy" && s.ts >= d30);
  const buys30Usd = buys30.filter((s) => s.usd_amount !== null);
  const aged = swaps.filter((s) => s.side === "buy" && s.token_age_sec !== null);
  const early = aged.filter((s) => (s.token_age_sec as number) <= earlyBuySeconds);
  const holds = closed30.map((c) => (Date.parse(c.closedAt) - Date.parse(c.openedAt)) / 60_000);
  const ts = swaps.map((s) => s.ts).sort();
  const ev7 = r.events.filter((e) => e.ts >= d7);
  const ev30 = r.events.filter((e) => e.ts >= d30);
  return {
    swaps_total: swaps.length,
    swaps_7d: swaps.filter((s) => s.ts >= d7).length,
    swaps_30d: swaps.filter((s) => s.ts >= d30).length,
    pnl_7d_sol: sum(ev7.map((e) => e.pnlSol)),
    pnl_30d_sol: sum(ev30.map((e) => e.pnlSol)),
    pnl_all_sol: sum(r.events.map((e) => e.pnlSol)),
    pnl_7d_usd: usdSum(ev7),
    pnl_30d_usd: usdSum(ev30),
    pnl_all_usd: usdSum(r.events),
    closed_7d: r.closed.filter((c) => c.closedAt >= d7).length,
    closed_30d: closed30.length,
    wins_30d: wins30.length,
    win_rate_30d: closed30.length ? wins30.length / closed30.length : null,
    best_trade_share: positive.length ? Math.max(...positive) / sum(positive) : null,
    avg_buy_sol: buys30.length ? sum(buys30.map((s) => s.sol_amount)) / buys30.length : null,
    avg_buy_usd: buys30Usd.length ? sum(buys30Usd.map((s) => s.usd_amount as number)) / buys30Usd.length : null,
    avg_hold_minutes: holds.length ? sum(holds) / holds.length : null,
    early_buys: early.length,
    early_buy_rate: aged.length >= 3 ? early.length / aged.length : null,
    first_trade_at: ts[0] ?? null,
    last_trade_at: ts.at(-1) ?? null,
  };
}
