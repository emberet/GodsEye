"use client";
import { PageHeader } from "@/components/page-header";
import { LIVE_LINKS, SubNav } from "@/components/nav";
import { Empty, Window } from "@/components/window";
import { Stat } from "@/components/stat";
import { WalletLink } from "@/components/wallet-badges";
import { DataState } from "@/components/data-state";
import { usePoll } from "@/lib/use-poll";
import { ago, dexscreenerToken, dollars, shortAddr } from "@/lib/format";
import type { RunnersData } from "@/lib/types";
import { cn } from "@/lib/utils";

const LABELS: Record<string, string> = { organic: "Trader", insider: "Insider", sniper: "Sniper", bot: "Bot", kol: "Caller on X" };
const x = (n: number | null | undefined, d = 1) => (n === null || n === undefined ? "—" : `${n.toFixed(d)}x`);
const pctOf = (n: number | null | undefined, d = 1) => (n === null || n === undefined ? "—" : `${(n * 100).toFixed(d)}%`);

export default function RunnersPage() {
  const { data, error, stale, updatedAt } = usePoll<RunnersData>("/api/runners", 60_000);
  const def = data?.definition;

  return (
    <>
      <PageHeader title="Runners" kicker="Coins that really ran, and who keeps buying them early. Research only: GodsEye doesn't copy these wallets.">
        <SubNav links={LIVE_LINKS} />
      </PageHeader>

      <section className="grid grid-cols-2 gap-4 lg:grid-cols-3">
        <Stat tile="bg-lime" label="Runners, last 7 days" value={def?.runners ?? "—"} sub={def ? `of ${def.coins.toLocaleString("en-US")} coins that drew a crowd` : undefined} />
        <Stat tile="bg-sun" label="A runner reaches" value={def ? dollars(def.mcapCutUsd) : "—"} sub={def ? `${def.minMultiple}x from its first price, ${def.minMinutesAbove5x}+ minutes at 5x` : undefined} />
        <Stat tile="bg-lilac" label="Coins watched" value={data?.coinsWatched.toLocaleString("en-US") ?? "—"} sub={def ? `cut-off updated ${ago(def.at)}` : undefined} className="col-span-2 lg:col-span-1" />
      </section>

      <Window title="Who catches them early">
        <p className="text-sm text-muted-foreground">
          Hit rate = runners bought early ÷ every launch bought early. A wallet that buys every launch can&apos;t beat the base rate; a ✔ means it does, over 3+ runners on 3+ days.
        </p>
        <div className="mt-2">
          <DataState error={error} stale={stale} updatedAt={updatedAt} what="runner-catchers" />
          {(!error || stale) && !data?.catchers.length && <Empty img="radar" title={data ? "Nobody yet" : "Loading…"}>{data ? "Wallets appear once runners have been watched from launch." : "Fetching runner-catchers."}</Empty>}
          {data?.catchers.map((c) => (
            <div key={c.wallet} className="line">
              <span className={cn("w-7 shrink-0 text-xl font-extrabold", c.qualifies ? "text-lime" : "text-muted-foreground")} aria-label={c.qualifies ? "Beats the base rate" : undefined}>{c.qualifies ? "✔" : "·"}</span>
              <div className="min-w-0 flex-1">
                <WalletLink address={c.wallet} />
                <p className="k mt-0.5">
                  {c.hits} runners early{c.early_buys ? ` of ${c.early_buys.toLocaleString("en-US")} launches bought` : ""} · {c.days} days · bought at {x(c.median_entry_x)} the first price · peak {x(c.median_x_to_peak, 0)} its entry
                  {c.capture !== null ? ` · sold at ${x(c.capture)}` : ""}
                  {c.x_handle ? ` · @${c.x_handle}` : ""}
                </p>
              </div>
              <span className="tag">{LABELS[c.label] ?? c.label}</span>
              <p className="w-[110px] text-right text-2xl font-extrabold num" title={`at least ${pctOf(c.hit_rate_lb)} (base rate ${pctOf(c.base_rate, 2)})`}>{c.early_buys ? pctOf(c.hit_rate) : "—"}</p>
            </div>
          ))}
        </div>
      </Window>

      <Window title="Who posts them on X first">
        <p className="text-sm text-muted-foreground">Accounts that posted a coin before it reached 3x, judged against the coins they posted that didn&apos;t run.</p>
        <div className="mt-2">
          {!data?.callers.length && <Empty img="eye" title="Nobody yet">{data ? "Accounts appear once runners have been searched on X." : "Loading…"}</Empty>}
          {data?.callers.map((c, i) => (
            <div key={c.username ?? i} className="line">
              <div className="min-w-0 flex-1">
                {c.username ? <a href={`https://x.com/${c.username}`} target="_blank" rel="noreferrer" className="font-extrabold underline-offset-2 hover:underline">@{c.username}</a> : "—"}
                <p className="k mt-0.5">
                  {c.early_runner_calls} of {c.runner_calls} runners posted early · {c.control_calls} non-runners · {c.median_lead_min !== null ? `${Math.round(c.median_lead_min)} min ahead` : "—"} · {c.days} days
                  {c.followers !== null ? ` · ${c.followers.toLocaleString("en-US")} followers` : ""}
                </p>
              </div>
              <p className="w-[110px] text-right text-2xl font-extrabold num" title="Hit rate, lower bound">≥{pctOf(c.hit_rate_lb)}</p>
            </div>
          ))}
        </div>
      </Window>

      <Window title="Recent runners">
        {!data?.runners.length && <Empty img="eye" title="None yet">{data ? "Runners appear as the live stream watches launches." : "Loading…"}</Empty>}
        {data?.runners.map((r) => (
          <div key={r.mint} className="line">
            <div className="min-w-0 flex-1">
              <a href={dexscreenerToken(r.mint)} target="_blank" rel="noreferrer" className="font-extrabold underline-offset-2 hover:underline">{r.symbol ?? shortAddr(r.mint)}</a>
              <p className="k mt-0.5">
                launched {ago(r.first_seen)} · {r.buyers} early buyers · {r.minutes_above_5x} min at 5x · {r.source === "stream" ? "watched from launch" : "read back from Solana"}
              </p>
            </div>
            <p className="text-right text-sm font-bold text-muted-foreground">peak {dollars(r.peak_mcap_usd)}</p>
            <p className="w-[110px] text-right text-2xl font-extrabold num">{x(r.multiple, 0)}</p>
          </div>
        ))}
      </Window>
    </>
  );
}
