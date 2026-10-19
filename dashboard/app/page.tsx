"use client";
import Link from "next/link";
import { TIERS, TIER_DESCRIPTIONS } from "@godseye/shared/constants";
import { StatusBadge } from "@/components/status-badge";
import { Window } from "@/components/window";
import { Stat } from "@/components/stat";
import { TerminalFeed } from "@/components/terminal-feed";
import { Addr, KindBadge, TierBadge } from "@/components/wallet-badges";
import { usePoll } from "@/lib/use-poll";
import { ago, pct, pnlClass, signedSol, signedUsd } from "@/lib/format";
import type { CopiesData, LeadersData, SmartMoneyData, Summary } from "@/lib/types";
import { cn } from "@/lib/utils";

export default function Home() {
  const { data: s, error } = usePoll<Summary>("/api/summary", 10_000);
  const { data: leaders } = usePoll<LeadersData>("/api/leaders", 30_000);
  const { data: copies } = usePoll<CopiesData>("/api/copies", 10_000);
  const { data: smart } = usePoll<SmartMoneyData>("/api/smart", 15_000);
  const flows = (smart?.flows ?? []).slice(0, 8);
  const signals = (smart?.signals ?? []).slice(0, 6);
  const copying = (leaders?.leaders ?? []).filter((l) => l.copy_weight > 0);
  const wr = s?.winRate ?? null;
  const st = s?.stream;

  return (
    <div className="grid gap-3">
      {error && <p className="border border-amber/60 bg-amber/10 p-2 text-xs text-amber" role="alert">⚠ No data yet: {error}</p>}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {s ? <StatusBadge live={s.live} heartbeat={s.heartbeat} /> : <span>connecting…</span>}
        {st?.enabled && (
          <Link href="/stream" className="hover:text-foreground">
            stream <span className={st.status === "connected" ? "text-win" : "text-amber"}>{st.status ?? "starting"}</span> · {st.swapsPerSec ?? "—"} swaps/s
          </Link>
        )}
        <span className="hidden sm:inline">GodsEye copies whoever is making money right now, AI agents and humans alike, and drops losers automatically.</span>
      </div>

      <div className="grid grid-cols-2 gap-px border bg-border sm:grid-cols-3 lg:grid-cols-6">
        <Stat className="border-0" label="Realized P&L" value={signedUsd(s?.realizedPnlUsd ?? null)} sub={s ? `${signedSol(s.realizedPnlSol, 3)} SOL from copies` : ""} valueClass={pnlClass(s?.realizedPnlUsd)} />
        <Stat className="border-0" label="Win rate" value={wr === null ? "—" : `${wr.toFixed(1)}%`} sub={s ? `${s.wins}W / ${s.losses}L` : ""} valueClass={wr === null ? "" : wr >= 50 ? "text-win" : "text-loss"} />
        <Stat className="border-0" label="Open" value={s ? `${s.openPositions}/${s.maxPositions}` : "—"} sub={s ? `${s.unrealizedPnlUsd === null ? `${signedSol(s.unrealizedPnlSol, 3)} SOL` : signedUsd(s.unrealizedPnlUsd)} unrealized` : ""} valueClass={pnlClass(s?.unrealizedPnlUsd ?? s?.unrealizedPnlSol)} />
        <Stat className="border-0" label="Copying" value={s?.leaders ?? "—"} sub="wallets" />
        <Stat className="border-0" label="Analyzed" value={s?.walletsTracked.toLocaleString("en-US") ?? "—"} sub="wallets with a tier" />
        <Stat className="border-0" label="Seen live" value={st?.walletsSeen24h.toLocaleString("en-US") ?? "—"} sub="wallets, last 24h" />
      </div>

      <div className="flex flex-wrap gap-1.5">
        {TIERS.map((t) => (
          <Link key={t} href={`/wallets?tier=${t}`} title={TIER_DESCRIPTIONS[t]} className="flex items-center gap-1.5 border px-2 py-1 hover:bg-muted/50">
            <TierBadge tier={t} className="border-0 bg-transparent px-0 py-0" />
            <span className="text-sm font-bold num">{s?.tierCounts[t] ?? "—"}</span>
          </Link>
        ))}
        <Link href="/wallets?kind=ai" className="flex items-center gap-1.5 border px-2 py-1 text-[11px] uppercase hover:bg-muted/50">
          🤖 AI/bot <span className="text-sm font-bold text-cyan-300 num">{s?.kindCounts.ai ?? "—"}</span>
        </Link>
        <Link href="/wallets?kind=human" className="flex items-center gap-1.5 border px-2 py-1 text-[11px] uppercase hover:bg-muted/50">
          🧑 Human <span className="text-sm font-bold text-sky-100 num">{s?.kindCounts.human ?? "—"}</span>
        </Link>
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        <Window
          title={`Where smart money is moving · ${smart?.activeWallets ?? "—"} smart wallets`}
          className="lg:col-span-2"
          right={smart ? <span className="text-muted-foreground">{smart.trades24h.toLocaleString("en-US")} smart trades in 24h</span> : null}
        >
          <div className="divide-y">
            {flows.length === 0 && <p className="p-3 text-xs text-muted-foreground">No smart-money trades yet. They show up as the live stream sees smart wallets trade.</p>}
            {flows.map((f) => {
              const net1 = f.buy_usd_1h - f.sell_usd_1h;
              const net24 = f.buy_usd_24h - f.sell_usd_24h;
              return (
                <div key={f.mint} className="flex flex-wrap items-center justify-between gap-2 px-3 py-1.5 text-xs">
                  <a href={`https://dexscreener.com/solana/${f.mint}`} target="_blank" rel="noreferrer" className="min-w-0 truncate font-bold hover:text-win">
                    {f.symbol ?? `${f.mint.slice(0, 4)}…`} ↗
                  </a>
                  <div className="flex items-center gap-3 num">
                    <span className="text-muted-foreground">{f.buyers_24h} buying · {f.sellers_24h} selling</span>
                    <span className={pnlClass(net1)} title="net smart money, last hour">{signedUsd(net1)} 1h</span>
                    <span className={cn("w-20 text-right font-bold", pnlClass(net24))} title="net smart money, last 24h">{signedUsd(net24)}</span>
                    <span className={cn("w-12 text-right", pnlClass(f.change_since_first_buy))} title="price change since the first smart buy">{pct(f.change_since_first_buy, 0)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </Window>
        <Window title="Smart money signals">
          <div className="divide-y">
            {signals.length === 0 && <p className="p-3 text-xs text-muted-foreground">None yet. A signal fires when 3+ smart wallets buy (or dump) the same token within an hour.</p>}
            {signals.map((g) => (
              <div key={g.id} className="flex items-center justify-between gap-2 px-3 py-1.5 text-xs">
                <span className="min-w-0 truncate">
                  <span className={g.kind === "accumulate" ? "text-win" : "text-loss"}>{g.kind === "accumulate" ? "▲" : "▼"}</span> <span className="font-bold">{g.symbol ?? `${g.mint.slice(0, 4)}…`}</span>{" "}
                  <span className="text-muted-foreground">· {g.wallet_count} wallets · {ago(g.ts)}</span>
                </span>
                <span className={cn("num", pnlClass(g.ret_6h ?? g.ret_1h))} title="price move after the signal (6h, or 1h so far)">
                  {g.ret_6h !== null ? `${pct(g.ret_6h, 0)} 6h` : g.ret_1h !== null ? `${pct(g.ret_1h, 0)} 1h` : "pending"}
                </span>
              </div>
            ))}
          </div>
        </Window>
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        <Window title="Copying now" className="lg:col-span-2" right={<Link href="/leaders" className="text-muted-foreground underline">all</Link>}>
          <div className="divide-y">
            {copying.length === 0 && <p className="p-3 text-xs text-muted-foreground">Nobody yet. Leaders appear once an analyzed wallet is making money.</p>}
            {copying.slice(0, 8).map((l) => (
              <div key={l.address} className="flex flex-wrap items-center justify-between gap-2 px-3 py-1.5 text-xs">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <Addr address={l.address} />
                  <TierBadge tier={l.tier} />
                  <KindBadge kind={l.kind} score={null} />
                </div>
                <div className="flex items-center gap-3 num">
                  <span className={pnlClass(l.pnl_7d_usd)}>{signedUsd(l.pnl_7d_usd)} 7d</span>
                  <span className="w-10 text-right font-bold text-win">{(l.copy_weight * 100).toFixed(0)}%</span>
                </div>
              </div>
            ))}
          </div>
        </Window>
        <Window title="Open positions" right={<Link href="/copies" className="text-muted-foreground underline">all</Link>}>
          <div className="divide-y">
            {(copies?.open ?? []).length === 0 && <p className="p-3 text-xs text-muted-foreground">None.</p>}
            {(copies?.open ?? []).map((p) => (
              <div key={p.id} className="flex items-center justify-between gap-3 px-3 py-1.5 text-xs">
                <span className="min-w-0 truncate">
                  <span className="font-bold">{p.symbol ?? p.mint.slice(0, 6)}</span> <span className="text-muted-foreground">· {ago(p.opened_at)}</span>
                </span>
                <span className={cn("font-bold num", pnlClass(p.unrealized_pct))}>{pct(p.unrealized_pct ?? null)}</span>
              </div>
            ))}
          </div>
        </Window>
      </div>

      <Window title="Log" bodyClassName="bg-black">
        <TerminalFeed limit={12} />
      </Window>
    </div>
  );
}
