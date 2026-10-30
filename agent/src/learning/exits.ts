/**
 * LEARNED EXITS — the agent picks its own exit rule.
 *
 * Every 6 hours a separate job (`npm run tune-exits`, systemd godseye-exits.timer) replays the ranked candidates' last
 * 14 days under every candidate rule (replay/sweep.ts) and keeps one only when it is clearly better, judged the cautious way:
 *   • each rule is scored by its % return per copy (trimmed mean) on both halves of the window apart, and ranked on its
 *     WORSE half (a rule that wins one week and loses the next is not better);
 *   • a new rule must beat the one in use on that worse half by MIN_GAIN_PP, with enough copies in each half, and make
 *     money in both halves; between rules within TIE_PP of each other, the one that lets winners run further wins, and
 *     it replaces the rule in use even without the margin (as good, more upside);
 *   • the stop-loss stays inside a fixed band (25–60 %) whatever the data says; profit targets start at +30 %.
 * Candidate rules: a plain stop-loss / take-profit pair, or a ladder — sell half at a profit target, then let the rest
 * run with a trailing stop up to a ceiling the tuner also picks, or none (NO_CEILING), so a big winner isn't capped.
 * Without a ceiling the trailing stop and the leader's own sell decide when a winner ends.
 * The choice is stored in agent_meta and read by the copy engine; if the job stops running, a choice older than 2 days
 * falls back to COPY_STOP_LOSS_PCT / COPY_TAKE_PROFIT_PCT (no ladder).
 */
import { type DB, getMeta, nowIso, setMeta } from "@godseye/shared";
import type { RuleScore } from "../replay/sweep";

export const EXIT_PARAMS_KEY = "exit_params";
export const SL_BAND: [number, number] = [25, 60];
/** A take-profit this high never fires: no ceiling. */
export const NO_CEILING = 100_000;
export const TP_BAND: [number, number] = [30, NO_CEILING];
export const SL_GRID = [25, 35, 50, 60];
export const TP_GRID = [30, 45, 60, 100, 150, 300, 500, NO_CEILING];
/** Ceilings tried for a ladder's remaining half. */
export const LADDER_CEILINGS = [300, 1000, NO_CEILING];
/** Ladders: sell half at each of these, then trail the rest by each of TRAIL_GRID % from its best. */
export const LADDER_GRID = [30, 45, 60, 100];
export const TRAIL_GRID = [20, 30];
/** Percentage points of worse-half trimmed mean return a new rule must add. */
export const MIN_GAIN_PP = 0.3;
/** Rules this close count as equal; the one with more upside is preferred. */
export const TIE_PP = 0.1;
export const MIN_COPIES_PER_HALF = 300;
const MAX_AGE_MS = 2 * 86_400_000;

export interface ExitRule {
  stopLossPct: number;
  takeProfitPct: number;
  /** Ladder: sell partialFraction at +partialTpPct (0 = no ladder). */
  partialTpPct: number;
  partialFraction: number;
  /** Ladder: once up trailArmPct, sell the rest when it falls trailStopPct % from its best (0 = no trailing stop). */
  trailStopPct: number;
  trailArmPct: number;
}

export interface Exits extends ExitRule {
  /** "learned" (from the tuner) or "config" (COPY_STOP_LOSS_PCT / COPY_TAKE_PROFIT_PCT). */
  source: "learned" | "config";
  reason?: string;
}

const clamp = (x: number, [lo, hi]: [number, number]) => Math.max(lo, Math.min(hi, x));
const NO_LADDER = { partialTpPct: 0, partialFraction: 0.5, trailStopPct: 0, trailArmPct: 0 };

export const plainRule = (stopLossPct: number, takeProfitPct: number): ExitRule => ({ stopLossPct, takeProfitPct, ...NO_LADDER });
export const ladderRule = (stopLossPct: number, at: number, trail: number, ceiling = NO_CEILING): ExitRule => ({
  stopLossPct, takeProfitPct: ceiling, partialTpPct: at, partialFraction: 0.5, trailStopPct: trail, trailArmPct: at,
});

const tpName = (tp: number) => (tp >= NO_CEILING ? "no-ceiling" : `tp${tp}`);
export const ruleName = (r: ExitRule): string =>
  r.partialTpPct > 0 || r.trailStopPct > 0
    ? `sl${r.stopLossPct} half@${r.partialTpPct} trail${r.trailStopPct} ${tpName(r.takeProfitPct)}`
    : `sl${r.stopLossPct} ${tpName(r.takeProfitPct)}`;

/** Every rule the tuner tries. */
export function candidateRules(): ExitRule[] {
  return [
    ...SL_GRID.flatMap((sl) => TP_GRID.map((tp) => plainRule(sl, tp))),
    ...SL_GRID.flatMap((sl) => LADDER_GRID.flatMap((at) => TRAIL_GRID.flatMap((t) => LADDER_CEILINGS.map((cap) => ladderRule(sl, at, t, cap))))),
  ];
}

const inBands = (r: ExitRule) =>
  r.stopLossPct >= SL_BAND[0] && r.stopLossPct <= SL_BAND[1] && r.takeProfitPct >= TP_BAND[0] && r.takeProfitPct <= TP_BAND[1] &&
  (r.partialTpPct === 0 || (r.partialTpPct >= TP_BAND[0] && r.partialTpPct <= TP_BAND[1]));

/** The exit rule the copy engine uses now. */
export function currentExits(db: DB, fallback: { stopLossPct: number; takeProfitPct: number }, now = Date.now()): Exits {
  const raw = getMeta(db, EXIT_PARAMS_KEY);
  if (raw) {
    try {
      const v = JSON.parse(raw) as Partial<ExitRule> & { at: string; reason?: string };
      if (now - Date.parse(v.at) < MAX_AGE_MS && (v.stopLossPct ?? 0) > 0 && (v.takeProfitPct ?? 0) > 0) {
        return {
          stopLossPct: clamp(v.stopLossPct!, SL_BAND), takeProfitPct: clamp(v.takeProfitPct!, TP_BAND),
          partialTpPct: v.partialTpPct ? clamp(v.partialTpPct, TP_BAND) : 0, partialFraction: clamp(v.partialFraction ?? 0.5, [0.1, 0.9]),
          trailStopPct: v.trailStopPct ? clamp(v.trailStopPct, [10, 50]) : 0, trailArmPct: v.trailArmPct ?? 0,
          source: "learned", reason: v.reason,
        };
      }
    } catch {
      /* unreadable: use the configured exits */
    }
  }
  return { ...plainRule(fallback.stopLossPct, fallback.takeProfitPct), source: "config" };
}

/** Worse of the two halves' trimmed mean return, %. */
const worse = (s: RuleScore) => Math.min(s.firstHalfTrimmedPct, s.secondHalfTrimmedPct);
/** How far a rule lets a winner run: the ceiling for a plain rule, the ceiling with a trailing stop counting more. */
const upside = (r: ExitRule) => r.takeProfitPct + (r.trailStopPct > 0 ? 1 : 0);

/** Pure decision: the rule to use, from the scored candidates and the rule in use (scored among them, by name). */
export function chooseExits(scored: { rule: ExitRule; score: RuleScore }[], inUse: ExitRule): ExitRule & { changed: boolean; reason: string } {
  const cur = scored.find((c) => ruleName(c.rule) === ruleName(inUse));
  const keep = (reason: string) => ({ ...inUse, changed: false, reason });
  const eligible = scored.filter(
    ({ rule, score: s }) => inBands(rule) && s.firstHalfN >= MIN_COPIES_PER_HALF && s.secondHalfN >= MIN_COPIES_PER_HALF && s.firstHalfSol > 0 && s.secondHalfSol > 0,
  );
  if (!eligible.length) return keep("no exit rule made money in both halves with enough copies");
  const top = Math.max(...eligible.map((c) => worse(c.score)));
  const best = eligible.filter((c) => worse(c.score) >= top - TIE_PP).reduce((a, b) => (upside(b.rule) > upside(a.rule) || (upside(b.rule) === upside(a.rule) && worse(b.score) > worse(a.score)) ? b : a));
  const name = ruleName(best.rule);
  if (name === ruleName(inUse)) return keep(`the rule in use is still the best (${worse(best.score).toFixed(2)}% per copy on its worse half)`);
  const curWorse = cur ? worse(cur.score) : -Infinity;
  // As good (within TIE_PP) and lets winners run further: take it. Otherwise it must be clearly better.
  const sameButMoreUpside = upside(best.rule) > upside(inUse) && worse(best.score) >= curWorse - TIE_PP;
  if (!sameButMoreUpside && worse(best.score) < curWorse + MIN_GAIN_PP) return keep(`best alternative ${name} adds only ${(worse(best.score) - curWorse).toFixed(2)} pp on its worse half (needs ${MIN_GAIN_PP})`);
  return {
    ...best.rule, changed: true,
    reason: `${name}: ${worse(best.score).toFixed(2)}% per copy on its worse half vs ${cur ? `${curWorse.toFixed(2)}%` : "not measured"} for ${ruleName(inUse)} (${best.score.firstHalfN}+${best.score.secondHalfN} copies)`,
  };
}

export function storeExits(db: DB, e: ExitRule & { reason: string }): void {
  const { stopLossPct, takeProfitPct, partialTpPct, partialFraction, trailStopPct, trailArmPct, reason } = e;
  setMeta(db, EXIT_PARAMS_KEY, JSON.stringify({ stopLossPct, takeProfitPct, partialTpPct, partialFraction, trailStopPct, trailArmPct, reason, at: nowIso() }));
}
