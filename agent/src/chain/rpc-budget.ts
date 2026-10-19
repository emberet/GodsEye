/**
 * A steady cap on how fast GodsEye reads wallet history over RPC, so analysis never bursts past the
 * provider's requests-per-second limit (Shyft's plans are priced by RPC requests/second, not credits).
 * Every transaction inside a batch counts as one request. Copy-trading calls (watcher, executor) are
 * not metered: they must never wait behind history reads.
 */
import { config } from "../config";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let nextFree = 0;
/** Requests per minute, keyed by minute (epoch ms / 60 000), kept for an hour. */
const perMinute = new Map<number, number>();

/** Wait for room for `n` requests, then count them. Spreads requests evenly at RPC_MAX_RPS. */
export async function takeRpc(n: number): Promise<void> {
  const rate = Math.max(1, config.rpcMaxRps);
  const now = Date.now();
  const start = Math.max(now, nextFree);
  nextFree = start + (n * 1000) / rate;
  if (start > now) await sleep(start - now);
  const m = Math.floor(Date.now() / 60_000);
  perMinute.set(m, (perMinute.get(m) ?? 0) + n);
  for (const k of perMinute.keys()) if (k < m - 60) perMinute.delete(k);
}

/** History RPC requests in the last `minutes`, their average per second, and the busiest minute's rate. */
export function rpcUsage(minutes = 60): { calls: number; avgPerSec: number; peakPerSec: number } {
  const m = Math.floor(Date.now() / 60_000);
  let calls = 0;
  let peak = 0;
  for (const [k, v] of perMinute) {
    if (k <= m - minutes) continue;
    calls += v;
    peak = Math.max(peak, v);
  }
  return { calls, avgPerSec: calls / (minutes * 60), peakPerSec: peak / 60 };
}

/** Total metered requests so far (for measuring one run). */
export function rpcCallsSoFar(): number {
  let n = 0;
  for (const v of perMinute.values()) n += v;
  return n;
}
