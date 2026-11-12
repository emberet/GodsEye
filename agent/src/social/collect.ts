/**
 * THE PRIVATE SOCIAL LAYER'S COLLECTOR — what the X accounts behind analyzed wallets post, for the social model.
 *
 * Each run takes up to X_SOCIAL_WALLETS_PER_HOUR analyzed wallets that are due (never looked up, or not for a week),
 * copied wallets first, then runner-catchers and smart money, then the rest:
 *   a. links: the runner research's wallet ↔ account links (x_wallet_links) are copied into social_wallet_accounts;
 *   b. accounts: each linked account's profile and latest posts, with the coin and wallet addresses found in each post;
 *   c. mentions: recent posts that contain the wallet's address; their authors are linked with how = 'mention', n = how
 *      many stored posts of theirs contain it (also when a post was stored earlier, from a timeline or another search).
 *      The posts are counted first (counts/all returns no posts and costs as much as two): at 0 there is no search,
 *      which is most visits; above MAX_MENTION_COUNT neither (an address that many posts carry is a tracker's or a
 *      bot's, and one page of it would say nothing about the owner). A count is asked only when the search it may call
 *      for can be paid too. A count or search that fails leaves the wallet's visit unrecorded, so the same window is
 *      searched again instead of being skipped for good, and sends the wallet to the back of the queue (social_retries:
 *      an hour, then twice as long after each further failure), so one wallet can't hold up the rest.
 * A visit reads at most VISIT_TIMELINE_POSTS from timelines and SEARCH_MAX_RESULTS from the search, and the X client
 * paces every budget by the day (x/client.ts), so a run can't spend the month.
 * A long post's whole text (note_tweet) is stored, and the addresses are read from it and from its links' expanded URLs
 * (an address in a link to a coin's page is a coin; so is one GodsEye has seen traded).
 * A profile's read time (fetched_at) and its posts' (timeline_at) are kept apart: a profile refreshed by a mention search
 * doesn't put off its timeline. A timeline is read on from its own last read (timeline_since_id, the newest id it
 * returned), not from the newest stored post: a mention search may have stored a newer post of the account in between,
 * and reading on from that would skip the posts before it for good.
 * Every profile read is also kept in social_account_snapshots (see schema.ts, point in time).
 * Reads are paid only from the "social" X budget (its share of X_MONTHLY_USD). A run ends cleanly when the month's
 * money or the day's share is spent, and at once when X refuses reads (out of credits, or over the usage cap).
 *
 * HIDDEN: nothing here goes to the published log feed (no say(), no agent_log, no thrown error text with an address or
 * a handle); the console gets counts only, which the systemd journal keeps. Observation only: nothing here trades.
 */
import { type DB, nowIso } from "@godseye/shared";
import { config } from "../config";
import { HttpError } from "../http";
import { isWallet } from "../market/holders";
import { ensureRunnerTables } from "../runners/schema";
import {
  budgetCap, countAll, lookupUsers, noRoom, PRICE, searchAll, smallestSearch, spentThisMonth, usd, userTweets, type XStop, type XTweet, type XUser, xConfigured,
} from "../x/client";
import { ensureSocialTables } from "./schema";

const DAY = 24 * 3_600_000;
/** A wallet is looked up again after this long. */
export const REVISIT_MS = 7 * DAY;
/** A linked account's profile and posts are fetched again after this long (a bit under a week, so each visit refreshes). */
const ACCOUNT_REFRESH_MS = 6 * DAY;
/** How far back the first mention search of a wallet reaches. */
const FIRST_LOOKBACK_MS = 30 * DAY;
/** X refuses an end_time less than ~10 s ago. */
const END_MARGIN_MS = 30_000;
/** Give up on a run after this many failed calls (the network or X is down). */
const MAX_ERRORS = 3;
/** Posts read from linked accounts' timelines in one wallet's visit. */
export const VISIT_TIMELINE_POSTS = 100;
/** Posts read by one wallet's mention search (one page). */
export const SEARCH_MAX_RESULTS = 100;
/** A wallet whose address more posts than this carry isn't searched. */
export const MAX_MENTION_COUNT = 300;
/** A wallet whose mention count or search failed is tried again after this long ... */
export const RETRY_MS = 3_600_000;
/** ... and twice as long after each further failure, up to a week. */
export const retryWait = (failures: number): number => Math.min(REVISIT_MS, RETRY_MS * 2 ** Math.min(Math.max(failures, 1) - 1, 10));
/** The most one wallet's mention check can cost at its smallest: the count, then one smallest search page with its authors. */
const MENTION_CHECK = PRICE.count + smallestSearch();
const ADDRESS = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;
/** A link to a coin's page: the address in it is a coin, whatever its curve. */
const COIN_URL = /(?:pump\.fun\/(?:coin\/)?|dexscreener\.com\/solana\/|birdeye\.so\/token\/|gmgn\.ai\/sol\/token\/|solscan\.io\/token\/|axiom\.trade\/meme\/)([1-9A-HJ-NP-Za-km-z]{32,44})/gi;
const LOG = "[social]";
/** Why a run stopped, for the console's count line. */
const STOP_WORDS: Record<XStop, string> = { month: "this month's money is spent", day: "today's share is spent", refused: "X refuses reads" };

export interface SocialCollectOptions {
  /** Wallets looked up this run (default X_SOCIAL_WALLETS_PER_HOUR). */
  limit?: number;
  /** Posts read per account timeline (5–100; default: the visit's VISIT_TIMELINE_POSTS split between its accounts). */
  postsPerAccount?: number;
  now?: number;
}

export interface SocialCollectResult {
  wallets: number;
  links: number;
  accounts: number;
  posts: number;
  mentions: number;
  errors: number;
  /** The social budget's month is spent: the run stopped there. */
  capped: boolean;
  /** Why the X client stopped the run, if it did: the month's money is spent, the day's share is (tomorrow carries on), or X refuses reads. */
  stop?: XStop;
}

/** Pure: the addresses in a post, split into coins (known mints, or a pump/bonk vanity suffix) and wallets (on-curve).
 * A coin GodsEye has seen traded counts as known, so an on-curve mint isn't taken for a wallet. */
export function splitAddresses(text: string, isKnownMint: (a: string) => boolean): { mints: string[]; wallets: string[] } {
  const mints: string[] = [];
  const wallets: string[] = [];
  for (const a of new Set(text.match(ADDRESS) ?? [])) {
    if (isKnownMint(a) || /(pump|bonk)$/.test(a)) mints.push(a);
    else if (isWallet(a)) wallets.push(a);
  }
  return { mints, wallets };
}

/** A post's whole text (a long post's note_tweet) and, apart, the expanded URLs of its links. */
export function postText(t: XTweet): { text: string; urls: string[] } {
  const urls = [...(t.entities?.urls ?? []), ...(t.note_tweet?.entities?.urls ?? [])].flatMap((u) => [u.expanded_url, u.unwound_url]).filter((u): u is string => !!u);
  return { text: t.note_tweet?.text || t.text || "", urls: [...new Set(urls)] };
}

/** Pure: the addresses that links to a coin's page (pump.fun, dexscreener, birdeye, gmgn, solscan, axiom) point at. */
export function urlCoins(urls: string[]): Set<string> {
  return new Set(urls.flatMap((u) => [...u.matchAll(COIN_URL)].map((m) => m[1])));
}

/** Analyzed wallets due a lookup: copied ones first, then runner-catchers and smart money, never-visited before stale.
 * A wallet whose last count or search failed is left out until its retry time. */
export function pickWallets(db: DB, limit: number, now = Date.now()): string[] {
  ensureRunnerTables(db);
  ensureSocialTables(db);
  return (
    db
      .prepare(
        `SELECT w.address FROM wallets w
           LEFT JOIN social_visits v ON v.wallet = w.address
           LEFT JOIN social_retries r ON r.wallet = w.address
          WHERE w.last_analyzed_at IS NOT NULL AND (v.visited_at IS NULL OR v.visited_at < ?)
            AND (r.retry_at IS NULL OR r.retry_at <= ?)
          ORDER BY (w.copy_weight > 0) * 4
                 + (EXISTS (SELECT 1 FROM runner_catchers c WHERE c.wallet = w.address)) * 2
                 + (EXISTS (SELECT 1 FROM smart_wallets s WHERE s.address = w.address AND s.active = 1)) * 2
                 + (EXISTS (SELECT 1 FROM x_wallet_links l WHERE l.wallet = w.address)) DESC,
                   v.visited_at IS NOT NULL, v.visited_at, w.copy_weight DESC
          LIMIT ?`,
      )
      .all(new Date(now - REVISIT_MS).toISOString(), new Date(now).toISOString(), limit) as { address: string }[]
  ).map((r) => r.address);
}

/**
 * Copy the runner research's wallet ↔ account links (strongest evidence first: bio, tweet, timing). Returns rows changed.
 * first_seen_at is the research link's earliest updated_at: never earlier than when the link was really known. A link
 * already stored as a mention that the research now ties by bio/tweet/timing becomes owner-grade only from now: its
 * first_seen_at moves to the upgrade, so a model reading the link at an earlier time doesn't see the later evidence (the
 * mention period is given up; a row holds one kind). Any other update keeps first_seen_at.
 */
export function syncLinks(db: DB): number {
  ensureRunnerTables(db);
  ensureSocialTables(db);
  return db
    .prepare(
      `INSERT INTO social_wallet_accounts (wallet, author_id, how, n, first_seen_at, updated_at)
       SELECT wallet, author_id, CASE WHEN SUM(how = 'bio') > 0 THEN 'bio' WHEN SUM(how = 'tweet') > 0 THEN 'tweet' ELSE 'timing' END, SUM(n),
              MIN(MIN(updated_at), $now), $now
         FROM x_wallet_links WHERE 1 GROUP BY wallet, author_id
       ON CONFLICT(wallet, author_id) DO UPDATE SET how = excluded.how, n = excluded.n, updated_at = excluded.updated_at,
         first_seen_at = CASE WHEN social_wallet_accounts.how = 'mention' THEN excluded.updated_at ELSE social_wallet_accounts.first_seen_at END
        WHERE social_wallet_accounts.how != excluded.how OR social_wallet_accounts.n != excluded.n`,
    )
    .run({ now: nowIso() }).changes;
}

/**
 * social_accounts.timeline_since_id: the newest post id the account's own timeline returned (its next since_id).
 * social_accounts.timeline_truncated: reads that stopped with posts left after since_id (the page was full and X had
 * more). Those posts are never read: an account that posts more than a visit's share a week is only partly covered,
 * and this measures how often.
 */
function ensureTimelineSince(db: DB): void {
  const cols = (db.prepare("PRAGMA table_info(social_accounts)").all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes("timeline_since_id")) db.exec("ALTER TABLE social_accounts ADD COLUMN timeline_since_id TEXT");
  if (!cols.includes("timeline_truncated")) db.exec("ALTER TABLE social_accounts ADD COLUMN timeline_truncated INTEGER NOT NULL DEFAULT 0");
}

class Stop extends Error {}

/** One collector run (the hourly job). Null when X_BEARER_TOKEN isn't set. Never throws: failures are counted. */
export async function runSocialCollect(db: DB, opts: SocialCollectOptions = {}): Promise<SocialCollectResult | null> {
  if (!xConfigured()) return null;
  ensureRunnerTables(db);
  ensureSocialTables(db);
  ensureTimelineSince(db);
  const now = opts.now ?? Date.now();
  const res: SocialCollectResult = { wallets: 0, links: 0, accounts: 0, posts: 0, mentions: 0, errors: 0, capped: false };

  const knownMint = db.prepare(
    `SELECT 1 FROM token_info WHERE mint = ? UNION ALL SELECT 1 FROM runner_tokens WHERE mint = ?
     UNION ALL SELECT 1 FROM (SELECT 1 FROM wallet_swaps WHERE mint = ? LIMIT 1) LIMIT 1`,
  );
  const isKnownMint = (a: string) => !!knownMint.get(a, a, a);
  // An upsert, not a replace: timeline_at is kept.
  const putAccount = db.prepare(
    `INSERT INTO social_accounts (id, username, name, followers, following, tweets, listed, created_at, description, verified, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET username = excluded.username, name = excluded.name, followers = excluded.followers,
       following = excluded.following, tweets = excluded.tweets, listed = excluded.listed, created_at = excluded.created_at,
       description = excluded.description, verified = excluded.verified, fetched_at = excluded.fetched_at`,
  );
  const putSnapshot = db.prepare(
    `INSERT OR IGNORE INTO social_account_snapshots (account_id, fetched_at, followers, following, tweets, listed, verified) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  // A timeline that returned nothing new keeps its mark.
  const timelineRead = db.prepare(
    "UPDATE social_accounts SET timeline_at = ?, timeline_since_id = coalesce(?, timeline_since_id), timeline_truncated = timeline_truncated + ? WHERE id = ?",
  );
  const putPost = db.prepare(
    `INSERT OR IGNORE INTO social_posts (post_id, author_id, ts, text, likes, reposts, replies, quotes, impressions, mints, wallets, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  // n is recounted from the stored posts, so a post seen twice (timeline and search, or two searches) counts once; at
  // least 1, since the search found one (X may cut a long post's text before the address).
  const linkMention = db.prepare(
    `INSERT INTO social_wallet_accounts (wallet, author_id, how, n, first_seen_at, updated_at)
     SELECT $wallet, $author, 'mention', MAX(COUNT(*), 1), $ts, $ts FROM social_posts WHERE author_id = $author AND instr(text, $wallet) > 0
     ON CONFLICT(wallet, author_id) DO UPDATE SET n = excluded.n, updated_at = excluded.updated_at
      WHERE social_wallet_accounts.how = 'mention' AND social_wallet_accounts.n != excluded.n`,
  );
  const linkedAccounts = db.prepare(
    `SELECT l.author_id FROM social_wallet_accounts l LEFT JOIN social_accounts a ON a.id = l.author_id
      WHERE l.wallet = ? AND (a.timeline_at IS NULL OR a.timeline_at < ?)
      ORDER BY l.how = 'mention', a.timeline_at IS NOT NULL, a.timeline_at, l.author_id`,
  );
  const timelineSince = db.prepare("SELECT timeline_since_id FROM social_accounts WHERE id = ?");
  const visit = db.prepare(
    `INSERT INTO social_visits (wallet, visited_at, mentions) VALUES (?, ?, ?)
     ON CONFLICT(wallet) DO UPDATE SET visited_at = excluded.visited_at, mentions = social_visits.mentions + excluded.mentions`,
  );
  const lastVisit = db.prepare("SELECT visited_at FROM social_visits WHERE wallet = ?");
  const failuresSoFar = db.prepare("SELECT failures FROM social_retries WHERE wallet = ?");
  const putRetry = db.prepare(
    `INSERT INTO social_retries (wallet, retry_at, failures) VALUES (?, ?, ?)
     ON CONFLICT(wallet) DO UPDATE SET retry_at = excluded.retry_at, failures = excluded.failures`,
  );
  const clearRetry = db.prepare("DELETE FROM social_retries WHERE wallet = ?");

  /** Stores profiles (latest, and a snapshot of each read); doesn't touch timeline_at. */
  const storeAccounts = (users: XUser[]) => {
    const ts = nowIso();
    db.transaction(() => {
      for (const u of users) {
        const m = u.public_metrics ?? {};
        const verified = u.verified === undefined ? null : u.verified ? 1 : 0;
        putAccount.run(u.id, u.username, u.name ?? null, m.followers_count ?? null, m.following_count ?? null, m.tweet_count ?? null, m.listed_count ?? null,
          u.created_at ?? null, u.description ?? null, verified, ts);
        putSnapshot.run(u.id, ts, m.followers_count ?? null, m.following_count ?? null, m.tweet_count ?? null, m.listed_count ?? null, verified);
      }
    })();
  };
  /** Stores posts (a post already stored keeps its first read); counts the new ones. */
  const storePosts = (tweets: XTweet[]) => {
    const ts = nowIso();
    let fresh = 0;
    db.transaction(() => {
      for (const t of tweets) {
        const m = t.public_metrics ?? {};
        const { text, urls } = postText(t);
        const linked = urlCoins(urls);
        const a = splitAddresses([text, ...urls].join(" "), (x) => linked.has(x) || isKnownMint(x));
        const added = putPost.run(t.id, t.author_id, t.created_at, text, m.like_count ?? null, m.retweet_count ?? null, m.reply_count ?? null,
          m.quote_count ?? null, m.impression_count ?? null, JSON.stringify(a.mints), JSON.stringify(a.wallets), ts).changes;
        fresh += added;
      }
    })();
    res.posts += fresh;
  };
  /** The X client stopped the run: nothing more is asked of X in it. */
  const stopRun = (why: XStop): never => {
    res.stop = why;
    res.capped = why === "month";
    throw new Stop();
  };
  /** Runs one X call: a stop (the month's money, the day's share, X refusing reads) or an auth/rate-limit refusal ends
   * the run; anything else is counted and skipped. */
  const call = async <T>(fn: () => Promise<T & { capped: boolean; reason?: XStop }>): Promise<T | null> => {
    try {
      const r = await fn();
      if (r.capped) stopRun(r.reason ?? "month");
      return r;
    } catch (e) {
      if (e instanceof Stop) throw e;
      res.errors++;
      if (res.errors >= MAX_ERRORS || (e instanceof HttpError && [401, 402, 403, 429].includes(e.status))) throw new Stop();
      return null;
    }
  };

  try {
    res.links = syncLinks(db);
    for (const wallet of pickWallets(db, opts.limit ?? config.xSocialWalletsPerHour, now)) {
      // b. Linked accounts not fetched this week: profiles, then each one's newest posts.
      const ids = (linkedAccounts.all(wallet, new Date(now - ACCOUNT_REFRESH_MS).toISOString()) as { author_id: string }[]).map((r) => r.author_id);
      if (ids.length) {
        const looked = await call(() => lookupUsers(db, ids, "social"));
        if (looked) {
          storeAccounts(looked.users);
          res.accounts += looked.users.length;
          // The visit's share is split between its accounts (a lone owner account gets all of it, so a busy one keeps its
          // week of posts), owner-grade links first, then the timelines read longest ago.
          let left = VISIT_TIMELINE_POSTS;
          const per = opts.postsPerAccount ?? Math.max(5, Math.floor(VISIT_TIMELINE_POSTS / looked.users.length));
          const order = new Map(ids.map((id, i) => [id, i]));
          for (const u of [...looked.users].sort((a, b) => (order.get(a.id) ?? ids.length) - (order.get(b.id) ?? ids.length))) {
            // The visit's timeline share is used up: the rest are read on a later visit (their timeline_at stays old).
            if (left < 5) break;
            const since = (timelineSince.get(u.id) as { timeline_since_id: string | null } | undefined)?.timeline_since_id ?? undefined;
            const timeline = await call(() => userTweets(db, u.id, "social", { max: Math.min(per, left), sinceId: since }));
            // Its timeline counts as read only once it was: a failed call or a run stopped at the cap tries again next visit.
            if (timeline) {
              storePosts(timeline.tweets);
              timelineRead.run(nowIso(), timeline.newestId ?? null, since && timeline.more ? 1 : 0, u.id);
              left -= timeline.tweets.length;
            }
          }
        }
      }
      // c. Posts containing the wallet's address since the last visit (30 days the first time).
      const prev = (lastVisit.get(wallet) as { visited_at: string } | undefined)?.visited_at;
      const fromMs = Math.max(prev ? Date.parse(prev) : 0, now - FIRST_LOOKBACK_MS);
      const toMs = Math.min(now, Date.now()) - END_MARGIN_MS;
      let mentions = 0;
      let searched = true;
      if (toMs > fromMs + 60_000) {
        const [q, from, to] = [`${wallet} -is:retweet`, new Date(fromMs).toISOString(), new Date(toMs).toISOString()];
        // No count without the money for its search: a count whose search can't follow is paid again on the next run.
        const short = noRoom(db, "social", MENTION_CHECK);
        if (short) stopRun(short);
        const counted = await call(() => countAll(db, q, from, to, "social"));
        const n = counted?.count ?? 0;
        const found = n > 0 && n <= MAX_MENTION_COUNT ? await call(() => searchAll(db, q, from, to, { pages: 1, budget: "social", max: SEARCH_MAX_RESULTS })) : null;
        // The window counts as searched only when the count (and the search it called for) answered.
        searched = counted !== null && (n === 0 || n > MAX_MENTION_COUNT || found !== null);
        if (found) {
          storeAccounts(found.users);
          storePosts(found.tweets);
          const ts = nowIso();
          // Every author found, new post or not: a post may already be stored from a timeline or another wallet's search.
          db.transaction(() => {
            for (const author of new Set(found.tweets.map((t) => t.author_id))) linkMention.run({ wallet, author, ts });
          })();
          mentions = new Set(found.tweets.map((t) => t.id)).size;
        }
      }
      res.mentions += mentions;
      // A failed count or search leaves visited_at where it was, so a later run searches the same window again: later,
      // and later still after each further failure, so the wallets behind it get their turn.
      if (!searched) {
        const failures = ((failuresSoFar.get(wallet) as { failures: number } | undefined)?.failures ?? 0) + 1;
        putRetry.run(wallet, new Date(now + retryWait(failures)).toISOString(), failures);
        continue;
      }
      db.transaction(() => {
        visit.run(wallet, new Date(now).toISOString(), mentions);
        clearRetry.run(wallet);
      })();
      res.wallets++;
    }
  } catch (e) {
    if (!(e instanceof Stop)) res.errors++;
  }
  const why = res.stop ? ` (stopped: ${STOP_WORDS[res.stop]})` : "";
  console.log(
    `${LOG} ${res.wallets} wallets, ${res.links} links synced, ${res.accounts} profiles, ${res.posts} new posts, ${res.mentions} mentions; ` +
      `${usd(spentThisMonth(db, "social"))} of ${usd(budgetCap("social"))} spent this month${why}${res.errors ? `, ${res.errors} errors` : ""}.`,
  );
  return res;
}
