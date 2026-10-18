"use client";
import { useCallback, useEffect, useRef, useState } from "react";

/** Fetches `url` now and every `intervalMs` (default 10s). */
export function usePoll<T>(url: string, intervalMs = 10_000) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const alive = useRef(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `${res.status} ${res.statusText}`);
      }
      const json = (await res.json()) as T;
      if (alive.current) {
        setData(json);
        setError(null);
        setUpdatedAt(new Date());
      }
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    }
  }, [url]);

  useEffect(() => {
    alive.current = true;
    void load();
    const id = setInterval(load, intervalMs);
    return () => {
      alive.current = false;
      clearInterval(id);
    };
  }, [load, intervalMs]);

  return { data, error, updatedAt, reload: load };
}
