/**
 * ORGANIC TOKENS — does this token have real, independent demand, or a handful of wallets (or one) trading with themselves?
 *
 * The smart-money feed used to take any trade by a smart wallet in any non-major token, so tokens with no real market
 * (a drained Meteora DBC pool, one wallet churning against another) ranked by net dollars like any other. This keeps a small
 * tally of EVERY swap the live stream sees — by every wallet, not only smart ones — and judges each token from it:
 *
 *   organic   enough different wallets, spread out, mostly net buying, not recycling the same money
 *   thin      too few makers, or one or two wallets carry the volume, or only smart wallets bought (copy-bots following each
 *             other aren't independent demand)
 *   wash      a large share of the volume is the same wallets buying and selling back within minutes
 *   unknown   too early to say (a brand-new token must not be judged on its first seconds)
 *
 * Flows are always recorded; the verdict is applied when a signal would be created and when the feed is shown. Thresholds
 * are first guesses taken from the research (research_notes/Organic token detection/), to be tuned on our own data: change
 * them in .env (ORGANIC_*). Pure functions below; the stream feeds `MintTally.record`, `assess` judges, `saveAssessment`
 * keeps the latest verdict in token_organic (created here, like the audit tables).
 *
 * Two limits to keep in mind: the stream only sees swaps on the programs it subscribes to (Meteora DBC isn't one of them, so
 * a DBC token can look thinner than it is), and a restart empties the tally, so a verdict is only replaced by a conclusive one.
 */
import { type DB, envBool, envNum } from "@godseye/shared";
import type { ParsedSwap } from "../chain/parse";

export const organicSettings = {
  enabled: envBool("ORGANIC_ENABLED", true),
  /** At least this many different wallets have traded the token (a bigger crowd than a few smart wallets and a friend). */
  minMakers: envNum("ORGANIC_MIN_MAKERS", 15),
  minBuyers: envNum("ORGANIC_MIN_BUYERS", 8),
  /** Effective number of traders (1 / Herfindahl of volume): 20 equal wallets = 20; one wallet with 70% of the volume = about 2. */
  minEffectiveMakers: envNum("ORGANIC_MIN_EFFECTIVE_MAKERS", 6),
  maxTop1Share: envNum("ORGANIC_MAX_TOP1_SHARE", 0.5),
  maxTop3Share: envNum("ORGANIC_MAX_TOP3_SHARE", 0.8),
  /** Share of the volume that is a wallet buying and selling the same tokens back within the window. */
  maxRoundTripShare: envNum("ORGANIC_MAX_ROUND_TRIP_SHARE", 0.3),
  /** Buyers that are not smart wallets. */
  minOutsideBuyers: envNum("ORGANIC_MIN_OUTSIDE_BUYERS", 5),
  /** Below this many swaps, and while the token is younger than judgeAfterMinutes, it is "unknown", not "thin". */
  minSwaps: envNum("ORGANIC_MIN_SWAPS", 20),
  judgeAfterMinutes: envNum("ORGANIC_JUDGE_AFTER_MINUTES", 10),
  /** A buy sold back within this long, to within the tolerance of the tokens bought, is a round trip. */
  roundTripWindowSec: envNum("ORGANIC_ROUND_TRIP_WINDOW_SEC", 180),
  roundTripTolerance: envNum("ORGANIC_ROUND_TRIP_TOLERANCE", 0.05),
  /** Wallets with this many round trips in one token are repeat cyclers. */
  cycleWallet: envNum("ORGANIC_CYCLE_WALLET", 3),
  /** Memory bounds of the tally. */
  maxMints: envNum("ORGANIC_MAX_MINTS", 30_000),
  maxMakersPerMint: envNum("ORGANIC_MAX_MAKERS_PER_MINT", 64),
  idleMinutes: envNum("ORGANIC_IDLE_MINUTES", 120),
};
export type OrganicSettings = typeof organicSettings;

interface Maker {
  buySol: number;
  sellSol: number;
  swaps: number;
  smart: boolean;
  cycles: number;
  lastBuy: { tokens: number; sol: number; t: number } | null;
}

interface Entry {
  first: number;
  last: number;
  swaps: number;
  buys: number;
  sells: number;
  volumeSol: number;
  roundTripSol: number;
  makers: Map<string, Maker>;
  /** Swaps by wallets beyond the per-token cap (counted in the volume, not as individuals). */
  overflowSwaps: number;
  capped: boolean;
}

export interface MintStats {
  swaps: number;
  makers: number;
  /** True when more wallets traded than the tally keeps individually: at least `makers`, and treated as a broad crowd. */
  capped: boolean;
  buyers: number;
  sellers: number;
  smartBuyers: number;
  outsideBuyers: number;
  volumeSol: number;
  buys: number;
  sells: number;
  top1Share: number;
  top3Share: number;
  effectiveMakers: number;
  roundTripShare: number;
  cycleWallets: number;
  ageMin: number;
  spanMin: number;
}

/** A rolling tally of every swap per token, bounded in memory. */
export class MintTally {
  private mints = new Map<string, Entry>();
  constructor(private s: OrganicSettings = organicSettings) {}

  get size(): number {
    return this.mints.size;
  }

  record(swap: ParsedSwap, smart: boolean, now = Date.now()): void {
    const t = Date.parse(swap.ts);
    const at = Number.isFinite(t) ? t : now;
    let e = this.mints.get(swap.mint);
    if (!e) {
      if (this.mints.size >= this.s.maxMints) this.evict(now, true);
      e = { first: now, last: now, swaps: 0, buys: 0, sells: 0, volumeSol: 0, roundTripSol: 0, makers: new Map(), overflowSwaps: 0, capped: false };
      this.mints.set(swap.mint, e);
    }
    e.last = now;
    e.swaps++;
    e.volumeSol += swap.solAmount;
    if (swap.side === "buy") e.buys++;
    else e.sells++;

    let m = e.makers.get(swap.wallet);
    if (!m) {
      if (e.makers.size >= this.s.maxMakersPerMint) {
        e.capped = true;
        e.overflowSwaps++;
        return;
      }
      m = { buySol: 0, sellSol: 0, swaps: 0, smart, cycles: 0, lastBuy: null };
      e.makers.set(swap.wallet, m);
    }
    m.swaps++;
    m.smart = m.smart || smart;
    if (swap.side === "buy") {
      m.buySol += swap.solAmount;
      m.lastBuy = { tokens: swap.tokenAmount, sol: swap.solAmount, t: at };
    } else {
      m.sellSol += swap.solAmount;
      const b = m.lastBuy;
      if (b && at - b.t <= this.s.roundTripWindowSec * 1000 && b.tokens > 0 && Math.abs(swap.tokenAmount - b.tokens) <= this.s.roundTripTolerance * b.tokens) {
        e.roundTripSol += 2 * Math.min(b.sol, swap.solAmount);
        m.cycles++;
        m.lastBuy = null;
      } else if (b && at - b.t > this.s.roundTripWindowSec * 1000) m.lastBuy = null;
    }
  }

  stats(mint: string, now = Date.now()): MintStats | null {
    const e = this.mints.get(mint);
    if (!e) return null;
    const ms = [...e.makers.values()];
    const total = e.volumeSol;
    const gross = ms.map((m) => m.buySol + m.sellSol).sort((a, b) => b - a);
    const sumSq = gross.reduce((s, g) => s + g * g, 0);
    const buyers = ms.filter((m) => m.buySol > 0);
    const smartBuyers = buyers.filter((m) => m.smart).length;
    return {
      swaps: e.swaps,
      makers: e.makers.size,
      capped: e.capped,
      buyers: buyers.length,
      sellers: ms.filter((m) => m.sellSol > 0).length,
      smartBuyers,
      outsideBuyers: buyers.length - smartBuyers,
      volumeSol: total,
      buys: e.buys,
      sells: e.sells,
      top1Share: total > 0 ? (gross[0] ?? 0) / total : 0,
      top3Share: total > 0 ? gross.slice(0, 3).reduce((s, g) => s + g, 0) / total : 0,
      effectiveMakers: sumSq > 0 ? (total * total) / sumSq : 0,
      roundTripShare: total > 0 ? Math.min(1, e.roundTripSol / total) : 0,
      cycleWallets: ms.filter((m) => m.cycles >= this.s.cycleWallet).length,
      ageMin: (now - e.first) / 60_000,
      spanMin: (e.last - e.first) / 60_000,
    };
  }

  /** Mints that have been seen. */
  mintsSeen(): string[] {
    return [...this.mints.keys()];
  }

  /** Forget tokens quiet for a while; when `force`, also the quietest until there is room. */
  evict(now = Date.now(), force = false): number {
    let n = 0;
    for (const [m, e] of this.mints) {
      if (now - e.last > this.s.idleMinutes * 60_000) {
        this.mints.delete(m);
        n++;
      }
    }
    if (force && this.mints.size >= this.s.maxMints) {
      const quiet = [...this.mints.entries()].sort((a, b) => a[1].last - b[1].last).slice(0, Math.ceil(this.s.maxMints * 0.1));
      for (const [m] of quiet) {
        this.mints.delete(m);
        n++;
      }
    }
    return n;
  }
}

export type Verdict = "organic" | "thin" | "wash" | "unknown";

export interface Assessment {
  verdict: Verdict;
  /** 0-100, saturating in the effective number of traders and discounted by recycled volume; only meaningful for "organic". */
  score: number;
  reasons: string[];
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

/** Pure: judge a token from its tally. */
export function assess(st: MintStats, s: OrganicSettings = organicSettings): Assessment {
  const young = st.ageMin < s.judgeAfterMinutes;
  const reasons: string[] = [];

  // Wash first: recycled volume is conclusive once there is enough of it to measure.
  if (st.swaps >= 30) {
    if (st.roundTripShare >= s.maxRoundTripShare) reasons.push(`${pct(st.roundTripShare)} of the volume is wallets buying and selling the same tokens back within ${Math.round(s.roundTripWindowSec / 60)} min`);
    if (st.cycleWallets >= 2 && st.top3Share >= 0.5) reasons.push(`${st.cycleWallets} wallets repeat buy-then-sell cycles and the top 3 wallets make ${pct(st.top3Share)} of the volume`);
  }
  if (reasons.length) return { verdict: "wash", score: 0, reasons };

  // Concentration is conclusive early too: one wallet doing most of it won't change as the crowd arrives.
  const concentration: string[] = [];
  if (st.swaps >= s.minSwaps && st.top1Share > s.maxTop1Share) concentration.push(`one wallet makes ${pct(st.top1Share)} of the volume`);
  if (st.swaps >= s.minSwaps && st.top3Share > s.maxTop3Share) concentration.push(`3 wallets make ${pct(st.top3Share)} of the volume`);
  if (concentration.length) return { verdict: "thin", score: 0, reasons: concentration };

  // Not enough traders yet: unknown while the token is young, thin once it has had its chance.
  const few: string[] = [];
  if (!st.capped && st.makers < s.minMakers) few.push(`only ${st.makers} different wallets have traded it (${s.minMakers} needed)`);
  if (!st.capped && st.buyers < s.minBuyers) few.push(`only ${st.buyers} have bought (${s.minBuyers} needed)`);
  if (!st.capped && st.effectiveMakers < s.minEffectiveMakers) few.push(`volume is spread over the equivalent of ${st.effectiveMakers.toFixed(1)} wallets (${s.minEffectiveMakers} needed)`);
  if (!st.capped && st.smartBuyers > 0 && st.outsideBuyers < s.minOutsideBuyers) few.push(`only ${st.outsideBuyers} buyers besides smart wallets (${s.minOutsideBuyers} needed)`);
  if (few.length) return { verdict: young ? "unknown" : "thin", score: 0, reasons: young ? [`too early to judge (${st.swaps} swaps in ${st.ageMin.toFixed(0)} min): ${few[0]}`] : few };
  if (st.swaps < s.minSwaps && young) return { verdict: "unknown", score: 0, reasons: [`too early to judge: ${st.swaps} swaps so far`] };

  const sat = 1 - Math.exp(-st.effectiveMakers / 12);
  const score = Math.round(100 * sat * (1 - st.roundTripShare) * Math.min(1, (st.outsideBuyers + 1) / 10));
  return {
    verdict: "organic",
    score,
    reasons: [`${st.capped ? `${st.makers}+` : st.makers} wallets, ${st.buyers} buyers (${st.outsideBuyers} not smart), volume spread over the equivalent of ${st.effectiveMakers.toFixed(1)} wallets, ${pct(st.roundTripShare)} recycled`],
  };
}

/**
 * How many independent voices are among these wallets: wallets known to share a funder count once (they are usually one
 * operator or one follower of another). Wallets with no known funder count individually, so this is an upper bound.
 */
export function independentVoters(wallets: string[], funderOf: (wallet: string) => string | null): number {
  const groups = new Set<string>();
  for (const w of wallets) groups.add(funderOf(w) ? `funder:${funderOf(w)}` : `wallet:${w}`);
  return groups.size;
}

// ---- keeping the latest verdict ----

const TABLE = `
CREATE TABLE IF NOT EXISTS token_organic (
  mint TEXT PRIMARY KEY,
  -- the verdict used everywhere: the stream tally's, overridden to 'thin' when the market check found no real pool
  verdict TEXT NOT NULL CHECK (verdict IN ('organic','thin','wash','unknown')),
  tally_verdict TEXT NOT NULL,
  score REAL,
  -- stream: judged from the live stream's tally of all swaps · tape: judged from tracked wallets' stored swaps (an undercount, so it can only say thin or unknown)
  source TEXT NOT NULL,
  reasons TEXT NOT NULL,
  stats TEXT,
  -- the market check (Jupiter): is there a pool with liquidity? ok / thin / null = not checked yet
  market TEXT,
  market_reason TEXT,
  liquidity_usd REAL,
  holders INTEGER,
  jup_organic_score REAL,
  jup_label TEXT,
  jup_suspicious INTEGER,
  enriched_at TEXT,
  assessed_at TEXT NOT NULL,
  first_assessed_at TEXT NOT NULL
);
`;
const ensured = new WeakSet<DB>();
export function ensureOrganicTable(db: DB): void {
  if (ensured.has(db)) return;
  db.exec(TABLE);
  ensured.add(db);
}

export interface StoredVerdict {
  mint: string;
  verdict: Verdict;
  tally_verdict: Verdict;
  score: number | null;
  source: string;
  reasons: string;
  stats: string | null;
  market: string | null;
  market_reason: string | null;
  liquidity_usd: number | null;
  holders: number | null;
  jup_organic_score: number | null;
  jup_label: string | null;
  jup_suspicious: number | null;
  enriched_at: string | null;
  assessed_at: string;
  first_assessed_at: string;
}

export const getVerdict = (db: DB, mint: string): StoredVerdict | null => {
  try {
    return (db.prepare("SELECT * FROM token_organic WHERE mint = ?").get(mint) as StoredVerdict | undefined) ?? null;
  } catch {
    return null;
  }
};

/**
 * Keeps an assessment. A token the market check found to have no real pool stays thin whatever the tally says, and an
 * "unknown" never replaces a conclusive verdict (a restart empties the tally, which would otherwise erase what was learned).
 */
export function saveAssessment(db: DB, mint: string, a: Assessment, st: MintStats | null, source: "stream" | "tape", now = Date.now()): void {
  ensureOrganicTable(db);
  const prev = getVerdict(db, mint);
  const ts = new Date(now).toISOString();
  if (prev && a.verdict === "unknown" && prev.tally_verdict !== "unknown") return;
  // The tape can only vouch for "thin" or "unknown", and never overwrites a verdict from the stream.
  if (prev && source === "tape" && prev.source === "stream") return;
  const marketThin = prev?.market === "thin";
  const verdict: Verdict = marketThin ? "thin" : a.verdict;
  const reasons = marketThin && a.verdict !== "thin" ? [prev!.market_reason ?? "no real pool", ...a.reasons] : a.reasons;
  db.prepare(
    `INSERT INTO token_organic (mint, verdict, tally_verdict, score, source, reasons, stats, assessed_at, first_assessed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(mint) DO UPDATE SET verdict = excluded.verdict, tally_verdict = excluded.tally_verdict, score = excluded.score, source = excluded.source,
       reasons = excluded.reasons, stats = excluded.stats, assessed_at = excluded.assessed_at`,
  ).run(mint, verdict, a.verdict, a.score, source, JSON.stringify(reasons), st ? JSON.stringify(st) : null, ts, prev?.first_assessed_at ?? ts);
}

/** Verdicts for tokens smart wallets traded in the last day that have none yet, from the tracked wallets' stored swaps. */
export function backfillFromTape(db: DB, s: OrganicSettings = organicSettings, now = Date.now()): number {
  ensureOrganicTable(db);
  const since = new Date(now - 86_400_000).toISOString();
  const todo = (db.prepare("SELECT DISTINCT mint FROM smart_flows WHERE ts >= ? AND mint NOT IN (SELECT mint FROM token_organic)").all(since) as { mint: string }[]).map((r) => r.mint);
  if (!todo.length) return 0;
  const rows = db.prepare("SELECT wallet, signature, ts, side, token_amount, sol_amount FROM wallet_swaps WHERE mint = ? ORDER BY ts, id LIMIT 5000");
  let n = 0;
  for (const mint of todo) {
    const list = rows.all(mint) as { wallet: string; ts: string; side: "buy" | "sell"; token_amount: number; sol_amount: number }[];
    const tally = new MintTally({ ...s, judgeAfterMinutes: 0 });
    for (const r of list) tally.record({ wallet: r.wallet, ts: r.ts, side: r.side, tokenAmount: r.token_amount, solAmount: r.sol_amount, mint } as ParsedSwap, false, Date.parse(r.ts));
    const st = list.length ? tally.stats(mint, Date.parse(list[list.length - 1].ts) + 1) : null;
    if (!st) {
      saveAssessment(db, mint, { verdict: "unknown", score: 0, reasons: ["no stored swaps to judge from"] }, null, "tape", now);
      n++;
      continue;
    }
    // Tracked wallets are a small slice of everyone who traded, so counts of makers undercount: only concentration and recycling are trusted.
    const a = assess({ ...st, ageMin: 1e9 }, s);
    const trusted = a.verdict === "wash" || (a.verdict === "thin" && a.reasons.some((r) => /one wallet|3 wallets/.test(r)));
    saveAssessment(db, mint, trusted ? a : { verdict: "unknown", score: 0, reasons: ["not yet seen on the live stream"] }, st, "tape", now);
    n++;
  }
  return n;
}
