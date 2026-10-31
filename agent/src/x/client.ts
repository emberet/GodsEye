/**
 * X (Twitter) API v2, read only, with the app's bearer token (X_BEARER_TOKEN): full-archive tweet search and the authors.
 *
 * Rate limits are per 15-minute window: on a 429 the client waits until `x-rate-limit-reset` (at most 15 min) and tries
 * again. Every tweet read counts against the plan's monthly quota, so the month's total is kept in agent_meta and searches
 * stop at X_MONTHLY_TWEET_CAP. The token is never logged.
 */
import { type DB, getMeta, setMeta } from "@godseye/shared";
import { backoff } from "../backoff";
import { config } from "../config";
import { HttpError } from "../http";

const API = "https://api.x.com/2";
const MAX_RESETS = 2;
/** Full-archive search allows one request a second on top of the window limit. */
const PAGE_GAP_MS = 1_100;

export interface XUser {
  id: string;
  username: string;
  name?: string;
  created_at?: string;
  description?: string;
  public_metrics?: { followers_count?: number };
}

export interface XTweet {
  id: string;
  text: string;
  author_id: string;
  created_at: string;
  public_metrics?: { like_count?: number; retweet_count?: number; reply_count?: number; quote_count?: number; impression_count?: number };
}

interface SearchPage {
  data?: XTweet[];
  includes?: { users?: XUser[] };
  meta?: { result_count?: number; next_token?: string };
}

export const xConfigured = (): boolean => !!config.xBearerToken;

const monthKey = (now = Date.now()) => `x_tweets_read_${new Date(now).toISOString().slice(0, 7)}`;
export const tweetsReadThisMonth = (db: DB): number => Number(getMeta(db, monthKey()) ?? 0);

/** GET an X API path; waits out rate limits (x-rate-limit-reset). Throws HttpError on other failures. */
export async function xGet<T>(path: string, params: Record<string, string>): Promise<T> {
  const url = `${API}${path}?${new URLSearchParams(params)}`;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { authorization: `Bearer ${config.xBearerToken}`, "user-agent": "godseye/0.1" }, signal: AbortSignal.timeout(30_000) });
    if (res.ok) return (await res.json()) as T;
    const body = (await res.text().catch(() => "")).slice(0, 200);
    if (res.status === 429 && attempt < MAX_RESETS) {
      const reset = Number(res.headers.get("x-rate-limit-reset"));
      const waitMs = Number.isFinite(reset) && reset > 0 ? Math.min(15 * 60_000, Math.max(1_000, reset * 1000 - Date.now() + 1_000)) : 60_000;
      await backoff(waitMs);
      continue;
    }
    throw new HttpError(res.status, `${res.status} from X ${path}: ${body}`);
  }
}

/**
 * Every tweet matching `query` between `from` and `to` (ISO), with the authors, up to `maxPages` pages of 500.
 * Stops early (`capped`) once the month's quota is reached.
 */
export async function searchAll(db: DB, query: string, from: string, to: string, maxPages = 3): Promise<{ tweets: XTweet[]; users: XUser[]; capped: boolean }> {
  const tweets: XTweet[] = [];
  const users = new Map<string, XUser>();
  let next: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    if (tweetsReadThisMonth(db) >= config.xMonthlyTweetCap) return { tweets, users: [...users.values()], capped: true };
    if (page) await backoff(PAGE_GAP_MS);
    const params: Record<string, string> = {
      query, start_time: from, end_time: to, max_results: "500",
      "tweet.fields": "created_at,author_id,public_metrics", expansions: "author_id", "user.fields": "username,name,created_at,description,public_metrics",
    };
    if (next) params.next_token = next;
    const r = await xGet<SearchPage>("/tweets/search/all", params);
    const got = r.data ?? [];
    tweets.push(...got);
    for (const u of r.includes?.users ?? []) users.set(u.id, u);
    setMeta(db, monthKey(), tweetsReadThisMonth(db) + got.length);
    next = r.meta?.next_token;
    if (!next) break;
  }
  return { tweets, users: [...users.values()], capped: false };
}
