/**
 * What the public website is allowed to show. The agent's database holds its full internal state; nothing reaches the
 * public API or the hosted copy of the dashboard without passing through `publicView`, which keeps only the fields
 * listed here for each feed. A new database column, a new field or a whole new feed stays private until it is added
 * to a shape below. On top of that list the public view:
 *   • hides the hot wallet's address (anyone could watch, front-run or target it); its balance is shown (the owner asked);
 *   • leaves the agent's own transaction signatures out of copy trades and exit reasons, and blanks any text that
 *     names its wallet;
 *   • hides the raw agent logs;
 *   • reduces each copy decision to its outcome (no internal reason text, sizing weight or latency);
 *   • hides the learned tuning thresholds (the "follow bar" and its history), also inside any reason text
 *     (`redactThresholds`: follow-bar %, top-N leader count, budget cap %, "N needed" minimums);
 *   • words the "insider" tier as an early-entry pattern: a heuristic, not an accusation;
 *   • shows nothing that ties a wallet to an X account (no handle, no caller list, no label that comes from X), and
 *     drops every field whose name mentions "social" (the brain's social layer is private, in every feed);
 *   • shows a proof-ledger payload only for the entry kinds in PUBLIC_PROOF_KINDS, exactly as it was committed, so
 *     its hash can still be checked.
 * Internal enums (tier "insider" etc.) are unchanged. The owner can see everything with GODSEYE_FULL_FEED=1 on a
 * dashboard started on their own machine with `npm run dashboard`; a production build and Vercel ignore the switch.
 */
import type {
  CopiesData, CopyTrade, Evidence, LeadersData, LiveWalletRow, PaperData, PaperEquityPoint, Performance, Position,
  ProofData, RugCheckEntry, RunnersData, SmartMoneyData, SmartWalletRow, Summary, SwapRow, WalletDetail, WalletGroup,
  WalletList, WalletRow, WalletStats, WeightChange,
} from "./dashboard-types";

export const PUBLIC_TIER_LABEL = "Early-entry pattern";

export type PublicFeed =
  | "summary" | "logs" | "copies" | "smart" | "leaders" | "wallets" | "wallet" | "groups"
  | "performance" | "proof" | "rugchecks" | "stream" | "runners" | "paper";

/**
 * True when this dashboard should show the full internal feed: the owner's own machine only. A production build
 * (`next start`) and Vercel never do, whatever the switch says, so a stray setting can't open the public site.
 */
export function fullFeedEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.GODSEYE_FULL_FEED === "1" && env.NODE_ENV !== "production" && !env.VERCEL;
}

/** Public wording for text that names the insider tier. */
export function publicText(s: string): string {
  return s.replace(/\bInsider pattern\b/g, PUBLIC_TIER_LABEL).replace(/\binsider pattern\b/g, PUBLIC_TIER_LABEL.toLowerCase());
}

const THRESHOLD_RULES: [RegExp, string][] = [
  // weights.ts: "wins 64% of trades; GodsEye currently follows ≥ 80% (learned)"
  [/;?\s*GodsEye currently follows\s*(?:≥|>=)\s*[\d.,]+\s*%\s*(?:\(learned\))?/g, "; win rate below the current follow bar"],
  // adaptive.ts: "following wallets with ≥ 55% wins"
  [/following wallets with\s*(?:≥|>=)\s*[\d.,]+\s*%\s*wins/g, "following wallets above the follow bar"],
  // weights.ts / evaluations.ts: "not in the top 8 earners", "a place among the top 8 earners"
  [/\bnot in the top\s+\d+\s+earners\b/g, "not currently among the top earners"],
  [/\bamong the top\s+\d+\s+earners\b/g, "among the top earners"],
  // weights.ts: "capped at 25% of the budget"
  [/\bcapped at\s+[\d.,]+\s*%\s+of the budget\b/g, "capped at its share of the budget"],
  // many modules: "(10 needed before GodsEye copies a wallet)", "($5000 needed)"
  [/\s*\(\$?[\d.,]+\s+needed\b[^)]*\)/g, " (below GodsEye's current minimum)"],
  // any other "follow bar" / "bar" number, e.g. "bar 62%", "bar of 0.62"
  [/\b(follow bar|win-rate bar)(\s*(?:of|at|is|=|:)?\s*)(?:≥|>=)?\s*[\d.,]+\s*%?/gi, "$1"],
];

/** Removes learned thresholds and settings from free text; the wallet's own stats are left as they are. */
export function redactThresholds(s: string): string {
  let out = s;
  for (const [re, to] of THRESHOLD_RULES) out = out.replace(re, to);
  return out.replace(/^;\s*/, "").replace(/;\s*;/g, ";");
}

type Obj = Record<string, unknown>;
/** Works out a field's public value from the row it sits in. The result is published as it stands. */
type Rule = (row: Obj, own: string | null) => unknown;
/** A record of plain numbers under any names (counts per tier, model scores). */
const NUMBERS = "numbers";
/**
 * What to publish of a value: 1 = the value itself (text goes through the wording filters), 0 = never, NUMBERS,
 * [shape] = a list, { field: shape or rule } = these fields only.
 */
type Shape = 0 | 1 | typeof NUMBERS | readonly [Shape] | { readonly [field: string]: Shape | Rule };
/** The shape of a dashboard type. Every field of the type has to be decided here, so a new field fails the typecheck. */
type ShapeOf<T> = T extends readonly (infer U)[]
  ? readonly [ShapeOf<U>]
  : T extends object
    ? { readonly [K in keyof T]-?: ShapeOf<NonNullable<T[K]>> | Rule | 0 } | (T extends Record<string, number> ? typeof NUMBERS : never)
    : 1;

/** The field is there for the pages, its value is not. */
const HIDDEN: Rule = () => null;
const NONE: Rule = () => [];

/** A transaction signature is 64 to 88 base58 characters; no address is that long. */
const SIGNATURE_LIKE = /[1-9A-HJ-NP-Za-km-z]{64,}/;
const SIGNATURES = new RegExp(SIGNATURE_LIKE.source, "g");
/** Text with every transaction signature taken out: for errors and log lines, where only the agent's own can appear. */
export const hideSignatures = (s: string): string => s.replace(SIGNATURES, "[signature hidden]");
/** Text with the agent's own address replaced by a placeholder: for log lines, which are kept and may be read later. */
export const hideOwnWallet = (s: string, own: string | null): string => (own ? s.split(own).join("[agent wallet]") : s);
/** Why a position closed. An error quoted in it could name the agent's transaction, which leads to its wallet. */
const exitReason: Rule = (p, own) => (typeof p.exit_reason === "string" ? hideSignatures(publicString(p.exit_reason, own)) : null);
/** Who first funded a wallet. One the agent funded reads as unknown: a blank where others have an address would give it away. */
const funder: Rule = (w, own) => (typeof w.funder === "string" && w.funder !== own ? publicString(w.funder, own) : null);
/** How many wallets share that funder: just itself when the funder is withheld. */
const groupSize: Rule = (w, own) => (own && w.funder === own ? 1 : typeof w.group_size === "number" ? w.group_size : null);

const WALLET_ROW: ShapeOf<WalletRow> = {
  address: 1, tier: 1, tier_reason: 1, tier_changed_at: 1, kind: 1, ai_score: 1, copy_weight: 1, is_fresh: 1, funder,
  discovered_via: 1, first_seen_at: 1, chain_created_at: 1, age_is_lower_bound: 1, last_activity_at: 1, history_from: 1,
  last_analyzed_at: 1, pnl_7d_sol: 1, pnl_30d_sol: 1, pnl_7d_usd: 1, pnl_30d_usd: 1, win_rate_30d: 1, closed_30d: 1,
  swaps_30d: 1, group_size: groupSize, is_smart: 1,
};
const WALLET_ROWS: ShapeOf<WalletRow[]> = [WALLET_ROW];
const WALLET_LIST: ShapeOf<WalletList> = { rows: [WALLET_ROW], total: 1 };

const WALLET_STATS: ShapeOf<WalletStats> = {
  swaps_total: 1, swaps_7d: 1, swaps_30d: 1, pnl_7d_sol: 1, pnl_30d_sol: 1, pnl_all_sol: 1, pnl_7d_usd: 1, pnl_30d_usd: 1,
  pnl_all_usd: 1, closed_7d: 1, closed_30d: 1, wins_30d: 1, win_rate_30d: 1, best_trade_share: 1, avg_buy_sol: 1,
  avg_buy_usd: 1, avg_hold_minutes: 1, median_hold_sec: 1, same_block_round_trips: 1, early_buys: 1, early_buy_rate: 1,
  first_trade_at: 1, last_trade_at: 1, computed_at: 1,
};
// Evidence and swaps are the watched wallet's own transactions, so their signatures stay.
const EVIDENCE: ShapeOf<Evidence> = { id: 1, kind: 1, detail: 1, mint: 1, signature: 1, ts: 1 };
const SWAP: ShapeOf<SwapRow> = {
  id: 1, signature: 1, ts: 1, mint: 1, symbol: 1, side: 1, token_amount: 1, sol_amount: 1, price_sol: 1, quote: 1,
  quote_amount: 1, usd_amount: 1, venue: 1, token_age_sec: 1,
};
const WEIGHT_CHANGE: ShapeOf<WeightChange> = { id: 1, wallet: 1, ts: 1, old_weight: 1, new_weight: 1, reason: 1 };
const SMART_WALLET: ShapeOf<SmartWalletRow> = {
  address: 1, source: 1, pnl_usd: 1, closed: 1, win_rate: 1, lead_n: 1, lead_hit_rate: 1, lead_median_6h: 1, active: 1,
  reason: 1, tier: 1, kind: 1,
};

/** A copy decision reduced to its outcome. `signature` is the agent's own transaction: it would give its wallet away. */
const TRADE: ShapeOf<CopyTrade> = {
  id: 1, decider: 1, leader: 1, leader_ts: 1, mint: 1, symbol: 1, side: 1, mode: 1, status: 1, size_sol: 1, token_amount: 1,
  price_sol: 1, fee_sol: 1, position_id: 1, created_at: 1, filled_at: 1, proof_hash: 1,
  reason: (t) => (t.status === "skipped" ? "Skipped by GodsEye's safety checks" : null),
  error: (t) => (t.status === "failed" ? "The trade did not go through" : null),
  weight: HIDDEN, latency_ms: HIDDEN, signature: 0, leader_signature: 0,
};
const POSITION: ShapeOf<Position> = {
  id: 1, decider: 1, mint: 1, symbol: 1, leader: 1, mode: 1, status: 1, token_amount: 1, tokens_bought: 1, cost_sol: 1, proceeds_sol: 1,
  cost_usd: 1, proceeds_usd: 1, pnl_usd: 1, fee_sol: 1, entry_price_sol: 1, last_price_sol: 1, last_price_ts: 1, opened_at: 1,
  closed_at: 1, exit_reason: exitReason, pnl_sol: 1, pnl_pct: 1, unrealized_sol: 1, unrealized_pct: 1, unrealized_usd: 1,
};

const SUMMARY: ShapeOf<Summary> = {
  live: 1, heartbeat: 1, agentStatus: 1, copyMode: 1, paused: 1, pnlSince: 1,
  wallet: { pubkey: HIDDEN, balanceSol: 1, checkedAt: 1 },
  closedPositions: 1, wins: 1, losses: 1, winRate: 1, realizedPnlSol: 1, todayPnlSol: 1, unrealizedPnlSol: 1,
  realizedPnlUsd: 1, todayPnlUsd: 1, unrealizedPnlUsd: 1, feesSol: 1, feesUnrecorded: 1, solUsd: 1, openPositions: 1,
  maxPositions: 1, copiesToday: 1, walletsTracked: 1, leaders: 1, freshWallets24h: 1, tierCounts: NUMBERS,
  kindCounts: NUMBERS, lastLearningAt: 1, lastDiscoveryAt: 1,
  limits: {
    at: 1, tradeSol: 1, tradePct: 1, equitySol: 1, dayChangePct: 1, fromHighPct: 1, stoppedToday: 1, selfPaused: 1, blocked: 1,
    rails: { maxTradePct: 1, dailyStopPct: 1, drawdownPausePct: 1, minEquitySol: 1 },
  },
  real: {
    deciders: [{ decider: 1, closed: 1, won: 1, pnlSol: 1, pnlUsd: 1, open: 1 }],
    sleeve: { state: 1, sharePct: 1 },
  },
  week: { started: 1, stopped: 1, raised: 1, lowered: 1, ruleChanges: 1, closedCopies: 1, modelVersion: 1, modelTrainedAt: 1 },
  funding: { depositsSol: 1, withdrawalsSol: 1, rewardsInSol: 1, payoutsSol: 1 },
  allTime: { closedPositions: 1, realizedPnlSol: 1, realizedPnlUsd: 1 },
  stream: {
    enabled: 1, status: 1, healthy: 1, ipTries: 1, ipDistinct: 1, lastAt: 1, txPerSec: 1, swapsPerSec: 1,
    walletsInMemory: 1, walletsSeen24h: 1, walletsSeenTotal: 1,
  },
};

const WALLET_DETAIL: ShapeOf<WalletDetail> = {
  wallet: WALLET_ROW, stats: WALLET_STATS, evidence: [EVIDENCE], kindReasons: [{ points: 1, reason: 1 }], swaps: [SWAP],
  weightHistory: [WEIGHT_CHANGE], group: [WALLET_ROW], copies: [TRADE], copyPnlSol: 1, copyPnlUsd: 1, copyClosed: 1,
  smart: SMART_WALLET,
};

const GROUPS: ShapeOf<WalletGroup[]> = [{
  funder: 1, funder_tier: 1, size: 1, ai: 1, human: 1, unknown: 1, fresh: 1, newest_at: 1, likely_exchange: 1,
  members: [{ address: 1, tier: 1, kind: 1, ai_score: 1, is_fresh: 1, pnl_30d_sol: 1, pnl_30d_usd: 1, chain_created_at: 1 }],
}];

const LEADERS: ShapeOf<LeadersData> = {
  leaders: [{
    address: 1, tier: 1, kind: 1, copy_weight: 1, weight_reason: 1, pnl_7d_sol: 1, pnl_30d_sol: 1, pnl_7d_usd: 1,
    pnl_30d_usd: 1, win_rate_30d: 1, closed_30d: 1, copy_pnl_sol: 1, copy_pnl_usd: 1, copy_closed: 1, last_activity_at: 1,
    history_from: 1,
  }],
  changes: [WEIGHT_CHANGE], budgetSol: 1, followBar: HIDDEN, followBarHistory: NONE,
};

const COPIES: ShapeOf<CopiesData> = { open: [POSITION], closed: [POSITION], trades: [TRADE] };

const PERFORMANCE: ShapeOf<Performance> = {
  startingCapitalUsd: 1, pnlSince: 1,
  equity: [{ ts: 1, equity: 1, cumPnl: 1, drawdownPct: 1 }],
  rollingWinRate: [{ day: 1, winRate: 1, trades: 1 }],
  monthly: [{ month: 1, pnlSol: 1, returnPct: 1 }],
  drawdown: { maxDrawdownPct: 1, maxDrawdownSol: 1, peakTs: 1, troughTs: 1 },
  currentDrawdownPct: 1, avgWinPct: 1, avgLossPct: 1, profitFactor: 1,
};

/** Ledger entries whose payload holds no secret. Any other kind shows its hash and time only, until it is listed here. */
const PUBLIC_PROOF_KINDS = ["copy_buy", "copy_sell"];
/**
 * The payload exactly as committed (a changed character would break its hash), or nothing at all. A buy's payload
 * names the leader's transaction, which is public; a sell's has none, so one that holds a signature is withheld.
 */
const proofPayload: Rule = (e, own) => {
  const { kind, payload } = e;
  if (typeof kind !== "string" || typeof payload !== "string" || !PUBLIC_PROOF_KINDS.includes(kind)) return null;
  if ((own && payload.includes(own)) || (kind !== "copy_buy" && SIGNATURE_LIKE.test(payload))) return null;
  return payload;
};
const PROOF: ShapeOf<ProofData> = {
  entries: [{ id: 1, kind: 1, payload: proofPayload, prev_hash: 1, hash: 1, committed_at: 1 }],
  total: 1,
  chain: { ok: 1, checked: 1, brokenAtId: 1 },
};

const RUG_CHECKS: ShapeOf<RugCheckEntry[]> = [{ mint: 1, symbol: 1, verdict: 1, blocks: [1], warnings: [1], rugcheck_score: 1, checked_at: 1 }];

const LIVE: ShapeOf<LiveWalletRow[]> = [{
  address: 1, first_seen_at: 1, last_seen_at: 1, swaps: 1, buys: 1, sells: 1, volume_sol: 1, live_pnl_sol: 1, live_pnl_usd: 1,
  live_closed: 1, live_wins: 1, live_kind: 1, live_ai_score: 1, promoted: 1, tier: 1,
}];

const SMART: ShapeOf<SmartMoneyData> = {
  followBar: HIDDEN, activeWallets: 1, droppedWallets: 1,
  flows: [{
    mint: 1, symbol: 1, buy_usd_1h: 1, sell_usd_1h: 1, buy_usd_24h: 1, sell_usd_24h: 1, buyers_24h: 1, sellers_24h: 1,
    first_smart_buy_at: 1, change_since_first_buy: 1, last_trade_at: 1, organic: 1, traders: 1, organic_score: 1,
  }],
  signals: [{
    id: 1, ts: 1, mint: 1, symbol: 1, kind: 1, wallet_count: 1, usd: 1, token_age_min: 1, ret_1h: 1, ret_6h: 1, ret_24h: 1,
    organic: 1,
  }],
  scorecard: [{ kind: 1, horizon: 1, signals: 1, measured: 1, hit_rate: 1, median_ret: 1 }],
  wallets: [SMART_WALLET], trades24h: 1,
};

/**
 * The catcher labels that are settled before the X check (runners/score.ts). The other two differ only in whether the
 * wallet is tied to an X account, so showing either one would give that away.
 */
const ON_CHAIN_LABELS = ["insider", "sniper", "bot"];
const RUNNERS: ShapeOf<RunnersData> = {
  definition: { minMultiple: 1, mcapCutUsd: 1, minMinutesAbove5x: 1, coins: 1, runners: 1, at: 1 },
  coinsWatched: 1,
  runners: [{ mint: 1, symbol: 1, first_seen: 1, multiple: 1, peak_mcap_usd: 1, minutes_above_5x: 1, buyers: 1, source: 1 }],
  catchers: [{
    wallet: 1, hits: 1, early_buys: 1, hit_rate: 1, hit_rate_lb: 1, base_rate: 1, days: 1, median_entry_x: 1,
    median_x_to_peak: 1, capture: 1, copyable_share: 1, qualifies: 1,
    label: (c) => (typeof c.label === "string" && ON_CHAIN_LABELS.includes(c.label) ? c.label : null),
    x_handle: 0,
  }],
  callers: NONE,
};

const EQUITY: ShapeOf<PaperEquityPoint[]> = [{ ts: 1, equity: 1 }];
const PAPER: ShapeOf<PaperData> = {
  accounts: [{
    account: 1, startedAt: 1, startingSol: 1, equitySol: 1, pnlSol: 1, returnPct: 1, winRate: 1, maxDrawdownPct: 1,
    closedTrades: 1, openTrades: 1,
  }],
  equity: { brain: EQUITY, baseline: EQUITY, explore: EQUITY },
  trades: [{ account: 1, symbol: 1, mint: 1, leader: 1, stake_sol: 1, exit_reason: 1, pnl_pct: 1, pnl_sol: 1, closed_at: 1 }],
  model: { version: 1, createdAt: 1, loadedAt: 1, realMoney: 1 },
  live: { streaming: 1, status: 1, lastAt: 1, heartbeat: 1, agentStatus: 1 },
};

const FEEDS: Record<Exclude<PublicFeed, "logs" | "wallets">, Shape> = {
  summary: SUMMARY, wallet: WALLET_DETAIL, groups: GROUPS, leaders: LEADERS, copies: COPIES, performance: PERFORMANCE,
  proof: PROOF, rugchecks: RUG_CHECKS, stream: LIVE, smart: SMART, runners: RUNNERS, paper: PAPER,
};

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isList = (s: Shape): s is readonly [Shape] => Array.isArray(s);
const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

/** Field names that are never published: the social layer stays private. */
const PRIVATE_KEY = /social/i;

/** Public wording for one text. A text that names the agent's own wallet is blanked whole. */
function publicString(s: string, own: string | null): string {
  return own && s.includes(own) ? "" : redactThresholds(publicText(s));
}

/** The part of `v` that `shape` lists. Anything of an unexpected kind comes out empty, never as it went in. */
function pick(shape: Shape, v: unknown, own: string | null): unknown {
  if (shape === 0) return null;
  if (shape === 1) return typeof v === "string" ? publicString(v, own) : typeof v === "number" || typeof v === "boolean" || v == null ? v : null;
  if (shape === NUMBERS) {
    if (!isObj(v)) return v == null ? v : null;
    const out: Obj = {};
    for (const [k, x] of Object.entries(v)) if (typeof x === "number" && !PRIVATE_KEY.test(k)) out[k] = x;
    return out;
  }
  if (isList(shape)) return Array.isArray(v) ? v.map((x) => pick(shape[0], x, own)) : v == null ? v : [];
  if (!isObj(v)) return v == null ? v : null;
  const out: Obj = {};
  for (const k of Object.keys(v)) {
    if (!has(shape, k) || PRIVATE_KEY.test(k)) continue;
    const s = shape[k];
    if (typeof s === "function") out[k] = s(v, own);
    else if (s !== 0) out[k] = pick(s, v[k], own);
  }
  return out;
}

/**
 * The public version of one API answer: the fields listed for that feed and nothing else. `ownWallet` is the agent's
 * own address when the caller knows it (the agent before it publishes, a dashboard reading the database); the hosted
 * site doesn't, and gets data that was already reduced with it. Running the result through again changes nothing.
 */
export function publicView<T>(feed: PublicFeed, body: T, ownWallet: string | null = null): T {
  // Only a whole address counts: a short or empty value must not blank every text that happens to contain it.
  const own = ownWallet && ownWallet.length >= 32 ? ownWallet : null;
  if (isObj(body) && "error" in body) return { error: (typeof body.error === "string" && publicString(body.error, own)) || "Data is unavailable right now." } as T;
  if (feed === "logs") return [] as unknown as T;
  if (feed === "wallets") return pick(Array.isArray(body) ? WALLET_ROWS : WALLET_LIST, body, own) as T;
  return (has(FEEDS, feed) ? pick(FEEDS[feed], body, own) : null) as T;
}
