/**
 * RUNNER BACKFILL — coins that ran before the tape was watching (or while the agent was down), read back from Solana.
 *
 *   1. Candidates: pump.fun coins in the stored swaps of the last N days with a crowd (15+ tracked wallets) whose price
 *      went 10x over pump.fun's starting price. Their price path (minute medians, peak, minutes at 5x, market cap at the
 *      peak) is rebuilt from those swaps: tracked wallets only, so an undercount, but enough to see a run.
 *   2. Each candidate that came close to running and has no buyers stored yet gets its launch read from Solana
 *      (runners/chain.ts), several coins at a time: they all share the RPC pacer, so running in parallel never goes past
 *      the budget, only fills it.
 *   3. Stored like the tape's coins (saveCoins), source "backfill".
 */
import { type DB } from "@godseye/shared";
import { say, short } from "../log";
import { recordLaunch } from "../market/tokens";
import { launchFromChain } from "./chain";
import { ensureRunnerTables } from "./schema";
import { type CoinRecord, plausiblePrice, PUMP_LAUNCH_PRICE_SOL, PUMP_SUPPLY, saveCoins, tapeSettings } from "./tape";

export interface PricePoint {
  t: number;
  price: number;
  solUsd: number | null;
}

/** Pure: peak of the minute medians, when it was, the first minute at 3x, minutes at 5x or more of `p0`, and SOL's price at the peak. */
export function pricePath(points: PricePoint[], p0: number): { peak: number; peakAt: number; x3At: number | null; minutesAbove5: number; peakSolUsd: number | null } {
  const minutes = new Map<number, { prices: number[]; solUsd: number | null }>();
  for (const p of points) {
    const m = Math.floor(p.t / 60_000);
    const e = minutes.get(m) ?? { prices: [], solUsd: p.solUsd };
    e.prices.push(p.price);
    minutes.set(m, e);
  }
  let peak = 0;
  let peakAt = points[0]?.t ?? 0;
  let peakSolUsd: number | null = null;
  let minutesAbove5 = 0;
  let x3At: number | null = null;
  for (const [m, e] of [...minutes.entries()].sort((a, b) => a[0] - b[0])) {
    const s = e.prices.sort((a, b) => a - b);
    const med = s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
    if (med > peak) {
      peak = med;
      peakAt = m * 60_000;
      peakSolUsd = e.solUsd;
    }
    if (med >= 5 * p0) minutesAbove5++;
    if (med >= 3 * p0) x3At ??= m * 60_000;
  }
  return { peak, peakAt, x3At, minutesAbove5, peakSolUsd };
}

export interface Candidate {
  mint: string;
  first: number;
  p0: number;
  peak: number;
  peakAt: number;
  x3At: number | null;
  minutesAbove5: number;
  peakMcapUsd: number | null;
  /** The coin's first stored swap at 3x (early buys are all before it, by definition): the chain is paged back from it. */
  anchor: string | null;
}

/** pump.fun coins in the stored swaps of the last `days` days that came close to running and have no buyers stored yet. */
export function backfillCandidates(db: DB, days: number, now = Date.now()): Candidate[] {
  ensureRunnerTables(db);
  const out: Candidate[] = [];
  const have = db.prepare("SELECT 1 FROM runner_buyers WHERE mint = ? LIMIT 1");
  const swaps = db.prepare("SELECT ts, price_sol, sol_usd, signature FROM wallet_swaps WHERE mint = ? AND quote = 'SOL' AND price_sol > 0 ORDER BY ts");
  // A day at a time: one GROUP BY over 15 days of swaps holds the database too long.
  const seen = new Set<string>();
  for (let d = days; d > 0; d--) {
    const from = new Date(now - d * 86_400_000).toISOString();
    const to = new Date(now - (d - 1) * 86_400_000).toISOString();
    const rows = db
      .prepare(
        `SELECT mint FROM wallet_swaps WHERE ts >= ? AND ts < ? AND mint LIKE '%pump' AND quote = 'SOL' AND price_sol > 0
          GROUP BY mint HAVING COUNT(DISTINCT wallet) >= ? AND MAX(price_sol) >= ?`,
      )
      .all(from, to, tapeSettings.keepMinBuyers, PUMP_LAUNCH_PRICE_SOL * tapeSettings.candidateX) as { mint: string }[];
    for (const { mint } of rows) {
      if (seen.has(mint) || have.get(mint)) continue;
      seen.add(mint);
      // Stored prices in the wrong units (a few parse that way) would make any coin a runner.
      const rows = (swaps.all(mint) as { ts: string; price_sol: number; sol_usd: number | null; signature: string }[]).filter((r) => plausiblePrice(r.price_sol));
      const pts = rows.map((r) => ({ t: Date.parse(r.ts), price: r.price_sol, solUsd: r.sol_usd }));
      if (!pts.length) continue;
      const p0 = PUMP_LAUNCH_PRICE_SOL;
      const path = pricePath(pts, p0);
      const peakMcapUsd = path.peakSolUsd ? path.peak * path.peakSolUsd * PUMP_SUPPLY : null;
      if (path.peak / p0 < tapeSettings.candidateX || (peakMcapUsd ?? 0) < tapeSettings.candidateMcapUsd) continue;
      out.push({ mint, first: pts[0].t, p0, peak: path.peak, peakAt: path.peakAt, x3At: path.x3At, minutesAbove5: path.minutesAbove5, peakMcapUsd, anchor: (rows.find((r) => r.price_sol >= p0 * tapeSettings.earlyMaxX) ?? rows[rows.length - 1]).signature });
    }
  }
  return out.sort((a, b) => (b.peakMcapUsd ?? 0) - (a.peakMcapUsd ?? 0));
}

export interface BackfillOptions {
  days: number;
  maxCoins: number;
  workers: number;
  maxPages: number;
  readTxs: number;
  delayMs: number;
}

/** Read the launches of up to `maxCoins` candidates from Solana, `workers` at a time, and store them. */
export async function runBackfill(db: DB, opts: BackfillOptions): Promise<{ candidates: number; read: number; tooBusy: number; failed: number; stored: number }> {
  const all = backfillCandidates(db, opts.days);
  const todo = all.slice(0, opts.maxCoins);
  let next = 0;
  let read = 0;
  let tooBusy = 0;
  let failed = 0;
  let stored = 0;
  const worker = async () => {
    while (next < todo.length) {
      const c = todo[next++];
      try {
        const launch = await launchFromChain(c.mint, { maxPages: opts.maxPages, readTxs: opts.readTxs, delayMs: opts.delayMs, before: c.anchor ?? undefined });
        if (!launch) {
          tooBusy++;
          continue;
        }
        read++;
        recordLaunch(db, c.mint, new Date(launch.first).toISOString(), launch.creator);
        const rec: CoinRecord = {
          mint: c.mint, source: "backfill", first: launch.first, firstSlot: launch.firstSlot, launchSeen: true, p0: c.p0, peak: c.peak, peakAt: c.peakAt, x3At: c.x3At,
          minutesAbove5: c.minutesAbove5, peakMcapUsd: c.peakMcapUsd, buyers: launch.buyers, buys: launch.buys, swaps: launch.swaps,
        };
        stored += saveCoins(db, [rec]).candidates;
      } catch (e) {
        failed++;
        if (failed <= 3) say("warn", `Runner backfill: couldn't read ${short(c.mint)}'s launch: ${(e as Error).message.slice(0, 160)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.workers, todo.length) }, worker));
  return { candidates: all.length, read, tooBusy, failed, stored };
}
