"use client";
import Link from "next/link";
import { ArrowUpRight, TrendingDown, TrendingUp } from "lucide-react";
import { TIERS, TIER_DESCRIPTIONS, TIER_LABELS } from "@godseye/shared/constants";
import { TopAlert } from "@/components/alert";
import { Logo } from "@/components/logo";
import { Empty } from "@/components/window";
import { Stat, Stats } from "@/components/stat";
import { TerminalFeed } from "@/components/terminal-feed";
import { TierBadge, WalletDot } from "@/components/wallet-badges";
import { usePoll } from "@/lib/use-poll";
import { ago, pct, pnlClass, shortAddr, signedUsd } from "@/lib/format";
import type { CopiesData, LeadersData, SmartMoneyData, Summary } from "@/lib/types";
import { cn } from "@/lib/utils";

export default function Home() {
  const { data: s, error } = usePoll<Summary>("/api/summary", 10_000);
  const { data: leaders } = usePoll<LeadersData>("/api/leaders", 30_000);
  const { data: copies } = usePoll<CopiesData>("/api/copies", 10_000);
  const { data: smart } = usePoll<SmartMoneyData>("/api/smart", 15_000);
  const flows = (smart?.flows ?? []).slice(0, 5);
  const signals = (smart?.signals ?? []).slice(0, 4);
  const copying = (leaders?.leaders ?? []).filter((l) => l.copy_weight > 0).slice(0, 5);
  const open = copies?.open ?? [];
  const seen = s?.stream.walletsSeen24h ?? 0;
  const bar = leaders?.followBar?.value ?? smart?.followBar?.value ?? null;
  const money = s?.realizedPnlUsd ?? null;
  const [whole, cents] = money === null ? ["—", ""] : (() => {
    const t = signedUsd(money);
    const i = t.lastIndexOf(".");
    return i === -1 ? [t, ""] : [t.slice(0, i), t.slice(i)];
  })();

  return (
    <>
      {error && !s && <p className="card text-sm text-loss" role="alert">No data yet: {error}</p>}

      <section className="flex flex-wrap items-center gap-x-6 gap-y-5">
        <div className="flex min-w-0 flex-1 basis-[340px] items-center gap-4 rounded-[28px] pr-4">
          <span className="hidden sm:block">
            <Logo size={112} />
          </span>
          <span className="sm:hidden">
            <Logo size={84} />
          </span>
          <div className="min-w-0">
            <p className="k">{s?.live ? "Watching live" : "Not running"} · {s?.copyMode === "real" ? "real money" : "paper trading"}</p>
            <p className="mt-1 text-lg font-medium leading-snug sm:text-xl">
              {seen > 0 ? `Watching ${seen.toLocaleString("en-US")} wallets.` : "Watching every memecoin trade on Solana."} Copying the ones that keep winning.
            </p>
          </div>
        </div>
        <Stats className="flex-[2] basis-[520px]">
          <Stat label="Your profit" value={whole} unit={cents || undefined} valueClass={pnlClass(money)} sub={s ? `${s.wins} won · ${s.losses} lost` : undefined} />
          <Stat label="Copying" value={s?.leaders ?? "—"} unit="wallets" sub={s ? `${s.openPositions} of ${s.maxPositions} trades open` : undefined} />
          <Stat label="Smart money" value={smart?.activeWallets ?? "—"} unit="wallets" sub={smart ? `${smart.trades24h.toLocaleString("en-US")} trades today` : undefined} />
          <Stat label="Follow bar" value={bar === null ? "50" : Math.round(bar * 100)} unit="% wins" sub="Learned from results" />
        </Stats>
      </section>

      <TopAlert s={s} />

      <section className="grid gap-5 lg:grid-cols-2">
        <div className="card">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-[22px] font-medium tracking-[-0.02em]">Where smart money is moving</h2>
            <Link href="/leaders" className="dot bg-white hover:bg-lilac" aria-label="What GodsEye learned from smart money">
              <ArrowUpRight size={18} strokeWidth={1.8} aria-hidden />
            </Link>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">Net buying by wallets that keep winning, last 24 hours.</p>
          <div className="mt-3">
            {flows.length === 0 && <Empty>Nothing yet. Coins show up here as smart wallets trade them.</Empty>}
            {flows.map((f) => {
              const net = f.buy_usd_24h - f.sell_usd_24h;
              const up = net >= 0;
              return (
                <a key={f.mint} href={`https://dexscreener.com/solana/${f.mint}`} target="_blank" rel="noreferrer" className="line transition-colors hover:text-violet-deep">
                  <span className={cn("dot font-semibold", up ? "bg-lilac" : "bg-chip")} aria-hidden>
                    {(f.symbol ?? f.mint).slice(0, 1).toUpperCase()}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-semibold">{f.symbol ?? shortAddr(f.mint)}</p>
                    <p className="k">
                      {f.buyers_24h} buying · {f.sellers_24h} selling
                      {f.change_since_first_buy !== null && <> · {pct(f.change_since_first_buy, 0)} since first buy</>}
                    </p>
                  </div>
                  <p className={cn("flex items-center gap-1.5 text-2xl font-light num", up ? "text-ink" : "text-loss")}>
                    {signedUsd(net)}
                    {up ? <TrendingUp size={16} className="text-violet-deep" aria-label="net buying" /> : <TrendingDown size={16} aria-label="net selling" />}
                  </p>
                </a>
              );
            })}
          </div>
        </div>

        <div className="card flex flex-col">
          <h2 className="text-[22px] font-medium tracking-[-0.02em]">Signals</h2>
          <div className="mt-2 flex-1">
            {signals.length === 0 ? (
              <Empty img="radar" title="Quiet for now">
                A signal appears when 3 or more smart wallets buy, or dump, the same coin within an hour.
              </Empty>
            ) : (
              signals.map((g) => {
                const r = g.ret_6h ?? g.ret_1h;
                return (
                  <div key={g.id} className="line">
                    <span className={cn("dot", g.kind === "accumulate" ? "bg-lilac" : "bg-chip")} aria-hidden>
                      {g.kind === "accumulate" ? <TrendingUp size={18} /> : <TrendingDown size={18} />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-semibold">
                        {g.wallet_count} smart wallets {g.kind === "accumulate" ? "bought" : "dumped"} {g.symbol ?? shortAddr(g.mint)}
                      </p>
                      <p className="k">{ago(g.ts)}</p>
                    </div>
                    <p className={cn("text-right text-xl font-light num", pnlClass(r))}>
                      {r === null ? <span className="text-sm text-muted-foreground">measuring</span> : <>{pct(r, 0)}<span className="unit">{g.ret_6h !== null ? "6h" : "1h"}</span></>}
                    </p>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </section>

      <section className="grid gap-5 lg:grid-cols-2">
        <div className="card">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-[22px] font-medium tracking-[-0.02em]">Who it copies</h2>
            <Link href="/leaders" className="pill">See all</Link>
          </div>
          <div className="mt-3">
            {copying.length === 0 && <Empty>Nobody yet. A wallet qualifies once it has a real track record and keeps winning.</Empty>}
            {copying.map((l) => (
              <Link key={l.address} href={`/wallets/${l.address}`} className="line transition-colors hover:text-violet-deep">
                <WalletDot address={l.address} tier={l.tier} />
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2">
                    <span className="font-mono">{shortAddr(l.address)}</span>
                    <TierBadge tier={l.tier} />
                  </p>
                  <p className="k mt-0.5">{(l.copy_weight * 100).toFixed(0)}% of the copy budget</p>
                </div>
                <p className={cn("text-right text-2xl font-light num", pnlClass(l.pnl_7d_usd))}>
                  {signedUsd(l.pnl_7d_usd)}
                  <span className="unit">7d</span>
                </p>
              </Link>
            ))}
          </div>
        </div>

        <div className="card">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-[22px] font-medium tracking-[-0.02em]">Open trades</h2>
            <Link href="/copies" className="pill">See all</Link>
          </div>
          <div className="mt-2">
            {open.length === 0 && (
              <Empty img="wallet" title="None open">
                When a wallet GodsEye copies buys a memecoin, a small copy shows up here.
              </Empty>
            )}
            {open.slice(0, 5).map((p) => (
              <div key={p.id} className="line">
                <span className="dot bg-lilac font-semibold" aria-hidden>{(p.symbol ?? p.mint).slice(0, 1).toUpperCase()}</span>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold">{p.symbol ?? shortAddr(p.mint)}</p>
                  <p className="k">opened {ago(p.opened_at)}</p>
                </div>
                <p className={cn("text-2xl font-light num", pnlClass(p.unrealized_pct))}>{pct(p.unrealized_pct ?? null, 1)}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="card">
        <h2 className="text-[22px] font-medium tracking-[-0.02em]">Every wallet, sorted</h2>
        <p className="mt-1 text-sm text-muted-foreground">GodsEye studies each wallet it sees trading and gives it a label. Tap one to see those wallets.</p>
        <div className="mt-4 flex flex-wrap gap-2">
          {TIERS.map((t) => (
            <Link key={t} href={`/wallets?tier=${t}`} title={TIER_DESCRIPTIONS[t]} className="pill gap-2.5 bg-white pl-2 hover:bg-lilac">
              <TierBadge tier={t} className="pointer-events-none" />
              <span className="sr-only">{TIER_LABELS[t]}</span>
              <span className="text-base num">{s?.tierCounts[t] ?? "—"}</span>
            </Link>
          ))}
          <Link href="/wallets?kind=ai" className="pill bg-white hover:bg-lilac">Bots <span className="text-base num">{s?.kindCounts.ai ?? "—"}</span></Link>
          <Link href="/wallets?kind=human" className="pill bg-white hover:bg-lilac">Humans <span className="text-base num">{s?.kindCounts.human ?? "—"}</span></Link>
        </div>
      </section>

      <TerminalFeed limit={8} />
    </>
  );
}
