"use client";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { COPYING_LINKS, SubNav } from "@/components/nav";
import { Empty, Window } from "@/components/window";
import { KindBadge, TierBadge, WalletDot } from "@/components/wallet-badges";
import { usePoll } from "@/lib/use-poll";
import { ago, pnlClass, shortAddr, signedSol, signedUsd } from "@/lib/format";
import type { LeadersData, SmartMoneyData } from "@/lib/types";
import { cn } from "@/lib/utils";

const pc = (n: number | null | undefined) => (n == null ? "—" : `${Math.round(n * 100)}%`);

export default function LeadersPage() {
  const { data } = usePoll<LeadersData>("/api/leaders", 30_000);
  const { data: smart } = usePoll<SmartMoneyData>("/api/smart", 30_000);
  const score = (kind: "accumulate" | "exit", h: "1h" | "6h" | "24h") => smart?.scorecard.find((x) => x.kind === kind && x.horizon === h);
  const measured = (smart?.wallets ?? []).filter((w) => w.lead_n > 0).slice(0, 8);
  const leaders = data?.leaders ?? [];
  const fb = data?.followBar;
  const barPct = fb ? Math.round(fb.value * 100) : 50;

  return (
    <>
      <PageHeader title="Who it copies" back="/copies" kicker="Re-checked every 15 minutes. Only wallets with a real track record make the cut.">
        <SubNav links={COPYING_LINKS} />
      </PageHeader>

      <section className="grid gap-5 lg:grid-cols-[1fr_1.4fr]">
        <div className="card">
          <h2 className="text-xl font-extrabold tracking-[-0.02em]">Follow bar</h2>
          <div className="mt-4 flex items-center gap-5">
            <div className="relative h-28 w-28 shrink-0" role="img" aria-label={`Follow bar ${barPct}% wins`}>
              <svg viewBox="0 0 36 36" className="h-full w-full -rotate-90" aria-hidden>
                <circle cx="18" cy="18" r="15.5" fill="none" stroke="#34343D" strokeWidth="4.5" />
                <circle cx="18" cy="18" r="15.5" fill="none" stroke="#D4EC00" strokeWidth="4.5" strokeLinecap="round" strokeDasharray={`${(barPct / 100) * 97.4} 97.4`} />
              </svg>
              <span className="absolute inset-0 flex items-center justify-center text-[28px] font-black num">{barPct}%</span>
            </div>
            <div className="min-w-0">
              <p className="font-medium">Minimum win rate to be copied</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Not fixed. GodsEye raises it when copying lower-win-rate wallets loses money, and lowers it when they turn out fine.
                {fb?.target != null && fb.target !== fb.value && <> Heading to {Math.round(fb.target * 100)}%.</>}
              </p>
            </div>
          </div>
          <p className="mt-4 rounded-[14px] border-[2.5px] border-ink bg-panel px-4 py-3 text-sm">
            <span className="font-semibold">Right now: </span>
            {fb?.reason ?? "Starts at 50% and adjusts once copies, or shadow copies of smart buys, have results."}
          </p>
          {(data?.followBarHistory ?? []).length > 0 && (
            <div className="mt-2">
              {(data?.followBarHistory ?? []).slice(0, 4).map((h) => (
                <div key={h.id} className="line text-sm">
                  <span className="num">
                    {Math.round(h.old_value * 100)}% → <b className="text-accent">{Math.round(h.new_value * 100)}%</b>
                  </span>
                  <span className="ml-auto text-xs text-muted-foreground">{ago(h.ts)}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="card">
          <h2 className="text-xl font-extrabold tracking-[-0.02em]">What it learned from smart money</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            When 3 or more smart wallets buy (or dump) the same coin within an hour, did the price follow? {smart?.activeWallets ?? "—"} smart wallets followed
            {smart?.droppedWallets ? `, ${smart.droppedWallets} dropped for buying tops` : ""}.
          </p>
          <div className="mt-4 grid grid-cols-[auto_repeat(3,minmax(0,1fr))] items-end gap-x-4 gap-y-3">
            <span />
            {(["1h", "6h", "24h"] as const).map((h) => (
              <span key={h} className="k text-right">after {h}</span>
            ))}
            {(["accumulate", "exit"] as const).map((k) => (
              <div key={k} className="contents">
                <span className="text-sm font-medium">{k === "accumulate" ? "Bought, went up" : "Dumped, went down"}</span>
                {(["1h", "6h", "24h"] as const).map((h) => {
                  const sc = score(k, h);
                  return (
                    <span key={h} className="text-right" title={sc ? `${sc.measured} of ${sc.signals} measured, median ${sc.median_ret?.toFixed(0) ?? "—"}%` : ""}>
                      <span className="text-[26px] font-extrabold num">{pc(sc?.hit_rate)}</span>
                      <span className="block text-xs text-muted-foreground num">{sc?.measured ?? 0} measured</span>
                    </span>
                  );
                })}
              </div>
            ))}
          </div>
          <p className="k mt-5">Smart wallets: how often the price rose 6 hours after they bought</p>
          {measured.length === 0 && <p className="py-2 text-sm text-muted-foreground">No buys measured yet. Each one is checked 1, 6 and 24 hours later.</p>}
          {measured.map((w) => (
            <div key={w.address} className={cn("line text-sm", !w.active && "opacity-50")}>
              <WalletDot address={w.address} tier={w.tier} className="h-8 w-8 text-[11px]" />
              <Link href={`/wallets/${w.address}`} className="font-mono hover:text-accent">{shortAddr(w.address)}</Link>
              <span className="ml-auto num">{pc(w.lead_hit_rate)} up</span>
              <span className={cn("w-24 text-right num", pnlClass(w.lead_median_6h))}>
                median {w.lead_median_6h == null ? "—" : `${w.lead_median_6h >= 0 ? "+" : ""}${Math.round(w.lead_median_6h)}%`}
              </span>
            </div>
          ))}
        </div>
      </section>

      <Window title="Every wallet it considered" right={<span className="text-muted-foreground">{leaders.filter((l) => l.copy_weight > 0).length} copied</span>}>
        <p className="text-sm text-muted-foreground">
          Its share of the copy budget{data?.budgetSol ? ` (${data.budgetSol} SOL)` : ""} follows its profit in dollars over 7 and 30 days, scaled by how often it wins. A losing week drops it to zero at once;
          if copying it loses GodsEye money over 14 days, it&apos;s dropped.
        </p>
        <div className="mt-2">
          {leaders.length === 0 && <Empty img="wallet">No wallet is earning enough to copy yet.</Empty>}
          {leaders.map((l) => (
            <Link key={l.address} href={`/wallets/${l.address}`} className={cn("line flex-wrap transition-colors hover:text-accent sm:flex-nowrap", l.copy_weight === 0 && "opacity-60")}>
              <WalletDot address={l.address} tier={l.tier} />
              <div className="min-w-0 flex-1 basis-56">
                <p className="flex flex-wrap items-center gap-2">
                  <span className="font-mono">{shortAddr(l.address)}</span>
                  <TierBadge tier={l.tier} />
                  <KindBadge kind={l.kind} score={null} />
                </p>
                <p className="mt-0.5 truncate text-xs text-muted-foreground" title={l.weight_reason ?? ""}>{l.weight_reason ?? `active ${ago(l.last_activity_at)}`}</p>
              </div>
              <div className="flex items-center gap-5">
                <div className="text-right">
                  <p className="k">Wins</p>
                  <p className="text-lg font-extrabold num">{pc(l.win_rate_30d)}</p>
                </div>
                <div className="text-right">
                  <p className="k">Its week</p>
                  <p className={cn("text-lg font-extrabold num", pnlClass(l.pnl_7d_usd))}>{signedUsd(l.pnl_7d_usd)}</p>
                </div>
                <div className="text-right" title={`${signedSol(l.copy_pnl_sol, 3)} SOL over ${l.copy_closed} copies`}>
                  <p className="k">Copying it</p>
                  <p className={cn("text-lg font-extrabold num", pnlClass(l.copy_pnl_usd))}>{signedUsd(l.copy_pnl_usd)}</p>
                </div>
                <div className="w-20 text-right">
                  <p className="k">Budget</p>
                  <p className="text-2xl font-extrabold num">{(l.copy_weight * 100).toFixed(0)}%</p>
                </div>
              </div>
            </Link>
          ))}
        </div>
      </Window>

      <Window title="Recent changes">
        {(data?.changes ?? []).length === 0 && <p className="py-3 text-sm text-muted-foreground">No changes yet.</p>}
        {(data?.changes ?? []).slice(0, 15).map((c) => (
          <div key={c.id} className="line flex-wrap text-sm sm:flex-nowrap">
            <Link href={`/wallets/${c.wallet}`} className="font-mono hover:text-accent">{shortAddr(c.wallet)}</Link>
            <span className="num">
              {(c.old_weight * 100).toFixed(0)}% → <b className={c.new_weight > c.old_weight ? "text-accent" : "text-loss"}>{(c.new_weight * 100).toFixed(0)}%</b>
            </span>
            <span className="min-w-0 flex-1 truncate text-muted-foreground" title={c.reason}>{c.reason}</span>
            <span className="shrink-0 text-xs text-muted-foreground">{ago(c.ts)}</span>
          </div>
        ))}
      </Window>
    </>
  );
}
