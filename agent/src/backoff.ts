/** Waits used between retries. Tests set `retryTiming.scale = 0` so retry paths run instantly. */
export const retryTiming = { scale: 1 };
export const backoff = (ms: number) => new Promise<void>((r) => setTimeout(r, ms * retryTiming.scale));
