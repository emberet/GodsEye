/**
 * The paper book's marks when it has no fresh price (brain/paper.ts priceOf, brain/quotes.ts QuoteModel), and the one
 * Jupiter bucket every Brain quote goes through (JupiterBucket, ShadowQuotes). In-memory database, a stub market (quotes at
 * a set price, nothing sent), an injected clock: no network, no model.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, type DB } from "@godseye/shared";

process.env.COPY_BUDGET_SOL = "1";
process.env.COPY_MAX_TRADE_SOL = "0.1";
process.env.COPY_MIN_TRADE_SOL = "0.01";
process.env.COPY_MAX_POSITIONS = "0";
process.env.COPY_DAILY_LOSS_LIMIT_SOL = "0.05";
process.env.MIN_LEADER_BUY_SOL = "0.2";
process.env.BRAIN_TX_COST_SOL = "0.0002";
process.env.BRAIN_RENT_SOL = "0.002";
process.env.BRAIN_HARD_STOP_PCT = "60";
process.env.BRAIN_MAX_HOLD_HOURS = "24";
process.env.BRAIN_BANKROLL_SOL = "";
process.env.BRAIN_SHADOW_QUOTES_PER_MIN = "1000";
process.env.BRAIN_MIRROR_QUOTES_PER_MIN = "10";
delete process.env.BRAIN_SHADOW_QUOTE_RATE;
const { PaperBook, DEAD_AFTER_FAILS, STALE_PRICE_MS } = await import("../src/brain/paper");
const Q = await import("../src/brain/quotes");
const { HttpError } = await import("../src/http");
const { config } = await import("../src/config");
type Deps = NonNullable<ConstructorParameters<typeof PaperBook>[1]>;

const TX = 0.0002;
const RENT = 0.002;
const near = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);
const rateLimit = () => new HttpError(429, "429 from api.jup.ag: Too Many Requests");

/** A market with set prices: quotes at the price, a coin can lose its route, or its quotes can fail (a rate limit). */
function market(t0 = Date.parse("2026-11-10T12:00:00.000Z")) {
  const prices = new Map<string, number>();
  const noRoute = new Set<string>();
  const failing = new Set<string>();
  const clock = { t: t0 };
  const sells: { mint: string; tokens: number; t: number }[] = [];
  const bucket = new Q.JupiterBucket(() => 60, t0);
  const deps: Partial<Deps> = {
    now: () => clock.t,
    wait: async (ms) => void (clock.t += ms),
    delayMs: 2000,
    bucket,
    quoteModel: () => Q.DEFAULT_QUOTE_MODEL,
    quoteBuy: async (mint, sol) => {
      const p = prices.get(mint);
      return p && !noRoute.has(mint) ? { tokens: sol / p, priceSol: p } : null;
    },
    quoteSell: async (mint, tokens) => {
      sells.push({ mint, tokens, t: clock.t });
      if (failing.has(mint)) throw rateLimit();
      const p = prices.get(mint);
      return p && !noRoute.has(mint) ? tokens * p : null;
    },
  };
  return { prices, noRoute, failing, clock, sells, bucket, deps };
}

function research(db: DB, address: string) {
  db.prepare("INSERT OR REPLACE INTO wallets (address, first_seen_at, discovered_via, tier, copy_weight, shadow_only) VALUES (?, ?, 'test', 'proven', 0.1, 1)").run(address, new Date().toISOString());
}

let sigN = 0;
const buy = (m: ReturnType<typeof market>, leader: string, mint: string) => ({
  leader, mint, symbol: "MEME", solAmount: 1, priceSol: m.prices.get(mint) ?? 1e-6, signature: `qsig${++sigN}`, t: m.clock.t,
});
const brainOnly = () => () => ({ brain: { stakeFrac: 1, q: [0, 0.1, 0.2, 0.3, 0.4], features: [1, 2, 3], modelVersion: "v1" } });
const pos = (db: DB) => db.prepare("SELECT * FROM brain_paper_positions WHERE account = 'brain' ORDER BY id").get() as Record<string, any>;

function setup(deps: Partial<Deps> = {}) {
  const db = openDb(":memory:");
  const m = market();
  const states: { ret_now: number; quote_failed: boolean; minutes_since_price: number }[] = [];
  const book = new PaperBook(db, { decideEntry: brainOnly(), decideExit: (_p, st) => (states.push(st), { action: "hold", features: [1] }), ...m.deps, ...deps });
  research(db, "W1");
  return { db, m, book, states };
}

test("mark model: the default curves are monotone and conservative; quote_model.json overrides them, a broken one falls back", () => {
  const d = Q.DEFAULT_QUOTE_MODEL;
  let prevM = 1;
  let prevD = Q.NO_ROUTE_MAX;
  for (const age of [0, 5, 30, 90, 200, 600, 3600, 7200, 30_000, 100_000]) {
    const mv = Q.staleMark(d, age);
    const dv = Q.darkMark(d, age);
    assert.ok(mv <= 1 && mv <= prevM, `m(${age}) = ${mv} never above 1 and never rising`);
    assert.ok(dv <= Q.NO_ROUTE_MAX && dv <= prevD && dv < mv, `f_dark(${age}) = ${dv}`);
    prevM = mv;
    prevD = dv;
  }
  near(Q.staleMark(d, 1200), 0.96); // sim.yaml m_age_table 5-30 min
  near(Q.staleMark(d, 100_000), 0.78);
  near(Q.darkMark(d, 100_000), 0.001);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "godseye-qm-"));
  const file = path.join(dir, "quote_model.json");
  assert.equal(Q.quoteModel(file, 0).source, "default", "no file: the default");
  // A fitted model: m above 1 is held at 1, f_dark above NO_ROUTE_MAX at it, and a step can't rise with age.
  fs.writeFileSync(file, JSON.stringify({ m_age: [[60, 1.05], [600, 0.9], [3600, 0.95]], f_dark: [[120, 0.55], [600, 0.04]] }));
  const fitted = Q.quoteModel(file, 120_000);
  assert.equal(fitted.source, file);
  assert.deepEqual(fitted.m, [[60, 1], [600, 0.9], [3600, 0.9]]);
  assert.deepEqual(fitted.fDark, [[120, Q.NO_ROUTE_MAX], [600, 0.04]]);
  near(Q.darkMark(fitted, 300), 0.04);
  near(Q.staleMark(fitted, 10_000), 0.9);
  assert.equal(Q.quoteModel(file, 130_000), fitted, "looked at once a minute at most");
  fs.writeFileSync(file, '{"m_age": [[60, "x"]], "f_dark": []}');
  fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
  assert.equal(Q.quoteModel(file, 240_000).source, "default", "a broken file: the default");
  assert.equal(Q.parseQuoteModel({ m_age: [[60, 0.9], [30, 0.8]], f_dark: [[60, 0.01]] }, "x"), null, "ages must rise");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a sell quote that fails (429) or isn't asked (the cap) doesn't keep the last price: the mark ages by m(age)", async () => {
  const { db, m, book, states } = setup();
  m.prices.set("A", 1e-6);
  await book.onLeaderBuy(buy(m, "W1", "A"));
  m.prices.set("A", 2e-6);
  m.clock.t += 120_000;
  await book.tick(); // a routed quote: +100%, a fresh mark
  near(states.at(-1)!.ret_now, 1);
  near(book.equity("brain"), 1 - 0.1 - TX - RENT + 0.2 + RENT);

  m.failing.add("A");
  m.clock.t += 20 * 60_000; // 20 min on, the quote is rate limited
  await book.tick();
  const mark = 2e-6 * Q.staleMark(Q.DEFAULT_QUOTE_MODEL, 20 * 60);
  near(states.at(-1)!.ret_now, mark / 1e-6 - 1, 1e-9);
  assert.ok(states.at(-1)!.ret_now < 1, "not the last price");
  near(book.equity("brain"), 1 - 0.1 - TX + (0.1 / 1e-6) * mark, 1e-9);
  assert.equal(pos(db).quote_fails, 0, "within 30 min of a tracked print a rate limit says nothing about the coin");
  assert.ok(m.bucket.backingOff(m.clock.t), "the 429 backs the bucket off");

  // Over the cap: no quote is asked, and the mark ages the same way.
  m.failing.delete("A");
  m.clock.t += 2 * 60 * 60_000; // 2 h 20 min since the last price
  const cap = config.brainExitQuotesPerMin;
  config.brainExitQuotesPerMin = 0;
  try {
    const asked = m.sells.length;
    await book.tick();
    assert.equal(m.sells.length, asked, "capped: not asked");
  } finally {
    config.brainExitQuotesPerMin = cap;
  }
  near(states.at(-1)!.ret_now, 2 * Q.staleMark(Q.DEFAULT_QUOTE_MODEL, 140 * 60) - 1, 1e-9);
  near(Q.staleMark(Q.DEFAULT_QUOTE_MODEL, 140 * 60), 0.88);
  // The quote works again: the mark is the quote, and its age starts over.
  m.clock.t += 60_000;
  await book.tick();
  near(states.at(-1)!.ret_now, 1);
  assert.equal(states.at(-1)!.minutes_since_price, 0);
});

test("only no-route quotes count toward the dead streak (a 429 never does, however long untracked); a tracked print or an ok quote ends it", async () => {
  const { db, m, book } = setup({ quoteModel: () => ({ m: Q.DEFAULT_QUOTE_MODEL.m, fDark: [[1e9, 0.08]], source: "test" }) });
  const stop = config.brainHardStopPct;
  config.brainHardStopPct = 99; // the dark mark (× 0.08) stays a mark: the streak, not the stop, closes it
  try {
    m.prices.set("D", 1e-6);
    await book.onLeaderBuy(buy(m, "W1", "D"));
    m.failing.add("D");
    for (let i = 0; i < 2 * DEAD_AFTER_FAILS; i++) {
      m.clock.t += 20 * 60_000;
      await book.tick();
    }
    assert.deepEqual([pos(db).quote_fails, pos(db).quote_failed, pos(db).status], [0, 0, "open"], "2 h of rate limits with no tracked print: never counted");
    m.failing.delete("D");
    m.noRoute.add("D");
    m.clock.t += 2 * 60_000; // past the bucket's back-off
    await book.tick();
    assert.equal(pos(db).quote_fails, 1, "no route: counted");
    m.clock.t += 2 * 60_000;
    await book.tick();
    assert.equal(pos(db).quote_fails, 2);
    // A tracked wallet trades it: the coin is alive and the streak ends.
    await book.onPrice("D", 1e-6, m.clock.t, 0.5, { tracked: true });
    assert.deepEqual([pos(db).quote_fails, pos(db).status], [0, "open"]);
    m.clock.t += 2 * 60_000;
    await book.tick();
    assert.equal(pos(db).quote_fails, 1);
    // An ok quote ends it too.
    m.noRoute.delete("D");
    m.clock.t += 2 * 60_000;
    await book.tick();
    assert.equal(pos(db).quote_fails, 0);
    m.noRoute.add("D");
    for (let i = 0; i < DEAD_AFTER_FAILS; i++) {
      m.clock.t += 2 * 60_000;
      await book.tick();
    }
    const p = pos(db);
    assert.equal(p.status, "closed", `${DEAD_AFTER_FAILS} no-route quotes in a row: dead`);
    assert.match(p.exit_reason, /dead, written off/);
    near(p.pnl_sol, -(0.1 + TX + RENT));
  } finally {
    config.brainHardStopPct = stop;
  }
});

test("no route: the mark is the last price × f_dark(age), lower the longer the coin has been dark", async () => {
  const { db, m, book, states } = setup({ quoteModel: () => ({ m: Q.DEFAULT_QUOTE_MODEL.m, fDark: [[300, 0.08], [3600, 0.02]], source: "test" }) });
  const stop = config.brainHardStopPct;
  config.brainHardStopPct = 99; // so the exit network sees the dark marks (at −60 % the stop holds them, unsellable)
  m.prices.set("R", 1e-6);
  await book.onLeaderBuy(buy(m, "W1", "R"));
  m.noRoute.add("R");
  m.clock.t += 120_000;
  await book.tick(); // no route at 2 min: × 0.08
  assert.deepEqual([pos(db).quote_failed, pos(db).quote_fails], [1, 1]);
  near(states.at(-1)!.ret_now, 0.08 - 1);
  near(book.equity("brain"), 1 - 0.1 - TX + 0.1 * 0.08, 1e-9);
  m.noRoute.delete("R");
  m.failing.add("R"); // 15 min later the quote is rate limited: still dark, now × 0.02
  m.clock.t += 13 * 60_000;
  await book.tick();
  near(states.at(-1)!.ret_now, 0.02 - 1);
  near(book.equity("brain"), 1 - 0.1 - TX + 0.1 * 0.02, 1e-9);
  // The default curve: about nothing, as before (never above NO_ROUTE_MAX whatever a file says).
  near(Q.darkMark(Q.DEFAULT_QUOTE_MODEL, 120), 0.005);
  config.brainHardStopPct = stop;
});

test("onPrice: an untracked print moves the price but not its time; a raw one (no flag) still refreshes it", async () => {
  const { db, m, book } = setup();
  m.prices.set("U", 1e-6);
  await book.onLeaderBuy(buy(m, "W1", "U"));
  const { last_price_ts: filled, last_tracked_price_ts: leaderBuy } = pos(db);
  m.clock.t += 30_000;
  await book.onPrice("U", 1.1e-6, m.clock.t, 0.5, { tracked: false });
  assert.deepEqual([pos(db).last_price_sol, pos(db).last_price_ts, pos(db).last_tracked_price_ts], [1.1e-6, filled, leaderBuy], "untracked: price only");
  m.clock.t += STALE_PRICE_MS;
  const asked = m.sells.length;
  await book.tick();
  assert.equal(m.sells.length, asked + 1, "the untracked print didn't hold off the stale quote");
  m.clock.t += 30_000;
  await book.onPrice("U", 1.2e-6, m.clock.t, 0.5); // runtime.ts's raw price: refreshes the time, as before
  assert.equal(pos(db).last_price_ts, new Date(m.clock.t).toISOString());
  assert.notEqual(pos(db).last_tracked_price_ts, new Date(m.clock.t).toISOString(), "but it is no tracked print");
  m.clock.t += 30_000;
  await book.onPrice("U", 1.3e-6, m.clock.t, 0.5, { tracked: true });
  assert.deepEqual([pos(db).last_price_ts, pos(db).last_tracked_price_ts], [new Date(m.clock.t).toISOString(), new Date(m.clock.t).toISOString()]);
});

test("the Jupiter bucket: exits before the mirror before the shadow; a 429 backs off; a sale is never refused", () => {
  const t0 = 1_000_000;
  const b = new Q.JupiterBucket(() => 8, t0);
  // 8 tokens: the shadow lane leaves the top half (4), the mirror the top quarter (2), the exits nothing.
  const take = (lane: "exit" | "mirror" | "shadow") => b.take(lane, t0);
  assert.deepEqual([take("shadow"), take("shadow"), take("shadow"), take("shadow"), take("shadow")], [true, true, true, true, false]);
  assert.deepEqual([take("mirror"), take("mirror"), take("mirror")], [true, true, false]);
  assert.deepEqual([take("exit"), take("exit"), take("exit")], [true, true, false]);
  b.note("exit", t0); // a sale: counted below zero
  assert.equal(b.left(t0), -1);
  assert.equal(b.take("real", t0), true, "the real engine's lane is never refused");
  assert.equal(b.take("exit", t0 + 7_500), false, "the lanes wait until the sales are paid back");
  assert.equal(b.take("exit", t0 + 30_000), true, "8 a minute refill");
  // A 429: every lane backs off, a little longer each time in a row, and a quote that works resets it.
  const t1 = t0 + 120_000;
  b.rateLimited(t1);
  assert.equal(b.take("exit", t1 + Q.BACKOFF_MIN_MS - 1), false);
  assert.equal(b.take("exit", t1 + Q.BACKOFF_MIN_MS), true);
  b.rateLimited(t1 + 6_000);
  assert.equal(b.backingOff(t1 + 6_000 + 2 * Q.BACKOFF_MIN_MS - 1), true, "doubled");
  b.ok();
  b.rateLimited(t1 + 30_000);
  assert.equal(b.backingOff(t1 + 30_000 + Q.BACKOFF_MIN_MS), false, "back to the shortest");
  assert.ok(b.refused.shadow >= 1 && b.refused.mirror >= 1 && b.refused.exit >= 2);
});

test("a paper sale is quoted even with the bucket empty and backing off; shadow quotes never take its place", async () => {
  const { db, m, book } = setup({ decideExit: () => ({ action: "sell_all", features: [1] }) });
  const q = new Q.ShadowQuotes(db, { now: () => m.clock.t, random: () => 0, bucket: m.bucket, quoteSell: async (_mint, tokens) => tokens * 1e-6, lastTracked: () => null });
  m.prices.set("S", 1e-6);
  await book.onLeaderBuy(buy(m, "W1", "S"));
  // Shadow candidates due now, the bucket drained and backing off after a 429.
  for (let i = 0; i < 5; i++) q.onCandidate({ leader: `L${i}`, mint: `M${i}`, signature: `c${i}`, priceSol: 1e-6, solAmount: 1, t: m.clock.t - 5_000 });
  while (m.bucket.take("exit", m.clock.t));
  m.bucket.rateLimited(m.clock.t);
  m.clock.t += 120_000;
  m.bucket.rateLimited(m.clock.t);
  const before = m.bucket.left(m.clock.t);
  await Promise.all([q.runDue(), book.onPrice("S", 1e-6, m.clock.t, 1, { tracked: true })]);
  assert.equal(pos(db).status, "closed", "the exit network's sale went through");
  near(pos(db).proceeds_sol, 0.1, 1e-9);
  const shadow = db.prepare("SELECT status FROM brain_shadow_quotes").all() as { status: string }[];
  assert.ok(shadow.length > 0 && shadow.every((r) => r.status === "capped"), "the shadow quotes were stored as capped, never asked");
  assert.ok(m.bucket.left(m.clock.t) < before, "the sale was counted in the bucket");
});

test("shadow quotes: every candidate is sampled by default, and every leader sell is quoted (once each, up to MAX_SELL_QUOTES)", async () => {
  assert.equal(config.brainShadowQuoteRate, 1);
  const db = openDb(":memory:");
  const clock = { t: Date.parse("2026-11-10T12:00:00.000Z") };
  const q = new Q.ShadowQuotes(db, { now: () => clock.t, random: Math.random, bucket: new Q.JupiterBucket(() => 10_000, clock.t), quoteSell: async (_m, tokens) => tokens * 1e-6, lastTracked: () => null });
  const n = 40;
  for (let i = 0; i < n; i++) assert.equal(q.onCandidate({ leader: `L${i}`, mint: "X", signature: `s${i}`, priceSol: 1e-6, solAmount: 0.5, t: clock.t }), true, `candidate ${i}`);
  assert.equal(q.pending(), n * Q.HORIZONS_SEC.length, "no per-minute sampling throttle");
  clock.t += 1_000;
  for (const t of [clock.t, clock.t, clock.t + 3_000]) q.onLeaderSell("L0", "X", t); // the same sell twice, then another
  await q.runDue();
  const sells = () => (db.prepare("SELECT COUNT(*) n FROM brain_shadow_quotes WHERE leader = 'L0' AND trigger = 'leader_sell'").get() as { n: number }).n;
  assert.equal(sells(), 2, "each sell once");
  for (let i = 0; i < Q.MAX_SELL_QUOTES + 10; i++) q.onLeaderSell("L0", "X", clock.t + 10_000 + i);
  await q.runDue();
  assert.equal(sells(), Q.MAX_SELL_QUOTES, "a bot selling hundreds of times can't flood the bucket");
  clock.t += 60_000;
  await q.runDue();
  const time = db.prepare("SELECT COUNT(*) n FROM brain_shadow_quotes WHERE trigger = 'time' AND status = 'ok'").get() as { n: number };
  assert.equal(time.n, n * Q.HORIZONS_SEC.length);
});

test("the mirror ledger's quotes take the bucket's mirror lane and back it off on a 429", async () => {
  const db = openDb(":memory:");
  const clock = { t: 5_000_000 };
  const bucket = new Q.JupiterBucket(() => 8, clock.t);
  let fail = true;
  const q = new Q.ShadowQuotes(db, { now: () => clock.t, random: () => 0, bucket, quoteSell: async (_m, tokens) => { if (fail) throw rateLimit(); return tokens * 1e-6; }, lastTracked: () => null });
  assert.equal(await q.tryQuote("B", 1e5), null, "a failed quote: no y_quote");
  assert.ok(bucket.backingOff(clock.t));
  assert.equal(await q.tryQuote("B", 1e5), undefined, "backing off: not asked");
  clock.t += Q.BACKOFF_MIN_MS;
  fail = false;
  near((await q.tryQuote("B", 1e5))!, 0.1);
  const got = await Promise.all([1, 2, 3, 4, 5, 6].map(() => q.tryQuote("B", 1e5)));
  assert.ok(got.filter((x) => x === undefined).length >= 2, "the mirror lane leaves the top quarter of the bucket to the exits");
});
