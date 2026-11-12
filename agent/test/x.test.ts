/**
 * X research (x/): the API client's rate-limit wait and its dollar budget, the search query and window, wallet links
 * and the caller hit rate. Stubbed fetch, in-memory database: nothing reaches X.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { type DB, getMeta, openDb, setMeta } from "@godseye/shared";
import { stubFetch } from "./helpers";

process.env.X_BEARER_TOKEN = "test-token";
// $600 a month: half of it is the research's ($300), a fifteenth of that in a day ($20): room for full pages of 500 posts.
process.env.X_MONTHLY_USD = "600";
const { retryTiming } = await import("../src/backoff");
const { budgetCap, dayShare, PRICE, searchAll, spentThisMonth, spentToday, tweetsReadThisMonth } = await import("../src/x/client");
const { addressesIn, buildQuery, callerHitRateLb, linkWallets, runXResearch, searchCoins, searchWindow } = await import("../src/x/calls");
const { attachLogDb } = await import("../src/log");
const { ensureRunnerTables } = await import("../src/runners/schema");
retryTiming.scale = 0;
// The day and the month come from the clock: start clear of UTC midnight.
if (Date.now() % 86_400_000 > 86_400_000 - 10_000) await new Promise((r) => setTimeout(r, 11_000));

const month = new Date().toISOString().slice(0, 7);
/** What a post costs when it brings its author. */
const WITH_AUTHOR = PRICE.post + PRICE.profile;
const tweets = (n: number, from = 0) => Array.from({ length: n }, (_, i) => ({ id: `t${from + i}`, text: "gm", author_id: "a1", created_at: "2026-10-30T12:00:00.000Z" }));

test("X client: waits for the rate-limit reset on 429, sends the bearer token, pages with next_token", async () => {
  const db = openDb(":memory:");
  let n = 0;
  const auth: (string | null)[] = [];
  const prev = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    auth.push(new Headers(init?.headers).get("authorization"));
    n++;
    if (n === 1) return new Response("{}", { status: 429, headers: { "x-rate-limit-reset": String(Math.floor(Date.now() / 1000) + 5) } });
    const url = String(input);
    const page2 = url.includes("next_token=p2");
    return new Response(JSON.stringify({ data: tweets(page2 ? 100 : 500, page2 ? 500 : 0), includes: { users: [{ id: "a1", username: "caller" }] }, meta: { next_token: page2 ? undefined : "p2" } }), { status: 200 });
  }) as typeof fetch;
  try {
    const r = await searchAll(db, "q", "2026-10-30T11:00:00.000Z", "2026-10-30T13:00:00.000Z");
    assert.equal(r.tweets.length, 600);
    assert.equal(r.users[0].username, "caller");
    assert.equal(n, 3, "one 429, then two pages");
    assert.ok(auth.every((a) => a === "Bearer test-token"));
    assert.equal(tweetsReadThisMonth(db), 600);
    // The author came with both pages and is counted with both: the agent's count never falls short of X's bill.
    assert.equal(spentThisMonth(db, "research"), 600 * PRICE.post + 2 * PRICE.profile);
    assert.equal(spentToday(db, "research"), spentThisMonth(db, "research"));
  } finally {
    globalThis.fetch = prev;
  }
});

test("X client: stops when the month's money is spent, and asks nothing", async () => {
  const db = openDb(":memory:");
  const net = stubFetch(() => undefined);
  try {
    // What is left is one post's price short of the smallest page (10 posts with their authors).
    setMeta(db, `x_tweets_read_${month}`, (budgetCap("research") - 10 * WITH_AUTHOR) / PRICE.post + 1);
    const r = await searchAll(db, "q", "2026-10-30T11:00:00.000Z", "2026-10-30T13:00:00.000Z");
    assert.deepEqual(r, { tweets: [], users: [], capped: true, reason: "month" });
    assert.equal(net.calls.length, 0);
  } finally {
    net.restore();
  }
});

test("research: a search stopped by the day's share keeps its pages; only the month's spent budget is announced, once", async () => {
  const db = openDb(":memory:");
  ensureRunnerTables(db);
  attachLogDb(db);
  const now = Date.now();
  const at = (h: number) => new Date(now - h * 3_600_000).toISOString();
  const coin = db.prepare(
    `INSERT INTO runner_tokens (mint, source, symbol, first_seen, p0_sol, peak_sol, peak_at, x3_at, multiple, buyers, buys, swaps, is_runner, saved_at)
     VALUES (?, 'stream', NULL, ?, 1, 5, ?, ?, 5, 20, 20, 40, ?, ?)`,
  );
  for (const [mint, runner] of [["R1pump", 1], ["R2pump", 1], ["C1pump", 0]] as const) coin.run(mint, at(5), at(4), runner ? at(4.5) : null, runner, at(1));
  // Today's share is spent but for 100 posts with their authors: room for one page of 100, not a second.
  setMeta(db, "x_spent_day", `${new Date(now).toISOString().slice(0, 10)} ${dayShare("research") - 100 * WITH_AUTHOR}`);
  // Every post by an author of its own: a page costs all that was set aside for it.
  const net = stubFetch((url) => {
    const n = Number(new URL(url).searchParams.get("max_results"));
    return {
      data: tweets(n).map((t, i) => ({ ...t, author_id: `a${i}` })),
      includes: { users: Array.from({ length: n }, (_, i) => ({ id: `a${i}`, username: `caller${i}` })) },
      meta: { next_token: "more" },
    };
  });
  const printed: string[] = [];
  const print = console.log;
  console.log = (...line: unknown[]) => void printed.push(line.join(" "));
  try {
    const s = await searchCoins(db, 2, now);
    assert.deepEqual(s, { searched: 1, tweets: 100, capped: false, stop: "day" });
    assert.equal(net.calls.length, 1);
    const done = db.prepare("SELECT mint, tweets FROM x_searches").all();
    assert.deepEqual(done, [{ mint: "R2pump", tweets: 100 }], "the partial search is stored and not asked again");
    assert.equal((db.prepare("SELECT COUNT(*) n FROM x_posts").get() as { n: number }).n, 100);
    assert.equal(tweetsReadThisMonth(db), 100);
    assert.equal(spentToday(db, "research"), dayShare("research"));

    assert.equal(await runXResearch(db), null, "nothing was searched, so there is no line for the log");
    assert.equal(net.calls.length, 1, "the day is used up: nothing asked");
    const warned = () => (db.prepare("SELECT COUNT(*) n FROM agent_log WHERE message LIKE '%budget%'").get() as { n: number }).n;
    assert.equal(warned(), 0, "the day's share isn't the month's budget");
    assert.equal(printed.filter((line) => line.includes("today's share is spent")).length, 1);

    setMeta(db, `x_tweets_read_${month}`, budgetCap("research") / PRICE.post);
    assert.equal(await runXResearch(db), null);
    assert.equal(warned(), 1, "the month's budget is");
    assert.equal(getMeta(db, "x_research_spent_said"), month);
    await runXResearch(db);
    assert.equal(warned(), 1, "and it is said once a month");
    assert.equal(net.calls.length, 1);
  } finally {
    console.log = print;
    net.restore();
    attachLogDb(null as unknown as DB);
  }
});

test("search: the mint or a plain $TICKER with crypto words; the window ends at least 30 s ago", () => {
  assert.equal(buildQuery("MINTpump", "DOGE"), "(MINTpump OR ($DOGE (pump OR pumpfun OR sol OR solana OR CA))) -is:retweet");
  assert.equal(buildQuery("MINTpump", "🐸 frog"), "(MINTpump) -is:retweet");
  const t0 = Date.parse("2026-10-30T12:00:00.000Z");
  const w = searchWindow("runner", t0, t0 + 3_600_000, t0 + 10 * 3_600_000)!;
  assert.deepEqual(w, { from: "2026-10-30T11:00:00.000Z", to: "2026-10-30T14:00:00.000Z" });
  const recent = searchWindow("control", t0, t0, t0 + 60_000)!;
  assert.equal(recent.to, "2026-10-30T12:00:30.000Z");
  assert.equal(searchWindow("control", t0, t0, t0 - 3_590_000), null);
});

test("wallet links: an address in a bio counts only if it trades, never the coin itself", () => {
  const db = openDb(":memory:");
  ensureRunnerTables(db);
  const trader = Keypair.generate().publicKey.toBase58();
  const idle = Keypair.generate().publicKey.toBase58();
  const coin = Keypair.generate().publicKey.toBase58();
  db.prepare("INSERT INTO wallet_activity (address, first_seen_at, last_seen_at, swaps, buys, sells, volume_sol) VALUES (?, '2026-10-30', '2026-10-30', 5, 3, 2, 1)").run(trader);
  db.prepare("INSERT INTO x_searches (mint, kind, window_from, window_to, tweets, searched_at) VALUES (?, 'runner', '2026-10-30', '2026-10-31', 1, '2026-10-31')").run(coin);
  db.prepare("INSERT INTO x_accounts (id, username, description, fetched_at) VALUES ('a1', 'caller', ?, '2026-10-31')").run(`my bags: ${trader} and ${idle}`);
  db.prepare("INSERT INTO x_posts (id, mint, author_id, ts, text, fetched_at) VALUES ('t1', ?, 'a1', '2026-10-30T12:00:00.000Z', ?, '2026-10-31')").run(coin, `CA ${coin}`);
  assert.deepEqual(addressesIn(`CA ${coin}`, new Set([coin])), []);
  linkWallets(db);
  const links = db.prepare("SELECT wallet, how FROM x_wallet_links").all();
  assert.deepEqual(links, [{ wallet: trader, how: "bio" }]);
});

test("caller hit rate: an account posting every coin scores below one posting a few that run", () => {
  const spammer = callerHitRateLb({ early: 5, runners: 5, controls: 200 }, 10);
  const picker = callerHitRateLb({ early: 5, runners: 6, controls: 1 }, 10);
  assert.ok(picker > 0.1, `picker ${picker}`); // 5 hits against 1 control × 10 (the controls stand for 10x as many coins) + 1 late call
  assert.ok(spammer < 0.01);
});
