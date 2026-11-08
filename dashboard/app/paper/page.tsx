"use client";
import { PageHeader } from "@/components/page-header";
import { COPYING_LINKS, SubNav } from "@/components/nav";
import { Empty, Window } from "@/components/window";
import { WalletLink } from "@/components/wallet-badges";
import { DataState } from "@/components/data-state";
import { PaperEquityChart } from "@/components/charts/perf-charts";
import { usePoll } from "@/lib/use-poll";
import { ago, dexscreenerToken, pct, pnlClass, shortAddr, signedSol, sol } from "@/lib/format";
import type { PaperAccount, PaperAccountName, PaperData, PaperModelInfo } from "@/lib/types";
import { cn } from "@/lib/utils";

const NAMES: Record<PaperAccountName, string> = { brain: "Brain", baseline: "Baseline", explore: "Explore" };
const TILES: Record<PaperAccountName, string> = { brain: "bg-lime", baseline: "bg-lilac", explore: "bg-sun" };
const ABOUT: Record<PaperAccountName, string> = {
  brain: "The neural network picks which buys to copy, how much to stake and when to sell.",
  baseline: "Today's copying rules, on the same signals, for comparison.",
  explore: "The share of trades the network takes to try new things, kept apart from the Brain's record.",
};
const winPct = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `${n.toFixed(0)}%`);
const words = (s: string) => s.replace(/[._]+/g, " ").trim();
const metric = (v: number) => (Math.abs(v) >= 100 ? v.toLocaleString("en-US", { maximumFractionDigits: 1 }) : Number(v.toFixed(3)).toString());

function PaperTag() {
  return <span className="tag bg-sun text-ink">Paper money · no real SOL</span>;
}

/** One account's headline numbers. The Brain and Baseline get big tiles; Explore a smaller card. */
function AccountTile({ a, small }: { a: PaperAccount; small?: boolean }) {
  const rows: [string, React.ReactNode, string?][] = [
    ["P&L after fees", `${signedSol(a.pnlSol, 3)} SOL`, small ? pnlClass(a.pnlSol) : undefined],
    ["Win rate", winPct(a.winRate)],
    ["Worst drop", `${a.maxDrawdownPct.toFixed(1)}%`],
    ["Trades", `${a.closedTrades} closed · ${a.openTrades} open`],
  ];
  return (
    <div className={cn("min-w-0", small ? "card" : cn("tile", TILES[a.account]))}>
      <div className="flex items-center justify-between gap-2">
        <p className={cn("text-sm font-extrabold", small ? "text-foreground" : "text-ink")}>{NAMES[a.account]}</p>
        <p className={cn("text-xs font-bold", small ? "text-muted-foreground" : "text-ink/75")}>started with {sol(a.startingSol, 2)} SOL</p>
      </div>
      <p className={cn("mt-2 truncate num", small ? "text-2xl font-extrabold" : "big", small && pnlClass(a.returnPct))}>
        {pct(a.returnPct, 1)}
        <span className="unit">return</span>
      </p>
      <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
        {rows.map(([k, v, cls]) => (
          <div key={k} className="min-w-0">
            <dt className={cn("font-bold", small ? "text-muted-foreground" : "text-ink/75")}>{k}</dt>
            <dd className={cn("truncate font-extrabold num", cls)}>{v}</dd>
          </div>
        ))}
      </dl>
      <p className={cn("mt-3 line-clamp-2 text-xs font-medium", small ? "text-muted-foreground" : "text-ink/75")}>{ABOUT[a.account]}</p>
    </div>
  );
}

function ModelPanel({ m }: { m: PaperModelInfo | null }) {
  if (!m) return <Empty img="eye" title="No model yet">The Brain trades once its first trained model is loaded.</Empty>;
  const groups = [
    ["Validation", "on weeks it never trained on", m.metrics.validation],
    ["Stress", "on crash and rug-wave scenarios", m.metrics.stress],
    ["Baseline", "today's rules on the same weeks", m.metrics.baseline],
  ] as const;
  return (
    <>
      <p className="k">
        Version <span className="font-mono text-foreground">{m.version}</span>
        {m.createdAt ? ` · trained ${ago(m.createdAt)}` : ""}
        {m.loadedAt ? ` · in use since ${ago(m.loadedAt)}` : ""}
      </p>
      <div className="mt-3 grid gap-4 sm:grid-cols-3">
        {groups.map(([title, sub, vals]) => (
          <div key={title} className="min-w-0">
            <p className="text-sm font-extrabold">{title}</p>
            <p className="k">{sub}</p>
            {Object.keys(vals).length === 0 ? (
              <p className="mt-2 text-sm text-muted-foreground">—</p>
            ) : (
              <dl className="mt-2">
                {Object.entries(vals).map(([k, v]) => (
                  <div key={k} className="flex justify-between gap-3 border-t-2 border-ink/70 py-1.5 text-sm first:border-t-0">
                    <dt className="min-w-0 truncate text-muted-foreground">{words(k)}</dt>
                    <dd className="font-bold num">{metric(v)}</dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

export default function PaperPage() {
  const { data, error, stale, updatedAt } = usePoll<PaperData>("/api/paper", 30_000);
  const acct = (n: PaperAccountName) => data?.accounts.find((a) => a.account === n);
  const brain = acct("brain");
  const baseline = acct("baseline");
  const explore = acct("explore");
  const hasCurve = !!data && Object.values(data.equity).some((s) => s.length > 1);

  return (
    <>
      <PageHeader
        title="Paper AI"
        back="/copies"
        kicker="A neural network learning to copy trades better, practising with paper money next to today's rules. No real SOL is spent; real copying stays paused."
      >
        <SubNav links={COPYING_LINKS} />
      </PageHeader>

      <div className="flex flex-wrap items-center gap-2">
        <PaperTag />
        {data && (
          <span className="tag">
            <span className={cn("h-2.5 w-2.5 rounded-full border-2 border-ink", data.live.streaming ? "animate-pulsedot bg-lime" : "bg-coral")} aria-hidden />
            {data.live.streaming ? "Trading on the live stream" : "Waiting for live data"}
          </span>
        )}
      </div>
      <DataState error={error} stale={stale} updatedAt={updatedAt} what="the paper accounts" />
      {data && !data.live.streaming && (
        <p role="status" className="rounded-[14px] border-[2.5px] border-ink bg-sun px-3 py-2 text-sm font-bold text-ink">
          Waiting for live data — paper trading starts when the stream is back.
          {data.live.lastAt ? ` Last trade seen ${ago(data.live.lastAt)}.` : ""}
        </p>
      )}

      {data && !data.accounts.length ? (
        <div className="card">
          <Empty img="radar" title="No paper accounts yet">The Brain&apos;s paper accounts open with the first live trades.</Empty>
        </div>
      ) : (
        <>
          <section className="grid gap-4 md:grid-cols-2">
            {brain && <AccountTile a={brain} />}
            {baseline && <AccountTile a={baseline} />}
            {!data && <p className="k">Loading…</p>}
          </section>
          {explore && (
            <section className="grid gap-4 md:grid-cols-2">
              <AccountTile a={explore} small />
            </section>
          )}
        </>
      )}

      <Window title="Paper money over time" right={<PaperTag />}>
        {hasCurve ? (
          <PaperEquityChart equity={data!.equity} startingSol={brain?.startingSol ?? baseline?.startingSol ?? null} />
        ) : (
          <Empty img="wallet" title={data ? "No curve yet" : "Loading…"}>{data ? "The lines appear once the accounts have traded." : "Fetching the paper accounts."}</Empty>
        )}
        <p className="mt-3 text-xs text-muted-foreground">Equity in SOL after every fee and rent, open trades at their last price. The dashed line is the starting bankroll.</p>
      </Window>

      <Window title="Recent paper trades">
        {!data?.trades.length && <Empty img="eye" title={data ? "None yet" : "Loading…"}>{data ? "Closed paper trades appear here." : "Fetching paper trades."}</Empty>}
        {data?.trades.map((t, i) => (
          <div key={`${t.account}-${t.mint}-${t.closed_at}-${i}`} className="line">
            <span className={cn("tag shrink-0 text-ink", TILES[t.account])}>{NAMES[t.account]}</span>
            <div className="min-w-0 flex-1">
              <a href={dexscreenerToken(t.mint)} target="_blank" rel="noreferrer" className="font-extrabold underline-offset-2 hover:underline">{t.symbol ?? shortAddr(t.mint)}</a>
              <p className="k mt-0.5">
                {t.leader ? (
                  <>
                    copied <WalletLink address={t.leader} /> ·{" "}
                  </>
                ) : null}
                staked {sol(t.stake_sol, 3)} SOL · {t.exit_reason ? words(t.exit_reason) : "closed"} · {ago(t.closed_at)}
              </p>
            </div>
            <p className={cn("hidden text-right text-sm font-bold sm:block", pnlClass(t.pnl_sol))}>{signedSol(t.pnl_sol, 3)} SOL</p>
            <p className={cn("w-[96px] text-right text-2xl font-extrabold num", pnlClass(t.pnl_pct))} title={`${signedSol(t.pnl_sol, 3)} SOL`}>{pct(t.pnl_pct, 0)}</p>
          </div>
        ))}
      </Window>

      <Window title="The model">
        <ModelPanel m={data?.model ?? null} />
      </Window>
    </>
  );
}
