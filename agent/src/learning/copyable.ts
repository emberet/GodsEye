/**
 * How much of a wallet's buying GodsEye could actually copy.
 *
 * The rug screen (market/rugcheck.ts) refuses coins whose pool liquidity isn't locked or burned, which is nearly every coin
 * launched outside pump.fun. A leader that mostly buys those holds a copy slot and produces no copies, so the learning loop
 * weighs each wallet by the share of its buys the screen would let through (weights.ts).
 *
 * A buy counts as copyable when its coin passed the rug screen, or, if the coin was never screened, when it was launched on
 * pump.fun (mint address ending in "pump": liquidity is the bonding curve, then burned at graduation). A coin the screen
 * blocked never counts.
 *
 * Measured one wallet at a time on its latest MAX_BUYS buys (a busy wallet's full history read cold held the event loop for
 * 15 s), yielding between wallets, junk wallets skipped (never copied), and kept for an hour: what a wallet buys changes slowly.
 */
import type { DB } from "@godseye/shared";

export interface Copyable {
  /** Buys over the window. */
  buys: number;
  /** Of those, buys of coins GodsEye could copy. */
  ok: number;
  at: number;
}

const cache = new Map<string, Copyable>();
const MAX_BUYS = 2000;

export const copyableOf = (address: string): Copyable | undefined => cache.get(address);

/** Measure the wallets not measured within `maxAgeMs`; returns how many were measured. */
export async function refreshCopyable(
  db: DB,
  addresses: string[],
  opts: { days?: number; maxAgeMs?: number; now?: number } = {},
): Promise<number> {
  const now = opts.now ?? Date.now();
  const since = new Date(now - (opts.days ?? 14) * 86_400_000).toISOString();
  const maxAge = opts.maxAgeMs ?? 3_600_000;
  const stmt = db.prepare(
    `SELECT COUNT(*) buys,
            COALESCE(SUM(CASE WHEN rc.verdict = 'pass' THEN 1 WHEN rc.verdict = 'blocked' THEN 0 WHEN sw.mint LIKE '%pump' THEN 1 ELSE 0 END), 0) ok
       FROM (SELECT mint FROM wallet_swaps WHERE wallet = ? AND side = 'buy' AND ts >= ? ORDER BY ts DESC LIMIT ${MAX_BUYS}) sw
       LEFT JOIN rug_checks rc ON rc.mint = sw.mint`,
  );
  const junk = db.prepare("SELECT 1 FROM wallets WHERE address = ? AND junk_reason IS NOT NULL AND copy_weight <= 0");
  let n = 0;
  for (const address of new Set(addresses)) {
    const had = cache.get(address);
    if (had && now - had.at < maxAge) continue;
    if (junk.get(address)) continue;
    const r = stmt.get(address, since) as { buys: number; ok: number };
    cache.set(address, { buys: r.buys, ok: r.ok, at: now });
    n++;
    await new Promise((resolve) => setImmediate(resolve));
  }
  return n;
}

/** Tests only. */
export const clearCopyable = (): void => cache.clear();
