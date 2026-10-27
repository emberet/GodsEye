/**
 * Options for every cron job. node-cron checks the clock once a second and, by default, silently drops a run
 * whose second passed while the event loop was busy: the 5-minute smart-money job fires in the same second as
 * the learning loop and can hold the loop past it, which skipped learning runs. Recovering missed executions
 * runs them as soon as the loop is free (the job() guard still stops a job overlapping itself).
 */
export const CRON_OPTS = { timezone: "UTC", recoverMissedExecutions: true } as const;
