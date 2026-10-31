/**
 * Job runner for the agent's scheduled work.
 *
 * A tick is skipped while the previous run of the same job is still going (never two copies at once).
 * Skips used to be silent: when a learning run hung on a websocket/RPC call that never settled, every later
 * learning tick was dropped without a trace and last_learning_at froze. Now:
 *   • a skipped tick logs a warning (rate-limited per job);
 *   • a run past its max runtime logs a warning (rate-limited);
 *   • jobs marked `releaseAfterMaxRuntime` (no trading side effects) have their slot freed once past max
 *     runtime, so a hung run cannot block its own schedule forever. The abandoned run keeps no lock: when it
 *     finally settles it cannot clear the slot of a newer run. Trading jobs are never released.
 */

/** Rejects with a timeout error if `p` has not settled within `ms`. */
export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

export interface JobOpts {
  /** Warn once a run has gone this long. */
  maxRuntimeMs?: number;
  /** Free the job's slot once past max runtime (only for jobs that cannot trade). */
  releaseAfterMaxRuntime?: boolean;
}

export interface JobRunnerDeps {
  warn: (msg: string) => void;
  error: (msg: string) => void;
  now?: () => number;
  /** Minimum gap between repeated warnings of the same kind for the same job. */
  warnEveryMs?: number;
}

export function createJobRunner(deps: JobRunnerDeps) {
  const now = deps.now ?? Date.now;
  const warnEvery = deps.warnEveryMs ?? 15 * 60_000;
  const running = new Map<string, { token: object; startedAt: number }>();
  const lastWarn = new Map<string, number>();
  const skipped = new Map<string, number>();

  const rateLimited = (key: string, msg: string) => {
    const t = now();
    const last = lastWarn.get(key);
    if (last !== undefined && t - last < warnEvery) return;
    lastWarn.set(key, t);
    deps.warn(msg);
  };

  /** Runs `fn` unless the same job is still going. Resolves true if it ran. */
  async function run(name: string, fn: () => Promise<void>, opts: JobOpts = {}): Promise<boolean> {
    const cur = running.get(name);
    if (cur) {
      const age = now() - cur.startedAt;
      if (opts.maxRuntimeMs !== undefined && age > opts.maxRuntimeMs) {
        if (opts.releaseAfterMaxRuntime) {
          deps.warn(`${name} run exceeded max runtime (${Math.round(age / 1000)} s > ${Math.round(opts.maxRuntimeMs / 1000)} s); abandoning it and starting a new run.`);
          running.delete(name);
        } else {
          rateLimited(`max:${name}`, `${name} run exceeded max runtime (${Math.round(age / 1000)} s > ${Math.round(opts.maxRuntimeMs / 1000)} s); still waiting for it (not restarted: this job can trade).`);
        }
      }
      if (running.has(name)) {
        const n = (skipped.get(name) ?? 0) + 1;
        skipped.set(name, n);
        rateLimited(`skip:${name}`, `${name} tick skipped: previous run still going after ${Math.round(age / 1000)} s (${n} skipped so far).`);
        return false;
      }
    }
    const token = {};
    running.set(name, { token, startedAt: now() });
    skipped.delete(name);
    try {
      await fn();
    } catch (e) {
      deps.error(`${name} failed: ${(e as Error).message}`);
    } finally {
      if (running.get(name)?.token === token) running.delete(name);
    }
    return true;
  }

  /** Names of the jobs currently holding a slot (for the event-loop and slow-SQL logs). */
  const names = (): string[] => [...running.keys()];
  return { run, isRunning: (name: string) => running.has(name), names };
}
