/**
 * THE BRAIN'S INPUTS — the entry and exit feature vectors of brain/spec/features.yaml, computed from what the server holds
 * when it decides: the incoming swap, the stream state (state.ts StreamState: the coin's ring, first sighting, the leader's
 * holding, the hourly active wallets), the leader ledgers (ledger.ts MirrorLedger) and a few indexed DB rows. The Python side
 * (brain/brain/features/entry.py, exit.py, spec.py) computes the same from the same inputs; brain/spec/golden/*.json pins
 * both to 1e-6 (test/brain-features.test.ts).
 *
 *   entryRaw    one leader buy at decision time t → each entry feature's raw value (NaN = missing; venue_group a level)
 *   entryGate   the first hard gate that fires (gates.ts, features.yaml order), or null: the signal reaches the network
 *   exitRaw     an open paper position's ExitState (paper.ts) + the coin's flow → each exit feature's raw value
 *   encode      raw values → the model's columns (features.yaml vector_layout): transforms, one-hot levels, `_missing` flags
 *   normalise   (x − mean) ÷ std per column with the manifest's norm; a missing (train_mean) value becomes 0
 *
 * Each feature reads exactly ONE live source (features.yaml conventions.live_sources), behind EntrySources: liveSources()
 * reads the server's structures, the golden test reads its cases. Windows (conventions.point_in_time): swaps by BLOCK time
 * [T − W, T) delivered before t (the ring's insert time `at` < t, wallet_swaps.ins_ms < t); ledger rows by availability
 * time [t − 7 d, t).
 * Times are integer epoch ms throughout, like the golden files, so a value on a window edge lands on the same side here and
 * in Python. The arithmetic follows Python's (its min/max ignore a NaN second argument, numpy's propagate it): a missing
 * input gives the same raw value on both sides.
 *
 * Bump FEATURE_SPEC_VERSION with features.yaml `version` (CONTRACT.md): a model bundle built for another version is refused.
 * Pure apart from liveSources' reads. Never logs: social_score is private (it is stored only in brain_transitions).
 */
import type { DB } from "@godseye/shared";
import { gate, type GateName } from "./gates";
import type { MirrorLedger } from "./ledger";
import type { StreamState } from "./state";

/** features.yaml `version`: what the model bundle's feature_spec_version must say. */
export const FEATURE_SPEC_VERSION = 1;

export type Transform = "none" | "share" | "log1p" | "log10" | "signed_log" | "onehot" | `clip:${number},${number}`;

/** One feature of the spec: its transform, whether a `<name>_missing` column follows it, and its missing-value default. */
export interface FeatureSpec {
  name: string;
  transform: Transform;
  missingFlag: boolean;
  /** The raw value used when missing; "train_mean" = the normalised value 0; a level for the one-hot feature. */
  default: number | "train_mean" | string;
}

const f = (name: string, transform: Transform, missingFlag: boolean, d: FeatureSpec["default"]): FeatureSpec => ({ name, transform, missingFlag, default: d });
const TM = "train_mean";

/** features.yaml `entry`, in spec order (test/brain-features.test.ts checks this against the yaml). */
export const ENTRY_FEATURES: readonly FeatureSpec[] = [
  f("cp_lrshr_7d", "none", false, 0),
  f("cp_n_7d", "log1p", false, 0),
  f("cp_win_7d", "share", true, TM),
  f("ps_r_7d", "clip:-1,3", true, TM),
  f("dd_rate_7d", "share", true, TM),
  f("b_first_7d", "share", true, TM),
  f("lf_flip60_7d", "share", true, TM),
  f("b_n_24h", "log1p", false, 0),
  f("leader_n_prior7", "log1p", false, 0),
  f("b_size_ratio", "clip:-5,5", true, 0),
  f("log_fee", "none", true, TM),
  f("venue_group", "onehot", false, "missing"),
  f("venue_via_bot", "none", false, 0),
  f("sfx_pump", "none", false, 0),
  f("log_mcap_sol", "clip:-1,8", true, TM),
  f("leader_sold_at_decision", "clip:0,1", false, 0),
  f("signal_lateness_sec", "log1p", false, 1),
  f("mint_first_seen_age_min", "log1p", true, 0),
  f("cr_seen_prior_7d", "log1p", true, TM),
  f("ret_since_first", "clip:-5,7", true, TM),
  f("dd_from_high", "clip:-6,3", true, TM),
  f("log_token_age", "none", true, TM),
  f("m_buyers_5m", "log1p", false, 0),
  f("m_buysol_5m", "log1p", false, 0),
  f("tracked_active_wallets_1h", "log10", false, TM),
  f("hour_sin", "none", false, 0),
  f("hour_cos", "none", false, 1),
  f("social_score", "none", false, 0),
  f("social_missing", "none", false, 1),
];

/** features.yaml `exit`, in spec order. */
export const EXIT_FEATURES: readonly FeatureSpec[] = [
  f("ret_now", "clip:-1,20", false, 0),
  f("peak_ret", "clip:-1,20", false, 0),
  f("drawdown_from_peak", "clip:0,1", false, 0),
  f("minutes_held", "log1p", false, 0),
  f("leader_sold", "none", false, 0),
  f("half_sold", "none", false, 0),
  f("minutes_since_price", "clip:0,60", false, 0),
  f("position", "none", false, 1),
  f("mins_since_tracked_price", "log1p", false, 0),
  f("quote_failed", "none", false, 0),
  f("sell_quote_ratio", "clip:0,2", true, 1),
  f("mom5", "clip:-3,3", false, 0),
  f("oth_buyers_5m", "log1p", false, 0),
  f("oth_sellers_5m", "log1p", false, 0),
  f("oth_net_sol_5m", "signed_log", false, 0),
  f("pts_5m", "log1p", false, 0),
  f("leader_sold_frac", "clip:0,1", false, 0),
  f("minutes_since_leader_sold", "log1p", false, 0),
  f("entry_venue_pumpswap", "none", false, 0),
  f("entry_tracked_active_wallets_1h", "log10", false, TM),
  f("leader_ps_r_7d", "clip:-1,3", true, TM),
];

/** venue_group's rules, first match wins (features.yaml venue_groups). */
export const VENUE_GROUPS: readonly { level: string; venues?: string[]; prefix?: string }[] = [
  { level: "pumpfun_curve", venues: ["pumpfun"] },
  { level: "pumpswap", venues: ["pumpswap"] },
  { level: "meteora_damm_v2", venues: ["meteora damm v2"] },
  { level: "meteora_other", prefix: "meteora" },
  { level: "raydium", prefix: "raydium" },
  { level: "orca", prefix: "orca" },
  { level: "jupiter", venues: ["jupiter"] },
  { level: "other", prefix: "" },
];
export const OTHER = "other";

export const DAY_MS = 86_400_000;
export const WINDOW_7D_MS = 7 * DAY_MS;
/** m_buyers_5m / m_buysol_5m, and the exit head's oth_* / pts_5m. */
export const FLOW_MS = 300_000;
/** dd_from_high ignores the last minute before T. */
export const HIGH_CUT_MS = 60_000;
/** lf_flip60_7d: a sell within this of the buy. */
export const FLIP_MS = 60_000;
/** A leader buy the style features count. */
export const MIN_STYLE_SOL = 0.05;
/** A copy-eligible leader buy (MIN_LEADER_BUY_SOL in the spec; leader_n_prior7 counts these). */
export const SPEC_LEADER_BUY_SOL = 0.2;
export const AGE_CAP_MIN = 10_080;
export const SOCIAL_SHRINK = 18;
export const SOCIAL_MAX_AGE_MS = 48 * 3_600_000;
export const TRACKED_CAP_MIN = 1440;
const LOG_FLOOR = 1e-9;
const VIA_BOT = " (via bot)";

// ---------------------------------------------------------------------------------------------------------------------
// Python's arithmetic: builtin min/max keep the first argument when the comparison with a NaN fails; numpy's propagate it.

const pyMax = (a: number, b: number) => (b > a ? b : a);
const pyMin = (a: number, b: number) => (b < a ? b : a);
const npMax = (a: number, b: number) => (Number.isNaN(a) || Number.isNaN(b) ? NaN : Math.max(a, b));
const npMin = (a: number, b: number) => (Number.isNaN(a) || Number.isNaN(b) ? NaN : Math.min(a, b));
const clip = (x: number, lo: number, hi: number) => (Number.isNaN(x) ? NaN : Math.min(Math.max(x, lo), hi));

/** A number, or NaN for anything missing or not finite (entry.py num). */
export const num = (v: unknown): number => {
  if (v === null || v === undefined || typeof v === "boolean") return NaN;
  const x = typeof v === "number" ? v : Number(v);
  return Number.isFinite(x) ? x : NaN;
};

/** The venue lower-cased without " (via bot)", and whether it had it; null when missing (entry.py strip_venue). */
export function stripVenue(venue: string | null | undefined): { venue: string | null; viaBot: boolean } {
  if (typeof venue !== "string" || !venue.trim()) return { venue: null, viaBot: false };
  const v = venue.trim().toLowerCase();
  return { venue: v.split(VIA_BOT).join("").trim(), viaBot: v.includes(VIA_BOT) };
}

/** features.yaml venue_group: the first matching rule; "missing" without a venue. */
export function venueGroup(venue: string | null | undefined): string {
  const v = stripVenue(venue).venue;
  if (v === null) return "missing";
  for (const g of VENUE_GROUPS) {
    if (g.venues?.includes(v)) return g.level;
    if (g.prefix !== undefined && v.startsWith(g.prefix)) return g.level;
  }
  return OTHER;
}

// ---------------------------------------------------------------------------------------------------------------------
// Column layout, transforms, encoding

/** The model's input columns: spec order, a one-hot feature as `<name>=<level>`, `<name>_missing` after flagged ones. */
export function columns(feats: readonly FeatureSpec[], categories: Record<string, readonly string[]> = {}): string[] {
  const out: string[] = [];
  for (const ft of feats) {
    if (ft.transform === "onehot") {
      const levels = categories[ft.name];
      if (!levels?.length) throw new Error(`categories.${ft.name}: no levels`);
      out.push(...levels.map((lv) => `${ft.name}=${lv}`));
    } else out.push(ft.name);
    if (ft.missingFlag) out.push(`${ft.name}_missing`);
  }
  return out;
}

export const entryColumns = (categories: Record<string, readonly string[]>): string[] => columns(ENTRY_FEATURES, categories);
export const exitColumns = (): string[] => columns(EXIT_FEATURES);

/** features.yaml conventions.transforms on one value (NaN stays NaN). */
export function transform(kind: Transform, x: number): number {
  switch (kind) {
    case "none":
    case "share":
      return x;
    case "log1p":
      return Math.log1p(npMax(x, 0));
    case "log10":
      return Math.log10(npMax(x, 1));
    case "signed_log":
      return Math.sign(x) * Math.log1p(Math.abs(x));
    case "onehot":
      throw new Error("a one-hot feature has no numeric transform");
    default: {
      const [lo, hi] = kind.slice(5).split(",").map(Number);
      return clip(x, lo, hi);
    }
  }
}

/** Raw values by feature name: a number (NaN = missing) or, for the one-hot feature, its level. */
export type RawValues = Record<string, number | string | null>;

/**
 * Raw values → the transformed columns (spec.py encode): a missing value with a numeric default becomes that default
 * before the transform, one with default train_mean stays NaN (normalise makes it 0), and its `_missing` flag is 1.
 * An unseen or absent level maps to `<name>=other`.
 */
export function encode(raw: RawValues, feats: readonly FeatureSpec[], categories: Record<string, readonly string[]> = {}): number[] {
  const out: number[] = [];
  for (const ft of feats) {
    const v = raw[ft.name];
    if (ft.transform === "onehot") {
      const levels = categories[ft.name] ?? [];
      const given = v === null || v === undefined || (typeof v === "number" && Number.isNaN(v)) ? String(ft.default) : String(v);
      const level = levels.includes(given) ? given : OTHER;
      for (const lv of levels) out.push(lv === level ? 1 : 0);
      if (ft.missingFlag) out.push(v === null || v === undefined ? 1 : 0);
      continue;
    }
    let x = num(v);
    const miss = Number.isNaN(x);
    if (miss && ft.default !== TM) x = Number(ft.default);
    out.push(miss && ft.default === TM ? NaN : transform(ft.transform, x));
    if (ft.missingFlag) out.push(miss ? 1 : 0);
  }
  return out;
}

/** The normalisation stored per net in the manifest, per column. */
export interface ColumnNorm {
  mean: readonly number[];
  std: readonly number[];
}

/** (x − mean) ÷ std per column, in float64; a missing (NaN) or non-finite result becomes 0, the column's training mean. */
export function normalise(x: readonly number[], norm: ColumnNorm): number[] {
  if (norm.mean.length !== x.length || norm.std.length !== x.length) throw new Error(`norm has ${norm.mean.length} columns, the vector ${x.length}`);
  return x.map((v, i) => {
    const z = (v - norm.mean[i]) / norm.std[i];
    return Number.isFinite(z) ? z : 0;
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Entry

/** The incoming leader buy. `T` is its block time (ms). */
export interface EntrySignal {
  wallet: string;
  mint: string;
  solAmount: number;
  priceSol: number | null;
  venue: string | null;
  feeLamports: number | null;
  T: number;
}

/** One swap of a coin's ring (StreamState): block time `ts`, insert time `at` (ms). */
export interface RingSwap {
  wallet: string;
  side: "buy" | "sell";
  sol: number;
  price: number;
  ts: number;
  at: number;
  ok: boolean;
}

/** A leader's wallet_swaps row as the style scan reads it (ts in ms). */
export interface LeaderSwapRow {
  mint: string;
  side: string;
  sol: number;
  ts: number;
}

/**
 * Where each entry feature reads its live source (features.yaml live_source): one structure per method. liveSources() is
 * the server's; the golden test implements the same over its cases.
 */
export interface EntrySources {
  /** ledger: MirrorLedger.cp(leader, t). */
  cp(leader: string, t: number): { cp_lrshr_7d: number; cp_n_7d: number; cp_win_7d: number | null };
  /** ledger: MirrorLedger.psR(leader, t); null = missing. */
  psR(leader: string, t: number): number | null;
  /** ledger: MirrorLedger.ddRate(leader, t); null = missing. */
  ddRate(leader: string, t: number): number | null;
  /**
   * db: the leader's wallet_swaps rows with block time in [from, to) stored before `knownBefore` (ins_ms; a row from
   * before that column counts), one indexed scan for five features.
   */
  leaderSwaps(leader: string, from: number, to: number, knownBefore: number): LeaderSwapRow[];
  /** ring: the coin's tracked swaps with block time in [end − windowMs, end) delivered before `knownBefore`. */
  ring(mint: string, end: number, windowMs: number, knownBefore: number): RingSwap[];
  /** ring: the coin's highest ok price with block time before `cut` (within 7 days) delivered before t; null = none. */
  maxOkBefore(mint: string, cut: number, t: number): number | null;
  /** ring: the coin's first sighting (brain_token_first_seen); null = never seen. creator: null = not looked up, '' = none. */
  firstSeen(mint: string): { firstSeenAt: number; firstOkPrice: number | null; firstOkAt: number | null; creator: string | null } | null;
  /** db: the creator's other coins first seen in [t − 7 d, t) (brain_token_first_seen by (creator, first_seen_at)). */
  creatorCoins7d(creator: string, t: number, exceptMint: string): number;
  /** ring: the leader's holding since its latest buy of the coin; null = unknown. */
  leaderHolding(leader: string, mint: string): { postBuyTokens: number | null; soldTokens: number } | null;
  /** ring: distinct tracked wallets in the previous complete UTC hour before t; null = no process saw all of it. */
  activeWallets1h(t: number): number | null;
  /** db: the coin's token_info row (times in ms, null = unknown); null = no row. */
  tokenInfo(mint: string): { poolCreatedAt: number | null; launchCheckedAt: number | null } | null;
  /** db: the leader's social_scores row; null = none. */
  social(leader: string): { score: number | null; modelVersion: string | null; updatedAt: number | null } | null;
  /** The live social model's version (<BRAIN_DIR>/social/current); null = none. */
  socialModelVersion(): string | null;
}

/** Every entry feature's raw value for one leader buy decided at t (entry.py entry_raw). */
export function entryRaw(s: EntrySignal, t: number, src: EntrySources): RawValues {
  const T = s.T;
  const leader = s.wallet;
  const mint = s.mint;
  const sol = num(s.solAmount);
  const price = num(s.priceSol);
  const out: RawValues = {};

  // ---- the mirror / ps / dd ledgers: rows available in [t − 7 d, t)
  const cp = src.cp(leader, t);
  out.cp_lrshr_7d = num(cp.cp_lrshr_7d);
  out.cp_n_7d = num(cp.cp_n_7d);
  out.cp_win_7d = num(cp.cp_win_7d);
  out.ps_r_7d = num(src.psR(leader, t));
  out.dd_rate_7d = num(src.ddRate(leader, t));

  // ---- the leader's wallet_swaps scan: block time in [T − 7 d, T)
  const scan = src.leaderSwaps(leader, T - WINDOW_7D_MS, T, t).filter((r) => Number.isFinite(r.ts) && r.ts >= T - WINDOW_7D_MS && r.ts < T);
  const buys = scan.filter((r) => r.side === "buy" && num(r.sol) >= MIN_STYLE_SOL);
  out.b_first_7d = buys.length ? new Set(buys.map((r) => r.mint)).size / buys.length : NaN;
  out.b_n_24h = buys.filter((r) => r.ts >= T - DAY_MS).length;
  out.leader_n_prior7 = new Set(buys.filter((r) => r.sol >= SPEC_LEADER_BUY_SOL).map((r) => r.mint)).size;
  out.b_size_ratio = buys.length && sol > 0 ? Math.log(sol) - buys.reduce((a, r) => a + Math.log(r.sol), 0) / buys.length : NaN;
  const sells = new Map<string, number[]>();
  for (const r of scan) if (r.side === "sell") (sells.get(r.mint) ?? sells.set(r.mint, []).get(r.mint)!).push(r.ts);
  const done = buys.filter((r) => r.ts < T - FLIP_MS);
  const flips = done.filter((b) => (sells.get(b.mint) ?? []).some((x) => b.ts <= x && x <= b.ts + FLIP_MS)).length;
  out.lf_flip60_7d = done.length ? flips / done.length : NaN;

  // ---- the incoming swap
  const fee = num(s.feeLamports);
  out.log_fee = fee >= 0 ? Math.log1p(fee) : NaN;
  out.venue_group = venueGroup(s.venue);
  out.venue_via_bot = stripVenue(s.venue).viaBot ? 1 : 0;
  out.sfx_pump = mint.endsWith("pump") ? 1 : 0;
  out.log_mcap_sol = price > 0 ? Math.log10(price * 1e9) : NaN;
  const h = src.leaderHolding(leader, mint);
  const post = h ? num(h.postBuyTokens) : NaN;
  out.leader_sold_at_decision = h && post > 0 ? pyMin(1, pyMax(0, num(h.soldTokens) / post)) : 0;
  out.signal_lateness_sec = pyMax(0, (t - T) / 1000);

  // ---- the coin: first sighting, creator, highs, launch time, the 5-min crowd
  const fs = src.firstSeen(mint);
  const fsa = fs ? num(fs.firstSeenAt) : NaN;
  out.mint_first_seen_age_min = fsa < T ? pyMin(AGE_CAP_MIN, (t - fsa) / 60_000) : NaN;
  const creator = fs?.creator;
  out.cr_seen_prior_7d = creator ? src.creatorCoins7d(creator, t, mint) : NaN;
  const fop = fs ? num(fs.firstOkPrice) : NaN;
  const foa = fs ? num(fs.firstOkAt) : NaN;
  out.ret_since_first = fop > 0 && foa < T && price > 0 ? Math.log(price / fop) : NaN;
  const high = src.maxOkBefore(mint, T - HIGH_CUT_MS, t);
  out.dd_from_high = high !== null && price > 0 ? Math.log(price / high) : NaN;
  const ti = src.tokenInfo(mint);
  const pca = ti ? num(ti.poolCreatedAt) : NaN;
  const lca = ti ? num(ti.launchCheckedAt) : NaN;
  out.log_token_age = Number.isFinite(pca) && lca < t ? Math.log1p(pyMax(0, (T - pca) / 1000)) : NaN;
  const crowd = src.ring(mint, T, FLOW_MS, t).filter((r) => r.wallet !== leader && r.side === "buy" && r.ok && r.at < t && r.ts >= T - FLOW_MS && r.ts < T);
  out.m_buyers_5m = new Set(crowd.map((r) => r.wallet)).size;
  out.m_buysol_5m = crowd.reduce((a, r) => a + num(r.sol), 0);

  // ---- regime, clock, social
  out.tracked_active_wallets_1h = num(src.activeWallets1h(t));
  const hour = (t % DAY_MS) / 3_600_000;
  out.hour_sin = Math.sin((2 * Math.PI * hour) / 24);
  out.hour_cos = Math.cos((2 * Math.PI * hour) / 24);
  const soc = src.social(leader);
  const live = soc ? src.socialModelVersion() : null;
  const updated = soc ? num(soc.updatedAt) : NaN;
  if (soc && live && soc.modelVersion === live && Number.isFinite(updated) && t - updated <= SOCIAL_MAX_AGE_MS && Number.isFinite(num(soc.score))) {
    out.social_score = (num(soc.score) * SOCIAL_SHRINK) / (SOCIAL_SHRINK + (out.leader_n_prior7 as number));
    out.social_missing = 0;
  } else {
    out.social_score = 0;
    out.social_missing = 1;
  }
  return out;
}

/** The first hard gate (features.yaml `gates`, in order) that fires for this signal, or null (gates.ts gate). */
export function entryGate(
  s: EntrySignal,
  t: number,
  src: Pick<EntrySources, "firstSeen">,
  screen: { failed: boolean; lpLockedPct: number | null } | null = null,
): GateName | null {
  const fs = src.firstSeen(s.mint);
  // A first sighting at or after the leader's block second is no sighting (mint_first_seen_age_min missing).
  const firstSeenAt = fs && num(fs.firstSeenAt) < s.T ? fs.firstSeenAt : null;
  return gate(
    { solAmount: s.solAmount, priceSol: s.priceSol, venue: s.venue, t: s.T },
    { now: t, firstSeenAt, screen, minLeaderBuySol: SPEC_LEADER_BUY_SOL },
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Exit

/** The coin's tracked flow in [t − 5 min, t) delivered before t (the exit head's oth_* / pts_5m). */
export interface ExitFlow {
  oth_buyers_5m: number;
  oth_sellers_5m: number;
  oth_net_sol_5m: number;
  pts_5m: number;
}

/**
 * An open position at decision time t: paper.ts ExitState's fields, the position's tokens and venue, the coin's flow, the
 * hourly active wallets and the entry's ps_r_7d. null / undefined = missing.
 */
export interface ExitInputs {
  ret_now: number | null;
  peak_ret: number | null;
  minutes_held: number | null;
  leader_sold: boolean | number | null;
  half_sold: boolean | number | null;
  minutes_since_price: number | null;
  quote_failed: boolean | number | null;
  mins_since_tracked_price: number | null;
  sell_quote_ratio: number | null;
  /** Absent = 0 (mom5 from the entry). */
  ret_5m_ago?: number | null;
  leader_sold_frac: number | null;
  minutes_since_leader_sold: number | null;
  tokens: number | null;
  tokens_left: number | null;
  venue: string | null;
  flow: ExitFlow;
  active_wallets_1h: number | null;
  leader_ps_r_7d: number | null;
}

/** exit.py flow: the flow of a ring at t, the leader left out of the oth_* counts (pts_5m counts everyone's ok swaps). */
export function ringFlow(ring: readonly RingSwap[], t: number, leader: string | null, windowMs = FLOW_MS): ExitFlow {
  const buyers = new Set<string>();
  const sellers = new Set<string>();
  let net = 0;
  let pts = 0;
  for (const r of ring) {
    if (!(t - windowMs <= r.ts && r.ts < t) || !(r.at < t)) continue;
    if (r.ok) pts++;
    if (r.wallet === leader) continue;
    if (r.side === "buy") {
      buyers.add(r.wallet);
      net += r.sol;
    } else {
      sellers.add(r.wallet);
      net -= r.sol;
    }
  }
  return { oth_buyers_5m: buyers.size, oth_sellers_5m: sellers.size, oth_net_sol_5m: net, pts_5m: pts };
}

const flag = (v: boolean | number | null | undefined): number => (v === true || num(v) > 0 ? 1 : 0);

/** Every exit feature's raw value (exit.py exit_raw for one decision). */
export function exitRaw(i: ExitInputs): RawValues {
  const ret = num(i.ret_now);
  const peak = num(i.peak_ret);
  const r5 = i.ret_5m_ago === undefined ? 0 : num(i.ret_5m_ago);
  const tokens = num(i.tokens);
  const lsf = num(i.leader_sold_frac);
  return {
    ret_now: ret,
    peak_ret: peak,
    drawdown_from_peak: 1 + peak > 0 ? npMax(0, 1 - (1 + ret) / (1 + peak)) : 0,
    minutes_held: num(i.minutes_held),
    leader_sold: flag(i.leader_sold),
    half_sold: flag(i.half_sold),
    minutes_since_price: num(i.minutes_since_price),
    position: tokens > 0 ? num(i.tokens_left) / tokens : 1,
    mins_since_tracked_price: npMin(num(i.mins_since_tracked_price), TRACKED_CAP_MIN),
    quote_failed: flag(i.quote_failed),
    sell_quote_ratio: num(i.sell_quote_ratio),
    mom5: Math.log(npMax(LOG_FLOOR, 1 + ret)) - Math.log(npMax(LOG_FLOOR, 1 + r5)),
    oth_buyers_5m: num(i.flow.oth_buyers_5m),
    oth_sellers_5m: num(i.flow.oth_sellers_5m),
    oth_net_sol_5m: num(i.flow.oth_net_sol_5m),
    pts_5m: num(i.flow.pts_5m),
    leader_sold_frac: Number.isFinite(lsf) ? clip(lsf, 0, 1) : 0,
    minutes_since_leader_sold: num(i.minutes_since_leader_sold),
    entry_venue_pumpswap: (stripVenue(i.venue).venue ?? "").startsWith("pumpswap") ? 1 : 0,
    entry_tracked_active_wallets_1h: num(i.active_wallets_1h),
    leader_ps_r_7d: num(i.leader_ps_r_7d),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Vectors

/** The entry network's input: raw values → normalised columns with the manifest's categories and norm. */
export function entryVector(raw: RawValues, categories: Record<string, readonly string[]>, norm: ColumnNorm): number[] {
  return normalise(encode(raw, ENTRY_FEATURES, categories), norm);
}

/** The exit network's input (exit features have no categoricals). */
export function exitVector(raw: RawValues, norm: ColumnNorm): number[] {
  return normalise(encode(raw, EXIT_FEATURES), norm);
}

/** Raw values for the transitions log: NaN (missing) as null, so JSON keeps it. */
export function rawForLog(raw: RawValues): Record<string, number | string | null> {
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, typeof v === "number" && !Number.isFinite(v) ? null : v]));
}

// ---------------------------------------------------------------------------------------------------------------------
// The server's sources

const isoMs = (v: unknown): number | null => {
  const x = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(x) ? x : null;
};
const iso = (ms: number) => new Date(ms).toISOString();
/** The leader scan's SQL bounds are widened by this much, then the exact window is applied on parsed times (a stored ts
 *  without milliseconds sorts differently from one with them). */
const SCAN_SLACK_MS = 1_000;

export interface LiveSourceDeps {
  db: DB;
  state: StreamState;
  ledger: MirrorLedger;
  /** The live social model's version (runtime.ts reads <BRAIN_DIR>/social/current). */
  socialModelVersion(): string | null;
}

/**
 * The server's sources: StreamState for the ring, first sightings, holdings and hourly counts; MirrorLedger for the
 * ledgers; one indexed read each of wallet_swaps (idx_swaps_wallet_ts), brain_token_first_seen (by creator), token_info
 * and social_scores. A table that isn't there (social_scores before the social layer ran) reads as no row.
 */
export function liveSources(d: LiveSourceDeps): EntrySources {
  const { db, state, ledger } = d;
  const stmts = new Map<string, ReturnType<DB["prepare"]>>();
  /** A prepared read, made once; undefined while its table doesn't exist (tried again next time). */
  const get = <T>(sql: string, key: string): T | undefined => {
    let s = stmts.get(sql);
    if (!s) {
      try {
        s = db.prepare(sql);
      } catch {
        return undefined;
      }
      stmts.set(sql, s);
    }
    return s.get(key) as T | undefined;
  };
  // The insert-time rule (features.yaml point_in_time): a row stored at or after t (a backfill, the stream's next flush)
  // was not known when the decision was taken.
  const scan = db.prepare("SELECT mint, side, sol_amount, ts FROM wallet_swaps WHERE wallet = ? AND ts >= ? AND ts < ? AND (ins_ms IS NULL OR ins_ms < ?)");
  return {
    cp: (leader, t) => ledger.cp(leader, t),
    psR: (leader, t) => ledger.psR(leader, t),
    ddRate: (leader, t) => ledger.ddRate(leader, t),
    leaderSwaps: (leader, from, to, knownBefore) =>
      (scan.all(leader, iso(from - SCAN_SLACK_MS), iso(to + SCAN_SLACK_MS), knownBefore) as { mint: string; side: string; sol_amount: number; ts: string }[]).map((r) => ({
        mint: r.mint, side: r.side, sol: r.sol_amount, ts: isoMs(r.ts) ?? NaN,
      })),
    ring: (mint, end, windowMs, knownBefore) => state.recent(mint, end, windowMs, knownBefore),
    maxOkBefore: (mint, cut, t) => state.maxOkBefore(mint, cut, t),
    firstSeen: (mint) => state.firstSeen(mint),
    creatorCoins7d: (creator, t, exceptMint) => state.creatorCoins7d(creator, t, exceptMint),
    leaderHolding: (leader, mint) => state.leaderHolding(leader, mint),
    activeWallets1h: (t) => state.activeWallets1h(t),
    tokenInfo: (mint) => {
      const r = get<{ pool_created_at: string | null; launch_checked_at: string | null }>("SELECT pool_created_at, launch_checked_at FROM token_info WHERE mint = ?", mint);
      return r ? { poolCreatedAt: isoMs(r.pool_created_at), launchCheckedAt: isoMs(r.launch_checked_at) } : null;
    },
    social: (leader) => {
      const r = get<{ score: number | null; model_version: string | null; updated_at: string | null }>("SELECT score, model_version, updated_at FROM social_scores WHERE wallet = ?", leader);
      return r ? { score: r.score, modelVersion: r.model_version, updatedAt: isoMs(r.updated_at) } : null;
    },
    socialModelVersion: () => d.socialModelVersion(),
  };
}
