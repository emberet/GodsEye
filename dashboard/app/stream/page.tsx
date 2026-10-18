"use client";
import { useState } from "react";
import { PageHeader } from "@/components/page-header";
import { Window } from "@/components/window";
import { Stat } from "@/components/stat";
import { Addr, KindBadge, TierBadge } from "@/components/wallet-badges";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { usePoll } from "@/lib/use-poll";
import { cn } from "@/lib/utils";
import { ago, pnlClass, signedSol, signedUsd } from "@/lib/format";
import type { LiveWalletRow, Summary } from "@/lib/types";

const SORTS = [
  { v: "pnl", label: "Live P&L" },
  { v: "swaps", label: "Most swaps" },
  { v: "volume", label: "Most volume" },
  { v: "recent", label: "Most recent" },
] as const;

export default function StreamPage() {
  const [sort, setSort] = useState<(typeof SORTS)[number]["v"]>("pnl");
  const [kind, setKind] = useState<"all" | "ai" | "human" | "unknown">("all");
  const { data: s } = usePoll<Summary>("/api/summary", 10_000);
  const { data, error } = usePoll<LiveWalletRow[]>(`/api/stream?sort=${sort}&kind=${kind}&limit=200`, 15_000);
  const st = s?.stream;
  return (
    <>
      <PageHeader title="Live" kicker="every DEX swap on Solana, as it confirms" />
      {st && !st.enabled && (
        <div className="mb-3 border border-amber/60 bg-amber/10 p-2 text-xs text-amber" role="status">
          The live stream is off. Set GRPC_URL and GRPC_TOKEN in .env (Shyft, Triton, Helius or QuickNode gRPC) and restart GodsEye. Until then GodsEye samples the busiest pools every 30 minutes.
        </div>
      )}
      <div className="mb-3 grid grid-cols-3 gap-px border bg-border lg:grid-cols-6">
        <Stat className="border-0" label="Stream" value={st?.enabled ? st.status ?? "starting" : "off"} sub={st?.lastAt ? `updated ${ago(st.lastAt)}` : ""} valueClass={st?.status === "connected" ? "text-win" : "text-amber"} />
        <Stat className="border-0" label="DEX txs / sec" value={st?.txPerSec ?? "—"} />
        <Stat className="border-0" label="Swaps / sec" value={st?.swapsPerSec ?? "—"} sub="memecoin swaps, parsed" />
        <Stat className="border-0" label="Wallets in memory" value={st?.walletsInMemory?.toLocaleString("en-US") ?? "—"} />
        <Stat className="border-0" label="Seen last 24h" value={st?.walletsSeen24h.toLocaleString("en-US") ?? "—"} />
        <Stat className="border-0" label="Seen total" value={st?.walletsSeenTotal.toLocaleString("en-US") ?? "—"} sub="kept 30 days" />
      </div>

      <Window
        title="Wallets seen live"
        right={
          <>
            <select aria-label="Sort" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} className="bevel-in bg-black px-1.5 py-0.5 text-foreground">
              {SORTS.map((o) => (
                <option key={o.v} value={o.v}>
                  Sort: {o.label}
                </option>
              ))}
            </select>
            <select aria-label="AI or human" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} className="bevel-in bg-black px-1.5 py-0.5 text-foreground">
              <option value="all">AI + human</option>
              <option value="ai">AI / bot</option>
              <option value="human">Human</option>
              <option value="unknown">Undecided</option>
            </select>
          </>
        }
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Wallet</TableHead>
              <TableHead>AI / human (live)</TableHead>
              <TableHead>Tier</TableHead>
              <TableHead className="text-right">Live P&amp;L</TableHead>
              <TableHead className="text-right">Closed</TableHead>
              <TableHead className="text-right">Swaps</TableHead>
              <TableHead className="text-right">Volume</TableHead>
              <TableHead>First seen</TableHead>
              <TableHead>Last seen</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {error && (
              <TableRow>
                <TableCell colSpan={9} className="py-6 text-center text-loss">{error}</TableCell>
              </TableRow>
            )}
            {!error && (data ?? []).length === 0 && (
              <TableRow>
                <TableCell colSpan={9} className="py-10 text-center text-muted-foreground">{data ? "No wallets seen on the stream yet." : "loading…"}</TableCell>
              </TableRow>
            )}
            {(data ?? []).map((w) => (
              <TableRow key={w.address}>
                <TableCell><Addr address={w.address} internal={w.tier !== null} /></TableCell>
                <TableCell><KindBadge kind={w.live_kind} score={w.live_ai_score} /></TableCell>
                <TableCell>{w.tier ? <TierBadge tier={w.tier} /> : <span className="text-[11px] text-muted-foreground">{w.promoted ? "queued" : "not analyzed"}</span>}</TableCell>
                <TableCell className={cn("text-right font-bold", pnlClass(w.live_pnl_usd))} title={`${signedSol(w.live_pnl_sol, 3)} SOL`}>{signedUsd(w.live_pnl_usd)}</TableCell>
                <TableCell className="text-right">{w.live_closed ? `${w.live_wins}/${w.live_closed}` : "—"}</TableCell>
                <TableCell className="text-right">{w.swaps}</TableCell>
                <TableCell className="text-right">{w.volume_sol.toFixed(2)}</TableCell>
                <TableCell className="text-muted-foreground">{ago(w.first_seen_at)}</TableCell>
                <TableCell className="text-muted-foreground">{ago(w.last_seen_at)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <p className="border-t px-3 py-2 text-[11px] text-muted-foreground">
          Live P&amp;L counts only swaps GodsEye has seen on the stream since it started watching the wallet, so a sell of tokens bought earlier isn&apos;t counted. Wallets that
          make ≥ $100 over ≥ 3 closed trades with ≥ 50% wins are promoted to a full analysis (tier, age, funder, history).
        </p>
      </Window>
    </>
  );
}
