/**
 * SOLD RIGHT BEFORE A CRASH? — one of the insider-pattern signals.
 *
 * Memecoins drop 60%+ over a few days all the time, so "it's lower now than
 * when they sold" says nothing. A sale only counts as "right before a crash" if:
 *   • the token fell ≥ CRASH_DROP_PCT (50%) below the sell price within
 *     CRASH_WINDOW_MINUTES (60) of the sale, and
 *   • the wallet sold near the top: within 20% of the previous hour's high
 *     (not into a dump that was already under way).
 * Prices come from 15-minute candles of the token's deepest pool. Each sale
 * is checked once (after its window has passed) and cached in crash_checks.
 */
import { type DB, nowIso } from "@godseye/shared";
import { fetchCandles15m, type Candle } from "../market/geckoterminal";
import { tokenInfo } from "../market/tokens";
import { solUsdAt } from "../market/solprice";

const CANDLE_SEC = 15 * 60;
/** Selling at ≥ 80% of the previous hour's high counts as "near the top". */
const NEAR_TOP = 0.8;

export interface ExitJudgement {
  dropPct: number;
  minutesToLow: number;
  nearTop: boolean;
}

/** Pure: judge one sale from candles around it. `sellUsd` = the wallet's sell price in USD. */
export function judgeExit(candles: Candle[], sellTs: number, sellUsd: number, windowMinutes: number): ExitJudgement | null {
  if (!candles.length || sellUsd <= 0) return null;
  const sellCandleStart = sellTs - (sellTs % CANDLE_SEC);
  const after = candles.filter(([t]) => t >= sellCandleStart && t <= sellTs + windowMinutes * 60);
  if (!after.length) return null;
  let low = after[0];
  for (const c of after) if (c[3] < low[3]) low = c;
  const before = candles.filter(([t]) => t < sellCandleStart && t >= sellCandleStart - 3600);
  const priorHigh = before.length ? Math.max(...before.map((c) => c[2])) : null;
  return {
    dropPct: Math.max(0, (1 - low[3] / sellUsd) * 100),
    minutesToLow: Math.max(0, (low[0] + CANDLE_SEC / 2 - sellTs) / 60),
    nearTop: priorHigh !== null && sellUsd >= priorHigh * NEAR_TOP,
  };
}

export function isCrashExit(j: ExitJudgement | null, cfg: { crashDropPct: number; crashWindowMinutes: number }): boolean {
  return !!j && j.nearTop && j.dropPct >= cfg.crashDropPct && j.minutesToLow <= cfg.crashWindowMinutes;
}

interface CachedCheck {
  drop_pct: number | null;
  minutes_to_low: number | null;
  near_top: number | null;
}

/**
 * Checks a sale (cached). Returns undefined if it can't be checked yet
 * (window still open, or out of lookup budget this run).
 */
export async function checkExit(
  db: DB,
  e: { mint: string; signature: string; ts: string; sellPriceSol: number },
  cfg: { crashWindowMinutes: number },
  budget: { left: number },
): Promise<ExitJudgement | null | undefined> {
  const cached = db.prepare("SELECT drop_pct, minutes_to_low, near_top FROM crash_checks WHERE signature = ? AND mint = ?").get(e.signature, e.mint) as CachedCheck | undefined;
  if (cached) return cached.drop_pct === null ? null : { dropPct: cached.drop_pct, minutesToLow: cached.minutes_to_low ?? 0, nearTop: cached.near_top === 1 };
  const sellTs = Math.floor(Date.parse(e.ts) / 1000);
  if (Date.now() / 1000 < sellTs + cfg.crashWindowMinutes * 60 + CANDLE_SEC) return undefined; // window not over yet
  if (budget.left <= 0) return undefined;
  budget.left--;
  const save = (j: ExitJudgement | null) => {
    db.prepare("INSERT OR REPLACE INTO crash_checks (signature, mint, drop_pct, minutes_to_low, near_top, checked_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(e.signature, e.mint, j?.dropPct ?? null, j?.minutesToLow ?? null, j ? (j.nearTop ? 1 : 0) : null, nowIso());
    return j;
  };
  const solUsd = solUsdAt(sellTs * 1000);
  const pool = (await tokenInfo(db, e.mint, { pool: true }).catch(() => null))?.pool_address;
  if (!solUsd || !pool) return save(null);
  const end = sellTs + cfg.crashWindowMinutes * 60 + CANDLE_SEC;
  const limit = Math.ceil((end - (sellTs - 3600)) / CANDLE_SEC) + 1;
  const candles = await fetchCandles15m(pool, end, limit).catch(() => null);
  if (!candles) return undefined; // network trouble: try again next time
  return save(judgeExit(candles, sellTs, e.sellPriceSol * solUsd, cfg.crashWindowMinutes));
}
