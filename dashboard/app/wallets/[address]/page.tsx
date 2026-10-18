"use client";
import Link from "next/link";
import { TIER_DESCRIPTIONS } from "@godseye/shared/constants";
import { PageHeader } from "@/components/page-header";
import { Window } from "@/components/window";
import { Stat } from "@/components/stat";
import { Addr, KindBadge, TierBadge } from "@/components/wallet-badges";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { usePoll } from "@/lib/use-poll";
import { ago, dollars, dt, pnlClass, signedSol, signedUsd, solscanAccount, solscanTx } from "@/lib/format";
import type { WalletDetail } from "@/lib/types";
import { cn } from "@/lib/utils";

const EVIDENCE_LABEL: Record<string, string> = {
  is_creator: "Token creator",
  funded_by_creator: "Funded by creator",
  early_entry: "Launch-minute buy",
  sold_before_crash: "Sold before crash",
  concentrated_profit: "One big win",
  small_sample: "Few trades",
  slipping: "Slipping",
  fresh_big: "Fresh + big",
  sibling_wallets: "Sibling wallets",
  rotated_from: "Possible rotation",
  inactive: "Inactive",
};

const age = (s: number | null) => (s === null ? "—" : s < 60 ? `${Math.round(s)}s` : s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`);

export default function WalletPage({ params }: { params: { address: string } }) {
  const { data, error } = usePoll<WalletDetail>(`/api/wallets/${params.address}`, 30_000);
  if (error) {
    return (
      <>
        <PageHeader title="Wallet" kicker={params.address} />
        <Window title="Not found">
          <p className="p-4 text-sm text-muted-foreground">
            {error}{" "}
            <a className="underline" href={solscanAccount(params.address)} target="_blank" rel="noreferrer">
              View on Solscan ↗
            </a>
          </p>
        </Window>
      </>
    );
  }
  if (!data) return <p className="text-sm text-muted-foreground">loading…</p>;
  const { wallet: w, stats: s } = data;

  return (
    <>
      <PageHeader title="Wallet" kicker="every label shows its evidence">
        <Link href="/wallets" className="text-xs text-muted-foreground underline">
          ← all wallets
        </Link>
      </PageHeader>

      <Window title={w.address} className="mb-3">
        <div className="flex flex-col gap-3 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <TierBadge tier={w.tier} className="text-sm" />
            <KindBadge kind={w.kind} score={w.ai_score} className="text-sm" />
            {w.is_fresh === 1 && <span className="border border-win/40 px-1.5 py-0.5 text-[11px] font-bold uppercase text-win">fresh wallet</span>}
            {w.copy_weight > 0 && <span className="border border-win/60 bg-win/10 px-1.5 py-0.5 text-[11px] font-bold uppercase text-win">GodsEye copies this · {(w.copy_weight * 100).toFixed(0)}%</span>}
            <a href={solscanAccount(w.address)} target="_blank" rel="noreferrer" className="ml-auto text-xs text-muted-foreground underline">
              Solscan ↗
            </a>
          </div>
          <p className="text-sm">{w.tier_reason ?? "Queued for analysis."}</p>
          <p className="text-[11px] text-muted-foreground">{TIER_DESCRIPTIONS[w.tier]}</p>
          <div className="grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
            <span>
              Created on Solana: <span className="text-foreground">{w.chain_created_at ? `${dt(w.chain_created_at)}${w.age_is_lower_bound ? " or earlier" : ""}` : "unknown"}</span>
            </span>
            <span>
              Funded by: {w.funder ? <Addr address={w.funder} /> : <span className="text-foreground">unknown</span>}
              {w.group_size > 1 && <span> · {w.group_size} tracked wallets share this funder</span>}
            </span>
            <span>
              Found: <span className="text-foreground">{dt(w.first_seen_at)}</span> ({w.discovered_via.replaceAll("_", " ")})
            </span>
            <span>
              Last analyzed: <span className="text-foreground">{ago(w.last_analyzed_at)}</span> · last active {ago(w.last_activity_at)}
            </span>
          </div>
        </div>
      </Window>

      <div className="mb-3 grid grid-cols-2 gap-px border bg-border sm:grid-cols-3 lg:grid-cols-6">
        <Stat className="border-0" label="7d P&L" value={signedUsd(s?.pnl_7d_usd)} sub={`${signedSol(s?.pnl_7d_sol, 2)} SOL`} valueClass={pnlClass(s?.pnl_7d_usd)} />
        <Stat className="border-0" label="30d P&L" value={signedUsd(s?.pnl_30d_usd)} sub={`${signedSol(s?.pnl_30d_sol, 2)} SOL`} valueClass={pnlClass(s?.pnl_30d_usd)} />
        <Stat className="border-0" label="Win rate 30d" value={s?.win_rate_30d == null ? "—" : `${Math.round(s.win_rate_30d * 100)}%`} sub={s ? `${s.wins_30d}/${s.closed_30d} closed` : ""} />
        <Stat className="border-0" label="Best trade share" value={s?.best_trade_share == null ? "—" : `${Math.round(s.best_trade_share * 100)}%`} sub="of 30d profit" />
        <Stat className="border-0" label="Avg buy" value={dollars(s?.avg_buy_usd)} sub={s?.avg_hold_minutes == null ? `${s?.avg_buy_sol?.toFixed(2) ?? "—"} SOL` : `${s?.avg_buy_sol?.toFixed(2) ?? "—"} SOL · holds ~${Math.round(s.avg_hold_minutes)}m`} />
        <Stat className="border-0" label="Launch-minute buys" value={s?.early_buy_rate == null ? "—" : `${Math.round(s.early_buy_rate * 100)}%`} sub={s ? `${s.early_buys} buys` : ""} />
      </div>

      <div className="mb-3 grid gap-3 lg:grid-cols-2">
        <Window title="Evidence">
          <div className="divide-y">
            {data.evidence.length === 0 && <p className="p-4 text-sm text-muted-foreground">No flags. Nothing unusual found.</p>}
            {data.evidence.map((e) => (
              <div key={e.id} className="flex flex-col gap-0.5 px-3 py-2 text-xs">
                <div className="flex items-center gap-2">
                  <span className="border border-border px-1 text-[10px] uppercase tracking-wider text-muted-foreground">{EVIDENCE_LABEL[e.kind] ?? e.kind}</span>
                  <span className="text-muted-foreground">{dt(e.ts)}</span>
                  {e.signature && (
                    <a href={solscanTx(e.signature)} target="_blank" rel="noreferrer" className="ml-auto text-muted-foreground underline">
                      tx ↗
                    </a>
                  )}
                </div>
                <p>{e.detail}</p>
              </div>
            ))}
          </div>
        </Window>

        <Window title="AI or human">
          <div className="p-3 text-xs">
            <p className="mb-2 text-muted-foreground">
              Starts at 50. Points push it toward AI / bot (≥ 65) or human (≤ 35). On-chain, an AI agent and a scripted bot look the same, so &quot;AI / bot&quot;
              means a program is placing the trades.
            </p>
            <ul className="space-y-1">
              {data.kindReasons.map((r, i) => (
                <li key={i} className="flex gap-2">
                  <span className={cn("w-9 shrink-0 text-right font-bold num", r.points > 0 ? "text-cyan-300" : r.points < 0 ? "text-sky-100" : "text-muted-foreground")}>
                    {r.points > 0 ? `+${r.points}` : r.points}
                  </span>
                  <span>{r.reason}</span>
                </li>
              ))}
            </ul>
            <p className="mt-2 border-t pt-2">
              Score: <span className="font-bold">{w.ai_score ?? "—"}</span> → <KindBadge kind={w.kind} score={null} />
            </p>
          </div>
        </Window>
      </div>

      {(w.copy_weight > 0 || data.weightHistory.length > 0 || data.copies.length > 0) && (
        <Window title="GodsEye and this wallet" className="mb-3">
          <div className="grid gap-4 p-3 text-xs lg:grid-cols-2">
            <div>
              <p className="mb-1 text-muted-foreground">Learning loop: how GodsEye&apos;s copy weight for this wallet changed</p>
              {data.weightHistory.length === 0 && <p className="text-muted-foreground">no changes yet</p>}
              {data.weightHistory.map((h) => (
                <p key={h.id}>
                  <span className="text-muted-foreground">{dt(h.ts)}</span> {(h.old_weight * 100).toFixed(0)}% → <span className={h.new_weight > h.old_weight ? "text-win" : "text-loss"}>{(h.new_weight * 100).toFixed(0)}%</span> · {h.reason}
                </p>
              ))}
            </div>
            <div>
              <p className="mb-1 text-muted-foreground">
                GodsEye&apos;s results copying it: <span className={cn("font-bold", pnlClass(data.copyPnlUsd))}>{signedUsd(data.copyPnlUsd)}</span> ({signedSol(data.copyPnlSol, 3)} SOL) over {data.copyClosed} closed positions
              </p>
              {data.copies.slice(0, 15).map((c) => (
                <p key={c.id}>
                  <span className="text-muted-foreground">{dt(c.created_at)}</span> {c.side} {c.symbol} · <span className={c.status === "filled" ? "text-win" : c.status === "failed" ? "text-loss" : "text-muted-foreground"}>{c.status}</span>
                  {c.reason && <span className="text-muted-foreground"> · {c.reason}</span>}
                </p>
              ))}
            </div>
          </div>
        </Window>
      )}

      {data.group.length > 0 && w.funder && (
        <Window title={`Same funder ${w.funder.slice(0, 4)}…${w.funder.slice(-4)}`} className="mb-3">
          <div className="flex flex-wrap gap-2 p-3">
            {data.group.map((g) => (
              <span key={g.address} className="flex items-center gap-1.5 border px-2 py-1 text-xs">
                <Addr address={g.address} /> <TierBadge tier={g.tier} /> <KindBadge kind={g.kind} score={g.ai_score} />
              </span>
            ))}
          </div>
        </Window>
      )}

      <Window title={`Swaps · latest ${data.swaps.length}`}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>Side</TableHead>
              <TableHead>Token</TableHead>
              <TableHead className="text-right">USD</TableHead>
              <TableHead className="text-right">SOL</TableHead>
              <TableHead>Settled in</TableHead>
              <TableHead className="text-right">Tokens</TableHead>
              <TableHead className="text-right">After launch</TableHead>
              <TableHead>Venue</TableHead>
              <TableHead>Tx</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.swaps.length === 0 && (
              <TableRow>
                <TableCell colSpan={10} className="py-8 text-center text-muted-foreground">No memecoin swaps settled in SOL or USDC/USDT seen yet.</TableCell>
              </TableRow>
            )}
            {data.swaps.map((x) => (
              <TableRow key={x.id}>
                <TableCell className="text-muted-foreground">{dt(x.ts)}</TableCell>
                <TableCell className={x.side === "buy" ? "text-win" : "text-loss"}>{x.side}</TableCell>
                <TableCell className="font-bold">{x.symbol ?? `${x.mint.slice(0, 4)}…`}</TableCell>
                <TableCell className="text-right">{dollars(x.usd_amount)}</TableCell>
                <TableCell className="text-right text-muted-foreground">{x.sol_amount.toFixed(3)}</TableCell>
                <TableCell className="text-muted-foreground">
                  {x.quote === "SOL" ? "SOL" : x.quote.includes("+") ? x.quote : `$${(x.quote_amount ?? 0).toFixed(2)} ${x.quote}`}
                </TableCell>
                <TableCell className="text-right">{x.token_amount.toPrecision(4)}</TableCell>
                <TableCell className="text-right">{age(x.token_age_sec)}</TableCell>
                <TableCell className="text-muted-foreground">{x.venue ?? "—"}</TableCell>
                <TableCell>
                  <a href={solscanTx(x.signature)} target="_blank" rel="noreferrer" className="text-muted-foreground underline">
                    ↗
                  </a>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Window>
    </>
  );
}
