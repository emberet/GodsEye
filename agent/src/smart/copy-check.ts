/**
 * THE TWO GATES BETWEEN "PROFITABLE" AND "SMART MONEY"
 *
 *   Bot gate — profit made in seconds can't be followed. Not smart if any of:
 *     • median hold under SMART_BOT_MIN_HOLD_SEC (15 s), first buy → closing sell
 *     • more than SMART_BOT_MAX_TX_PER_HOUR (20) transactions an hour
 *     • more than SMART_BOT_MAX_SAME_BLOCK (0) positions bought and sold in the same block
 *       (a buy and sell inside ONE transaction nets to nothing and is never stored as a swap,
 *       so the same block is the closest GodsEye can see)
 *   Copy gate — the wallet's own P&L says nothing about a follower's. The copy-fill replay
 *     (replay/) re-runs its last 14 days of trades the way the copy engine would take them, at
 *     GodsEye's real delay and size, after fees. Smart only if the MEDIAN copy made money, over
 *     ≥ SMART_REPLAY_MIN_COPIES copies, with the tape seeing other swaps near ≥ SMART_REPLAY_MIN_COVERAGE
 *     of entries. Until a wallet has been replayed it doesn't count.
 * Replays are refreshed in the background, a slice at a time, so the live stream keeps flowing.
 */
import { type DB, nowIso } from "@godseye/shared";
import { config } from "../config";
import { calibration, dataEnd, replayWallet } from "../replay/run";
import { summarize } from "../replay/summary";

export interface BotSigns {
  median_hold_sec: number | null;
  tx_per_hour: number | null;
  same_block_round_trips: number | null;
}

export interface CopyReplay {
  delay_sec: number;
  n: number;
  coverage: number | null;
  median_ret_pct: number | null;
}

type BotCfg = { minHoldSec: number; maxTxPerHour: number; maxSameBlock: number };
type ReplayCfg = { minCopies: number; minCoverage: number };

/** Pure: why this wallet looks like a bot, or null. Unknown values never count against it. */
export function botReason(b: BotSigns, cfg: BotCfg): string | null {
  if (b.median_hold_sec !== null && b.median_hold_sec < cfg.minHoldSec) return `bot: median hold ${Math.round(b.median_hold_sec)} s (under ${cfg.minHoldSec} s can't be copied)`;
  if (b.tx_per_hour !== null && b.tx_per_hour > cfg.maxTxPerHour) return `bot: ${Math.round(b.tx_per_hour)} transactions an hour (over ${cfg.maxTxPerHour})`;
  if ((b.same_block_round_trips ?? 0) > cfg.maxSameBlock) return `bot: bought and sold in the same block ${b.same_block_round_trips} time${b.same_block_round_trips === 1 ? "" : "s"}`;
  return null;
}

/** Pure: why copying this wallet doesn't pay, or null if it does. */
export function copyReason(r: CopyReplay | null, cfg: ReplayCfg): string | null {
  if (!r) return "waiting for its copy replay";
  if (r.n < cfg.minCopies) return `copy replay: only ${r.n} copyable buys in 14 days (${cfg.minCopies} needed)`;
  if (r.coverage === null || r.coverage < cfg.minCoverage) return `copy replay: too few other swaps seen around its entries to tell (${Math.round((r.coverage ?? 0) * 100)}% of ${r.n})`;
  if (r.median_ret_pct === null || r.median_ret_pct <= 0) {
    return `copy replay: copying it ${r.delay_sec} s late made a median ${r.median_ret_pct === null ? "—" : `${r.median_ret_pct >= 0 ? "+" : "−"}${Math.abs(r.median_ret_pct).toFixed(1)}%`} per copy (${r.n} copies)`;
  }
  return null;
}

export const botCfg = (): BotCfg => ({ minHoldSec: config.smartBotMinHoldSec, maxTxPerHour: config.smartBotMaxTxPerHour, maxSameBlock: config.smartBotMaxSameBlock });
export const replayCfg = (): ReplayCfg => ({ minCopies: config.smartReplayMinCopies, minCoverage: config.smartReplayMinCoverage });

/** Bot signs for many wallets at once. */
export function botSigns(db: DB, wallets: string[]): Map<string, BotSigns> {
  const q = db.prepare(
    `SELECT w.tx_per_hour, s.median_hold_sec, s.same_block_round_trips FROM wallets w LEFT JOIN wallet_stats s ON s.wallet = w.address WHERE w.address = ?`,
  );
  const out = new Map<string, BotSigns>();
  for (const a of wallets) {
    const r = q.get(a) as BotSigns | undefined;
    if (r) out.set(a, r);
  }
  return out;
}

export function storedReplays(db: DB): Map<string, CopyReplay> {
  const rows = db.prepare("SELECT wallet, delay_sec, n, coverage, median_ret_pct FROM copy_replays").all() as (CopyReplay & { wallet: string })[];
  return new Map(rows.map((r) => [r.wallet, r]));
}

/** The delay to replay at: GodsEye's own median once it has real copies, otherwise the configured guess. */
export function replayDelaySec(db: DB): number {
  const cal = calibration(db);
  return cal.n >= 5 && cal.medianLatencySec !== null ? Math.max(1, Math.round(cal.medianLatencySec)) : config.smartReplayDelaySec;
}

/** A replay older than this is redone. */
export const REPLAY_MAX_AGE_MS = 6 * 3_600_000;
const REPLAY_DAYS = 14;

/**
 * Replay the wallets whose result is missing or stale (missing first, then oldest), for at most `budgetMs`,
 * yielding between wallets. Returns how many were replayed.
 */
export async function refreshCopyReplays(db: DB, wallets: string[], opts: { budgetMs: number; now?: number }): Promise<number> {
  const now = opts.now ?? Date.now();
  const age = new Map((db.prepare("SELECT wallet, computed_at FROM copy_replays").all() as { wallet: string; computed_at: string }[]).map((r) => [r.wallet, Date.parse(r.computed_at)]));
  const due = wallets.filter((w) => now - (age.get(w) ?? 0) > REPLAY_MAX_AGE_MS).sort((a, b) => (age.get(a) ?? 0) - (age.get(b) ?? 0));
  if (!due.length) return 0;
  const delay = replayDelaySec(db);
  const endT = dataEnd(db);
  const params = {
    sizeSol: config.copyMaxTradeSol,
    minLeaderBuySol: config.minLeaderBuySol,
    stopLossPct: config.stopLossPct,
    takeProfitPct: config.takeProfitPct,
    maxHoldHours: config.maxHoldHours,
  };
  const up = db.prepare(
    `INSERT INTO copy_replays (wallet, delay_sec, n, coverage, median_ret_pct, mean_ret_pct, win_rate, leader_ret_pct, implausible, computed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(wallet) DO UPDATE SET delay_sec=excluded.delay_sec, n=excluded.n, coverage=excluded.coverage, median_ret_pct=excluded.median_ret_pct,
       mean_ret_pct=excluded.mean_ret_pct, win_rate=excluded.win_rate, leader_ret_pct=excluded.leader_ret_pct, implausible=excluded.implausible, computed_at=excluded.computed_at`,
  );
  const started = Date.now();
  let done = 0;
  for (const w of due) {
    if (Date.now() - started > opts.budgetMs) break;
    const r = replayWallet(db, w, [delay], params, { sinceMs: endT - REPLAY_DAYS * 86_400_000, endT });
    const s = summarize(delay, r.real.get(delay) ?? [], r.ideal);
    up.run(w, delay, s.n, s.coverage, s.medianRetPct, s.meanRetPct, s.winRate, s.idealMeanRetPct, r.implausible, nowIso());
    done++;
    await new Promise((res) => setImmediate(res));
  }
  return done;
}
