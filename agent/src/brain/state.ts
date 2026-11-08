/**
 * THE BRAIN'S VIEW OF THE STREAM — what the entry and exit features read about coins and leaders right now
 * (brain/spec/features.yaml, "new_server_state_required"), fed by every streamed swap. In memory, bounded and pruned; each
 * coin's first sighting is persisted (brain_token_first_seen) so it survives a restart.
 *
 *   per coin    the last 60 min of tracked swaps (wallet, side, SOL, price, block time, insert time = when the stream
 *               delivered it), each marked ok or not by the TRAILING outlier filter; the last ok price; the highest ok price
 *               from before the last hour; the first sighting, first ok price and creator
 *   per leader  its latest buy of each coin and what it has sold of it since (leader_sold_at_decision)
 *   per hour    the distinct tracked wallets that traded (tracked_active_wallets_1h), persisted per whole hour seen
 *
 * A tracked swap is one by a wallet whose swaps the stream stores in wallet_swaps (stream.ts NOT_A_BOT); a leader is any
 * analyzed wallet (bots included), whose buys are signals. Windows are on BLOCK time with the INSERT-TIME rule
 * (features.yaml conventions.point_in_time): a window [T − W, T) holds the swaps with ts in it that the server had before
 * the decision time t (insert time `at` < t). Entry features end their windows at the leader's block second T, so the
 * incoming swap and anything else in its block second never count; exit features end them at t.
 *
 * "ok price" (features.yaml conventions.tracked_swap, derive.build_prices `ok`): valid (price > 0, SOL >= 0.001, tokens >= 1),
 * within 10× of the median of the coin's PREVIOUS 10 valid prices, and not backed by its own wallet alone (TrailingFilter).
 * Trailing, never centered: it can't look ahead live.
 *
 * Wiring (brain/runtime.ts): state.onSwap(swap) for every streamed swap, before anything reads the state; state.tick()
 * once a minute. The ledgers (ledger.ts) subscribe to it. Server logs only: nothing here reaches say() or the public feed.
 */
import { type DB, isNonMemecoin } from "@godseye/shared";
import { config } from "../config";
import type { ParsedSwap } from "../chain/parse";
import { fetchJson } from "../http";
import { ensureBrainTables } from "./schema";

export const OK_MIN_SOL = 0.001;
/** derive.MIN_PRICE_TOKENS: micro-token prints (1e-6 .. 1e-2 tokens for a normal SOL amount) are unit errors, no price. */
export const OK_MIN_TOKENS = 1;
export const OK_TAIL = 10;
export const OK_MAX_RATIO = 10;
/** How far back the per-coin ring reaches (features read at most 5 min; exits read the ring too). */
export const RING_MS = 60 * 60_000;
/** The crowd features' window. */
export const FLOW_MS = 5 * 60_000;
/**
 * A coin loaded into memory is seeded from up to this many of its stored swaps (within 7 days): its last hour for the ring,
 * the rest for its high. The filter itself only needs the last OK_TAIL valid prices to agree with the full-sequence one.
 */
export const OK_WARM_ROWS = 1_000;
/** How far a swap's block time may run ahead of the server clock that stamps its insert time (the ring walks back by `at`). */
const TS_SKEW_MS = 60_000;
/** SQL: a wallet_swaps row that can carry a price (isValidPrice). */
export const VALID_PRICE_SQL = `price_sol > 0 AND sol_amount >= ${OK_MIN_SOL} AND token_amount >= ${OK_MIN_TOKENS}`;
/** A first ok price only counts from a swap this big (ret_since_first). */
export const FIRST_PRICE_MIN_SOL = 0.01;
export const WINDOW_7D_MS = 7 * 86_400_000;
/** Bounds: coins and leader buys held in memory, swaps per coin's ring. */
export const MAX_MINTS = 50_000;
export const MAX_RING = 5_000;
export const MAX_LEADER_BUYS = 100_000;
/** A coin idle this long leaves memory (its first sighting stays in the table). */
const MINT_IDLE_MS = 24 * 3_600_000;
/** A leader's buy is forgotten this long after its last swap of the coin (decisions are taken within 60 s of the buy). */
const LEADER_IDLE_MS = 2 * 3_600_000;
const SEEN_MAX = 50_000;
const TRACKED_TTL_MS = 10 * 60_000;
const CREATOR_QUEUE_MAX = 5_000;
/** A creator lookup that failed (rate limit, timeout) is tried again this many times, after 2, then 8 minutes. */
const CREATOR_TRIES = 3;
const CREATOR_RETRY_MS = 2 * 60_000;
const FIRST_SEEN_KEEP_MS = 8 * 86_400_000;
/** stream.ts NOT_A_BOT: wallets already found to be bots aren't stored swap by swap (copied ones always are). */
const NOT_A_BOT = "(junk_reason IS NULL OR junk_reason NOT LIKE 'bot:%' OR copy_weight > 0)";

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const iso = (ms: number) => new Date(ms).toISOString();
const ms = (s: string | null | undefined) => (s ? Date.parse(s) : NaN);

/** A swap that can carry a price at all ("valid"): price > 0, at least OK_MIN_SOL and at least OK_MIN_TOKENS tokens. */
export const isValidPrice = (price: number, sol = Infinity, tokens = Infinity): boolean =>
  price > 0 && Number.isFinite(price) && sol >= OK_MIN_SOL && tokens >= OK_MIN_TOKENS;

/**
 * The trailing outlier filter of one coin (derive.build_prices `ok`): remembers its last OK_TAIL VALID prices and their
 * wallets, passed or not, so it heals after a real lasting > 10× move (a rug): a filter fed only the prices it accepted
 * would reject everything after one forever. A price is ok when it is valid, within 10× of the median of that window (the
 * coin's first valid price always is), and not "lone": among the window's prints by OTHER wallets, at least one and none
 * within 10× of it, so only its own wallet backs its level (one wallet's run of unit-error prints can't heal on its own).
 * An unknown wallet ('') counts every print in the window as another wallet's.
 */
export class TrailingFilter {
  private tail: { price: number; wallet: string }[] = [];

  /** Is this price ok? Every valid price joins the window afterwards, ok or not. */
  accept(price: number, sol = Infinity, tokens = Infinity, wallet = ""): boolean {
    if (!isValidPrice(price, sol, tokens)) return false;
    const ok = this.judge(price, wallet);
    this.tail.push({ price, wallet });
    if (this.tail.length > OK_TAIL) this.tail.shift();
    return ok;
  }

  private judge(price: number, wallet: string): boolean {
    if (!this.tail.length) return true;
    const rm = price / median(this.tail.map((x) => x.price));
    if (!(rm >= 1 / OK_MAX_RATIO && rm <= OK_MAX_RATIO)) return false;
    const others = this.tail.filter((x) => x.wallet !== wallet);
    return !others.length || others.some((x) => x.price >= price / OK_MAX_RATIO && x.price <= price * OK_MAX_RATIO);
  }

  /** Valid prices in the window. */
  get size(): number {
    return this.tail.length;
  }
}

/** Mark rows in order with the trailing filter (rows of one coin, oldest first; no tokens or wallet = not checked / unknown). */
export function markOk<T extends { price: number; sol: number; tokens?: number; wallet?: string }>(rows: T[], filter = new TrailingFilter()): (T & { ok: boolean })[] {
  return rows.map((r) => ({ ...r, ok: filter.accept(r.price, r.sol, r.tokens ?? Infinity, r.wallet ?? "") }));
}

/** One swap as the Brain keeps it. Times are ms; `at` = insert time (when the server got it). */
export interface StreamSwap {
  wallet: string;
  mint: string;
  side: "buy" | "sell";
  sol: number;
  price: number;
  tokens: number;
  ts: number;
  at: number;
  signature: string;
  ok: boolean;
  /** By a wallet whose swaps are stored (a price for the tape); false = only an analyzed wallet's (e.g. a bot leader's). */
  tracked: boolean;
  /** By an analyzed wallet (a signal when it buys). */
  analyzed: boolean;
  venue: string | null;
  tokenBalanceBefore: number;
}

export interface FirstSeen {
  mint: string;
  firstSeenAt: number;
  /** stream = the stream's first tracked swap; db = the coin was already in wallet_swaps when the stream first met it. */
  source: "stream" | "db";
  firstOkPrice: number | null;
  firstOkAt: number | null;
  /** null = not looked up yet; '' = looked up, none found. */
  creator: string | null;
  creatorResolvedAt: number | null;
}

/** The tracked crowd of one coin in a window, the leader left out. */
export interface Flow {
  /** Distinct wallets with an ok buy (m_buyers_5m) and with any buy (oth_buyers_5m). */
  okBuyers: number;
  buyers: number;
  /** SOL of ok buys (m_buysol_5m). */
  okBuySol: number;
  sellers: number;
  /** SOL bought minus SOL sold, every swap (oth_net_sol_5m). */
  netSol: number;
  /** Ok-priced swaps, everyone's (pts_5m counts the leader's too). */
  okSwaps: number;
}

export interface LeaderHolding {
  leader: string;
  mint: string;
  buyTs: number;
  signature: string;
  /** token_balance_before + token_amount of the buy (null when the stream didn't give the balance). */
  postBuyTokens: number | null;
  soldTokens: number;
  firstSellTs: number | null;
  /** soldTokens / postBuyTokens, capped at 1 (0 when unknown). */
  soldFrac: number;
}

interface MintState {
  ring: StreamSwap[];
  filter: TrailingFilter;
  lastOk: StreamSwap | null;
  /** Highest ok price among swaps already out of the ring (and its block time). */
  histMax: { price: number; ts: number } | null;
  histMaxDirty: boolean;
  first: FirstSeen;
}

/** A coin waiting for its creator lookup. */
interface CreatorJob {
  mint: string;
  tries: number;
  notBefore: number;
}

interface LeaderBuyState {
  buyTs: number;
  signature: string;
  postBuyTokens: number | null;
  soldTokens: number;
  firstSellTs: number | null;
  touched: number;
}

export interface StreamStateDeps {
  now(): number;
  /** A wallet whose swaps the stream stores (stream.ts `tracked`). */
  isTracked(wallet: string): boolean;
  /** Any wallet in the wallets table (its buys are signals). */
  isAnalyzed(wallet: string): boolean;
  /** The creator if already cached elsewhere (token_info), without a network call. */
  cachedCreator(mint: string): string | null;
  /** Look the creator up (network, capped by BRAIN_CREATOR_LOOKUPS_PER_MIN); '' or null = none found. */
  lookupCreator(mint: string): Promise<string | null>;
}

/** How much memory holds (defaults MAX_MINTS, MAX_RING, MAX_LEADER_BUYS). */
export interface StateBounds {
  mints: number;
  ring: number;
  leaderBuys: number;
}

export class StreamState {
  private deps: StreamStateDeps;
  private bounds: StateBounds;
  private mints = new Map<string, MintState>();
  private leaders = new Map<string, LeaderBuyState>();
  private seen = new Map<string, true>();
  private listeners: ((s: StreamSwap) => void)[] = [];
  private hour = { h: -1, wallets: new Set<string>(), whole: false };
  private hourCounts = new Map<number, number>();
  /** Coins waiting for a creator lookup, in order; those a leader just bought (copy-eligible) wait in `creatorHot`, first. */
  private creatorQueue = new Map<string, CreatorJob>();
  private creatorHot = new Map<string, CreatorJob>();
  private creatorAsking = new Set<string>();
  private creatorCalls: number[] = [];
  /** Coins dropped from a full creator queue (never looked up: cr_seen_prior_7d undercounts), since start. */
  private creatorDropped = 0;
  private creatorWarned = 0;
  private walletSets: { tracked: Set<string>; analyzed: Set<string>; at: number } | null = null;
  private warned = 0;
  private lastPrune = 0;

  constructor(private db: DB, deps: Partial<StreamStateDeps> = {}, bounds: Partial<StateBounds> = {}) {
    ensureBrainTables(db);
    this.bounds = { mints: MAX_MINTS, ring: MAX_RING, leaderBuys: MAX_LEADER_BUYS, ...bounds };
    this.deps = {
      now: Date.now,
      isTracked: (w) => this.wallets().tracked.has(w),
      isAnalyzed: (w) => this.wallets().analyzed.has(w),
      cachedCreator: (mint) => (db.prepare("SELECT creator FROM token_info WHERE mint = ?").get(mint) as { creator: string | null } | undefined)?.creator || null,
      lookupCreator: (mint) =>
        fetchJson<{ creator?: string }>(`https://api.rugcheck.xyz/v1/tokens/${mint}/report`, { retries: 0, timeoutMs: 8_000 }).then((r) => r.creator || ""),
      ...deps,
    };
  }

  private wallets(): { tracked: Set<string>; analyzed: Set<string> } {
    const now = this.deps.now();
    if (!this.walletSets || now - this.walletSets.at > TRACKED_TTL_MS) {
      const rows = this.db.prepare(`SELECT address, ${NOT_A_BOT} AS stored FROM wallets`).all() as { address: string; stored: number }[];
      this.walletSets = { tracked: new Set(rows.filter((r) => r.stored).map((r) => r.address)), analyzed: new Set(rows.map((r) => r.address)), at: now };
    }
    return this.walletSets;
  }

  /** Called with every swap the state keeps (tracked or by an analyzed wallet), after it is recorded. */
  subscribe(fn: (s: StreamSwap) => void): void {
    this.listeners.push(fn);
  }

  /**
   * One streamed swap (any wallet): kept when it is a tracked wallet's or an analyzed wallet's. Returns what was kept, or
   * null. Never throws (the stream loop mustn't stall).
   */
  onSwap(swap: ParsedSwap, now = this.deps.now()): StreamSwap | null {
    try {
      return this.record(swap, now);
    } catch (e) {
      if (now > this.warned) {
        this.warned = now + 10 * 60_000;
        console.warn(`[brain] stream state: ${(e as Error).message.slice(0, 160)}`);
      }
      return null;
    }
  }

  private record(swap: ParsedSwap, now: number): StreamSwap | null {
    if (isNonMemecoin(swap.mint, null)) return null;
    const tracked = this.deps.isTracked(swap.wallet);
    const analyzed = this.deps.isAnalyzed(swap.wallet);
    if (!tracked && !analyzed) return null;
    const key = `${swap.signature}:${swap.wallet}:${swap.mint}:${swap.side}`;
    if (this.seen.has(key)) return null;
    this.seen.set(key, true);
    if (this.seen.size > SEEN_MAX) this.seen.delete(this.seen.keys().next().value!);
    const ts = Date.parse(swap.ts) || now;
    const s: StreamSwap = {
      wallet: swap.wallet, mint: swap.mint, side: swap.side, sol: swap.solAmount, price: swap.priceSol, tokens: swap.tokenAmount,
      ts, at: now, signature: swap.signature, ok: false, tracked, analyzed, venue: swap.venue ?? null, tokenBalanceBefore: swap.tokenBalanceBefore,
    };
    if (tracked) {
      const st = this.mint(swap.mint, now, swap.signature);
      s.ok = st.filter.accept(s.price, s.sol, s.tokens, s.wallet);
      st.ring.push(s);
      if (st.ring.length > this.bounds.ring) this.dropOldest(st);
      if (s.ok) {
        st.lastOk = s;
        if (st.first.firstOkPrice === null && s.sol >= FIRST_PRICE_MIN_SOL) {
          st.first.firstOkPrice = s.price;
          st.first.firstOkAt = now;
          this.db.prepare("UPDATE brain_token_first_seen SET first_ok_price = ?, first_ok_price_at = ? WHERE mint = ? AND first_ok_price IS NULL").run(s.price, iso(now), s.mint);
        }
      }
      this.countWallet(s.wallet, now);
    }
    if (analyzed) {
      this.leaderSwap(s);
      // A copy-eligible buy of a coin still without a creator: its lookup goes first (cr_seen_prior_7d is read at this decision).
      const st = s.side === "buy" && s.sol >= config.minLeaderBuySol ? this.mints.get(s.mint) : undefined;
      if (st && st.first.creator === null) this.queueCreator(s.mint, now, true);
    }
    for (const fn of this.listeners) fn(s);
    return s;
  }

  /** The coin's state, loaded on first use in this process: its first sighting (persisted) and its last hour from wallet_swaps. */
  private mint(mint: string, now: number, exceptSig: string): MintState {
    let st = this.mints.get(mint);
    if (st) {
      this.mints.delete(mint); // most recently used last: the bound evicts the idlest
      this.mints.set(mint, st);
      return st;
    }
    st = { ring: [], filter: new TrailingFilter(), lastOk: null, histMax: null, histMaxDirty: false, first: this.firstSighting(mint, now, exceptSig) };
    // Stored swaps of the last 7 days (the stream's, before a restart, and backfills) seed the filter, the ring and the high.
    const rows = (
      this.db
        .prepare(
          `SELECT wallet, side, sol_amount sol, price_sol price, token_amount tokens, ts, signature, slot, id FROM wallet_swaps
           WHERE mint = ? AND ts >= ? AND ts <= ? ORDER BY ts DESC, slot DESC, id DESC LIMIT ${OK_WARM_ROWS}`,
        )
        .all(mint, iso(now - WINDOW_7D_MS), iso(now)) as {
        wallet: string; side: "buy" | "sell"; sol: number; price: number; tokens: number; ts: string; signature: string; slot: number; id: number;
      }[]
    ).reverse();
    // More stored than that: the filter first remembers the OK_TAIL valid prices just before the oldest one loaded (as
    // ledger.okSwaps warms its own), so the loaded rows get the verdicts the full-sequence filter gives them.
    if (rows.length >= OK_WARM_ROWS) {
      const o = rows[0];
      const before = this.db
        .prepare(
          `SELECT wallet, price_sol price, sol_amount sol, token_amount tokens FROM wallet_swaps
           WHERE mint = ? AND ts >= ? AND (ts < ? OR (ts = ? AND (slot < ? OR (slot = ? AND id < ?)))) AND ${VALID_PRICE_SQL}
           ORDER BY ts DESC, slot DESC, id DESC LIMIT ${OK_TAIL}`,
        )
        .all(mint, iso(now - WINDOW_7D_MS), o.ts, o.ts, o.slot, o.slot, o.id) as { wallet: string; price: number; sol: number; tokens: number }[];
      for (const b of before.reverse()) st.filter.accept(b.price, b.sol, b.tokens, b.wallet);
    }
    for (const { slot: _slot, id: _id, ...r } of rows) {
      if (r.signature === exceptSig) continue;
      const t = ms(r.ts);
      const ok = st.filter.accept(r.price, r.sol, r.tokens, r.wallet);
      // Stored before `now`: known from (at most) its block time on.
      const s: StreamSwap = { ...r, mint, ts: t, at: Math.min(t, now), ok, tracked: true, analyzed: false, venue: null, tokenBalanceBefore: 0 };
      if (ok) st.lastOk = s;
      if (t >= now - RING_MS) st.ring.push(s);
      else if (ok && (!st.histMax || r.price > st.histMax.price)) st.histMax = { price: r.price, ts: t };
    }
    const stored = this.db.prepare("SELECT max_ok_price p, max_ok_price_at a FROM brain_token_first_seen WHERE mint = ?").get(mint) as { p: number | null; a: string | null } | undefined;
    if (stored?.p && (!st.histMax || stored.p > st.histMax.price)) st.histMax = { price: stored.p, ts: ms(stored.a) || now };
    this.mints.set(mint, st);
    if (this.mints.size > this.bounds.mints) this.evict(this.mints.keys().next().value!);
    return st;
  }

  /** The coin's first sighting: from the table, else from wallet_swaps (already stored), else this swap. Written once. */
  private firstSighting(mint: string, now: number, exceptSig: string): FirstSeen {
    const row = this.db.prepare("SELECT * FROM brain_token_first_seen WHERE mint = ?").get(mint) as
      | { first_seen_at: string; source: "stream" | "db"; first_ok_price: number | null; first_ok_price_at: string | null; creator: string | null; creator_resolved_at: string | null }
      | undefined;
    if (row) {
      // Still without a creator (its lookups failed, or the process stopped before them): looked up again.
      if (row.creator === null) this.queueCreator(mint, now);
      return {
        mint, firstSeenAt: ms(row.first_seen_at), source: row.source, firstOkPrice: row.first_ok_price, firstOkAt: row.first_ok_price_at ? ms(row.first_ok_price_at) : null,
        creator: row.creator, creatorResolvedAt: row.creator_resolved_at ? ms(row.creator_resolved_at) : null,
      };
    }
    // Swaps stored before the stream met the coin (a wallet's history read earlier): the earliest within 7 days.
    const prior = (
      this.db
        .prepare("SELECT wallet, sol_amount sol, price_sol price, token_amount tokens, ts, signature FROM wallet_swaps WHERE mint = ? AND ts >= ? AND ts <= ? ORDER BY ts, slot, id LIMIT 50")
        .all(mint, iso(now - WINDOW_7D_MS), iso(now)) as { wallet: string; sol: number; price: number; tokens: number; ts: string; signature: string }[]
    ).filter((r) => r.signature !== exceptSig);
    const f = new TrailingFilter();
    const firstOk = prior.find((r) => f.accept(r.price, r.sol, r.tokens, r.wallet) && r.sol >= FIRST_PRICE_MIN_SOL);
    const first: FirstSeen = {
      mint, firstSeenAt: prior.length ? Math.min(ms(prior[0].ts), now) : now, source: prior.length ? "db" : "stream",
      firstOkPrice: firstOk?.price ?? null, firstOkAt: firstOk ? Math.min(ms(firstOk.ts), now) : null, creator: null, creatorResolvedAt: null,
    };
    const cached = this.deps.cachedCreator(mint);
    if (cached) {
      first.creator = cached;
      first.creatorResolvedAt = now;
    }
    this.db
      .prepare(
        `INSERT OR IGNORE INTO brain_token_first_seen (mint, first_seen_at, source, first_ok_price, first_ok_price_at, creator, creator_resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(mint, iso(first.firstSeenAt), first.source, first.firstOkPrice, first.firstOkAt === null ? null : iso(first.firstOkAt), first.creator, first.creatorResolvedAt === null ? null : iso(now));
    if (!cached) this.queueCreator(mint, now);
    return first;
  }

  /**
   * Queue the coin's creator lookup (once: a queued coin keeps its place). `hot` = a leader just made a copy-eligible buy
   * of it: it moves ahead of the rest. Over CREATOR_QUEUE_MAX the oldest waiting coin is dropped.
   */
  private queueCreator(mint: string, now: number, hot = false): void {
    if (this.creatorAsking.has(mint) || this.creatorHot.has(mint)) return;
    const job = this.creatorQueue.get(mint);
    if (job && !hot) return;
    this.creatorQueue.delete(mint);
    (hot ? this.creatorHot : this.creatorQueue).set(mint, job ?? { mint, tries: 0, notBefore: 0 });
    if (this.creatorQueue.size + this.creatorHot.size > CREATOR_QUEUE_MAX) {
      const q = this.creatorQueue.size ? this.creatorQueue : this.creatorHot;
      q.delete(q.keys().next().value!);
      this.creatorDropped++;
      if (now > this.creatorWarned) {
        this.creatorWarned = now + 10 * 60_000;
        console.log(`[brain] creator lookups can't keep up (${config.brainCreatorLookupsPerMin}/min): ${this.creatorDropped} coins dropped from the queue since start`);
      }
    }
    void this.lookupCreators(now);
  }

  /**
   * Creators of newly seen coins, at most BRAIN_CREATOR_LOOKUPS_PER_MIN lookups a minute (the rest wait in the queue), the
   * coins a leader bought first. A coin whose creator other code has stored in token_info meanwhile takes no lookup. A
   * lookup that fails (rate limit, timeout) goes back in line, up to CREATOR_TRIES times.
   */
  async lookupCreators(now = this.deps.now()): Promise<void> {
    this.creatorCalls = this.creatorCalls.filter((t) => t > now - 60_000);
    const jobs: Promise<void>[] = [];
    for (const q of [this.creatorHot, this.creatorQueue]) {
      for (const job of [...q.values()]) {
        if (this.creatorCalls.length >= config.brainCreatorLookupsPerMin) break;
        if (job.notBefore > now) continue;
        q.delete(job.mint);
        const cached = this.deps.cachedCreator(job.mint);
        if (cached) {
          this.setCreator(job.mint, cached, now);
          continue;
        }
        this.creatorAsking.add(job.mint);
        this.creatorCalls.push(now);
        jobs.push(
          this.deps.lookupCreator(job.mint).then(
            (creator) => {
              this.creatorAsking.delete(job.mint);
              this.setCreator(job.mint, creator ?? "", this.deps.now());
            },
            () => {
              // Not answered this time: tried again later (after the last try the coin stays without a creator: cr_seen_prior_7d missing).
              this.creatorAsking.delete(job.mint);
              if (++job.tries >= CREATOR_TRIES || q.has(job.mint) || this.creatorHot.has(job.mint)) return;
              job.notBefore = this.deps.now() + CREATOR_RETRY_MS * 4 ** (job.tries - 1);
              q.set(job.mint, job);
            },
          ),
        );
      }
    }
    await Promise.all(jobs);
  }

  private setCreator(mint: string, creator: string, at: number): void {
    this.db.prepare("UPDATE brain_token_first_seen SET creator = ?, creator_resolved_at = ? WHERE mint = ? AND creator IS NULL").run(creator, iso(at), mint);
    const st = this.mints.get(mint);
    if (st && st.first.creator === null) Object.assign(st.first, { creator, creatorResolvedAt: at });
  }

  private dropOldest(st: MintState): void {
    const s = st.ring.shift()!;
    if (s.ok && (!st.histMax || s.price > st.histMax.price)) {
      st.histMax = { price: s.price, ts: s.ts };
      st.histMaxDirty = true;
    }
  }

  private evict(mint: string): void {
    const st = this.mints.get(mint);
    if (!st) return;
    while (st.ring.length) this.dropOldest(st);
    this.saveHigh(mint, st);
    this.mints.delete(mint);
  }

  private saveHigh(mint: string, st: MintState): void {
    if (!st.histMaxDirty || !st.histMax) return;
    st.histMaxDirty = false;
    this.db
      .prepare("UPDATE brain_token_first_seen SET max_ok_price = ?, max_ok_price_at = ? WHERE mint = ? AND (max_ok_price IS NULL OR max_ok_price < ?)")
      .run(st.histMax.price, iso(st.histMax.ts), mint, st.histMax.price);
  }

  private countWallet(wallet: string, now: number): void {
    const h = Math.floor(now / 3_600_000);
    if (h !== this.hour.h) {
      // A finished hour counts only if this process saw all of it (persisted: a restart reads it back); otherwise it's missing.
      if (this.hour.h >= 0 && this.hour.whole) {
        this.hourCounts.set(this.hour.h, this.hour.wallets.size);
        this.db.prepare("INSERT OR REPLACE INTO brain_active_wallets_hourly (hour, wallets) VALUES (?, ?)").run(iso(this.hour.h * 3_600_000), this.hour.wallets.size);
      }
      this.hour = { h, wallets: new Set(), whole: this.hour.h === h - 1 };
      for (const k of this.hourCounts.keys()) if (k < h - 48) this.hourCounts.delete(k);
    }
    this.hour.wallets.add(wallet);
  }

  private leaderSwap(s: StreamSwap): void {
    const key = `${s.wallet}|${s.mint}`;
    if (s.side === "buy") {
      const post = s.tokenBalanceBefore >= 0 && s.tokens > 0 ? s.tokenBalanceBefore + s.tokens : null;
      this.leaders.delete(key);
      this.leaders.set(key, { buyTs: s.ts, signature: s.signature, postBuyTokens: post, soldTokens: 0, firstSellTs: null, touched: s.at });
      if (this.leaders.size > this.bounds.leaderBuys) this.leaders.delete(this.leaders.keys().next().value!);
      return;
    }
    const b = this.leaders.get(key);
    if (!b || s.ts < b.buyTs) return;
    b.soldTokens += Math.max(0, s.tokens);
    b.firstSellTs ??= s.ts;
    b.touched = s.at;
  }

  /** Once a minute: drop what fell out of the windows, keep memory bounded, look up waiting creators. */
  tick(now = this.deps.now()): void {
    for (const [mint, st] of this.mints) {
      while (st.ring.length && st.ring[0].at < now - RING_MS) this.dropOldest(st);
      const last = Math.max(st.lastOk?.at ?? 0, st.ring.at(-1)?.at ?? 0);
      if (!st.ring.length && now - last > MINT_IDLE_MS) this.evict(mint);
      else this.saveHigh(mint, st);
    }
    for (const [key, b] of this.leaders) if (now - b.touched > LEADER_IDLE_MS) this.leaders.delete(key);
    if (now - this.lastPrune >= 3_600_000) {
      // First sightings older than 8 days go: every window that reads them is 7 days (a coin met again starts over).
      this.lastPrune = now;
      this.db.prepare("DELETE FROM brain_token_first_seen WHERE first_seen_at < ?").run(iso(now - FIRST_SEEN_KEEP_MS));
      this.db.prepare("DELETE FROM brain_active_wallets_hourly WHERE hour < ?").run(iso(now - FIRST_SEEN_KEEP_MS));
    }
    void this.lookupCreators(now);
  }

  // ------------------------------------------------- queries (windows [end − W, end) on block time; known = delivered before t)

  /**
   * The coin's tracked swaps with block time in [end − windowMs, end) that the server had before `knownBefore` (insert
   * time), oldest first. An entry feature passes end = T (the leader's block second) and knownBefore = t; an exit feature
   * end = knownBefore = t.
   */
  recent(mint: string, end = this.deps.now(), windowMs = FLOW_MS, knownBefore = end): StreamSwap[] {
    const ring = this.mints.get(mint)?.ring ?? [];
    const out: StreamSwap[] = [];
    // The ring is in delivery order and a swap is delivered after its block time (give or take the clock skew), so the walk
    // back stops once insert times are older than the window.
    for (let i = ring.length - 1; i >= 0; i--) {
      const s = ring[i];
      if (s.at < end - windowMs - TS_SKEW_MS) break;
      if (s.at >= knownBefore || s.ts >= end || s.ts < end - windowMs) continue;
      out.push(s);
    }
    return out.reverse().sort((a, b) => a.ts - b.ts);
  }

  /**
   * The tracked crowd of a coin with block time in [end − windowMs, end), delivered before `o.knownBefore` (default end),
   * `exclude` (the leader) left out of the wallet counts.
   */
  flow(mint: string, end = this.deps.now(), o: { exclude?: string; windowMs?: number; knownBefore?: number } = {}): Flow {
    const okBuyers = new Set<string>();
    const buyers = new Set<string>();
    const sellers = new Set<string>();
    let okBuySol = 0;
    let netSol = 0;
    let okSwaps = 0;
    for (const s of this.recent(mint, end, o.windowMs ?? FLOW_MS, o.knownBefore ?? end)) {
      if (s.ok) okSwaps++;
      if (s.wallet === o.exclude) continue;
      if (s.side === "buy") {
        buyers.add(s.wallet);
        netSol += s.sol;
        if (s.ok) {
          okBuyers.add(s.wallet);
          okBuySol += s.sol;
        }
      } else {
        sellers.add(s.wallet);
        netSol -= s.sol;
      }
    }
    return { okBuyers: okBuyers.size, buyers: buyers.size, okBuySol, sellers: sellers.size, netSol, okSwaps };
  }

  /** The coin's last ok tracked price inserted before t (null: none in memory). */
  lastTracked(mint: string, t = this.deps.now()): { price: number; ts: number; at: number } | null {
    const st = this.mints.get(mint);
    if (!st) return null;
    let s = st.lastOk;
    if (s && s.at >= t) {
      s = null;
      for (let i = st.ring.length - 1; i >= 0; i--) {
        if (st.ring[i].at < t && st.ring[i].ok) {
          s = st.ring[i];
          break;
        }
      }
    }
    return s ? { price: s.price, ts: s.ts, at: s.at } : null;
  }

  /** Was this price ok for the coin's filter (the last swap recorded at that price)? For callers holding a raw stream price. */
  isOkPrice(mint: string, price: number, signature?: string): boolean | null {
    const ring = this.mints.get(mint)?.ring;
    if (!ring) return null;
    for (let i = ring.length - 1; i >= Math.max(0, ring.length - 20); i--) {
      if (ring[i].price === price && (!signature || ring[i].signature === signature)) return ring[i].ok;
    }
    return null;
  }

  /** The coin's first sighting (memory or the table); null = never seen. */
  firstSeen(mint: string): FirstSeen | null {
    const st = this.mints.get(mint);
    if (st) return st.first;
    const row = this.db.prepare("SELECT * FROM brain_token_first_seen WHERE mint = ?").get(mint) as
      | { first_seen_at: string; source: "stream" | "db"; first_ok_price: number | null; first_ok_price_at: string | null; creator: string | null; creator_resolved_at: string | null }
      | undefined;
    if (!row) return null;
    return {
      mint, firstSeenAt: ms(row.first_seen_at), source: row.source, firstOkPrice: row.first_ok_price, firstOkAt: row.first_ok_price_at ? ms(row.first_ok_price_at) : null,
      creator: row.creator, creatorResolvedAt: row.creator_resolved_at ? ms(row.creator_resolved_at) : null,
    };
  }

  /**
   * The coin's highest ok price with block time in [t − 7 d, cut) that the server had before t (dd_from_high: cut = T − 60 s);
   * null = none. What left the ring is known (it arrived over an hour ago).
   */
  maxOkBefore(mint: string, cut: number, t = this.deps.now()): number | null {
    const st = this.mints.get(mint);
    if (!st) return null;
    let best = st.histMax && st.histMax.ts >= t - WINDOW_7D_MS && st.histMax.ts < cut ? st.histMax.price : null;
    for (const s of st.ring) {
      if (s.at >= t) break; // delivery order: the rest arrived later still
      if (s.ok && s.ts < cut && s.ts >= t - WINDOW_7D_MS && (best === null || s.price > best)) best = s.price;
    }
    return best;
  }

  /** Other coins of this creator first seen in [t − 7 d, t) (cr_seen_prior_7d). */
  creatorCoins7d(creator: string, t = this.deps.now(), exceptMint?: string): number {
    if (!creator) return 0;
    return (
      this.db
        .prepare("SELECT COUNT(*) n FROM brain_token_first_seen WHERE creator = ? AND first_seen_at >= ? AND first_seen_at < ? AND mint != ?")
        .get(creator, iso(t - WINDOW_7D_MS), iso(t), exceptMint ?? "") as { n: number }
    ).n;
  }

  /** The leader's latest buy of the coin and what it sold since, as the stream delivered it before t. */
  leaderHolding(leader: string, mint: string): LeaderHolding | null {
    const b = this.leaders.get(`${leader}|${mint}`);
    if (!b) return null;
    const soldFrac = b.postBuyTokens && b.postBuyTokens > 0 ? Math.min(1, b.soldTokens / b.postBuyTokens) : 0;
    return { leader, mint, buyTs: b.buyTs, signature: b.signature, postBuyTokens: b.postBuyTokens, soldTokens: b.soldTokens, firstSellTs: b.firstSellTs, soldFrac };
  }

  /**
   * Distinct tracked wallets the stream delivered swaps of in the previous complete UTC hour before t, by insert time
   * (tracked_active_wallets_1h): this process's count, or one persisted by an earlier process that saw the whole hour.
   * null = no process saw all of it (missing: the feature's default), never a count by block time from wallet_swaps,
   * which would count backfilled history and jump after every restart.
   */
  activeWallets1h(t = this.deps.now()): number | null {
    const prev = Math.floor(t / 3_600_000) - 1;
    if (this.hour.h === prev && this.hour.whole && Math.floor(this.deps.now() / 3_600_000) > prev) return this.hour.wallets.size;
    let n = this.hourCounts.get(prev);
    if (n === undefined) {
      const row = this.db.prepare("SELECT wallets FROM brain_active_wallets_hourly WHERE hour = ?").get(iso(prev * 3_600_000)) as { wallets: number } | undefined;
      if (!row) return null;
      this.hourCounts.set(prev, (n = row.wallets));
    }
    return n;
  }

  /** What memory holds (for the server log and the bound tests). */
  stats(): { mints: number; swaps: number; leaders: number; creatorQueue: number; creatorDropped: number } {
    let swaps = 0;
    for (const st of this.mints.values()) swaps += st.ring.length;
    return { mints: this.mints.size, swaps, leaders: this.leaders.size, creatorQueue: this.creatorQueue.size + this.creatorHot.size, creatorDropped: this.creatorDropped };
  }
}
