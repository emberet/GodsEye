/**
 * A steady cap on how fast GodsEye reads wallet history over RPC, so analysis never bursts past the
 * provider's requests-per-second limit (Shyft's plans are priced by RPC requests/second, not credits).
 * Every transaction inside a batch counts as one request. Copy-trading calls (watcher, executor) are
 * never delayed: they must never wait behind history reads. Instead a share of the budget
 * (RPC_COPY_RESERVE, default 20%) is set aside for them: history reads are paced at the remaining share,
 * and slow down further while copy-engine calls (noteCopyRpc) run above their reserve.
 */
import { config, copyRpcUrl, rpcUrl } from "../config";

/** The copy path has its own RPC (COPY_RPC_URL or Helius): nothing to reserve or yield on the main one. */
const copyHasOwnRpc = () => copyRpcUrl() !== rpcUrl();

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

/** Copy-engine RPC calls in the current and previous second (sliding window for the reserve guard). */
let copyWindow = { sec: 0, cur: 0, prev: 0 };

/** Count copy-engine RPC calls (never delayed; they only reduce the room left for analysis). */
export function noteCopyRpc(n = 1, now = Date.now()): void {
  if (copyHasOwnRpc()) return;
  const sec = Math.floor(now / 1000);
  if (sec !== copyWindow.sec) copyWindow = { sec, cur: 0, prev: sec - copyWindow.sec === 1 ? copyWindow.cur : 0 };
  copyWindow.cur += n;
}

/** Copy-engine calls per second right now (the busier of this and the last second). */
export function copyRpcRate(now = Date.now()): number {
  const sec = Math.floor(now / 1000);
  if (sec === copyWindow.sec) return Math.max(copyWindow.cur, copyWindow.prev);
  if (sec - copyWindow.sec === 1) return copyWindow.cur;
  return 0;
}

/**
 * Requests per second analysis may use: RPC_MAX_RPS minus the copy reserve, minus whatever copy
 * calls currently use beyond that reserve. Never below 1 (analysis slows down, it never stops forever).
 */
export function analysisRate(maxRps: number, reserve: number, copyRps: number): number {
  const max = Math.max(1, maxRps);
  const reserved = max * reserve;
  const overflow = Math.max(0, copyRps - reserved);
  return Math.max(1, max - reserved - overflow);
}

/** Wait for room for `n` requests, then count them. Spreads history reads evenly at the analysis share of RPC_MAX_RPS. */
export async function takeRpc(n: number): Promise<void> {
  const rate = copyHasOwnRpc() ? Math.max(1, config.rpcMaxRps) : analysisRate(config.rpcMaxRps, config.rpcCopyReserve, copyRpcRate());
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
