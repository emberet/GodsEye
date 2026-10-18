/**
 * THE LEARNING LOOP — decides whom GodsEye copies, and how much.
 *
 * It always sides with whoever is making money right now:
 *   • A wallet's weight follows its realized profit — in USD, each trade
 *     valued when it settled — over the last 7 days (60%) and 30 days (40%),
 *     scaled by its win rate and by how many trades back that up.
 *   • Losing over 7 days → weight 0 immediately. No second chances until it
 *     makes money again (then it comes back on its own).
 *   • GodsEye also learns from its OWN results: if copying a wallet has lost
 *     GodsEye money over the last 14 days (late entries, slippage), that wallet
 *     is dropped even if the wallet itself is winning.
 *   • Only the top COPY_MAX_LEADERS earners get weight; weights add up to 1.
 *   • New weights move halfway from the old ones (no whiplash), except
 *     drops to 0, which happen at once.
 */
import type { Tier } from "@godseye/shared";

export interface WeightInput {
  address: string;
  tier: Tier;
  /** Realized profit in USD at settlement. */
  pnl7: number;
  pnl30: number;
  closed30: number;
  winRate30: number | null;
  isFresh: boolean;
  /** GodsEye's own realized P&L from copying this wallet over the last 14 days. */
  copyPnl14: number;
  copyClosed14: number;
  oldWeight: number;
}

export interface WeightResult {
  weight: number;
  reason: string;
}

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const sol = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)} SOL`;
const usd = (n: number) => `${n >= 0 ? "+" : "−"}$${Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

/** How attractive a wallet is to copy right now (0 = don't copy). */
export function rawScore(w: WeightInput, cfg: { copyLossDropSol: number }): WeightResult {
  if (w.tier === "quitter") return { weight: 0, reason: "stopped trading" };
  if (w.pnl7 <= 0) return { weight: 0, reason: `not making money this week (${usd(w.pnl7)})` };
  if (w.copyClosed14 >= 3 && w.copyPnl14 <= -cfg.copyLossDropSol) {
    return { weight: 0, reason: `GodsEye's copies of it lost ${sol(w.copyPnl14)} over 14 days, so it can't be copied profitably` };
  }
  const profit = 0.6 * Math.sqrt(w.pnl7) + 0.4 * Math.sqrt(Math.max(0, w.pnl30));
  const confidence = clamp(w.closed30 / 20, 0.1, 1);
  const winFactor = w.winRate30 === null ? 0.25 : clamp((w.winRate30 - 0.3) / 0.3, 0.25, 1);
  let score = profit * confidence * winFactor;
  const notes = [`${usd(w.pnl7)} this week`, `${usd(w.pnl30)} this month`, `${w.closed30} closed trades`];
  if (w.winRate30 !== null) notes.push(`${Math.round(w.winRate30 * 100)}% wins`);
  if (w.pnl30 <= 0) {
    score *= 0.5;
    notes.push("recovering from a losing month");
  }
  if (w.isFresh) {
    score *= 0.5;
    notes.push("fresh wallet (half weight)");
  }
  return { weight: score, reason: notes.join(", ") };
}

export function computeWeights(inputs: WeightInput[], cfg: { maxLeaders: number; copyLossDropSol: number }): Map<string, WeightResult> {
  const scored = inputs.map((w) => ({ w, r: rawScore(w, cfg) }));
  const ranked = scored.filter((x) => x.r.weight > 0).sort((a, b) => b.r.weight - a.r.weight);
  const top = new Set(ranked.slice(0, cfg.maxLeaders).map((x) => x.w.address));
  const total = ranked.filter((x) => top.has(x.w.address)).reduce((s, x) => s + x.r.weight, 0);

  // Target weights, then smooth toward them (drops to zero are immediate).
  const smoothed = new Map<string, WeightResult>();
  for (const { w, r } of scored) {
    if (!top.has(w.address) || total <= 0) {
      smoothed.set(w.address, { weight: 0, reason: r.weight > 0 ? `${r.reason}; not in the top ${cfg.maxLeaders} earners` : r.reason });
      continue;
    }
    const target = r.weight / total;
    smoothed.set(w.address, { weight: w.oldWeight > 0 ? 0.5 * w.oldWeight + 0.5 * target : target, reason: r.reason });
  }
  const sum = [...smoothed.values()].reduce((s, x) => s + x.weight, 0);
  if (sum > 0) for (const v of smoothed.values()) v.weight /= sum;
  return smoothed;
}

/** SOL to spend copying a buy from a leader with this weight (0 = skip). */
export function copySize(weight: number, cfg: { copyBudgetSol: number; copyMinTradeSol: number; copyMaxTradeSol: number }): number {
  const size = Math.min(cfg.copyMaxTradeSol, cfg.copyBudgetSol * weight);
  return size >= cfg.copyMinTradeSol ? Number(size.toFixed(6)) : 0;
}
