"use client";
import { PageHeader } from "@/components/page-header";
import { COPYING_LINKS, SubNav } from "@/components/nav";
import { Window } from "@/components/window";
import { Addr, KindBadge, TierBadge } from "@/components/wallet-badges";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { usePoll } from "@/lib/use-poll";
import { ago, dt, pnlClass, signedSol, signedUsd } from "@/lib/format";
import type { LeadersData } from "@/lib/types";
import { cn } from "@/lib/utils";

export default function LeadersPage() {
  const { data } = usePoll<LeadersData>("/api/leaders", 30_000);
  const leaders = data?.leaders ?? [];
  return (
    <>
      <PageHeader title="Copying" kicker="who it copies · re-weighted every 15 min">
        <SubNav links={COPYING_LINKS} />
      </PageHeader>
      <p className="mb-3 text-xs text-muted-foreground">
        Only wallets with a track record are copied: Proven, or at least 10 closed trades in 30 days (never a Lucky streak), with a win rate at or above
        the follow bar below, which GodsEye learns from results. Weight follows each
        wallet&apos;s profit in USD (valued when each trade settled) over 7 days (60%) and 30 days (40%), scaled by win rate and number of trades. Losing this week → 0 at once.
        If copying a wallet loses GodsEye money over 14 days, it stops copying it. Top earners only; weights add up to the copy budget
        {data?.budgetSol ? ` (${data.budgetSol} SOL)` : ""}.
      </p>

      <Window
        title="Follow bar · learned, not fixed"
        className="mb-3"
        right={data?.followBar ? <span className="text-muted-foreground">updated {ago(data.followBar.updated_at)}</span> : null}
      >
        <div className="flex flex-col gap-2 p-3 text-xs sm:flex-row sm:items-start sm:gap-6">
          <div className="shrink-0">
            <p className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Min win rate to follow</p>
            <p className="font-pixel text-4xl leading-none text-win num">{data?.followBar ? `${Math.round(data.followBar.value * 100)}%` : "50%"}</p>
            {data?.followBar?.target != null && data.followBar.target !== data.followBar.value && (
              <p className="text-muted-foreground">heading to {Math.round(data.followBar.target * 100)}%</p>
            )}
          </div>
          <div className="min-w-0 flex-1 space-y-1">
            <p>{data?.followBar?.reason ?? "Not learned yet: starts at 50% and adjusts once copy trades (or shadow copies of smart buys) have measured results."}</p>
            <p className="text-muted-foreground">
              Every 15 minutes GodsEye looks at how following worked out (its copy trades, or until there are enough of those, what each smart-wallet buy did over 6 hours),
              grouped by the leader&apos;s win rate, and moves the bar toward the lowest level that still paid, at most 5 points at a time.
            </p>
            {(data?.followBarHistory ?? []).slice(0, 6).map((h) => (
              <p key={h.id} className="text-muted-foreground">
                <span className="num">{dt(h.ts)}</span> {Math.round(h.old_value * 100)}% → <span className={h.new_value > h.old_value ? "text-amber" : "text-win"}>{Math.round(h.new_value * 100)}%</span>
              </p>
            ))}
          </div>
        </div>
      </Window>

      <Window title={`Leaders · ${leaders.filter((l) => l.copy_weight > 0).length} copied`} className="mb-3">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Wallet</TableHead>
              <TableHead>Tier</TableHead>
              <TableHead>Kind</TableHead>
              <TableHead className="text-right">Weight</TableHead>
              <TableHead className="text-right">Its 7d</TableHead>
              <TableHead className="text-right">Its 30d</TableHead>
              <TableHead className="text-right">Wins</TableHead>
              <TableHead className="text-right">GodsEye&apos;s copy P&amp;L</TableHead>
              <TableHead>Active</TableHead>
              <TableHead>Why</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {leaders.length === 0 && (
              <TableRow>
                <TableCell colSpan={10} className="py-10 text-center text-muted-foreground">No wallet is earning enough to copy yet.</TableCell>
              </TableRow>
            )}
            {leaders.map((l) => (
              <TableRow key={l.address} className={l.copy_weight > 0 ? "" : "opacity-60"}>
                <TableCell><Addr address={l.address} /></TableCell>
                <TableCell><TierBadge tier={l.tier} /></TableCell>
                <TableCell><KindBadge kind={l.kind} score={null} /></TableCell>
                <TableCell className="text-right">
                  <div className="flex items-center justify-end gap-2">
                    <div className="h-2 w-16 bevel-in bg-black" aria-hidden>
                      <div className="h-full bg-win" style={{ width: `${Math.min(100, l.copy_weight * 100)}%` }} />
                    </div>
                    <span className="w-10 font-bold text-win">{(l.copy_weight * 100).toFixed(0)}%</span>
                  </div>
                </TableCell>
                <TableCell className={cn("text-right", pnlClass(l.pnl_7d_usd))}>{signedUsd(l.pnl_7d_usd)}</TableCell>
                <TableCell className={cn("text-right", pnlClass(l.pnl_30d_usd))}>{signedUsd(l.pnl_30d_usd)}</TableCell>
                <TableCell className="text-right">{l.win_rate_30d === null ? "—" : `${Math.round(l.win_rate_30d * 100)}%`}</TableCell>
                <TableCell className={cn("text-right font-bold", pnlClass(l.copy_pnl_usd))} title={`${signedSol(l.copy_pnl_sol, 3)} SOL`}>
                  {signedUsd(l.copy_pnl_usd)} <span className="font-normal text-muted-foreground">({l.copy_closed})</span>
                </TableCell>
                <TableCell className="text-muted-foreground">{ago(l.last_activity_at)}</TableCell>
                <TableCell className="max-w-[300px] truncate text-xs text-muted-foreground" title={l.weight_reason ?? ""}>{l.weight_reason}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Window>

      <Window title="Weight changes">
        <div className="divide-y text-xs">
          {(data?.changes ?? []).length === 0 && <p className="p-4 text-muted-foreground">No changes yet.</p>}
          {(data?.changes ?? []).map((c) => (
            <div key={c.id} className="flex flex-wrap items-center gap-2 px-3 py-1.5">
              <span className="text-muted-foreground">{dt(c.ts)}</span>
              <Addr address={c.wallet} />
              <span className="num">
                {(c.old_weight * 100).toFixed(0)}% → <span className={c.new_weight > c.old_weight ? "text-win" : "text-loss"}>{(c.new_weight * 100).toFixed(0)}%</span>
              </span>
              <span className="text-muted-foreground">{c.reason}</span>
            </div>
          ))}
        </div>
      </Window>
    </>
  );
}
