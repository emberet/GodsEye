/**
 * THE COPY ENGINE — reacts to a leader's swap.
 *
 * Leader buys  → GodsEye buys too, sized by the leader's weight from the
 *                learning loop, after every safety check passes.
 * Leader sells → GodsEye sells the same share of its position (sold 50% → GodsEye sells 50%).
 * Every minute → GodsEye marks its positions to market and exits on its own
 *                stop-loss / take-profit / max-hold, in case a leader never sells
 *                (or moves its tokens to another wallet). Between the minute checks, any swap of a coin
 *                GodsEye holds on the live stream runs the same check at that swap's price (onMarketSwap).
 *
 * Safety checks before any buy (any one failing = no buy):
 *   not a memecoin (bridged majors, staked SOL, stablecoins…) · the leader's
 *   trade was seen too late (price has moved on) · paused (`npm run pause`, or
 *   a file named data/PAUSE) · daily loss limit hit · max open positions ·
 *   already holding the token · copy budget used up · wallet balance below
 *   size + reserve · token fails the rug check (which also blocks tokens that
 *   can still be minted — most bridged tokens)
 * Skips that are about GodsEye's own state (no SOL, paused, limits) repeat for
 * every leader buy, so they're logged and recorded at most once per 10 minutes.
 * Every decision is written to the proof ledger before it's executed.
 *
 * With real money the risk governor (risk.ts) sets the size, the budget and the day's stop from what the wallet holds.
 * Limits (budget, open positions, daily loss) count only positions in the current mode, and buys still
 * in flight count against the budget: the final check and the reservation of a buy happen under one
 * lock, so two leader buys of different tokens can't both spend the same room.
 */
import fs from "node:fs";
import { commitProof, dataPath, type DB, getMeta, isNonMemecoinSymbol, NON_MEMECOIN_MINTS, nowIso, setMeta, SOL_MINT } from "@godseye/shared";
import { config } from "../config";
import { fmtPct, fmtSol, say, short } from "../log";
import { alert } from "../alerts";
import type { ParsedSwap } from "../chain/parse";
import { insertSwaps } from "../analysis/analyze";
import { copySize } from "../learning/weights";
import { currentExits, type Exits } from "../learning/exits";
import { applyQuantSizing, skillGateBlocks } from "./quant";
import { effectiveLimits, type Limits } from "./risk";
import { ownCoin } from "../creator/rewards";
import { rugLook, UNFINISHED_TEXT } from "../market/rugcheck";
import { gate, gateReason } from "../brain/gates";
import type { ShadowLogger } from "../shadow/log";
import { createDecisionAudit, type DecisionAudit } from "../audit/decisions";
import { noteSocialWarning } from "../social/labels";
import { getPrices } from "../market/prices";
import { symbolOf, tokenInfo } from "../market/tokens";
import { walletBalanceSol } from "../wallet/wallet";
import { NothingHeldError, UnsettledError, type Executor, type OnSigned } from "./executor";
import { RouteRefused } from "../market/jupiter";
import { applySellFill, openPositionFromFill, type PositionRow, usdOf } from "./fills";
import type { PublicKey } from "@solana/web3.js";

/** How long a repeated skip message stays quiet. */
const SKIP_QUIET_MS = 10 * 60_000;
/** A position the stream hasn't priced for this long, and the price API doesn't know, is priced by a sell quote. */
const UNPRICED_AFTER_MS = 90_000;
const BALANCE_CACHE_MS = 20_000;
/**
 * Longest a copy waits for a token's name. A brand-new token is often unknown to Shyft, and the fallback
 * (GeckoTerminal, ~9 calls a minute, shared with every smart-money lookup) can take hours; the lookup carries
 * on in the background and the copy goes ahead without the name.
 */
const NAME_WAIT_MS = 3_000;
/** Least time between two stream-driven exit checks of one coin (a busy coin swaps many times a second). */
const STREAM_CHECK_MS = 2_000;
/** After a sell quote didn't confirm the stream's price, the stream waits this long before asking again. */
const UNCONFIRMED_HOLD_MS = 5_000;
const OPEN_MINTS_TTL_MS = 30_000;
/** While a sell's outcome isn't known, the exit checks leave its position alone this long before looking again. */
const UNSETTLED_WAIT_MS = 60_000;
/** Jupiter's "slippage tolerance exceeded" (0x1771): the price moved past the quote while the sell was landing. */
const SLIPPAGE_ERROR = /6001|0x1771|slippage/i;

/** Slippage for a stop-loss or trailing-stop sell after `slipFails` slippage failures: 3% (COPY_SLIPPAGE_BPS), then 10%,
 *  then 25% (capped at COPY_EXIT_MAX_SLIPPAGE_BPS). Selling a crashing coin late costs more than a wide slippage. */
export function exitSlippageBps(slipFails: number): number {
  const steps = [config.slippageBps, 1000, 2500];
  return Math.max(config.slippageBps, Math.min(config.exitMaxSlippageBps, steps[Math.min(slipFails, steps.length - 1)]));
}

/** Wait before retrying a failed sell: 15 s, 30 s, 60 s … up to 5 min. */
export const sellRetryMs = (failures: number): number => Math.min(300, 15 * 2 ** Math.max(0, failures - 1)) * 1000;

export function isPaused(db: DB): boolean {
  return getMeta(db, "copy_paused") === "1" || fs.existsSync(dataPath("PAUSE"));
}

export class CopyEngine {
  private locks = new Map<string, Promise<unknown>>();
  /** Serialises the last limit check + reservation of every buy (see the note at the top). */
  private buyGate: Promise<unknown> = Promise.resolve();
  /** Failed sells per position: how many, how many were slippage errors, and when to try again. */
  private sellFailures = new Map<number, { count: number; slip: number; until: number }>();
  /** Positions with an exit check (and maybe a sell) under way: the stream and the minute job never run one twice. */
  private checking = new Set<number>();
  /** Per coin: when the stream may check it again. */
  private nextStreamCheck = new Map<string, number>();
  private openMints: { set: Set<string>; at: number } | null = null;
  /** Makes each own-exit sell's id unique (two tries of one exit can fall in the same millisecond). */
  private exitSeq = 0;
  /** Set by `stop()`: no new trade starts, and the ones under way are waited for. */
  private stopping = false;
  /** Throttle for repeated skip messages: key → when it may be shown again, and how many were held back. */
  private quiet = new Map<string, { until: number; held: number }>();
  private balance: { sol: number; at: number } | null = null;
  /** Reads the wallet's SOL (tests put a fake in its place). */
  balanceOf: (wallet: PublicKey) => Promise<number> = walletBalanceSol;
  /** Tokens already reported as not-memecoins today. */
  private notMemeLogged = new Map<string, string>();

  constructor(
    private db: DB,
    private executor: Executor,
    private wallet: PublicKey | null,
    /** Logs every copyable leader buy and what became of it, with or without SOL. Observation only (see shadow/log.ts). */
    private shadow: ShadowLogger | null = null,
    /** Records every leader buy considered, check by check, and the copyability gate's log-only verdict (see audit/decisions.ts). */
    private audit: DecisionAudit | null | undefined = undefined,
  ) {
    if (this.audit === undefined) this.audit = createDecisionAudit(db);
  }

  /** One action per token at a time, so a buy and a sell can't race. */
  private withLock<T>(mint: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(mint) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.locks.set(mint, next.catch(() => undefined));
    return next;
  }

  private withBuyGate<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.buyGate.then(fn, fn);
    this.buyGate = next.catch(() => undefined);
    return next;
  }

  /**
   * Lets no new trade start and waits (at most `maxMs`) for every action under way to finish, so a shutdown doesn't cut a
   * trade between its send and its record. False when some were still going at the deadline: their rows stay pending with
   * the signature, and the settle step reads them from the chain at the next start.
   */
  async stop(maxMs = 60_000): Promise<boolean> {
    this.stopping = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<boolean>((r) => (timer = setTimeout(() => r(false), maxMs)));
    try {
      return await Promise.race([Promise.allSettled([...this.locks.values(), this.buyGate]).then(() => true), late]);
    } finally {
      clearTimeout(timer);
    }
  }

  async onLeaderSwap(swap: ParsedSwap, seenAt = Date.now()): Promise<void> {
    insertSwaps(this.db, [swap]);
    this.db.prepare("UPDATE wallets SET last_activity_at = MAX(COALESCE(last_activity_at, ''), ?) WHERE address = ?").run(swap.ts, swap.wallet);
    if (swap.side === "buy") await this.withLock(swap.mint, () => this.copyBuy(swap, seenAt)).finally(() => this.audit?.close(swap));
    else await this.withLock(swap.mint, () => this.copySell(swap));
  }

  /**
   * Record and report a skipped copy.
   *   key     — what kind of skip (e.g. "balance", "late"); repeats within SKIP_QUIET_MS are held back
   *   account — the reason is GodsEye's own state (no SOL, paused, limits): the copy-log row is throttled too
   */
  private skip(swap: ParsedSwap, weight: number, symbol: string, key: string, reason: string, account = false): void {
    this.shadow?.setOutcome(swap, key.split(":")[0]);
    this.audit?.skipped(swap, key, reason);
    const now = Date.now();
    const q = this.quiet.get(key);
    const quiet = !!q && now < q.until;
    if (!account || !quiet) {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO copy_trades (leader, leader_signature, leader_ts, mint, symbol, side, mode, status, reason, weight, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'skipped', ?, ?, ?)`,
        )
        .run(swap.wallet, swap.signature, swap.ts, swap.mint, symbol, swap.side, this.executor.mode, reason, weight, nowIso());
    }
    if (quiet) {
      q!.held++;
      return;
    }
    const held = q?.held ? ` (+${q.held} similar skips in the last ${SKIP_QUIET_MS / 60_000} min)` : "";
    this.quiet.set(key, { until: now + SKIP_QUIET_MS, held: 0 });
    say("info", `Skipped copying ${short(swap.wallet)}'s ${swap.side} of ${symbol}: ${reason}${held}.`);
  }

  /** Why this token isn't a memecoin, or null if it is one (as far as names and known addresses tell). */
  private notMemecoin(mint: string, symbol: string): string | null {
    if (NON_MEMECOIN_MINTS.has(mint)) return `${symbol} isn't a memecoin`;
    if (isNonMemecoinSymbol(symbol)) return `${symbol} isn't a memecoin (bridged major / tokenized stock / staked SOL / stablecoin)`;
    return null;
  }

  /** Wallet balance, cached briefly (a busy leader can trigger many checks a second). Null when it can't be read: unknown, not empty. */
  private async walletSol(): Promise<number | null> {
    if (this.balance && Date.now() - this.balance.at < BALANCE_CACHE_MS) return this.balance.sol;
    if (!this.wallet) return 0;
    const sol = await this.balanceOf(this.wallet).catch(() => null);
    if (sol !== null) this.balance = { sol, at: Date.now() };
    return sol;
  }

  /** How much this buy may spend under GodsEye's own limits, or null (skip recorded) if it may not. Counts only
   *  positions and in-flight buys in the current mode. */
  private async roomFor(swap: ParsedSwap, weight: number, symbol: string): Promise<number | null> {
    const mode = this.executor.mode;
    if (isPaused(this.db)) return this.skip(swap, weight, symbol, "paused", "copying is paused", true), null;
    // Real money under the risk governor (./risk.ts): size, budget and the day's stop follow what the wallet holds.
    const governed = mode === "real" && !!this.wallet && config.riskGovernor;
    let lim: Limits = { copyMaxTradeSol: config.copyMaxTradeSol, copyBudgetSol: config.copyBudgetSol, copyMinTradeSol: config.copyMinTradeSol };
    if (governed) {
      const l = effectiveLimits(this.db, config, await this.walletSol());
      if (!l.ok) return this.skip(swap, weight, symbol, l.key, l.reason, true), null;
      lim = l;
    }
    const today = new Date().toISOString().slice(0, 10);
    const lossToday = (this.db.prepare("SELECT COALESCE(SUM(pnl_sol),0) s FROM positions WHERE status='closed' AND mode = ? AND closed_at >= ?").get(mode, `${today}T00:00:00.000Z`) as { s: number }).s;
    // Under the governor the fixed SOL limit stays a ceiling only when it is written in .env.
    if ((!governed || config.fixedInEnv.dailyLoss) && lossToday <= -config.dailyLossLimitSol) {
      void alert(this.db, "daily_stop", `Daily loss limit reached in ${mode} mode (${fmtSol(lossToday)} today). No new buys until tomorrow (UTC); sells and exits keep running.`, today);
      return this.skip(swap, weight, symbol, "loss-limit", `daily loss limit reached (${fmtSol(lossToday)})`, true), null;
    }
    const held = this.db
      .prepare("SELECT COUNT(*) n, COALESCE(SUM(CASE WHEN tokens_bought > 0 THEN cost_sol * token_amount / tokens_bought ELSE cost_sol END),0) c FROM positions WHERE status='open' AND mode = ?")
      .get(mode) as { n: number; c: number };
    const flying = this.db.prepare("SELECT COUNT(*) n, COALESCE(SUM(size_sol),0) c FROM copy_trades WHERE side='buy' AND status='pending' AND mode = ?").get(mode) as { n: number; c: number };
    // COPY_MAX_POSITIONS=0: no count limit; the copy budget and the wallet balance below decide how many can be open.
    if (config.maxPositions > 0 && held.n + flying.n >= config.maxPositions) return this.skip(swap, weight, symbol, "max-positions", `already at ${config.maxPositions} open positions`, true), null;

    let size = copySize(weight, lim);
    if (size > 0) {
      // optional offline quant sizing: off by default, can only reduce the size (see ./quant.ts)
      const q = applyQuantSizing(this.db, swap.wallet, size, weight, lim);
      if (q.log) {
        say("info", `${short(swap.wallet)}: ${q.log}`);
        this.audit?.check(swap, "quant-size", "pass", q.log);
      }
      size = Math.min(size, q.size);
    }
    if (size <= 0) {
      this.audit?.check(swap, "size", "fail", `weight ${(weight * 100).toFixed(1)}% gives less than the minimum trade of ${lim.copyMinTradeSol} SOL`);
      this.audit?.finish(swap, "skipped:size");
      return null;
    }
    size = Math.min(size, lim.copyBudgetSol - held.c - flying.c);
    if (size < lim.copyMinTradeSol) return this.skip(swap, weight, symbol, "budget", "copy budget fully in use", true), null;
    if (mode === "real" && this.wallet) {
      const sol = await this.walletSol();
      if (sol === null) return this.skip(swap, weight, symbol, "risk-unread", "the wallet's balance can't be read right now", true), null;
      const balance = sol - flying.c;
      if (balance - config.walletReserveSol < size) {
        return this.skip(swap, weight, symbol, "balance", `wallet has ${balance.toFixed(3)} SOL, needs ${(size + config.walletReserveSol).toFixed(3)} — send SOL to the agent's wallet to start copying`, true), null;
      }
    }
    return size;
  }

  private async copyBuy(swap: ParsedSwap, seenAt: number): Promise<void> {
    const leader = this.db.prepare("SELECT copy_weight FROM wallets WHERE address = ?").get(swap.wallet) as { copy_weight: number } | undefined;
    // QUANT_SKILL_GATE=on (default off): a 'luck' verdict from the quant job zeroes the weight
    const weight = skillGateBlocks(this.db, swap.wallet) ? 0 : (leader?.copy_weight ?? 0);
    if (weight <= 0 || swap.solAmount < config.minLeaderBuySol) return;
    this.audit?.begin(swap, seenAt, weight); // from here on this buy is a candidate and gets a row in copy_decisions
    // Never its own coin: buying it would trade on what the agent itself makes happen.
    if (swap.mint === ownCoin(this.db, config)) {
      this.audit?.check(swap, "not_own_coin", "fail", "this is the agent's own coin");
      return this.audit?.finish(swap, "ignored:own_coin");
    }
    if (this.db.prepare("SELECT 1 FROM positions WHERE status='open' AND mint = ?").get(swap.mint)) {
      this.audit?.check(swap, "not_holding", "fail", "a position in this token is already open (a second leader's buy adds nothing)");
      return this.audit?.finish(swap, "ignored:holding");
    }
    // A buy of this coin whose outcome isn't known yet may already hold it: a second one would double the position.
    if (this.db.prepare("SELECT 1 FROM copy_trades WHERE side='buy' AND status='pending' AND mint = ?").get(swap.mint)) {
      this.audit?.check(swap, "not_holding", "fail", "an earlier buy of this token is still being settled");
      return this.audit?.finish(swap, "ignored:holding");
    }
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([tokenInfo(this.db, swap.mint).catch(() => null), new Promise((r) => (timer = setTimeout(r, NAME_WAIT_MS)))]);
    clearTimeout(timer);
    const symbol = symbolOf(this.db, swap.mint);

    // 1) Memecoins only. Not worth a copy-log row; reported once per token per day.
    const notMeme = this.notMemecoin(swap.mint, symbol);
    if (notMeme) {
      const day = new Date().toISOString().slice(0, 10);
      if (this.notMemeLogged.get(swap.mint) !== day) {
        this.notMemeLogged.set(swap.mint, day);
        say("info", `Not copying ${short(swap.wallet)}'s buy of ${symbol}: ${notMeme}.`);
      }
      return this.audit?.discard(swap);
    }
    this.audit?.candidate(swap, symbol);
    this.shadow?.observe(swap, seenAt, weight, symbol); // from here on it is a copyable buy: log it and rug-screen it, whatever happens next
    noteSocialWarning(this.db, swap, seenAt); // SOCIAL_WARNING=shadow (default off): a private "would have skipped" row, and the copy goes on unchanged
    // 2) This trade: too late?
    const lateSec = (seenAt - Date.parse(swap.ts)) / 1000;
    if (lateSec > config.maxCopyDelaySeconds) return this.skip(swap, weight, symbol, "late", `seen ${Math.round(lateSec)}s after the leader traded`);
    this.audit?.check(swap, "lateness", "pass", `${Math.round(lateSec)}s after the leader traded (limit ${config.maxCopyDelaySeconds}s)`);
    // 2b) The Brain's hard gates (COPY_BRAIN_GATES, owner-approved): a pumpswap coin priced ≥ 1e-4 SOL a token, an AMM coin
    // first seen under 10 min ago. The screen gate is left to the rug check below (stricter: LP_MIN_LOCKED_PCT, fail closed).
    if (config.copyBrainGates) {
      const signal = { solAmount: swap.solAmount, priceSol: swap.priceSol, venue: swap.venue, t: Date.parse(swap.ts) };
      const ctx = { now: seenAt, firstSeenAt: firstSeenAt(this.db, swap.mint, seenAt), screen: null, minLeaderBuySol: config.minLeaderBuySol, maxLateSec: config.maxCopyDelaySeconds };
      const g = gate(signal, ctx);
      if (g) return this.skip(swap, weight, symbol, `gate:${g}`, `brain gate ${g}: ${gateReason(g, signal, ctx)}`);
      this.audit?.check(swap, "brain_gates", "pass", "no hard gate (pumpswap price, young AMM coin) fires");
    }
    // 3) GodsEye's own state (a quick look first, so the rug check isn't spent on a buy that can't happen)
    if ((await this.roomFor(swap, weight, symbol)) === null) return;
    this.audit?.check(swap, "limits", "pass", "budget, positions, daily loss, balance and pause all allow it");
    // 4) The token itself (also blocks tokens that can still be minted — most bridged tokens)
    if (config.rugCheckEnabled) {
      const look = await rugLook(this.db, swap.mint, symbol);
      this.audit?.rug(swap, look.verdict, look.why ? UNFINISHED_TEXT[look.why] : undefined);
      // Fail closed: a look that couldn't be finished is no buy, whatever it had found so far.
      if (!look.verdict) return this.skip(swap, weight, symbol, `unverified:${look.why}`, `rug check not finished: ${UNFINISHED_TEXT[look.why]}`);
      if (look.verdict.verdict !== "pass") return this.skip(swap, weight, symbol, `rug:${swap.mint}`, `rug check: ${look.verdict.blocks.join("; ")}`);
    }

    // 5) Check the limits again and reserve the buy, under the buy gate.
    const reserved = await this.withBuyGate(async () => {
      if (this.stopping) return "stopping" as const;
      const size = await this.roomFor(swap, weight, symbol);
      if (size === null) return null;
      // The pending row, its proof entry and the link between them are written in one step: a crash never leaves one without the other.
      return this.db.transaction(() => {
        const row = this.db
          .prepare(
            `INSERT OR IGNORE INTO copy_trades (leader, leader_signature, leader_ts, mint, symbol, side, mode, status, reason, weight, size_sol, created_at)
             VALUES (?, ?, ?, ?, ?, 'buy', ?, 'pending', ?, ?, ?, ?)`,
          )
          .run(swap.wallet, swap.signature, swap.ts, swap.mint, symbol, this.executor.mode, `leader bought ${swap.solAmount.toFixed(3)} SOL`, weight, size, nowIso());
        if (row.changes === 0) return null; // already handled this leader trade
        const copyId = Number(row.lastInsertRowid);
        const proof = commitProof(this.db, "copy_buy", { leader: swap.wallet, leader_signature: swap.signature, mint: swap.mint, symbol, size_sol: size, weight, mode: this.executor.mode });
        this.db.prepare("UPDATE copy_trades SET proof_id=? WHERE id=?").run(proof.id, copyId);
        return { size, copyId };
      })();
    });
    if (reserved === "stopping") {
      this.audit?.check(swap, "reserve", "fail", "the agent is stopping");
      return this.audit?.finish(swap, "ignored:stopping");
    }
    if (!reserved) {
      this.audit?.check(swap, "reserve", "fail", "this leader trade was already handled");
      return this.audit?.finish(swap, "ignored:duplicate");
    }
    const { size, copyId } = reserved;
    try {
      const fill = await this.executor.buy(swap.mint, size, this.onSigned(copyId));
      openPositionFromFill(this.db, { copyId, fill, latencyMs: Date.now() - Date.parse(swap.ts), mint: swap.mint, symbol, leader: swap.wallet, mode: this.executor.mode });
      this.shadow?.setOutcome(swap, "bought");
      this.audit?.check(swap, "execution", "pass", `${this.executor.mode} fill at ${fill.priceSol}`);
      this.audit?.finish(swap, "bought", { sizeSol: fill.solAmount });
      this.balance = null; // the wallet just spent SOL
      this.openMints = null; // the stream now prices this coin too
      say("trade", `Copied ${short(swap.wallet)}: bought ${symbol} for ${fill.solAmount.toFixed(4)} SOL (${this.executor.mode}, weight ${(weight * 100).toFixed(0)}%).`);
    } catch (e) {
      if (e instanceof RouteRefused) {
        // Refused before anything was signed: a skip, not a failed buy.
        this.db.prepare("UPDATE copy_trades SET status='skipped', reason=? WHERE id=? AND status='pending'").run(e.message, copyId);
        this.shadow?.setOutcome(swap, e.kind);
        this.audit?.check(swap, e.kind === "impact" ? "price_impact" : "route_pools", "fail", e.message);
        this.audit?.finish(swap, `skipped:${e.kind}`, { sizeSol: size });
        say("info", `Skipped copying ${short(swap.wallet)}'s buy of ${symbol}: ${e.message}.`);
        return;
      }
      if (e instanceof UnsettledError) {
        // Sent, but not seen to land or to expire. The row stays pending (its size stays reserved) and the settle step
        // reads the outcome from the chain: calling it failed here is how a buy that landed was once lost.
        this.keepPending(copyId, e);
        this.shadow?.setOutcome(swap, "unsettled");
        this.audit?.check(swap, "execution", "error", "sent, outcome not known yet");
        this.audit?.finish(swap, "unsettled", { sizeSol: size });
        this.balance = null; // it may have spent SOL
        say("warn", `Copy buy of ${symbol}: sent, but its outcome isn't known yet. Settling it from the chain.`);
        return;
      }
      this.db.prepare("UPDATE copy_trades SET status='failed', error=? WHERE id=? AND status='pending'").run((e as Error).message.slice(0, 500), copyId);
      this.shadow?.setOutcome(swap, "buy_failed");
      this.audit?.check(swap, "execution", "error", (e as Error).message.slice(0, 200));
      this.audit?.finish(swap, "buy_failed", { sizeSol: size });
      say("error", `Copy buy of ${symbol} failed: ${(e as Error).message.slice(0, 200)}`);
    }
  }

  private async copySell(swap: ParsedSwap): Promise<void> {
    const pos = this.db.prepare("SELECT * FROM positions WHERE status='open' AND mint = ? AND leader = ?").get(swap.mint, swap.wallet) as PositionRow | undefined;
    if (!pos) return;
    const fraction = swap.tokenBalanceBefore > 0 ? Math.min(1, swap.tokenAmount / swap.tokenBalanceBefore) : 1;
    const all = fraction >= 0.9;
    await this.sellPosition(pos, all ? pos.token_amount : pos.token_amount * fraction, all, `leader sold ${Math.round(fraction * 100)}%`, swap);
  }

  /** `urgent` (stop-loss, trailing stop): after a slippage failure, the next try allows more slippage (exitSlippageBps). */
  private async sellPosition(pos: PositionRow, tokens: number, all: boolean, reason: string, leaderSwap?: ParsedSwap, urgent = false): Promise<boolean> {
    const symbol = pos.symbol ?? symbolOf(this.db, pos.mint);
    const record = (status: "pending" | "failed", error: string | null) =>
      this.db
        .prepare(
          `INSERT OR IGNORE INTO copy_trades (leader, leader_signature, leader_ts, mint, symbol, side, mode, status, reason, token_amount, position_id, error, created_at)
           VALUES (?, ?, ?, ?, ?, 'sell', ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(pos.leader, leaderSwap?.signature ?? `exit:${pos.id}:${Date.now()}:${++this.exitSeq}:${reason}`, leaderSwap?.ts ?? nowIso(), pos.mint, symbol, this.executor.mode, status, reason, tokens, pos.id, error, nowIso());
    // An earlier sell of this position was sent and its outcome isn't known yet. A second one could sell twice, so
    // nothing goes out until the settle step (recovery.ts) has read the first one from the chain.
    if (this.db.prepare("SELECT 1 FROM copy_trades WHERE position_id=? AND side='sell' AND status='pending' AND signature IS NOT NULL").get(pos.id)) {
      if (leaderSwap) record("failed", "not sent: an earlier sell of this position is still being settled"); // a leader's sell comes once: keep it on record
      this.holdOff(pos.id, UNSETTLED_WAIT_MS);
      return false;
    }
    if (this.stopping) {
      if (leaderSwap) record("failed", "not sent: the agent was stopping"); // a leader's sell comes once: keep it on record
      return false;
    }
    // The pending row, its proof entry and the link between them, in one step.
    const copyId = this.db.transaction(() => {
      const row = record("pending", null);
      if (row.changes === 0) return null; // already handled this leader trade
      const id = Number(row.lastInsertRowid);
      const proof = commitProof(this.db, "copy_sell", { position_id: pos.id, mint: pos.mint, symbol, tokens, all, reason, mode: this.executor.mode });
      this.db.prepare("UPDATE copy_trades SET proof_id=? WHERE id=?").run(proof.id, id);
      return id;
    })();
    if (copyId === null) return false;
    try {
      const slip = this.sellFailures.get(pos.id)?.slip ?? 0;
      const fill = await this.executor.sell(pos.mint, tokens, all, urgent ? exitSlippageBps(slip) : config.slippageBps, this.onSigned(copyId));
      // Writes the position, the close and the trade's row in one step, and says the "Sold" / "Closed" line (fills.ts).
      const result = applySellFill(this.db, pos.id, { copyId, fill, latencyMs: leaderSwap ? Date.now() - Date.parse(leaderSwap.ts) : null, all, reason });
      if (result === "closed") this.openMints = null;
      this.sellFailures.delete(pos.id);
      return result !== "stale";
    } catch (e) {
      const message = (e as Error).message;
      if (e instanceof UnsettledError) {
        // Sent, but not seen to land or to expire. The row stays pending and the settle step reads the outcome from the
        // chain; until then no other sell of this position goes out (the check above). Not counted as a failed sell.
        this.keepPending(copyId, e);
        this.holdOff(pos.id, UNSETTLED_WAIT_MS);
        say("warn", `Selling ${symbol} (${reason}): sent, but its outcome isn't known yet. Settling it from the chain.`);
        return false;
      }
      this.db.prepare("UPDATE copy_trades SET status='failed', error=? WHERE id=? AND status='pending'").run(message.slice(0, 500), copyId);
      const f = this.sellFailures.get(pos.id) ?? { count: 0, slip: 0, until: 0 };
      f.count++;
      if (SLIPPAGE_ERROR.test(message)) f.slip++; // a rate limit or an expired blockhash isn't a price problem
      f.until = Date.now() + sellRetryMs(f.count);
      this.sellFailures.set(pos.id, f);
      if (e instanceof NothingHeldError) {
        // An earlier sell landed without being recorded, or the tokens left the wallet some other way. Selling again
        // can't work: the missing-position check (recovery.ts) finds that sell on chain and closes the position.
        say("warn", `Selling ${symbol} (${reason}): the wallet holds none of it. Looking for its sell on chain.`);
        return false;
      }
      say("error", `Selling ${symbol} failed (${reason}): ${message.slice(0, 200)}. Retrying later.`);
      return false;
    }
  }

  /**
   * Given to the executor with each trade: it is called once the swap is signed, before it is sent, and puts the
   * signature (and the last block height it can land at) on the trade's row. Whatever happens next, the trade can be
   * settled from the chain. If this write fails, the swap is not sent.
   */
  private onSigned(copyId: number): OnSigned {
    return (signature, lastValidBlockHeight) => {
      this.db.prepare("UPDATE copy_trades SET signature=?, last_valid_height=? WHERE id=?").run(signature, lastValidBlockHeight, copyId);
    };
  }

  /** The engine lets go of a trade whose outcome it doesn't know: the row stays pending, with why, for the settle step. */
  private keepPending(copyId: number, e: UnsettledError): void {
    this.db
      .prepare("UPDATE copy_trades SET error=?, signature=COALESCE(signature, ?), last_valid_height=COALESCE(last_valid_height, ?) WHERE id=? AND status='pending'")
      .run(e.message.slice(0, 500), e.signature, e.lastValidBlockHeight, copyId);
  }

  /** No exit check sells this position for `ms` from now. Unlike a failed sell, it doesn't count toward the retry wait. */
  private holdOff(posId: number, ms: number): void {
    const f = this.sellFailures.get(posId) ?? { count: 0, slip: 0, until: 0 };
    f.until = Math.max(f.until, Date.now() + ms);
    this.sellFailures.set(posId, f);
  }

  /** Sell every open position now (`npm run close-all`), each with up to `tries` attempts at the stop-loss's widening slippage. */
  async closeAll(reason: string, tries = 3, waitMs = 3000): Promise<{ closed: number; left: number }> {
    const open = this.db.prepare("SELECT * FROM positions WHERE status='open' AND mode = ?").all(this.executor.mode) as PositionRow[];
    let closed = 0;
    for (const { id } of open) {
      for (let i = 0; i < tries; i++) {
        const pos = this.db.prepare("SELECT * FROM positions WHERE id = ? AND status='open'").get(id) as PositionRow | undefined;
        if (!pos) break;
        if (await this.withLock(pos.mint, () => this.sellPosition(pos, pos.token_amount, true, reason, undefined, true))) {
          closed++;
          break;
        }
        if (i < tries - 1) await new Promise((r) => setTimeout(r, waitMs));
      }
    }
    return { closed, left: open.length - closed };
  }

  /** Mints of the open positions, so the stream can ignore every other coin at once. Refreshed every 30 s and on each open/close. */
  private openMintSet(): Set<string> {
    if (!this.openMints || Date.now() - this.openMints.at > OPEN_MINTS_TTL_MS) {
      const rows = this.db.prepare("SELECT mint FROM positions WHERE status='open' AND mode = ?").all(this.executor.mode) as { mint: string }[];
      this.openMints = { set: new Set(rows.map((r) => r.mint)), at: Date.now() };
    }
    return this.openMints.set;
  }

  /** A settle step (recovery.ts) opened or closed a position outside the engine: forget what was cached about them. */
  positionsChanged(): void {
    this.openMints = null;
    this.balance = null;
  }

  /**
   * A swap of any wallet on the live stream. For a coin GodsEye holds, its price is the coin's price this second: the same
   * exit check as the minute job runs on it (at most every STREAM_CHECK_MS per coin), so a stop-loss fires seconds after
   * the price crosses it, not up to a minute later. The stream doesn't wait for it; the promise (never rejected) is for tests.
   */
  onMarketSwap(swap: ParsedSwap): Promise<void> | undefined {
    if (!(swap.priceSol > 0) || !this.openMintSet().has(swap.mint)) return;
    const now = Date.now();
    if (now < (this.nextStreamCheck.get(swap.mint) ?? 0)) return;
    this.nextStreamCheck.set(swap.mint, now + STREAM_CHECK_MS);
    const pos = this.db.prepare("SELECT * FROM positions WHERE status='open' AND mode = ? AND mint = ?").get(this.executor.mode, swap.mint) as PositionRow | undefined;
    if (!pos) return;
    return this.checkExit(pos, swap.priceSol, currentExits(this.db, config), "stream").catch((e: Error) => say("error", `Exit check for ${pos.symbol ?? short(pos.mint)} failed: ${e.message}`));
  }

  /** Every minute: price open positions, exit on stop-loss / take-profit / max hold, refresh the wallet balance. */
  async managePositions(): Promise<void> {
    const open = this.db.prepare("SELECT * FROM positions WHERE status='open' AND mode = ?").all(this.executor.mode) as PositionRow[];
    if (this.executor.mode === "real" && this.wallet) {
      const bal = await this.balanceOf(this.wallet).catch(() => null);
      if (bal !== null) {
        setMeta(this.db, "wallet_balance_sol", bal);
        setMeta(this.db, "wallet_balance_checked_at", nowIso());
        if (getMeta(this.db, "starting_balance_sol") === null && bal > 0) {
          setMeta(this.db, "starting_balance_sol", bal);
          const usd = usdOf(bal);
          if (usd) setMeta(this.db, "starting_balance_usd", usd);
        }
      }
    }
    if (!open.length) return;
    const prices = await getPrices([SOL_MINT, ...open.map((p) => p.mint)]).catch(() => new Map());
    const solUsd = prices.get(SOL_MINT)?.priceUsd;
    // Learned by the exit tuner (learning/exits.ts), or COPY_STOP_LOSS_PCT / COPY_TAKE_PROFIT_PCT.
    const exits = currentExits(this.db, config);
    for (const pos of open) {
      const usd = prices.get(pos.mint)?.priceUsd;
      if (usd && solUsd) {
        await this.checkExit(pos, usd / solUsd, exits, "feed");
        continue;
      }
      // No price: a rugged coin leaves the price API and, its pool drained, the stream too. Left alone, it was never
      // checked again and went to zero untouched (BvGQ, 7 h). Unless the stream priced it lately, a sell quote is its price.
      if (pos.last_price_ts && Date.now() - Date.parse(pos.last_price_ts) < UNPRICED_AFTER_MS) continue;
      const got = this.executor.quoteSellSol && pos.token_amount > 0 ? await this.executor.quoteSellSol(pos.mint, pos.token_amount).catch(() => null) : null;
      if (got !== null) {
        await this.checkExit(pos, got / pos.token_amount, exits, "quote");
        continue;
      }
      const key = `unpriced:${pos.id}`;
      const q = this.quiet.get(key);
      if (!q || Date.now() >= q.until) {
        this.quiet.set(key, { until: Date.now() + SKIP_QUIET_MS, held: 0 });
        say("warn", `Can't price ${pos.symbol ?? short(pos.mint)}: no price and no sell route (rugged or no liquidity). Can't check its stop-loss.`);
      }
    }
  }

  /**
   * One position at one price (SOL per token): stop-loss, trailing stop, take-profit, the ladder's first sale, or max hold.
   * The same rule for the minute job (price API, or a sell quote for a coin it has no price for) and the live stream.
   * A price exit is confirmed by a sell quote first.
   */
  private async checkExit(pos: PositionRow, price: number, exits: Exits, source: "feed" | "stream" | "quote"): Promise<void> {
    if (!(pos.tokens_bought > 0) || !Number.isFinite(price) || price <= 0) return;
    if (this.checking.has(pos.id)) return; // a check of this position (and its sell) is already under way
    this.checking.add(pos.id);
    try {
      this.db.prepare("UPDATE positions SET last_price_sol=?, last_price_ts=? WHERE id=?").run(price, nowIso(), pos.id);
      const heldCost = pos.cost_sol * (pos.token_amount / pos.tokens_bought);
      const pct = heldCost > 0 ? ((pos.token_amount * price - heldCost) / heldCost) * 100 : 0;
      const ageH = (Date.now() - Date.parse(pos.opened_at)) / 3_600_000;
      const peak = Math.max(pos.peak_pct ?? 0, pct);
      if (peak > (pos.peak_pct ?? 0)) this.db.prepare("UPDATE positions SET peak_pct=? WHERE id=?").run(peak, pos.id);
      // Which exit fires at a given return (the learned rule, learning/exits.ts): checked on the price, then on a quote.
      const exitAt = (p: number): "stop" | "trail" | "take" | "ladder" | null =>
        p <= -exits.stopLossPct ? "stop"
        : exits.trailStopPct > 0 && peak >= exits.trailArmPct && 1 + p / 100 <= (1 + peak / 100) * (1 - exits.trailStopPct / 100) ? "trail"
        : p >= exits.takeProfitPct ? "take"
        : exits.partialTpPct > 0 && !pos.partial_done && p >= exits.partialTpPct ? "ladder"
        : null;
      const label = { stop: "stop-loss", trail: `trailing stop (${exits.trailStopPct}% below its best, +${peak.toFixed(0)}%)`, take: "take-profit", ladder: `took ${Math.round(exits.partialFraction * 100)}% off` };
      let kind = exitAt(pct);
      let reason: string | null = kind ? `${label[kind]} at ${fmtPct(pct)}${source === "stream" ? " (stream)" : ""}` : ageH >= config.maxHoldHours ? `held ${config.maxHoldHours}h without the leader selling` : null;
      if (!reason) return;
      const backoff = this.sellFailures.get(pos.id);
      if (backoff && Date.now() < backoff.until) return;
      // The price can be wrong for a thin coin (a winner once read as −52% and was sold at +48%; one swap on the stream can
      // print far off the pool): before a price exit, ask what a sell would really get. No quote = trust the price (a stop
      // must not wait on a missing route).
      if (kind && this.executor.quoteSellSol) {
        const got = await this.executor.quoteSellSol(pos.mint, pos.token_amount).catch(() => null);
        if (got !== null && heldCost > 0) {
          const real = ((got - heldCost) / heldCost) * 100;
          const confirmed = exitAt(real);
          if (!confirmed) {
            // Don't ask for a quote on every swap while the stream and the quote disagree.
            this.nextStreamCheck.set(pos.mint, Date.now() + UNCONFIRMED_HOLD_MS);
            const key = `confirm:${pos.id}`;
            const q = this.quiet.get(key);
            if (!q || Date.now() >= q.until) {
              this.quiet.set(key, { until: Date.now() + SKIP_QUIET_MS, held: 0 });
              say("info", `Not acting on ${label[kind]} for ${pos.symbol ?? short(pos.mint)}: the ${source === "stream" ? "last swap" : "price feed"} says ${fmtPct(pct)}, but a sell quote gives ${fmtPct(real)}.`);
            }
            return;
          }
          kind = confirmed;
          reason = `${label[kind]} at ${fmtPct(real)} (sell quote${source === "stream" ? ", stream" : ""})`;
        }
      }
      const part = kind === "ladder";
      // A falling coin: a stop that failed on slippage is sent again with more room (exitSlippageBps).
      const urgent = kind === "stop" || kind === "trail";
      await this.withLock(pos.mint, async () => {
        const fresh = this.db.prepare("SELECT * FROM positions WHERE id=? AND status='open'").get(pos.id) as PositionRow | undefined;
        if (!fresh || (part && fresh.partial_done)) return;
        const sold = await this.sellPosition(fresh, part ? fresh.token_amount * exits.partialFraction : fresh.token_amount, !part, reason!, undefined, urgent);
        if (sold && part) this.db.prepare("UPDATE positions SET partial_done=1 WHERE id=?").run(pos.id);
      });
    } finally {
      this.checking.delete(pos.id);
    }
  }
}

/**
 * When GodsEye first saw this coin, as of `now` (epoch ms; null = never): the Brain's first sighting
 * (brain_token_first_seen), else the first swap stored of it by insert time (wallet_swaps.ins_ms ≤ now; a row from before
 * ins_ms counts at its block time). A backfilled old swap stored just now counts as now: young_amm is about what the
 * server had seen, not when the coin launched.
 */
export function firstSeenAt(db: DB, mint: string, now: number): number | null {
  let best = Infinity;
  try {
    const row = db.prepare("SELECT first_seen_at FROM brain_token_first_seen WHERE mint = ?").get(mint) as { first_seen_at: string } | undefined;
    if (row) best = Math.min(best, Date.parse(row.first_seen_at));
  } catch {
    // no Brain tables in this database
  }
  const ins = db.prepare("SELECT MIN(ins_ms) v FROM wallet_swaps WHERE mint = ? AND ins_ms IS NOT NULL AND ins_ms <= ?").get(mint, now) as { v: number | null };
  if (ins.v !== null) best = Math.min(best, ins.v);
  const old = db.prepare("SELECT MIN(ts) v FROM wallet_swaps WHERE mint = ? AND ins_ms IS NULL").get(mint) as { v: string | null };
  if (old.v) best = Math.min(best, Date.parse(old.v));
  return Number.isFinite(best) && best <= now ? best : null;
}
