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
import { ago, pct, pnlClass, shortAddr, signedUsd, weekLabel } from "@/lib/format";
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
  const { data: s, error } = usePoll<Summary>("/api/summary", 10_000);
  const { data: leaders } = usePoll<LeadersData>("/api/leaders", 30_000);
  const { data: copies } = usePoll<CopiesData>("/api/copies", 10_000);
  const { data: smart } = usePoll<SmartMoneyData>("/api/smart", 15_000);
  const flows = (smart?.flows ?? []).slice(0, 5);
  const signals = (smart?.signals ?? []).slice(0, 3);
  const copying = (leaders?.leaders ?? []).filter((l) => l.copy_weight > 0).slice(0, 4);
  const open = copies?.open ?? [];
  const st = s?.stream;
  const bar = leaders?.followBar?.value ?? smart?.followBar?.value ?? null;
  const openPnl = open.reduce((t, p) => t + (p.unrealized_usd ?? 0), 0);

  return (
    <>
      {error && !s && <p className="card text-sm font-bold text-coral" role="alert">No data yet: {error}</p>}

      {/* At a glance: one sentence, then the four numbers that matter. */}
      <section className="grid gap-4 lg:grid-cols-[1fr_2fr]">
        <div className="card flex flex-col justify-between gap-4">
          <div>
            <p className="k">Right now</p>
            <p className="mt-1.5 text-2xl font-extrabold leading-tight tracking-[-0.02em]">
              {st?.walletsSeen24h
                ? `${s?.live ? "Watching" : "Paused on"} ${st.walletsSeen24h.toLocaleString("en-US")} wallets and copying the ones that keep winning.`
                : `${s?.live ? "Studying" : "Paused on"} ${s?.walletsTracked ? s.walletsTracked.toLocaleString("en-US") : "every"} wallets and copying the ones that keep winning.`}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <span className="tag min-h-[30px] px-2.5">
              <span className={cn("h-2.5 w-2.5 rounded-full border-2 border-ink", st?.status === "connected" ? "animate-pulsedot bg-lime" : "bg-coral")} aria-hidden />
              {st?.status === "connected" ? `${st.swapsPerSec ?? "—"} trades/sec` : st?.enabled ? st.status ?? "starting" : "stream off"}
            </span>
            <span className="tag min-h-[30px] px-2.5">Follow bar {bar === null ? 50 : Math.round(bar * 100)}% wins</span>
            <span className="tag min-h-[30px] px-2.5">{s?.walletsTracked.toLocaleString("en-US") ?? "—"} studied</span>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <Stat tile="bg-lime" label="Your profit" value={signedUsd(s?.realizedPnlUsd ?? null)} sub={s ? `${s.wins} won · ${s.losses} lost` : undefined} />
          <Stat tile="bg-lilac" label="Copying" value={s?.leaders ?? "—"} unit="wallets" sub="with a real track record" />
          <Stat tile="bg-sun" label="Smart money" value={smart?.activeWallets ?? "—"} unit="wallets" sub={smart ? `${smart.trades24h.toLocaleString("en-US")} trades today` : undefined} />
          <Stat tile="bg-coral" label="Open trades" value={s?.openPositions ?? "—"} unit={s ? `of ${s.maxPositions}` : undefined} sub={open.length ? `${signedUsd(openPnl)} unsold` : "none open"} />
        </div>
      </section>

      <TopAlert s={s} />

      <section className="grid gap-5 lg:grid-cols-3">
        <Panel title="Smart money is buying" href="/leaders">
          {flows.length === 0 && <Empty>Nothing yet. Coins appear here as winning wallets trade them.</Empty>}
          {flows.map((f) => {
            const net = f.buy_usd_24h - f.sell_usd_24h;
            const up = net >= 0;
            return (
              <a key={f.mint} href={`https://dexscreener.com/solana/${f.mint}`} target="_blank" rel="noreferrer" className="line hover:text-accent">
                <span className={cn("dot h-10 w-10 font-black", up ? "bg-lime" : "bg-coral")} aria-hidden>
                  {up ? <TrendingUp size={18} strokeWidth={2.6} /> : <TrendingDown size={18} strokeWidth={2.6} />}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-extrabold">{f.symbol ?? shortAddr(f.mint)}</p>
                  <p className="k">{f.buyers_24h} buying · {f.sellers_24h} selling</p>
                </div>
                <p className={cn("text-lg font-extrabold num", up ? "text-lime" : "text-coral")}>{signedUsd(net)}</p>
              </a>
            );
          })}
        </Panel>

        <Panel title="Who it copies" href="/leaders">
          {copying.length === 0 && <Empty>Nobody yet. A wallet qualifies with a real track record and a win rate above the follow bar.</Empty>}
          {copying.map((l) => (
            <div key={l.address} className="line">
              <WalletDot address={l.address} tier={l.tier} className="h-10 w-10" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">
                  <WalletLink address={l.address} />
                </p>
                <p className="k">{(l.copy_weight * 100).toFixed(0)}% of budget · {l.win_rate_30d === null ? "—" : `${Math.round(l.win_rate_30d * 100)}% won`}</p>
              </div>
              <p className={cn("text-lg font-extrabold num", pnlClass(l.pnl_7d_usd))}>
                {signedUsd(l.pnl_7d_usd)}
                <span className="unit">{weekLabel(l.history_from)}</span>
              </p>
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

        <Panel title="Signals" href="/leaders">
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
                  <p className={cn("text-lg font-extrabold num", pnlClass(r))}>{r === null ? <span className="text-sm text-muted-foreground">measuring</span> : pct(r, 0)}</p>
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
