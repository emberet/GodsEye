import "server-only";
import { NextResponse } from "next/server";
import { fullFeedEnabled, publicView, type PublicFeed } from "@godseye/shared/public-view";
import { hosted } from "./data";
export { intParam } from "./params";

/**
 * The agent's own address, so that no text naming it leaves this server. Only a site running next to GodsEye can know
 * it (from GodsEye's database); the published copy a hosted site reads never holds it.
 */
async function ownWallet(): Promise<string | null> {
  if (hosted()) return null;
  return (await import("./queries")).ownWallet();
}

/**
 * Wraps a GET handler for the public API: read-only data, short shared caching, a plain JSON error
 * (no stack trace, no database path) when the data can't be read, and only the public view of each
 * feed (see shared/src/public-view.ts). The owner's full view needs GODSEYE_FULL_FEED=1 on a site started
 * with `npm run dashboard`; a production build and Vercel ignore the switch.
 */
export function apiRoute<A extends unknown[]>(handler: (...args: A) => Promise<Response> | Response, feed: PublicFeed, maxAgeSec = 5) {
  return async (...args: A): Promise<Response> => {
    try {
      let res = await handler(...args);
      if (res.ok && !fullFeedEnabled() && res.headers.get("content-type")?.includes("application/json")) {
        const body = publicView(feed, await res.json(), await ownWallet());
        const headers = new Headers(res.headers);
        headers.delete("content-length");
        res = NextResponse.json(body, { status: res.status, headers });
      }
      if (res.ok && !res.headers.has("cache-control")) res.headers.set("cache-control", `public, max-age=0, s-maxage=${maxAgeSec}, stale-while-revalidate=${maxAgeSec * 4}`);
      return res;
    } catch (e) {
      console.error(`API error: ${(e as Error).message}`);
      return NextResponse.json({ error: "Data is unavailable right now (the database couldn't be read). Try again shortly." }, { status: 503, headers: { "cache-control": "no-store" } });
    }
  };
}
