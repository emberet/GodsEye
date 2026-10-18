/**
 * SOL's USD price at any moment in the last ~80 days, so swaps paid in USDC
 * or USDT can be valued in SOL at the time they happened.
 *   • last 90 minutes: Jupiter's live price, refreshed every minute
 *   • older: hourly closes of Raydium's main SOL/USDC pool (GeckoTerminal),
 *     cached in the sol_price_hourly table and topped up every few hours
 * solUsdAt() is synchronous so the swap parser can stay pure; call
 * initSolPrices() once at startup.
 */
import { type DB, SOL_MINT } from "@godseye/shared";
import { say } from "../log";
import { fetchHourlyCloses } from "./geckoterminal";
import { getPrices } from "./prices";

/** Raydium SOL/USDC (AMM v4), the deepest SOL/USDC pool. */
const SOL_USDC_POOL = "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2";
const HOUR = 3600;
/** How far an hourly close may be from the swap and still be used. */
const MAX_GAP_HOURS = 3;
/** How long the live price counts as "now". */
const LIVE_WINDOW_MS = 90 * 60_000;

const hourly = new Map<number, number>();
let live: { usd: number; at: number } | null = null;

/** SOL in USD at `tsMs`, or null if unknown (the swap is then skipped rather than guessed). */
export function solUsdAt(tsMs: number): number | null {
  if (live && Math.abs(tsMs - live.at) <= LIVE_WINDOW_MS) return live.usd;
  const h = Math.floor(tsMs / 1000 / HOUR) * HOUR;
  for (let d = 0; d <= MAX_GAP_HOURS; d++) {
    const v = hourly.get(h - d * HOUR) ?? hourly.get(h + d * HOUR);
    if (v) return v;
  }
  return null;
}

/** For tests and tools: set prices directly. */
export function setSolPricesForTest(points: [number, number][], liveUsd?: number): void {
  hourly.clear();
  for (const [t, usd] of points) hourly.set(t, usd);
  live = liveUsd ? { usd: liveUsd, at: Date.now() } : null;
}

export async function refreshLiveSolPrice(): Promise<void> {
  const p = (await getPrices([SOL_MINT]).catch(() => new Map())).get(SOL_MINT)?.priceUsd;
  if (p) live = { usd: p, at: Date.now() };
}

/** Load cached hours, then fetch whatever is missing (up to ~80 days back). */
export async function refreshHourlySolPrices(db: DB): Promise<void> {
  for (const r of db.prepare("SELECT hour, usd FROM sol_price_hourly").all() as { hour: number; usd: number }[]) hourly.set(r.hour, r.usd);
  const nowHour = Math.floor(Date.now() / 1000 / HOUR) * HOUR;
  const newest = Math.max(0, ...hourly.keys());
  if (nowHour - newest < 2 * HOUR && hourly.size > 1500) return;
  const ins = db.prepare("INSERT OR REPLACE INTO sol_price_hourly (hour, usd) VALUES (?, ?)");
  try {
    let before: number | undefined;
    for (let page = 0; page < 2; page++) {
      const closes = await fetchHourlyCloses(SOL_USDC_POOL, before);
      if (!closes.length) break;
      db.transaction(() => closes.forEach(([t, usd]) => usd > 0 && (hourly.set(t, usd), ins.run(t, usd))))();
      before = closes[closes.length - 1][0];
      if (closes[closes.length - 1][0] <= newest) break; // caught up with the cache
    }
  } catch (e) {
    say("warn", `Couldn't load SOL price history (${(e as Error).message.slice(0, 100)}); USDC-priced swaps older than 90 min are skipped until it loads.`);
  }
}

export async function initSolPrices(db: DB): Promise<void> {
  await Promise.all([refreshLiveSolPrice(), refreshHourlySolPrices(db)]);
}
