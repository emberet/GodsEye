import { backoff } from "./backoff";

/** Small fetch helper: timeouts + a retry, so one flaky API doesn't stop GodsEye. */
export async function fetchJson<T = unknown>(
  url: string,
  init: RequestInit & { timeoutMs?: number; retries?: number } = {},
): Promise<T> {
  const { timeoutMs = 15_000, retries = 1, ...rest } = init;
  let lastErr: unknown;
  let rateLimited = false;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        ...rest,
        headers: { accept: "application/json", "user-agent": "godseye/0.1", ...(rest.headers ?? {}) },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        const err = new HttpError(res.status, `${res.status} ${res.statusText} from ${new URL(url).host}: ${body.slice(0, 200)}`);
        // don't retry client errors except rate limits
        if (res.status < 500 && res.status !== 429) throw err;
        rateLimited = res.status === 429;
        lastErr = err;
      } else {
        return (await res.json()) as T;
      }
    } catch (e) {
      if (e instanceof HttpError && e.status < 500 && e.status !== 429) throw e;
      lastErr = e;
    }
    // Rate-limited? Wait longer before trying again.
    if (attempt < retries) await backoff((rateLimited ? 6000 : 1500) * (attempt + 1));
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
