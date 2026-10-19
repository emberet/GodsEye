/**
 * SELF-ADJUSTING THRESHOLDS — the bar for following a wallet isn't fixed:
 * GodsEye learns it from how following actually worked out.
 *
 * Today one parameter is learned: the minimum win rate a wallet needs before
 * GodsEye copies it or counts it as smart money ("follow_min_win_rate").
 *
 * Every outcome GodsEye can measure is tagged with the leader's win rate at
 * the time it acted:
 *   • its own copy trades (closed positions, % return in USD), once there are enough;
 *   • until then, "shadow copies": the measured move after every smart-wallet buy —
 *     what copying that buy would have done — 6 hours later, or 1 hour later while
 *     there are too few 6-hour results yet.
 * Each learning cycle it finds the LOWEST win-rate bar whose wallets still produced
 * a positive median result (with at least FOLLOW_MIN_SAMPLES outcomes). If no bar pays,
 * it goes stricter. It moves at most FOLLOW_MAX_STEP per cycle, stays within
 * [FOLLOW_WIN_RATE_FLOOR, FOLLOW_WIN_RATE_CEILING], and records every change and why.
 */
import { type DB, nowIso } from "@godseye/shared";
import { config } from "../config";
import { say } from "../log";

export interface Outcome {
  /** The leader's win rate (0–1) when it made the trade / when GodsEye copied it. */
  winRate: number;
  /** Result in % (copy: realized USD return; shadow: 6-hour move after the buy). */
  ret: number;
}

export interface ThresholdCfg {
  floor: number;
  ceiling: number;
  maxStep: number;
  minSamples: number;
}

export interface Learned {
  value: number;
  /** Where the evidence points (before limiting the step). */
  target: number;
  changed: boolean;
  reason: string;
}

const median = (xs: number[]) => {
  const v = [...xs].sort((a, b) => a - b);
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};
const pctStr = (x: number) => `${Math.round(x * 100)}%`;
const retStr = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}%`;
const round2 = (x: number) => Math.round(x * 100) / 100;

/** Pure: learn the follow win-rate bar from outcomes. */
export function learnWinRateThreshold(outcomes: Outcome[], current: number, cfg: ThresholdCfg, source: string): Learned {
  if (outcomes.length < cfg.minSamples) {
    return { value: current, target: current, changed: false, reason: `waiting for data: ${outcomes.length}/${cfg.minSamples} measured ${source}` };
  }
  // Candidate bars from floor to ceiling in 5-point steps.
  const bars: number[] = [];
  for (let b = cfg.floor; b <= cfg.ceiling + 1e-9; b += 0.05) bars.push(round2(b));
  let target: number | null = null;
  let evidence = "";
  for (const bar of bars) {
    const above = outcomes.filter((o) => o.winRate >= bar).map((o) => o.ret);
    if (above.length < cfg.minSamples) break; // not enough evidence this high
    const med = median(above);
    if (med >= 0) {
      target = bar;
      const below = outcomes.filter((o) => o.winRate < bar).map((o) => o.ret);
      evidence =
        `following wallets with ≥ ${pctStr(bar)} wins: median ${retStr(med)} (${above.length} ${source})` +
        (below.length ? `; below that: median ${retStr(median(below))} (${below.length})` : "");
      break;
    }
  }
  if (target === null) {
    target = cfg.ceiling;
    evidence = `no win-rate bar between ${pctStr(cfg.floor)} and ${pctStr(cfg.ceiling)} produced a positive median (${outcomes.length} ${source}) — getting stricter`;
  }
  const step = Math.max(-cfg.maxStep, Math.min(cfg.maxStep, target - current));
  const value = round2(Math.max(cfg.floor, Math.min(cfg.ceiling, current + step)));
  const changed = Math.abs(value - current) >= 0.005;
  return { value, target, changed, reason: changed ? `${pctStr(current)} → ${pctStr(value)}: ${evidence}` : `stays ${pctStr(value)}: ${evidence}` };
}

export const FOLLOW_MIN_WIN_RATE = "follow_min_win_rate";

/** The current learned value (or the configured starting point). */
export function getParam(db: DB, key: string, fallback: number): number {
  const r = db.prepare("SELECT value FROM learning_params WHERE key = ?").get(key) as { value: number } | undefined;
  return r?.value ?? fallback;
}

/** Outcomes to learn from: real copies when there are enough, otherwise shadow copies of smart buys. */
export function gatherOutcomes(db: DB, minSamples: number): { outcomes: Outcome[]; source: string } {
  const since = new Date(Date.now() - 14 * 86_400_000).toISOString();
  const copies = db
    .prepare("SELECT leader_win_rate w, pnl_pct r FROM positions WHERE status = 'closed' AND closed_at >= ? AND leader_win_rate IS NOT NULL AND pnl_pct IS NOT NULL")
    .all(since) as { w: number; r: number }[];
  if (copies.length >= minSamples) return { outcomes: copies.map((c) => ({ winRate: c.w, ret: c.r })), source: "copy trades" };
  // Shadow copies: 6-hour results; while there are too few of those, 1-hour results so learning can start sooner.
  for (const [col, label] of [["ret_6h", "6h"], ["ret_1h", "1h"]] as const) {
    const shadow = db
      .prepare(`SELECT wallet_win_rate w, ${col} r FROM smart_flows WHERE side = 'buy' AND ts >= ? AND wallet_win_rate IS NOT NULL AND ${col} IS NOT NULL`)
      .all(since) as { w: number; r: number }[];
    if (shadow.length >= minSamples || label === "1h") return { outcomes: shadow.map((c) => ({ winRate: c.w, ret: c.r })), source: `shadow copies of smart buys (${label} results)` };
  }
  return { outcomes: [], source: "shadow copies of smart buys" };
}

/** Run once per learning cycle: update the follow win-rate bar from evidence. */
export function adaptThresholds(db: DB): number {
  const cfg: ThresholdCfg = {
    floor: config.followWinRateFloor,
    ceiling: config.followWinRateCeiling,
    maxStep: config.followMaxStep,
    minSamples: config.followMinSamples,
  };
  const current = getParam(db, FOLLOW_MIN_WIN_RATE, config.followWinRateStart);
  const { outcomes, source } = gatherOutcomes(db, cfg.minSamples);
  const l = learnWinRateThreshold(outcomes, current, cfg, source);
  const ts = nowIso();
  db.prepare(
    `INSERT INTO learning_params (key, value, target, samples, reason, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, target = excluded.target, samples = excluded.samples, reason = excluded.reason, updated_at = excluded.updated_at`,
  ).run(FOLLOW_MIN_WIN_RATE, l.value, l.target, outcomes.length, l.reason, ts);
  if (l.changed) {
    db.prepare("INSERT INTO param_history (key, ts, old_value, new_value, reason) VALUES (?, ?, ?, ?, ?)").run(FOLLOW_MIN_WIN_RATE, ts, current, l.value, l.reason);
    say("learn", `Follow bar (min win rate) ${l.reason}.`);
  }
  return l.value;
}
