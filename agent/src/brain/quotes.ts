/**
 * SHADOW SELL QUOTES — what a copy could really have sold for, next to what the tape said (research only, nothing is sent).
 *
 * For every one of the Brain's paper candidates (every copy-eligible buy by an analyzed wallet, bots and pumpswap included;
 * BRAIN_SHADOW_QUOTE_RATE, default 1, can thin it), a Jupiter sell quote for what a COPY_MAX_TRADE_SOL copy at the leader's
 * price would hold, 5, 15, 30 and 60 s after the leader's buy and right after EVERY sell of the leader's in the next 24 h,
 * stored in brain_shadow_quotes with the last ok tracked price and its age. This is what calibrates the simulator's marks
 * (sim.yaml mark_model: m(age), f_dark) on fresh data, and the paper book's marks (quote_model.json) in turn.
 *
 * ONE JUPITER BUCKET (JupiterBucket, jupiterBucket): every Brain quote takes a token from one bucket of
 * JUPITER_QUOTES_PER_MIN, by priority — real engine > paper exits (and paper buy fills) > mirror ledger > shadow. A lane may take a token only
 * while the bucket stays above its floor (the shadow lane leaves the top half, the mirror's the top quarter, for the lanes
 * above), and a sale's quote is never refused (it is counted, and may take the bucket below zero: the lower lanes then
 * wait for it). After a 429 every lane but a sale backs off (BACKOFF_MIN_MS, doubling to BACKOFF_MAX_MS, reset on a quote
 * that worked). Inside it, the old per-lane caps still hold: BRAIN_SHADOW_QUOTES_PER_MIN in any 60 s, split into
 * BRAIN_MIRROR_QUOTES_PER_MIN for the mirror ledger's exit quotes (tryQuote, y_quote) and the rest for the shadow quotes.
 * A due shadow quote with no token isn't asked and is stored as 'capped'; it never waits, so it can never delay a paper or
 * real sell. Each quote is one request (no retry after a 429 or a timeout: the bucket counts what Jupiter sees).
 *
 * MARK MODEL (QuoteModel, quote_model.json in BRAIN_DIR): what the paper book marks a position at when it has no fresh
 * price — m(age) when the sell quote failed (429, timeout) or wasn't asked (the cap), f_dark(age) when it found no route.
 * A conservative default until the Mac fits one on pre-test shadow quotes.
 *
 * Wiring (brain/runtime.ts): quotes.onCandidate(buy) for each analyzed wallet's buy, quotes.onLeaderSell(...) for each of its
 * sells, quotes.start() once (a 1 s timer runs the due quotes), quotes.stop() on shutdown. The real engine's own quotes
 * (market/jupiter.ts) should call jupiterBucket.note("real") so the lanes below see them.
 */
import fs from "node:fs";
import path from "node:path";
import { type DB, isNonMemecoin, LAMPORTS_PER_SOL, repoRoot, SOL_MINT } from "@godseye/shared";
import { config } from "../config";
import { HttpError } from "../http";
import { tokenDecimals } from "../market/decimals";
import { jupiterQuote } from "../market/jupiter";
import { ensureBrainTables } from "./schema";

export const HORIZONS_SEC = [5, 15, 30, 60];
/** A sampled candidate's leader sell is quoted only this long after its buy. */
export const SELL_WATCH_MS = 24 * 3_600_000;
/** A sampled candidate's leader sells quoted at most (a bot that sells hundreds of times can't flood the bucket). */
export const MAX_SELL_QUOTES = 50;
const MAX_JOBS = 20_000;
const MAX_WATCHED = 20_000;
const RUN_EVERY_MS = 1_000;

const iso = (ms: number) => new Date(ms).toISOString();

/** Jupiter's answer when the coin has no route (http.ts puts the first 200 characters of the body in the message). */
const NO_ROUTE_BODY = /COULD_NOT_FIND_ANY_ROUTE|NO_ROUTES_FOUND|TOKEN_NOT_TRADABLE|could not find any route|not tradable/i;

/**
 * Did a quote fail because the coin has no route (a 400 whose body is Jupiter's route error), rather than for a passing
 * reason (rate limit, timeout, server error, or a key or gateway refusing us: 401, 403, 404)? Only the first says anything
 * about the coin: counting a revoked key as no route would write every paper position off as dead.
 */
export const isNoRoute = (e: unknown): boolean => e instanceof HttpError && e.status === 400 && NO_ROUTE_BODY.test(e.message);

/**
 * SOL a sell of `tokens` would get now (copy/executor.ts sellQuoteSol, asked once: no retry after a rate limit, a server
 * error or a timeout, so one quote under the caps here is one request to Jupiter). A quote only: nothing is signed or sent.
 */
export async function jupiterSellQuoteOnce(mint: string, tokens: number): Promise<number | null> {
  const decimals = await tokenDecimals(mint);
  if (decimals === undefined) throw new Error("couldn't read token decimals");
  const amount = BigInt(Math.floor(tokens * 10 ** decimals));
  if (amount <= 0n) return null;
  const q = await jupiterQuote(mint, SOL_MINT, amount, config.slippageBps, 0);
  const sol = Number(q.outAmount) / LAMPORTS_PER_SOL;
  return sol > 0 ? sol : null;
}

/**
 * Tokens `sol` would buy now and the price paid (copy/executor.ts PaperExecutor.buy, asked once: no retry, so one paper
 * fill is one request to Jupiter, counted in the bucket by the paper book). null = no route; throws otherwise. A quote
 * only: nothing is signed or sent.
 */
export async function jupiterBuyQuoteOnce(mint: string, sol: number): Promise<{ tokens: number; priceSol: number } | null> {
  const lamports = BigInt(Math.floor(sol * LAMPORTS_PER_SOL));
  if (lamports <= 0n) return null;
  let q: Awaited<ReturnType<typeof jupiterQuote>>;
  try {
    q = await jupiterQuote(SOL_MINT, mint, lamports, config.slippageBps, 0);
  } catch (e) {
    if (isNoRoute(e)) return null;
    throw e;
  }
  const decimals = await tokenDecimals(mint);
  if (decimals === undefined) throw new Error("couldn't read token decimals");
  const tokens = Number(q.outAmount) / 10 ** decimals;
  const spent = Number(q.inAmount) / LAMPORTS_PER_SOL;
  return tokens > 0 && spent > 0 ? { tokens, priceSol: spent / tokens } : null;
}

/** The Brain's sell quote client (jupiterSellQuoteOnce): null = no route; throws otherwise. `raw` replaces it (tests). */
export function sellQuoteClient(raw?: (mint: string, tokens: number) => Promise<number | null>): (mint: string, tokens: number) => Promise<number | null> {
  const ask = raw ?? jupiterSellQuoteOnce;
  return (mint, tokens) =>
    ask(mint, tokens).catch((e: unknown) => {
      if (isNoRoute(e)) return null;
      throw e;
    });
}

/** At most `perMinute` takes in any 60 s. */
export class QuoteBudget {
  private taken: number[] = [];

  constructor(private perMinute: () => number) {}

  private trim(now: number): void {
    while (this.taken.length && this.taken[0] <= now - 60_000) this.taken.shift();
  }

  /** Room for one more now? Takes it if so. */
  take(now: number): boolean {
    this.trim(now);
    if (this.taken.length >= this.perMinute()) return false;
    this.taken.push(now);
    return true;
  }

  /** Count one that is asked whatever the cap says (a sale: exits are never starved). */
  note(now: number): void {
    this.trim(now);
    this.taken.push(now);
  }

  /** Takes left in the current 60 s. */
  left(now: number): number {
    this.trim(now);
    return Math.max(0, this.perMinute() - this.taken.length);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The mark model: what a position with no fresh price is worth

/** A step curve: [up to this age in seconds, factor] in rising age; past the last step, the last factor. */
export type MarkCurve = [number, number][];

export interface QuoteModel {
  /** m(age): the mark when a sell quote failed or wasn't asked, × the last price. Never above 1. */
  m: MarkCurve;
  /** f_dark(age): the mark when a sell quote found no route, × the last price. Never above NO_ROUTE_MAX. */
  fDark: MarkCurve;
  source: "default" | string;
}

/**
 * A no-route mark is at most this × the last price: the simulator gives a quote no route only once f_dark(age) < 0.10
 * (sim.yaml stale_dead), and unsellability is absorbing (4 of 1,288 recover).
 */
export const NO_ROUTE_MAX = 0.1;

/**
 * Conservative until fitted: m is sim.yaml's m_age_table (train sellable samples, itself still optimistic on test) with
 * its 1.002 bin held at the bin before; f_dark starts at a twentieth of the 0.10 where the sim drops the route and falls to
 * 0.001 (the old flat mark) by 6 h.
 */
export const DEFAULT_QUOTE_MODEL: QuoteModel = {
  m: [[10, 0.996], [60, 0.996], [300, 0.987], [1800, 0.96], [21_600, 0.88], [86_400, 0.78]],
  fDark: [[300, 0.005], [3600, 0.002], [21_600, 0.001]],
  source: "default",
};

/** The curve's factor at `ageSec`. */
export function curveAt(curve: MarkCurve, ageSec: number): number {
  for (const [upTo, f] of curve) if (ageSec <= upTo) return f;
  return curve[curve.length - 1][1];
}

/** A curve from a file: rising ages, factors in [0, max], and never rising with age (a later step can only be lower). */
function parseCurve(v: unknown, max: number): MarkCurve | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  const out: MarkCurve = [];
  let lo = max;
  let prev = -Infinity;
  for (const step of v) {
    if (!Array.isArray(step) || step.length !== 2) return null;
    const [age, f] = step;
    if (typeof age !== "number" || typeof f !== "number" || !Number.isFinite(age) || !Number.isFinite(f) || age <= prev || f < 0) return null;
    prev = age;
    lo = Math.min(lo, f);
    out.push([age, lo]);
  }
  return out;
}

/** quote_model.json: {"m_age": [[sec, factor], ...], "f_dark": [[sec, factor], ...]}; null = not a valid model. */
export function parseQuoteModel(raw: unknown, source: string): QuoteModel | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const m = parseCurve(r.m_age, 1);
  const fDark = parseCurve(r.f_dark, NO_ROUTE_MAX);
  return m && fDark ? { m, fDark, source } : null;
}

const MODEL_CHECK_MS = 60_000;
const modelCache = new Map<string, { checked: number; mtime: number; model: QuoteModel }>();

/**
 * The mark model in use: BRAIN_DIR/quote_model.json when there is a valid one, else DEFAULT_QUOTE_MODEL. The file is
 * looked at at most once a minute and read again only when it changed; a broken file is logged and the default used.
 */
export function quoteModel(file = path.resolve(repoRoot(), config.brainDir, "quote_model.json"), now = Date.now()): QuoteModel {
  const hit = modelCache.get(file);
  if (hit && now - hit.checked < MODEL_CHECK_MS && now >= hit.checked) return hit.model;
  let mtime = -1;
  try {
    mtime = fs.statSync(file).mtimeMs;
  } catch {
    // no file: the default
  }
  if (hit && hit.mtime === mtime) {
    hit.checked = now;
    return hit.model;
  }
  let model = DEFAULT_QUOTE_MODEL;
  if (mtime >= 0) {
    try {
      model = parseQuoteModel(JSON.parse(fs.readFileSync(file, "utf8")), file) ?? DEFAULT_QUOTE_MODEL;
    } catch {
      model = DEFAULT_QUOTE_MODEL;
    }
    if (model === DEFAULT_QUOTE_MODEL) console.warn(`[brain] ${file} is not a valid quote model: the default marks are used`);
  }
  modelCache.set(file, { checked: now, mtime, model });
  return model;
}

/** m(age): a position whose sell quote failed or wasn't asked, × its last price. */
export const staleMark = (model: QuoteModel, ageSec: number) => Math.min(1, curveAt(model.m, Math.max(0, ageSec)));
/** f_dark(age): a position whose sell quote found no route, × its last price. */
export const darkMark = (model: QuoteModel, ageSec: number) => Math.min(NO_ROUTE_MAX, curveAt(model.fDark, Math.max(0, ageSec)));

// ---------------------------------------------------------------------------------------------------------------------
// One bucket for every Jupiter quote

/** Who asks, highest priority first. */
export type QuoteLane = "real" | "exit" | "mirror" | "shadow";
/** The share of the bucket a lane must leave for the lanes above it. */
const LANE_FLOOR: Record<Exclude<QuoteLane, "real">, number> = { exit: 0, mirror: 0.25, shadow: 0.5 };
export const BACKOFF_MIN_MS = 5_000;
export const BACKOFF_MAX_MS = 120_000;

/** Did Jupiter refuse the quote for the rate limit? */
export const isRateLimit = (e: unknown): boolean => e instanceof HttpError && e.status === 429;

/** A token bucket of `perMinute` a minute (bursts up to a minute's worth), with priority lanes and a 429 back-off. */
export class JupiterBucket {
  private level: number;
  private at: number;
  private backoffMs = 0;
  private until = -Infinity;
  /** Tokens refused per lane since start (server log). */
  readonly refused: Record<QuoteLane, number> = { real: 0, exit: 0, mirror: 0, shadow: 0 };

  constructor(private perMinute: () => number, now = Date.now()) {
    this.level = Math.max(0, perMinute());
    this.at = now;
  }

  private refill(now: number): number {
    const cap = Math.max(0, this.perMinute());
    if (now < this.at - 60_000) {
      // The clock went back a long way (a test, a clock fix): start full, with no back-off.
      this.level = cap;
      this.until = -Infinity;
      this.backoffMs = 0;
    } else if (now > this.at) {
      this.level = Math.min(cap, this.level + ((now - this.at) * cap) / 60_000);
    }
    this.at = Math.max(this.at, now);
    return cap;
  }

  /** A token for `lane` now? Takes it if so. The real engine's lane is never refused. */
  take(lane: QuoteLane, now: number): boolean {
    if (lane === "real") return this.note(lane, now), true;
    const cap = this.refill(now);
    if (now < this.until || this.level - 1 < LANE_FLOOR[lane] * cap) {
      this.refused[lane]++;
      return false;
    }
    this.level -= 1;
    return true;
  }

  /** A quote asked whatever the bucket says (a sale, the real engine): counted, and the lanes below wait for it. */
  note(_lane: QuoteLane, now: number): void {
    this.refill(now);
    this.level -= 1;
  }

  /** Jupiter answered 429: every lane but a sale backs off, a little longer each time in a row. */
  rateLimited(now: number): void {
    this.refill(now);
    this.backoffMs = this.backoffMs ? Math.min(BACKOFF_MAX_MS, this.backoffMs * 2) : BACKOFF_MIN_MS;
    this.until = now + this.backoffMs;
  }

  /** A quote went through: the back-off starts again from its shortest. */
  ok(): void {
    this.backoffMs = 0;
  }

  /** Backing off after a 429 at `now`? */
  backingOff(now: number): boolean {
    return now < this.until;
  }

  /** Tokens in the bucket now (may be below zero after sales). */
  left(now: number): number {
    this.refill(now);
    return this.level;
  }
}

/** The process's one bucket: the paper book, the mirror ledger and the shadow quotes share it. */
export const jupiterBucket = new JupiterBucket(() => config.jupiterQuotesPerMin);

/** A paper candidate: an analyzed wallet's buy as the stream delivered it. `t` = the leader's block time (ms). */
export interface QuoteCandidate {
  leader: string;
  mint: string;
  signature: string;
  priceSol: number;
  solAmount: number;
  t: number;
  venue?: string | null;
  symbol?: string | null;
}

interface Watched {
  c: QuoteCandidate;
  tokens: number;
  /** The leader's sells quoted (their times: the same sell delivered twice is quoted once). */
  sells: Set<number>;
}

interface Job {
  due: number;
  w: Watched;
  trigger: "time" | "leader_sell";
}

export interface ShadowQuoteDeps {
  now(): number;
  random(): number;
  /** SOL a sell of `tokens` would get now (a quote, nothing sent); null = no route. May throw (stored as an error). */
  quoteSell(mint: string, tokens: number): Promise<number | null>;
  /** The coin's last ok tracked price before t (StreamState.lastTracked), for the quote/tape ratio. */
  lastTracked(mint: string, t: number): { price: number; ts: number } | null;
  /** The one Jupiter bucket (default the process's jupiterBucket). */
  bucket: JupiterBucket;
}

/** The mirror ledger's share of the cap (never more than all of it). */
const mirrorShare = () => Math.max(0, Math.min(config.brainMirrorQuotesPerMin, config.brainShadowQuotesPerMin));
/** The shadow quotes' share: the rest. */
const shadowShare = () => config.brainShadowQuotesPerMin - mirrorShare();

export class ShadowQuotes {
  private deps: ShadowQuoteDeps;
  /** The shadow quotes' share of the cap. */
  readonly budget: QuoteBudget;
  /** The mirror ledger's share (tryQuote). */
  readonly mirrorBudget: QuoteBudget;
  private jobs: Job[] = [];
  private watched = new Map<string, Watched>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  /** Quotes not asked because of the cap, since start (server log). */
  capped = 0;

  constructor(private db: DB, deps: Partial<ShadowQuoteDeps> = {}) {
    ensureBrainTables(db);
    this.deps = {
      now: Date.now,
      random: Math.random,
      quoteSell: sellQuoteClient(),
      lastTracked: () => null,
      bucket: jupiterBucket,
      ...deps,
    };
    this.budget = new QuoteBudget(shadowShare);
    this.mirrorBudget = new QuoteBudget(mirrorShare);
  }

  /**
   * A paper candidate: sampled at BRAIN_SHADOW_QUOTE_RATE (default every one). Its quotes are asked when due, each under
   * the bucket (stored as capped when there is no token). True = sampled.
   */
  onCandidate(c: QuoteCandidate): boolean {
    if (!(c.solAmount >= config.minLeaderBuySol) || !(c.priceSol > 0) || isNonMemecoin(c.mint, c.symbol)) return false;
    const key = `${c.leader}|${c.mint}`;
    if (this.watched.has(key) || this.deps.random() >= config.brainShadowQuoteRate) return false;
    if (this.jobs.length + HORIZONS_SEC.length > MAX_JOBS) return false;
    const w: Watched = { c, tokens: config.copyMaxTradeSol / c.priceSol, sells: new Set() };
    this.watched.set(key, w);
    if (this.watched.size > MAX_WATCHED) this.watched.delete(this.watched.keys().next().value!);
    for (const h of HORIZONS_SEC) this.jobs.push({ due: c.t + h * 1000, w, trigger: "time" });
    this.jobs.sort((a, b) => a.due - b.due);
    return true;
  }

  /** The leader sold: a sampled candidate of its buy is quoted at once, on every sell (up to MAX_SELL_QUOTES). */
  onLeaderSell(leader: string, mint: string, t: number): void {
    const w = this.watched.get(`${leader}|${mint}`);
    if (!w || w.sells.has(t) || w.sells.size >= MAX_SELL_QUOTES || t < w.c.t || t > w.c.t + SELL_WATCH_MS || this.jobs.length >= MAX_JOBS) return;
    w.sells.add(t);
    this.jobs.unshift({ due: this.deps.now(), w, trigger: "leader_sell" });
  }

  /**
   * A sell quote for the mirror ledger's exits: a BRAIN_SHADOW_QUOTE_RATE sample, under the mirror's share of the cap (never
   * the shadow quotes'). undefined = not sampled or over that share: not asked.
   */
  async tryQuote(mint: string, tokens: number): Promise<number | null | undefined> {
    if (this.deps.random() >= config.brainShadowQuoteRate) return undefined;
    const now = this.deps.now();
    if (!this.mirrorBudget.take(now) || !this.deps.bucket.take("mirror", now)) {
      this.capped++;
      return undefined;
    }
    return this.deps.quoteSell(mint, tokens).then(
      (sol) => (this.deps.bucket.ok(), sol),
      (e: unknown) => (isRateLimit(e) && this.deps.bucket.rateLimited(this.deps.now()), null),
    );
  }

  /** Ask every due quote (each under the cap, or stored as capped). Resolves when they're stored. */
  async runDue(now = this.deps.now()): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const due: Job[] = [];
      while (this.jobs.length && this.jobs[0].due <= now) due.push(this.jobs.shift()!);
      await Promise.all(due.map((j) => this.quote(j, now)));
      for (const [key, w] of this.watched) if (now - w.c.t > SELL_WATCH_MS) this.watched.delete(key);
      return due.length;
    } finally {
      this.running = false;
    }
  }

  private async quote(j: Job, now: number): Promise<void> {
    const { c, tokens } = j.w;
    const tracked = this.deps.lastTracked(c.mint, now);
    let status: "ok" | "no_route" | "error" | "capped" = "capped";
    let sol: number | null = null;
    let error: string | null = null;
    if (this.budget.take(now) && this.deps.bucket.take("shadow", now)) {
      try {
        sol = await this.deps.quoteSell(c.mint, tokens);
        this.deps.bucket.ok();
        status = sol !== null && sol > 0 ? "ok" : "no_route";
        if (status === "no_route") sol = null;
      } catch (e) {
        if (isRateLimit(e)) this.deps.bucket.rateLimited(this.deps.now());
        status = "error";
        error = (e as Error).message.slice(0, 200);
      }
    } else this.capped++;
    const at = this.deps.now();
    this.db
      .prepare(
        `INSERT INTO brain_shadow_quotes (leader, mint, buy_sig, venue, leader_ts, leader_price_sol, tokens, trigger, horizon_sec, quoted_at, status,
           sell_quote_sol, error, tracked_price_sol, tracked_price_age_sec)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        c.leader, c.mint, c.signature, c.venue ?? null, iso(c.t), c.priceSol, tokens, j.trigger, (now - c.t) / 1000, iso(at), status,
        sol, error, tracked?.price ?? null, tracked ? (now - tracked.ts) / 1000 : null,
      );
  }

  /** Run the due quotes every second (unref'd: it never keeps the process alive). */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.runDue().catch((e) => console.warn(`[brain] shadow quotes: ${(e as Error).message.slice(0, 120)}`)), RUN_EVERY_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Quotes waiting (for the server log and tests). */
  pending(): number {
    return this.jobs.length;
  }

  /** Stored quotes older than `keepDays` go (they are pulled to the Mac long before). */
  prune(keepDays = 30, now = this.deps.now()): void {
    this.db.prepare("DELETE FROM brain_shadow_quotes WHERE quoted_at < ?").run(iso(now - keepDays * 86_400_000));
  }
}
