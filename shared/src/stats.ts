/** Performance math used by the dashboard and the daily recap. */

export interface ClosedTrade {
  exit_ts: string;
  pnl_sol: number;
  pnl_pct: number;
}

export function winRate(trades: { pnl_sol: number }[]): number | null {
  if (trades.length === 0) return null;
  return (trades.filter((t) => t.pnl_sol > 0).length / trades.length) * 100;
}

export interface EquityPoint {
  ts: string;
  equity: number;
  cumPnl: number;
  drawdownPct: number;
}

/** Equity curve: starting capital + running total of closed-trade P&L. */
export function equityCurve(trades: ClosedTrade[], startingCapital: number): EquityPoint[] {
  const sorted = [...trades].sort((a, b) => a.exit_ts.localeCompare(b.exit_ts));
  let cum = 0;
  let peak = startingCapital;
  return sorted.map((t) => {
    cum += t.pnl_sol;
    const equity = startingCapital + cum;
    peak = Math.max(peak, equity);
    return { ts: t.exit_ts, equity, cumPnl: cum, drawdownPct: peak > 0 ? ((equity - peak) / peak) * 100 : 0 };
  });
}

export interface Drawdown {
  maxDrawdownPct: number;
  maxDrawdownSol: number;
  peakTs: string | null;
  troughTs: string | null;
}

export function maxDrawdown(curve: EquityPoint[], startingCapital: number): Drawdown {
  let peak = startingCapital;
  let peakTs: string | null = null;
  const worst: Drawdown = { maxDrawdownPct: 0, maxDrawdownSol: 0, peakTs: null, troughTs: null };
  for (const p of curve) {
    if (p.equity > peak) {
      peak = p.equity;
      peakTs = p.ts;
    }
    const ddSol = p.equity - peak;
    const ddPct = peak > 0 ? (ddSol / peak) * 100 : 0;
    if (ddPct < worst.maxDrawdownPct) Object.assign(worst, { maxDrawdownPct: ddPct, maxDrawdownSol: ddSol, peakTs, troughTs: p.ts });
  }
  return worst;
}

/** Win rate over the trailing `windowDays` for each day that had trades. */
export function rollingWinRate(trades: ClosedTrade[], windowDays = 30): { day: string; winRate: number; trades: number }[] {
  if (trades.length === 0) return [];
  const sorted = [...trades].sort((a, b) => a.exit_ts.localeCompare(b.exit_ts));
  const days = [...new Set(sorted.map((t) => t.exit_ts.slice(0, 10)))];
  return days.map((day) => {
    const end = new Date(`${day}T23:59:59.999Z`).getTime();
    const start = end - windowDays * 86_400_000;
    const inWindow = sorted.filter((t) => {
      const ts = new Date(t.exit_ts).getTime();
      return ts > start && ts <= end;
    });
    return { day, winRate: winRate(inWindow) ?? 0, trades: inWindow.length };
  });
}

/** Sum of P&L per calendar month, plus % of capital at month start. */
export function monthlyReturns(trades: ClosedTrade[], startingCapital: number): { month: string; pnlSol: number; returnPct: number }[] {
  const sorted = [...trades].sort((a, b) => a.exit_ts.localeCompare(b.exit_ts));
  const months = new Map<string, number>();
  for (const t of sorted) months.set(t.exit_ts.slice(0, 7), (months.get(t.exit_ts.slice(0, 7)) ?? 0) + t.pnl_sol);
  let capital = startingCapital;
  return [...months.entries()].map(([month, pnlSol]) => {
    const returnPct = capital > 0 ? (pnlSol / capital) * 100 : 0;
    capital += pnlSol;
    return { month, pnlSol, returnPct };
  });
}
