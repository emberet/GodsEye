/**
 * THE COPY ENGINE — reacts to a leader's swap.
 *
 * Leader buys  → GodsEye buys too, sized by the leader's weight from the
 *                learning loop, after every safety check passes.
 * Leader sells → GodsEye sells the same share of its position (sold 50% → GodsEye sells 50%).
 * Every minute → GodsEye marks its positions to market and exits on its own
 *                stop-loss / take-profit / max-hold, in case a leader never sells
 *                (or moves its tokens to another wallet).
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
 * Limits (budget, open positions, daily loss) count only positions in the current mode, and buys still
 * in flight count against the budget: the final check and the reservation of a buy happen under one
 * lock, so two leader buys of different tokens can't both spend the same room.
 */
import fs from "node:fs";
import { commitProof, dataPath, type DB, getMeta, isNonMemecoinSymbol, NON_MEMECOIN_MINTS, nowIso, setMeta, SOL_MINT } from "@godseye/shared";
import { config } from "../config";
import { fmtPct, fmtSol, say, short } from "../log";
import type { ParsedSwap } from "../chain/parse";
import { insertSwaps } from "../analysis/analyze";
import { copySize } from "../learning/weights";
import { rugCheck } from "../market/rugcheck";
import { getPrices } from "../market/prices";
import { symbolOf, tokenInfo } from "../market/tokens";
import { walletBalanceSol } from "../wallet/wallet";
import { solUsdAt } from "../market/solprice";
import type { Executor } from "./executor";
import type { PublicKey } from "@solana/web3.js";

interface PositionRow {
  id: number;
  mint: string;
  symbol: string | null;
  leader: string;
  token_amount: number;
  tokens_bought: number;
  cost_sol: number;
  proceeds_sol: number;
  cost_usd: number | null;
  proceeds_usd: number;
  /** Network fees, tips and token-account rent paid so far (SOL); null = not recorded (paper, or opened before fees were tracked). */
  fee_sol: number | null;
  entry_price_sol: number;
  last_price_sol: number | null;
  opened_at: string;
}

/** SOL → USD at this moment (null if the price is unknown). */
const usdOf = (sol: number): number | null => {
  const p = solUsdAt(Date.now());
  return p ? sol * p : null;
};

/** How long a repeated skip message stays quiet. */
const SKIP_QUIET_MS = 10 * 60_000;
const BALANCE_CACHE_MS = 20_000;

export function isPaused(db: DB): boolean {
  return getMeta(db, "copy_paused") === "1" || fs.existsSync(dataPath("PAUSE"));
}

export class CopyEngine {
  private locks = new Map<string, Promise<unknown>>();
  /** Serialises the last limit check + reservation of every buy (see the note at the top). */
  private buyGate: Promise<unknown> = Promise.resolve();
  private sellFailures = new Map<number, { count: number; until: number }>();
  /** Throttle for repeated skip messages: key → when it may be shown again, and how many were held back. */
  private quiet = new Map<string, { until: number; held: number }>();
  private balance: { sol: number; at: number } | null = null;
  /** Tokens already reported as not-memecoins today. */
  private notMemeLogged = new Map<string, string>();

  constructor(
    private db: DB,
    private executor: Executor,
    private wallet: PublicKey | null,
  ) {}

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

  async onLeaderSwap(swap: ParsedSwap, seenAt = Date.now()): Promise<void> {
    insertSwaps(this.db, [swap]);
    this.db.prepare("UPDATE wallets SET last_activity_at = MAX(COALESCE(last_activity_at, ''), ?) WHERE address = ?").run(swap.ts, swap.wallet);
    if (swap.side === "buy") await this.withLock(swap.mint, () => this.copyBuy(swap, seenAt));
    else await this.withLock(swap.mint, () => this.copySell(swap));
  }

  /**
   * Record and report a skipped copy.
   *   key     — what kind of skip (e.g. "balance", "late"); repeats within SKIP_QUIET_MS are held back
   *   account — the reason is GodsEye's own state (no SOL, paused, limits): the copy-log row is throttled too
   */
  private skip(swap: ParsedSwap, weight: number, symbol: string, key: string, reason: string, account = false): void {
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

  /** Wallet balance, cached briefly (a busy leader can trigger many checks a second). */
  private async walletSol(): Promise<number> {
    if (this.balance && Date.now() - this.balance.at < BALANCE_CACHE_MS) return this.balance.sol;
    const sol = this.wallet ? await walletBalanceSol(this.wallet).catch(() => 0) : 0;
    this.balance = { sol, at: Date.now() };
    return sol;
  }

  /** How much this buy may spend under GodsEye's own limits, or null (skip recorded) if it may not. Counts only
   *  positions and in-flight buys in the current mode. */
  private async roomFor(swap: ParsedSwap, weight: number, symbol: string): Promise<number | null> {
    const mode = this.executor.mode;
    if (isPaused(this.db)) return this.skip(swap, weight, symbol, "paused", "copying is paused", true), null;
    const today = new Date().toISOString().slice(0, 10);
    const lossToday = (this.db.prepare("SELECT COALESCE(SUM(pnl_sol),0) s FROM positions WHERE status='closed' AND mode = ? AND closed_at >= ?").get(mode, `${today}T00:00:00.000Z`) as { s: number }).s;
    if (lossToday <= -config.dailyLossLimitSol) return this.skip(swap, weight, symbol, "loss-limit", `daily loss limit reached (${fmtSol(lossToday)})`, true), null;
    const held = this.db
      .prepare("SELECT COUNT(*) n, COALESCE(SUM(CASE WHEN tokens_bought > 0 THEN cost_sol * token_amount / tokens_bought ELSE cost_sol END),0) c FROM positions WHERE status='open' AND mode = ?")
      .get(mode) as { n: number; c: number };
    const flying = this.db.prepare("SELECT COUNT(*) n, COALESCE(SUM(size_sol),0) c FROM copy_trades WHERE side='buy' AND status='pending' AND mode = ?").get(mode) as { n: number; c: number };
    if (held.n + flying.n >= config.maxPositions) return this.skip(swap, weight, symbol, "max-positions", `already at ${config.maxPositions} open positions`, true), null;

    let size = copySize(weight, config);
    if (size <= 0) return null;
    size = Math.min(size, config.copyBudgetSol - held.c - flying.c);
    if (size < config.copyMinTradeSol) return this.skip(swap, weight, symbol, "budget", "copy budget fully in use", true), null;
    if (mode === "real" && this.wallet) {
      const balance = (await this.walletSol()) - flying.c;
      if (balance - config.walletReserveSol < size) {
        return this.skip(swap, weight, symbol, "balance", `wallet has ${balance.toFixed(3)} SOL, needs ${(size + config.walletReserveSol).toFixed(3)} — send SOL to ${short(this.wallet.toBase58())} to start copying`, true), null;
      }
    }
    return size;
  }

  private async copyBuy(swap: ParsedSwap, seenAt: number): Promise<void> {
    const leader = this.db.prepare("SELECT copy_weight FROM wallets WHERE address = ?").get(swap.wallet) as { copy_weight: number } | undefined;
    const weight = leader?.copy_weight ?? 0;
    if (weight <= 0 || swap.solAmount < config.minLeaderBuySol) return;
    if (this.db.prepare("SELECT 1 FROM positions WHERE status='open' AND mint = ?").get(swap.mint)) return;
    await tokenInfo(this.db, swap.mint).catch(() => null);
    const symbol = symbolOf(this.db, swap.mint);

    // 1) Memecoins only. Not worth a copy-log row; reported once per token per day.
    const notMeme = this.notMemecoin(swap.mint, symbol);
    if (notMeme) {
      const day = new Date().toISOString().slice(0, 10);
      if (this.notMemeLogged.get(swap.mint) !== day) {
        this.notMemeLogged.set(swap.mint, day);
        say("info", `Not copying ${short(swap.wallet)}'s buy of ${symbol}: ${notMeme}.`);
      }
      return;
    }
    // 2) This trade: too late?
    const lateSec = (seenAt - Date.parse(swap.ts)) / 1000;
    if (lateSec > config.maxCopyDelaySeconds) return this.skip(swap, weight, symbol, "late", `seen ${Math.round(lateSec)}s after the leader traded`);
    // 3) GodsEye's own state (a quick look first, so the rug check isn't spent on a buy that can't happen)
    if ((await this.roomFor(swap, weight, symbol)) === null) return;
    // 4) The token itself (also blocks tokens that can still be minted — most bridged tokens)
    if (config.rugCheckEnabled) {
      const v = await rugCheck(this.db, swap.mint, symbol);
      if (!v) return this.skip(swap, weight, symbol, "unverified", "couldn't verify the token on Solana");
      if (v.verdict === "blocked") return this.skip(swap, weight, symbol, `rug:${swap.mint}`, `rug check: ${v.blocks.join("; ")}`);
    }

    // 5) Check the limits again and reserve the buy, under the buy gate.
    const reserved = await this.withBuyGate(async () => {
      const size = await this.roomFor(swap, weight, symbol);
      if (size === null) return null;
      const row = this.db
        .prepare(
          `INSERT OR IGNORE INTO copy_trades (leader, leader_signature, leader_ts, mint, symbol, side, mode, status, reason, weight, size_sol, created_at)
           VALUES (?, ?, ?, ?, ?, 'buy', ?, 'pending', ?, ?, ?, ?)`,
        )
        .run(swap.wallet, swap.signature, swap.ts, swap.mint, symbol, this.executor.mode, `leader bought ${swap.solAmount.toFixed(3)} SOL`, weight, size, nowIso());
      return row.changes === 0 ? null : { size, copyId: Number(row.lastInsertRowid) }; // 0 = already handled this leader trade
    });
    if (!reserved) return;
    const { size, copyId } = reserved;
    const proof = commitProof(this.db, "copy_buy", { leader: swap.wallet, leader_signature: swap.signature, mint: swap.mint, symbol, size_sol: size, weight, mode: this.executor.mode });
    this.db.prepare("UPDATE copy_trades SET proof_id=? WHERE id=?").run(proof.id, copyId);
    try {
      const fill = await this.executor.buy(swap.mint, size);
      const pos = this.db
        .prepare(
          `INSERT INTO positions (mint, symbol, leader, mode, status, token_amount, tokens_bought, cost_sol, cost_usd, fee_sol, entry_price_sol, last_price_sol, last_price_ts, opened_at, leader_win_rate)
           VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT win_rate_30d FROM wallet_stats WHERE wallet = ?))`,
        )
        .run(swap.mint, symbol, swap.wallet, this.executor.mode, fill.tokenAmount, fill.tokenAmount, fill.solAmount, usdOf(fill.solAmount), fill.feeSol ?? null, fill.priceSol, fill.priceSol, nowIso(), nowIso(), swap.wallet);
      this.db
        .prepare("UPDATE copy_trades SET status='filled', size_sol=?, token_amount=?, price_sol=?, fee_sol=?, signature=?, position_id=?, latency_ms=?, filled_at=? WHERE id=?")
        .run(fill.solAmount, fill.tokenAmount, fill.priceSol, fill.feeSol ?? null, fill.signature, Number(pos.lastInsertRowid), Date.now() - Date.parse(swap.ts), nowIso(), copyId);
      this.balance = null; // the wallet just spent SOL
      say("trade", `Copied ${short(swap.wallet)}: bought ${symbol} for ${fill.solAmount.toFixed(4)} SOL (${this.executor.mode}, weight ${(weight * 100).toFixed(0)}%).`);
    } catch (e) {
      this.db.prepare("UPDATE copy_trades SET status='failed', error=? WHERE id=?").run((e as Error).message.slice(0, 500), copyId);
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

  private async sellPosition(pos: PositionRow, tokens: number, all: boolean, reason: string, leaderSwap?: ParsedSwap): Promise<boolean> {
    const symbol = pos.symbol ?? symbolOf(this.db, pos.mint);
    const row = this.db
      .prepare(
        `INSERT OR IGNORE INTO copy_trades (leader, leader_signature, leader_ts, mint, symbol, side, mode, status, reason, token_amount, position_id, created_at)
         VALUES (?, ?, ?, ?, ?, 'sell', ?, 'pending', ?, ?, ?, ?)`,
      )
      .run(pos.leader, leaderSwap?.signature ?? `exit:${pos.id}:${Date.now()}`, leaderSwap?.ts ?? nowIso(), pos.mint, symbol, this.executor.mode, reason, tokens, pos.id, nowIso());
    if (row.changes === 0) return false; // already handled this leader trade
    const copyId = Number(row.lastInsertRowid);
    const proof = commitProof(this.db, "copy_sell", { position_id: pos.id, mint: pos.mint, symbol, tokens, all, reason, mode: this.executor.mode });
    this.db.prepare("UPDATE copy_trades SET proof_id=? WHERE id=?").run(proof.id, copyId);
    try {
      const fill = await this.executor.sell(pos.mint, tokens, all);
      const remaining = all ? 0 : Math.max(0, pos.token_amount - fill.tokenAmount);
      const proceeds = pos.proceeds_sol + fill.solAmount;
      const fillUsd = usdOf(fill.solAmount);
      const proceedsUsd = pos.proceeds_usd + (fillUsd ?? 0);
      const usdKnown = pos.cost_usd !== null && fillUsd !== null;
      const closed = remaining <= pos.tokens_bought * 0.01;
      // Fees stay "not recorded" for a position whose buy fee wasn't recorded (never half-counted).
      const fees = pos.fee_sol === null ? null : pos.fee_sol + (fill.feeSol ?? 0);
      this.db.prepare("UPDATE positions SET token_amount=?, proceeds_sol=?, proceeds_usd=?, cost_usd=?, fee_sol=?, last_price_sol=?, last_price_ts=? WHERE id=?")
        .run(remaining, proceeds, proceedsUsd, usdKnown ? pos.cost_usd : null, fees, fill.priceSol, nowIso(), pos.id);
      if (closed) {
        const feeUsd = fees === null ? 0 : (usdOf(fees) ?? null);
        const pnl = proceeds - pos.cost_sol - (fees ?? 0);
        const pnlUsd = usdKnown && feeUsd !== null ? proceedsUsd - (pos.cost_usd as number) - feeUsd : null;
        // % return in USD when known (SOL's own price move between entry and exit isn't trading profit).
        const pct = pnlUsd !== null && pos.cost_usd ? (pnlUsd / pos.cost_usd) * 100 : pos.cost_sol > 0 ? (pnl / pos.cost_sol) * 100 : 0;
        this.db.prepare("UPDATE positions SET status='closed', token_amount=0, closed_at=?, exit_reason=?, pnl_sol=?, pnl_usd=?, pnl_pct=? WHERE id=?").run(nowIso(), reason, pnl, pnlUsd, pct, pos.id);
        const shown = pnlUsd !== null ? `${pnlUsd >= 0 ? "+" : "−"}$${Math.abs(pnlUsd).toFixed(2)} (${fmtSol(pnl)})` : fmtSol(pnl);
        say(pnl >= 0 ? "win" : "loss", `Closed ${symbol} (copied from ${short(pos.leader)}): ${shown} (${fmtPct(pct)}) — ${reason}.`);
      } else {
        say("trade", `Sold ${fill.tokenAmount.toPrecision(4)} ${symbol} for ${fill.solAmount.toFixed(4)} SOL — ${reason}.`);
      }
      this.db
        .prepare("UPDATE copy_trades SET status='filled', size_sol=?, token_amount=?, price_sol=?, fee_sol=?, signature=?, latency_ms=?, filled_at=? WHERE id=?")
        .run(fill.solAmount, fill.tokenAmount, fill.priceSol, fill.feeSol ?? null, fill.signature, leaderSwap ? Date.now() - Date.parse(leaderSwap.ts) : null, nowIso(), copyId);
      this.sellFailures.delete(pos.id);
      return true;
    } catch (e) {
      this.db.prepare("UPDATE copy_trades SET status='failed', error=? WHERE id=?").run((e as Error).message.slice(0, 500), copyId);
      const f = this.sellFailures.get(pos.id) ?? { count: 0, until: 0 };
      f.count++;
      f.until = Date.now() + Math.min(60, 2 ** f.count) * 60_000; // back off: 2, 4, 8 … up to 60 min
      this.sellFailures.set(pos.id, f);
      say("error", `Selling ${symbol} failed (${reason}): ${(e as Error).message.slice(0, 200)}. Retrying later.`);
      return false;
    }
  }

  /** Every minute: price open positions, exit on stop-loss / take-profit / max hold, refresh the wallet balance. */
  async managePositions(): Promise<void> {
    const open = this.db.prepare("SELECT * FROM positions WHERE status='open' AND mode = ?").all(this.executor.mode) as PositionRow[];
    if (this.executor.mode === "real" && this.wallet) {
      const bal = await walletBalanceSol(this.wallet).catch(() => null);
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
    if (!solUsd) return;
    for (const pos of open) {
      const usd = prices.get(pos.mint)?.priceUsd;
      if (!usd || !(pos.tokens_bought > 0)) continue;
      const price = usd / solUsd;
      if (!Number.isFinite(price) || price <= 0) continue;
      this.db.prepare("UPDATE positions SET last_price_sol=?, last_price_ts=? WHERE id=?").run(price, nowIso(), pos.id);
      const heldCost = pos.cost_sol * (pos.token_amount / pos.tokens_bought);
      const pct = heldCost > 0 ? ((pos.token_amount * price - heldCost) / heldCost) * 100 : 0;
      const ageH = (Date.now() - Date.parse(pos.opened_at)) / 3_600_000;
      let reason: string | null = null;
      if (pct <= -config.stopLossPct) reason = `stop-loss at ${fmtPct(pct)}`;
      else if (pct >= config.takeProfitPct) reason = `take-profit at ${fmtPct(pct)}`;
      else if (ageH >= config.maxHoldHours) reason = `held ${config.maxHoldHours}h without the leader selling`;
      if (!reason) continue;
      const backoff = this.sellFailures.get(pos.id);
      if (backoff && Date.now() < backoff.until) continue;
      await this.withLock(pos.mint, async () => {
        const fresh = this.db.prepare("SELECT * FROM positions WHERE id=? AND status='open'").get(pos.id) as PositionRow | undefined;
        if (fresh) await this.sellPosition(fresh, fresh.token_amount, true, reason!);
      });
    }
  }
}
