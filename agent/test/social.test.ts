/**
 * The private social layer (social/): its own X budget, the collector (links, profiles, posts, mentions) and the guard
 * that keeps it hidden: nothing social reaches the dashboard snapshot, any public feed, the log feed or say().
 * Stubbed fetch, in-memory database: nothing reaches X.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair } from "@solana/web3.js";
import { type DB, openDb, setMeta } from "@godseye/shared";
import { buildDashboardSnapshot, getWalletDetail } from "@godseye/shared/dashboard-data";
import { publicView, type PublicFeed } from "@godseye/shared/public-view";
import { stubFetch } from "./helpers";

process.env.X_BEARER_TOKEN = "test-token";
// $100 a month: $50 for the runner research, $40 for the social layer, a fifteenth of each in a day. A full page of
// mentions with its authors ($1.50) fits a day's share, so the budget cuts a run short only where a test spends it first.
process.env.X_MONTHLY_USD = "100";
process.env.X_SOCIAL_SCOPE = "all"; // these tests read every analyzed wallet; the candidates scope has its own test
const { retryTiming } = await import("../src/backoff");
const { config } = await import("../src/config");
const { budgetCap, budgetSpent, dayShare, lookupUsers, PRICE, searchAll, tweetsReadThisMonth, usersReadThisMonth, userTweets, xRefusal } = await import("../src/x/client");
const { MAX_MENTION_COUNT, RETRY_MS, SEARCH_MAX_RESULTS, TEXT_KEEP_MS, VISIT_TIMELINE_POSTS, forgetOldText, pickWallets, postText, retryWait, runSocialCollect, splitAddresses, syncLinks, urlCoins } =
  await import("../src/social/collect");
const { ensureRunnerTables } = await import("../src/runners/schema");
const { ensureSocialTables, socialTablesExist } = await import("../src/social/schema");
const { attachLogDb } = await import("../src/log");
retryTiming.scale = 0;
// A day's share is counted by UTC day: a run that began in the last seconds of one waits for the next.
if (Date.now() % 86_400_000 > 86_400_000 - 10_000) await new Promise((r) => setTimeout(r, 11_000));

const month = new Date().toISOString().slice(0, 7);
const today = () => new Date().toISOString().slice(0, 10);
/** A budget's whole month, in posts. */
const postsIn = (budget: "research" | "social") => budgetCap(budget) / PRICE.post;
const HANDLE = "zz_hidden_caller_q7";
const MENTIONER = "zz_hidden_mentioner_k3";
const SECRET_TEXT = "gm frens zz-secret-post-marker";
const addr = () => Keypair.generate().publicKey.toBase58();

/** A database with one analyzed, copied wallet tied to account a1 by the runner research (its address in a1's bio). */
function seed(): { db: DB; wallet: string; coin: string; other: string } {
  const db = openDb(":memory:");
  ensureRunnerTables(db);
  const wallet = addr();
  const coin = addr();
  const other = addr();
  db.prepare("INSERT INTO wallets (address, first_seen_at, discovered_via, last_analyzed_at, copy_weight) VALUES (?, '2026-10-01', 'manual', '2026-11-01', 1)").run(wallet);
  db.prepare("INSERT INTO wallets (address, first_seen_at, discovered_via) VALUES (?, '2026-10-01', 'manual')").run(addr()); // never analyzed: not looked up
  db.prepare("INSERT INTO token_info (mint, symbol, checked_at) VALUES (?, 'COIN', '2026-11-01')").run(coin);
  db.prepare("INSERT INTO x_wallet_links (author_id, wallet, how, n, updated_at) VALUES ('a1', ?, 'bio', 1, '2026-11-01')").run(wallet);
  return { db, wallet, coin, other };
}

/** X as the collector sees it: a1's profile and timeline, and a2's post sharing the wallet. */
function fakeX(wallet: string, coin: string, other: string) {
  return stubFetch((url) => xReply(url, wallet, coin, other));
}

/** One reply of the fake X (undefined = an unexpected call). */
function xReply(url: string, wallet: string, coin: string, other: string): object | undefined {
  const u = new URL(url);
  if (u.pathname === "/2/users")
    return { data: [{ id: "a1", username: HANDLE, name: "Hidden", created_at: "2024-01-01T00:00:00.000Z", verified: false, public_metrics: { followers_count: 1234, following_count: 50, tweet_count: 900, listed_count: 3 } }] };
  if (u.pathname === "/2/users/a1/tweets")
    return {
      data: [
        { id: "1002", text: `${SECRET_TEXT} aping ${coin} with ${other}`, author_id: "a1", created_at: "2026-11-05T10:00:00.000Z", public_metrics: { like_count: 10, retweet_count: 2, reply_count: 1, quote_count: 0, impression_count: 500 } },
        { id: "1001", text: "no addresses here", author_id: "a1", created_at: "2026-11-04T10:00:00.000Z" },
      ],
    };
  if (u.pathname === "/2/tweets/counts/all") return { meta: { total_tweet_count: 1 } };
  if (u.pathname === "/2/tweets/search/all") {
    assert.ok(u.searchParams.get("query")?.includes(wallet));
    return { data: [{ id: "2001", text: `follow this wallet ${wallet}`, author_id: "a2", created_at: "2026-11-05T11:00:00.000Z" }], includes: { users: [{ id: "a2", username: MENTIONER }] }, meta: {} };
  }
  return undefined;
}

/** Runs the collector with the console captured; returns what it printed. */
async function collect(db: DB, opts = {}) {
  const lines: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  try {
    return { res: await runSocialCollect(db, opts), out: lines.join("\n") };
  } finally {
    console.log = log;
  }
}

test("X budgets: research and social are counted apart; a spent social budget makes no network call", async () => {
  const db = openDb(":memory:");
  setMeta(db, `x_tweets_read_${month}`, postsIn("research")); // the research budget is used up
  const net = stubFetch(() => ({ data: [{ id: "t1", text: "gm", author_id: "a1", created_at: "2026-11-05T10:00:00.000Z" }], meta: {} }));
  try {
    const research = await searchAll(db, "q", "2026-11-01T00:00:00.000Z", "2026-11-02T00:00:00.000Z");
    assert.deepEqual([research.capped, research.reason], [true, "month"]);
    assert.equal(net.calls.length, 0);
    const social = await searchAll(db, "q", "2026-11-01T00:00:00.000Z", "2026-11-02T00:00:00.000Z", { pages: 1, budget: "social" });
    assert.equal(social.capped, false);
    assert.equal(social.tweets.length, 1);
    assert.equal(tweetsReadThisMonth(db, "social"), 1);
    assert.equal(tweetsReadThisMonth(db), postsIn("research"), "the research count is untouched");
    await userTweets(db, "a1", "social");
    assert.equal(tweetsReadThisMonth(db, "social"), 2);
    assert.match(net.calls[1].url, /\/2\/users\/a1\/tweets\?/);

    setMeta(db, `x_social_tweets_read_${month}`, postsIn("social"));
    assert.equal(budgetSpent(db, "social"), true);
    const before = net.calls.length;
    assert.equal((await searchAll(db, "q", "2026-11-01T00:00:00.000Z", "2026-11-02T00:00:00.000Z", { pages: 1, budget: "social" })).capped, true);
    assert.equal((await userTweets(db, "a1", "social")).capped, true);
    assert.equal((await lookupUsers(db, ["a1"], "social")).capped, true);
    assert.equal(net.calls.length, before, "no call once the social budget is spent");
  } finally {
    net.restore();
  }
});

test("collector: stops cleanly when the social budget's month is spent, without calling X", async () => {
  const { db } = seed();
  setMeta(db, `x_social_tweets_read_${month}`, postsIn("social"));
  const net = stubFetch(() => undefined);
  try {
    const { res, out } = await collect(db);
    assert.ok(res);
    assert.deepEqual([res.capped, res.stop], [true, "month"]);
    assert.equal(res.wallets, 0, "a wallet cut short isn't marked visited");
    assert.equal(res.links, 1, "local links are still copied");
    assert.equal(net.calls.length, 0);
    assert.match(out, /stopped: this month's money is spent/);
  } finally {
    net.restore();
  }
});

test("collector: the day's share used up ends the run quietly, and isn't the month's budget", async () => {
  const { db } = seed();
  setMeta(db, "x_social_spent_day", `${today()} ${dayShare("social")}`);
  const net = stubFetch(() => undefined);
  try {
    const { res, out } = await collect(db);
    assert.ok(res);
    assert.deepEqual([res.capped, res.stop, res.wallets, net.calls.length], [false, "day", 0, 0]);
    assert.match(out, /stopped: today's share is spent/);
    assert.doesNotMatch(out, /this month's money is spent/);
  } finally {
    net.restore();
  }
});

test("collector: a timeline read that stops with posts left after since_id is counted (timeline_truncated)", async () => {
  const { db, wallet, coin, other } = seed();
  const net = stubFetch((url) => {
    const r = xReply(url, wallet, coin, other) as { data?: unknown[]; meta?: object } | undefined;
    // a1 posts more than a page a week: X always has more.
    return new URL(url).pathname === "/2/users/a1/tweets" ? { ...r, meta: { next_token: "older" } } : r;
  });
  const truncated = () => (db.prepare("SELECT timeline_truncated n FROM social_accounts WHERE id = 'a1'").get() as { n: number }).n;
  try {
    await collect(db);
    assert.equal(truncated(), 0, "the first read has no since_id: older posts are history, not a gap");
    await collect(db, { now: Date.now() + 8 * 24 * 3_600_000 });
    assert.equal(truncated(), 1, "the second read stopped short of since_id 1002");
  } finally {
    net.restore();
  }
});

test("collector: skips entirely without X_BEARER_TOKEN", async () => {
  const { db } = seed();
  const prev = config.xBearerToken;
  config.xBearerToken = "";
  const net = stubFetch(() => undefined);
  try {
    assert.equal(await runSocialCollect(db), null);
    assert.equal(net.calls.length, 0);
    assert.equal(socialTablesExist(db), false, "nothing is created either");
  } finally {
    config.xBearerToken = prev;
    net.restore();
  }
});

test("addresses in a post: known coins and pump/bonk vanity mints are coins, other on-curve keys are wallets", () => {
  const coin = addr();
  const wallet = addr();
  const vanity = "So11111111111111111111111111111111111pump";
  const r = splitAddresses(`CA ${coin} ${vanity} dev ${wallet} ${wallet}`, (a) => a === coin);
  assert.deepEqual(r, { mints: [coin, vanity], wallets: [wallet] });
});

test("collector: links, profiles and posts with their coins and wallets; a wallet isn't looked up again within the week", async () => {
  const { db, wallet, coin, other } = seed();
  const net = fakeX(wallet, coin, other);
  try {
    const { res, out } = await collect(db);
    assert.deepEqual(res, { wallets: 1, links: 1, accounts: 1, posts: 3, mentions: 1, errors: 0, capped: false });
    assert.equal(net.calls.length, 4, "profiles, a1's timeline, the mention count, the mention search");

    const acct = db.prepare("SELECT username, followers, following, tweets, listed, verified FROM social_accounts WHERE id = 'a1'").get();
    assert.deepEqual(acct, { username: HANDLE, followers: 1234, following: 50, tweets: 900, listed: 3, verified: 0 });
    const post = db.prepare("SELECT author_id, likes, impressions, mints, wallets FROM social_posts WHERE post_id = '1002'").get() as Record<string, unknown>;
    assert.deepEqual(post, { author_id: "a1", likes: 10, impressions: 500, mints: JSON.stringify([coin]), wallets: JSON.stringify([other]) });
    const links = db.prepare("SELECT author_id, how, n FROM social_wallet_accounts WHERE wallet = ? ORDER BY author_id").all(wallet);
    assert.deepEqual(links, [{ author_id: "a1", how: "bio", n: 1 }, { author_id: "a2", how: "mention", n: 1 }]);
    assert.equal(tweetsReadThisMonth(db, "social"), 3);
    assert.equal(tweetsReadThisMonth(db, "research"), 0, "only the social budget is used");
    assert.equal(usersReadThisMonth(db, "social"), 2, "a1's lookup and a2 with the search: profiles counted apart from tweets");
    assert.equal(usersReadThisMonth(db, "research"), 0);

    assert.ok(!out.includes(wallet) && !out.includes(HANDLE) && !out.includes(MENTIONER), "the console gets counts only");
    assert.equal((db.prepare("SELECT COUNT(*) n FROM agent_log").get() as { n: number }).n, 0, "nothing in the published log feed");

    const again = await collect(db);
    assert.equal(again.res?.wallets, 0);
    assert.equal(net.calls.length, 4, "no new calls within the week");
  } finally {
    net.restore();
  }
});

test("collector: a post already stored (from a timeline or another wallet's search) still links its author as a mention", async () => {
  const { db, wallet, coin, other } = seed();
  // `other` is analyzed too, but visited after `wallet` (not copied), so a1's timeline stores post 1002 first.
  db.prepare("INSERT INTO wallets (address, first_seen_at, discovered_via, last_analyzed_at) VALUES (?, '2026-10-01', 'manual', '2026-11-01')").run(other);
  const shared = { id: "3001", text: `two wallets ${wallet} and ${other}`, author_id: "a2", created_at: "2026-11-05T12:00:00.000Z" };
  const net = stubFetch((url) => {
    const u = new URL(url);
    if (u.pathname !== "/2/tweets/search/all") return xReply(url, wallet, coin, other);
    const q = u.searchParams.get("query") ?? "";
    if (q.includes(other))
      return { data: [{ id: "1002", text: `${SECRET_TEXT} aping ${coin} with ${other}`, author_id: "a1", created_at: "2026-11-05T10:00:00.000Z" }, shared], includes: { users: [{ id: "a1", username: HANDLE }, { id: "a2", username: MENTIONER }] }, meta: {} };
    return { data: [shared], includes: { users: [{ id: "a2", username: MENTIONER }] }, meta: {} };
  });
  try {
    const { res } = await collect(db);
    assert.equal(res?.wallets, 2);
    assert.equal(res?.posts, 3, "1001, 1002 from a1's timeline and 3001 once");
    assert.equal(res?.mentions, 3, "one post for the first wallet, two for the second");
    const links = db.prepare("SELECT author_id, how, n FROM social_wallet_accounts WHERE wallet = ? ORDER BY author_id").all(other);
    assert.deepEqual(links, [{ author_id: "a1", how: "mention", n: 1 }, { author_id: "a2", how: "mention", n: 1 }], "both authors linked, each post counted once");
  } finally {
    net.restore();
  }
});

test("collector: a profile refreshed by a mention search doesn't put off its timeline; a failed timeline is retried", async () => {
  const { db, wallet, coin, other } = seed();
  // `other` is copied, so it is visited first, and its mention search returns a1 (linked to `wallet`) with a fresh profile.
  db.prepare("INSERT INTO wallets (address, first_seen_at, discovered_via, last_analyzed_at, copy_weight) VALUES (?, '2026-10-01', 'manual', '2026-11-01', 2)").run(other);
  let timelineFails = true;
  const net = stubFetch((url) => {
    const u = new URL(url);
    if (u.pathname === "/2/tweets/search/all") {
      const q = u.searchParams.get("query") ?? "";
      if (q.includes(other)) return { data: [{ id: "4001", text: `watching ${other}`, author_id: "a1", created_at: "2026-11-05T12:00:00.000Z" }], includes: { users: [{ id: "a1", username: HANDLE }] }, meta: {} };
      return { meta: {} };
    }
    if (u.pathname === "/2/users/a1/tweets" && timelineFails) return new Response("down", { status: 500 });
    return xReply(url, wallet, coin, other);
  });
  try {
    const first = await collect(db);
    assert.equal(first.res?.errors, 1, "the timeline call failed");
    const a1 = db.prepare("SELECT fetched_at, timeline_at FROM social_accounts WHERE id = 'a1'").get() as { fetched_at: string; timeline_at: string | null };
    assert.ok(a1.fetched_at, "the profile was read");
    assert.equal(a1.timeline_at, null, "a failed timeline isn't marked read");
    assert.ok(net.calls.some((c) => c.url.includes("/2/users/a1/tweets")), "the search's profile refresh didn't skip a1's timeline");

    // A week later both wallets are due again: a1's timeline is fetched this time, despite a fresh profile.
    timelineFails = false;
    const later = Date.now() + 8 * 24 * 3_600_000;
    const second = await collect(db, { now: later });
    assert.equal(second.res?.errors, 0);
    assert.ok((db.prepare("SELECT timeline_at FROM social_accounts WHERE id = 'a1'").get() as { timeline_at: string | null }).timeline_at);
    assert.equal((db.prepare("SELECT COUNT(*) n FROM social_posts WHERE author_id = 'a1'").get() as { n: number }).n, 3);
  } finally {
    net.restore();
  }
});

test("point in time: links keep when first seen, every profile read is kept", async () => {
  const { db, wallet, coin, other } = seed();
  db.prepare("UPDATE x_wallet_links SET updated_at = '2026-10-15T00:00:00.000Z'").run();
  let followers = 1234;
  const net = stubFetch((url) => {
    const r = xReply(url, wallet, coin, other) as { data?: { public_metrics?: { followers_count?: number } }[] } | undefined;
    if (new URL(url).pathname === "/2/users" && r?.data?.[0]?.public_metrics) r.data[0].public_metrics.followers_count = followers;
    return r;
  });
  try {
    await collect(db);
    const link = () => db.prepare("SELECT n, first_seen_at FROM social_wallet_accounts WHERE wallet = ? AND author_id = 'a1'").get(wallet);
    assert.deepEqual(link(), { n: 1, first_seen_at: "2026-10-15T00:00:00.000Z" }, "first seen = the research link's time");
    db.prepare("UPDATE x_wallet_links SET n = 4, updated_at = '2026-11-06T00:00:00.000Z'").run();
    assert.equal(syncLinks(db), 1);
    assert.deepEqual(link(), { n: 4, first_seen_at: "2026-10-15T00:00:00.000Z" }, "an update never moves first_seen_at");
    const mention = db.prepare("SELECT first_seen_at, updated_at FROM social_wallet_accounts WHERE author_id = 'a2'").get() as { first_seen_at: string; updated_at: string };
    assert.ok(mention.first_seen_at && mention.first_seen_at === mention.updated_at);

    followers = 2000;
    await new Promise((r) => setTimeout(r, 5));
    await collect(db, { now: Date.now() + 8 * 24 * 3_600_000 });
    assert.equal((db.prepare("SELECT followers FROM social_accounts WHERE id = 'a1'").get() as { followers: number }).followers, 2000);
    const snaps = db.prepare("SELECT followers FROM social_account_snapshots WHERE account_id = 'a1' ORDER BY fetched_at").all();
    assert.deepEqual(snaps, [{ followers: 1234 }, { followers: 2000 }], "the old profile is kept");
  } finally {
    net.restore();
  }
});

test("collector: a timeline reads on from its own last read, not from a newer post a mention search stored in between", async () => {
  const { db, wallet, coin, other } = seed();
  // `other` is visited after `wallet` (not copied); its mention search stores a1's post 1005, newer than a1's timeline.
  db.prepare("INSERT INTO wallets (address, first_seen_at, discovered_via, last_analyzed_at) VALUES (?, '2026-10-01', 'manual', '2026-11-01')").run(other);
  const net = stubFetch((url) => {
    const u = new URL(url);
    if (u.pathname === "/2/tweets/search/all" && (u.searchParams.get("query") ?? "").includes(other))
      return { data: [{ id: "1005", text: `watching ${other}`, author_id: "a1", created_at: "2026-11-05T12:00:00.000Z" }], includes: { users: [{ id: "a1", username: HANDLE }] }, meta: {} };
    if (u.pathname === "/2/users/a1/tweets" && u.searchParams.get("since_id")) return { meta: { result_count: 0 } };
    return xReply(url, wallet, coin, other);
  });
  try {
    await collect(db);
    const timelines = () => net.calls.filter((c) => c.url.includes("/2/users/a1/tweets")).map((c) => new URL(c.url).searchParams.get("since_id"));
    assert.deepEqual(timelines(), [null], "the first read has no since_id");
    assert.ok(db.prepare("SELECT 1 FROM social_posts WHERE post_id = '1005' AND author_id = 'a1'").get(), "the search stored a1's newer post");

    await collect(db, { now: Date.now() + 8 * 24 * 3_600_000 });
    // (Both wallets' visits read a1 here: timeline_at is stamped with the real clock, `now` is a week ahead.)
    const later = timelines().slice(1);
    assert.ok(later.length >= 1 && later.every((id) => id === "1002"), `read on from the timeline's own newest post, not the search's 1005: ${later}`);
    const a1 = () => (db.prepare("SELECT timeline_since_id FROM social_accounts WHERE id = 'a1'").get() as { timeline_since_id: string | null }).timeline_since_id;
    assert.equal(a1(), "1002", "an empty page keeps the mark");
  } finally {
    net.restore();
  }
});

test("point in time: a mention link the research later ties by bio/tweet/timing is owner-grade only from then", async () => {
  const { db, wallet, coin, other } = seed();
  const net = fakeX(wallet, coin, other);
  try {
    await collect(db);
  } finally {
    net.restore();
  }
  const link = () => db.prepare("SELECT how, first_seen_at FROM social_wallet_accounts WHERE wallet = ? AND author_id = 'a2'").get(wallet) as { how: string; first_seen_at: string };
  const mention = link();
  assert.equal(mention.how, "mention");
  db.prepare("INSERT INTO x_wallet_links (author_id, wallet, how, n, updated_at) VALUES ('a2', ?, 'tweet', 1, '2026-10-01T00:00:00.000Z')").run(wallet);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(syncLinks(db), 1);
  const upgraded = link();
  assert.equal(upgraded.how, "tweet");
  assert.ok(upgraded.first_seen_at > mention.first_seen_at, "first seen moves to the upgrade, not back to the mention");
  assert.equal(upgraded.first_seen_at, (db.prepare("SELECT updated_at FROM social_wallet_accounts WHERE wallet = ? AND author_id = 'a2'").get(wallet) as { updated_at: string }).updated_at);
  // An owner-grade link changing kind (tweet -> bio) keeps its time.
  db.prepare("UPDATE x_wallet_links SET how = 'bio' WHERE author_id = 'a2'").run();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(syncLinks(db), 1);
  assert.deepEqual(link(), { how: "bio", first_seen_at: upgraded.first_seen_at });
});

/** Every key in a JSON value, at any depth. */
function keys(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) for (const x of v) keys(x, out);
  else if (v && typeof v === "object")
    for (const [k, x] of Object.entries(v)) {
      out.push(k);
      keys(x, out);
    }
  return out;
}

test("HIDDEN: no social data in the dashboard snapshot, any public feed, a wallet page or the log feed", async () => {
  const { db, wallet, coin, other } = seed();
  const net = fakeX(wallet, coin, other);
  try {
    await collect(db);
  } finally {
    net.restore();
  }
  // social_scores as the hourly scorer writes it (social/score.ts): a distinctive score, so a leaked value shows too.
  const SCORE = 0.4217318;
  db.prepare("INSERT INTO social_scores (wallet, score, n_posts, model_version, updated_at) VALUES (?, ?, 3, 'zz-social-model', '2026-11-06')").run(wallet, SCORE);
  assert.ok((db.prepare("SELECT COUNT(*) n FROM social_posts").get() as { n: number }).n > 0, "the guard runs on real social rows");

  const snap = buildDashboardSnapshot(db);
  const feedOf: Record<string, PublicFeed> = { live: "stream" };
  const pub: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(snap)) pub[k] = publicView(feedOf[k] ?? (k as PublicFeed), v);
  const detail = getWalletDetail(db, wallet);
  const views = { snapshot: snap, public: pub, walletPage: detail, publicWalletPage: publicView("wallet", detail) };
  for (const [name, body] of Object.entries(views)) {
    const json = JSON.stringify(body);
    for (const secret of [HANDLE, MENTIONER, SECRET_TEXT, "zz-social-model", "0.4217", "42.17"]) assert.ok(!json.includes(secret), `${name} leaks ${secret}`);
    const leaked = keys(body).filter((k) => k.toLowerCase().startsWith("social"));
    assert.deepEqual(leaked, [], `${name} has social keys`);
  }
});

test("HIDDEN: nothing under agent/src/social calls say() or writes the log feed", () => {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/social");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".ts"));
  assert.ok(files.length >= 2);
  for (const f of files) {
    const src = fs.readFileSync(path.join(dir, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, ""); // code only, not comments
    assert.ok(!/\bsay\s*\(/.test(src), `${f} calls say()`);
    assert.ok(!/from\s+["']\.\.\/log["']/.test(src), `${f} imports the log module`);
    assert.ok(!/INSERT\s+INTO\s+agent_log/i.test(src), `${f} writes agent_log`);
  }
  // The table helper is idempotent and the tables exist once created.
  const db = openDb(":memory:");
  ensureSocialTables(db);
  ensureSocialTables(db);
  assert.equal(socialTablesExist(db), true);
});

test("collector: posts are counted before a wallet search; none at 0 or above MAX_MENTION_COUNT, one small page otherwise", async () => {
  for (const [count, searched] of [[0, false], [MAX_MENTION_COUNT + 1, false], [MAX_MENTION_COUNT, true]] as const) {
    const { db, wallet, coin, other } = seed();
    const net = stubFetch((url) => (new URL(url).pathname === "/2/tweets/counts/all" ? { meta: { total_tweet_count: count } } : xReply(url, wallet, coin, other)));
    try {
      const { res } = await collect(db);
      assert.equal(res?.wallets, 1, "the wallet is visited either way");
      const searches = net.calls.filter((c) => c.url.includes("/2/tweets/search/all"));
      assert.equal(searches.length, searched ? 1 : 0, `count ${count}`);
      if (searched) assert.equal(new URL(searches[0].url).searchParams.get("max_results"), String(SEARCH_MAX_RESULTS));
      assert.equal(net.calls.filter((c) => c.url.includes("/2/tweets/counts/all")).length, 1);
    } finally {
      net.restore();
    }
  }
});

test("collector: a failed mention count or search leaves the visit unrecorded; the wallet waits an hour, then the same window is searched", async () => {
  for (const failing of ["/2/tweets/counts/all", "/2/tweets/search/all"]) {
    const { db, wallet, coin, other } = seed();
    let down = true;
    const net = stubFetch((url) => {
      const u = new URL(url);
      if (down && u.pathname === failing) return new Response("service unavailable", { status: 503 });
      return xReply(url, wallet, coin, other);
    });
    const retry = () => db.prepare("SELECT retry_at, failures FROM social_retries WHERE wallet = ?").get(wallet) as { retry_at: string; failures: number } | undefined;
    try {
      const began = Date.now();
      const first = await collect(db);
      assert.equal(first.res?.errors, 1, failing);
      assert.equal(first.res?.wallets, 0, "a wallet whose window wasn't searched isn't counted as visited");
      assert.equal((db.prepare("SELECT COUNT(*) n FROM social_visits").get() as { n: number }).n, 0, "visited_at isn't moved forward");
      assert.equal(retry()?.failures, 1);
      assert.ok(Date.parse(retry()!.retry_at) >= began + RETRY_MS, "it is tried again in an hour, not sooner");

      down = false;
      const before = net.calls.length;
      const soon = await collect(db);
      assert.deepEqual([soon.res?.wallets, net.calls.length], [0, before], "not within the hour, though X answers again");

      const second = await collect(db, { now: Date.now() + RETRY_MS + 1_000 });
      assert.equal(second.res?.wallets, 1);
      const [from] = net.calls.slice(before).filter((c) => c.url.includes("/2/tweets/search/all")).map((c) => new URL(c.url).searchParams.get("start_time"));
      assert.ok(from && Date.now() - Date.parse(from) > 29 * 86_400_000, "the retry still reaches back the whole first lookback");
      const v = db.prepare("SELECT visited_at, mentions FROM social_visits WHERE wallet = ?").get(wallet) as { visited_at: string; mentions: number };
      assert.ok(v.visited_at);
      assert.equal(v.mentions, 1);
      assert.equal(retry(), undefined, "a recorded visit ends the wait");
    } finally {
      net.restore();
    }
  }
});

test("collector: a wallet whose count failed goes to the back of the queue: the one behind it is read next, and each further failure doubles the wait", async () => {
  const { db, wallet, coin, other } = seed();
  // `other` is analyzed too and not copied, so it is read after `wallet`.
  db.prepare("INSERT INTO wallets (address, first_seen_at, discovered_via, last_analyzed_at) VALUES (?, '2026-10-01', 'manual', '2026-11-01')").run(other);
  const net = stubFetch((url) => {
    const u = new URL(url);
    if (u.pathname !== "/2/tweets/counts/all") return xReply(url, wallet, coin, other);
    return (u.searchParams.get("query") ?? "").includes(wallet) ? new Response("service unavailable", { status: 503 }) : { meta: { total_tweet_count: 0 } };
  });
  const retry = () => db.prepare("SELECT retry_at, failures FROM social_retries WHERE wallet = ?").get(wallet);
  const visited = () => (db.prepare("SELECT wallet FROM social_visits").all() as { wallet: string }[]).map((r) => r.wallet);
  try {
    const now = Date.now();
    assert.deepEqual(pickWallets(db, 1, now), [wallet], "the copied wallet is first in line");
    const first = await collect(db, { limit: 1, now });
    assert.deepEqual([first.res?.wallets, first.res?.errors], [0, 1]);
    assert.deepEqual(retry(), { retry_at: new Date(now + RETRY_MS).toISOString(), failures: 1 });
    assert.deepEqual(pickWallets(db, 1, now), [other], "the wallet behind it is next");

    const second = await collect(db, { limit: 1, now });
    assert.deepEqual([second.res?.wallets, second.res?.errors], [1, 0]);
    assert.deepEqual(visited(), [other]);

    // An hour on it is tried again, fails again and waits twice as long.
    const later = now + RETRY_MS;
    assert.deepEqual(pickWallets(db, 5, later), [wallet]);
    await collect(db, { limit: 1, now: later });
    assert.deepEqual(retry(), { retry_at: new Date(later + 2 * RETRY_MS).toISOString(), failures: 2 });
    assert.deepEqual(visited(), [other], "still not counted as visited");
  } finally {
    net.restore();
  }
  assert.deepEqual([1, 2, 3, 30].map((failures) => retryWait(failures)), [RETRY_MS, 2 * RETRY_MS, 4 * RETRY_MS, 7 * 24 * RETRY_MS], "an hour, doubled each time, a week at most");
});

test("collector: out of credits (402) ends the run at the first refused read; the reason is kept, the owner is told once, and no wallet is pushed back", async () => {
  const { db, wallet, coin, other } = seed();
  db.prepare("INSERT INTO wallets (address, first_seen_at, discovered_via, last_analyzed_at) VALUES (?, '2026-10-01', 'manual', '2026-11-01')").run(other);
  let credits = false;
  const net = stubFetch((url) => {
    // X's answer quotes an account: neither the console nor the alert may repeat it.
    if (!credits) return new Response(JSON.stringify({ title: "CreditsDepleted", detail: `no credits left, asked for ${HANDLE}` }), { status: 402 });
    return new URL(url).pathname === "/2/tweets/counts/all" ? { meta: { total_tweet_count: 0 } } : xReply(url, wallet, coin, other);
  });
  const count = (table: string) => (db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n;
  const told = (out: string) => out.split("\n").filter((line) => line.includes("Owner alert (x_credits)")).length;
  attachLogDb(db);
  try {
    const first = await collect(db);
    assert.deepEqual(first.res, { wallets: 0, links: 1, accounts: 0, posts: 0, mentions: 0, errors: 0, capped: false, stop: "refused" });
    assert.equal(net.calls.length, 1, "the first refused read ends the run: the second wallet isn't tried");
    assert.match(first.out, /stopped: X refuses reads/);
    const refusal = xRefusal(db);
    assert.deepEqual([refusal?.why, refusal?.status], ["credits", 402]);
    assert.equal(told(first.out), 1, "the owner is told");
    assert.deepEqual([count("social_visits"), count("social_retries")], [0, 0], "X's refusal isn't a wallet's failure: nobody waits longer for it");
    assert.equal(tweetsReadThisMonth(db, "social") + usersReadThisMonth(db, "social"), 0, "a refused read is not counted as paid");

    const second = await collect(db);
    assert.equal(second.res?.stop, "refused");
    assert.equal(net.calls.length, 2, "one read a run goes on, so the first good answer is noticed");
    assert.equal(told(second.out), 0, "not told again within the hour");
    assert.equal(xRefusal(db)?.since, refusal?.since, "refused since the first time");

    // The owner alert is the one line a refusal puts in the log, and it names nobody.
    const logged = (db.prepare("SELECT message FROM agent_log").all() as { message: string }[]).map((r) => r.message);
    assert.equal(logged.length, 1);
    assert.match(logged[0]!, /^Owner alert \(x_credits\): X refuses to answer: the account is out of credits\./);
    for (const text of [first.out, second.out, ...logged]) for (const secret of [wallet, other, HANDLE]) assert.ok(!text.includes(secret), "the console and the alert name nobody");

    credits = true;
    const third = await collect(db);
    assert.deepEqual([third.res?.wallets, third.res?.stop], [2, undefined]);
    assert.equal(xRefusal(db), null, "a good answer ends the refusal");
  } finally {
    attachLogDb(null as unknown as DB);
    net.restore();
  }
});

test("collector: addresses in a long post's full text and in its links' expanded URLs are read; a coin GodsEye trades isn't a wallet", async () => {
  const { db, wallet, coin, other } = seed();
  const linked = addr();
  const traded = addr(); // on-curve, not in token_info, but GodsEye has seen it traded
  db.prepare("INSERT INTO wallet_swaps (wallet, signature, slot, ts, mint, side, token_amount, sol_amount, price_sol) VALUES (?, 'zzsig', 1, '2026-11-05T00:00:00.000Z', ?, 'buy', 1, 1, 1)").run(other, traded);
  const long = { id: "5001", text: "a long post cut at 280 characters https://t.co/abc", author_id: "a1", created_at: "2026-11-05T10:00:00.000Z",
    entities: { urls: [{ expanded_url: `https://pump.fun/coin/${linked}` }] }, note_tweet: { text: `the whole post: dev wallet ${other} and ${traded}` } };
  const net = stubFetch((url) => (new URL(url).pathname === "/2/users/a1/tweets" ? { data: [long] } : xReply(url, wallet, coin, other)));
  try {
    await collect(db);
    const net2 = net.calls.find((c) => c.url.includes("/2/users/a1/tweets"));
    assert.match(new URL(net2!.url).searchParams.get("tweet.fields") ?? "", /entities.*note_tweet/);
    const post = db.prepare("SELECT text, mints, wallets FROM social_posts WHERE post_id = '5001'").get() as { text: string; mints: string; wallets: string };
    assert.equal(post.text, long.note_tweet.text, "the whole text is stored");
    assert.deepEqual(JSON.parse(post.mints).sort(), [linked, traded].sort(), "the coin in the link, and the coin GodsEye has seen traded");
    assert.deepEqual(JSON.parse(post.wallets), [other]);
  } finally {
    net.restore();
  }
  assert.deepEqual(postText({ id: "1", text: "short", author_id: "a", created_at: "" }), { text: "short", urls: [] });
  assert.deepEqual([...urlCoins([`https://dexscreener.com/solana/${coin}`, `https://solscan.io/account/${other}`, `https://gmgn.ai/sol/token/${linked}?ref=x`])], [coin, linked],
    "a coin page's address, never an account page's");
});

test("collector: one visit reads at most VISIT_TIMELINE_POSTS from its accounts' timelines; the rest wait for the next visit", async () => {
  const { db, wallet, coin, other } = seed();
  const ids = ["a1", "a2", "a3", "a4"];
  for (const id of ids.slice(1)) db.prepare("INSERT INTO x_wallet_links (author_id, wallet, how, n, updated_at) VALUES (?, ?, 'tweet', 1, '2026-11-01')").run(id, wallet);
  let postId = 9000;
  const net = stubFetch((url) => {
    const u = new URL(url);
    if (u.pathname === "/2/users") return { data: (u.searchParams.get("ids") ?? "").split(",").map((id) => ({ id, username: `zz_${id}` })) };
    const m = u.pathname.match(/^\/2\/users\/(a\d)\/tweets$/);
    if (m) {
      const n = Number(u.searchParams.get("max_results"));
      return { data: Array.from({ length: n }, () => ({ id: String(++postId), text: "gm", author_id: m[1], created_at: "2026-11-05T10:00:00.000Z" })) };
    }
    return xReply(url, wallet, coin, other);
  });
  try {
    const { res } = await collect(db, { postsPerAccount: 40 });
    const asked = net.calls.filter((c) => /\/2\/users\/a\d\/tweets/.test(c.url)).map((c) => Number(new URL(c.url).searchParams.get("max_results")));
    assert.deepEqual(asked, [40, 40, 20], "40 + 40 + the 20 left of the visit's share");
    assert.ok(asked.reduce((a, b) => a + b, 0) <= VISIT_TIMELINE_POSTS);
    assert.equal(res?.posts, 100 + 1, "the timelines' 100 and the mention search's post");
    const unread = db.prepare("SELECT COUNT(*) n FROM social_accounts WHERE id IN ('a1','a2','a3','a4') AND timeline_at IS NULL").get() as { n: number };
    assert.equal(unread.n, 1, "the fourth account's timeline is read on a later visit");
  } finally {
    net.restore();
  }
});

test("collector: by default a visit's timeline share is split between its accounts, owner-grade links first; a lone account gets all of it", async () => {
  for (const extra of [false, true]) {
    const { db, wallet, coin, other } = seed();
    if (extra) {
      ensureSocialTables(db);
      db.prepare("INSERT INTO x_wallet_links (author_id, wallet, how, n, updated_at) VALUES ('a3', ?, 'tweet', 1, '2026-11-01')").run(wallet);
      // a0 only mentioned the wallet: read last, whatever its id
      db.prepare("INSERT INTO social_wallet_accounts (wallet, author_id, how, n, first_seen_at, updated_at) VALUES (?, 'a0', 'mention', 1, '2026-11-01', '2026-11-01')").run(wallet);
    }
    let postId = 7000;
    const net = stubFetch((url) => {
      const u = new URL(url);
      if (u.pathname === "/2/users") return { data: (u.searchParams.get("ids") ?? "").split(",").reverse().map((id) => ({ id, username: `zz_${id}` })) };
      const m = u.pathname.match(/^\/2\/users\/(a\d)\/tweets$/);
      if (m) return { data: Array.from({ length: Number(u.searchParams.get("max_results")) }, () => ({ id: String(++postId), text: "gm", author_id: m[1], created_at: "2026-11-05T10:00:00.000Z" })) };
      return xReply(url, wallet, coin, other);
    });
    try {
      await collect(db);
      const asked = net.calls.filter((c) => /\/2\/users\/a\d\/tweets/.test(c.url)).map((c) => `${c.url.match(/users\/(a\d)/)![1]}:${new URL(c.url).searchParams.get("max_results")}`);
      assert.deepEqual(asked, extra ? ["a1:33", "a3:33", "a0:33"] : ["a1:100"]);
    } finally {
      net.restore();
    }
  }
});

test("collector scope: by default only the wallets GodsEye copies or may copy are paid for", () => {
  const db = openDb(":memory:");
  ensureRunnerTables(db);
  ensureSocialTables(db);
  const now = Date.now();
  const a = (k: string) => `${k}${"1".repeat(43 - k.length)}`;
  const add = db.prepare("INSERT INTO wallets (address, first_seen_at, discovered_via, last_analyzed_at, copy_weight) VALUES (?, '2026-10-01', 'manual', '2026-11-01', ?)");
  add.run(a("Copied"), 0.3);
  add.run(a("Near"), 0);
  add.run(a("Nobody"), 0);
  db.prepare(`INSERT INTO wallet_stats (wallet, computed_at, swaps_total, swaps_7d, swaps_30d, pnl_7d_sol, pnl_30d_sol, pnl_all_sol, closed_7d, closed_30d, wins_30d, win_rate_30d, pnl_7d_usd)
              VALUES (?, '2026-11-01', 40, 10, 40, 1, 2, 2, 4, 12, 6, 0.5, 40)`).run(a("Near"));
  assert.deepEqual(pickWallets(db, 10, now, "candidates").sort(), [a("Copied"), a("Near")].sort());
  assert.equal(pickWallets(db, 10, now, "all").length, 3);
});

test("X's rules: post text goes after 30 days, the post's id and counts stay", () => {
  const db = openDb(":memory:");
  ensureRunnerTables(db);
  ensureSocialTables(db);
  const now = Date.now();
  const old = new Date(now - TEXT_KEEP_MS - 60_000).toISOString();
  const fresh = new Date(now - 60_000).toISOString();
  const sp = db.prepare("INSERT INTO social_posts (post_id, author_id, ts, text, likes, fetched_at) VALUES (?, 'a1', ?, ?, 7, ?)");
  sp.run("p-old", old, "old text", fresh);
  sp.run("p-new", fresh, "new text", fresh);
  db.prepare("INSERT INTO x_posts (id, mint, author_id, ts, text, likes, fetched_at) VALUES ('x-old', 'M', 'a1', ?, 'old call', 3, ?)").run(old, fresh);
  const print = console.log;
  console.log = () => undefined;
  try {
    assert.equal(forgetOldText(db, now), 2);
  } finally {
    console.log = print;
  }
  assert.deepEqual(db.prepare("SELECT post_id, text, likes FROM social_posts ORDER BY post_id").all(), [
    { post_id: "p-new", text: "new text", likes: 7 },
    { post_id: "p-old", text: "", likes: 7 },
  ]);
  assert.deepEqual(db.prepare("SELECT id, text, likes FROM x_posts").get(), { id: "x-old", text: "", likes: 3 });
  assert.equal(forgetOldText(db, now), 0);
});
