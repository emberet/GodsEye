"use client";
import Link from "next/link";
import { ArrowRight, TrendingDown, TrendingUp } from "lucide-react";
import { TIERS, TIER_DESCRIPTIONS, TIER_LABELS } from "@godseye/shared/constants";
import { TopAlert } from "@/components/alert";
import { Empty } from "@/components/window";
import { Stat } from "@/components/stat";
import { TerminalFeed } from "@/components/terminal-feed";
import { TIER_STYLE, TokenLink, WalletDot, WalletLink, WalletPageLink } from "@/components/wallet-badges";
import { usePoll } from "@/lib/use-poll";
import { ago, dexscreenerToken, pct, pnlClass, shortAddr, signedUsd, streamStatusLabel, weekLabel } from "@/lib/format";
import { DataState } from "@/components/data-state";
import type { CopiesData, LeadersData, SmartMoneyData, Summary } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Card with a title and a "see all" link: every Home panel uses it. */
function Panel({ title, href, children, className }: { title: string; href?: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn("card flex min-w-0 flex-col", className)}>
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-xl font-extrabold tracking-[-0.02em]">{title}</h2>
        {href && (
          <Link href={href} className="dot h-9 w-9 bg-cream shadow-hard-sm" aria-label={`See all: ${title}`}>
            <ArrowRight size={17} strokeWidth={2.6} aria-hidden />
          </Link>
        )}
      </div>
      <div className="mt-2 flex-1">{children}</div>
    </section>
  );
}

export default function Home() {
  const { data: s, error, stale, updatedAt } = usePoll<Summary>("/api/summary", 10_000);
  const { data: leaders } = usePoll<LeadersData>("/api/leaders", 30_000);
  const { data: copies } = usePoll<CopiesData>("/api/copies", 10_000);
  const { data: smart } = usePoll<SmartMoneyData>("/api/smart", 15_000);
  const flows = (smart?.flows ?? []).slice(0, 5);
  const signals = (smart?.signals ?? []).slice(0, 3);
  const copying = (leaders?.leaders ?? []).filter((l) => l.copy_weight > 0).slice(0, 4);
  const open = copies?.open ?? [];
  const st = s?.stream;
  const bar = leaders?.followBar?.value ?? smart?.followBar?.value ?? null;
  // Unknown if any open trade can't be valued in USD (never shown as $0).
  const openPnl = s?.unrealizedPnlUsd ?? null;

  return (
    <>
      <DataState error={error} stale={stale} updatedAt={updatedAt} what="GodsEye's status" />

      {/* At a glance: one sentence, then the four numbers that matter. */}
      <section className="card flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between lg:gap-6 lg:py-5">
        <div className="min-w-0">
          <p className="k">Right now</p>
          <p className="mt-1 text-2xl font-extrabold leading-tight tracking-[-0.02em] lg:text-[26px]">
            {st?.walletsSeen24h
              ? `${s?.live ? "Watching" : "Offline. Last watched"} ${st.walletsSeen24h.toLocaleString("en-US")} wallets and copying the ones that keep winning.`
              : `${s?.live ? "Studying" : "Offline. Last studied"} ${s?.walletsTracked ? s.walletsTracked.toLocaleString("en-US") : "every"} wallets and copying the ones that keep winning.`}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2 lg:justify-end">
          <span className="tag min-h-[30px] px-2.5">
            <span className={cn("h-2.5 w-2.5 rounded-full border-2 border-ink", st?.healthy ? "animate-pulsedot bg-lime" : "bg-coral")} aria-hidden />
            {st?.healthy ? `${st.swapsPerSec ?? "—"} trades/sec` : !st?.enabled ? "stream off" : !s?.live ? "stream offline" : st.status === "connected" ? "stream quiet" : streamStatusLabel(st.status).toLowerCase()}
          </span>
          <span className="tag min-h-[30px] px-2.5">{bar === null ? "Follow bar: default 50% wins" : `Follow bar ${Math.round(bar * 100)}% wins`}</span>
          <span className="tag min-h-[30px] px-2.5">{s?.walletsTracked.toLocaleString("en-US") ?? "—"} studied</span>
        </div>
      </section>

      <section className="grid grid-cols-2 gap-4 lg:grid-cols-4 lg:gap-5">
        <Stat
          tile="bg-lime"
          label={`Realized profit${s?.copyMode === "paper" ? " (paper)" : ""}`}
          value={signedUsd(s?.realizedPnlUsd ?? null)}
          sub={s ? `all time, ${s.feesUnrecorded ? `fees not recorded on ${s.feesUnrecorded}` : "after fees"} · ${s.wins} won · ${s.losses} lost` : undefined}
        />
        <Stat tile="bg-lilac" label="Copying" value={s?.leaders ?? "—"} unit="wallets" sub="with a real track record" />
        <Stat tile="bg-sun" label="Smart money" value={smart?.activeWallets ?? "—"} unit="wallets" sub={smart ? `${smart.trades24h.toLocaleString("en-US")} trades, last 24h` : undefined} />
        <Stat tile="bg-coral" label="Open trades" value={s?.openPositions ?? "—"} unit={s ? `of ${s.maxPositions}` : undefined} sub={open.length ? `${signedUsd(openPnl)} unrealized` : "none open"} />
      </section>

      <TopAlert s={s} />

      <section className="grid gap-5 lg:grid-cols-12">
        <Panel title="Who it copies" href="/leaders" className="lg:col-span-5">
          {copying.length === 0 && <Empty>Nobody yet. A wallet qualifies with a real track record and a win rate above the follow bar.</Empty>}
          {copying.map((l) => (
            <div key={l.address} className="line">
              <WalletDot address={l.address} tier={l.tier} className="h-10 w-10" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">
                  <WalletLink address={l.address} />
                </p>
                <p className="k truncate">{(l.copy_weight * 100).toFixed(0)}% of budget · {l.win_rate_30d === null ? "no closed trades" : `${Math.round(l.win_rate_30d * 100)}% of ${l.closed_30d ?? 0} won (30d)`}</p>
              </div>
              <div className="shrink-0 text-right">
                <p className={cn("whitespace-nowrap text-lg font-extrabold leading-tight num", pnlClass(l.pnl_7d_usd))}>{signedUsd(l.pnl_7d_usd)}</p>
                <p className="k whitespace-nowrap">{weekLabel(l.history_from)}</p>
              </div>
              <WalletPageLink address={l.address} />
            </div>
          ))}
          {open.length > 0 && (
            <Link href="/copies" className="mt-3 flex items-center justify-between rounded-[14px] border-[2.5px] border-ink bg-panel px-3 py-2.5 text-sm font-bold hover:text-accent">
              {open.length} open trade{open.length === 1 ? "" : "s"}
              <span className={cn("num", pnlClass(openPnl))}>{signedUsd(openPnl)}</span>
            </Link>
          )}
        </Panel>
        <Panel title="Smart money flows · net 24h" href="/leaders" className="lg:col-span-4">
          {flows.length === 0 && <Empty>Nothing yet. Coins appear here as winning wallets trade them.</Empty>}
          {flows.map((f) => {
            const net = f.buy_usd_24h - f.sell_usd_24h;
            const up = net >= 0;
            return (
              <a key={f.mint} href={dexscreenerToken(f.mint)} target="_blank" rel="noreferrer" className="line hover:text-accent" aria-label={`${f.symbol ?? shortAddr(f.mint)} on DexScreener (opens in a new tab)`}>
                <span className={cn("dot h-10 w-10 font-black", up ? "bg-lime" : "bg-coral")} aria-hidden>
                  {up ? <TrendingUp size={18} strokeWidth={2.6} /> : <TrendingDown size={18} strokeWidth={2.6} />}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-extrabold">{f.symbol ?? shortAddr(f.mint)}</p>
                  <p className="k">
                    {f.buyers_24h} buying · {f.sellers_24h} selling
                    {f.traders ? ` · ${f.traders}${f.traders >= 64 ? "+" : ""} traders` : f.organic === "unverified" ? " · not verified yet" : ""}
                  </p>
                </div>
                <p className={cn("text-lg font-extrabold num", up ? "text-lime" : "text-coral")}>{signedUsd(net)}</p>
              </a>
            );
          })}
        </Panel>
        <Panel title="Signals" href="/leaders" className="lg:col-span-3">
          {signals.length === 0 ? (
            <Empty img="radar" title="Quiet">A signal fires when 3+ smart wallets buy, or dump, the same coin within an hour.</Empty>
          ) : (
            signals.map((g) => {
              const r = g.ret_6h ?? g.ret_1h;
              return (
                <div key={g.id} className="line">
                  <span className={cn("dot h-10 w-10", g.kind === "accumulate" ? "bg-lime" : "bg-coral")} aria-hidden>
                    {g.kind === "accumulate" ? <TrendingUp size={18} strokeWidth={2.6} /> : <TrendingDown size={18} strokeWidth={2.6} />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-extrabold">
                      <TokenLink mint={g.mint} symbol={g.symbol} />
                    </p>
                    <p className="k">{g.wallet_count} wallets {g.kind === "accumulate" ? "bought" : "dumped"} · {ago(g.ts)}</p>
                  </div>
                  <p className={cn("text-lg font-extrabold num", pnlClass(r))}>{r === null ? <span className="text-sm text-muted-foreground">measuring</span> : <>{pct(r, 0)}<span className="ml-1 text-xs font-bold text-muted-foreground">{g.ret_6h !== null ? "6h" : "1h"}</span></>}</p>
                </div>
              );
            })
          )}
          <div className="mt-3 border-t-2 border-ink/70 pt-3">
            <p className="k">Every wallet, sorted</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {TIERS.filter((t) => (s?.tierCounts[t] ?? 0) > 0).map((t) => (
                <Link key={t} href={`/wallets?tier=${t}`} title={TIER_DESCRIPTIONS[t]} className={cn("tag min-h-[30px] px-2.5 shadow-hard-sm hover:-translate-y-px", TIER_STYLE[t])}>
                  {TIER_LABELS[t]} <span className="num">{s?.tierCounts[t]}</span>
                </Link>
              ))}
            </div>
          </div>
        </Panel>
      </section>

      <TerminalFeed limit={5} />
    </>
  );
}
