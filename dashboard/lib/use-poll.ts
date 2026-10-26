"use client";
import { useCallback, useEffect, useRef, useState } from "react";

/** Requests for the same URL within this window share one fetch (the summary feeds several components). */
const SHARE_MS = 2_000;
const shared = new Map<string, { at: number; promise: Promise<unknown> }>();

async function getJson<T>(url: string, signal: AbortSignal): Promise<T> {
  const hit = shared.get(url);
  if (hit && Date.now() - hit.at < SHARE_MS) return hit.promise as Promise<T>;
  const promise = (async () => {
    const res = await fetch(url, { cache: "no-store", signal });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      throw Object.assign(new Error(body?.error ?? `${res.status} ${res.statusText}`), { status: res.status });
    }
    return (await res.json()) as T;
  })();
  shared.set(url, { at: Date.now(), promise });
  promise.catch(() => shared.delete(url));
  return promise;
}

/**
 * Fetches `url` now and every `intervalMs` (default 10s).
 *   • a response for a URL the component has moved away from (filters changed) is dropped
 *   • polling pauses while the tab is hidden and catches up when it's shown again
 *   • after errors it backs off (up to 4× the interval) and keeps the last good data, flagged as stale
 */
export function usePoll<T>(url: string, intervalMs = 10_000) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<number | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const current = useRef(url);
  const failures = useRef(0);
  current.current = url;

  const load = useCallback(async () => {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 20_000);
    try {
      const json = await getJson<T>(url, ctrl.signal);
      if (current.current !== url) return;
      failures.current = 0;
      setData(json);
      setError(null);
      setStatus(200);
      setUpdatedAt(new Date());
    } catch (e) {
      if (current.current !== url) return;
      failures.current++;
      setError((e as Error).name === "AbortError" ? "The request timed out" : (e as Error).message);
      setStatus((e as { status?: number }).status ?? null);
    } finally {
      clearTimeout(timeout);
    }
  }, [url]);

  useEffect(() => {
    // A new URL starts clean: never show the previous filter's rows under the new one.
    setData(null);
    setError(null);
    setStatus(null);
    failures.current = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const tick = async () => {
      if (!document.hidden) await load();
      if (stopped) return;
      timer = setTimeout(tick, intervalMs * Math.min(4, 2 ** failures.current));
    };
    const onShow = () => {
      if (document.hidden || stopped) return;
      clearTimeout(timer);
      void tick();
    };
    void tick();
    document.addEventListener("visibilitychange", onShow);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onShow);
    };
  }, [load, intervalMs]);

  /** Last good data is on screen but the latest refresh failed. */
  const stale = !!error && data !== null;
  return { data, error, status, stale, updatedAt, reload: load };
}
