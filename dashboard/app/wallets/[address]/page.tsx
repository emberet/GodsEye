"use client";
import { useState } from "react";
import Link from "next/link";
import { ArrowUpRight, Check, ChevronLeft, Minus, Plus } from "lucide-react";
import { TIER_DESCRIPTIONS } from "@godseye/shared/constants";
import { PageHeader } from "@/components/page-header";
import { CopyButton } from "@/components/copy-button";
import { Empty, Window } from "@/components/window";
import { Stat } from "@/components/stat";
import { Addr, KindBadge, kindLabel, TierBadge, TokenLink, WalletDot, WalletLink, WalletPageLink } from "@/components/wallet-badges";
import { usePoll } from "@/lib/use-poll";
import { ago, dollars, dt, hasWeek, pnlClass, shortAddr, signedSol, signedUsd, solscanAccount, solscanTx, spanLabel } from "@/lib/format";
import type { WalletDetail } from "@/lib/types";
import { cn } from "@/lib/utils";

const EVIDENCE_LABEL: Record<string, string> = {
  is_creator: "Made the coin",
  funded_by_creator: "Funded by the coin's maker",
  early_entry: "Bought in the first minute",
  sold_before_crash: "Sold right before a crash",
  concentrated_profit: "One big win",
  small_sample: "Few trades",
  slipping: "Starting to lose",
  fresh_big: "New wallet, big buys",
  sibling_wallets: "Many sibling wallets",
  rotated_from: "Possibly a swapped-in wallet",
  inactive: "Stopped trading",
};

const age = (s: number | null) => (s === null ? "—" : s < 60 ? `${Math.round(s)}s` : s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`);
const pctOf = (n: number | null | undefined) => (n == null ? "—" : `${Math.round(n * 100)}`);

export default function WalletPage({ params }: { params: { address: string } }) {
  const { data, error } = usePoll<WalletDetail>(`/api/wallets/${params.address}`, 30_000);
  const [allSwaps, setAllSwaps] = useState(false);

  if (error) {
    return (
      <>
        <PageHeader title="Wallet" back="/wallets" kicker={<span className="font-mono">{shortAddr(params.address, 6)}</span>} />
        <div className="card">
          <Empty img="radar" title="Not studied yet">
            {error}{" "}
            <a className="text-accent underline underline-offset-2" href={solscanAccount(params.address)} target="_blank" rel="noreferrer">
              View it on Solscan
            </a>
          </Empty>
        </div>
      </>
    );
  }
  if (!data) return <p className="text-sm text-muted-foreground">Loading…</p>;
  const { wallet: w, stats: s } = data;
  const sm = data.smart;
  const swaps = allSwaps ? data.swaps : data.swaps.slice(0, 8);
  const copied = w.copy_weight > 0;

  return (
    <>
      <section className="flex flex-wrap items-center gap-4">
        <Link href="/wallets" className="dot bg-cream shadow-hard-sm" aria-label="All wallets">
          <ChevronLeft size={18} strokeWidth={1.8} aria-hidden />
        </Link>
        <WalletDot address={w.address} tier={w.tier} className="h-16 w-16 text-xl sm:h-[72px] sm:w-[72px]" />
        <div className="min-w-0 flex-1 basis-64">
          <h1 className="text-2xl sm:text-[30px]">
            <WalletLink address={w.address} />
          </h1>
          <div className="mt-2 flex flex-wrap gap-2">
            <TierBadge tier={w.tier} />
            <KindBadge kind={w.kind} score={null} />
            {w.is_fresh === 1 && <span className="tag bg-coral text-ink">New wallet</span>}
            {w.is_smart === 1 && <span className="tag bg-sun text-ink">Smart money</span>}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <CopyButton text={w.address} />
          <a className="btn" href={solscanAccount(w.address)} target="_blank" rel="noreferrer">
            Solscan <ArrowUpRight size={15} aria-hidden />
          </a>
        </div>
      </section>

      <section className={cn("flex flex-wrap items-center gap-3 rounded-[18px] border-[3px] border-ink py-2.5 pl-3 pr-2.5 text-ink shadow-hard", copied ? "bg-lime" : "bg-card text-foreground")}>
        <span className="dot h-10 w-10 bg-cream" aria-hidden>
          {copied ? <Check size={15} strokeWidth={2.4} /> : <Minus size={15} strokeWidth={2.4} />}
        </span>
        <p className="min-w-0 flex-1 basis-60 py-1.5 text-[15px] font-bold">
          {copied ? "GodsEye copies this wallet. " : "GodsEye doesn't copy this wallet. "}
          {w.tier_reason ?? "It's queued for a full look."}
        </p>
        {copied && <span className="tag min-h-[44px] bg-cream px-4 text-sm text-ink shadow-hard-sm">{(w.copy_weight * 100).toFixed(0)}% of copy budget</span>}
      </section>

      <section className="grid gap-5 sm:grid-cols-3">
        <div className="card">
          <Stat
            label={`Profit, ${spanLabel(w.history_from)}`}
            value={signedUsd(s?.pnl_30d_usd)}
            valueClass={pnlClass(s?.pnl_30d_usd)}
            sub={`${signedSol(s?.pnl_30d_sol, 2)} SOL · ${hasWeek(w.history_from) ? `7 days ${signedUsd(s?.pnl_7d_usd)}` : "realized, not counting coins still held"}`}
          />
        </div>
        <div className="card">
          <Stat label="Trades won" value={pctOf(s?.win_rate_30d)} unit={s?.win_rate_30d == null ? undefined : "%"} sub={s ? `${s.wins_30d} of ${s.closed_30d} closed trades` : "No closed trades yet"} />
        </div>
        <div className="card">
          <Stat
            label="After it buys"
            value={sm?.lead_n ? pctOf(sm.lead_hit_rate) : "—"}
            unit={sm?.lead_n ? "% went up" : undefined}
            valueClass={sm?.lead_n ? "" : "text-muted-foreground"}
            sub={sm?.lead_n ? `in 6 hours, over ${sm.lead_n} buys (median ${sm.lead_median_6h == null ? "—" : `${sm.lead_median_6h >= 0 ? "+" : ""}${Math.round(sm.lead_median_6h)}%`})` : "Measuring the price 6 hours after each buy"}
          />
        </div>
      </section>

      <section className="grid gap-5 lg:grid-cols-2">
        <Window title="Why this label">
          <p className="text-sm text-muted-foreground">{TIER_DESCRIPTIONS[w.tier]}</p>
          <div className="mt-2">
            {data.evidence.length === 0 && <p className="py-3 text-sm">No red flags. Nothing unusual found.</p>}
            {data.evidence.map((e) => (
              <div key={e.id} className="line items-start">
                <span className="tag mt-0.5 shrink-0">{EVIDENCE_LABEL[e.kind] ?? e.kind}</span>
                <p className="min-w-0 flex-1 text-sm">
                  {e.detail}
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {dt(e.ts)}
                    {e.signature && (
                      <>
                        {" · "}
                        <a href={solscanTx(e.signature)} target="_blank" rel="noreferrer" className="text-accent underline underline-offset-2">see the trade</a>
                      </>
                    )}
                  </span>
                </p>
              </div>
            ))}
          </div>
        </Window>

        <Window title="Bot or human?">
          <p className="text-sm text-muted-foreground">
            {w.kind === "unknown" ? "Not sure yet." : `Most likely a ${kindLabel(w.kind).toLowerCase()}.`} Score {w.ai_score ?? "—"} of 100: 65 or more means a program places the trades, 35 or less a person.
          </p>
          <div className="mt-2">
            {data.kindReasons.map((r, i) => (
              <div key={i} className="line">
                <span className={cn("dot h-8 w-8 text-ink", r.points > 0 ? "bg-lilac" : r.points < 0 ? "bg-cream" : "bg-chip text-foreground")} aria-hidden>
                  {r.points > 0 ? <Plus size={14} strokeWidth={2.4} /> : r.points < 0 ? <Minus size={14} strokeWidth={2.4} /> : "·"}
                </span>
                <p className="min-w-0 flex-1 text-sm">{r.reason}</p>
                <span className="text-sm text-muted-foreground num">{r.points > 0 ? `+${r.points}` : r.points}</span>
              </div>
            ))}
          </div>
        </Window>
      </section>

      <Window
        title="Latest trades"
        right={data.swaps.length > 8 && <button type="button" className="pill" onClick={() => setAllSwaps((v) => !v)}>{allSwaps ? "Show fewer" : `Show all ${data.swaps.length}`}</button>}
      >
        {data.swaps.length === 0 && <p className="py-3 text-sm text-muted-foreground">No memecoin trades paid in SOL, USDC or USDT seen yet.</p>}
        {swaps.map((x) => (
          <div key={x.id} className="line flex-wrap sm:flex-nowrap">
            <span className={cn("tag w-[70px] justify-center", x.side === "buy" ? "bg-lime text-ink" : "bg-coral text-ink")}>{x.side === "buy" ? "Bought" : "Sold"}</span>
            <p className="min-w-0 flex-1 font-semibold">
              <TokenLink mint={x.mint} symbol={x.symbol} />
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                {x.token_age_sec !== null && <>coin was {age(x.token_age_sec)} old · </>}
                {x.quote === "SOL" ? `${x.sol_amount.toFixed(3)} SOL` : x.quote.includes("+") ? x.quote : `${x.quote}`}
                {x.venue && <> · {x.venue}</>}
              </span>
            </p>
            <p className="text-xl font-extrabold num">{dollars(x.usd_amount)}</p>
            <a href={solscanTx(x.signature)} target="_blank" rel="noreferrer" className="w-16 text-right text-xs text-muted-foreground hover:text-accent" title={dt(x.ts)}>
              {ago(x.ts)}
            </a>
          </div>
        ))}
      </Window>

      {(copied || data.weightHistory.length > 0 || data.copies.length > 0) && (
        <Window title="GodsEye and this wallet" right={<span className={cn("text-xl font-extrabold num", pnlClass(data.copyPnlUsd))}>{signedUsd(data.copyPnlUsd)}</span>}>
          <p className="text-sm text-muted-foreground">
            Result of copying it: {signedUsd(data.copyPnlUsd)} ({signedSol(data.copyPnlSol, 3)} SOL) over {data.copyClosed} closed trade{data.copyClosed === 1 ? "" : "s"}.
          </p>
          <div className="mt-2 grid gap-x-8 lg:grid-cols-2">
            <div className="min-w-0">
              <p className="k mt-2">How much GodsEye trusts it</p>
              {data.weightHistory.length === 0 && <p className="py-2 text-sm text-muted-foreground">No changes yet.</p>}
              {data.weightHistory.slice(0, 8).map((h) => (
                <div key={h.id} className="line text-sm">
                  <span className="num">
                    {(h.old_weight * 100).toFixed(0)}% → <b className={h.new_weight > h.old_weight ? "text-accent" : "text-loss"}>{(h.new_weight * 100).toFixed(0)}%</b>
                  </span>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground" title={h.reason}>{h.reason}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{ago(h.ts)}</span>
                </div>
              ))}
            </div>
            <div className="min-w-0">
              <p className="k mt-2">Copies</p>
              {data.copies.length === 0 && <p className="py-2 text-sm text-muted-foreground">None yet.</p>}
              {data.copies.slice(0, 8).map((c) => (
                <div key={c.id} className="line text-sm">
                  <span className={cn("tag", c.status === "filled" ? "bg-lime text-ink" : c.status === "failed" ? "bg-coral text-ink" : "")}>{c.status}</span>
                  <span className="min-w-0 flex-1 truncate">
                    {c.side} <TokenLink mint={c.mint} symbol={c.symbol} />
                    {c.reason && <span className="text-muted-foreground"> · {c.reason}</span>}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">{ago(c.created_at)}</span>
                </div>
              ))}
            </div>
          </div>
        </Window>
      )}

      {data.group.length > 0 && w.funder && (
        <Window title="Wallets with the same funder" right={<span className="text-muted-foreground">{data.group.length + 1} wallets</span>}>
          <div className="flex flex-wrap gap-2">
            {data.group.map((g) => (
              <div key={g.address} className="pill gap-2 pl-1.5 pr-1.5 hover:translate-y-0">
                <WalletDot address={g.address} tier={g.tier} className="h-8 w-8 text-[11px]" />
                <WalletLink address={g.address} />
                <TierBadge tier={g.tier} />
                <WalletPageLink address={g.address} className="h-7 w-7 shadow-none" />
              </div>
            ))}
          </div>
        </Window>
      )}

      <details className="card group py-2">
        <summary className="flex min-h-[48px] cursor-pointer list-none items-center justify-between text-base font-medium">
          More details
          <Plus size={18} className="transition-transform group-open:rotate-45" aria-hidden />
        </summary>
        <div className="grid gap-x-6 gap-y-4 pb-4 pt-1 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <p className="k">Created on Solana</p>
            <p className="mt-0.5 text-sm">{w.chain_created_at ? `${dt(w.chain_created_at)}${w.age_is_lower_bound ? " or earlier" : ""}` : "Unknown"}</p>
          </div>
          <div>
            <p className="k">Funded by</p>
            <p className="mt-0.5 text-sm">{w.funder ? <Addr address={w.funder} /> : "Unknown"}</p>
          </div>
          <div>
            <p className="k">Found</p>
            <p className="mt-0.5 text-sm">{dt(w.first_seen_at)} · {w.discovered_via.replaceAll("_", " ")}</p>
          </div>
          <div>
            <p className="k">Trades read since</p>
            <p className="mt-0.5 text-sm">{w.history_from ? `${dt(w.history_from)}${s ? ` · ${s.swaps_total} swaps` : ""}` : "Not read yet"}</p>
          </div>
          <div>
            <p className="k">Last checked</p>
            <p className="mt-0.5 text-sm">{ago(w.last_analyzed_at)} · active {ago(w.last_activity_at)}</p>
          </div>
          {s && (
            <>
              <div>
                <p className="k">Biggest trade&apos;s share of profit</p>
                <p className="mt-0.5 text-sm">{s.best_trade_share == null ? "—" : `${Math.round(s.best_trade_share * 100)}%`}</p>
              </div>
              <div>
                <p className="k">Typical buy</p>
                <p className="mt-0.5 text-sm">{dollars(s.avg_buy_usd)} · {s.avg_buy_sol?.toFixed(2) ?? "—"} SOL</p>
              </div>
              <div>
                <p className="k">Usually holds</p>
                <p className="mt-0.5 text-sm">{s.avg_hold_minutes == null ? "—" : `~${Math.round(s.avg_hold_minutes)} minutes`}</p>
              </div>
              <div>
                <p className="k">Buys in a coin&apos;s first minute</p>
                <p className="mt-0.5 text-sm">{s.early_buy_rate == null ? "—" : `${Math.round(s.early_buy_rate * 100)}%`} · {s.early_buys} buys</p>
              </div>
            </>
          )}
        </div>
      </details>
    </>
  );
}
