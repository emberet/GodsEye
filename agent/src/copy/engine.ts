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
 *   paused (`npm run pause`, or a file named data/PAUSE) · daily loss limit hit ·
 *   max open positions · already holding the token · copy budget used up ·
 *   wallet balance below size + reserve · token fails the rug check ·
 *   the leader's trade was seen too late (price has moved on)
 * Every decision is written to the proof ledger before it's executed.
 */
import fs from "node:fs";
import { commitProof, dataPath, type DB, getMeta, nowIso, setMeta, SOL_MINT } from "@godseye/shared";
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
  entry_price_sol: number;
  last_price_sol: number | null;
  opened_at: string;
}

/** SOL → USD at this moment (null if the price is unknown). */
const usdOf = (sol: number): number | null => {
  const p = solUsdAt(Date.now());
  return p ? sol * p : null;
};

export function isPaused(db: DB): boolean {
  return getMeta(db, "copy_paused") === "1" || fs.existsSync(dataPath("PAUSE"));
}

export class CopyEngine {
  private locks = new Map<string, Promise<unknown>>();
  private sellFailures = new Map<number, { count: number; until: number }>();

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

  async onLeaderSwap(swap: ParsedSwap, seenAt = Date.now()): Promise<void> {
    insertSwaps(this.db, [swap]);
    this.db.prepare("UPDATE wallets SET last_activity_at = MAX(COALESCE(last_activity_at, ''), ?) WHERE address = ?").run(swap.ts, swap.wallet);
    if (swap.side === "buy") await this.withLock(swap.mint, () => this.copyBuy(swap, seenAt));
    else await this.withLock(swap.mint, () => this.copySell(swap));
  }

  private skip(swap: ParsedSwap, weight: number, reason: string, symbol: string): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO copy_trades (leader, leader_signature, leader_ts, mint, symbol, side, mode, status, reason, weight, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'skipped', ?, ?, ?)`,
      )
      .run(swap.wallet, swap.signature, swap.ts, swap.mint, symbol, swap.side, this.executor.mode, reason, weight, nowIso());
    say("info", `Skipped copying ${short(swap.wallet)}'s ${swap.side} of ${symbol}: ${reason}.`);
  }

  private async copyBuy(swap: ParsedSwap, seenAt: number): Promise<void> {
    const leader = this.db.prepare("SELECT copy_weight FROM wallets WHERE address = ?").get(swap.wallet) as { copy_weight: number } | undefined;
    const weight = leader?.copy_weight ?? 0;
    if (weight <= 0 || swap.solAmount < config.minLeaderBuySol) return;
    if (this.db.prepare("SELECT 1 FROM positions WHERE status='open' AND mint = ?").get(swap.mint)) return;
    await tokenInfo(this.db, swap.mint).catch(() => null);
    const symbol = symbolOf(this.db, swap.mint);

    const lateSec = (seenAt - Date.parse(swap.ts)) / 1000;
    if (lateSec > config.maxCopyDelaySeconds) return this.skip(swap, weight, `seen ${Math.round(lateSec)}s after the leader traded`, symbol);
    if (isPaused(this.db)) return this.skip(swap, weight, "copying is paused", symbol);
    const today = new Date().toISOString().slice(0, 10);
    const lossToday = (this.db.prepare("SELECT COALESCE(SUM(pnl_sol),0) s FROM positions WHERE status='closed' AND closed_at >= ?").get(`${today}T00:00:00.000Z`) as { s: number }).s;
    if (lossToday <= -config.dailyLossLimitSol) return this.skip(swap, weight, `daily loss limit reached (${fmtSol(lossToday)})`, symbol);
    const open = this.db.prepare("SELECT COUNT(*) n, COALESCE(SUM(cost_sol * token_amount / tokens_bought),0) c FROM positions WHERE status='open'").get() as { n: number; c: number };
    if (open.n >= config.maxPositions) return this.skip(swap, weight, `already at ${config.maxPositions} open positions`, symbol);

    let size = copySize(weight, config);
    if (size <= 0) return;
    size = Math.min(size, config.copyBudgetSol - open.c);
    if (size < config.copyMinTradeSol) return this.skip(swap, weight, "copy budget fully in use", symbol);
    if (this.executor.mode === "real" && this.wallet) {
      const balance = await walletBalanceSol(this.wallet).catch(() => 0);
      if (balance - config.walletReserveSol < size) return this.skip(swap, weight, `wallet has ${balance.toFixed(3)} SOL, needs ${(size + config.walletReserveSol).toFixed(3)}`, symbol);
    }
    if (config.rugCheckEnabled) {
      const v = await rugCheck(this.db, swap.mint, symbol);
      if (!v) return this.skip(swap, weight, "couldn't verify the token on Solana", symbol);
      if (v.verdict === "blocked") return this.skip(swap, weight, `rug check: ${v.blocks.join("; ")}`, symbol);
    }

    const proof = commitProof(this.db, "copy_buy", { leader: swap.wallet, leader_signature: swap.signature, mint: swap.mint, symbol, size_sol: size, weight, mode: this.executor.mode });
    const row = this.db
      .prepare(
        `INSERT OR IGNORE INTO copy_trades (leader, leader_signature, leader_ts, mint, symbol, side, mode, status, reason, weight, size_sol, proof_id, created_at)
         VALUES (?, ?, ?, ?, ?, 'buy', ?, 'pending', ?, ?, ?, ?, ?)`,
      )
      .run(swap.wallet, swap.signature, swap.ts, swap.mint, symbol, this.executor.mode, `leader bought ${swap.solAmount.toFixed(3)} SOL`, weight, size, proof.id, nowIso());
    if (row.changes === 0) return; // already handled this leader trade
    const copyId = Number(row.lastInsertRowid);
    try {
      const fill = await this.executor.buy(swap.mint, size);
      const pos = this.db
        .prepare(
          `INSERT INTO positions (mint, symbol, leader, mode, status, token_amount, tokens_bought, cost_sol, cost_usd, entry_price_sol, last_price_sol, last_price_ts, opened_at)
           VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(swap.mint, symbol, swap.wallet, this.executor.mode, fill.tokenAmount, fill.tokenAmount, fill.solAmount, usdOf(fill.solAmount), fill.priceSol, fill.priceSol, nowIso(), nowIso());
      this.db
        .prepare("UPDATE copy_trades SET status='filled', size_sol=?, token_amount=?, price_sol=?, signature=?, position_id=?, latency_ms=?, filled_at=? WHERE id=?")
        .run(fill.solAmount, fill.tokenAmount, fill.priceSol, fill.signature, Number(pos.lastInsertRowid), Date.now() - Date.parse(swap.ts), nowIso(), copyId);
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
    const proof = commitProof(this.db, "copy_sell", { position_id: pos.id, mint: pos.mint, symbol, tokens, all, reason, mode: this.executor.mode });
    const row = this.db
      .prepare(
        `INSERT OR IGNORE INTO copy_trades (leader, leader_signature, leader_ts, mint, symbol, side, mode, status, reason, token_amount, position_id, proof_id, created_at)
         VALUES (?, ?, ?, ?, ?, 'sell', ?, 'pending', ?, ?, ?, ?, ?)`,
      )
      .run(pos.leader, leaderSwap?.signature ?? `exit:${pos.id}:${Date.now()}`, leaderSwap?.ts ?? nowIso(), pos.mint, symbol, this.executor.mode, reason, tokens, pos.id, proof.id, nowIso());
    if (row.changes === 0) return false;
    const copyId = Number(row.lastInsertRowid);
    try {
      const fill = await this.executor.sell(pos.mint, tokens, all);
      const remaining = all ? 0 : Math.max(0, pos.token_amount - fill.tokenAmount);
      const proceeds = pos.proceeds_sol + fill.solAmount;
      const fillUsd = usdOf(fill.solAmount);
      const proceedsUsd = pos.proceeds_usd + (fillUsd ?? 0);
      const usdKnown = pos.cost_usd !== null && fillUsd !== null;
      const closed = remaining <= pos.tokens_bought * 0.01;
      this.db.prepare("UPDATE positions SET token_amount=?, proceeds_sol=?, proceeds_usd=?, cost_usd=?, last_price_sol=?, last_price_ts=? WHERE id=?")
        .run(remaining, proceeds, proceedsUsd, usdKnown ? pos.cost_usd : null, fill.priceSol, nowIso(), pos.id);
      if (closed) {
        const pnl = proceeds - pos.cost_sol;
        const pnlUsd = usdKnown ? proceedsUsd - (pos.cost_usd as number) : null;
        // % return in USD when known (SOL's own price move between entry and exit isn't trading profit).
        const pct = pnlUsd !== null && pos.cost_usd ? (pnlUsd / pos.cost_usd) * 100 : pos.cost_sol > 0 ? (pnl / pos.cost_sol) * 100 : 0;
        this.db.prepare("UPDATE positions SET status='closed', token_amount=0, closed_at=?, exit_reason=?, pnl_sol=?, pnl_usd=?, pnl_pct=? WHERE id=?").run(nowIso(), reason, pnl, pnlUsd, pct, pos.id);
        const shown = pnlUsd !== null ? `${pnlUsd >= 0 ? "+" : "−"}$${Math.abs(pnlUsd).toFixed(2)} (${fmtSol(pnl)})` : fmtSol(pnl);
        say(pnl >= 0 ? "win" : "loss", `Closed ${symbol} (copied from ${short(pos.leader)}): ${shown} (${fmtPct(pct)}) — ${reason}.`);
      } else {
        say("trade", `Sold ${fill.tokenAmount.toPrecision(4)} ${symbol} for ${fill.solAmount.toFixed(4)} SOL — ${reason}.`);
      }
      this.db
        .prepare("UPDATE copy_trades SET status='filled', size_sol=?, token_amount=?, price_sol=?, signature=?, latency_ms=?, filled_at=? WHERE id=?")
        .run(fill.solAmount, fill.tokenAmount, fill.priceSol, fill.signature, leaderSwap ? Date.now() - Date.parse(leaderSwap.ts) : null, nowIso(), copyId);
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
    const open = this.db.prepare("SELECT * FROM positions WHERE status='open'").all() as PositionRow[];
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
      if (!usd) continue;
      const price = usd / solUsd;
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
