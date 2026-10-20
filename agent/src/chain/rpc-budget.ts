/**
 * A steady cap on how fast GodsEye reads wallet history over RPC, so analysis never bursts past the
 * provider's requests-per-second limit (Shyft's plans are priced by RPC requests/second, not credits).
 * Every transaction inside a batch counts as one request. Copy-trading calls (watcher, executor) are
 * not metered: they must never wait behind history reads.
 */
import { config } from "../config";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let nextFree = 0;
/** Every metered request since start (never trimmed, so runs longer than an hour measure correctly). */
let total = 0;
/** Requests per minute, keyed by minute (epoch ms / 60 000), kept for an hour. */
const perMinute = new Map<number, number>();
/** Requests the RPC refused as rate-limited (each was retried after a pause), per minute. */
const throttledPerMinute = new Map<number, number>();

/** The RPC answered "too many requests": a sign RPC_MAX_RPS is above what the plan allows. */
export function noteThrottled(): void {
  const m = Math.floor(Date.now() / 60_000);
  throttledPerMinute.set(m, (throttledPerMinute.get(m) ?? 0) + 1);
  for (const k of throttledPerMinute.keys()) if (k < m - 60) throttledPerMinute.delete(k);
}

/** Wait for room for `n` requests, then count them. Spreads requests evenly at RPC_MAX_RPS. */
export async function takeRpc(n: number): Promise<void> {
  const rate = Math.max(1, config.rpcMaxRps);
  const now = Date.now();
  const start = Math.max(now, nextFree);
  nextFree = start + (n * 1000) / rate;
  if (start > now) await sleep(start - now);
  total += n;
  const m = Math.floor(Date.now() / 60_000);
  perMinute.set(m, (perMinute.get(m) ?? 0) + n);
  for (const k of perMinute.keys()) if (k < m - 60) perMinute.delete(k);
}

/** History RPC requests in the last `minutes`, their average per second, and the busiest minute's rate. */
export function rpcUsage(minutes = 60): { calls: number; avgPerSec: number; peakPerSec: number; throttled: number } {
  const m = Math.floor(Date.now() / 60_000);
  let calls = 0;
  let peak = 0;
  for (const [k, v] of perMinute) {
    if (k <= m - minutes) continue;
    calls += v;
    peak = Math.max(peak, v);
  }
  let throttled = 0;
  for (const [k, v] of throttledPerMinute) if (k > m - minutes) throttled += v;
  return { calls, avgPerSec: calls / (minutes * 60), peakPerSec: peak / 60, throttled };
}

/** Total metered requests so far (for measuring one run). */
export function rpcCallsSoFar(): number {
  return total;
}
