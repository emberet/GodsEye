/**
 * The Brain's paper accounts (brain/paper.ts, brain/transitions.ts): fills with fees and rent, the real limits per account,
 * the Baseline mirroring the real rules, hard stops, and the transitions the Mac trains on. In-memory database, a stub market
 * (quotes at a set price, nothing sent): no network, no model.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { dataPath, openDb, setMeta, type DB } from "@godseye/shared";

process.env.COPY_BUDGET_SOL = "1";
process.env.COPY_MAX_TRADE_SOL = "0.1";
process.env.COPY_MIN_TRADE_SOL = "0.01";
process.env.COPY_MAX_POSITIONS = "0";
process.env.COPY_DAILY_LOSS_LIMIT_SOL = "0.05";
process.env.COPY_STOP_LOSS_PCT = "35";
process.env.COPY_TAKE_PROFIT_PCT = "300";
process.env.COPY_MAX_HOLD_HOURS = "48";
process.env.MIN_LEADER_BUY_SOL = "0.2";
process.env.BRAIN_TX_COST_SOL = "0.0002";
process.env.BRAIN_RENT_SOL = "0.002";
process.env.BRAIN_HARD_STOP_PCT = "60";
process.env.BRAIN_MAX_HOLD_HOURS = "24";
process.env.BRAIN_BANKROLL_SOL = "";
const { PaperBook, paperRugCheck, EXIT_QUOTE_REUSE_MS, DEAD_AFTER_FAILS } = await import("../src/brain/paper");
const { JupiterBucket, sellQuoteClient } = await import("../src/brain/quotes");
const { HttpError } = await import("../src/http");
const { attachLogDb } = await import("../src/log");
const { config } = await import("../src/config");
const { isPaused } = await import("../src/copy/engine");
const { ladderRule, storeExits } = await import("../src/learning/exits");
type Book = InstanceType<typeof PaperBook>;
type Deps = NonNullable<ConstructorParameters<typeof PaperBook>[1]>;

const TX = 0.0002;
const RENT = 0.002;
const near = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

/** A market with set prices: quotes at the price, a coin can lose its route, or its quotes can fail (a rate limit). */
function market(t0 = Date.now()) {
  const prices = new Map<string, number>();
  const noRoute = new Set<string>();
  const failing = new Set<string>();
  const clock = { t: t0 };
  const sells: { mint: string; tokens: number }[] = [];
  const deps: Partial<Deps> = {
    now: () => clock.t,
    wait: async (ms) => void (clock.t += ms),
    delayMs: 2000,
    quoteBuy: async (mint, sol) => {
      const p = prices.get(mint);
      return p && !noRoute.has(mint) ? { tokens: sol / p, priceSol: p } : null;
    },
    quoteSell: async (mint, tokens) => {
      sells.push({ mint, tokens });
      if (failing.has(mint)) throw new Error("HTTP 429");
      const p = prices.get(mint);
      return p && !noRoute.has(mint) ? tokens * p : null;
    },
  };
  return { prices, noRoute, failing, clock, sells, deps };
}

function seedWallet(db: DB, address: string, weight = 0, shadow = 0) {
  const now = new Date().toISOString();
  db.prepare("INSERT OR REPLACE INTO wallets (address, first_seen_at, discovered_via, tier, copy_weight, shadow_only) VALUES (?, ?, 'test', 'proven', ?, ?)").run(address, now, weight, shadow);
}

/** A shadow-only research wallet: not one the real engine copies, but with a real per-trade size (copySize 0.1 at weight 0.1). */
const research = (db: DB, address: string, weight = 0.1) => seedWallet(db, address, weight, 1);

let sigN = 0;
const buy = (m: ReturnType<typeof market>, leader: string, mint: string, solAmount = 1) => ({
  leader, mint, symbol: "MEME", solAmount, priceSol: m.prices.get(mint) ?? 1e-6, signature: `sig${++sigN}`, t: m.clock.t,
});

const brainOnly = (stakeFrac: number, extra: Record<string, unknown> = {}) => () => ({ brain: { stakeFrac, q: [0, 0.1, 0.2, 0.3, 0.4], features: [1, 2, 3], modelVersion: "v1", ...extra } });

function positions(db: DB, account?: string) {
  return db.prepare(`SELECT * FROM brain_paper_positions ${account ? "WHERE account = ?" : ""} ORDER BY id`).all(...(account ? [account] : [])) as Record<string, any>[];
}
const cash = (db: DB, account: string) => (db.prepare("SELECT cash_sol FROM brain_paper_accounts WHERE account = ?").get(account) as { cash_sol: number }).cash_sol;
const realRows = (db: DB) => (db.prepare("SELECT (SELECT COUNT(*) FROM copy_trades) + (SELECT COUNT(*) FROM positions) n").get() as { n: number }).n;

function setup(deps: Partial<Deps> = {}) {
  const db = openDb(":memory:");
  const m = market();
  const book: Book = new PaperBook(db, { ...m.deps, ...deps });
  return { db, m, book };
}

test("a paper fill pays the stake, the fee and the rent; a full sell refunds the rent and books the net P&L", async () => {
  const exits: string[] = ["hold", "sell_all"];
  const { db, m, book } = setup({ decideEntry: brainOnly(1), decideExit: () => ({ action: exits.shift() as "hold", features: [9], q: [0.1, 0, 0.2] }) });
  research(db, "W1");
  m.prices.set("COIN", 1e-6);
  const before = m.clock.t;
  await book.onLeaderBuy(buy(m, "W1", "COIN"));
  assert.equal(m.clock.t - before, 2000, "filled after the copy delay");
  const [p] = positions(db, "brain");
  near(p.cost_sol, 0.1);
  near(p.fee_sol, TX);
  near(p.rent_sol, RENT);
  near(p.tokens, 0.1 / 1e-6, 1e-3);
  near(cash(db, "brain"), 1 - 0.1 - TX - RENT);

  m.prices.set("COIN", 2e-6); // doubled
  m.clock.t += 60_000;
  await book.tick(); // hold
  m.clock.t += 60_000;
  await book.tick(); // sell_all
  const [c] = positions(db, "brain");
  assert.equal(c.status, "closed");
  near(c.proceeds_sol, 0.2, 1e-9);
  near(c.fee_sol, 2 * TX);
  near(c.pnl_sol, 0.2 - 0.1 - 2 * TX);
  near(cash(db, "brain"), 1 - 0.1 - TX - RENT + (0.2 - TX) + RENT);
  near(book.equity("brain"), 1 + c.pnl_sol);
  assert.equal(realRows(db), 0, "nothing in copy_trades or positions");
});

test("Brain's stake is a fraction of the real per-trade size (COPY_MAX_TRADE_SOL) and never more, whatever the model asks; below the minimum it's a skip", async () => {
  const { db, m, book } = setup({ decideEntry: brainOnly(7) });
  research(db, "W1");
  research(db, "W2", 0.03); // the real engine would stake 0.03 SOL on this wallet
  m.prices.set("A", 1e-6);
  await book.onLeaderBuy(buy(m, "W1", "A"));
  await book.onLeaderBuy(buy(m, "W2", "A"));
  const [p] = positions(db, "brain");
  near(p.cost_sol, 0.1);
  near(p.stake_frac, 1);
  const half = setup({ decideEntry: brainOnly(0.5) });
  research(half.db, "W2", 0.03);
  half.m.prices.set("B", 1e-6);
  await half.book.onLeaderBuy(buy(half.m, "W2", "B"));
  near(positions(half.db, "brain")[0].cost_sol, 0.05, 1e-9);
  const e = half.db.prepare("SELECT action, info FROM brain_transitions WHERE kind='entry'").get() as { action: number; info: string };
  assert.deepEqual([e.action, JSON.parse(e.info).base_size_sol], [0.5, 0.1], "the trainer sees the size the fraction is of");
  const w2 = setup({ decideEntry: brainOnly(1) });
  research(w2.db, "W2", 0.03);
  w2.m.prices.set("B", 1e-6);
  await w2.book.onLeaderBuy(buy(w2.m, "W2", "B"));
  near(positions(w2.db, "brain")[0].cost_sol, 0.1, 1e-9);

  const small = setup({ decideEntry: brainOnly(0.05) });
  research(small.db, "W1");
  small.m.prices.set("A", 1e-6);
  await small.book.onLeaderBuy(buy(small.m, "W1", "A"));
  assert.equal(positions(small.db).length, 0);
  const tr = small.db.prepare("SELECT reward, done, info FROM brain_transitions").get() as { reward: number; done: number; info: string };
  assert.deepEqual([tr.reward, tr.done, JSON.parse(tr.info).blocked], [0, 1, "below the minimum trade"]);
});

test("budget and cash cap each account's entries; the daily loss limit blocks only the account that lost, until the next UTC day", async () => {
  const { db, m, book } = setup({ decideEntry: brainOnly(1) });
  research(db, "W1");
  db.prepare("UPDATE brain_paper_accounts SET bankroll_sol = 0.25, cash_sol = 0.25").run();
  for (const c of ["A", "B", "C", "D"]) {
    m.prices.set(c, 1e-6);
    await book.onLeaderBuy(buy(m, "W1", c));
  }
  const open = positions(db, "brain");
  assert.equal(open.length, 3, "the fourth finds the budget used up");
  near(open[2].cost_sol, 0.25 - 2 * (0.1 + TX + RENT) - TX - RENT, 1e-6); // the third is cut to the cash left
  assert.ok(cash(db, "brain") >= 0);
  const blocked = db.prepare("SELECT info FROM brain_transitions WHERE kind='entry' ORDER BY id DESC").get() as { info: string };
  assert.equal(JSON.parse(blocked.info).blocked, "budget fully in use");
  // One position per coin per account.
  await book.onLeaderBuy(buy(m, "W1", "A"));
  assert.equal(positions(db, "brain").length, 3);

  // Daily loss: lose 0.06 on A (limit 0.05) → Brain is blocked today, Explore is not.
  const d = setup({ decideEntry: (s) => (s.mint.startsWith("X") ? { explore: { stakeFrac: 1, features: [], modelVersion: "v1" } } : brainOnly(1)()) });
  research(d.db, "W1");
  d.m.prices.set("A", 1e-6);
  await d.book.onLeaderBuy(buy(d.m, "W1", "A"));
  d.m.prices.set("A", 0.3e-6); // −70%: hard stop
  await d.book.onPrice("A", 0.3e-6);
  const lost = positions(d.db, "brain")[0];
  assert.equal(lost.status, "closed");
  assert.ok(lost.pnl_sol <= -0.05);
  d.m.prices.set("B", 1e-6);
  await d.book.onLeaderBuy(buy(d.m, "W1", "B"));
  assert.equal(positions(d.db, "brain").length, 1, "Brain blocked by its loss limit");
  d.m.prices.set("XB", 1e-6);
  await d.book.onLeaderBuy(buy(d.m, "W1", "XB"));
  assert.equal(positions(d.db, "explore").length, 1, "Explore has its own day");
  d.m.clock.t += 86_400_000;
  await d.book.onLeaderBuy(buy(d.m, "W1", "B"));
  assert.equal(positions(d.db, "brain").length, 2, "a new UTC day");
});

test("the real pause (copy_paused and data/PAUSE) does not stop paper trading, and nothing reaches copy_trades or positions", async () => {
  const { db, m, book } = setup({ decideEntry: brainOnly(1) });
  research(db, "W1");
  setMeta(db, "copy_paused", "1");
  const file = dataPath("PAUSE");
  fs.writeFileSync(file, "");
  try {
    assert.equal(isPaused(db), true);
    m.prices.set("A", 1e-6);
    await book.onLeaderBuy(buy(m, "W1", "A"));
    assert.equal(positions(db, "brain").length, 1);
    await book.onLeaderSell("W1", "A");
    assert.equal(realRows(db), 0);
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test("Baseline copies current leaders only, at copySize of their weight; Brain sees every analyzed wallet, shadow-only too", async () => {
  const { db, m, book } = setup({ decideEntry: brainOnly(0.5) });
  seedWallet(db, "LEADER", 0.05);
  seedWallet(db, "NOBODY", 0);
  research(db, "RESEARCH", 0.08);
  for (const [w, c] of [["LEADER", "A"], ["NOBODY", "B"], ["RESEARCH", "C"], ["UNKNOWN", "D"]]) {
    m.prices.set(c, 1e-6);
    await book.onLeaderBuy(buy(m, w, c));
  }
  const base = positions(db, "baseline");
  assert.deepEqual(base.map((p) => p.leader), ["LEADER"]);
  near(base[0].cost_sol, 0.05, 1e-9); // copySize(0.05) with a 1 SOL budget
  assert.match(base[0].exit_rule, /^sl35 tp300$/);
  assert.deepEqual(positions(db, "brain").map((p) => p.leader), ["LEADER", "NOBODY", "RESEARCH"], "not a wallet GodsEye never analyzed");
  // Half of the real per-trade size (0.1 SOL), whatever the wallet's copy weight, weight-0 and research wallets included.
  for (const p of positions(db, "brain")) near(p.cost_sol, 0.05, 1e-9);
  // Dust and late buys are left alone, as by the real engine.
  m.prices.set("E", 1e-6);
  await book.onLeaderBuy(buy(m, "LEADER", "E", 0.1));
  await book.onLeaderBuy({ ...buy(m, "LEADER", "E"), t: m.clock.t - 120_000 });
  assert.equal(positions(db).filter((p) => p.mint === "E").length, 0);
});

test("Baseline mirrors the real exits: the leader's sells, the learned ladder with its trailing stop, the stop-loss", async () => {
  const { db, m, book } = setup();
  seedWallet(db, "L", 0.1);
  storeExits(db, { ...ladderRule(35, 30, 20), reason: "test" });
  m.prices.set("A", 1e-6);
  await book.onLeaderBuy(buy(m, "L", "A"));
  m.clock.t += 5000;
  m.prices.set("A", 1.4e-6);
  await book.onPrice("A", 1.4e-6); // +40%: the ladder sells half
  let [p] = positions(db, "baseline");
  assert.equal(p.half_sold, 1);
  near(p.tokens_left, p.tokens / 2, 1e-3);
  m.clock.t += 5000;
  m.prices.set("A", 2e-6);
  await book.onPrice("A", 2e-6); // peak +100%
  m.clock.t += 5000;
  m.prices.set("A", 1.5e-6);
  await book.onPrice("A", 1.5e-6); // 25% below its best: the trailing stop sells the rest
  [p] = positions(db, "baseline");
  assert.equal(p.status, "closed");
  assert.match(p.exit_reason, /trailing stop/);

  // Leader sells half, then the rest; a −40% price is a stop-loss only once a sell quote confirms it.
  m.prices.set("B", 1e-6);
  await book.onLeaderBuy(buy(m, "L", "B"));
  await book.onLeaderSell("L", "B", m.clock.t, 0.5);
  let b = positions(db, "baseline").find((x) => x.mint === "B")!;
  near(b.tokens_left, b.tokens / 2, 1e-3);
  assert.equal(b.status, "open");
  m.clock.t += 5000;
  await book.onPrice("B", 0.6e-6); // the quote still says 1e-6: not confirmed
  b = positions(db, "baseline").find((x) => x.mint === "B")!;
  assert.equal(b.status, "open");
  await book.onLeaderSell("L", "B", m.clock.t, 1);
  b = positions(db, "baseline").find((x) => x.mint === "B")!;
  assert.equal(b.status, "closed");
  assert.equal(b.exit_reason, "leader sold 100%");
  near(b.pnl_sol, -3 * TX, 1e-9); // three swaps' fees: the buy and two sells
  m.prices.set("C", 1e-6);
  await book.onLeaderBuy(buy(m, "L", "C"));
  m.clock.t += 5000;
  m.prices.set("C", 0.6e-6);
  await book.onPrice("C", 0.6e-6); // −40%, and the quote agrees: the rule's 35% stop-loss
  const c = positions(db, "baseline").find((x) => x.mint === "C")!;
  assert.equal(c.status, "closed");
  assert.match(c.exit_reason, /^stop-loss at -40\.00% \(sell quote\)/);
});

test("a leader sell during the copy delay is applied right after the fill, as the real engine's sell queued behind its buy", async () => {
  let release: (() => void) | null = null;
  let waiting: () => void = () => {};
  const reached = () => new Promise<void>((r) => (waiting = r));
  const seen: boolean[] = [];
  const { db, m, book } = setup({
    decideEntry: brainOnly(1),
    decideExit: (_p, st) => (seen.push(st.leader_sold), { action: "hold" }),
    wait: (ms) => new Promise<void>((r) => {
      release = () => ((m.clock.t += ms), r());
      waiting();
    }),
  });
  seedWallet(db, "L", 0.1);
  seedWallet(db, "OTHER", 0.1);
  m.prices.set("A", 1e-6);
  let at = reached();
  const filling = book.onLeaderBuy(buy(m, "L", "A"));
  await at;
  assert.equal(positions(db).length, 0, "still in the copy delay");
  await book.onLeaderSell("OTHER", "A", m.clock.t, 1); // someone else's sell: not ours to mirror
  await book.onLeaderSell("L", "A", m.clock.t, 1);
  release!();
  await filling;
  const base = positions(db, "baseline")[0];
  assert.equal(base.status, "closed");
  assert.equal(base.exit_reason, "leader sold 100%");
  const br = positions(db, "brain")[0];
  assert.deepEqual([br.status, br.leader_sold], ["open", 1]);
  assert.deepEqual(seen, [true], "Brain's network is asked at once, with leader_sold");

  // A partial sell in the delay: Baseline sells the same share after the fill, and a later sell isn't applied twice.
  m.prices.set("B", 1e-6);
  at = reached();
  const second = book.onLeaderBuy(buy(m, "L", "B"));
  await at;
  await book.onLeaderSell("L", "B", m.clock.t, 0.5);
  release!();
  await second;
  let b = positions(db, "baseline").find((x) => x.mint === "B")!;
  near(b.tokens_left, b.tokens / 2, 1e-3);
  assert.equal(b.status, "open");
  await book.onLeaderSell("L", "B", m.clock.t, 0.5);
  b = positions(db, "baseline").find((x) => x.mint === "B")!;
  near(b.tokens_left, b.tokens / 4, 1e-3);
  assert.equal(realRows(db), 0);
});

test("hard stops: −60% (confirmed by a quote) and the max hold close Brain positions whatever the network says", async () => {
  const { db, m, book } = setup({ decideEntry: brainOnly(1), decideExit: () => ({ action: "hold", features: [1] }) });
  research(db, "W1");
  m.prices.set("A", 1e-6);
  m.prices.set("B", 1e-6);
  await book.onLeaderBuy(buy(m, "W1", "A"));
  await book.onLeaderBuy(buy(m, "W1", "B"));
  m.clock.t += 3000;
  await book.onPrice("A", 0.35e-6); // a print at −65%, but the pool still quotes 1e-6
  assert.equal(positions(db, "brain")[0].status, "open");
  m.prices.set("A", 0.35e-6);
  m.clock.t += 3000;
  await book.onPrice("A", 0.35e-6);
  assert.equal(positions(db, "brain")[0].status, "open", "the quote from 3 s ago (above the stop) is reused");
  m.clock.t += 15_000;
  await book.onPrice("A", 0.35e-6); // past EXIT_QUOTE_REUSE_MS: a fresh quote confirms the stop
  const a = positions(db, "brain")[0];
  assert.equal(a.status, "closed");
  assert.match(a.exit_reason, /^hard stop/);

  m.clock.t += 24 * 3_600_000;
  await book.tick();
  const b = positions(db, "brain")[1];
  assert.equal(b.status, "closed");
  assert.match(b.exit_reason, /max hold/);
  const forced = db.prepare("SELECT action, done, reward, info FROM brain_transitions WHERE position_id = ? AND kind = 'exit' ORDER BY id DESC").get(b.id) as { action: number; done: number; reward: number; info: string };
  assert.deepEqual([forced.action, forced.done, JSON.parse(forced.info).forced], [2, 1, "max-hold"]);
  near(forced.reward, b.pnl_sol);
});

test("a coin with no stream price for 90 s is priced by a sell quote", async () => {
  const { db, m, book } = setup({ decideEntry: brainOnly(1) });
  research(db, "W1");
  m.prices.set("A", 1e-6);
  await book.onLeaderBuy(buy(m, "W1", "A"));
  m.prices.set("A", 1.2e-6);
  m.clock.t += 30_000;
  await book.tick();
  assert.equal(m.sells.length, 0, "the price is still fresh");
  m.clock.t += 90_000;
  await book.tick();
  assert.equal(m.sells.length, 1);
  const [p] = positions(db, "brain");
  near(p.last_price_sol, 1.2e-6, 1e-15);
  near(p.peak_pct, 20, 1e-6);
  m.prices.set("A", 0.2e-6);
  m.clock.t += 120_000;
  await book.tick(); // the quote is the price: −80% → hard stop
  assert.match(positions(db, "brain")[0].exit_reason, /^hard stop/);

});

test("dead coin: a sell quote with no route marks it near zero (not at its last price); 3 in a row write it off at 0 with the rent lost", async () => {
  const states: { quote_failed: boolean; ret_now: number }[] = [];
  const { db, m, book } = setup({ decideEntry: brainOnly(1), decideExit: (_p, st) => (states.push(st), { action: "hold", features: [1] }) });
  research(db, "W1");
  m.prices.set("R", 1e-6);
  await book.onLeaderBuy(buy(m, "W1", "R"));
  m.prices.set("R", 1.5e-6);
  m.clock.t += 120_000;
  await book.tick(); // a routed quote: +50%
  assert.equal(states.at(-1)!.quote_failed, false);
  near(book.equity("brain"), 1 - TX + 0.05, 1e-9);

  m.noRoute.add("R");
  m.clock.t += 120_000;
  await book.tick(); // no route 1: the stop fires on the near-zero mark but nothing can be sold
  let p = positions(db, "brain")[0];
  assert.deepEqual([p.status, p.quote_failed, p.quote_fails], ["open", 1, 1]);
  near(p.last_price_sol, 1.5e-6, 1e-15); // the last real price is kept for the record, not as the mark
  assert.ok(book.equity("brain") < 1 - 0.1 + 0.001, "the position is worth about nothing, not +50%");

  m.failing.add("R"); // a rate limit says nothing about the coin: the streak neither grows nor ends
  m.clock.t += 60_000;
  await book.tick();
  assert.equal(positions(db, "brain")[0].quote_fails, 1);
  m.failing.delete("R");
  m.clock.t += 60_000;
  await book.tick(); // no route 2
  assert.equal(positions(db, "brain")[0].status, "open");
  m.clock.t += 60_000;
  await book.tick(); // no route 3: dead
  p = positions(db, "brain")[0];
  assert.equal(p.status, "closed");
  assert.match(p.exit_reason, /dead, written off/);
  near(p.pnl_sol, -(0.1 + TX + RENT)); // stake, the buy's fee and the rent: nothing sold, the account never closed
  near(cash(db, "brain"), 1 - 0.1 - TX - RENT);
  const forced = db.prepare("SELECT action, features, reward, done, info FROM brain_transitions WHERE position_id = ? AND kind = 'exit' ORDER BY id DESC").get(p.id) as Record<string, any>;
  assert.deepEqual([forced.action, forced.features, forced.done, JSON.parse(forced.info).forced], [2, "[]", 1, "dead"]);
  near(forced.reward, p.pnl_sol);
  const entry = db.prepare("SELECT reward FROM brain_transitions WHERE position_id = ? AND kind = 'entry'").get(p.id) as { reward: number };
  near(entry.reward, p.pnl_sol);
  assert.equal(realRows(db), 0);
});

test("a tracked wallet's stream price ends a no-route streak (a raw or untracked one doesn't); Baseline's dead coins are written off too", async () => {
  const { db, m, book } = setup({ decideEntry: brainOnly(1) });
  seedWallet(db, "L", 0.1);
  m.prices.set("R", 1e-6);
  await book.onLeaderBuy(buy(m, "L", "R"));
  m.noRoute.add("R");
  for (let i = 0; i < 2; i++) {
    m.clock.t += 120_000;
    await book.tick();
  }
  assert.deepEqual(positions(db).map((p) => p.quote_fails), [2, 2]);
  const trackedTs = positions(db).map((p) => p.last_tracked_price_ts);
  // A raw stream price (the caller doesn't say whose swap it was) or an untracked wallet's: it marks the coin, but it is
  // no tracked trade, so neither the streak nor the staleness clock moves.
  await book.onPrice("R", 1e-6, m.clock.t, 0.5);
  m.clock.t += 2_000; // past the per-position stream check interval
  await book.onPrice("R", 1e-6, m.clock.t, 0.5, { tracked: false });
  assert.deepEqual(positions(db).map((p) => [p.status, p.quote_fails, p.quote_failed]), [["open", 2, 1], ["open", 2, 1]]);
  assert.deepEqual(positions(db).map((p) => p.last_tracked_price_ts), trackedTs);
  m.clock.t += 2_000;
  await book.onPrice("R", 1e-6, m.clock.t, 0.5, { tracked: true }); // a tracked wallet traded it: there is a route after all
  assert.deepEqual(positions(db).map((p) => [p.status, p.quote_fails, p.quote_failed]), [["open", 0, 0], ["open", 0, 0]]);
  assert.deepEqual(positions(db).map((p) => p.last_tracked_price_ts), [new Date(m.clock.t).toISOString(), new Date(m.clock.t).toISOString()]);
  for (let i = 0; i < 3; i++) {
    m.clock.t += 120_000;
    await book.tick();
  }
  const ps = positions(db);
  assert.deepEqual(ps.map((p) => p.status), ["closed", "closed"]);
  for (const p of ps) near(p.pnl_sol, -(p.cost_sol + TX + RENT));
  assert.match(ps.find((p) => p.account === "baseline")!.exit_reason, /dead, written off/);
  assert.equal(realRows(db), 0);
});

test("the trailing outlier filter keeps a bad print out of the peak and the stops", async () => {
  const seen: { peak_ret: number }[] = [];
  const { db, m, book } = setup({ decideEntry: brainOnly(1), decideExit: (_p, st) => (seen.push(st), { action: "hold" }) });
  research(db, "W1");
  m.prices.set("A", 1e-6);
  await book.onLeaderBuy(buy(m, "W1", "A"));
  m.clock.t += 20_000;
  await book.onPrice("A", 1e-3, m.clock.t, 1); // a 1000× print
  m.clock.t += 20_000;
  await book.onPrice("A", 1e-9, m.clock.t, 1); // and a −99.9% one
  let [p] = positions(db, "brain");
  assert.deepEqual([p.status, p.peak_pct], ["open", 0]);
  m.clock.t += 20_000;
  await book.onPrice("A", 1.3e-6, m.clock.t, 0.0001); // dust: no price either
  m.clock.t += 20_000;
  await book.onPrice("A", 1.3e-6, m.clock.t, 1);
  [p] = positions(db, "brain");
  near(p.peak_pct, 30, 1e-6);
  // StreamState already judged it: a swap it marked not ok never prices the position.
  m.clock.t += 20_000;
  await book.onPrice("A", 5e-6, m.clock.t, 1, { ok: false });
  near(positions(db, "brain")[0].peak_pct, 30, 1e-6);
});

test("the exit state carries the stream and leader features; the stream-swap hook prices the coin and evaluates at once on the leader's sell", async () => {
  const seen: Record<string, any>[] = [];
  const { db, m, book } = setup({
    decideEntry: brainOnly(1),
    decideExit: (_p, st) => (seen.push({ ...st, position: undefined }), { action: "hold", features: [1] }),
    lastTracked: () => null,
  });
  research(db, "W1");
  m.prices.set("A", 1e-6);
  const t0 = m.clock.t;
  await book.onLeaderBuy({ ...buy(m, "W1", "A"), venue: "pumpswap (via bot)", tokenAmount: 1_000, tokenBalanceBefore: 3_000 });
  let [p] = positions(db, "brain");
  assert.deepEqual([p.venue, p.leader_post_buy_tokens], ["pumpswap (via bot)", 4_000]);
  near(p.fee_sol, TX);

  const swap = (o: Record<string, unknown>) => ({
    wallet: "OTHER", mint: "A", side: "buy" as const, sol: 1, price: 1.1e-6, tokens: 1e6, ts: m.clock.t, at: m.clock.t, signature: `s${++sigN}`,
    ok: true, tracked: true, analyzed: false, venue: "pumpswap", tokenBalanceBefore: 0, ...o,
  });
  m.clock.t = t0 + 6 * 60_000;
  await book.onStreamSwap(swap({}));
  let st = seen.at(-1)!;
  near(st.ret_now, 0.1, 1e-9);
  near(st.ret_5m_ago, 0, 1e-9);
  near(st.mins_since_tracked_price, 0, 1e-9);
  assert.equal(st.leader_sold_frac, 0);
  assert.equal(st.sell_quote_ratio, null, "no sell quote yet");

  // The leader sells 2,000 of its 4,000: evaluated at once (no 15 s wait), leader_sold_frac 0.5.
  m.clock.t += 1_000;
  const before = seen.length;
  await book.onStreamSwap(swap({ wallet: "W1", side: "sell", tracked: false, analyzed: true, ok: false, tokens: 2_000, tokenBalanceBefore: 4_000 }));
  assert.equal(seen.length, before + 1);
  st = seen.at(-1)!;
  assert.equal(st.leader_sold, true);
  near(st.leader_sold_frac, 0.5, 1e-9);
  near(st.minutes_since_leader_sold, 0, 1e-9);

  // No stream price for 2 min: a sell quote marks it; the quote / stream price ratio is read from it.
  m.prices.set("A", 1.0e-6);
  m.clock.t += 120_000;
  await book.tick();
  st = seen.at(-1)!;
  near(st.sell_quote_ratio, 1 / 1.1, 1e-9);
  near(st.mins_since_tracked_price, 121_000 / 60_000, 1e-9);
  near(st.minutes_since_price, 0, 1e-9);
  near(st.minutes_since_leader_sold, 2, 1e-9);
  near(st.ret_5m_ago, 0, 1e-9); // 5 minutes ago it was the entry
  m.clock.t += 4 * 60_000;
  await book.tick();
  near(seen.at(-1)!.ret_5m_ago, 0.1, 1e-9); // now 5 minutes ago it was the +10% stream mark
  [p] = positions(db, "brain");
  assert.ok(p.last_tracked_price_ts && p.quote_ts);
  assert.equal(realRows(db), 0);
});

test("transitions: a row per entry decision and per exit evaluation; the close fills the rewards", async () => {
  const actions = ["hold", "sell_half", "sell_half", "sell_all"];
  const { db, m, book } = setup({
    decideEntry: (s) => brainOnly(s.mint === "SKIP" ? 0 : 1)(),
    decideExit: (_p, st) => {
      assert.equal(typeof st.ret_now, "number");
      return { action: actions.shift() as "hold", features: [st.ret_now, st.minutes_held], q: [0, 1, 2], modelVersion: "v1" };
    },
  });
  research(db, "W1");
  m.prices.set("SKIP", 1e-6);
  await book.onLeaderBuy(buy(m, "W1", "SKIP"));
  const skip = db.prepare("SELECT * FROM brain_transitions").get() as Record<string, any>;
  assert.deepEqual([skip.kind, skip.account, skip.action, skip.reward, skip.done, skip.model_version], ["entry", "brain", 0, 0, 1, "v1"]);
  assert.deepEqual(JSON.parse(skip.features), [1, 2, 3]);
  assert.deepEqual(JSON.parse(skip.q), [0, 0.1, 0.2, 0.3, 0.4]);

  m.prices.set("A", 1e-6);
  await book.onLeaderBuy(buy(m, "W1", "A"));
  for (let i = 0; i < 4; i++) {
    m.clock.t += 120_000; // no stream price: each minute's check prices it by a sell quote
    m.prices.set("A", (1 + 0.1 * (i + 1)) * 1e-6);
    await book.tick();
  }
  const [p] = positions(db, "brain");
  assert.equal(p.status, "closed");
  const rows = db.prepare("SELECT kind, action, reward, done, info FROM brain_transitions WHERE position_id = ? ORDER BY id").all(p.id) as Record<string, any>[];
  assert.deepEqual(rows.map((r) => [r.kind, r.action]), [["entry", 1], ["exit", 0], ["exit", 1], ["exit", 0], ["exit", 2]], "a second sell_half is a hold");
  assert.equal(JSON.parse(rows[3].info).chosen, "sell_half");
  near(rows[0].reward, p.pnl_sol);
  assert.deepEqual(rows.slice(1, 4).map((r) => r.reward), [null, null, null]);
  assert.deepEqual([rows[4].done, rows[4].reward], [1, p.pnl_sol]);
  assert.equal(p.half_sold, 1);
  near(p.fee_sol, 3 * TX);
  // Leader sold: the network is asked at once, with leader_sold set.
  const seen: boolean[] = [];
  const l = setup({ decideEntry: brainOnly(1), decideExit: (_p, st) => (seen.push(st.leader_sold), { action: "hold" }) });
  research(l.db, "W1");
  l.m.prices.set("A", 1e-6);
  await l.book.onLeaderBuy(buy(l.m, "W1", "A"));
  await l.book.onLeaderSell("W1", "A", l.m.clock.t, 1);
  assert.deepEqual(seen, [true]);
});

test("Explore trades are kept apart from Brain's: own account, own position in the same coin, flagged explore", async () => {
  let route: "brain" | "explore" = "explore";
  const { db, m, book } = setup({ decideEntry: () => ({ [route]: { stakeFrac: 0.5, features: [], modelVersion: "v2" } }) });
  research(db, "W1");
  m.prices.set("A", 1e-6);
  await book.onLeaderBuy(buy(m, "W1", "A"));
  route = "brain";
  await book.onLeaderBuy(buy(m, "W1", "A"));
  const ex = positions(db, "explore");
  const br = positions(db, "brain");
  assert.equal(ex.length, 1);
  assert.equal(br.length, 1);
  assert.deepEqual([ex[0].explore, br[0].explore], [1, 0]);
  near(cash(db, "explore"), 1 - 0.05 - TX - RENT);
  near(cash(db, "brain"), 1 - 0.05 - TX - RENT);
  near(cash(db, "baseline"), 1);
  const tr = db.prepare("SELECT account, COUNT(*) n FROM brain_transitions GROUP BY account ORDER BY account").all() as { account: string; n: number }[];
  assert.deepEqual(tr, [{ account: "brain", n: 1 }, { account: "explore", n: 1 }]);
  m.clock.t += 10 * 60_000;
  await book.tick();
  const eq = db.prepare("SELECT account, equity_sol FROM brain_paper_equity ORDER BY account").all() as { account: string; equity_sol: number }[];
  assert.equal(eq.length, 3);
  near(eq.find((e) => e.account === "explore")!.equity_sol, 1 - TX);
});

test("exit confirmations are throttled: a recent quote is reused, the rest wait under their own cap; a sale is always quoted", async () => {
  const { db, m, book } = setup({ decideEntry: brainOnly(1), decideExit: () => ({ action: "hold", features: [1] }) });
  research(db, "W1");
  m.prices.set("A", 1e-6);
  await book.onLeaderBuy(buy(m, "W1", "A"));
  m.prices.set("A", 0.5e-6); // the pool quotes −50%: above the stop
  m.sells.length = 0;
  // The tape prints −70% on every 2 s stream check for a minute: a thin coin's print, never confirmed by the pool.
  for (let i = 0; i < 30; i++) {
    m.clock.t += 2000;
    await book.onPrice("A", 0.3e-6);
  }
  assert.equal(positions(db, "brain")[0].status, "open");
  assert.ok(m.sells.length <= Math.ceil(60_000 / EXIT_QUOTE_REUSE_MS) + 1, `${m.sells.length} quotes in 60 s`);

  // Over the cap: no confirmation is asked (logged); the stop waits for a later check, then fires on a fresh quote.
  const cap = config.brainExitQuotesPerMin;
  config.brainExitQuotesPerMin = 0;
  try {
    m.prices.set("A", 0.3e-6);
    m.clock.t += EXIT_QUOTE_REUSE_MS + 1000;
    const asked = m.sells.length;
    await book.onPrice("A", 0.3e-6);
    assert.equal(m.sells.length, asked, "capped: not asked");
    assert.equal(positions(db, "brain")[0].status, "open");
    assert.ok(book.quotesCapped > 0);
  } finally {
    config.brainExitQuotesPerMin = cap;
  }
  m.clock.t += 2000;
  await book.onPrice("A", 0.3e-6);
  const [p] = positions(db, "brain");
  assert.equal(p.status, "closed");
  assert.match(p.exit_reason, /^hard stop/);
  near(p.proceeds_sol, 0.1 * 0.3, 1e-9);
});

test("a quote refused by the API (401, 403, 404, 429, 5xx) is no dead coin; only Jupiter's no-route answer counts", async () => {
  const err = (status: number, body = "") => new HttpError(status, `${status} from api.jup.ag: ${body}`);
  const answers: Error[] = [err(401, '{"message":"Unauthorized"}'), err(403, "cloudflare"), err(404, "Not Found"), err(429, ""), err(500, "")];
  const { db, m, book } = setup({ decideEntry: brainOnly(1), quoteSell: sellQuoteClient(async () => Promise.reject(answers.shift() ?? err(400, '{"error":"Could not find any route","errorCode":"COULD_NOT_FIND_ANY_ROUTE"}'))) });
  research(db, "W1");
  m.prices.set("A", 1e-6);
  await book.onLeaderBuy(buy(m, "W1", "A"));
  for (let i = 0; i < 5; i++) {
    m.clock.t += 91_000; // stale: a sell quote each minute
    await book.tick();
    assert.deepEqual([positions(db, "brain")[0].quote_fails, positions(db, "brain")[0].status], [0, "open"], `answer ${i + 1} says nothing about the coin`);
  }
  for (let i = 0; i < DEAD_AFTER_FAILS; i++) {
    m.clock.t += 91_000;
    await book.tick();
  }
  const [p] = positions(db, "brain");
  assert.equal(p.status, "closed", "3 real no-route answers in a row: dead");
  assert.match(p.exit_reason, /dead/);
  // The shadow quotes' client maps the same way: a 400 that isn't a route error is an error too.
  const client = sellQuoteClient(async () => Promise.reject(err(400, '{"error":"Invalid mint"}')));
  await assert.rejects(client("A", 1));
});

test("a Jupiter outage (401, 503) on a coin with no tracked print for over 30 min writes nothing off; an error leaves a no-route streak as it was", async () => {
  const err = (status: number) => new HttpError(status, `${status} from api.jup.ag`);
  let answer: "ok" | "noroute" | 401 | 503 = "ok";
  const quoteSell = sellQuoteClient(async (_mint, tokens) => {
    if (answer === "ok") return tokens * 1e-6;
    if (answer === "noroute") throw new HttpError(400, '400 from api.jup.ag: {"errorCode":"COULD_NOT_FIND_ANY_ROUTE"}');
    throw err(answer);
  });
  const { db, m, book } = setup({ decideEntry: brainOnly(1), decideExit: () => ({ action: "hold" }), quoteSell });
  research(db, "W1");
  m.prices.set("A", 1e-6);
  await book.onLeaderBuy(buy(m, "W1", "A"));
  // 31 minutes with no tracked print: the coin is priced by quotes (most held minutes are stale on the tracked tape).
  for (let i = 0; i < 31; i++) {
    m.clock.t += 60_000;
    await book.tick();
  }
  for (const status of [401, 401, 401, 503, 503, 503] as const) {
    answer = status;
    m.clock.t += 60_000;
    await book.tick();
    assert.deepEqual([positions(db, "brain")[0].status, positions(db, "brain")[0].quote_fails], ["open", 0], `a ${status} says nothing about the coin`);
  }
  // no route, an outage, no route: the streak is 2 (the error neither counts nor ends it), and the third no route kills it.
  for (const [a, fails] of [["noroute", 1], [503, 1], ["noroute", 2]] as const) {
    answer = a;
    m.clock.t += 91_000;
    await book.tick();
    assert.equal(positions(db, "brain")[0].quote_fails, fails, `after ${a}`);
  }
  answer = "noroute";
  m.clock.t += 91_000;
  await book.tick();
  const [p] = positions(db, "brain");
  assert.equal(p.status, "closed");
  assert.match(p.exit_reason, /^no sell route 3 quotes in a row: dead/);
  const dead = db.prepare("SELECT info FROM brain_transitions WHERE kind = 'exit' ORDER BY id DESC LIMIT 1").get() as { info: string };
  assert.deepEqual([JSON.parse(dead.info).forced, JSON.parse(dead.info).quote_failed, JSON.parse(dead.info).quote_fails], ["dead", true, 3]);
});

test("a paper fill's buy quote takes a token from the Jupiter bucket; with none, or while it backs off, the entry closes as 'no quote'", async () => {
  const bucket = new JupiterBucket(() => 3, Date.now());
  let asked = 0;
  let rateLimit = false;
  const { db, m, book } = setup({
    decideEntry: brainOnly(1),
    bucket,
    quoteBuy: async (_mint, sol) => {
      asked++;
      if (rateLimit) throw new HttpError(429, "429 from api.jup.ag");
      return { tokens: sol / 1e-6, priceSol: 1e-6 };
    },
  });
  research(db, "W1");
  const before = bucket.left(m.clock.t); // full: the copy delay's refill can't top it up
  await book.onLeaderBuy(buy(m, "W1", "A"));
  assert.equal(positions(db, "brain").length, 1);
  near(bucket.left(m.clock.t), before - 1); // one token
  // A 429 on the buy quote: no fill, and the bucket backs off; the next fill isn't even asked.
  rateLimit = true;
  await book.onLeaderBuy(buy(m, "W1", "B"));
  assert.equal(bucket.backingOff(m.clock.t), true);
  const n = asked;
  await book.onLeaderBuy(buy(m, "W1", "C"));
  assert.equal(asked, n, "not asked while backing off");
  const blocked = (db.prepare("SELECT info FROM brain_transitions WHERE kind = 'entry' ORDER BY id").all() as { info: string }[]).map((r) => JSON.parse(r.info).blocked ?? null);
  assert.deepEqual(blocked, [null, "no quote: the buy quote failed", "no quote: Jupiter rate limit (backing off)"]);
  // Empty bucket (no back-off): refused as the cap.
  rateLimit = false;
  m.clock.t += 10 * 60_000;
  bucket.ok();
  while (bucket.take("exit", m.clock.t));
  await book.onLeaderBuy(buy(m, "W1", "D"));
  assert.equal(JSON.parse((db.prepare("SELECT info FROM brain_transitions WHERE kind = 'entry' ORDER BY id DESC LIMIT 1").get() as { info: string }).info).blocked, "no quote: Jupiter cap");
});

test("the paper rug check stores its verdict quietly: a blocked coin never reaches the public feed", async () => {
  const db = openDb(":memory:");
  attachLogDb(db);
  try {
    const blocked = { verdict: "blocked" as const, blocks: ["mint authority"], warnings: [], rugcheckScore: 90 };
    const screen = async () => ({ onchain: null, rc: null, holders: null, holdersStatus: "off" as const, verdict: blocked, chainMs: 0, rugcheckMs: 0, holdersMs: null });
    const v = await paperRugCheck(db, "RUG", "RUG", screen);
    assert.equal(v?.verdict, "blocked");
    assert.equal((db.prepare("SELECT verdict FROM rug_checks WHERE mint = 'RUG'").get() as { verdict: string }).verdict, "blocked", "cached for the next screen");
    assert.equal((await paperRugCheck(db, "RUG", "RUG", async () => assert.fail("cached")))?.verdict, "blocked");
    assert.equal((db.prepare("SELECT COUNT(*) n FROM agent_log").get() as { n: number }).n, 0, "nothing in agent_log");
    // The book's screen goes the same way (RUG_CHECK_ENABLED on).
    const book = new PaperBook(db, market().deps);
    const enabled = config.rugCheckEnabled;
    config.rugCheckEnabled = true;
    try {
      assert.equal(await (book as unknown as { deps: Deps }).deps.screen!("RUG", "RUG"), false);
    } finally {
      config.rugCheckEnabled = enabled;
    }
    assert.equal((db.prepare("SELECT COUNT(*) n FROM agent_log").get() as { n: number }).n, 0);
  } finally {
    attachLogDb(null as unknown as DB);
  }
});
