/**
 * The X client's money (x/client.ts): posts, profiles and post counts are paid from a dollar budget for the month, a
 * paced budget spends only its day's share, and a spent month or day skips the call instead of waiting inside the cron
 * job. When X refuses reads (out of credits, over the usage cap) the call stops at once, the reason is kept and the
 * owner is told once a day. In-memory database, a stubbed X API (no network).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type DB, getMeta, openDb, setMeta } from "@godseye/shared";
import { stubFetch } from "./helpers";

process.env.X_BEARER_TOKEN = "test-token";
process.env.X_MONTHLY_USD = "2"; // test-sized: $1.00 for the research, $0.80 for the social layer, no pacing
const { config } = await import("../src/config");
const X = await import("../src/x/client");
const { HttpError } = await import("../src/http");
const { retryTiming } = await import("../src/backoff");
retryTiming.scale = 0;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// The day and the month come from the clock: start clear of UTC midnight.
if (Date.now() % DAY > DAY - 10_000) await new Promise((r) => setTimeout(r, 11_000));
const today = new Date().toISOString().slice(0, 10);
const month = today.slice(0, 7);
const FROM = "2026-11-01T00:00:00.000Z";
const TO = "2026-11-02T00:00:00.000Z";

type Answer = Response | object | undefined;
/** An X that answers every read: as many posts as were asked for, all by one author. `instead` answers first when it has something to say. */
const fakeX = (instead: () => Answer = () => undefined) =>
  stubFetch((url) => {
    const other = instead();
    if (other) return other;
    const u = new URL(url);
    if (u.pathname === "/2/users") return { data: u.searchParams.get("ids")!.split(",").map((id) => ({ id, username: `u${id}` })) };
    if (u.pathname === "/2/tweets/counts/all") return { meta: { total_tweet_count: 4 } };
    const n = Number(u.searchParams.get("max_results"));
    const data = Array.from({ length: n }, (_, i) => ({ id: `${i + 1}`, text: "gm", author_id: "a", created_at: "2026-11-05T10:00:00.000Z" }));
    if (u.pathname !== "/2/tweets/search/all") return { data, meta: {} };
    return { data, ...(u.searchParams.has("expansions") ? { includes: { users: [{ id: "a", username: "ua" }] } } : {}), meta: { next_token: "more" } };
  });
const asked = (call: { url: string }, param: string): string | null => new URL(call.url).searchParams.get(param);

/** Collects what the console prints until `stop()`. */
function listen(): { lines: string[]; stop: () => void } {
  const lines: string[] = [];
  const print = console.log;
  console.log = (...line: unknown[]) => void lines.push(line.join(" "));
  return { lines, stop: () => void (console.log = print) };
}
const alertsOf = (lines: string[], kind: string): string[] => lines.filter((l) => l.includes(`Owner alert (${kind}): `));

test("X_MONTHLY_USD is 50 by default: half for the runner research, two fifths for the social layer; 0 reads nothing", async () => {
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/config.ts"), "utf8");
  assert.match(src, /xMonthlyUsd: envNum\("X_MONTHLY_USD", 50\)/);
  assert.ok(!src.includes("TWEET_CAP"), "the budget is in dollars: no post caps are left");
  assert.equal(config.xMonthlyUsd, 2, "this file's override");
  assert.deepEqual([X.budgetCap("research"), X.budgetCap("social")], [1_000, 800]);
  assert.equal(X.usd(12_340), "$12.34");

  const db = openDb(":memory:");
  const net = fakeX();
  try {
    config.xMonthlyUsd = 50;
    assert.deepEqual([X.usd(X.budgetCap("research")), X.usd(X.budgetCap("social"))], ["$25.00", "$20.00"]);
    for (const none of [0, -5]) {
      config.xMonthlyUsd = none;
      assert.deepEqual([X.budgetCap("research"), X.budgetCap("social")], [0, 0]);
      assert.deepEqual(await X.countAll(db, "w", FROM, TO, "social"), { count: 0, capped: true, reason: "month" });
      assert.deepEqual(await X.searchAll(db, "q", FROM, TO), { tweets: [], users: [], capped: true, reason: "month" });
    }
    assert.equal(net.calls.length, 0);
  } finally {
    config.xMonthlyUsd = 2;
    net.restore();
  }
});

test("posts, profiles and post counts are paid at X's prices, and a budget stops at its month's money", async () => {
  const db = openDb(":memory:");
  setMeta(db, `x_social_tweets_read_${month}`, 140); // $0.70 of the $0.80
  const net = fakeX();
  try {
    assert.deepEqual([X.PRICE.post, X.PRICE.profile, X.PRICE.count], [5, 10, 10]);
    assert.equal(X.spentThisMonth(db, "social"), 700);
    assert.deepEqual(await X.countAll(db, "w", FROM, TO, "social"), { count: 4, capped: false });
    assert.equal(X.spentThisMonth(db, "social"), 710, "a post count costs a cent");
    // Nine cents left: the lookup asks only for 9 of the 12 profiles, then stops.
    const ids = Array.from({ length: 12 }, (_, i) => `${i + 1}`);
    const r = await X.lookupUsers(db, ids, "social");
    assert.deepEqual([r.users.length, r.capped, r.reason], [9, true, "month"]);
    assert.equal(asked(net.calls[1]!, "ids")!.split(",").length, 9);
    assert.deepEqual([X.usersReadThisMonth(db, "social"), X.countsReadThisMonth(db, "social")], [9, 1]);
    assert.equal(X.spentThisMonth(db, "social"), 800);
    assert.equal(X.budgetSpent(db, "social"), true);

    assert.deepEqual(await X.countAll(db, "w", FROM, TO, "social"), { count: 0, capped: true, reason: "month" });
    assert.equal((await X.lookupUsers(db, ["99"], "social")).reason, "month");
    assert.deepEqual(await X.searchAll(db, "q", FROM, TO, { budget: "social" }), { tweets: [], users: [], capped: true, reason: "month" });
    assert.deepEqual(await X.userTweets(db, "7", "social"), { tweets: [], capped: true, reason: "month" });
    assert.equal(net.calls.length, 2, "nothing is asked once the money is spent");
    assert.equal(X.noRoom(db, "social", 1), "month");

    assert.equal(X.spentThisMonth(db, "research"), 0, "the other budget is untouched");
    assert.equal(X.noRoom(db, "research", X.PRICE.count + X.smallestSearch()), null);
  } finally {
    net.restore();
  }
});

test("a search page is paid for as if every post brought an author of its own; without authors it reaches three times as far", async () => {
  const net = fakeX();
  try {
    // $1.00: 66 posts with an author each fit, then what is left after each page.
    const withAuthors = openDb(":memory:");
    const s = await X.searchAll(withAuthors, "q", FROM, TO);
    assert.deepEqual(net.calls.map((c) => asked(c, "max_results")), ["66", "44", "28"]);
    assert.deepEqual(net.calls.map((c) => asked(c, "expansions")), ["author_id", "author_id", "author_id"]);
    assert.deepEqual(net.calls.map((c) => asked(c, "next_token")), [null, "more", "more"]);
    assert.deepEqual([s.tweets.length, s.users.length, s.capped], [138, 1, false]);
    assert.deepEqual([X.tweetsReadThisMonth(withAuthors), X.usersReadThisMonth(withAuthors)], [138, 3], "counted as it came back: the author once a page");
    assert.equal(X.spentThisMonth(withAuthors, "research"), 720);
    assert.equal(X.spentToday(withAuthors, "research"), 720);

    const bare = openDb(":memory:");
    const b = await X.searchAll(bare, "q", FROM, TO, { pages: 1, authors: false });
    const call = net.calls[3]!;
    assert.deepEqual([asked(call, "max_results"), asked(call, "expansions"), asked(call, "user.fields")], ["200", null, null]);
    assert.deepEqual([b.tweets.length, b.users.length, b.capped], [200, 0, false]);
    assert.equal(X.budgetSpent(bare, "research"), true);

    // The caller's page size holds while the money allows it.
    const small = openDb(":memory:");
    await X.searchAll(small, "q", FROM, TO, { pages: 1, budget: "social", max: 30 });
    assert.equal(asked(net.calls[4]!, "max_results"), "30");
    assert.equal(X.spentThisMonth(small, "social"), 30 * X.PRICE.post + X.PRICE.profile);

    // Ten cents left: the smallest page with authors (10 posts) does not fit; without them 20 posts do.
    const low = openDb(":memory:");
    setMeta(low, `x_tweets_read_${month}`, 180);
    assert.deepEqual(await X.searchAll(low, "q", FROM, TO), { tweets: [], users: [], capped: true, reason: "month" });
    assert.equal(net.calls.length, 5);
    assert.equal((await X.searchAll(low, "q", FROM, TO, { pages: 1, authors: false })).tweets.length, 20);
    assert.equal(asked(net.calls[5]!, "max_results"), "20");
  } finally {
    net.restore();
  }
});

test("a paced budget spends a fifteenth of its month in a day, and a spent day skips the call instead of waiting", async () => {
  const db = openDb(":memory:");
  const net = fakeX();
  try {
    config.xMonthlyUsd = 50;
    assert.deepEqual([X.dayShare("research"), X.dayShare("social")], [1_666, 1_333]);

    // A page of 500 is asked for; the day's share pays for 111 posts with their authors.
    await X.searchAll(db, "q", FROM, TO, { pages: 1 });
    assert.equal(asked(net.calls[0]!, "max_results"), "111");
    assert.equal(X.spentToday(db, "research"), 111 * X.PRICE.post + X.PRICE.profile);

    // 6.6 cents left today: no search page fits, a count does, and a timeline shrinks to what is left.
    setMeta(db, "x_spent_day", `${today} 1600`);
    assert.deepEqual(await X.searchAll(db, "q", FROM, TO), { tweets: [], users: [], capped: true, reason: "day" });
    assert.equal(net.calls.length, 1, "nothing is asked, and nothing waits for tomorrow");
    assert.deepEqual(await X.countAll(db, "w", FROM, TO, "research"), { count: 4, capped: false });
    assert.equal((await X.userTweets(db, "7", "research")).tweets.length, 11);
    assert.equal(asked(net.calls[2]!, "max_results"), "11");
    assert.equal(X.spentToday(db, "research"), 1_665);
    assert.deepEqual(await X.countAll(db, "w", FROM, TO, "research"), { count: 0, capped: true, reason: "day" });
    assert.equal(X.noRoom(db, "research", X.PRICE.count), "day");
    assert.equal(net.calls.length, 3);

    // The other budget has a day of its own, and tomorrow starts at nothing.
    assert.equal(X.spentToday(db, "social"), 0);
    assert.equal(X.noRoom(db, "social", X.PRICE.count + X.smallestSearch()), null);
    assert.equal(X.spentToday(db, "research", Date.now() + DAY), 0);
    setMeta(db, "x_spent_day", `${new Date(Date.now() - DAY).toISOString().slice(0, 10)} 1666`);
    assert.equal(X.spentToday(db, "research"), 0);
    assert.deepEqual(await X.countAll(db, "w", FROM, TO, "research"), { count: 4, capped: false });
    assert.equal(X.spentToday(db, "research"), X.PRICE.count);

    // The month keeps all of it.
    assert.deepEqual([X.tweetsReadThisMonth(db), X.usersReadThisMonth(db), X.countsReadThisMonth(db)], [122, 1, 2]);
    assert.equal(X.spentThisMonth(db, "research"), 640);

    // A day's share is never less than one mention check (a count, then the smallest search page with its authors)...
    config.xMonthlyUsd = 3;
    assert.deepEqual([X.dayShare("research"), X.dayShare("social")], [160, 160]);
    assert.equal(X.PRICE.count + X.smallestSearch(), 160);
    // ...and a test-sized budget may go in one day.
    config.xMonthlyUsd = 2;
    assert.deepEqual([X.dayShare("research"), X.dayShare("social")], [X.budgetCap("research"), X.budgetCap("social")]);
  } finally {
    config.xMonthlyUsd = 2;
    net.restore();
  }
});

/** As if `ms` had gone by since the refusal began and the owner was last told of it. */
function later(db: DB, ms: number): void {
  const back = (iso: string) => new Date(Date.parse(iso) - ms).toISOString();
  const refusal = JSON.parse(getMeta(db, "x_refused")!) as { since: string; last: string };
  const told = JSON.parse(getMeta(db, "alert_x_credits")!) as { at: string; about: string };
  setMeta(db, "x_refused", JSON.stringify({ ...refusal, since: back(refusal.since), last: back(refusal.last) }));
  setMeta(db, "alert_x_credits", JSON.stringify({ at: back(told.at), about: told.about.replace(refusal.since, back(refusal.since)) }));
}

test("out of credits (402): the read stops at once, the reason is kept, the owner is told once a day, and a good answer clears it", async () => {
  const db = openDb(":memory:");
  let refused = true;
  const net = fakeX(() => (refused ? new Response(JSON.stringify({ title: "CreditsDepleted", detail: "made-up answer" }), { status: 402 }) : undefined));
  const out = listen();
  try {
    assert.deepEqual(await X.countAll(db, "w", FROM, TO, "social"), { count: 0, capped: true, reason: "refused" });
    assert.equal(net.calls.length, 1, "no second try: waiting brings no credits");
    const first = X.xRefusal(db)!;
    assert.deepEqual([first.why, first.status, first.last], ["credits", 402, first.since]);
    assert.ok(Date.now() - Date.parse(first.since) < 60_000);
    assert.equal(alertsOf(out.lines, "x_credits").length, 1);
    assert.ok(
      out.lines[0]!.endsWith(
        "Owner alert (x_credits): X refuses to answer: the account is out of credits. Nothing is read from X until credits are added in the X developer console. Trading is not affected.",
      ),
    );

    // Every kind of read stops the same way, with one request each: that is how the first good answer gets noticed.
    assert.deepEqual(await X.searchAll(db, "q", FROM, TO), { tweets: [], users: [], capped: true, reason: "refused" });
    assert.equal((await X.lookupUsers(db, ["1", "2"], "social")).reason, "refused");
    assert.deepEqual(await X.userTweets(db, "7", "social"), { tweets: [], capped: true, reason: "refused" });
    assert.equal(net.calls.length, 4);
    assert.deepEqual([X.spentThisMonth(db, "social"), X.spentThisMonth(db, "research")], [0, 0], "a refused read costs nothing");
    assert.equal(X.xRefusal(db)!.since, first.since, "one refusal, however often it is met");
    assert.equal(alertsOf(out.lines, "x_credits").length, 1);

    // Two hours on it is the same refusal, and the owner was told today.
    later(db, 2 * HOUR);
    await X.countAll(db, "w", FROM, TO, "social");
    assert.equal(alertsOf(out.lines, "x_credits").length, 1);
    // A day on, a reminder says how long it has lasted.
    later(db, 23 * HOUR);
    await X.countAll(db, "w", FROM, TO, "social");
    assert.equal(alertsOf(out.lines, "x_credits").length, 2);
    assert.match(alertsOf(out.lines, "x_credits")[1]!, /X has refused to answer for 25 hours: the account is out of credits\./);

    // The first read that goes through ends it; a later refusal is a new one.
    refused = false;
    assert.deepEqual(await X.countAll(db, "w", FROM, TO, "social"), { count: 4, capped: false });
    assert.equal(X.xRefusal(db), null);
    refused = true;
    await X.countAll(db, "w", FROM, TO, "social");
    assert.ok(Date.now() - Date.parse(X.xRefusal(db)!.since) < 60_000);

    // The error itself and everything printed carry nothing X answered.
    await assert.rejects(
      () => X.xGet("/usage/tweets", {}),
      (e: unknown) => e instanceof X.XRefused && e.status === 402 && e.why === "credits" && !e.message.includes("made-up"),
    );
    assert.ok(!out.lines.join("\n").includes("made-up"));
  } finally {
    out.stop();
    net.restore();
  }
});

test("over the usage cap (a 429 that says so) nothing waits; a plain rate limit still waits for its reset", async () => {
  const db = openDb(":memory:");
  const overCap = () =>
    new Response(JSON.stringify({ title: "UsageCapExceeded", type: "https://api.twitter.com/2/problems/usage-capped", detail: "made-up answer" }), { status: 429 });
  const limited = () =>
    new Response(JSON.stringify({ title: "Too Many Requests", type: "about:blank" }), { status: 429, headers: { "x-rate-limit-reset": String(Math.floor(Date.now() / 1000) + 1) } });
  const queue: (() => Response)[] = [overCap];
  let always: (() => Response) | undefined;
  const net = fakeX(() => (queue.shift() ?? always)?.());
  const out = listen();
  try {
    assert.deepEqual(await X.countAll(db, "w", FROM, TO, "social"), { count: 0, capped: true, reason: "refused" });
    assert.equal(net.calls.length, 1, "the cap does not lift by waiting");
    const refusal = X.xRefusal(db)!;
    assert.deepEqual([refusal.why, refusal.status], ["usage cap", 429]);
    assert.equal(alertsOf(out.lines, "x_credits").length, 1);
    assert.match(out.lines[0]!, /X refuses to answer: the account is over its usage cap\. Nothing is read from X until /);

    // A rate limit is no refusal: the read waits for the reset and comes through, which also ends the refusal.
    queue.push(limited);
    assert.deepEqual(await X.countAll(db, "w", FROM, TO, "social"), { count: 4, capped: false });
    assert.equal(net.calls.length, 3);
    assert.equal(X.xRefusal(db), null);

    // One that never lifts fails the call after two waits, and is still no refusal.
    always = limited;
    await assert.rejects(
      () => X.countAll(db, "w", FROM, TO, "social"),
      (e: unknown) => e instanceof HttpError && e.status === 429 && !(e instanceof X.XRefused),
    );
    assert.equal(net.calls.length, 6);
    assert.equal(X.xRefusal(db), null);
    assert.equal(X.spentThisMonth(db, "social"), X.PRICE.count, "only the count that came through is paid for");
    assert.equal(alertsOf(out.lines, "x_credits").length, 1);
    assert.ok(!out.lines.join("\n").includes("made-up"));
  } finally {
    out.stop();
    net.restore();
  }
});
