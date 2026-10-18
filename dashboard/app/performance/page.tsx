"use client";
import { PageHeader } from "@/components/page-header";
import { COPYING_LINKS, SubNav } from "@/components/nav";
import { Window } from "@/components/window";
import { Stat } from "@/components/stat";
import { EquityChart, MonthlyChart, RollingWinRateChart } from "@/components/charts/perf-charts";
import { usePoll } from "@/lib/use-poll";
import { dt, pct, pnlClass } from "@/lib/format";
import type { Performance } from "@/lib/types";

export default function PerformancePage() {
  const { data } = usePoll<Performance>("/api/performance", 60_000);
  const empty = !data || data.equity.length <= 1;
  const last = data?.equity.at(-1);
  return (
    <>
      <PageHeader title="Copying" kicker="performance · closed positions only">
        <SubNav links={COPYING_LINKS} />
      </PageHeader>
      <div className="mb-3 grid grid-cols-2 gap-px border bg-border sm:grid-cols-3 lg:grid-cols-6">
        <Stat className="border-0" label="Equity" value={last ? `${last.equity.toFixed(2)}` : "—"} sub={`SOL · started ${data?.startingCapitalSol ?? "—"}`} />
        <Stat className="border-0" label="Total return" value={pct(last && data ? (last.cumPnl / data.startingCapitalSol) * 100 : null)} valueClass={pnlClass(last?.cumPnl)} />
        <Stat className="border-0"
          label="Max drawdown"
          value={data ? `${data.drawdown.maxDrawdownPct.toFixed(2)}%` : "—"}
          sub={data?.drawdown.troughTs ? `trough ${dt(data.drawdown.troughTs).slice(0, 10)}` : "no drawdown yet"}
          valueClass={data && data.drawdown.maxDrawdownPct < 0 ? "text-loss" : ""}
        />
        <Stat className="border-0" label="Current DD" value={data ? `${data.currentDrawdownPct.toFixed(2)}%` : "—"} valueClass={data && data.currentDrawdownPct < 0 ? "text-loss" : "text-win"} />
        <Stat className="border-0" label="Avg win" value={pct(data?.avgWinPct ?? null, 2)} sub={`avg loss ${pct(data?.avgLossPct ?? null, 2)}`} valueClass="text-win" />
        <Stat className="border-0" label="Profit factor" value={data?.profitFactor ? data.profitFactor.toFixed(2) : "—"} sub="gross win ÷ gross loss" />
      </div>

      {/* Drawdown meter */}
      {data && (
        <Window title="Drawdown" className="mb-3">
          <div className="p-4">
            <div className="flex justify-between text-[11px] text-muted-foreground">
              <span>0%</span>
              <span>max {data.drawdown.maxDrawdownPct.toFixed(2)}%</span>
              <span>−20%</span>
            </div>
            <div className="relative mt-1 h-4 bevel-in bg-black" role="meter" aria-valuemin={-20} aria-valuemax={0} aria-valuenow={data.currentDrawdownPct} aria-label="Current drawdown">
              <div className="absolute inset-y-0 left-0 bg-loss/40" style={{ width: `${Math.min(100, (Math.abs(data.drawdown.maxDrawdownPct) / 20) * 100)}%` }} />
              <div className="absolute inset-y-0 left-0 bg-loss" style={{ width: `${Math.min(100, (Math.abs(data.currentDrawdownPct) / 20) * 100)}%` }} />
            </div>
            <p className="mt-2 text-[11px] text-muted-foreground">Bright = current drawdown from peak equity · faded = worst drawdown ever.</p>
          </div>
        </Window>
      )}

      <div className="grid gap-3 lg:grid-cols-2">
        <Window title="Equity" className="lg:col-span-2">
          <div className="p-2 sm:p-4">{empty ? <EmptyChart /> : <EquityChart data={data!} />}</div>
        </Window>
        <Window title="30-day win rate">
          <div className="p-2 sm:p-4">{empty ? <EmptyChart /> : <RollingWinRateChart data={data!} />}</div>
        </Window>
        <Window title="Monthly">
          <div className="p-2 sm:p-4">{empty ? <EmptyChart /> : <MonthlyChart data={data!} />}</div>
        </Window>
      </div>
    </>
  );
}

function EmptyChart() {
  return <p className="flex h-[200px] items-center justify-center text-sm text-muted-foreground">Charts appear after GodsEye closes its first copied positions.</p>;
}
