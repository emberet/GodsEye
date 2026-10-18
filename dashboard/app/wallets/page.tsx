"use client";
import { Suspense, useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { TIERS, TIER_DESCRIPTIONS, TIER_LABELS } from "@godseye/shared/constants";
import { PageHeader } from "@/components/page-header";
import { SubNav, WALLET_LINKS } from "@/components/nav";
import { Window } from "@/components/window";
import { Addr, KindBadge, TierBadge } from "@/components/wallet-badges";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { usePoll } from "@/lib/use-poll";
import { ago, pnlClass, signedSol } from "@/lib/format";
import type { WalletList } from "@/lib/types";
import { cn } from "@/lib/utils";

const SORTS = [
  { v: "pnl_30d", label: "30d P&L" },
  { v: "pnl_7d", label: "7d P&L" },
  { v: "weight", label: "Copy weight" },
  { v: "ai_score", label: "AI score" },
  { v: "last_activity", label: "Last active" },
  { v: "first_seen", label: "Newest found" },
];
const PAGE = 50;

export default function WalletsPage() {
  return (
    <Suspense fallback={<p className="text-sm text-muted-foreground">loading…</p>}>
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
  const rows = data?.rows ?? [];
  const pages = data ? Math.ceil(data.total / PAGE) : 0;

  return (
    <>
      <PageHeader title="Wallets" kicker={`${data?.total ?? "…"} wallets · public`}>
        <SubNav links={WALLET_LINKS} />
      </PageHeader>

      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="search address or funder…"
          aria-label="Search wallets"
          className="bevel-in bg-black px-1.5 py-1 text-xs text-foreground w-full outline-none placeholder:text-muted-foreground sm:w-64"
        />
        <select aria-label="Tier" value={tier} onChange={(e) => set({ tier: e.target.value })} className="bevel-in bg-black px-1.5 py-1 text-xs text-foreground" title={tier === "all" ? "" : TIER_DESCRIPTIONS[tier as (typeof TIERS)[number]]}>
          <option value="all">All tiers</option>
          {TIERS.map((t) => (
            <option key={t} value={t}>
              {TIER_LABELS[t]}
            </option>
          ))}
        </select>
        <select aria-label="AI or human" value={kind} onChange={(e) => set({ kind: e.target.value })} className="bevel-in bg-black px-1.5 py-1 text-xs text-foreground">
          <option value="all">AI + human</option>
          <option value="ai">AI / bot</option>
          <option value="human">Human</option>
          <option value="unknown">Undecided</option>
        </select>
        <select aria-label="Sort" value={sort} onChange={(e) => set({ sort: e.target.value })} className="bevel-in bg-black px-1.5 py-1 text-xs text-foreground">
          {SORTS.map((o) => (
            <option key={o.v} value={o.v}>
              Sort: {o.label}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1.5 text-muted-foreground">
          <input type="checkbox" checked={fresh} onChange={(e) => set({ fresh: e.target.checked ? "1" : null })} /> fresh only
        </label>
      </div>

      <Window title="Wallet database">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Wallet</TableHead>
              <TableHead>Tier</TableHead>
              <TableHead>AI / human</TableHead>
              <TableHead className="text-right">7d P&amp;L</TableHead>
              <TableHead className="text-right">30d P&amp;L</TableHead>
              <TableHead className="text-right">Wins</TableHead>
              <TableHead className="text-right">Trades 30d</TableHead>
              <TableHead className="text-right">Copy wt</TableHead>
              <TableHead>Group</TableHead>
              <TableHead>Active</TableHead>
              <TableHead>Why</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {error && (
              <TableRow>
                <TableCell colSpan={11} className="py-6 text-center text-loss">{error}</TableCell>
              </TableRow>
            )}
            {!error && rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={11} className="py-10 text-center text-muted-foreground">{data ? "No wallets match." : "loading…"}</TableCell>
              </TableRow>
            )}
            {rows.map((w) => (
              <TableRow key={w.address}>
                <TableCell>
                  <Addr address={w.address} />
                  {w.is_fresh === 1 && <span className="ml-1.5 border border-win/40 px-1 text-[10px] uppercase text-win">fresh</span>}
                </TableCell>
                <TableCell>
                  <TierBadge tier={w.tier} />
                </TableCell>
                <TableCell>
                  <KindBadge kind={w.kind} score={w.ai_score} />
                </TableCell>
                <TableCell className={cn("text-right", pnlClass(w.pnl_7d_sol))}>{signedSol(w.pnl_7d_sol, 2)}</TableCell>
                <TableCell className={cn("text-right font-bold", pnlClass(w.pnl_30d_sol))}>{signedSol(w.pnl_30d_sol, 2)}</TableCell>
                <TableCell className="text-right">{w.win_rate_30d === null ? "—" : `${Math.round(w.win_rate_30d * 100)}%`}</TableCell>
                <TableCell className="text-right">{w.swaps_30d ?? "—"}</TableCell>
                <TableCell className={cn("text-right", w.copy_weight > 0 ? "font-bold text-win" : "text-muted-foreground")}>{w.copy_weight > 0 ? `${(w.copy_weight * 100).toFixed(0)}%` : "—"}</TableCell>
                <TableCell className="text-muted-foreground">{w.group_size > 1 ? `${w.group_size} wallets` : "—"}</TableCell>
                <TableCell className="text-muted-foreground">{ago(w.last_activity_at)}</TableCell>
                <TableCell className="max-w-[320px] truncate text-xs text-muted-foreground" title={w.tier_reason ?? ""}>
                  {w.last_analyzed_at ? w.tier_reason : "queued for analysis"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {pages > 1 && (
          <div className="flex items-center justify-between border-t px-3 py-2 text-xs">
            <button disabled={page === 0} onClick={() => set({ page: String(page - 1) })} className="bevel-out bg-w95-gray px-2 py-0.5 text-black disabled:opacity-40">
              ← prev
            </button>
            <span className="text-muted-foreground">
              page {page + 1} / {pages}
            </span>
            <button disabled={page + 1 >= pages} onClick={() => set({ page: String(page + 1) })} className="bevel-out bg-w95-gray px-2 py-0.5 text-black disabled:opacity-40">
              next →
            </button>
          </div>
        )}
        <p className="border-t px-3 py-2 text-[11px] text-muted-foreground">
          P&amp;L is realized profit in SOL from swaps GodsEye has seen (SOL-priced only). Labels are automated reads of on-chain behaviour, not accusations.
          Each wallet&apos;s page lists the evidence behind its label.
        </p>
      </Window>
    </>
  );
}
