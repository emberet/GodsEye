/**
 * The X client's budgets (x/client.ts): profiles and post counts count against the monthly caps and stop at them, a
 * spent hour skips the call instead of waiting inside the cron job, and the burn guard stops a budget that read more than
 * 2× its hourly share over 3 h. In-memory database, a stubbed X API (no network).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, setMeta } from "@godseye/shared";
import { stubFetch } from "./helpers";

process.env.X_BEARER_TOKEN = "test-token";
process.env.X_MONTHLY_TWEET_CAP = "36000"; // research: 100 an hour, burn limit 300 over 3 h
process.env.X_SOCIAL_MONTHLY_TWEET_CAP = "300"; // social: test-sized (no pacing, no burn guard)
const { config } = await import("../src/config");
const X = await import("../src/x/client");

const month = new Date().toISOString().slice(0, 7);
const hourStamp = (ms: number) => new Date(ms).toISOString().slice(0, 13);
const users = (ids: string[]) => ({ data: ids.map((id) => ({ id, username: `u${id}` })) });
const fakeX = () =>
  stubFetch((url) => {
    const u = new URL(url);
    if (u.pathname === "/2/users") return users(u.searchParams.get("ids")!.split(","));
    if (u.pathname === "/2/tweets/counts/all") return { meta: { total_tweet_count: 4 } };
    const n = Number(u.searchParams.get("max_results"));
    return { data: Array.from({ length: n }, (_, i) => ({ id: `p${i}`, text: "gm", author_id: "a", created_at: "2026-11-05T10:00:00.000Z" })), meta: u.pathname === "/2/tweets/search/all" ? { next_token: "more" } : {} };
  });

test("the two caps stay 500k each by default: 1M X reads a month in all (owner-confirmed)", () => {
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/config.ts"), "utf8");
  assert.match(src, /xMonthlyTweetCap: envNum\("X_MONTHLY_TWEET_CAP", 500_000\)/);
  assert.match(src, /xSocialMonthlyTweetCap: envNum\("X_SOCIAL_MONTHLY_TWEET_CAP", 500_000\)/);
  assert.equal(config.xMonthlyTweetCap, 36_000, "this file's override");
});

test("profile lookups and counts/all count against the monthly cap and stop at it", async () => {
  const db = openDb(":memory:");
  setMeta(db, `x_social_tweets_read_${month}`, 290);
  const net = fakeX();
  try {
    const c = await X.countAll(db, "w", "2026-11-01T00:00:00.000Z", "2026-11-02T00:00:00.000Z", "social");
    assert.deepEqual([c.count, c.capped], [4, false]);
    assert.equal(X.spentThisMonth(db, "social"), 291, "a counts/all request counts one");
    // 9 left: the lookup asks only for 9 of the 12 profiles, then stops at the cap.
    const ids = Array.from({ length: 12 }, (_, i) => `id${i}`);
    const r = await X.lookupUsers(db, ids, "social");
    assert.deepEqual([r.users.length, r.capped, r.reason], [9, true, "month"]);
    assert.equal(new URL(net.calls[1].url).searchParams.get("ids")!.split(",").length, 9);
    assert.equal(X.usersReadThisMonth(db, "social"), 9);
    assert.equal(X.spentThisMonth(db, "social"), 300);
    assert.equal(X.budgetSpent(db, "social"), true);
    const calls = net.calls.length;
    assert.deepEqual(await X.countAll(db, "w", "2026-11-01T00:00:00.000Z", "2026-11-02T00:00:00.000Z", "social"), { count: 0, capped: true, reason: "month" });
    assert.equal((await X.lookupUsers(db, ["id99"], "social")).reason, "month");
    assert.equal(net.calls.length, calls, "nothing asked past the cap");
    // A search's authors count too, so the research budget's profiles can't go past it either.
    assert.equal(X.spentThisMonth(db, "research"), 0, "the other budget is untouched");
  } finally {
    net.restore();
  }
});

test("a spent hour skips the call (reason 'hour') instead of waiting; profiles and counts use up the hour too", async () => {
  const db = openDb(":memory:");
  assert.equal(X.hourlyCap("research"), 100);
  const net = fakeX();
  try {
    await X.lookupUsers(db, Array.from({ length: 30 }, (_, i) => `id${i}`), "research");
    await X.countAll(db, "q", "2026-11-01T00:00:00.000Z", "2026-11-02T00:00:00.000Z", "research");
    assert.equal(X.tweetsReadThisHour(db, "research"), 31);
    const r = await X.searchAll(db, "q", "2026-11-01T00:00:00.000Z", "2026-11-02T00:00:00.000Z", 3);
    assert.equal(new URL(net.calls[2].url).searchParams.get("max_results"), "69", "what the hour has left");
    assert.deepEqual([r.tweets.length, r.capped, r.reason], [69, true, "hour"]);
    assert.equal(net.calls.length, 3, "the second page wasn't asked: the run ends, it doesn't wait an hour");
    const started = Date.now();
    assert.equal((await X.userTweets(db, "a1", "research")).reason, "hour");
    assert.equal((await X.lookupUsers(db, ["x"], "research")).reason, "hour");
    assert.equal((await X.countAll(db, "q", "2026-11-01T00:00:00.000Z", "2026-11-02T00:00:00.000Z", "research")).reason, "hour");
    assert.ok(Date.now() - started < 1000, "no waiting");
    assert.equal(net.calls.length, 3);
  } finally {
    net.restore();
  }
});

test("burn guard: more than 2× the hourly share over 3 h stops the budget and logs it once", async () => {
  const db = openDb(":memory:");
  const now = Date.now();
  assert.equal(X.burnLimit("research"), 300);
  assert.equal(X.burnLimit("social"), Infinity, "a test-sized cap has no burn guard (as no pacing)");
  // The two hours before this one read 160 and 141 (more than pacing allows: say, profiles that weren't counted then).
  setMeta(db, "x_read_last_hours", JSON.stringify({ [hourStamp(now - 3 * 3_600_000)]: 999, [hourStamp(now - 2 * 3_600_000)]: 160, [hourStamp(now - 3_600_000)]: 141 }));
  assert.equal(X.readLastHours(db, "research", now), 301, "the 4th hour back is out of the window");
  const warned: string[] = [];
  const warn = console.warn;
  console.warn = (...a: unknown[]) => void warned.push(a.map(String).join(" "));
  const net = fakeX();
  try {
    assert.equal(X.burning(db, "research", now), true);
    for (const r of [
      await X.searchAll(db, "q", "2026-11-01T00:00:00.000Z", "2026-11-02T00:00:00.000Z"),
      await X.userTweets(db, "a1", "research"),
      await X.lookupUsers(db, ["a1"], "research"),
      await X.countAll(db, "q", "2026-11-01T00:00:00.000Z", "2026-11-02T00:00:00.000Z", "research"),
    ]) assert.deepEqual([r.capped, r.reason], [true, "burn"]);
    assert.equal(net.calls.length, 0);
    assert.equal(warned.length, 1, "logged once an hour");
    assert.match(warned[0], /research budget: 301 read in 3 h, over 2× its hourly share \(300\)/);
    assert.ok(!warned[0].includes("test-token"));
    // The social budget is apart.
    assert.equal((await X.userTweets(db, "a1", "social")).capped, false);
    // Two hours on, the burst is out of the window: the budget reads again (from the hour's share).
    assert.equal(X.burning(db, "research", now + 2 * 3_600_000), false);
  } finally {
    console.warn = warn;
    net.restore();
  }
});
