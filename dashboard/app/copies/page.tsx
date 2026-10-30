"use client";
import { useState } from "react";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { COPYING_LINKS, SubNav } from "@/components/nav";
import { TopAlert } from "@/components/alert";
import { Empty, Window } from "@/components/window";
import { Stat, Stats } from "@/components/stat";
import { RugChecks } from "@/components/rug-checks";
import { TierBadge, TokenLink, WalletDot, WalletLink, WalletPageLink } from "@/components/wallet-badges";
import { usePoll } from "@/lib/use-poll";
import { ago, COPY_STATUS_LABEL as STATUS_LABEL, COPY_STATUS_STYLE as STATUS, dollars, pct, pnlClass, signedSol, signedUsd, solscanTx, weekLabel, winRateLabel } from "@/lib/format";
import { DataState } from "@/components/data-state";
import type { CopiesData, LeadersData, Summary } from "@/lib/types";
import { cn } from "@/lib/utils";


export default function CopiesPage() {
  const { data, error, stale, updatedAt } = usePoll<CopiesData>("/api/copies", 10_000);
  const { data: s } = usePoll<Summary>("/api/summary", 10_000);
  const { data: leaders } = usePoll<LeadersData>("/api/leaders", 30_000);
  const [allTrades, setAllTrades] = useState(false);
  const open = data?.open ?? [];
  const closed = data?.closed ?? [];
  const trades = data?.trades ?? [];
  const copying = (leaders?.leaders ?? []).filter((l) => l.copy_weight > 0);
  const bar = leaders?.followBar?.value ?? null;

  return (
    <>
      <PageHeader title="Copying" kicker={copying.length ? `GodsEye is ready to copy ${copying.length} wallet${copying.length === 1 ? "" : "s"}. ${open.length ? `${open.length} trade${open.length === 1 ? "" : "s"} open.` : "Nothing open yet."}` : "Waiting for a wallet with a real track record."}>
        <SubNav links={COPYING_LINKS} />
      </PageHeader>

      <DataState error={error} stale={stale} updatedAt={updatedAt} what="copy trades" />

      <Stats>
        <Stat
          tile="bg-lime"
          label={`Realized profit${s?.copyMode === "paper" ? " (paper)" : ""}`}
          value={signedUsd(s?.realizedPnlUsd ?? null)}
          sub={s ? `all time${s.feesUnrecorded ? `, fees not recorded on ${s.feesUnrecorded}` : ", after fees"} · ${s.wins} won · ${s.losses} lost · today (UTC) ${signedUsd(s.todayPnlUsd)}` : undefined}
        />
        <Stat tile="bg-coral" label="Open trades" value={s?.openPositions ?? "—"} unit={s ? (s.maxPositions > 0 ? `of ${s.maxPositions}` : "budget-limited") : undefined} sub={s?.openPositions ? (s.unrealizedPnlUsd != null ? `${signedUsd(s.unrealizedPnlUsd)} unrealized` : "value unknown") : undefined} />
        {s?.copyMode === "paper" ? (
          <Stat tile="bg-sun" label="Paper trading" value="No real SOL" sub="Fills are simulated with live quotes" />
        ) : (
          <Stat tile="bg-sun" label="Wallet balance" value={s?.wallet.balanceSol == null ? "—" : s.wallet.balanceSol.toFixed(s.wallet.balanceSol < 1 ? 3 : 2)} unit="SOL" sub={s?.wallet.checkedAt ? `${s.wallet.balanceSol != null && s.solUsd ? `≈ $${(s.wallet.balanceSol * s.solUsd).toFixed(2)} · ` : ""}checked ${ago(s.wallet.checkedAt)}` : s && !s.wallet.pubkey ? "hidden on the public site" : "not checked yet"} />
        )}
        <Stat tile="bg-lilac" label="Follow bar" value={bar === null ? "50" : Math.round(bar * 100)} unit="% wins" sub={bar === null ? "Default: not learned yet" : "Moves on its own as copies win or lose"} />
      </Stats>

      <TopAlert s={s} />

      <section className="grid gap-5 lg:grid-cols-2">
        <Window title="Open trades" right={open.length > 0 && <span className="text-muted-foreground num">{signedUsd(s?.unrealizedPnlUsd ?? null)}</span>}>
          {open.length === 0 && (
            <Empty img="wallet" title="No open trades">
              When a wallet below buys a memecoin, GodsEye buys a small copy and shows it here.
            </Empty>
          )}
          {open.map((p) => (
            <div key={p.id} className="line">
              <span className="dot bg-lilac font-black" aria-hidden>{(p.symbol ?? p.mint).slice(0, 1).toUpperCase()}</span>
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold">
                  <TokenLink mint={p.mint} symbol={p.symbol} />
                </p>
                <p className="k">
                  {dollars(p.cost_usd)} in · copied from <WalletLink address={p.leader} /> · {ago(p.opened_at)}
                </p>
              </div>
              <div className="text-right">
                <p className={cn("text-2xl font-extrabold num", pnlClass(p.unrealized_pct))}>{pct(p.unrealized_pct ?? null, 1)}</p>
                <p className="k num">{p.unrealized_usd != null ? signedUsd(p.unrealized_usd) : `${signedSol(p.unrealized_sol ?? null, 3)} SOL`}</p>
              </div>
            </div>
          ))}
        </Window>

        <Window title="Who it copies" right={<Link href="/leaders" className="pill">Details</Link>}>
          {copying.length === 0 && <Empty>Nobody yet. A wallet qualifies with a real track record and a win rate above the follow bar.</Empty>}
          {copying.slice(0, 6).map((l) => (
            <div key={l.address} className="line">
              <WalletDot address={l.address} tier={l.tier} />
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2">
                  <WalletLink address={l.address} />
                  <TierBadge tier={l.tier} />
                </p>
                <p className="k mt-0.5">{winRateLabel(l.win_rate_30d, l.closed_30d)} (30d) · {signedUsd(l.pnl_7d_usd)} {weekLabel(l.history_from) === "7d" ? "this week" : weekLabel(l.history_from)}</p>
              </div>
              <div className="w-28 sm:w-40">
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">Budget</span>
                  <span className="font-semibold num">{(l.copy_weight * 100).toFixed(0)}%</span>
                </div>
                <div className="mt-1.5 h-3 overflow-hidden rounded-[6px] border-2 border-ink bg-chip" aria-hidden>
                  <div className="h-full bg-lime" style={{ width: `${Math.min(100, l.copy_weight * 100)}%` }} />
                </div>
              </div>
              <WalletPageLink address={l.address} />
            </div>
          ))}
        </Window>
      </section>

      <Window
        title="What it decided"
        right={trades.length > 8 && <button type="button" className="pill" onClick={() => setAllTrades((v) => !v)}>{allTrades ? "Show fewer" : `Show all ${trades.length}`}</button>}
      >
        <p className="text-sm text-muted-foreground">Every buy or sell GodsEye considered, and why it went ahead or didn&apos;t.</p>
        <div className="mt-2">
          {trades.length === 0 && <p className="py-3 text-sm text-muted-foreground">No decisions yet.</p>}
          {(allTrades ? trades : trades.slice(0, 8)).map((c) => (
            <div key={c.id} className="line flex-wrap sm:flex-nowrap">
              <span className={cn("tag w-[74px] justify-center", STATUS[c.status])}>{STATUS_LABEL[c.status] ?? c.status}</span>
              <p className="min-w-0 flex-1 text-sm">
                <span className="font-semibold">
                  {c.side === "buy" ? "Buy" : "Sell"} <TokenLink mint={c.mint} symbol={c.symbol} />
                </span>
                {c.size_sol != null && <span className="text-muted-foreground"> · {c.size_sol.toFixed(3)} SOL</span>}
                <span className={cn("block truncate text-xs", c.error ? "text-loss" : "text-muted-foreground")} title={c.error ?? c.reason ?? ""}>
                  {c.error ?? c.reason ?? (
                    <>
                      copying <WalletLink address={c.leader} />
                    </>
                  )}
                </span>
              </p>
              {c.signature ? (
                <a href={solscanTx(c.signature)} target="_blank" rel="noreferrer" className="shrink-0 text-xs text-accent underline underline-offset-2">{ago(c.created_at)}</a>
              ) : (
                <span className="shrink-0 text-xs text-muted-foreground">{ago(c.created_at)}</span>
              )}
            </div>
          ))}
        </div>
      </Window>

      <Window title="Closed trades" right={closed.length > 0 && <Link href="/performance" className="pill">Results</Link>}>
        {closed.length === 0 && <p className="py-3 text-sm text-muted-foreground">Nothing closed yet.</p>}
        {closed.slice(0, 12).map((p) => (
          <div key={p.id} className="line">
            <span className={cn("dot font-semibold", (p.pnl_usd ?? p.pnl_sol ?? 0) >= 0 ? "bg-lime" : "bg-coral")} aria-hidden>{(p.symbol ?? p.mint).slice(0, 1).toUpperCase()}</span>
            <div className="min-w-0 flex-1">
              <p className="truncate font-semibold">
                <TokenLink mint={p.mint} symbol={p.symbol} />
              </p>
              <p className="k">
                {dollars(p.cost_usd)} in · {dollars(p.proceeds_usd)} out{p.mode === "real" ? (p.fee_sol === null ? " · fees not recorded" : ` · ${p.fee_sol.toFixed(4)} SOL fees`) : ""} · {p.exit_reason} · {ago(p.closed_at)}
              </p>
            </div>
            <div className="text-right" title={`${signedSol(p.pnl_sol)} SOL`}>
              <p className={cn("text-2xl font-extrabold num", pnlClass(p.pnl_usd ?? p.pnl_sol))}>{p.pnl_usd != null ? signedUsd(p.pnl_usd) : `${signedSol(p.pnl_sol, 3)} SOL`}</p>
              <p className="k num">{pct(p.pnl_pct, 1)}</p>
            </div>
          </div>
        ))}
      </Window>

      <RugChecks />
    </>
  );
}
