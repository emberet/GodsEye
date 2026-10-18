/**
 * AI / BOT OR HUMAN? — scored from how a wallet trades, never from who it is.
 *
 * Starts at 50 and adds or subtracts points for behaviour. Every point comes
 * with a plain-English reason, and the reasons are shown on the wallet's
 * public page. ≥ 65 → "ai" (an AI agent or trading bot), ≤ 35 → "human",
 * in between → "unknown". On-chain, an AI agent and a scripted bot look the
 * same, so "ai" means "a program is pressing the buttons".
 */
import type { WalletKind } from "@godseye/shared";
import type { KindReason } from "@godseye/shared/dashboard-types";
import type { SwapLite } from "./pnl";

export const MIN_SWAPS_TO_CLASSIFY = 8;
const ROUND_SIZES = [0.05, 0.1, 0.2, 0.25, 0.3, 0.5, 1, 1.5, 2, 2.5, 3, 4, 5, 10, 20, 25, 50, 100];
const DIRECT_VENUES = new Set(["pumpfun", "pumpswap", "raydium", "orca", "meteora"]);

export interface Classification {
  kind: WalletKind;
  score: number | null;
  reasons: KindReason[];
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const cv = (xs: number[]) => {
  const m = mean(xs);
  if (m === 0) return 0;
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2))) / m;
};

/** Longest run of hours (UTC, wrapping around midnight) with no trades at all. */
export function longestQuietHours(timestamps: string[]): number {
  const active = new Array(24).fill(false);
  for (const t of timestamps) active[new Date(t).getUTCHours()] = true;
  if (active.every(Boolean)) return 0;
  let best = 0;
  let run = 0;
  for (let i = 0; i < 48; i++) {
    run = active[i % 24] ? 0 : run + 1;
    best = Math.max(best, Math.min(run, 24));
  }
  return best;
}

/** Transactions per hour no person keeps up (≈ one every 30 seconds, around the clock). */
export const MACHINE_TX_PER_HOUR = 120;

export function classify(swaps: SwapLite[], activity: { txPerHour?: number | null } = {}): Classification {
  const rate = activity.txPerHour ?? null;
  if (swaps.length < MIN_SWAPS_TO_CLASSIFY && !(rate !== null && rate >= MACHINE_TX_PER_HOUR)) {
    return { kind: "unknown", score: null, reasons: [{ points: 0, reason: `Only ${swaps.length} swaps seen, need ${MIN_SWAPS_TO_CLASSIFY} to judge` }] };
  }
  const sorted = [...swaps].sort((a, b) => a.ts.localeCompare(b.ts));
  const times = sorted.map((s) => Date.parse(s.ts));
  const spanDays = times.length ? (times.at(-1)! - times[0]) / 86_400_000 : 0;
  const reasons: KindReason[] = [];
  const add = (points: number, reason: string) => reasons.push({ points, reason });

  // 0) Raw speed: all transactions, not just swaps.
  if (rate !== null && rate >= MACHINE_TX_PER_HOUR) add(30, `~${Math.round(rate).toLocaleString("en-US")} transactions per hour (faster than anyone can click)`);
  else if (rate !== null && rate >= 30) add(10, `~${Math.round(rate)} transactions per hour`);

  // 1) Sleep. People have a quiet window every day; programs don't.
  if (spanDays >= 2 && sorted.length >= 20) {
    const quiet = longestQuietHours(sorted.map((s) => s.ts));
    if (quiet <= 1) add(25, `Trades around the clock: no quiet hours over ${spanDays.toFixed(0)} days`);
    else if (quiet >= 6) add(-20, `Has a ${quiet}h quiet window every day (sleep-like)`);
  }

  // 2) Clockwork timing.
  const gaps = times.slice(1).map((t, i) => (t - times[i]) / 1000).filter((g) => g > 0);
  if (gaps.length >= 14 && cv(gaps) < 0.6) add(15, "Trades at very regular intervals");

  // 3) Reaction speed: buying a token seconds after it launched.
  const snipes = sorted.filter((s) => s.side === "buy" && s.token_age_sec !== null && s.token_age_sec <= 10).length;
  if (snipes >= 2) add(20, `Bought ${snipes} tokens within 10 seconds of launch (sniping speed)`);

  // 4) Volume of activity.
  const days = new Set(sorted.map((s) => s.ts.slice(0, 10))).size;
  const perDay = sorted.length / Math.max(1, days);
  if (perDay > 100) add(20, `~${Math.round(perDay)} swaps per active day`);
  else if (perDay < 10 && sorted.length >= 15) add(-10, `Only ~${perDay.toFixed(1)} swaps per active day`);

  // 5) In-and-out within a minute.
  const quickFlips = countQuickFlips(sorted, 60);
  if (quickFlips >= 3) add(15, `Bought and sold the same token within a minute ${quickFlips} times`);

  // 6) Buy sizes: identical every time (configured) vs. round numbers that vary (typed by hand).
  const buys = sorted.filter((s) => s.side === "buy").map((s) => s.sol_amount);
  if (buys.length >= 10) {
    const sizeCv = cv(buys);
    const round = buys.filter((b) => ROUND_SIZES.some((r) => Math.abs(b - r) / r < 0.01)).length / buys.length;
    if (sizeCv < 0.05) add(15, `Uses the same buy size every time (~${mean(buys).toFixed(3)} SOL)`);
    else if (round >= 0.6) add(-10, `${Math.round(round * 100)}% of buys are round numbers like 0.5 or 1 SOL`);
  }

  // 7) Infrastructure.
  const tipShare = sorted.filter((s) => s.jito_tip).length / sorted.length;
  if (tipShare >= 0.7) add(10, `Pays Jito tips for priority on ${Math.round(tipShare * 100)}% of trades`);
  const directShare = sorted.filter((s) => s.venue && DIRECT_VENUES.has(s.venue)).length / sorted.length;
  if (directShare >= 0.8) add(10, "Calls DEX programs directly instead of through an app or aggregator");
  const botAppShare = sorted.filter((s) => s.venue?.endsWith("(via bot)")).length / sorted.length;
  if (botAppShare >= 0.5) add(-5, "Mostly trades through a trading-bot app (usually a person tapping buttons)");

  const score = Math.max(0, Math.min(100, 50 + reasons.reduce((s, r) => s + r.points, 0)));
  if (reasons.length === 0) add(0, "No strong signals either way");
  return { kind: score >= 65 ? "ai" : score <= 35 ? "human" : "unknown", score, reasons };
}

function countQuickFlips(sorted: SwapLite[], seconds: number): number {
  const lastBuy = new Map<string, number>();
  let n = 0;
  for (const s of sorted) {
    const t = Date.parse(s.ts);
    if (s.side === "buy") lastBuy.set(s.mint, t);
    else {
      const b = lastBuy.get(s.mint);
      if (b !== undefined && t - b <= seconds * 1000) {
        n++;
        lastBuy.delete(s.mint);
      }
    }
  }
  return n;
}
