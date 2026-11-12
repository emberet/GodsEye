/**
 * X (Twitter) API v2, read only, with the app's bearer token (X_BEARER_TOKEN): full-archive tweet search and the authors.
 *
 * X BILLS PER READ, so the budget is in dollars: X_MONTHLY_USD for a calendar month (UTC), shared out between the
 * runner research ("research") and the private social layer ("social") so that neither can use up the other's part; the
 * rest is spare. One price table (PRICE) turns what was read into money: posts, profiles (user lookups and the authors
 * that come with a search) and post-count requests, each kept in its own monthly counter in agent_meta. No request asks
 * for more than the month or the day has left. X does not bill the same post or profile twice in one day, so the
 * agent's own count is the most the bill can be.
 *
 * PACING: no job can spend its month in hours. A budget spends at most 1/15 of its month in one day (UTC), but never
 * less than a post count and the smallest search page with its authors. Only a test-sized budget (PACE_FLOOR or less)
 * may go in one day.
 * A request asks only for what the day has left; once the day's share is spent the call returns `capped` (reason "day")
 * at once, and the cron job ends its run instead of waiting inside it.
 *
 * REFUSED: when X answers that the account is out of credits (402) or over its usage cap (a 429 that says so), waiting
 * does not help. The call returns `capped` (reason "refused") at once, the reason is kept in a private agent_meta row
 * (xRefusal) and the owner is told, once a day while it lasts. The first good answer clears the row.
 *
 * Rate limits are per 15-minute window: on any other 429 the client waits until `x-rate-limit-reset` (at most 15 min)
 * and tries again. The token is never logged, and an owner alert carries nothing X answered.
 */
import { type DB, getMeta, setMeta } from "@godseye/shared";
import { alert, howLong } from "../alerts";
import { backoff } from "../backoff";
import { config } from "../config";
import { HttpError } from "../http";

const API = "https://api.x.com/2";
const MAX_RESETS = 2;
/** Full-archive search allows one request a second on top of the window limit. */
const PAGE_GAP_MS = 1_100;
const HOUR_MS = 3_600_000;
/** What X charges for one read, in thousandths of a dollar (X's pricing page, read on 2026-11-12). */
export const PRICE = { post: 5, profile: 10, count: 10 } as const;
/** Each budget's part of X_MONTHLY_USD, in percent. The rest is spare. */
const SHARE: Record<XBudget, number> = { research: 50, social: 40 };
/** A budget's share for one day: its month over this many days ... */
const PACE_DAYS = 15;
/** ... except a budget this small (a dollar: a test's), which may all go in one day. */
const PACE_FLOOR = 1_000;
/** The smallest page each endpoint takes. */
const MIN_SEARCH_RESULTS = 10;
const MIN_TIMELINE_RESULTS = 5;
/** How a 429 says that it is the usage cap, and not the 15-minute rate limit. */
const USAGE_CAP = /usage-capped|UsageCapExceeded|usage cap exceeded/i;

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
/** Why a call fetched nothing: the month's money is spent, the day's share is spent (try tomorrow), or X refuses reads. */
export type XStop = "month" | "day" | "refused";

const TWEET_FIELDS = "created_at,author_id,public_metrics,entities,note_tweet";
const USER_FIELDS = "username,name,created_at,description,public_metrics,verified";

export const xConfigured = (): boolean => !!config.xBearerToken;

/** Thousandths of a dollar the way the owner reads them: "$12.34". */
export const usd = (mills: number): string => `$${(mills / 1000).toFixed(2)}`;

const monthKey = (budget: XBudget, what: "tweets" | "users" | "counts" = "tweets", now = Date.now()) =>
  `x_${budget === "social" ? "social_" : ""}${what}_read_${new Date(now).toISOString().slice(0, 7)}`;
/** A budget's money for the month, in thousandths of a dollar. X_MONTHLY_USD=0 reads nothing. */
export const budgetCap = (budget: XBudget): number => Math.floor(Math.max(0, config.xMonthlyUsd) * 10 * SHARE[budget]);
/** Tweets read this calendar month (UTC) under a budget (default: the runner research's). */
export const tweetsReadThisMonth = (db: DB, budget: XBudget = "research"): number => Number(getMeta(db, monthKey(budget)) ?? 0);
/** Profiles read this calendar month (UTC) under a budget: user lookups plus the authors returned with searches. */
export const usersReadThisMonth = (db: DB, budget: XBudget = "research"): number => Number(getMeta(db, monthKey(budget, "users")) ?? 0);
/** Post-count requests (counts/all) made this calendar month (UTC) under a budget: they return no posts. */
export const countsReadThisMonth = (db: DB, budget: XBudget = "research"): number => Number(getMeta(db, monthKey(budget, "counts")) ?? 0);
/** What a budget's reads cost this month, in thousandths of a dollar: posts, profiles and post-count requests. */
export const spentThisMonth = (db: DB, budget: XBudget): number =>
  tweetsReadThisMonth(db, budget) * PRICE.post + usersReadThisMonth(db, budget) * PRICE.profile + countsReadThisMonth(db, budget) * PRICE.count;
/** True once a budget's month is used up: nothing more is fetched under it until next month. */
export const budgetSpent = (db: DB, budget: XBudget): boolean => spentThisMonth(db, budget) >= budgetCap(budget);

// One key per budget holds "<day> <thousandths of a dollar spent in it>": a new day starts at 0 and no old keys pile up.
const dayKey = (budget: XBudget) => `x_${budget === "social" ? "social_" : ""}spent_day`;
const dayStamp = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);
/** What a budget's reads cost so far today (UTC), in thousandths of a dollar. */
export const spentToday = (db: DB, budget: XBudget, now = Date.now()): number => {
  const [d, n] = (getMeta(db, dayKey(budget)) ?? "").split(" ");
  return d === dayStamp(now) ? Number(n) || 0 : 0;
};
/** The most the smallest search page can cost, in thousandths of a dollar: every post may bring an author of its own. */
export const smallestSearch = (authors = true): number => MIN_SEARCH_RESULTS * (PRICE.post + (authors ? PRICE.profile : 0));
/** The most a budget spends in one day, in thousandths of a dollar. */
export const dayShare = (budget: XBudget): number => {
  const cap = budgetCap(budget);
  return cap <= PACE_FLOOR ? cap : Math.max(PRICE.count + smallestSearch(), Math.floor(cap / PACE_DAYS));
};

/**
 * How many the next request may ask for (between `min` and `want`), at `each` thousandths of a dollar apiece: no more
 * than the month and the day's share have left. A stop when not even `min` fits: the caller ends its run instead of
 * waiting for tomorrow.
 */
function afford(db: DB, budget: XBudget, want: number, min: number, each: number): number | XStop {
  const month = Math.floor((budgetCap(budget) - spentThisMonth(db, budget)) / each);
  if (month < min) return "month";
  const day = Math.floor((dayShare(budget) - spentToday(db, budget)) / each);
  if (day < min) return "day";
  return Math.min(want, month, day);
}

/** The stop that a read costing `mills` would meet now; null while the month and the day both have room for it. */
export function noRoom(db: DB, budget: XBudget, mills: number): XStop | null {
  const fits = afford(db, budget, 1, 1, mills);
  return typeof fits === "number" ? null : fits;
}

/** Counts what a request returned: each kind in its month's counter, and the money in the day's. */
function spend(db: DB, budget: XBudget, got: { posts?: number; profiles?: number; counts?: number }, now = Date.now()): void {
  const { posts = 0, profiles = 0, counts = 0 } = got;
  if (posts) setMeta(db, monthKey(budget), tweetsReadThisMonth(db, budget) + posts);
  if (profiles) setMeta(db, monthKey(budget, "users"), usersReadThisMonth(db, budget) + profiles);
  if (counts) setMeta(db, monthKey(budget, "counts"), countsReadThisMonth(db, budget) + counts);
  const cost = posts * PRICE.post + profiles * PRICE.profile + counts * PRICE.count;
  if (cost) setMeta(db, dayKey(budget), `${dayStamp(now)} ${spentToday(db, budget, now) + cost}`);
}

/** What the private row says while X refuses paid reads. */
export interface XRefusal {
  /** When this refusal began. */
  since: string;
  why: "credits" | "usage cap";
  status: number;
  /** The latest refused request. */
  last: string;
}

/** X refuses a read and waiting will not help: the account is out of credits, or over its usage cap. */
export class XRefused extends HttpError {
  constructor(
    status: number,
    public why: XRefusal["why"],
  ) {
    super(status, `${status} from X: ${why === "credits" ? "out of credits" : "over the usage cap"}`);
  }
}

const REFUSED_KEY = "x_refused";
/** The refusal X is answering with now, or null when its last paid read went through. */
export function xRefusal(db: DB): XRefusal | null {
  try {
    const v = JSON.parse(getMeta(db, REFUSED_KEY) || "null") as XRefusal | null;
    return v && typeof v === "object" && typeof v.since === "string" ? v : null;
  } catch {
    return null;
  }
}

// What the owner is told. Plain words only: no query, no account and nothing X answered.
const REFUSED_WORDS: Record<XRefusal["why"], string> = {
  credits: "the account is out of credits. Nothing is read from X until credits are added in the X developer console.",
  "usage cap": "the account is over its usage cap. Nothing is read from X until the billing period ends or the cap is raised in the X developer console.",
};

/** Keeps the reason and tells the owner: a reminder a day while the same refusal lasts. */
function noteRefusal(db: DB, e: XRefused, now = Date.now()): void {
  const before = xRefusal(db);
  const since = before?.why === e.why ? before.since : new Date(now).toISOString();
  setMeta(db, REFUSED_KEY, JSON.stringify({ since, why: e.why, status: e.status, last: new Date(now).toISOString() } satisfies XRefusal));
  const lasted = now - Date.parse(since);
  const head = lasted >= HOUR_MS ? `X has refused to answer for ${howLong(lasted)}` : "X refuses to answer";
  void alert(db, "x_credits", `${head}: ${REFUSED_WORDS[e.why]} Trading is not affected.`, `refused since ${since}`);
}

/**
 * GET an X API path; waits out rate limits (x-rate-limit-reset). Throws XRefused when the account is out of credits or
 * over its usage cap, HttpError on other failures.
 */
export async function xGet<T>(path: string, params: Record<string, string>): Promise<T> {
  const url = `${API}${path}?${new URLSearchParams(params)}`;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { authorization: `Bearer ${config.xBearerToken}`, "user-agent": "godseye/0.1" }, signal: AbortSignal.timeout(30_000) });
    if (res.ok) return (await res.json()) as T;
    const body = await res.text().catch(() => "");
    if (res.status === 402) throw new XRefused(402, "credits");
    if (res.status === 429 && USAGE_CAP.test(body)) throw new XRefused(429, "usage cap");
    if (res.status === 429 && attempt < MAX_RESETS) {
      const reset = Number(res.headers.get("x-rate-limit-reset"));
      const waitMs = Number.isFinite(reset) && reset > 0 ? Math.min(15 * 60_000, Math.max(1_000, reset * 1000 - Date.now() + 1_000)) : 60_000;
      await backoff(waitMs);
      continue;
    }
    throw new HttpError(res.status, `${res.status} from X ${path}: ${body.slice(0, 200)}`);
  }
}

/** A billed read. Null when X refuses it for a reason that waiting can't fix: that is recorded, and the owner is told. */
async function paid<T>(db: DB, path: string, params: Record<string, string>): Promise<T | null> {
  try {
    const r = await xGet<T>(path, params);
    if (getMeta(db, REFUSED_KEY)) setMeta(db, REFUSED_KEY, "");
    return r;
  } catch (e) {
    if (!(e instanceof XRefused)) throw e;
    noteRefusal(db, e);
    return null;
  }
}

export interface SearchOpts {
  /** Pages read at most (default 3). */
  pages?: number;
  /** Default: the runner research's. */
  budget?: XBudget;
  /** Posts a page: 10–500 (default 500). */
  max?: number;
  /** Also fetch each post's author (default: yes). An author costs as much as two posts. */
  authors?: boolean;
}

/**
 * Every tweet matching `query` between `from` and `to` (ISO), with the authors unless `authors` is false, up to `pages`
 * pages of `max` (less when the day's share is nearly spent: see PACING). Stops early (`capped`, with the reason) when
 * the month's money or the day's share is spent, or when X refuses.
 */
export async function searchAll(
  db: DB, query: string, from: string, to: string, opts: SearchOpts = {},
): Promise<{ tweets: XTweet[]; users: XUser[]; capped: boolean; reason?: XStop }> {
  const { pages = 3, budget = "research", max = 500, authors = true } = opts;
  // A page is paid for as if every post had an author of its own; what came back is what is counted.
  const each = PRICE.post + (authors ? PRICE.profile : 0);
  const tweets: XTweet[] = [];
  const users = new Map<string, XUser>();
  const ended = (reason: XStop) => ({ tweets, users: [...users.values()], capped: true, reason });
  let next: string | undefined;
  for (let page = 0; page < pages; page++) {
    const size = afford(db, budget, Math.min(500, Math.max(MIN_SEARCH_RESULTS, Math.round(max))), MIN_SEARCH_RESULTS, each);
    if (typeof size !== "number") return ended(size);
    if (page) await backoff(PAGE_GAP_MS);
    const params: Record<string, string> = { query, start_time: from, end_time: to, max_results: String(size), "tweet.fields": TWEET_FIELDS };
    if (authors) Object.assign(params, { expansions: "author_id", "user.fields": USER_FIELDS });
    if (next) params.next_token = next;
    const r = await paid<SearchPage>(db, "/tweets/search/all", params);
    if (!r) return ended("refused");
    const got = r.data ?? [];
    tweets.push(...got);
    for (const u of r.includes?.users ?? []) users.set(u.id, u);
    spend(db, budget, { posts: got.length, profiles: r.includes?.users?.length ?? 0 });
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
 * weren't read. Paid from `budget`; nothing is fetched (`capped`) when its month or its day's share is spent, or when X
 * refuses.
 */
export async function userTweets(
  db: DB, userId: string, budget: XBudget, opts: { max?: number; sinceId?: string } = {},
): Promise<{ tweets: XTweet[]; newestId?: string; more?: boolean; capped: boolean; reason?: XStop }> {
  const size = afford(db, budget, Math.min(100, Math.max(MIN_TIMELINE_RESULTS, Math.round(opts.max ?? 20))), MIN_TIMELINE_RESULTS, PRICE.post);
  if (typeof size !== "number") return { tweets: [], capped: true, reason: size };
  const params: Record<string, string> = { max_results: String(size), exclude: "retweets", "tweet.fields": TWEET_FIELDS };
  if (opts.sinceId) params.since_id = opts.sinceId;
  const r = await paid<TimelinePage>(db, `/users/${encodeURIComponent(userId)}/tweets`, params);
  if (!r) return { tweets: [], capped: true, reason: "refused" };
  const tweets = (r.data ?? []).map((t) => ({ ...t, author_id: t.author_id ?? userId }));
  spend(db, budget, { posts: tweets.length });
  const newestId = r.meta?.newest_id ?? tweets.reduce<string | undefined>((a, t) => newerId(a, t.id), undefined);
  return { tweets, newestId, more: !!r.meta?.next_token, capped: false };
}

/**
 * Profiles by id, 100 a request (fewer when the month or the day has less left). Each profile read is paid from the
 * budget (in the profile counter, not the tweet count); nothing more is fetched (`capped`) when its month or its day's
 * share is spent, or when X refuses. Unknown or suspended ids are left out.
 */
export async function lookupUsers(db: DB, ids: string[], budget: XBudget): Promise<{ users: XUser[]; capped: boolean; reason?: XStop }> {
  const users: XUser[] = [];
  for (let i = 0; i < ids.length; ) {
    const n = afford(db, budget, Math.min(100, ids.length - i), 1, PRICE.profile);
    if (typeof n !== "number") return { users, capped: true, reason: n };
    const r = await paid<{ data?: XUser[] }>(db, "/users", { ids: ids.slice(i, i + n).join(","), "user.fields": USER_FIELDS });
    if (!r) return { users, capped: true, reason: "refused" };
    users.push(...(r.data ?? []));
    spend(db, budget, { profiles: r.data?.length ?? 0 });
    i += n;
  }
  return { users, capped: false };
}

/**
 * How many posts match `query` between `from` and `to` (counts/all, by day). Returns no posts: the collector asks before
 * a search and skips the search at 0. Each request is paid from the budget (in its own counter); nothing is fetched
 * (`capped`) when its month or its day's share is spent, or when X refuses.
 */
export async function countAll(db: DB, query: string, from: string, to: string, budget: XBudget): Promise<{ count: number; capped: boolean; reason?: XStop }> {
  const room = afford(db, budget, 1, 1, PRICE.count);
  if (typeof room !== "number") return { count: 0, capped: true, reason: room };
  const r = await paid<{ meta?: { total_tweet_count?: number } }>(db, "/tweets/counts/all", { query, start_time: from, end_time: to, granularity: "day" });
  if (!r) return { count: 0, capped: true, reason: "refused" };
  spend(db, budget, { counts: 1 });
  return { count: Number(r.meta?.total_tweet_count ?? 0), capped: false };
}
