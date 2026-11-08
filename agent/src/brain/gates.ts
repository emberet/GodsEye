/**
 * THE BRAIN'S HARD GATES — skips applied before the entry network (brain/spec/features.yaml `gates`, in that order): the
 * first that fires is the signal's gate (features_entry.gate, info.gate), and a gated signal never reaches the network.
 *
 *   below_min_leader_buy  the leader bought less than 0.2 SOL (MIN_LEADER_BUY_SOL)
 *   too_late              decided more than 60 s after the leader's block time (MAX_COPY_DELAY_SECONDS)
 *   pumpswap_hiprice      a pumpswap coin priced ≥ 1e-4 SOL per token (unsellable within minutes, 96-100 % precision)
 *   young_amm             a pumpswap / meteora / meteora dbc / raydium / raydium launchlab / orca coin first seen less than
 *                         10 min before the decision, or never seen
 *   screen_dead           the rug screen failed, or the pool's LP is ≤ 1 % locked (no screen back yet: doesn't apply)
 *
 * Pure: no clock, no database. The paper policy (brain/policy.ts) and the real copy screen (copy/engine.ts copyBuy, behind
 * COPY_BRAIN_GATES) both call gate(); brain/spec/golden/entry.json pins the cases (agent/test/brain-gates.test.ts).
 */

export const GATES = ["below_min_leader_buy", "too_late", "pumpswap_hiprice", "young_amm", "screen_dead"] as const;
export type GateName = (typeof GATES)[number];

export const GATE_MIN_LEADER_BUY_SOL = 0.2;
export const GATE_MAX_LATE_SEC = 60;
/** SOL per UI token at or above which a pumpswap coin is gated. */
export const PUMPSWAP_HIPRICE_SOL = 1e-4;
/** An AMM coin first seen less than this before the decision is gated. */
export const YOUNG_AMM_MIN = 10;
/** LP locked at or below this (%) is a dead screen. */
export const SCREEN_DEAD_LP_PCT = 1;
/** The venues young_amm applies to (the venue with " (via bot)" stripped, exactly). */
export const YOUNG_AMM_VENUES: ReadonlySet<string> = new Set(["pumpswap", "meteora", "meteora dbc", "raydium", "raydium launchlab", "orca"]);

/** The leader's buy as the gates see it. */
export interface GateSignal {
  /** SOL the leader spent. */
  solAmount: number;
  /** The leader's price, SOL per UI token (null or ≤ 0 = unknown: pumpswap_hiprice doesn't apply). */
  priceSol: number | null;
  /** The swap's venue as parse.ts names it ("pumpswap", "raydium launchlab (via bot)", …); null = unknown. */
  venue: string | null;
  /** The leader's block time, epoch ms. */
  t: number;
}

export interface GateContext {
  /** Decision time, epoch ms. */
  now: number;
  /** The coin's first sighting (StreamState.firstSeen(mint).firstSeenAt), epoch ms; null = never seen. */
  firstSeenAt: number | null;
  /** The rug screen, if it returned by decision time; null = not back yet (screen_dead doesn't apply). */
  screen?: { failed: boolean; lpLockedPct: number | null } | null;
  /** MIN_LEADER_BUY_SOL (default the spec's 0.2). */
  minLeaderBuySol?: number;
  /** MAX_COPY_DELAY_SECONDS (default the spec's 60). */
  maxLateSec?: number;
}

/** The venue without its " (via bot)" suffix, lower case. */
export const baseVenue = (venue: string | null): string => (venue ?? "").replace(/\s*\(via bot\)\s*$/i, "").trim().toLowerCase();

/** The first gate that fires for this signal (features.yaml order), or null: the signal reaches the network. */
export function gate(signal: GateSignal, ctx: GateContext): GateName | null {
  if (!(signal.solAmount >= (ctx.minLeaderBuySol ?? GATE_MIN_LEADER_BUY_SOL))) return "below_min_leader_buy";
  if (ctx.now - signal.t > (ctx.maxLateSec ?? GATE_MAX_LATE_SEC) * 1000) return "too_late";
  const venue = baseVenue(signal.venue);
  if (venue.startsWith("pumpswap") && signal.priceSol !== null && signal.priceSol >= PUMPSWAP_HIPRICE_SOL) return "pumpswap_hiprice";
  if (YOUNG_AMM_VENUES.has(venue) && (ctx.firstSeenAt === null || ctx.now - ctx.firstSeenAt < YOUNG_AMM_MIN * 60_000)) return "young_amm";
  const s = ctx.screen;
  if (s && (s.failed || (s.lpLockedPct !== null && s.lpLockedPct <= SCREEN_DEAD_LP_PCT))) return "screen_dead";
  return null;
}

/** Why a gate fired, in words (the copy log, copy_decisions). */
export function gateReason(name: GateName, signal: GateSignal, ctx: GateContext): string {
  switch (name) {
    case "below_min_leader_buy":
      return `the leader bought only ${signal.solAmount} SOL`;
    case "too_late":
      return `seen ${Math.round((ctx.now - signal.t) / 1000)}s after the leader traded`;
    case "pumpswap_hiprice":
      return `a pumpswap coin at ${signal.priceSol} SOL a token (≥ ${PUMPSWAP_HIPRICE_SOL}: these become unsellable within minutes)`;
    case "young_amm":
      return ctx.firstSeenAt === null
        ? `a ${baseVenue(signal.venue)} coin GodsEye has never seen before`
        : `a ${baseVenue(signal.venue)} coin first seen ${((ctx.now - ctx.firstSeenAt) / 60_000).toFixed(1)} min ago (under ${YOUNG_AMM_MIN} min)`;
    case "screen_dead":
      return ctx.screen?.failed ? "the rug screen failed" : `only ${ctx.screen?.lpLockedPct}% of its LP is locked`;
  }
}
