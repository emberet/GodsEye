/**
 * X (Twitter) API v2, read only, with the app's bearer token (X_BEARER_TOKEN): full-archive tweet search and the authors.
 *
 * Rate limits are per 15-minute window: on a 429 the client waits until `x-rate-limit-reset` (at most 15 min) and tries
 * again. Every read counts against the plan's monthly quota, so the month's totals are kept in agent_meta per budget:
 * the runner research ("research", X_MONTHLY_TWEET_CAP) and the private social layer ("social",
 * X_SOCIAL_MONTHLY_TWEET_CAP) are counted apart (1M a month in all, owner-confirmed), and each stops at its own cap.
 * What counts against a cap: posts read, profiles read (user lookups and the authors that come with a search) and post
 * counts (one per counts/all request), each in its own counter (shown to the owner) and summed for the cap
 * (spentThisMonth). No request asks for more than the month or the hour has left.
 *
 * PACING: no job can spend its month in hours. A budget reads at most 1/360 of its monthly cap in a clock hour (UTC), so
 * the cap lasts at least 15 days (500k a month → 1,388 an hour), but never less than one smallest page (10) an hour. Only
 * a test-sized cap (PACE_FLOOR or less) may be read in one hour. A request asks only for what is left of the hour; once
 * the hour is used up the call returns `capped` (reason "hour") at once, and the cron job ends its run instead of waiting
 * inside it for the next hour.
 *
 * BURN GUARD: a budget that spent more than BURN_FACTOR × its even hourly share (cap / 720) a clock hour over the last
 * BURN_HOURS hours (more than the pacing allows: a page that came back bigger than asked, profiles with a search) stops
 * (reason "burn") and says so on the server console, until the trailing hours fall back under it.
 * The token is never logged.
 */
import { type DB, getMeta, setMeta } from "@godseye/shared";
import { backoff } from "../backoff";
import { config } from "../config";
import { HttpError } from "../http";

const API = "https://api.x.com/2";
const MAX_RESETS = 2;
/** Full-archive search allows one request a second on top of the window limit. */
const PAGE_GAP_MS = 1_100;
const HOUR_MS = 3_600_000;
/** A budget's hourly share: its monthly cap over this many hours ... */
const PACE_HOURS = 360;
/** ... except a cap this small, a test's: it may all be read in one hour. */
const PACE_FLOOR = 1_000;
/** The burn guard: more than BURN_FACTOR × the even hourly share (cap / HOURS_IN_MONTH) an hour over BURN_HOURS stops. */
const BURN_FACTOR = 2;
const BURN_HOURS = 3;
const HOURS_IN_MONTH = 720;
/** The smallest page each endpoint takes. */
const MIN_SEARCH_RESULTS = 10;
const MIN_TIMELINE_RESULTS = 5;

export interface XUser {
  id: string;
  username: string;
  name?: string;
  created_at?: string;
  description?: string;
  verified?: boolean;
  public_metrics?: { followers_count?: number; following_count?: number; tweet_count?: number; listed_count?: number };
}

/** Links and @-mentions in a post (tweet.fields=entities): a link's expanded URL may carry an address the text hides. */
export interface XEntities {
  urls?: { expanded_url?: string; unwound_url?: string }[];
  mentions?: { username?: string; id?: string }[];
}

export interface XTweet {
  id: string;
  /** Cut at 280 characters for a long post: the whole text is in note_tweet. */
  text: string;
  author_id: string;
  created_at: string;
  public_metrics?: { like_count?: number; retweet_count?: number; reply_count?: number; quote_count?: number; impression_count?: number };
  entities?: XEntities;
  note_tweet?: { text?: string; entities?: XEntities };
}

interface SearchPage {
  data?: XTweet[];
  includes?: { users?: XUser[] };
  meta?: { result_count?: number; next_token?: string };
}

interface TimelinePage {
  data?: XTweet[];
  meta?: { result_count?: number; newest_id?: string; next_token?: string };
}

/** Who a read is counted against: the runner research (x/calls.ts) or the private social layer (social/). */
export type XBudget = "research" | "social";
/** Why a call fetched nothing: the month's cap, the hour's share (try next run), or the burn guard. */
export type XStop = "month" | "hour" | "burn";

const TWEET_FIELDS = "created_at,author_id,public_metrics,entities,note_tweet";
const USER_FIELDS = "username,name,created_at,description,public_metrics,verified";

export const xConfigured = (): boolean => !!config.xBearerToken;

const monthKey = (budget: XBudget, what: "tweets" | "users" | "counts" = "tweets", now = Date.now()) =>
  `x_${budget === "social" ? "social_" : ""}${what}_read_${new Date(now).toISOString().slice(0, 7)}`;
/** The monthly tweet cap of a budget. */
export const budgetCap = (budget: XBudget): number => (budget === "social" ? config.xSocialMonthlyTweetCap : config.xMonthlyTweetCap);
/** Tweets read this calendar month (UTC) under a budget (default: the runner research's). */
export const tweetsReadThisMonth = (db: DB, budget: XBudget = "research"): number => Number(getMeta(db, monthKey(budget)) ?? 0);
/** Everything read this month under a budget that counts against its cap: posts, profiles and post-count requests. */
export const spentThisMonth = (db: DB, budget: XBudget): number => tweetsReadThisMonth(db, budget) + usersReadThisMonth(db, budget) + countsReadThisMonth(db, budget);
/** True once a budget's month is used up: nothing more is fetched under it until next month. */
export const budgetSpent = (db: DB, budget: XBudget): boolean => spentThisMonth(db, budget) >= budgetCap(budget);
const countRead = (db: DB, budget: XBudget, n: number) => {
  setMeta(db, monthKey(budget), tweetsReadThisMonth(db, budget) + n);
  countHour(db, budget, n);
};
/** n more read this hour (every kind: the hour's share and the burn guard see them all). */
const countHour = (db: DB, budget: XBudget, n: number, now = Date.now()) => {
  if (!n) return;
  setMeta(db, hourKey(budget), `${hourStamp(now)} ${tweetsReadThisHour(db, budget, now) + n}`);
  const hours = burnHours(db, budget);
  hours[hourStamp(now)] = (hours[hourStamp(now)] ?? 0) + n;
  const keep = Object.keys(hours).sort().slice(-BURN_HOURS);
  setMeta(db, burnKey(budget), JSON.stringify(Object.fromEntries(keep.map((h) => [h, hours[h]]))));
};

// One key per budget holds "<hour> <posts read in it>": a new hour starts at 0 and no old keys pile up.
const hourKey = (budget: XBudget) => `x_${budget === "social" ? "social_" : ""}tweets_read_hour`;
const hourStamp = (now = Date.now()) => new Date(now).toISOString().slice(0, 13);
/** What a budget read in each of its last BURN_HOURS clock hours (UTC), by hour stamp. */
const burnKey = (budget: XBudget) => `x_${budget === "social" ? "social_" : ""}read_last_hours`;
const burnHours = (db: DB, budget: XBudget): Record<string, number> => {
  try {
    const v = JSON.parse(getMeta(db, burnKey(budget)) ?? "{}") as Record<string, number>;
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
};
/** Posts, profiles and counts read under a budget in the current clock hour (UTC). */
export const tweetsReadThisHour = (db: DB, budget: XBudget, now = Date.now()): number => {
  const [h, n] = (getMeta(db, hourKey(budget)) ?? "").split(" ");
  return h === hourStamp(now) ? Number(n) || 0 : 0;
};
/** The most posts a budget reads in one clock hour. */
export const hourlyCap = (budget: XBudget): number => {
  const cap = budgetCap(budget);
  return Math.max(MIN_SEARCH_RESULTS, cap <= PACE_FLOOR ? cap : Math.floor(cap / PACE_HOURS));
};

/** The burn guard's limit: what a budget may read over the last BURN_HOURS clock hours (Infinity for a test-sized cap). */
export const burnLimit = (budget: XBudget): number => {
  const cap = budgetCap(budget);
  return cap <= PACE_FLOOR ? Infinity : (BURN_FACTOR * BURN_HOURS * cap) / HOURS_IN_MONTH;
};
/** What a budget read over the last BURN_HOURS clock hours (this one included). */
export const readLastHours = (db: DB, budget: XBudget, now = Date.now()): number => {
  const from = hourStamp(now - (BURN_HOURS - 1) * HOUR_MS);
  return Object.entries(burnHours(db, budget)).reduce((n, [h, v]) => (h >= from && h <= hourStamp(now) ? n + (Number(v) || 0) : n), 0);
};
const burnWarned = new Map<XBudget, string>();
/** Over the burn limit? Stops the budget, said once an hour on the server console. */
export function burning(db: DB, budget: XBudget, now = Date.now()): boolean {
  const read = readLastHours(db, budget, now);
  if (read <= burnLimit(budget)) return false;
  if (burnWarned.get(budget) !== hourStamp(now)) {
    burnWarned.set(budget, hourStamp(now));
    console.warn(`[x] ${budget} budget: ${read} read in ${BURN_HOURS} h, over ${BURN_FACTOR}× its hourly share (${Math.floor(burnLimit(budget))}): stopped until it falls back`);
  }
  return true;
}

/**
 * Why nothing may be read under a budget now (month, burn), else null. `need` = the least the next request reads.
 */
function stopped(db: DB, budget: XBudget, need = 1): XStop | null {
  if (budgetCap(budget) - spentThisMonth(db, budget) < need) return "month";
  if (burning(db, budget)) return "burn";
  return null;
}

/**
 * How many the next request may ask for (between `min` and `want`): no more than the hour's share and the month have
 * left. null = not even `min` is left this hour: the caller skips its run (reason "hour") instead of waiting for the next.
 */
function paced(db: DB, budget: XBudget, want: number, min: number): number | null {
  const room = Math.min(hourlyCap(budget) - tweetsReadThisHour(db, budget), budgetCap(budget) - spentThisMonth(db, budget));
  return room < min ? null : Math.min(want, room);
}
/** Profiles read this calendar month (UTC) under a budget: user lookups plus the authors returned with searches. */
export const usersReadThisMonth = (db: DB, budget: XBudget = "research"): number => Number(getMeta(db, monthKey(budget, "users")) ?? 0);
const countUsers = (db: DB, budget: XBudget, n: number) => {
  if (!n) return;
  setMeta(db, monthKey(budget, "users"), usersReadThisMonth(db, budget) + n);
  countHour(db, budget, n);
};
/** Post-count requests (counts/all) made this calendar month (UTC) under a budget: they return no posts. */
export const countsReadThisMonth = (db: DB, budget: XBudget = "research"): number => Number(getMeta(db, monthKey(budget, "counts")) ?? 0);

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
 * Every tweet matching `query` between `from` and `to` (ISO), with the authors, up to `maxPages` pages of `maxResults`
 * (10–500, less when the hour's share is nearly used: see PACING). Stops early (`capped`, with the reason) at the
 * monthly cap, the hour's share or the burn guard.
 */
export async function searchAll(
  db: DB, query: string, from: string, to: string, maxPages = 3, budget: XBudget = "research", maxResults = 500,
): Promise<{ tweets: XTweet[]; users: XUser[]; capped: boolean; reason?: XStop }> {
  const tweets: XTweet[] = [];
  const users = new Map<string, XUser>();
  let next: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const stop = stopped(db, budget, MIN_SEARCH_RESULTS);
    if (stop) return { tweets, users: [...users.values()], capped: true, reason: stop };
    const size = paced(db, budget, Math.min(500, Math.max(MIN_SEARCH_RESULTS, Math.round(maxResults))), MIN_SEARCH_RESULTS);
    if (size === null) return { tweets, users: [...users.values()], capped: true, reason: "hour" };
    if (page) await backoff(PAGE_GAP_MS);
    const params: Record<string, string> = {
      query, start_time: from, end_time: to, max_results: String(size),
      "tweet.fields": TWEET_FIELDS, expansions: "author_id", "user.fields": USER_FIELDS,
    };
    if (next) params.next_token = next;
    const r = await xGet<SearchPage>("/tweets/search/all", params);
    const got = r.data ?? [];
    tweets.push(...got);
    for (const u of r.includes?.users ?? []) users.set(u.id, u);
    countRead(db, budget, got.length);
    countUsers(db, budget, r.includes?.users?.length ?? 0);
    next = r.meta?.next_token;
    if (!next) break;
  }
  return { tweets, users: [...users.values()], capped: false };
}

/** The newer of two post ids (numeric strings: longer is newer, then by digits). */
const newerId = (a: string | undefined, b: string): string => (a === undefined || b.length > a.length || (b.length === a.length && b > a) ? b : a);

/**
 * An account's latest tweets (one page, 5–100, retweets left out), newer than `sinceId` when given, and the newest id
 * the page returned (meta.newest_id; undefined when it returned none): the caller's next `sinceId` for this timeline.
 * `more`: X has more posts past this page (meta.next_token): with a `sinceId`, posts between it and the page's oldest
 * weren't read. Counted against `budget`; nothing is fetched (`capped`) at its monthly cap, the hour's share or the burn
 * guard.
 */
export async function userTweets(
  db: DB, userId: string, budget: XBudget, opts: { max?: number; sinceId?: string } = {},
): Promise<{ tweets: XTweet[]; newestId?: string; more?: boolean; capped: boolean; reason?: XStop }> {
  const stop = stopped(db, budget, MIN_TIMELINE_RESULTS);
  if (stop) return { tweets: [], capped: true, reason: stop };
  const size = paced(db, budget, Math.min(100, Math.max(MIN_TIMELINE_RESULTS, Math.round(opts.max ?? 20))), MIN_TIMELINE_RESULTS);
  if (size === null) return { tweets: [], capped: true, reason: "hour" };
  const params: Record<string, string> = { max_results: String(size), exclude: "retweets", "tweet.fields": TWEET_FIELDS };
  if (opts.sinceId) params.since_id = opts.sinceId;
  const r = await xGet<TimelinePage>(`/users/${encodeURIComponent(userId)}/tweets`, params);
  const tweets = (r.data ?? []).map((t) => ({ ...t, author_id: t.author_id ?? userId }));
  countRead(db, budget, tweets.length);
  const newestId = r.meta?.newest_id ?? tweets.reduce<string | undefined>((a, t) => newerId(a, t.id), undefined);
  return { tweets, newestId, more: !!r.meta?.next_token, capped: false };
}

/**
 * Profiles by id, 100 a request (fewer when the month or the hour has less left). Each profile read counts against the
 * budget's cap and its hour (in the profile counter, not the tweet count); nothing more is fetched (`capped`) at the cap,
 * the hour's share or the burn guard. Unknown or suspended ids are left out.
 */
export async function lookupUsers(db: DB, ids: string[], budget: XBudget): Promise<{ users: XUser[]; capped: boolean; reason?: XStop }> {
  const users: XUser[] = [];
  for (let i = 0; i < ids.length; ) {
    const stop = stopped(db, budget);
    if (stop) return { users, capped: true, reason: stop };
    const n = paced(db, budget, Math.min(100, ids.length - i), 1);
    if (n === null) return { users, capped: true, reason: "hour" };
    const r = await xGet<{ data?: XUser[] }>("/users", { ids: ids.slice(i, i + n).join(","), "user.fields": USER_FIELDS });
    users.push(...(r.data ?? []));
    countUsers(db, budget, r.data?.length ?? 0);
    i += n;
  }
  return { users, capped: false };
}

/**
 * How many posts match `query` between `from` and `to` (counts/all, by day). Returns no posts: the collector asks before
 * a search and skips the search at 0. Each request counts one against the budget's cap and its hour (in its own
 * counter); nothing is fetched (`capped`) at the cap, the hour's share or the burn guard.
 */
export async function countAll(db: DB, query: string, from: string, to: string, budget: XBudget): Promise<{ count: number; capped: boolean; reason?: XStop }> {
  const stop = stopped(db, budget);
  if (stop) return { count: 0, capped: true, reason: stop };
  if (paced(db, budget, 1, 1) === null) return { count: 0, capped: true, reason: "hour" };
  const r = await xGet<{ meta?: { total_tweet_count?: number } }>("/tweets/counts/all", { query, start_time: from, end_time: to, granularity: "day" });
  setMeta(db, monthKey(budget, "counts"), countsReadThisMonth(db, budget) + 1);
  countHour(db, budget, 1);
  return { count: Number(r.meta?.total_tweet_count ?? 0), capped: false };
}
