/**
 * WALLET TIERS — the label each wallet gets on the public database.
 * Rules run in this order; the first match wins:
 *
 *   quitter          no swaps for QUIT_AFTER_DAYS
 *   insider          evidence of early/inside knowledge (see below)
 *   lucky_streak     profitable, but the profit rests on one or two trades
 *   needs_attention  something changed or looks off (slipping, fresh + big, many sibling wallets, rotated from a tracked wallet)
 *   proven           profitable over many trades, profit spread out
 *   unrated          everything else (too few trades, or not profitable)
 *
 * Insider pattern needs at least one of:
 *   • it's the token's creator, or was funded by the token's creator, and bought that token
 *   • ≥ 3 profitable positions that started with a buy in the token's first minutes, and ≥ 40% of its buys are that early
 *   • ≥ 2 times it sold out shortly before the token crashed ≥ 60%
 * Every rule that fires leaves a piece of evidence, shown on the wallet's page.
 */
import type { Tier } from "@godseye/shared";
import type { ClosedPosition, ComputedStats } from "./pnl";

export interface EvidenceItem {
  kind: string;
  detail: string;
  mint?: string | null;
  signature?: string | null;
  ts: string;
}

export interface TierInput {
  stats: ComputedStats;
  closed: ClosedPosition[];
  now: number;
  isFresh: boolean;
  groupSize: number;
  /** The funder is itself a wallet GodsEye tracks (possible wallet rotation). */
  funderTracked: { address: string; tier: Tier } | null;
  previousTier: Tier;
  /** Tokens this wallet bought where it is, or was funded by, the token's creator. */
  creatorLinks: { mint: string; symbol: string; relation: "is_creator" | "funded_by_creator"; signature: string; ts: string }[];
  /** Positions it closed shortly before a crash: its last sell price vs. the price now. */
  crashExits: { mint: string; symbol: string; sellPriceSol: number; nowPriceSol: number; signature: string; ts: string }[];
  symbols: Map<string, string>;
  cfg: { quitAfterDays: number; minClosedForProven: number; earlyBuySeconds: number };
}

/** Evidence kinds that describe the wallet's current state (replaced on every analysis), not one specific trade. */
export const STATE_EVIDENCE = ["inactive", "small_sample", "slipping", "fresh_big", "sibling_wallets", "rotated_from"];

export interface TierResult {
  tier: Tier;
  reason: string;
  evidence: EvidenceItem[];
}

const sol = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)} SOL`;
const LIKELY_EXCHANGE_GROUP = 25;

export function assignTier(i: TierInput): TierResult {
  const s = i.stats;
  const nowIso = new Date(i.now).toISOString();
  const sym = (m: string) => i.symbols.get(m) ?? `${m.slice(0, 4)}…`;

  if (s.swaps_total === 0 || !s.last_trade_at) return { tier: "unrated", reason: "No SOL-priced swaps seen yet", evidence: [] };

  // 1) Quitter
  const idleDays = (i.now - Date.parse(s.last_trade_at)) / 86_400_000;
  if (idleDays >= i.cfg.quitAfterDays) {
    const reason = `No trades for ${Math.floor(idleDays)} days (last trade ${s.last_trade_at.slice(0, 10)})`;
    return { tier: "quitter", reason, evidence: [{ kind: "inactive", detail: reason, ts: nowIso }] };
  }

  // 2) Insider pattern
  const insider: EvidenceItem[] = [];
  for (const l of i.creatorLinks) {
    insider.push({
      kind: l.relation,
      detail: l.relation === "is_creator" ? `Created ${l.symbol} and traded it` : `Was funded by the creator of ${l.symbol}, then bought it`,
      mint: l.mint, signature: l.signature, ts: l.ts,
    });
  }
  const d30 = new Date(i.now - 30 * 86_400_000).toISOString();
  const earlyWins = i.closed.filter((c) => c.earlyEntry && c.pnlSol > 0 && c.closedAt >= d30);
  if (earlyWins.length >= 3 && (s.early_buy_rate ?? 0) >= 0.4) {
    for (const c of earlyWins.slice(0, 10)) {
      insider.push({
        kind: "early_entry",
        detail: `Bought ${sym(c.mint)} within ${Math.round(i.cfg.earlyBuySeconds / 60)} min of launch, closed ${sol(c.pnlSol)} (${c.pnlPct.toFixed(0)}%)`,
        mint: c.mint, signature: c.lastSellSignature, ts: c.closedAt,
      });
    }
  }
  const crashes = i.crashExits.filter((x) => x.nowPriceSol <= x.sellPriceSol * 0.4);
  if (crashes.length >= 2) {
    for (const x of crashes) {
      insider.push({
        kind: "sold_before_crash",
        detail: `Sold out of ${x.symbol}; it's down ${Math.round((1 - x.nowPriceSol / x.sellPriceSol) * 100)}% since`,
        mint: x.mint, signature: x.signature, ts: x.ts,
      });
    }
  }
  if (insider.length) {
    const kinds = new Set(insider.map((e) => e.kind));
    const parts = [
      kinds.has("is_creator") || kinds.has("funded_by_creator") ? "linked to token creators" : null,
      kinds.has("early_entry") ? `${earlyWins.length} profitable launch-minute buys` : null,
      kinds.has("sold_before_crash") ? `sold before ${crashes.length} crashes` : null,
    ].filter(Boolean);
    return { tier: "insider", reason: `Insider pattern: ${parts.join(", ")}`, evidence: insider };
  }

  // 3) Lucky streak
  if (s.pnl_30d_sol > 0 && s.closed_30d >= 1) {
    const best = i.closed.filter((c) => c.closedAt >= d30).sort((a, b) => b.pnlSol - a.pnlSol)[0];
    if (s.best_trade_share !== null && s.best_trade_share >= 0.7 && s.closed_30d >= 2) {
      const reason = `One trade made ${Math.round(s.best_trade_share * 100)}% of the 30-day profit (${sol(best.pnlSol)} on ${sym(best.mint)})`;
      return { tier: "lucky_streak", reason, evidence: [{ kind: "concentrated_profit", detail: reason, mint: best.mint, signature: best.lastSellSignature, ts: best.closedAt }] };
    }
    if (s.closed_30d < i.cfg.minClosedForProven) {
      const reason = `Up ${sol(s.pnl_30d_sol)} but only ${s.closed_30d} closed trades in 30 days (${i.cfg.minClosedForProven} needed to call it skill)`;
      return { tier: "lucky_streak", reason, evidence: [{ kind: "small_sample", detail: reason, ts: nowIso }] };
    }
  }

  // 4) Needs attention
  const attention: EvidenceItem[] = [];
  if (s.pnl_30d_sol > 0 && s.pnl_7d_sol < 0) attention.push({ kind: "slipping", detail: `Profitable over 30 days (${sol(s.pnl_30d_sol)}) but losing this week (${sol(s.pnl_7d_sol)})`, ts: nowIso });
  else if (i.previousTier === "proven" && s.pnl_7d_sol < 0) attention.push({ kind: "slipping", detail: `Was Proven, now losing this week (${sol(s.pnl_7d_sol)})`, ts: nowIso });
  if (i.isFresh && (s.avg_buy_sol ?? 0) >= 3) attention.push({ kind: "fresh_big", detail: `Brand-new wallet already buying ~${(s.avg_buy_sol ?? 0).toFixed(1)} SOL per trade`, ts: nowIso });
  if (i.groupSize >= 5 && i.groupSize < LIKELY_EXCHANGE_GROUP) attention.push({ kind: "sibling_wallets", detail: `One funder paid for ${i.groupSize} tracked wallets, including this one`, ts: nowIso });
  if (i.funderTracked) attention.push({ kind: "rotated_from", detail: `Funded by ${i.funderTracked.address.slice(0, 4)}…${i.funderTracked.address.slice(-4)}, a tracked wallet (${i.funderTracked.tier}): maybe the same trader on a new wallet`, ts: nowIso });
  if (attention.length) return { tier: "needs_attention", reason: attention.map((a) => a.detail).join(" · "), evidence: attention };

  // 5) Proven
  if (s.pnl_30d_sol > 0 && s.pnl_7d_sol >= 0 && s.closed_30d >= i.cfg.minClosedForProven && (s.win_rate_30d ?? 0) >= 0.5 && (s.best_trade_share ?? 1) < 0.5) {
    return {
      tier: "proven",
      reason: `${sol(s.pnl_30d_sol)} over ${s.closed_30d} closed trades in 30 days, ${Math.round((s.win_rate_30d ?? 0) * 100)}% wins`,
      evidence: [],
    };
  }

  // 6) Unrated
  if (s.closed_30d < 3) return { tier: "unrated", reason: `Only ${s.closed_30d} closed trades in 30 days`, evidence: [] };
  if (s.pnl_30d_sol <= 0) return { tier: "unrated", reason: `Not profitable: ${sol(s.pnl_30d_sol)} over 30 days`, evidence: [] };
  return { tier: "unrated", reason: `Profitable (${sol(s.pnl_30d_sol)}) but under 50% wins or uneven profit`, evidence: [] };
}
