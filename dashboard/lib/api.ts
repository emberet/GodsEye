import "server-only";
import { NextResponse } from "next/server";
export { intParam } from "./params";

/**
 * Wraps a GET handler for the public API: read-only data, short shared caching, and a plain JSON error
 * (no stack trace, no database path) when the data can't be read.
 */
export function apiRoute<A extends unknown[]>(handler: (...args: A) => Promise<Response> | Response, maxAgeSec = 5) {
  return async (...args: A): Promise<Response> => {
    try {
      const res = await handler(...args);
      if (res.ok && !res.headers.has("cache-control")) res.headers.set("cache-control", `public, max-age=0, s-maxage=${maxAgeSec}, stale-while-revalidate=${maxAgeSec * 4}`);
      return res;
    } catch (e) {
      console.error(`API error: ${(e as Error).message}`);
      return NextResponse.json({ error: "Data is unavailable right now (the database couldn't be read). Try again shortly." }, { status: 503, headers: { "cache-control": "no-store" } });
    }
  };
}
