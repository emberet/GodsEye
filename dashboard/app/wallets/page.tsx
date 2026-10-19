"use client";
import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ChevronRight, Search } from "lucide-react";
import { TIERS, TIER_DESCRIPTIONS, TIER_LABELS } from "@godseye/shared/constants";
import { PageHeader } from "@/components/page-header";
import { SubNav, WALLET_LINKS } from "@/components/nav";
import { Empty } from "@/components/window";
import { KindBadge, TierBadge, WalletDot } from "@/components/wallet-badges";
import { usePoll } from "@/lib/use-poll";
import { pnlClass, shortAddr, signedSol, signedUsd, spanLabel } from "@/lib/format";
import type { Summary, WalletList } from "@/lib/types";
import { cn } from "@/lib/utils";

const SORTS = [
  { v: "pnl_30d", label: "Biggest profit" },
  { v: "pnl_7d", label: "Biggest profit this week" },
  { v: "weight", label: "Copied most" },
  { v: "ai_score", label: "Most bot-like" },
  { v: "last_activity", label: "Active most recently" },
  { v: "first_seen", label: "Found most recently" },
];
const KINDS = [
  { v: "all", label: "Bots + humans" },
  { v: "ai", label: "Bots" },
  { v: "human", label: "Humans" },
  { v: "unknown", label: "Undecided" },
];
const PAGE = 30;

export default function WalletsPage() {
  return (
    <Suspense fallback={<p className="text-sm text-muted-foreground">Loading…</p>}>
      <WalletDatabase />
    </Suspense>
  );
}

function WalletDatabase() {
  const router = useRouter();
  const path = usePathname();
  const sp = useSearchParams();
  const tier = sp.get("tier") ?? "all";
  const kind = sp.get("kind") ?? "all";
  const sort = sp.get("sort") ?? "pnl_30d";
  const fresh = sp.get("fresh") === "1";
  const page = Number(sp.get("page") ?? 0);
  const [q, setQ] = useState(sp.get("q") ?? "");

  const set = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(patch)) (v === null || v === "" || v === "all" ? next.delete(k) : next.set(k, v));
    if (!("page" in patch)) next.delete("page");
    router.replace(`${path}?${next.toString()}`, { scroll: false });
  };
  useEffect(() => {
    const t = setTimeout(() => q !== (sp.get("q") ?? "") && set({ q }), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const api = new URLSearchParams({ sort, limit: String(PAGE), offset: String(page * PAGE) });
  if (tier !== "all") api.set("tier", tier);
  if (kind !== "all") api.set("kind", kind);
  if (fresh) api.set("fresh", "1");
  if (sp.get("q")) api.set("q", sp.get("q")!);
  const { data, error } = usePoll<WalletList>(`/api/wallets?${api.toString()}`, 30_000);
  const { data: s } = usePoll<Summary>("/api/summary", 30_000);
  const rows = data?.rows ?? [];
  const pages = data ? Math.ceil(data.total / PAGE) : 0;

  return (
    <>
      <PageHeader title="Wallets" kicker="Every wallet GodsEye has studied, and what it thinks of each one.">
        <SubNav links={WALLET_LINKS} />
      </PageHeader>

      <section className="flex flex-wrap items-center gap-x-7 gap-y-4">
        <label className="flex min-h-[58px] flex-1 basis-[320px] items-center gap-2.5 rounded-[16px] border-[3px] border-ink bg-card pl-4 pr-2 shadow-hard focus-within:outline focus-within:outline-[3px] focus-within:outline-lime">
          <Search size={20} strokeWidth={1.8} className="shrink-0 text-muted-foreground" aria-hidden />
          <span className="sr-only">Search wallets</span>
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Paste a wallet or funder address"
            className="min-h-[48px] min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-muted-foreground"
          />
        </label>
        <div className="flex gap-7 px-1">
          <div>
            <p className="k">Studied</p>
            <p className="mt-0.5 text-[34px] font-extrabold leading-none num">{s?.walletsTracked.toLocaleString("en-US") ?? "—"}</p>
          </div>
          <div>
            <p className="k">Seen live today</p>
            <p className="mt-0.5 text-[34px] font-extrabold leading-none num">{s?.stream.walletsSeen24h.toLocaleString("en-US") ?? "—"}</p>
          </div>
        </div>
      </section>

      <section className="flex flex-wrap items-center gap-2" aria-label="Filter wallets">
        <button type="button" onClick={() => set({ tier: null })} aria-pressed={tier === "all"} className={cn("pill", tier === "all" && "pill-on")}>
          All
        </button>
        {TIERS.map((t) => (
          <button key={t} type="button" title={TIER_DESCRIPTIONS[t]} onClick={() => set({ tier: tier === t ? null : t })} aria-pressed={tier === t} className={cn("pill", tier === t && "pill-on")}>
            {t === "proven" && <span className="h-2.5 w-2.5 rounded-full border-2 border-ink bg-lime" aria-hidden />}
            {TIER_LABELS[t]}
            {s && <span className="text-muted-foreground num">{s.tierCounts[t]}</span>}
          </button>
        ))}
        <span className="hidden flex-1 lg:block" />
        <label className="pill pr-2">
          <span className="sr-only">Bots or humans</span>
          <select value={kind} onChange={(e) => set({ kind: e.target.value })} className="cursor-pointer bg-transparent outline-none">
            {KINDS.map((k) => (
              <option key={k.v} value={k.v}>{k.label}</option>
            ))}
          </select>
        </label>
        <label className="pill pr-2">
          <span className="sr-only">Sort</span>
          <select value={sort} onChange={(e) => set({ sort: e.target.value })} className="cursor-pointer bg-transparent outline-none">
            {SORTS.map((o) => (
              <option key={o.v} value={o.v}>{o.label}</option>
            ))}
          </select>
        </label>
        <button type="button" onClick={() => set({ fresh: fresh ? null : "1" })} aria-pressed={fresh} className={cn("pill", fresh && "pill-on")}>
          New wallets only
        </button>
      </section>

      <section className="flex flex-col gap-2.5" aria-label="Wallets">
        {error && <p className="card text-sm text-loss">{error}</p>}
        {!error && rows.length === 0 && (
          <div className="card">
            <Empty img="wallet" title={data ? "No wallets match" : "Loading…"}>{data ? "Try another filter, or clear the search." : "Fetching wallets."}</Empty>
          </div>
        )}
        {rows.map((w) => (
          <Link key={w.address} href={`/wallets/${w.address}`} className="group flex flex-wrap items-center gap-x-4 gap-y-3 rounded-[18px] border-[3px] border-ink bg-card px-4 py-4 shadow-hard transition-transform hover:-translate-y-0.5 sm:px-5">
            <WalletDot address={w.address} tier={w.tier} />
            <div className="min-w-0 flex-1 basis-[260px]">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-[15px]" title={w.address}>{shortAddr(w.address)}</span>
                <TierBadge tier={w.tier} />
                {w.kind !== "unknown" && <KindBadge kind={w.kind} score={null} />}
                {w.is_fresh === 1 && <span className="tag bg-coral text-ink">New wallet</span>}
                {w.is_smart === 1 && <span className="tag bg-sun text-ink" title="GodsEye counts this wallet as smart money">Smart money</span>}
                {w.copy_weight > 0 && <span className="tag bg-cream text-ink">Copied</span>}
              </div>
              <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{w.last_analyzed_at ? w.tier_reason : "Queued for a full look."}</p>
            </div>
            <div className="ml-auto flex items-center gap-6 sm:gap-8">
              <div className="text-right">
                <p className="k">Wins</p>
                <p className="text-[22px] font-extrabold num" title={`${w.closed_30d ?? 0} closed trades`}>
                  {w.win_rate_30d === null ? "—" : `${Math.round(w.win_rate_30d * 100)}%`}
                  <span className="unit">{w.closed_30d ? `of ${w.closed_30d}` : "none closed"}</span>
                </p>
              </div>
              <div className="w-[120px] text-right" title={`${signedSol(w.pnl_30d_sol, 2)} SOL`}>
                <p className="k" title={w.history_from ? `GodsEye has this wallet's trades since ${w.history_from.slice(0, 16).replace("T", " ")} UTC` : undefined}>{spanLabel(w.history_from)}</p>
                <p className={cn("text-[26px] font-extrabold num", pnlClass(w.pnl_30d_usd))}>{signedUsd(w.pnl_30d_usd)}</p>
              </div>
              <span className="dot hidden bg-cream transition-colors group-hover:bg-lilac sm:inline-flex" aria-hidden>
                <ChevronRight size={16} strokeWidth={1.8} />
              </span>
            </div>
          </Link>
        ))}
      </section>

      {pages > 1 && (
        <nav className="flex items-center justify-center gap-3" aria-label="Pages">
          <button type="button" disabled={page === 0} onClick={() => set({ page: String(page - 1) })} className="btn">Newer</button>
          <span className="text-sm text-muted-foreground num">Page {page + 1} of {pages}</span>
          <button type="button" disabled={page + 1 >= pages} onClick={() => set({ page: String(page + 1) })} className="btn">More</button>
        </nav>
      )}

      <p className="px-1 text-xs text-muted-foreground">
        Profit is realized profit in dollars, valued when each trade settled, from memecoin trades paid in SOL, USDC or USDT. It covers the trades GodsEye has read for each wallet, shown above each figure: for busy wallets that can be only a day or two, not 30 days. Labels are automated reads of on-chain behaviour, not accusations;
        each wallet&apos;s page shows the evidence.
      </p>
    </>
  );
}
