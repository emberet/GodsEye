"use client";
import { PageHeader } from "@/components/page-header";
import { COPYING_LINKS, SubNav } from "@/components/nav";
import { Empty, Window } from "@/components/window";
import { WalletLink } from "@/components/wallet-badges";
import { DataState } from "@/components/data-state";
import { PaperEquityChart } from "@/components/charts/perf-charts";
import { SkeletonRows } from "@/components/skeleton";
import { usePoll } from "@/lib/use-poll";
import { ago, dexscreenerToken, pct, pnlClass, pnlPeriod, shortAddr, signedSol, signedUsd, sol } from "@/lib/format";
import type { PaperAccount, PaperAccountName, PaperData, PaperModelInfo, Summary } from "@/lib/types";
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

/** The model in plain words: when it was made, since when it trades, and whether it may trade real money. */
function ModelPanel({ m, sleeve }: { m: PaperModelInfo | null; sleeve: NonNullable<Summary["real"]>["sleeve"] | null }) {
  if (!m) return <Empty img="eye" title="No model yet">The Brain starts paper trading once its first trained model is loaded.</Empty>;
  const real = !m.realMoney
    ? "Paper only. This model hasn't passed the safety check that real money needs, so the rules decide every real copy."
    : sleeve?.state === "off"
      ? "Passed the safety check, but the owner has set the rules to decide every real copy for now."
      : sleeve?.state === "on"
        ? `Passed the safety check: it decides ${sleeve.sharePct ?? 50}% of real copies, with every safety rule of the rules' trades.`
        : "Passed the safety check: it starts on real copies within minutes.";
  return (
    <dl className="grid gap-4 sm:grid-cols-3">
      <div className="min-w-0">
        <dt className="k">Trained</dt>
        <dd className="mt-1 text-lg font-extrabold">{m.createdAt ? ago(m.createdAt) : "—"}</dd>
      </div>
      <div className="min-w-0">
        <dt className="k">Trading on paper since</dt>
        <dd className="mt-1 text-lg font-extrabold">{m.loadedAt ? ago(m.loadedAt) : "—"}</dd>
      </div>
      <div className="min-w-0 sm:col-span-3">
        <dt className="k">Real money</dt>
        <dd className="mt-1 text-sm font-bold">{real}</dd>
      </div>
    </dl>
  );
}

const HOW = [
  ["It looks at a buy", "When a wallet GodsEye follows buys a coin, one network estimates whether copying it would make money once fees and delay are paid, and how much to put in."],
  ["It watches the trade", "A second network keeps checking the open trade and picks: hold, sell half, or sell all."],
  ["It learns from the past", "Both learn by replaying millions of stored trades in a simulator that charges real fees and the delay a copy really has. Every night they train again on the newest days."],
  ["It has to pass a check", "Before a new model is used, it is tested on days it never trained on and next to today's rules. Real money needs a stricter safety check on top."],
] as const;

export default function BrainPage() {
  const { data, error, stale, updatedAt } = usePoll<PaperData>("/api/paper", 30_000);
  const { data: s } = usePoll<Summary>("/api/summary", 30_000);
  const realBrain = s?.real?.deciders.find((r) => r.decider === "brain");
  const realRules = s?.real?.deciders.find((r) => r.decider === "rules");
  const acct = (n: PaperAccountName) => data?.accounts.find((a) => a.account === n);
  const brain = acct("brain");
  const baseline = acct("baseline");
  const explore = acct("explore");
  const hasCurve = !!data && Object.values(data.equity).some((s) => s.length > 1);

  return (
    <>
      <PageHeader
        title="Brain"
        back="/copies"
        kicker="A neural network learning to copy trades better. It practises with paper money next to today's rules, and trades real money only after passing a safety check."
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

      <section className="card">
        <h2 className="text-xl font-extrabold tracking-[-0.02em]">What it is</h2>
        <ol className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {HOW.map(([t, d], i) => (
            <li key={t} className="min-w-0">
              <p className="flex items-center gap-2 font-extrabold">
                <span className="dot h-7 w-7 bg-sun text-sm text-ink" aria-hidden>{i + 1}</span>
                {t}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">{d}</p>
            </li>
          ))}
        </ol>
      </section>

      {realBrain && realRules && (realBrain.closed > 0 || realBrain.open > 0) && (
        <section className="card">
          <h2 className="text-xl font-extrabold tracking-[-0.02em]">Real money, {pnlPeriod(s?.pnlSince)}</h2>
          <div className="mt-3 grid grid-cols-2 gap-4">
            {[realBrain, realRules].map((r) => (
              <div key={r.decider} className="min-w-0">
                <p className="k">{r.decider === "brain" ? "Brain" : "Rules"}</p>
                <p className={cn("mt-1 text-2xl font-extrabold num", pnlClass(r.pnlUsd))}>{signedUsd(r.pnlUsd)}</p>
                <p className="text-xs text-muted-foreground">{r.closed ? `${r.won} of ${r.closed} won` : "none closed"} · {r.open} open</p>
              </div>
            ))}
          </div>
        </section>
      )}

      <h2 className="-mb-2 text-2xl font-black tracking-[-0.02em]">Three paper accounts, side by side</h2>
      {data && !data.accounts.length ? (
        <div className="card">
          <Empty img="radar" title="No paper accounts yet">The Brain&apos;s paper accounts open with the first live trades.</Empty>
        </div>
      ) : (
        <>
          <section className="grid gap-4 md:grid-cols-2">
            {brain && <AccountTile a={brain} />}
            {baseline && <AccountTile a={baseline} />}
            {!data && <div className="card md:col-span-2"><SkeletonRows rows={2} /></div>}
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
          data ? <Empty img="wallet" title="No curve yet">The lines appear once the accounts have traded.</Empty> : <SkeletonRows rows={2} />
        )}
        <p className="mt-3 text-xs text-muted-foreground">Equity in SOL after every fee and rent, open trades at their last price. The dashed line is the starting bankroll.</p>
      </Window>

      <Window title="Recent paper trades">
        {!data && <SkeletonRows />}
        {data && !data.trades.length && <Empty img="eye" title="None yet">Closed paper trades appear here.</Empty>}
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

      <Window title="The model in use">
        {data ? <ModelPanel m={data.model} sleeve={s?.real?.sleeve ?? null} /> : <SkeletonRows rows={1} />}
      </Window>
    </>
  );
}
