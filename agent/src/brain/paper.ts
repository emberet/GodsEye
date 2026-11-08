/**
 * THE PAPER ACCOUNTS — the Brain trades paper money on the live stream, next to today's real rules, before it may touch SOL.
 *
 * Three accounts, each with its own bankroll (BRAIN_BANKROLL_SOL, else the real COPY_BUDGET_SOL) and the real limits:
 *   brain    — the policy's own trades (the entry network's stake, the exit network's exits)
 *   explore  — the signals the policy routed to exploration (~10%), kept apart so they never flatter or hurt the Brain's record
 *   baseline — today's real rules, mirrored from the copy engine: current leaders only, sized by copySize(weight), the
 *              learned exit rule (stop-loss, take-profit, ladder with a trailing stop, ceiling), max hold, the leader's sells
 * Brain and Explore see every analyzed wallet's buys (any wallet in the wallets table, shadow-only research wallets included).
 *
 * Stakes (CONTRACT.md): Brain/Explore stake stakeFrac × the real per-trade size COPY_MAX_TRADE_SOL (never more), on any
 * analyzed wallet whatever its copy weight; Baseline stakes what the real engine would, copySize of the wallet's copy_weight
 * after the quant gates.
 *
 * Fills are paper: the buy is quoted (Jupiter, nothing sent; one request under the Jupiter bucket's exit lane, no fill
 * without a token) after the real copy delay, a sell is quoted when it happens.
 * A leader sell during the copy delay is applied right after the fill, as the real engine's sell queues behind its buy.
 *   cost     = stake + BRAIN_TX_COST_SOL + BRAIN_RENT_SOL (the token account's rent, refunded on a full close)
 *   proceeds = the quoted SOL − BRAIN_TX_COST_SOL
 * The real rules on every new entry, per account: the stake is at most COPY_MAX_TRADE_SOL (and at least COPY_MIN_TRADE_SOL),
 * the bankroll caps what's in open positions, cash can't go negative, COPY_MAX_POSITIONS, one position per coin, and the daily
 * loss limit (COPY_DAILY_LOSS_LIMIT_SOL) per UTC day. The real pause (data/PAUSE, `npm run pause`) does not stop paper trading.
 *
 * Exits: a stream price per coin (onPrice, or onStreamSwap with what StreamState kept), and once a minute (tick) a sell quote
 * for a coin with no price for 90 s. Brain and Explore positions ask the exit network every minute, on a stream price at most
 * every 15 s, and at once when the leader sells (onLeaderSell / onLeaderSellSwap / onStreamSwap: the runtime's hooks); hard
 * stops apply on top (−BRAIN_HARD_STOP_PCT, BRAIN_MAX_HOLD_HOURS).
 * Every decision is recorded for the Mac (transitions.ts).
 *
 * Prices (CONTRACT.md, sim.yaml mark_model): a stream price counts only if it passes the coin's TRAILING outlier filter
 * (state.ts: within 10× of the median of its previous 10 valid prices, backed by more than its own wallet), so one bad print
 * can't make a peak or a stop. A price is never kept as it was once it is stale (> 90 s): the mark model (quotes.ts
 * QuoteModel, BRAIN_DIR/quote_model.json) ages it. A coin is dead when its sell quote finds no route: it is marked at the
 * last price × f_dark(age) (at most NO_ROUTE_MAX, quote_failed = 1), and DEAD_AFTER_FAILS such quotes in a row write the
 * position off at 0 with the rent lost (info.forced = "dead"). A quote that fails for another reason (rate limit, timeout,
 * a key or server error) or isn't asked (the cap) marks it at the last price × m(age) and leaves the streak as it was: an
 * outage says nothing about the coin (CONTRACT.md: only no-route quotes make a coin dead; a coin that can never be quoted
 * is written off WRITE_OFF_AFTER_MS past its max hold). Only a print with `tracked` refreshes the price's time; an
 * untracked one moves the price but not its age (it can't hold off the quote).
 *
 * Quotes (the Jupiter API is shared with the real engine): a stale mark and the quote that confirms a price exit are asked
 * under their own cap, BRAIN_EXIT_QUOTES_PER_MIN (apart from the shadow quotes' cap), and the one Jupiter bucket's exit
 * lane (quotes.ts jupiterBucket: above the mirror and shadow lanes, backing off after a 429); a confirmation reuses a quote
 * from the last EXIT_QUOTE_REUSE_MS; a sale's own quote is always asked (and counted). The paper rug check stores its
 * verdict quietly: a paper decision never reaches the public feed.
 *
 * Never touches the real engine: no CopyEngine, no RealExecutor, no signature, no copy_trades or positions rows.
 */
import { type DB, isNonMemecoin } from "@godseye/shared";
import { config } from "../config";
import { fmtPct } from "../log";
import { copySize } from "../learning/weights";
import { currentExits, ruleName, type Exits } from "../learning/exits";
import { currentLeaders } from "../learning/loop";
import { applyQuantSizing, skillGateBlocks } from "../copy/quant";
import { type RugCheckRow, type RugVerdict, type Screen, saveVerdict, screenToken } from "../market/rugcheck";
import { replayDelaySec } from "../smart/copy-check";
import type { ParsedSwap } from "../chain/parse";
import { darkMark, isRateLimit, jupiterBuyQuoteOnce, type JupiterBucket, jupiterBucket, type QuoteModel, QuoteBudget, quoteModel, sellQuoteClient, staleMark } from "./quotes";
import { ensureBrainTables } from "./schema";
import { type StreamSwap, TrailingFilter } from "./state";
import { type Account, closeEntryUnfilled, EXIT_ACTIONS, type ExitAction, finishPosition, linkEntry, recordTransition, type TransitionRow } from "./transitions";

export const ACCOUNTS: Account[] = ["brain", "explore", "baseline"];

/** A coin the stream hasn't priced for this long is priced by a sell quote (as in the copy engine). */
export const STALE_PRICE_MS = 90_000;
/** Least time between two stream-driven checks of one position (the copy engine's per-coin stream check). */
export const STREAM_CHECK_MS = 2_000;
/** Least time between two exit-network evaluations of one position on stream prices (CONTRACT.md). */
export const NET_EVAL_MS = 15_000;
export const EQUITY_EVERY_MS = 10 * 60_000;
/** A position past its max hold that still has no sell route this long after is written off (a rug leaves no route). */
export const WRITE_OFF_AFTER_MS = 3_600_000;
/** Sell quotes in a row with no route that make a coin dead: written off at 0, the rent lost (CONTRACT.md). */
export const DEAD_AFTER_FAILS = 3;
/** The no-route mark's floor: a coin whose sell quote has no route is worth at least its last price × this (f_dark's last step). */
export const NO_ROUTE_MARK = 0.001;
/** A price exit is confirmed with a sell quote this recent if there is one (else a new one, under the exit-quote cap). */
export const EXIT_QUOTE_REUSE_MS = 15_000;
/** sell_quote_ratio reads a quote this recent. */
const QUOTE_FRESH_MS = 5 * 60_000;
/** mom5's lookback, and how long a position's marks are kept for it. */
const MOM_MS = 5 * 60_000;
const MARKS_KEEP_MS = 10 * 60_000;
const LEADERS_TTL_MS = 60_000;
const DELAY_TTL_MS = 10 * 60_000;
const SEEN_MAX = 20_000;
const WARN_QUIET_MS = 10 * 60_000;

/** A leader's buy seen on the stream. `t` is when the leader traded (ms). */
export interface LeaderBuy {
  leader: string;
  mint: string;
  symbol?: string | null;
  solAmount: number;
  priceSol: number;
  signature: string;
  t: number;
  /** The leader's swap venue, e.g. "pumpswap (via bot)" (stored on the position: the exit features read it). */
  venue?: string | null;
  /** The leader's tokens bought and its balance before: leader_post_buy_tokens = the sum (leader_sold_frac's base). */
  tokenAmount?: number;
  tokenBalanceBefore?: number;
}

/** The entry network's choice for one account: the stake as a fraction of the real per-trade size (0 = skip, at most 1). */
export interface EntryDecision {
  stakeFrac: number;
  q?: number[] | null;
  features: number[];
  modelVersion?: string | null;
  info?: Record<string, unknown>;
}

/** A signal goes to the Brain or (exploration) to Explore; none = the model doesn't trade it or isn't loaded. */
export interface EntryDecisions {
  brain?: EntryDecision;
  explore?: EntryDecision;
}

export interface PaperPosition {
  id: number;
  account: Account;
  leader: string;
  mint: string;
  symbol: string | null;
  opened_at: string;
  closed_at: string | null;
  status: "open" | "closed";
  stake_frac: number;
  cost_sol: number;
  fee_sol: number;
  rent_sol: number;
  tokens: number;
  tokens_left: number;
  entry_price_sol: number;
  last_price_sol: number | null;
  last_price_ts: string | null;
  peak_pct: number | null;
  half_sold: number;
  leader_sold: number;
  proceeds_sol: number;
  pnl_sol: number | null;
  pnl_pct: number | null;
  exit_reason: string | null;
  model_version: string | null;
  explore: number;
  exit_rule: string | null;
  venue: string | null;
  leader_post_buy_tokens: number | null;
  leader_sold_tokens: number;
  leader_sold_at: string | null;
  last_tracked_price_ts: string | null;
  quote_failed: number;
  quote_fails: number;
  quote_price_sol: number | null;
  quote_ts: string | null;
}

/**
 * What the exit network sees about an open position. Returns are fractions of the entry price (0.5 = +50%), before fees.
 * drawdown_from_peak: how far below its best it is now, as a fraction of the best (0 = at its best).
 */
export interface ExitState {
  ret_now: number;
  peak_ret: number;
  drawdown_from_peak: number;
  minutes_held: number;
  leader_sold: boolean;
  half_sold: boolean;
  minutes_since_price: number;
  /** The latest sell quote found no route (the mark is then near zero). */
  quote_failed: boolean;
  /** Minutes since the coin's last ok stream price from a tracked wallet (not reset by quotes), capped at 1440. */
  mins_since_tracked_price: number;
  /** Tokens the leader sold since the copied buy / its holding right after it, capped at 1 (null: holding unknown). */
  leader_sold_frac: number | null;
  /** Minutes since the leader's first sell after the copied buy (0 before it sells). */
  minutes_since_leader_sold: number;
  /** Latest sell quote within 5 min / (tokens_left × last ok stream price), in [0, 2]; null = no such quote or price. */
  sell_quote_ratio: number | null;
  /** ret_now 5 minutes ago from the position's own marks (0 = the entry, for a position younger than that); mom5 reads it. */
  ret_5m_ago: number;
  position: PaperPosition;
}

export interface ExitDecision {
  action: ExitAction;
  q?: number[] | null;
  features?: number[];
  modelVersion?: string | null;
}

/** Everything that reaches outside: injected so the book runs in tests without a network or a model. */
export interface PaperDeps {
  /** A buy quote: tokens `sol` buys now, and the price paid (SOL per token). null = no route; a throw = failed otherwise. */
  quoteBuy(mint: string, sol: number): Promise<{ tokens: number; priceSol: number } | null>;
  /** SOL a sell of `tokens` would get now. null = no route; a throw = the quote failed for another reason (rate limit…). */
  quoteSell(mint: string, tokens: number): Promise<number | null>;
  now(): number;
  wait(ms: number): Promise<void>;
  /** The real copy delay (ms); default GodsEye's measured one (smart/copy-check.ts replayDelaySec). */
  delayMs?: number;
  decideEntry(signal: LeaderBuy): EntryDecisions | null | Promise<EntryDecisions | null>;
  /** For Brain/Explore positions; null = no model (hold; the hard stops still apply). */
  decideExit(position: PaperPosition, state: ExitState): ExitDecision | null | Promise<ExitDecision | null>;
  /** The wallets the real engine copies now (learning/loop.ts currentLeaders). */
  baselineLeaders(): string[];
  /**
   * SOL the real engine would stake on this wallet's buy (copySize of its weight, after the quant gates): Baseline's stake.
   * 0 = the real engine wouldn't stake on it.
   */
  baselineSize(leader: string): number;
  /** The exit rule the real engine uses now (learning/exits.ts currentExits). */
  baselineExits(): Exits;
  /** The real rug check (false = the real engine wouldn't buy this coin). */
  screen(mint: string, symbol: string): Promise<boolean>;
  /** A wallet GodsEye analyzed (any row in wallets): Brain and Explore consider its buys. */
  isAnalyzed(wallet: string): boolean;
  /**
   * The coin's last ok tracked price inserted before t (StreamState.lastTracked), when the runtime has the stream state:
   * mins_since_tracked_price and sell_quote_ratio read it (it survives a restart of the book). Optional.
   */
  lastTracked?(mint: string, t: number): { price: number; at: number } | null;
  /** The one Jupiter bucket (default the process's quotes.ts jupiterBucket). */
  bucket?: JupiterBucket;
  /** The mark model for prices with no fresh quote (default quotes.ts quoteModel(): BRAIN_DIR/quote_model.json or the default). */
  quoteModel?(now: number): QuoteModel;
}

/** An entry waiting out the copy delay: it holds its budget, cash and coin, and collects the leader's sells meanwhile. */
interface Pending {
  leader: string;
  stake: number;
  cash: number;
  /** What the leader sold before the fill (share of its holding, tokens, when), in order: applied right after it. */
  sells: LeaderSell[];
}

interface LeaderSell {
  share: number;
  tokens: number;
  t: number;
}

interface Plan {
  account: Account;
  stake: number;
  frac: number;
  decision?: EntryDecision;
  tid?: number;
  pending?: Pending;
}

interface CheckOpts {
  /** The price came from a stream swap or a fresh quote: store it as the position's price now. */
  mark?: boolean;
  /** A sell quote for all of tokens_left, already fetched. */
  quoteSol?: number | null;
  leaderSold?: boolean;
  /** The price is a tracked wallet's swap on the stream (moves last_tracked_price_ts, ends a no-route streak). */
  tracked?: boolean;
  /** An untracked print (onPrice with tracked: false): it moves the price, not last_price_ts (the price's age). */
  untracked?: boolean;
  /** The latest sell quote found no route: nothing can be sold; the price is the near-zero mark. */
  quoteFailed?: boolean;
}

/** What a sell quote came back with: SOL, null = no route (it counts toward a dead coin), undefined = failed for another reason. */
type Quoted = number | null | undefined;

/** What a position is worth now: the stream's price or a sell quote; `failed` = no route; `dead` = DEAD_AFTER_FAILS in a row. */
interface Mark {
  price: number;
  quote: number | null;
  at: number;
  failed: boolean;
  dead: boolean;
}

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const iso = (ms: number) => new Date(ms).toISOString();
const dayOf = (ms: number) => iso(ms).slice(0, 10);
const maxHoldMs = (account: Account) => (account === "baseline" ? config.maxHoldHours : config.brainMaxHoldHours) * 3_600_000;

/**
 * The real rug check (market/rugcheck.ts rugCheck: the cached verdict, else a fresh screen, fail closed) for a paper entry,
 * with the verdict stored quietly: Brain and Explore screen every analyzed wallet's coins, and a paper decision must never
 * announce a blocked coin on the public feed. null = couldn't verify.
 */
export async function paperRugCheck(db: DB, mint: string, symbol: string, screen: (mint: string) => Promise<Screen> = screenToken): Promise<RugVerdict | null> {
  const cached = db.prepare("SELECT * FROM rug_checks WHERE mint = ?").get(mint) as RugCheckRow | undefined;
  if (cached && Date.now() - new Date(cached.checked_at).getTime() < config.rugCheckCacheHours * 3_600_000) {
    return { verdict: cached.verdict, blocks: JSON.parse(cached.blocks), warnings: JSON.parse(cached.warnings), rugcheckScore: cached.rugcheck_score };
  }
  const s = await screen(mint);
  if (!s.verdict || s.holdersStatus === "failed" || s.holdersStatus === "timeout") return null;
  saveVerdict(db, mint, symbol, s.verdict, false);
  return s.verdict;
}

export class PaperBook {
  private deps: PaperDeps;
  /** Entries waiting out the copy delay, per account and coin. */
  private pending = new Map<Account, Map<string, Pending>>(ACCOUNTS.map((a) => [a, new Map()]));
  /** Positions with a check (and maybe a sale) under way. */
  private locks = new Map<number, Promise<unknown>>();
  private nextStreamCheck = new Map<number, number>();
  private lastNetEval = new Map<number, number>();
  private seen = new Map<string, true>();
  private leaders: { set: Set<string>; at: number } | null = null;
  private delay: { ms: number; at: number } | null = null;
  private openMints: Set<string> | null = null;
  private equityBucket = -1;
  private ticking = false;
  private warned = new Map<string, number>();
  /** The trailing outlier filter of each coin a paper account holds, fed every stream price of it. */
  private filters = new Map<string, TrailingFilter>();
  /** Each Brain/Explore position's recent marks (ret_now by time), for mom5. */
  private marks = new Map<number, { t: number; ret: number }[]>();
  /** Each held coin's last ok stream price (sell_quote_ratio's denominator). */
  private streamPrice = new Map<string, { price: number; at: number }>();
  /** The paper accounts' own quote cap (stale marks, exit confirmations; sales are counted, never refused). */
  readonly exitQuotes = new QuoteBudget(() => config.brainExitQuotesPerMin);
  /** Stale marks and confirmations not asked because of the cap, since start (server log). */
  quotesCapped = 0;

  constructor(private db: DB, deps: Partial<PaperDeps> = {}) {
    ensureBrainTables(db);
    this.deps = {
      quoteBuy: jupiterBuyQuoteOnce, // a quote only, one request (no retry): the bucket counts what Jupiter sees
      quoteSell: sellQuoteClient(), // one request a quote (no retry): the exit-quote cap counts what Jupiter sees
      now: Date.now,
      wait: (ms) => new Promise((r) => setTimeout(r, ms)),
      decideEntry: () => null,
      decideExit: () => null,
      baselineLeaders: () => currentLeaders(db),
      baselineSize: (leader) => this.realSize(leader),
      baselineExits: () => currentExits(db, config, this.deps.now()),
      screen: async (mint, symbol) => !config.rugCheckEnabled || (await paperRugCheck(db, mint, symbol))?.verdict === "pass",
      isAnalyzed: (wallet) => !!db.prepare("SELECT 1 FROM wallets WHERE address = ?").get(wallet),
      bucket: jupiterBucket,
      quoteModel: (now) => quoteModel(undefined, now),
      ...deps,
    };
    const now = this.deps.now();
    const bankroll = config.brainBankrollSol > 0 ? config.brainBankrollSol : config.copyBudgetSol;
    const add = db.prepare("INSERT OR IGNORE INTO brain_paper_accounts (account, bankroll_sol, cash_sol, started_at, day, day_loss_sol) VALUES (?, ?, ?, ?, ?, 0)");
    for (const a of ACCOUNTS) add.run(a, bankroll, bankroll, iso(now), dayOf(now));
  }

  /** The real engine's stake for a leader's buy (copy/engine.ts roomFor, before its budget and balance limits). */
  private realSize(leader: string): number {
    const row = this.db.prepare("SELECT copy_weight FROM wallets WHERE address = ?").get(leader) as { copy_weight: number } | undefined;
    const weight = skillGateBlocks(this.db, leader) ? 0 : (row?.copy_weight ?? 0);
    let size = copySize(weight, config);
    if (size > 0) size = Math.min(size, applyQuantSizing(this.db, leader, size, weight, config).size);
    return size;
  }

  private leaderSet(now: number): Set<string> {
    if (!this.leaders || now - this.leaders.at > LEADERS_TTL_MS) this.leaders = { set: new Set(this.deps.baselineLeaders()), at: now };
    return this.leaders.set;
  }

  private delayMs(now: number): number {
    if (this.deps.delayMs !== undefined) return this.deps.delayMs;
    if (!this.delay || now - this.delay.at > DELAY_TTL_MS) this.delay = { ms: replayDelaySec(this.db) * 1000, at: now };
    return this.delay.ms;
  }

  /** Server log only (never the public logs feed), at most once per 10 min per kind. */
  private warn(key: string, message: string): void {
    const now = Date.now();
    if (now < (this.warned.get(key) ?? 0)) return;
    this.warned.set(key, now + WARN_QUIET_MS);
    console.warn(`[brain] ${message}`);
  }

  /** The account's row, its daily loss rolled over to a new UTC day first. */
  account(account: Account, now = this.deps.now()): { bankroll_sol: number; cash_sol: number; day: string; day_loss_sol: number } {
    const day = dayOf(now);
    this.db.prepare("UPDATE brain_paper_accounts SET day = ?, day_loss_sol = 0 WHERE account = ? AND day != ?").run(day, account, day);
    return this.db.prepare("SELECT bankroll_sol, cash_sol, day, day_loss_sol FROM brain_paper_accounts WHERE account = ?").get(account) as {
      bankroll_sol: number; cash_sol: number; day: string; day_loss_sol: number;
    };
  }

  /** How much a new entry may stake under the real limits, or why it may not. */
  private room(account: Account, mint: string, stake: number, now: number): { size: number } | { blocked: string } {
    if (stake < config.copyMinTradeSol) return { blocked: "below the minimum trade" };
    const acc = this.account(account, now);
    if (acc.day_loss_sol >= config.dailyLossLimitSol) return { blocked: "daily loss limit reached" };
    const pend = this.pending.get(account)!;
    if (pend.has(mint) || this.db.prepare("SELECT 1 FROM brain_paper_positions WHERE status='open' AND account = ? AND mint = ?").get(account, mint)) {
      return { blocked: "already holding this coin" };
    }
    const held = this.db
      .prepare("SELECT COUNT(*) n, COALESCE(SUM(CASE WHEN tokens > 0 THEN cost_sol * tokens_left / tokens ELSE cost_sol END),0) c FROM brain_paper_positions WHERE status='open' AND account = ?")
      .get(account) as { n: number; c: number };
    const flying = [...pend.values()].reduce((s, p) => ({ stake: s.stake + p.stake, cash: s.cash + p.cash }), { stake: 0, cash: 0 });
    if (config.maxPositions > 0 && held.n + pend.size >= config.maxPositions) return { blocked: `already at ${config.maxPositions} open positions` };
    let size = Math.min(stake, config.copyMaxTradeSol, acc.bankroll_sol - held.c - flying.stake);
    if (size < config.copyMinTradeSol) return { blocked: "budget fully in use" };
    size = Math.min(size, acc.cash_sol - flying.cash - config.brainTxCostSol - config.brainRentSol);
    if (size < config.copyMinTradeSol) return { blocked: "not enough cash" };
    return { size: Number(size.toFixed(6)) };
  }

  /**
   * A leader's buy (any analyzed wallet). Decides for each account, reserves under the limits, waits out the copy delay and
   * fills at a quote. Resolves once every fill is done (the stream doesn't wait for it).
   */
  async onLeaderBuy(s: LeaderBuy): Promise<void> {
    if (config.brainMode === "off") return;
    if (this.seen.has(s.signature)) return;
    this.seen.set(s.signature, true);
    if (this.seen.size > SEEN_MAX) this.seen.delete(this.seen.keys().next().value!);
    const now = this.deps.now();
    // The real engine's filters on the trade itself: dust, not a memecoin, seen too late.
    if (!(s.solAmount >= config.minLeaderBuySol) || isNonMemecoin(s.mint, s.symbol)) return;
    if ((now - s.t) / 1000 > config.maxCopyDelaySeconds) return;

    let decided: EntryDecisions | null = null;
    if (this.deps.isAnalyzed(s.leader)) {
      try {
        decided = await this.deps.decideEntry(s);
      } catch (e) {
        this.warn("entry", `entry decision failed: ${(e as Error).message.slice(0, 120)}`);
      }
    }
    const isLeader = this.leaderSet(now).has(s.leader);
    if (!decided?.brain && !decided?.explore && !isLeader) return;
    // Brain/Explore stake a fraction of the real per-trade size; Baseline what the real engine would stake (CONTRACT.md).
    const base = Math.max(0, this.deps.baselineSize(s.leader) || 0);
    const unit = config.copyMaxTradeSol;
    const ts = iso(now);
    const info = { signature: s.signature, leader_sol: s.solAmount, leader_price_sol: s.priceSol, base_size_sol: unit, real_size_sol: base };
    const plans: Plan[] = [];
    for (const account of ["brain", "explore"] as const) {
      const d = decided?.[account];
      if (!d) continue;
      const frac = clamp(Number.isFinite(d.stakeFrac) ? d.stakeFrac : 0, 0, 1);
      const tid = recordTransition(this.db, {
        ts, account, kind: "entry", leader: s.leader, mint: s.mint, modelVersion: d.modelVersion, features: d.features, action: frac, q: d.q,
        info: { ...info, ...d.info, ...(frac > 0 ? {} : { skipped: true }) }, reward: frac > 0 ? null : 0, done: frac <= 0,
      });
      if (!(frac > 0)) continue;
      plans.push({ account, stake: frac * unit, frac, decision: d, tid });
    }
    if (isLeader && base > 0) {
      const d = decided?.brain ?? decided?.explore;
      const tid = recordTransition(this.db, { ts, account: "baseline", kind: "entry", leader: s.leader, mint: s.mint, modelVersion: d?.modelVersion, features: d?.features ?? [], action: 1, info });
      plans.push({ account: "baseline", stake: base, frac: 1, tid });
    }

    const go: Plan[] = [];
    for (const p of plans) {
      const r = this.room(p.account, s.mint, p.stake, now);
      if ("blocked" in r) {
        if (p.tid) closeEntryUnfilled(this.db, p.tid, r.blocked);
        continue;
      }
      p.stake = r.size;
      p.pending = { leader: s.leader, stake: p.stake, cash: p.stake + config.brainTxCostSol + config.brainRentSol, sells: [] };
      this.pending.get(p.account)!.set(s.mint, p.pending);
      go.push(p);
    }
    if (!go.length) return;
    try {
      const ok = await this.deps.screen(s.mint, s.symbol ?? s.mint.slice(0, 6)).catch(() => false);
      if (!ok) {
        for (const p of go) if (p.tid) closeEntryUnfilled(this.db, p.tid, "rug check");
        return;
      }
      const wait = s.t + this.delayMs(now) - this.deps.now();
      if (wait > 0) await this.deps.wait(wait);
      for (const p of go) await this.fill(s, p);
    } finally {
      for (const p of go) this.unpend(s.mint, p);
    }
  }

  /** The plan's reservation ends (filled or not); never another, later reservation of the same coin. */
  private unpend(mint: string, p: Plan): void {
    const pend = this.pending.get(p.account)!;
    if (p.pending && pend.get(mint) === p.pending) pend.delete(mint);
  }

  private async fill(s: LeaderBuy, p: Plan): Promise<void> {
    // The buy quote takes a token from the one Jupiter bucket's exit lane, and waits out a 429's back-off: no token, no fill.
    const bucket = this.deps.bucket!;
    const asked = this.deps.now();
    if (!bucket.take("exit", asked)) {
      this.unpend(s.mint, p);
      if (p.tid) closeEntryUnfilled(this.db, p.tid, bucket.backingOff(asked) ? "no quote: Jupiter rate limit (backing off)" : "no quote: Jupiter cap");
      return;
    }
    let q: { tokens: number; priceSol: number } | null = null;
    let failed = false;
    try {
      q = await this.deps.quoteBuy(s.mint, p.stake);
      bucket.ok();
    } catch (e) {
      if (isRateLimit(e)) bucket.rateLimited(this.deps.now());
      failed = true;
    }
    if (!q || !(q.tokens > 0)) {
      this.unpend(s.mint, p);
      if (p.tid) closeEntryUnfilled(this.db, p.tid, failed ? "no quote: the buy quote failed" : "no buy route");
      return;
    }
    const now = this.deps.now();
    const price = q.priceSol > 0 ? q.priceSol : p.stake / q.tokens;
    const exitRule = p.account === "baseline" ? ruleName(this.deps.baselineExits()) : `exit network${p.decision?.modelVersion ? ` ${p.decision.modelVersion}` : ""}`;
    const postBuy = s.tokenAmount !== undefined && s.tokenAmount > 0 ? Math.max(0, s.tokenBalanceBefore ?? 0) + s.tokenAmount : null;
    const id = this.db.transaction(() => {
      const pos = this.db
        .prepare(
          `INSERT INTO brain_paper_positions (account, leader, mint, symbol, opened_at, status, stake_frac, cost_sol, fee_sol, rent_sol, tokens, tokens_left,
             entry_price_sol, last_price_sol, last_price_ts, peak_pct, model_version, explore, exit_rule, venue, leader_post_buy_tokens, last_tracked_price_ts)
           VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          p.account, s.leader, s.mint, s.symbol ?? null, iso(now), p.frac, p.stake, config.brainTxCostSol, config.brainRentSol, q.tokens, q.tokens,
          price, price, iso(now), p.decision?.modelVersion ?? null, p.account === "explore" ? 1 : 0, exitRule, s.venue ?? null, postBuy, iso(s.t),
        );
      this.db.prepare("UPDATE brain_paper_accounts SET cash_sol = MAX(0, cash_sol - ?) WHERE account = ?").run(p.stake + config.brainTxCostSol + config.brainRentSol, p.account);
      if (p.tid) linkEntry(this.db, p.tid, Number(pos.lastInsertRowid));
      return Number(pos.lastInsertRowid);
    })();
    // In the same synchronous step as the insert: from here on a leader sell finds the open position, not the reservation.
    this.unpend(s.mint, p);
    this.openMints = null;
    // The leader's buy is the coin's latest tracked price: it starts the filter when nothing else has.
    if (!this.filters.has(s.mint)) {
      const f = new TrailingFilter();
      f.accept(s.priceSol, s.solAmount, s.tokenAmount ?? Infinity, s.leader);
      this.filters.set(s.mint, f);
    }
    this.marks.set(id, [{ t: now, ret: 0 }]);
    for (const sell of p.pending?.sells ?? []) await this.leaderSold(id, p.account, sell);
  }

  private openMintSet(): Set<string> {
    this.openMints ??= new Set((this.db.prepare("SELECT DISTINCT mint FROM brain_paper_positions WHERE status='open'").all() as { mint: string }[]).map((r) => r.mint));
    return this.openMints;
  }

  private get(id: number): PaperPosition | undefined {
    return this.db.prepare("SELECT * FROM brain_paper_positions WHERE id = ? AND status='open'").get(id) as PaperPosition | undefined;
  }

  /** Run `fn` on one position unless a check of it is already under way (`wait`: queue behind it instead). */
  private withPosition(id: number, fn: (pos: PaperPosition) => Promise<void>, wait = false): Promise<void> {
    const prev = this.locks.get(id);
    if (prev && !wait) return Promise.resolve();
    const run = async () => {
      const pos = this.get(id);
      if (pos) await fn(pos);
    };
    const next = (prev ?? Promise.resolve()).then(run, run);
    const tail = next.catch((e: Error) => this.warn("exit", `exit check failed: ${e.message.slice(0, 120)}`));
    this.locks.set(id, tail);
    void tail.finally(() => {
      if (this.locks.get(id) === tail) this.locks.delete(id);
    });
    return tail;
  }

  /**
   * A swap of any coin on the live stream: for a coin a paper account holds, its price this second, if it passes the coin's
   * trailing outlier filter (`solAmount` < 0.001 SOL or `o.tokens` < 1 is no price either; unknown = not checked; `o.wallet`
   * backs the price's level). `ok` = already judged by StreamState's filter (true: taken as is; false: a bad print).
   * `tracked` = a tracked wallet's swap as StreamState kept it: only that moves last_tracked_price_ts and ends a no-route
   * streak (an ok tracked swap is what shows the coin alive: sim.yaml, mins_since_tracked_price). `tracked: false` = an
   * untracked wallet's print: it moves the price but not its time (last_price_ts), so it can't hold off the stale quote
   * and the mark model. A caller that doesn't say (runtime.ts's raw stream price, for now) refreshes the price's time as
   * before, but never ends a no-route streak.
   */
  async onPrice(mint: string, priceSol: number, t?: number, solAmount?: number, o: { ok?: boolean; tracked?: boolean; tokens?: number; wallet?: string } = {}): Promise<void> {
    if (config.brainMode === "off" || !(priceSol > 0) || !this.openMintSet().has(mint) || o.ok === false) return;
    if (o.ok !== true) {
      let filter = this.filters.get(mint);
      if (!filter) this.filters.set(mint, (filter = new TrailingFilter()));
      if (!filter.accept(priceSol, solAmount, o.tokens, o.wallet)) return; // a bad print: no mark, no peak, no stop
    }
    const now = this.deps.now();
    this.streamPrice.set(mint, { price: priceSol, at: now });
    const open = this.db.prepare("SELECT id FROM brain_paper_positions WHERE status='open' AND mint = ?").all(mint) as { id: number }[];
    await Promise.all(
      open.map(({ id }) => {
        if (now < (this.nextStreamCheck.get(id) ?? 0)) return;
        this.nextStreamCheck.set(id, now + STREAM_CHECK_MS);
        const untracked = o.tracked === false;
        return this.withPosition(id, (pos) => this.check(pos, priceSol, "stream", { mark: true, tracked: o.tracked === true, untracked }, untracked ? undefined : (t ?? now)));
      }),
    );
  }

  /**
   * The runtime's hook for each swap StreamState kept (state.onSwap's result): a tracked wallet's ok price marks the coin,
   * and an analyzed wallet's sell is a leader sell (the exits are evaluated at once).
   */
  async onStreamSwap(s: StreamSwap): Promise<void> {
    const jobs: Promise<void>[] = [];
    if (s.tracked && s.ok) jobs.push(this.onPrice(s.mint, s.price, s.ts, s.sol, { ok: true, tracked: true }));
    if (s.analyzed && s.side === "sell") {
      const fraction = s.tokenBalanceBefore > 0 ? Math.min(1, s.tokens / s.tokenBalanceBefore) : 1;
      jobs.push(this.onLeaderSell(s.wallet, s.mint, s.ts, fraction, s.tokens));
    }
    await Promise.all(jobs);
  }

  /**
   * The leader sold `fraction` of its holding (`tokens` of it, at `t`): the runtime's hook, called at once on the stream sell.
   * Baseline sells the same share, as the real engine does (all of it from 90%); Brain and Explore ask the exit network at
   * once, with leader_sold set and leader_sold_frac / minutes_since_leader_sold updated.
   */
  async onLeaderSell(leader: string, mint: string, t?: number, fraction = 1, tokens = 0): Promise<void> {
    if (config.brainMode === "off") return;
    const sell: LeaderSell = { share: clamp(Number.isFinite(fraction) ? fraction : 1, 0, 1), tokens: Number.isFinite(tokens) ? Math.max(0, tokens) : 0, t: t ?? this.deps.now() };
    // A copy of this buy still in its copy delay: the fill applies the sell right after (the real engine's sell waits on the coin's lock).
    for (const a of ACCOUNTS) {
      const p = this.pending.get(a)!.get(mint);
      if (p?.leader === leader) p.sells.push(sell);
    }
    const open = this.db.prepare("SELECT id, account FROM brain_paper_positions WHERE status='open' AND mint = ? AND leader = ?").all(mint, leader) as { id: number; account: Account }[];
    await Promise.all(open.map(({ id, account }) => this.leaderSold(id, account, sell)));
  }

  /** The hook with the stream's sell swap itself: its share of the leader's holding and its tokens. */
  onLeaderSellSwap(swap: Pick<ParsedSwap, "wallet" | "mint" | "ts" | "tokenAmount" | "tokenBalanceBefore">): Promise<void> {
    const fraction = swap.tokenBalanceBefore > 0 ? Math.min(1, swap.tokenAmount / swap.tokenBalanceBefore) : 1;
    return this.onLeaderSell(swap.wallet, swap.mint, Date.parse(swap.ts) || this.deps.now(), fraction, swap.tokenAmount);
  }

  /** One position's leader sold: Baseline sells the same share (all of it from 90%), Brain/Explore ask the network. */
  private leaderSold(id: number, account: Account, sell: LeaderSell): Promise<void> {
    this.db
      .prepare("UPDATE brain_paper_positions SET leader_sold = 1, leader_sold_tokens = leader_sold_tokens + ?, leader_sold_at = COALESCE(leader_sold_at, ?) WHERE id = ? AND status='open'")
      .run(sell.tokens, iso(sell.t), id);
    return this.withPosition(
      id,
      async (pos) => {
        if (account === "baseline") {
          const all = sell.share >= 0.9;
          await this.sell(pos, all ? pos.tokens_left : pos.tokens_left * sell.share, all, `leader sold ${Math.round(sell.share * 100)}%`);
          return;
        }
        const m = await this.priceOf(pos);
        if (m.dead) return this.writeOffDead(pos, "leader");
        await this.check(pos, m.price, "leader", { quoteSol: m.quote, mark: m.quote !== null, leaderSold: true, quoteFailed: m.failed }, m.at);
      },
      true,
    );
  }

  /**
   * A sell quote for `tokens`: SOL, null = no route (counted on the position), undefined = failed for another reason (a
   * 429 backs the bucket off; never counted: a rate limit, a revoked key or a Jupiter outage says nothing about the coin).
   */
  private async quote(pos: PaperPosition, tokens: number): Promise<Quoted> {
    let got: number | null;
    try {
      got = await this.deps.quoteSell(pos.mint, tokens);
    } catch (e) {
      if (isRateLimit(e)) this.deps.bucket!.rateLimited(this.deps.now());
      return undefined;
    }
    this.deps.bucket!.ok();
    if (got === null || !(got > 0)) {
      pos.quote_fails += 1;
      pos.quote_failed = 1;
      this.db.prepare("UPDATE brain_paper_positions SET quote_failed = 1, quote_fails = quote_fails + 1 WHERE id = ?").run(pos.id);
      return null;
    }
    const now = this.deps.now();
    Object.assign(pos, { quote_fails: 0, quote_failed: 0, quote_price_sol: got / tokens, quote_ts: iso(now) });
    this.db.prepare("UPDATE brain_paper_positions SET quote_failed = 0, quote_fails = 0, quote_price_sol = ?, quote_ts = ? WHERE id = ?").run(got / tokens, iso(now), pos.id);
    return got;
  }

  /**
   * Room under the exit-quote cap and in the Jupiter bucket's exit lane for a quote that only checks (a stale mark, a
   * confirmation); logged when there is none.
   */
  private quoteRoom(now: number): boolean {
    const bucket = this.deps.bucket!;
    if (!bucket.backingOff(now) && this.exitQuotes.take(now) && bucket.take("exit", now)) return true;
    this.quotesCapped++;
    const why = bucket.backingOff(now) ? "Jupiter rate limit (backing off)" : `paper quote cap reached (${config.brainExitQuotesPerMin}/min)`;
    this.warn("exit-quotes", `${why}: a stale mark or an exit confirmation waits (${this.quotesCapped} since start)`);
    return false;
  }

  /**
   * A position's mark from its stored price: the last price while fresh (≤ 90 s), else aged by the mark model —
   * × f_dark(age) after a no-route quote, × m(age) otherwise. The age runs from last_price_ts (a tracked print, an ok quote).
   */
  private markOf(pos: PaperPosition, now: number): number {
    const price = pos.last_price_sol ?? pos.entry_price_sol;
    const ageMs = Math.max(0, now - Date.parse(pos.last_price_ts ?? pos.opened_at));
    const model = this.deps.quoteModel!(now);
    if (pos.quote_failed) return price * Math.max(NO_ROUTE_MARK, darkMark(model, ageMs / 1000));
    return ageMs <= STALE_PRICE_MS ? price : price * staleMark(model, ageMs / 1000);
  }

  /**
   * A sell quote for all of tokens_left to confirm a price exit: a quote from the last EXIT_QUOTE_REUSE_MS is reused (a
   * stream check every 2 s would otherwise ask Jupiter 30 times a minute per position), else a new one under the cap.
   * `reused` = not fresh enough to sell at (the sale asks its own); "capped" = no quote this time.
   */
  private async confirmQuote(pos: PaperPosition, now: number): Promise<{ sol: Quoted; reused: boolean } | "capped"> {
    const at = pos.quote_ts ? Date.parse(pos.quote_ts) : -Infinity;
    if (!pos.quote_failed && pos.quote_price_sol !== null && pos.quote_price_sol > 0 && now - at <= EXIT_QUOTE_REUSE_MS) {
      return { sol: pos.quote_price_sol * pos.tokens_left, reused: true };
    }
    if (!this.quoteRoom(now)) return "capped";
    return { sol: await this.quote(pos, pos.tokens_left), reused: false };
  }

  /**
   * The position's price now: the stream's last one, or a sell quote when it is older than 90 s. A price is never kept as
   * it was: with no quote (it failed, or the cap) the mark is the last price × m(age); with no route, × f_dark(age)
   * (quote_failed). DEAD_AFTER_FAILS no-route quotes in a row make it dead (a quote that failed otherwise doesn't count).
   */
  private async priceOf(pos: PaperPosition): Promise<Mark> {
    const now = this.deps.now();
    const last = Date.parse(pos.last_price_ts ?? pos.opened_at);
    const kept = (): Mark => ({ price: this.markOf(pos, now), quote: null, at: last, failed: pos.quote_failed === 1, dead: pos.quote_fails >= DEAD_AFTER_FAILS });
    if (now - last <= STALE_PRICE_MS || !(pos.tokens_left > 0) || !this.quoteRoom(now)) return kept();
    const got = await this.quote(pos, pos.tokens_left);
    if (got === undefined) return kept();
    if (got === null) return { ...kept(), failed: true };
    return { price: got / pos.tokens_left, quote: got, at: now, failed: false, dead: false };
  }

  /** Once a minute: new UTC day, prices (a quote for a coin with none for 90 s), exits, and the equity curve every 10 min. */
  async tick(now = this.deps.now()): Promise<void> {
    if (config.brainMode === "off" || this.ticking) return;
    this.ticking = true;
    try {
      for (const a of ACCOUNTS) this.account(a, now);
      const open = this.db.prepare("SELECT id FROM brain_paper_positions WHERE status='open' ORDER BY id").all() as { id: number }[];
      for (const { id } of open) {
        await this.withPosition(id, async (pos) => {
          const m = await this.priceOf(pos);
          if (m.dead) return this.writeOffDead(pos, "tick");
          await this.check(pos, m.price, "tick", { quoteSol: m.quote, mark: m.quote !== null, quoteFailed: m.failed }, m.at);
        });
      }
      this.snapshot(now);
    } finally {
      this.ticking = false;
    }
  }

  /** Each account's value every 10 minutes: cash + open positions at their last price + the rent they'll get back. */
  snapshot(now = this.deps.now(), force = false): void {
    const bucket = Math.floor(now / EQUITY_EVERY_MS);
    if (bucket === this.equityBucket && !force) return;
    this.equityBucket = bucket;
    const ts = iso(bucket * EQUITY_EVERY_MS);
    const put = this.db.prepare("INSERT OR REPLACE INTO brain_paper_equity (account, ts, equity_sol) VALUES (?, ?, ?)");
    for (const a of ACCOUNTS) put.run(a, ts, this.equity(a));
  }

  /** Cash + open positions at their mark (markOf: a stale price aged, a no-route coin at f_dark) + refundable rent. */
  equity(account: Account, now = this.deps.now()): number {
    const cash = (this.db.prepare("SELECT cash_sol FROM brain_paper_accounts WHERE account = ?").get(account) as { cash_sol: number }).cash_sol;
    const open = this.db.prepare("SELECT * FROM brain_paper_positions WHERE status='open' AND account = ?").all(account) as PaperPosition[];
    return cash + open.reduce((v, p) => v + p.tokens_left * this.markOf(p, now) + p.rent_sol, 0);
  }

  /** One position at one price: the account's exit rules, then (Brain/Explore) the exit network. */
  private async check(pos: PaperPosition, price: number, source: "stream" | "tick" | "leader", o: CheckOpts, priceAt?: number): Promise<void> {
    if (!(pos.tokens > 0) || !(price > 0) || !(pos.entry_price_sol > 0)) return;
    const now = this.deps.now();
    const pct = (price / pos.entry_price_sol - 1) * 100;
    const peak = Math.max(pos.peak_pct ?? 0, pct);
    // The mark, a tracked swap's news and a new peak: one write.
    const set: string[] = [];
    const args: (number | string)[] = [];
    // An untracked print moves the price, not its time: the price still ages, and the stale quote still comes.
    const stamp = o.mark && !o.untracked;
    if (o.mark) {
      set.push("last_price_sol = ?");
      args.push(price);
      if (stamp) {
        set.push("last_price_ts = ?");
        args.push(iso(now));
      }
      if (source === "stream" && o.tracked) {
        // A tracked wallet's swap at an ok price: the coin trades, whatever the last quote said.
        set.push("quote_failed = 0", "quote_fails = 0", "last_tracked_price_ts = ?");
        args.push(iso(now));
        Object.assign(pos, { quote_failed: 0, quote_fails: 0, last_tracked_price_ts: iso(now) });
      }
    }
    if (peak > (pos.peak_pct ?? 0)) {
      set.push("peak_pct = ?");
      args.push(peak);
    }
    if (set.length) this.db.prepare(`UPDATE brain_paper_positions SET ${set.join(", ")} WHERE id = ?`).run(...args, pos.id);
    const fresh = { ...pos, peak_pct: peak, last_price_sol: o.mark ? price : pos.last_price_sol, last_price_ts: stamp ? iso(now) : pos.last_price_ts };
    const ageMs = now - Date.parse(pos.opened_at);
    if (pos.account === "baseline") {
      if (o.quoteFailed) return; // no route: nothing can be sold until a quote finds one (or the coin is written off)
      return this.baselineExit(fresh, pct, peak, ageMs, source, o);
    }
    return this.brainExit(fresh, price, pct, peak, ageMs, source, o, priceAt ?? (stamp ? now : Date.parse(pos.last_price_ts ?? pos.opened_at)));
  }

  /** The real engine's exit check (copy/engine.ts checkExit) with the rule in use: a price exit is confirmed by a sell quote. */
  private async baselineExit(pos: PaperPosition, pct: number, peak: number, ageMs: number, source: string, o: CheckOpts): Promise<void> {
    const ex = this.deps.baselineExits();
    const exitAt = (p: number): "stop" | "trail" | "take" | "ladder" | null =>
      p <= -ex.stopLossPct ? "stop"
      : ex.trailStopPct > 0 && peak >= ex.trailArmPct && 1 + p / 100 <= (1 + peak / 100) * (1 - ex.trailStopPct / 100) ? "trail"
      : p >= ex.takeProfitPct ? "take"
      : ex.partialTpPct > 0 && !pos.half_sold && p >= ex.partialTpPct ? "ladder"
      : null;
    const label = { stop: "stop-loss", trail: `trailing stop (${ex.trailStopPct}% below its best, +${peak.toFixed(0)}%)`, take: "take-profit", ladder: `took ${Math.round(ex.partialFraction * 100)}% off` };
    let kind = exitAt(pct);
    let reason = kind ? `${label[kind]} at ${fmtPct(pct)}${source === "stream" ? " (stream)" : ""}` : ageMs >= maxHoldMs("baseline") ? `held ${config.maxHoldHours}h without the leader selling` : null;
    if (!reason) return;
    let quote: number | null = null;
    if (kind) {
      const c = typeof o.quoteSol === "number" ? { sol: o.quoteSol, reused: false } : await this.confirmQuote(pos, this.deps.now());
      if (c === "capped") return; // confirmed on a later check
      const got = c.sol;
      if (got === null) return this.afterNoRoute(pos, source);
      const heldCost = pos.cost_sol * (pos.tokens_left / pos.tokens);
      if (got !== undefined && heldCost > 0) {
        const real = ((got - heldCost) / heldCost) * 100;
        const confirmed = exitAt(real);
        if (!confirmed) return; // the price said exit, a sell quote says no
        kind = confirmed;
        reason = `${label[kind]} at ${fmtPct(real)} (sell quote)`;
        if (!c.reused) quote = got;
      }
    }
    const part = kind === "ladder";
    const sold = await this.sell(pos, part ? pos.tokens_left * ex.partialFraction : pos.tokens_left, !part, reason, { quoteSol: part ? null : quote });
    if (sold && part) this.db.prepare("UPDATE brain_paper_positions SET half_sold = 1 WHERE id = ?").run(pos.id);
  }

  /** What the exit network sees about the position now (features.yaml exit head; features.ts builds the vector from it). */
  private exitState(pos: PaperPosition, pct: number, peak: number, ageMs: number, priceAt: number, o: CheckOpts): ExitState {
    const now = this.deps.now();
    const ret = pct / 100;
    // The position's marks, for mom5: the latest one at least 5 minutes old (the entry's 0 for a younger position).
    let marks = this.marks.get(pos.id);
    if (!marks) this.marks.set(pos.id, (marks = []));
    marks.push({ t: now, ret });
    while (marks.length && marks[0].t < now - MARKS_KEEP_MS) marks.shift();
    let ret5 = ageMs < MOM_MS ? 0 : marks[0].ret;
    for (const m of marks) if (m.t <= now - MOM_MS) ret5 = m.ret;
    // The last ok tracked price: the stream state's (survives a restart), else what this book saw.
    const tracked = this.deps.lastTracked?.(pos.mint, now) ?? null;
    const lastTrackedAt = Math.max(tracked?.at ?? -Infinity, pos.last_tracked_price_ts ? Date.parse(pos.last_tracked_price_ts) : -Infinity);
    const streamPx = this.streamPrice.get(pos.mint)?.price ?? tracked?.price ?? null;
    const quoteAt = pos.quote_ts ? Date.parse(pos.quote_ts) : -Infinity;
    const leaderSoldAt = pos.leader_sold_at ? Date.parse(pos.leader_sold_at) : null;
    return {
      ret_now: ret,
      peak_ret: peak / 100,
      drawdown_from_peak: Math.max(0, 1 - (1 + ret) / (1 + peak / 100)),
      minutes_held: ageMs / 60_000,
      leader_sold: !!o.leaderSold || pos.leader_sold === 1,
      half_sold: pos.half_sold === 1,
      minutes_since_price: Math.min(60, Math.max(0, now - priceAt) / 60_000),
      quote_failed: !!o.quoteFailed || pos.quote_failed === 1,
      mins_since_tracked_price: Number.isFinite(lastTrackedAt) ? Math.min(1440, Math.max(0, now - lastTrackedAt) / 60_000) : 1440,
      leader_sold_frac: pos.leader_post_buy_tokens && pos.leader_post_buy_tokens > 0 ? Math.min(1, pos.leader_sold_tokens / pos.leader_post_buy_tokens) : null,
      minutes_since_leader_sold: leaderSoldAt !== null ? Math.max(0, now - leaderSoldAt) / 60_000 : 0,
      sell_quote_ratio:
        pos.quote_price_sol !== null && now - quoteAt <= QUOTE_FRESH_MS && streamPx && streamPx > 0 ? clamp(pos.quote_price_sol / streamPx, 0, 2) : null,
      ret_5m_ago: ret5,
      position: pos,
    };
  }

  /** A forced exit row (hard stop, max hold, write-off): sell_all with no features (CONTRACT.md). */
  private forcedRow(pos: PaperPosition, why: string, source: string, info: Record<string, unknown> = {}): TransitionRow {
    return {
      ts: iso(this.deps.now()), account: pos.account, kind: "exit", positionId: pos.id, leader: pos.leader, mint: pos.mint, modelVersion: pos.model_version,
      features: [], action: EXIT_ACTIONS.indexOf("sell_all"), info: { ...info, forced: why, source },
    };
  }

  /** Hard stops first (−BRAIN_HARD_STOP_PCT, confirmed by a quote; max hold), then the exit network. */
  private async brainExit(pos: PaperPosition, price: number, pct: number, peak: number, ageMs: number, source: "stream" | "tick" | "leader", o: CheckOpts, priceAt: number): Promise<void> {
    const now = this.deps.now();
    const state = this.exitState(pos, pct, peak, ageMs, priceAt, o);
    const { position: _p, ...stateInfo } = state;
    if (pct <= -config.brainHardStopPct) {
      // No route: the stop fires but nothing can be sold; the coin is quoted again next minute (dead after DEAD_AFTER_FAILS).
      if (o.quoteFailed) return;
      const c = typeof o.quoteSol === "number" ? { sol: o.quoteSol, reused: false } : await this.confirmQuote(pos, now);
      // Over the quote cap: the stop is confirmed on a later check (the network still decides on this one).
      if (c !== "capped") {
        const got = c.sol;
        if (got === null) return this.afterNoRoute(pos, source);
        const heldCost = pos.cost_sol * (pos.tokens_left / pos.tokens);
        // A thin coin's print can be far off its pool: no quote = trust the price, a quote above the stop = no stop.
        if (got === undefined || heldCost <= 0 || ((got - heldCost) / heldCost) * 100 <= -config.brainHardStopPct) {
          const quoteSol = got === undefined || c.reused ? null : got;
          await this.sell(pos, pos.tokens_left, true, `hard stop at ${fmtPct(pct)}`, { quoteSol, transition: this.forcedRow(pos, "hard-stop", source, { price, ...stateInfo }) });
          return;
        }
      }
    }
    if (ageMs >= maxHoldMs(pos.account) && !o.quoteFailed) {
      await this.sell(pos, pos.tokens_left, true, `held ${config.brainMaxHoldHours}h (max hold)`, { quoteSol: o.quoteSol, transition: this.forcedRow(pos, "max-hold", source, { price, ...stateInfo }) });
      return;
    }
    if (source === "stream" && now - (this.lastNetEval.get(pos.id) ?? 0) < NET_EVAL_MS) return;
    this.lastNetEval.set(pos.id, now);
    let d: ExitDecision | null = null;
    try {
      d = await this.deps.decideExit(pos, state);
    } catch (e) {
      this.warn("exit-model", `exit decision failed: ${(e as Error).message.slice(0, 120)}`);
    }
    if (!d || !EXIT_ACTIONS.includes(d.action)) return; // no model: hold (the hard stops above still apply)
    // sell_half is allowed once; a second one is a hold.
    const act: ExitAction = d.action === "sell_half" && pos.half_sold ? "hold" : d.action;
    recordTransition(this.db, {
      ts: iso(now), account: pos.account, kind: "exit", positionId: pos.id, leader: pos.leader, mint: pos.mint, modelVersion: d.modelVersion ?? pos.model_version,
      features: d.features ?? [], action: EXIT_ACTIONS.indexOf(act), q: d.q, info: { source, price, ...stateInfo, ...(act !== d.action ? { chosen: d.action } : {}) },
    });
    if (act === "hold" || o.quoteFailed) return; // with no route the sale waits for one
    const half = act === "sell_half";
    const reason = `exit network: ${act.replace("_", " ")} at ${fmtPct(pct)}${state.leader_sold ? " (leader sold)" : ""}`;
    const sold = await this.sell(pos, half ? pos.tokens_left * 0.5 : pos.tokens_left, !half, reason, { quoteSol: half ? null : o.quoteSol });
    if (sold && half) this.db.prepare("UPDATE brain_paper_positions SET half_sold = 1 WHERE id = ?").run(pos.id);
  }

  /** A sell quote just found no route: the coin is written off once that makes DEAD_AFTER_FAILS in a row. */
  private afterNoRoute(pos: PaperPosition, source: string): void {
    if (pos.quote_fails >= DEAD_AFTER_FAILS) this.writeOffDead(pos, source);
  }

  /**
   * Sell `tokens` (all = the whole position) at a sell quote. A full close refunds the rent and books the net P&L: on the
   * account's day, and as the reward of the position's transitions. No route = nothing sold (it counts toward a dead coin);
   * a quote that failed otherwise = tried again later, unless the position is past its max hold by WRITE_OFF_AFTER_MS.
   */
  private async sell(pos: PaperPosition, tokens: number, all: boolean, reason: string, o: { quoteSol?: number | null; transition?: TransitionRow } = {}): Promise<boolean> {
    if (!(tokens > 0)) return false;
    if (typeof o.quoteSol !== "number") {
      // A sale is always quoted, and counted (the bucket's lower lanes wait for it).
      this.exitQuotes.note(this.deps.now());
      this.deps.bucket!.note("exit", this.deps.now());
    }
    const got = typeof o.quoteSol === "number" ? o.quoteSol : await this.quote(pos, tokens);
    const now = this.deps.now();
    if (got === null) {
      this.afterNoRoute(pos, "sell");
      return false;
    }
    if (got === undefined || !(got >= 0)) {
      if (pos.quote_fails >= DEAD_AFTER_FAILS) this.writeOffDead(pos, "sell");
      else if (now - Date.parse(pos.opened_at) >= maxHoldMs(pos.account) + WRITE_OFF_AFTER_MS) this.writeOff(pos, o.transition);
      return false;
    }
    const tx = config.brainTxCostSol;
    if (!all && got <= tx) return false; // a part worth less than its fee: keep it
    const remaining = all ? 0 : Math.max(0, pos.tokens_left - tokens);
    const closed = remaining <= pos.tokens * 0.01;
    const proceeds = pos.proceeds_sol + got;
    const fees = pos.fee_sol + tx;
    const pnl = proceeds - pos.cost_sol - fees;
    this.db.transaction(() => {
      this.db.prepare("UPDATE brain_paper_positions SET tokens_left = ?, proceeds_sol = ?, fee_sol = ?, last_price_sol = ?, last_price_ts = ? WHERE id = ?")
        .run(closed ? 0 : remaining, proceeds, fees, got / tokens > 0 ? got / tokens : pos.last_price_sol, iso(now), pos.id);
      this.db.prepare("UPDATE brain_paper_accounts SET cash_sol = MAX(0, cash_sol + ?) WHERE account = ?").run(got - tx + (closed ? pos.rent_sol : 0), pos.account);
      if (o.transition) recordTransition(this.db, o.transition);
      if (closed) this.close(pos, pnl, reason, now);
    })();
    return true;
  }

  /**
   * DEAD_AFTER_FAILS sell quotes in a row found no route: the coin is dead. The position closes at value 0 with the rent
   * lost (info.forced = "dead"; Baseline's too, as nothing could sell it).
   */
  private writeOffDead(pos: PaperPosition, source: string): void {
    const row = pos.account === "baseline" ? undefined : this.forcedRow(pos, "dead", source, { quote_fails: pos.quote_fails, quote_failed: pos.quote_failed === 1 });
    this.writeOff(pos, row, "dead", `no sell route ${pos.quote_fails} quotes in a row: dead, written off`);
  }

  /** Written off: the tokens are worth nothing and the token account's rent stays locked (no route, so no close). */
  private writeOff(pos: PaperPosition, transition?: TransitionRow, forced = "write-off", reason = "no sell route after the max hold: written off"): void {
    const now = this.deps.now();
    const pnl = pos.proceeds_sol - pos.cost_sol - pos.fee_sol - pos.rent_sol;
    this.db.transaction(() => {
      this.db.prepare("UPDATE brain_paper_positions SET tokens_left = 0 WHERE id = ?").run(pos.id);
      if (transition) recordTransition(this.db, { ...transition, info: { ...transition.info, forced } });
      this.close(pos, pnl, reason, now);
    })();
  }

  private close(pos: PaperPosition, pnl: number, reason: string, now: number): void {
    const pct = pos.cost_sol > 0 ? (pnl / pos.cost_sol) * 100 : 0;
    this.db.prepare("UPDATE brain_paper_positions SET status = 'closed', tokens_left = 0, closed_at = ?, exit_reason = ?, pnl_sol = ?, pnl_pct = ? WHERE id = ?").run(iso(now), reason, pnl, pct, pos.id);
    this.account(pos.account, now);
    this.db.prepare("UPDATE brain_paper_accounts SET day_loss_sol = day_loss_sol - ? WHERE account = ?").run(pnl, pos.account);
    finishPosition(this.db, pos.id, pnl);
    this.openMints = null;
    this.nextStreamCheck.delete(pos.id);
    this.lastNetEval.delete(pos.id);
    this.marks.delete(pos.id);
    if (!this.openMintSet().has(pos.mint)) {
      this.filters.delete(pos.mint);
      this.streamPrice.delete(pos.mint);
    }
  }
}
