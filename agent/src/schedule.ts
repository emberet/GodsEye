/**
 * Every cron job is scheduled through `every`.
 *
 * node-cron checks the clock once a second and, by default, silently drops a run whose second passed while the
 * event loop was busy: the 5-minute smart-money job fires in the same second as the learning loop and can hold
 * the loop past it, which skipped learning runs. So missed executions are recovered. But node-cron's recovery
 * compares the last run (rounded to the second) with an unrounded time, and re-fires a run that already
 * happened when the loop is busy right after it (03:45 on 27 Oct ran twice). Every schedule here is per
 * minute or coarser, so a second run in the same minute is that duplicate and is dropped.
 */
import cron from "node-cron";

export const CRON_OPTS = { timezone: "UTC", recoverMissedExecutions: true } as const;

/** `fn`, but called at most once per clock minute (later calls in the same minute do nothing). */
export function oncePerMinute(fn: () => unknown, clock: () => number = Date.now): () => void {
  let lastMinute = -1;
  return () => {
    const minute = Math.floor(clock() / 60_000);
    if (minute === lastMinute) return;
    lastMinute = minute;
    fn();
  };
}

/** Run `fn` on the cron schedule `expr` (minute resolution): missed runs are recovered, each minute runs once. */
export function every(expr: string, fn: () => unknown): cron.ScheduledTask {
  if (expr.trim().split(/\s+/).length > 5) throw new Error(`"${expr}": schedules are per minute at most (no seconds field)`);
  return cron.schedule(expr, oncePerMinute(fn), CRON_OPTS);
}
