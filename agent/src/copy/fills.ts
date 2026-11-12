/**
 * FILLS — writing a copy trade's result into the books.
 *
 * A result can arrive from two places: the engine (the swap confirmed while it waited) and the settle step
 * (recovery.ts reads the chain for trades whose outcome wasn't known when the engine gave up, or that a restart
 * interrupted). Each function here records a result only while the trade's row is still `pending`, in one DB
 * transaction, so whichever comes second changes nothing and no trade is counted twice. (`revive` also takes a row
 * marked `failed`: the caller found that swap on chain after all.)
 */
import { type DB, nowIso } from "@godseye/shared";
import { fmtPct, fmtSol, say, short } from "../log";
import { symbolOf } from "../market/tokens";
import { solUsdAt } from "../market/solprice";
import type { Fill } from "./executor";

export interface PositionRow {
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
  last_price_ts: string | null;
  opened_at: string;
  /** Best return seen on the minute checks, % (trailing stop). */
  peak_pct: number | null;
  /** 1 once the ladder's first part was sold. */
  partial_done: number;
  /** Who chose the trade: the leader-copy rules, or the Brain sleeve (brain/sleeve.ts). */
  decider?: "rules" | "brain";
  brain_paper_id?: number | null;
}

/** SOL → USD at `atMs` (default: this moment); null if the price is unknown. */
export const usdOf = (sol: number, atMs = Date.now()): number | null => {
  const p = solUsdAt(atMs);
  return p ? sol * p : null;
};

const isoAt = (atMs?: number): string => (atMs === undefined ? nowIso() : new Date(atMs).toISOString());
const canSettle = (db: DB, copyId: number, revive = false): boolean =>
  db.prepare("SELECT 1 FROM copy_trades WHERE id=? AND (status='pending' OR (? = 1 AND status='failed'))").get(copyId, revive ? 1 : 0) !== undefined;

export interface FillRecord {
  /** The copy_trades row this fill settles. */
  copyId: number;
  fill: Fill;
  /** Leader's trade → this fill, ms (null = not known). */
  latencyMs: number | null;
  /** When the fill happened (default: now). A fill read back from the chain passes its block time. */
  atMs?: number;
  /** Kept on the trade's row when the fill didn't come straight from the engine (how it was settled). */
  note?: string;
  /** Also settle a trade marked `failed`: the chain shows it landed after all. */
  revive?: boolean;
}

/**
 * A buy landed: open its position and mark the trade filled. Returns the position's id, or null when the trade was
 * already settled (nothing is written then). There is one open position per coin: a buy that lands while one is
 * already open (the engine never sends one; only a late-settled buy can) is added to it.
 */
export function openPositionFromFill(db: DB, o: FillRecord & { mint: string; symbol: string | null; leader: string; mode: "real" | "paper" }): number | null {
  const f = o.fill;
  const at = isoAt(o.atMs);
  return db.transaction((): number | null => {
    if (!canSettle(db, o.copyId, o.revive)) return null;
    const usd = usdOf(f.solAmount, o.atMs);
    const open = db.prepare("SELECT id FROM positions WHERE status='open' AND mint=? AND mode=?").get(o.mint, o.mode) as { id: number } | undefined;
    if (open) {
      // Every right-hand side reads the row as it was before this update.
      db.prepare(
        `UPDATE positions SET token_amount = token_amount + ?, tokens_bought = tokens_bought + ?, cost_sol = cost_sol + ?,
           cost_usd = CASE WHEN cost_usd IS NULL OR ? IS NULL THEN NULL ELSE cost_usd + ? END,
           fee_sol = CASE WHEN fee_sol IS NULL THEN NULL ELSE fee_sol + ? END,
           entry_price_sol = (cost_sol + ?) / (tokens_bought + ?)
         WHERE id=?`,
      ).run(f.tokenAmount, f.tokenAmount, f.solAmount, usd, usd, f.feeSol ?? 0, f.solAmount, f.tokenAmount, open.id);
    }
    const id =
      open?.id ??
      Number(
        db
          .prepare(
            `INSERT INTO positions (mint, symbol, leader, mode, status, token_amount, tokens_bought, cost_sol, cost_usd, fee_sol, entry_price_sol, last_price_sol, last_price_ts, opened_at, leader_win_rate, decider)
             VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT win_rate_30d FROM wallet_stats WHERE wallet = ?),
                     COALESCE((SELECT decider FROM copy_trades WHERE id = ?), 'rules'))`,
          )
          .run(o.mint, o.symbol, o.leader, o.mode, f.tokenAmount, f.tokenAmount, f.solAmount, usd, f.feeSol ?? null, f.priceSol, f.priceSol, at, at, o.leader, o.copyId).lastInsertRowid,
      );
    db.prepare(
      "UPDATE copy_trades SET status='filled', size_sol=?, token_amount=?, price_sol=?, fee_sol=?, signature=COALESCE(?, signature), position_id=?, latency_ms=?, filled_at=?, error=? WHERE id=?",
    ).run(f.solAmount, f.tokenAmount, f.priceSol, f.feeSol ?? null, f.signature, id, o.latencyMs, at, o.note ?? null, o.copyId);
    return id;
  })();
}

/** Books a position as closed: what came back, minus what went in and the fees (fees only when they were recorded). */
function bookClose(
  db: DB,
  pos: PositionRow,
  t: { proceeds: number; proceedsUsd: number; usdKnown: boolean; fees: number | null; reason: string; atMs?: number },
): { pnl: number; pnlUsd: number | null; pct: number } {
  const feeUsd = t.fees === null ? 0 : (usdOf(t.fees, t.atMs) ?? null);
  const pnl = t.proceeds - pos.cost_sol - (t.fees ?? 0);
  const pnlUsd = t.usdKnown && feeUsd !== null ? t.proceedsUsd - (pos.cost_usd as number) - feeUsd : null;
  // % return in USD when known (SOL's own price move between entry and exit isn't trading profit).
  const pct = pnlUsd !== null && pos.cost_usd ? (pnlUsd / pos.cost_usd) * 100 : pos.cost_sol > 0 ? (pnl / pos.cost_sol) * 100 : 0;
  db.prepare("UPDATE positions SET status='closed', token_amount=0, closed_at=?, exit_reason=?, pnl_sol=?, pnl_usd=?, pnl_pct=? WHERE id=?").run(isoAt(t.atMs), t.reason, pnl, pnlUsd, pct, pos.id);
  return { pnl, pnlUsd, pct };
}

const closedLine = (db: DB, pos: PositionRow, r: { pnl: number; pnlUsd: number | null; pct: number }, reason: string): (() => void) => {
  const shown = r.pnlUsd !== null ? `${r.pnlUsd >= 0 ? "+" : "−"}$${Math.abs(r.pnlUsd).toFixed(2)} (${fmtSol(r.pnl)})` : fmtSol(r.pnl);
  return () => say(r.pnl >= 0 ? "win" : "loss", `Closed ${pos.symbol ?? symbolOf(db, pos.mint)} (copied from ${short(pos.leader)}): ${shown} (${fmtPct(r.pct)}) — ${reason}.`);
};

/**
 * A sell landed: take it off the position (closing it when nothing worth holding is left) and mark the trade filled.
 *   "closed" / "reduced" — recorded
 *   "stale"              — the trade was already settled, or its position is no longer open; the position is untouched
 */
export function applySellFill(db: DB, posId: number, o: FillRecord & { all: boolean; reason: string }): "closed" | "reduced" | "stale" {
  const f = o.fill;
  const at = isoAt(o.atMs);
  const lines: (() => void)[] = [];
  const result = db.transaction((): "closed" | "reduced" | "stale" => {
    if (!canSettle(db, o.copyId, o.revive)) return "stale";
    const settle = (note: string | null) =>
      db
        .prepare("UPDATE copy_trades SET status='filled', size_sol=?, token_amount=?, price_sol=?, fee_sol=?, signature=COALESCE(?, signature), latency_ms=?, filled_at=?, error=? WHERE id=?")
        .run(f.solAmount, f.tokenAmount, f.priceSol, f.feeSol ?? null, f.signature, o.latencyMs, at, note, o.copyId);
    const pos = db.prepare("SELECT * FROM positions WHERE id=? AND status='open'").get(posId) as PositionRow | undefined;
    if (!pos) {
      settle("this sell landed, but its position was already closed: the proceeds are not in the position's result");
      return "stale";
    }
    const remaining = o.all ? 0 : Math.max(0, pos.token_amount - f.tokenAmount);
    const proceeds = pos.proceeds_sol + f.solAmount;
    const fillUsd = usdOf(f.solAmount, o.atMs);
    const proceedsUsd = pos.proceeds_usd + (fillUsd ?? 0);
    const usdKnown = pos.cost_usd !== null && fillUsd !== null;
    const closed = remaining <= pos.tokens_bought * 0.01;
    // Fees stay "not recorded" for a position whose buy fee wasn't recorded (never half-counted).
    const fees = pos.fee_sol === null ? null : pos.fee_sol + (f.feeSol ?? 0);
    // A fill settled late must not put an older price over one the minute check has recorded since.
    const priced = pos.last_price_ts !== null && pos.last_price_ts > at;
    db.prepare("UPDATE positions SET token_amount=?, proceeds_sol=?, proceeds_usd=?, cost_usd=?, fee_sol=?, last_price_sol=?, last_price_ts=? WHERE id=?").run(
      remaining, proceeds, proceedsUsd, usdKnown ? pos.cost_usd : null, fees, priced ? pos.last_price_sol : f.priceSol, priced ? pos.last_price_ts : at, pos.id,
    );
    settle(o.note ?? null);
    if (!closed) {
      lines.push(() => say("trade", `Sold ${f.tokenAmount.toPrecision(4)} ${pos.symbol ?? symbolOf(db, pos.mint)} for ${f.solAmount.toFixed(4)} SOL — ${o.reason}.`));
      return "reduced";
    }
    lines.push(closedLine(db, pos, bookClose(db, pos, { proceeds, proceedsUsd, usdKnown, fees, reason: o.reason, atMs: o.atMs }), o.reason));
    return "closed";
  })();
  for (const line of lines) line(); // said only once the books are written
  return result;
}

/**
 * Close a position the wallet no longer holds when no sell of it can be found on chain: booked with what is on record
 * (nothing more came back), so it stops counting as open. False when the position isn't open any more.
 */
export function closeMissing(db: DB, posId: number, reason = "missing: wallet holds none"): boolean {
  const lines: (() => void)[] = [];
  const done = db.transaction((): boolean => {
    const pos = db.prepare("SELECT * FROM positions WHERE id=? AND status='open'").get(posId) as PositionRow | undefined;
    if (!pos) return false;
    const booked = bookClose(db, pos, { proceeds: pos.proceeds_sol, proceedsUsd: pos.proceeds_usd, usdKnown: pos.cost_usd !== null, fees: pos.fee_sol, reason });
    lines.push(closedLine(db, pos, booked, reason));
    return true;
  })();
  for (const line of lines) line();
  return done;
}
