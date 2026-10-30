/**
 * WALLET EVALUATIONS — why each wallet was in the state it was in.
 *
 * The learning loop (learning/loop.ts) recomputes every wallet's copy weight every 15 minutes. After each run this writes
 * down, for every wallet whose situation changed, the state it ended in, the rule that decided it, every number the
 * weight was computed from, the cutoffs in force, how much of the wallet's history was really seen, and the evidence for
 * and against copying it. Append-only, so any past decision can be explained and any later rule can be tested against what
 * was known at the time.
 *
 * The state is deliberately simple and provisional (state_version 1), taken from the weight gates alone:
 *   copy    weight above 0
 *   ignore  stopped trading, or no closed trades to judge
 *   block   listed in IGNORE_WALLETS
 *   watch   everything else: uncertain or not good enough yet, and may change
 * It describes what the existing rules did. It adds no rule and changes no weight.
 */
import type { DB } from "@godseye/shared";
import { config } from "../config";
import { copyableShare, tooLittleCopyable, type WeightInput, type WeightResult } from "../learning/weights";
import { auditSettings } from "./settings";
import { ensureAuditTables } from "./schema";

export type WalletState = "copy" | "watch" | "ignore" | "block";
export type Gate = "ok" | "not_in_top" | "quitter" | "lucky_streak" | "few_closed" | "win_rate" | "pnl7" | "copy_loss" | "bot" | "copy_replay" | "uncopyable" | "blocked";

export interface WeightCutoffs {
  maxLeaders: number;
  copyLossDropSol: number;
  minClosed: number;
  minWinRate: number;
  /** COPY_MIN_COPYABLE_SHARE; unset = 0. */
  minCopyableShare?: number;
}

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const usd = (n: number) => `${n >= 0 ? "+" : "−"}$${Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const pct = (x: number) => `${Math.round(x * 100)}%`;

/** The first rule in rawScore that gives a wallet no weight (mirrors weights.ts; a test keeps the two in step). */
export function gateOf(w: WeightInput, cfg: WeightCutoffs): Gate {
  if (w.tier === "quitter") return "quitter";
  if (w.tier === "lucky_streak") return "lucky_streak";
  if (w.tier !== "proven" && w.closed30 < cfg.minClosed) return "few_closed";
  if ((w.winRate30 ?? 0) < cfg.minWinRate) return "win_rate";
  if (w.pnl7 <= 0) return "pnl7";
  if (w.copyClosed14 >= 3 && w.copyPnl14 <= -cfg.copyLossDropSol) return "copy_loss";
  if (w.botGate) return "bot";
  if (w.copyGate) return "copy_replay";
  if (tooLittleCopyable(copyableShare(w), cfg.minCopyableShare ?? 0)) return "uncopyable";
  return "ok";
}

export interface ScoreComponents {
  profit: number;
  confidence: number;
  winFactor: number;
  /** 0.5 when the 30-day result is not positive, else 1. */
  recoveringFactor: number;
  /** 0.5 for a fresh wallet, else 1. */
  freshFactor: number;
  /** 0.5 … 1.5 from what its buys did next, once 10+ buys are measured; else 1. */
  leadFactor: number;
  /** Share of its buys GodsEye could copy, once 10+ buys are measured; else 1. */
  copyableFactor: number;
  /** The product (what rawScore returns), before the top-N share-out and smoothing. */
  score: number;
}

/** The factors of the score (null where a gate gives no score). The product equals rawScore's weight. */
export function scoreComponents(w: WeightInput, cfg: WeightCutoffs): ScoreComponents | null {
  if (gateOf(w, cfg) !== "ok") return null;
  const profit = 0.6 * Math.sqrt(w.pnl7) + 0.4 * Math.sqrt(Math.max(0, w.pnl30));
  const confidence = clamp(w.closed30 / 20, 0.1, 1);
  const winFactor = w.winRate30 === null ? 0.25 : clamp((w.winRate30 - 0.3) / 0.3, 0.25, 1);
  const recoveringFactor = w.pnl30 <= 0 ? 0.5 : 1;
  const freshFactor = w.isFresh ? 0.5 : 1;
  const leadFactor = (w.leadN ?? 0) >= 10 && w.leadMedian6h !== null && w.leadMedian6h !== undefined ? clamp(1 + w.leadMedian6h / 100, 0.5, 1.5) : 1;
  const copyableFactor = copyableShare(w) ?? 1;
  return {
    profit, confidence, winFactor, recoveringFactor, freshFactor, leadFactor, copyableFactor,
    score: profit * confidence * winFactor * recoveringFactor * freshFactor * leadFactor * copyableFactor,
  };
}

export const stateOf = (w: WeightInput, weight: number, blocked: boolean): WalletState =>
  blocked ? "block" : weight > 0 ? "copy" : w.tier === "quitter" || w.closed30 === 0 ? "ignore" : "watch";

/** What was seen of the wallet's history. */
export interface HistoryInfo {
  historyFrom: string | null;
  historyDone: boolean | null;
  txRead: number | null;
  ageIsLowerBound: boolean | null;
  kind: string | null;
  aiScore: number | null;
  txPerHour: number | null;
  bestTradeShare: number | null;
  medianHoldSec: number | null;
  sameBlockRoundTrips: number | null;
  tierReason: string | null;
  lastActivityAt: string | null;
}

export function dataQuality(h: HistoryInfo, now = Date.now()): Record<string, unknown> {
  const from = h.historyFrom ? Date.parse(h.historyFrom) : NaN;
  return {
    historyFrom: h.historyFrom,
    windowDays: Number.isFinite(from) ? Number(((now - from) / 86_400_000).toFixed(1)) : null,
    historyComplete: h.historyDone,
    transactionsRead: h.txRead,
    ageIsLowerBound: h.ageIsLowerBound,
  };
}

export interface Explanation {
  gate: Gate;
  state: WalletState;
  evidenceFor: string[];
  evidenceAgainst: string[];
  reassess: string;
}

export function explain(w: WeightInput, result: WeightResult, cfg: WeightCutoffs, h: HistoryInfo, blocked: boolean, now = Date.now()): Explanation {
  let gate: Gate = blocked ? "blocked" : gateOf(w, cfg);
  if (gate === "ok" && result.weight <= 0) gate = "not_in_top";
  const state = stateOf(w, result.weight, blocked);

  const f: string[] = [];
  const a: string[] = [];
  if (w.pnl7 > 0) f.push(`${usd(w.pnl7)} this week`);
  if (w.pnl30 > 0) f.push(`${usd(w.pnl30)} over the history seen`);
  if (w.closed30 >= cfg.minClosed) f.push(`${w.closed30} closed trades seen`);
  if (w.winRate30 !== null && w.winRate30 >= cfg.minWinRate) f.push(`wins ${pct(w.winRate30)} of trades (bar ${pct(cfg.minWinRate)})`);
  if ((w.leadN ?? 0) >= 10 && (w.leadMedian6h ?? 0) > 0) f.push(`its buys move +${Math.round(w.leadMedian6h as number)}% in 6 h (median of ${w.leadN})`);
  if (w.copyClosed14 > 0 && w.copyPnl14 > 0) f.push(`our copies of it made +${w.copyPnl14.toFixed(2)} SOL over 14 days`);
  if (w.tier === "proven") f.push("Proven tier");
  const copyable = copyableShare(w);
  if (copyable !== null && copyable >= 0.5) f.push(`${pct(copyable)} of its ${w.copyableBuys} buys in 14 days were coins GodsEye can copy`);

  if (result.weight <= 0 && gate !== "blocked") a.push(result.reason);
  if (w.pnl30 <= 0 && gate === "ok") a.push("losing over the history seen (half weight)");
  if (w.isFresh) a.push("fresh wallet (half weight)");
  if ((w.leadN ?? 0) >= 10 && (w.leadMedian6h ?? 0) < 0) a.push(`its buys move ${Math.round(w.leadMedian6h as number)}% in 6 h (median of ${w.leadN})`);
  if (copyable !== null && copyable < 0.5 && gate !== "uncopyable") a.push(`only ${pct(copyable)} of its ${w.copyableBuys} buys in 14 days were coins GodsEye can copy`);
  if ((w.leadN ?? 0) < 10) a.push(`what its buys do next is not measured yet (${w.leadN ?? 0} of 10 buys)`);
  if (w.copyClosed14 > 0 && w.copyPnl14 < 0) a.push(`our copies of it lost ${w.copyPnl14.toFixed(2)} SOL over 14 days`);
  if (w.tier === "insider") a.push("insider tier: its edge may come from launch access a follower can't reproduce (still copyable by decision)");
  if (w.tier === "needs_attention" && h.tierReason) a.push(h.tierReason);
  if (h.kind === "ai") a.push(`behaves like a bot${h.aiScore !== null ? ` (score ${Math.round(h.aiScore)})` : ""}`);
  if (h.medianHoldSec !== null && h.medianHoldSec < 15) a.push(`median hold ${Math.round(h.medianHoldSec)} s: faster than a delayed copy can follow`);
  if ((h.sameBlockRoundTrips ?? 0) > 0) a.push(`${h.sameBlockRoundTrips} positions bought and sold in one block`);
  if (h.bestTradeShare !== null && h.bestTradeShare >= 0.5) a.push(`its best winner is ${pct(h.bestTradeShare)} of all winning trades`);
  const q = dataQuality(h, now);
  if (typeof q.windowDays === "number" && q.windowDays < 14) a.push(`history seen covers only ${q.windowDays} days, not the 30 the stats are named for`);
  if (h.historyDone === false) a.push("older history has not been read yet");

  const reassess: Record<Gate, string> = {
    blocked: "removing it from IGNORE_WALLETS",
    quitter: "the wallet trading again",
    lucky_streak: `${cfg.minClosed}+ closed trades with no single trade making 70% of the profit`,
    few_closed: `${Math.max(0, cfg.minClosed - w.closed30)} more closed trades`,
    win_rate: `a win rate of ${pct(cfg.minWinRate)} or more (the bar moves with outcomes)`,
    pnl7: "a profitable week",
    copy_loss: "the losing copies leaving the 14-day window",
    bot: "trading at a pace a delayed copy can follow (median hold 15 s+, 20 transactions an hour or fewer, no same-block round trips)",
    copy_replay: "a copy replay at GodsEye's delay with a positive median return over 10+ copies (redone every 6 hours)",
    uncopyable: `at least ${pct(cfg.minCopyableShare ?? 0)} of its buys in coins the rug screen passes (measured hourly over 14 days)`,
    not_in_top: `a place among the top ${cfg.maxLeaders} earners`,
    ok: "any gate failing, or losing a top-earner place",
  };
  return { gate, state, evidenceFor: f, evidenceAgainst: a, reassess: reassess[gate] };
}

const historyFrom = (w: Record<string, unknown> | undefined, s: Record<string, unknown> | undefined): HistoryInfo => ({
  historyFrom: (w?.history_from as string | null) ?? null,
  historyDone: w && w.history_done !== undefined ? w.history_done === 1 : null,
  txRead: (w?.history_tx_read as number | null) ?? null,
  ageIsLowerBound: w && w.age_is_lower_bound !== undefined ? w.age_is_lower_bound === 1 : null,
  kind: (w?.kind as string | null) ?? null,
  aiScore: (w?.ai_score as number | null) ?? null,
  txPerHour: (w?.tx_per_hour as number | null) ?? null,
  bestTradeShare: (s?.best_trade_share as number | null) ?? null,
  medianHoldSec: (s?.median_hold_sec as number | null) ?? null,
  sameBlockRoundTrips: (s?.same_block_round_trips as number | null) ?? null,
  tierReason: (w?.tier_reason as string | null) ?? null,
  lastActivityAt: (w?.last_activity_at as string | null) ?? null,
});

interface Last {
  id: number;
  wallet: string;
  ts: string;
  state: string;
  gate: string;
  tier: string;
  weight: number;
}

/**
 * Writes an evaluation for every wallet whose state, deciding rule, tier or weight (by 0.01 or more) changed since its last
 * one, and again once a day for copied wallets. Returns how many rows were written. Never throws.
 */
export function recordEvaluations(
  db: DB,
  a: { inputs: WeightInput[]; results: Map<string, WeightResult>; cfg: WeightCutoffs; mode: string; blocked?: string[] },
  now = Date.now(),
): number {
  if (!auditSettings.auditEnabled) return 0;
  try {
    ensureAuditTables(db);
    const last = new Map<string, Last>();
    for (const r of db.prepare("SELECT id, wallet, ts, state, gate, tier, weight FROM wallet_evaluations WHERE id IN (SELECT MAX(id) FROM wallet_evaluations GROUP BY wallet)").all() as Last[]) last.set(r.wallet, r);
    const wallets = new Map((db.prepare("SELECT * FROM wallets").all() as Record<string, unknown>[]).map((r) => [r.address as string, r]));
    const stats = new Map((db.prepare("SELECT * FROM wallet_stats").all() as Record<string, unknown>[]).map((r) => [r.wallet as string, r]));
    const blocked = new Set(a.blocked ?? config.ignoreWallets);
    const heartbeatMs = auditSettings.evaluationHeartbeatHours * 3_600_000;
    const ts = new Date(now).toISOString();
    const insert = db.prepare(
      `INSERT INTO wallet_evaluations (wallet, ts, state, state_version, gate, tier, tier_reason, weight, weight_reason, mode, inputs, cutoffs, components, data_quality, evidence_for, evidence_against, reassess, last_activity_at, changed)
       VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    let written = 0;
    db.transaction(() => {
      for (const w of a.inputs) {
        const res = a.results.get(w.address);
        if (!res) continue;
        const weight = Number(res.weight.toFixed(4));
        const h = historyFrom(wallets.get(w.address), stats.get(w.address));
        const ex = explain(w, res, a.cfg, h, blocked.has(w.address), now);
        const prev = last.get(w.address);
        const changed = !prev || prev.state !== ex.state || prev.gate !== ex.gate || prev.tier !== w.tier || Math.abs(prev.weight - weight) >= 0.01;
        const beat = !changed && ex.state === "copy" && now - Date.parse(prev!.ts) >= heartbeatMs;
        if (!changed && !beat) continue;
        insert.run(
          w.address, ts, ex.state, ex.gate, w.tier, h.tierReason, weight, res.reason, a.mode,
          JSON.stringify(w), JSON.stringify(a.cfg), JSON.stringify(scoreComponents(w, a.cfg)), JSON.stringify(dataQuality(h, now)),
          JSON.stringify(ex.evidenceFor), JSON.stringify(ex.evidenceAgainst), ex.reassess, h.lastActivityAt, changed ? 1 : 0,
        );
        written++;
      }
    })();
    return written;
  } catch (e) {
    console.warn(`Audit: couldn't record wallet evaluations: ${(e as Error).message}`);
    return 0;
  }
}

/** Latest evaluation row id for a wallet (null if none). */
export function latestEvaluationId(db: DB, wallet: string): number | null {
  try {
    return (db.prepare("SELECT MAX(id) id FROM wallet_evaluations WHERE wallet = ?").get(wallet) as { id: number | null } | undefined)?.id ?? null;
  } catch {
    return null;
  }
}
