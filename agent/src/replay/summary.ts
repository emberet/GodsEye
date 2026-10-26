/** Rolls replayed episodes up into the numbers that say whether a leader is still worth copying at a given delay. */
import { type Episode, median } from "./model";

export interface Summary {
  delaySec: number;
  /** Positions the copy engine would have opened. */
  n: number;
  /** Of those, still open when the data ended (marked at the last price). */
  open: number;
  winRate: number | null;
  /** Mean / median return on cost per position, %. */
  meanRetPct: number | null;
  medianRetPct: number | null;
  /** Half-width of the 95% interval on the mean return, %. */
  ciHalfPct: number | null;
  netSol: number;
  /** The same positions on the leader's side (leader's fills, no costs, no delay), mean return %. */
  idealMeanRetPct: number | null;
  /** Ideal minus real, mean percentage points per position: what copying cost. */
  copyCostPp: number | null;
  /** Our entry price ÷ the leader's − 1, mean and median, %. */
  meanDriftPct: number | null;
  medianDriftPct: number | null;
  /** Share of the net profit from the best 1 and best 3 positions (null unless net profit is positive). */
  top1Share: number | null;
  top3Share: number | null;
  /** Median seconds from the leader's entry to its first sell, over positions where it sold. */
  medianLeaderHoldSec: number | null;
  /** Share of entries where the tape saw ≥ 3 swaps by other wallets within ±2 min. */
  coverage: number | null;
}

const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

function ci95(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const m = mean(xs)!;
  const sd = Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
  return 1.96 * (sd / Math.sqrt(xs.length));
}

/** `ideal` = the same leader's episodes replayed with ideal fills, matched to `real` by the leader's entry swap. */
export function summarize(delaySec: number, real: Episode[], ideal: Episode[]): Summary {
  const idealBy = new Map(ideal.map((e) => [e.entrySignature, e]));
  const rets = real.map((e) => e.retPct);
  const pairs = real.flatMap((e) => {
    const i = idealBy.get(e.entrySignature);
    return i ? [{ real: e.retPct, ideal: i.retPct }] : [];
  });
  const net = real.reduce((a, e) => a + e.pnlSol, 0);
  const best = real.map((e) => e.pnlSol).sort((a, b) => b - a);
  const share = (k: number) => (net > 0 ? best.slice(0, k).reduce((a, b) => a + b, 0) / net : null);
  const pct = (x: number | null) => (x === null ? null : x * 100);
  return {
    delaySec,
    n: real.length,
    open: real.filter((e) => !e.closed).length,
    winRate: real.length ? real.filter((e) => e.pnlSol > 0).length / real.length : null,
    meanRetPct: mean(rets),
    medianRetPct: median(rets),
    ciHalfPct: ci95(rets),
    netSol: net,
    idealMeanRetPct: mean(pairs.map((p) => p.ideal)),
    copyCostPp: mean(pairs.map((p) => p.ideal - p.real)),
    meanDriftPct: pct(mean(real.map((e) => e.entryDrift))),
    medianDriftPct: pct(median(real.map((e) => e.entryDrift))),
    top1Share: share(1),
    top3Share: share(3),
    medianLeaderHoldSec: median(real.flatMap((e) => (e.leaderFirstSellSec === null ? [] : [e.leaderFirstSellSec]))),
    coverage: real.length ? real.filter((e) => e.density >= 3).length / real.length : null,
  };
}

const f1 = (x: number | null, suffix = ""): string => (x === null ? "—" : `${x >= 0 ? "" : "−"}${Math.abs(x).toFixed(1)}${suffix}`);
const share = (x: number | null): string => (x === null ? "—" : `${Math.round(x * 100)}%`);

export function formatTable(rows: Summary[]): string {
  const head = ["delay", "n", "open", "win", "mean ret", "±95%", "median", "net SOL", "leader ret", "copy cost", "drift", "top1", "top3", "leader hold", "tape"];
  const body = rows.map((s) => [
    `${s.delaySec}s`,
    String(s.n),
    String(s.open),
    share(s.winRate),
    f1(s.meanRetPct, "%"),
    s.ciHalfPct === null ? "—" : f1(s.ciHalfPct),
    f1(s.medianRetPct, "%"),
    s.netSol.toFixed(3),
    f1(s.idealMeanRetPct, "%"),
    f1(s.copyCostPp, "pp"),
    f1(s.medianDriftPct, "%"),
    share(s.top1Share),
    share(s.top3Share),
    s.medianLeaderHoldSec === null ? "—" : s.medianLeaderHoldSec < 120 ? `${Math.round(s.medianLeaderHoldSec)}s` : `${Math.round(s.medianLeaderHoldSec / 60)}m`,
    share(s.coverage),
  ]);
  const widths = head.map((h, c) => Math.max(h.length, ...body.map((r) => r[c].length)));
  const line = (r: string[]) => r.map((x, c) => (c === 0 ? x.padEnd(widths[c]) : x.padStart(widths[c]))).join("  ");
  return [line(head), ...body.map(line)].join("\n");
}
