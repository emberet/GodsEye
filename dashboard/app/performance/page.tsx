"use client";
import { PageHeader } from "@/components/page-header";
import { COPYING_LINKS, SubNav } from "@/components/nav";
import { Empty, Window } from "@/components/window";
import { Stat, Stats } from "@/components/stat";
import { EquityChart, MonthlyChart, RollingWinRateChart } from "@/components/charts/perf-charts";
import { usePoll } from "@/lib/use-poll";
import { DataState } from "@/components/data-state";
import { dollars, dt, pct, pnlClass } from "@/lib/format";
import type { Performance } from "@/lib/types";

export default function PerformancePage() {
  const { data, error, stale, updatedAt } = usePoll<Performance>("/api/performance", 60_000);
  const empty = !data || data.equity.length <= 1;
  const last = data?.equity.at(-1);
  return (
    <>
      <PageHeader title="Results" back="/copies" kicker="How copying has gone in the current mode, in dollars at settlement, counting closed trades only (open trades and deposits aren't included).">
        <SubNav links={COPYING_LINKS} />
      </PageHeader>
      <DataState error={error} stale={stale} updatedAt={updatedAt} what="results" />
      <Stats>
        <Stat label="Start + closed P&L" value={last ? dollars(last.equity) : "—"} sub={`started with ${dollars(data?.startingCapitalUsd ?? null)} · not the wallet balance`} />
        <Stat label="Total return" value={pct(last && data?.startingCapitalUsd ? (last.cumPnl / data.startingCapitalUsd) * 100 : null, 1)} valueClass={pnlClass(last?.cumPnl)} />
        <Stat
          label="Worst drop from a high"
          value={data ? `${data.drawdown.maxDrawdownPct.toFixed(1)}%` : "—"}
          sub={data?.drawdown.troughTs ? `lowest on ${dt(data.drawdown.troughTs).slice(0, 10)}` : "No drop yet"}
          valueClass={data && data.drawdown.maxDrawdownPct < 0 ? "text-loss" : ""}
        />
        <Stat label="Wins vs losses" value={data?.profitFactor ? data.profitFactor.toFixed(2) : "—"} unit="×" sub={`avg win ${pct(data?.avgWinPct ?? null, 1)} · avg loss ${pct(data?.avgLossPct ?? null, 1)}`} />
      </Stats>

      {empty ? (
        <div className="card">
          <Empty img="wallet" title="No results yet">Charts appear after GodsEye closes its first copied trades.</Empty>
        </div>
      ) : (
        <>
          <Window title="Money over time">
            <EquityChart data={data!} />
          </Window>
          <div className="grid gap-5 lg:grid-cols-2">
            <Window title="Win rate, last 30 days">
              <RollingWinRateChart data={data!} />
            </Window>
            <Window title="By month">
              <MonthlyChart data={data!} />
            </Window>
          </div>
          <Window title="Drop from the high">
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>0%</span>
              <span>worst {data!.drawdown.maxDrawdownPct.toFixed(1)}%</span>
              <span>−20%</span>
            </div>
            <div className="relative mt-2 h-3 overflow-hidden rounded-[6px] border-2 border-ink bg-chip" role="meter" aria-valuemin={-20} aria-valuemax={0} aria-valuenow={data!.currentDrawdownPct} aria-label="Current drop from the high">
              <div className="absolute inset-y-0 left-0 bg-coral/50" style={{ width: `${Math.min(100, (Math.abs(data!.drawdown.maxDrawdownPct) / 20) * 100)}%` }} />
              <div className="absolute inset-y-0 left-0 bg-coral" style={{ width: `${Math.min(100, (Math.abs(data!.currentDrawdownPct) / 20) * 100)}%` }} />
            </div>
            <p className="mt-2 text-xs text-muted-foreground">Bright is today&apos;s drop from the highest point; faded is the worst it has been.</p>
          </Window>
        </>
      )}
    </>
  );
}
