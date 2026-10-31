/**
 * What counts as a RUNNER — decided from the data, not fixed.
 *
 * 10x from the first price alone is far too loose: most pump.fun launches that do it go from ~$5k to ~$50k and die (3 days
 * of stored swaps: 1,997 of 12,788 coins with a crowd went 10x). So a runner must also reach a market cap in the top
 * RUNNER_TOP_SHARE (1%) of the coins of the last 7 days that drew a crowd (15+ buyers), and stay at 5x or more for
 * RUNNER_MIN_MINUTES_ABOVE_5X (10) minutes, on minute medians, so a one-minute spike isn't a run. The cut-off is
 * recomputed every hour; each coin's is_runner flag follows it, and the definition in force is kept in agent_meta.
 */
import { type DB, envNum, getMeta, nowIso, setMeta } from "@godseye/shared";
import { ensureRunnerTables } from "./schema";
import { tapeSettings } from "./tape";

export const DEFINITION_KEY = "runner_definition";

export const defineSettings = {
  minMultiple: 10,
  topShare: envNum("RUNNER_TOP_SHARE", 0.01),
  minMinutesAbove5x: envNum("RUNNER_MIN_MINUTES_ABOVE_5X", 10),
  windowDays: 7,
  /** Coins counted for the cut-off: a real crowd. */
  minBuyers: tapeSettings.keepMinBuyers,
  /** The market-cap cut-off never goes below this, however quiet the market. */
  mcapFloorUsd: tapeSettings.candidateMcapUsd,
};

export interface RunnerDefinition {
  minMultiple: number;
  mcapCutUsd: number;
  minMinutesAbove5x: number;
  /** Coins the cut-off was taken from, and how many count as runners now. */
  coins: number;
  runners: number;
  at: string;
}

/** Pure: the market cap at the top `share` of `mcaps` (never below `floor`). */
export function mcapCut(mcaps: number[], share: number, floor: number): number {
  if (!mcaps.length) return floor;
  const s = [...mcaps].sort((a, b) => b - a);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil(s.length * share) - 1));
  return Math.max(floor, s[i]);
}

export function defineRunners(db: DB, now = Date.now(), s = defineSettings): RunnerDefinition {
  ensureRunnerTables(db);
  const since = new Date(now - s.windowDays * 86_400_000).toISOString();
  const mcaps = (db.prepare("SELECT peak_mcap_usd m FROM runner_tokens WHERE first_seen >= ? AND buyers >= ? AND peak_mcap_usd IS NOT NULL").all(since, s.minBuyers) as { m: number }[]).map((r) => r.m);
  const cut = mcapCut(mcaps, s.topShare, s.mcapFloorUsd);
  db.prepare(
    `UPDATE runner_tokens SET is_runner = CASE WHEN multiple >= ? AND COALESCE(peak_mcap_usd, 0) >= ? AND minutes_above_5x >= ? THEN 1 ELSE 0 END`,
  ).run(s.minMultiple, cut, s.minMinutesAbove5x);
  const runners = (db.prepare("SELECT COUNT(*) n FROM runner_tokens WHERE is_runner = 1 AND first_seen >= ?").get(since) as { n: number }).n;
  const def: RunnerDefinition = { minMultiple: s.minMultiple, mcapCutUsd: cut, minMinutesAbove5x: s.minMinutesAbove5x, coins: mcaps.length, runners, at: nowIso() };
  setMeta(db, DEFINITION_KEY, JSON.stringify(def));
  return def;
}

export function currentDefinition(db: DB): RunnerDefinition | null {
  const raw = getMeta(db, DEFINITION_KEY);
  try {
    return raw ? (JSON.parse(String(raw)) as RunnerDefinition) : null;
  } catch {
    return null;
  }
}

export const describeDefinition = (d: RunnerDefinition): string =>
  `a runner = ${d.minMultiple}x or more from its first price, a peak market cap of $${Math.round(d.mcapCutUsd).toLocaleString("en-US")} or more (top ${defineSettings.topShare * 100}% of ${d.coins.toLocaleString("en-US")} coins with a crowd, last ${defineSettings.windowDays} days) and ${d.minMinutesAbove5x}+ minutes at 5x: ${d.runners} runners`;
