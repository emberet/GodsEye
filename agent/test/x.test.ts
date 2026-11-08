/**
 * X research (x/): the API client's rate-limit wait and monthly cap, the search query and window, wallet links and the
 * caller hit rate. Stubbed fetch, in-memory database: nothing reaches X.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { type DB, openDb, setMeta } from "@godseye/shared";
import { stubFetch } from "./helpers";

process.env.X_BEARER_TOKEN = "test-token";
process.env.X_MONTHLY_TWEET_CAP = "700";
const { retryTiming } = await import("../src/backoff");
const { searchAll, tweetsReadThisMonth } = await import("../src/x/client");
const { addressesIn, buildQuery, callerHitRateLb, linkWallets, runXResearch, searchCoins, searchWindow } = await import("../src/x/calls");
const { attachLogDb } = await import("../src/log");
const { ensureRunnerTables } = await import("../src/runners/schema");
retryTiming.scale = 0;

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
  } finally {
    globalThis.fetch = prev;
  }
});

test("X client: stops at the month's tweet cap", async () => {
  const db = openDb(":memory:");
  setMeta(db, `x_tweets_read_${new Date().toISOString().slice(0, 7)}`, 700);
  const net = stubFetch(() => undefined);
  try {
    const r = await searchAll(db, "q", "2026-10-30T11:00:00.000Z", "2026-10-30T13:00:00.000Z");
    assert.equal(r.capped, true);
    assert.equal(net.calls.length, 0);
  } finally {
    net.restore();
  }
});

test("research: a search stopped by the hour's share keeps its pages, and only the month's cap is announced", async () => {
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
  // 600 of the hour's 700 (this file's test-sized cap) are read: room for one page of 100, not a second.
  setMeta(db, "x_tweets_read_hour", `${new Date(now).toISOString().slice(0, 13)} 600`);
  const net = stubFetch((url) => {
    const n = Number(new URL(url).searchParams.get("max_results"));
    return { data: tweets(n), includes: { users: [{ id: "a1", username: "caller" }] }, meta: { next_token: "more" } };
  });
  try {
    const s = await searchCoins(db, 2, now);
    assert.deepEqual(s, { searched: 1, tweets: 100, capped: false, stop: "hour" });
    assert.equal(net.calls.length, 1);
    const done = db.prepare("SELECT mint, tweets FROM x_searches").all();
    assert.deepEqual(done, [{ mint: "R2pump", tweets: 100 }], "the partial search is stored and not asked again");
    assert.equal((db.prepare("SELECT COUNT(*) n FROM x_posts").get() as { n: number }).n, 100);
    assert.equal(tweetsReadThisMonth(db), 100);

    await runXResearch(db);
    assert.equal(net.calls.length, 1, "the hour is used up: nothing asked");
    const warned = () => (db.prepare("SELECT COUNT(*) n FROM agent_log WHERE message LIKE '%cap%'").get() as { n: number }).n;
    assert.equal(warned(), 0, "the hour's share isn't the month's cap");
    setMeta(db, `x_tweets_read_${new Date().toISOString().slice(0, 7)}`, 700);
    await runXResearch(db);
    assert.equal(warned(), 1, "the month's cap is");
  } finally {
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
