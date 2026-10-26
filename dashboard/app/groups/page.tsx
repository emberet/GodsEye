"use client";
import { PageHeader } from "@/components/page-header";
import { SubNav, WALLET_LINKS } from "@/components/nav";
import { Empty, Window } from "@/components/window";
import { KindBadge, TierBadge, WalletDot, WalletLink, WalletPageLink } from "@/components/wallet-badges";
import { usePoll } from "@/lib/use-poll";
import { ago, pnlClass, signedUsd } from "@/lib/format";
import type { WalletGroup } from "@/lib/types";
import { cn } from "@/lib/utils";

export default function GroupsPage() {
  const { data, error } = usePoll<WalletGroup[]>("/api/groups", 30_000);
  const groups = data ?? [];
  return (
    <>
      <PageHeader title="New wallets by funder" kicker="Wallets that got their first SOL from the same address are grouped together.">
        <SubNav links={WALLET_LINKS} />
      </PageHeader>
      {error && <p className="card text-sm text-loss">{error}</p>}
      {data && groups.length === 0 && (
        <div className="card">
          <Empty img="wallet" title="No groups yet">They appear as GodsEye studies new wallets.</Empty>
        </div>
      )}
      <div className="grid gap-5 lg:grid-cols-2">
        {groups.map((g) => (
          <Window
            key={g.funder}
            title={<WalletLink address={g.funder} />}
            right={<span className="text-muted-foreground">{g.size} wallet{g.size === 1 ? "" : "s"} · newest {ago(g.newest_at)}</span>}
          >
            <div className="flex flex-wrap items-center gap-2 text-sm">
              {g.funder_tier && <TierBadge tier={g.funder_tier} />}
              {g.likely_exchange && <span className="tag bg-sun text-ink">Probably an exchange</span>}
              <span className="tag">{g.ai} bots</span>
              <span className="tag">{g.human} humans</span>
              {g.unknown > 0 && <span className="tag text-muted-foreground">{g.unknown} undecided</span>}
              {g.fresh > 0 && <span className="tag bg-coral text-ink">{g.fresh} new</span>}
            </div>
            <div className="mt-2">
              {g.members.map((m) => (
                <div key={m.address} className="line flex-wrap">
                  <WalletDot address={m.address} tier={m.tier} className="h-9 w-9 text-xs" />
                  <WalletLink address={m.address} />
                  <TierBadge tier={m.tier} />
                  <KindBadge kind={m.kind} score={null} />
                  <span className={cn("ml-auto text-lg font-extrabold num", pnlClass(m.pnl_30d_usd))} title="Realized profit, last 30 days (as far back as GodsEye has read)">{signedUsd(m.pnl_30d_usd)}<span className="unit">30d</span></span>
                  <WalletPageLink address={m.address} />
                </div>
              ))}
            </div>
          </Window>
        ))}
      </div>
    </>
  );
}
