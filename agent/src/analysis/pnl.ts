/**
 * A wallet's realized profit, from its swaps alone (average-cost method):
 *   buy  → adds tokens and their SOL cost
 *   sell → profit = SOL received − average cost of the tokens sold
 * A "position" closes when (almost) all tokens of that coin are sold; a win
 * is a closed position that made money. Sells of tokens GodsEye never saw
 * bought (received by transfer, or bought before it started reading) are
 * ignored, so they can't fake a profit.
 */

export interface SwapLite {
  signature: string;
  ts: string;
  mint: string;
  side: "buy" | "sell";
  token_amount: number;
  sol_amount: number;
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
  lastSellSignature: string;
  lastSellPriceSol: number;
  /** True if the first buy of this position was "early" (soon after the token launched). */
  earlyEntry: boolean;
}

export interface RealizedEvent {
  ts: string;
  mint: string;
  pnlSol: number;
}

export interface Realized {
  closed: ClosedPosition[];
  events: RealizedEvent[];
  open: Map<string, { qty: number; costSol: number; openedAt: string }>;
  unmatchedSells: number;
}

const CLOSE_THRESHOLD = 0.01; // ≤1% of the peak holding left = closed

export function realize(swaps: SwapLite[], earlyBuySeconds: number): Realized {
  const sorted = [...swaps].sort((a, b) => a.ts.localeCompare(b.ts) || (a.side === "buy" ? -1 : 1));
  type St = { qty: number; cost: number; peak: number; openedAt: string; accCost: number; accProceeds: number; early: boolean };
  const state = new Map<string, St>();
  const closed: ClosedPosition[] = [];
  const events: RealizedEvent[] = [];
  let unmatchedSells = 0;

  for (const s of sorted) {
    let st = state.get(s.mint);
    if (s.side === "buy") {
      if (!st || st.qty <= 0) {
        st = { qty: 0, cost: 0, peak: 0, openedAt: s.ts, accCost: 0, accProceeds: 0, early: s.token_age_sec !== null && s.token_age_sec <= earlyBuySeconds };
        state.set(s.mint, st);
      }
      st.qty += s.token_amount;
      st.cost += s.sol_amount;
      st.peak = Math.max(st.peak, st.qty);
      continue;
    }
    if (!st || st.qty <= 0) {
      unmatchedSells++;
      continue;
    }
    const sold = Math.min(s.token_amount, st.qty);
    const costPart = st.cost * (sold / st.qty);
    const proceedsPart = s.sol_amount * (sold / s.token_amount);
    st.qty -= sold;
    st.cost -= costPart;
    st.accCost += costPart;
    st.accProceeds += proceedsPart;
    events.push({ ts: s.ts, mint: s.mint, pnlSol: proceedsPart - costPart });
    if (st.qty <= st.peak * CLOSE_THRESHOLD) {
      const pnl = st.accProceeds - st.accCost;
      closed.push({
        mint: s.mint,
        openedAt: st.openedAt,
        closedAt: s.ts,
        costSol: st.accCost,
        proceedsSol: st.accProceeds,
        pnlSol: pnl,
        pnlPct: st.accCost > 0 ? (pnl / st.accCost) * 100 : 0,
        lastSellSignature: s.signature,
        lastSellPriceSol: s.price_sol,
        earlyEntry: st.early,
      });
      state.delete(s.mint);
    }
  }
  const open = new Map<string, { qty: number; costSol: number; openedAt: string }>();
  for (const [mint, st] of state) if (st.qty > 0) open.set(mint, { qty: st.qty, costSol: st.cost, openedAt: st.openedAt });
  return { closed, events, open, unmatchedSells };
}

export interface ComputedStats {
  swaps_total: number;
  swaps_7d: number;
  swaps_30d: number;
  pnl_7d_sol: number;
  pnl_30d_sol: number;
  pnl_all_sol: number;
  closed_7d: number;
  closed_30d: number;
  wins_30d: number;
  win_rate_30d: number | null;
  best_trade_share: number | null;
  avg_buy_sol: number | null;
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
  const closed30 = r.closed.filter((c) => c.closedAt >= d30);
  const wins30 = closed30.filter((c) => c.pnlSol > 0);
  const positive = wins30.map((c) => c.pnlSol);
  const buys30 = swaps.filter((s) => s.side === "buy" && s.ts >= d30);
  const aged = swaps.filter((s) => s.side === "buy" && s.token_age_sec !== null);
  const early = aged.filter((s) => (s.token_age_sec as number) <= earlyBuySeconds);
  const holds = closed30.map((c) => (Date.parse(c.closedAt) - Date.parse(c.openedAt)) / 60_000);
  const ts = swaps.map((s) => s.ts).sort();
  return {
    swaps_total: swaps.length,
    swaps_7d: swaps.filter((s) => s.ts >= d7).length,
    swaps_30d: swaps.filter((s) => s.ts >= d30).length,
    pnl_7d_sol: sum(r.events.filter((e) => e.ts >= d7).map((e) => e.pnlSol)),
    pnl_30d_sol: sum(r.events.filter((e) => e.ts >= d30).map((e) => e.pnlSol)),
    pnl_all_sol: sum(r.events.map((e) => e.pnlSol)),
    closed_7d: r.closed.filter((c) => c.closedAt >= d7).length,
    closed_30d: closed30.length,
    wins_30d: wins30.length,
    win_rate_30d: closed30.length ? wins30.length / closed30.length : null,
    best_trade_share: positive.length ? Math.max(...positive) / sum(positive) : null,
    avg_buy_sol: buys30.length ? sum(buys30.map((s) => s.sol_amount)) / buys30.length : null,
    avg_hold_minutes: holds.length ? sum(holds) / holds.length : null,
    early_buys: early.length,
    early_buy_rate: aged.length >= 3 ? early.length / aged.length : null,
    first_trade_at: ts[0] ?? null,
    last_trade_at: ts.at(-1) ?? null,
  };
}
