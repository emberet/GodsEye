"use client";
import { useState } from "react";
import Link from "next/link";
import { Empty, Window } from "@/components/window";
import { Stat } from "@/components/stat";
import { TierBadge, kindLabel } from "@/components/wallet-badges";
import { usePoll } from "@/lib/use-poll";
import { ago, pnlClass, shortAddr, signedSol, signedUsd } from "@/lib/format";
import type { LiveWalletRow, Summary } from "@/lib/types";
import { cn } from "@/lib/utils";

const SORTS = [
  { v: "pnl", label: "Most profit" },
  { v: "swaps", label: "Most trades" },
  { v: "volume", label: "Most volume" },
  { v: "recent", label: "Most recent" },
] as const;
const KINDS = [
  { v: "all", label: "Everyone" },
  { v: "ai", label: "Bots" },
  { v: "human", label: "Humans" },
] as const;

export default function StreamPage() {
  const [sort, setSort] = useState<(typeof SORTS)[number]["v"]>("pnl");
  const [kind, setKind] = useState<"all" | "ai" | "human" | "unknown">("all");
  const [more, setMore] = useState(false);
  const { data: s } = usePoll<Summary>("/api/summary", 10_000);
  const { data, error } = usePoll<LiveWalletRow[]>(`/api/stream?sort=${sort}&kind=${kind}&limit=200`, 15_000);
  const st = s?.stream;
  const rows = (data ?? []).slice(0, more ? 200 : 25);
  const connected = st?.status === "connected";

  return (
    <>
      <header>
        <h1 className="text-3xl font-medium tracking-[-0.03em] sm:text-[34px]">Live</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">Every memecoin trade on Solana, read as it happens.</p>
      </header>

      <div
        aria-hidden
        className="-mx-4 -my-2 h-[120px] bg-[url(/img/waves.jpg)] bg-cover bg-[center_46%] bg-no-repeat mix-blend-multiply [mask-image:linear-gradient(to_bottom,transparent,#000_22%,#000_78%,transparent)] sm:-mx-7 sm:h-[170px]"
      />

      {st && !st.enabled && (
        <section role="status" className="rounded-[28px] bg-frame px-5 py-4 text-sm text-[#F6F5F2]">
          The live stream is off. Add GRPC_URL and GRPC_TOKEN to .env and restart GodsEye. Until then it checks the busiest pools every 30 minutes.
        </section>
      )}

      <section className="grid grid-cols-2 gap-x-4 gap-y-5 px-1 lg:grid-cols-3">
        <Stat
          label="Stream"
          value={
            <span className="flex items-center gap-3">
              <span className={cn("h-3 w-3 shrink-0 rounded-full", connected ? "animate-pulsedot bg-violet shadow-[0_0_0_6px_rgba(139,99,255,.2)]" : "bg-loss")} aria-hidden />
              {st?.enabled ? (connected ? "Connected" : st.status ?? "Starting") : "Off"}
            </span>
          }
          sub={st?.lastAt ? `last trade ${ago(st.lastAt)}` : undefined}
          className="col-span-2 lg:col-span-1"
        />
        <Stat label="Memecoin trades" value={st?.swapsPerSec ?? "—"} unit="per second" sub={st?.txPerSec != null ? `${st.txPerSec} exchange transactions a second` : undefined} />
        <Stat label="Wallets seen today" value={st?.walletsSeen24h.toLocaleString("en-US") ?? "—"} sub={st ? `${st.walletsSeenTotal.toLocaleString("en-US")} in the last 30 days` : undefined} />
      </section>

      <Window
        title="Winning right now"
        right={
          <>
            <div className="flex gap-1.5" role="group" aria-label="Who">
              {KINDS.map((k) => (
                <button key={k.v} type="button" onClick={() => setKind(k.v)} aria-pressed={kind === k.v} className={cn("pill", kind === k.v ? "bg-frame text-white hover:bg-frame" : "")}>
                  {k.label}
                </button>
              ))}
            </div>
            <label className="pill pr-2">
              <span className="sr-only">Sort</span>
              <select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} className="cursor-pointer bg-transparent outline-none">
                {SORTS.map((o) => (
                  <option key={o.v} value={o.v}>{o.label}</option>
                ))}
              </select>
            </label>
          </>
        }
      >
        <p className="text-sm text-muted-foreground">Profit from trades GodsEye has watched live. Wallets that make $100+ over 3+ trades and win at least half get a full check.</p>
        <div className="mt-2">
          {error && <p className="py-3 text-sm text-loss">{error}</p>}
          {!error && rows.length === 0 && <Empty img="radar" title={data ? "Nobody yet" : "Loading…"}>{data ? "Wallets appear as the stream sees them trade." : "Fetching live wallets."}</Empty>}
          {rows.map((w, i) => {
            const status = w.tier ? null : w.promoted ? "Checking now" : "Not checked";
            const row = (
              <>
                <span className="w-7 shrink-0 text-xl font-light text-muted-foreground num">{i + 1}</span>
                <div className="min-w-0 flex-1">
                  <span className="font-mono" title={w.address}>{shortAddr(w.address)}</span>
                  <p className="k mt-0.5">
                    {kindLabel(w.live_kind)} · {w.live_closed ? `${w.live_closed} closed, ${w.live_wins} won` : `${w.swaps} trades`} · {w.volume_sol.toFixed(1)} SOL traded · {ago(w.last_seen_at)}
                  </p>
                </div>
                {w.tier ? <TierBadge tier={w.tier} /> : <span className={cn("tag", w.promoted && "bg-lilac")}>{status}</span>}
                <p className={cn("w-[110px] text-right text-2xl font-light num", pnlClass(w.live_pnl_usd))} title={`${signedSol(w.live_pnl_sol, 3)} SOL`}>{signedUsd(w.live_pnl_usd)}</p>
              </>
            );
            return w.tier ? (
              <Link key={w.address} href={`/wallets/${w.address}`} className="line transition-colors hover:text-violet-deep">{row}</Link>
            ) : (
              <div key={w.address} className="line">{row}</div>
            );
          })}
        </div>
        {(data?.length ?? 0) > 25 && (
          <div className="mt-3 flex justify-center">
            <button type="button" className="btn" onClick={() => setMore((v) => !v)}>{more ? "Show fewer" : `Show all ${data!.length}`}</button>
          </div>
        )}
        <p className="mt-4 text-xs text-muted-foreground">Live profit only counts trades seen since GodsEye started watching the wallet, so selling coins bought earlier isn&apos;t included.</p>
      </Window>
    </>
  );
}
