/**
 * The Brain's server state (brain/state.ts, ledger.ts, quotes.ts): the per-coin ring of tracked swaps with the trailing
 * outlier filter and its bounds, each coin's first sighting, the mirror / ps / dd ledgers and their delayed jobs, and the
 * shadow sell quotes under their hard per-minute cap. In-memory database, a set clock and stub quotes: no network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { openDb, type DB } from "@godseye/shared";
import type { ParsedSwap } from "../src/chain/parse";

process.env.MIN_LEADER_BUY_SOL = "0.2";
process.env.COPY_MAX_TRADE_SOL = "0.1";
process.env.BRAIN_SHADOW_QUOTES_PER_MIN = "7";
process.env.BRAIN_MIRROR_QUOTES_PER_MIN = "2";
process.env.BRAIN_SHADOW_QUOTE_RATE = "1";
process.env.BRAIN_CREATOR_LOOKUPS_PER_MIN = "2";
delete process.env.BRAIN_TX_COST_SOL;
const { config } = await import("../src/config");
const { StreamState, TrailingFilter, markOk, RING_MS, OK_WARM_ROWS } = await import("../src/brain/state");
const { MirrorLedger, MIRROR_COST, CP_SHRINK, logOutcome, DD_AVAIL_MS, DD_FROM_MS, DD_TO_MS, PS_AVAIL_MS } = await import("../src/brain/ledger");
const { ShadowQuotes, QuoteBudget, HORIZONS_SEC } = await import("../src/brain/quotes");
type State = InstanceType<typeof StreamState>;

const T0 = Date.parse("2026-11-01T00:00:00Z");
const MIN = 60_000;
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const near = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);
const realRows = (db: DB) => (db.prepare("SELECT (SELECT COUNT(*) FROM copy_trades) + (SELECT COUNT(*) FROM positions) n").get() as { n: number }).n;

let sigN = 0;
/** A streamed swap at block time `t` (ms). */
function swap(wallet: string, mint: string, side: "buy" | "sell", price: number, t: number, o: Partial<ParsedSwap> = {}): ParsedSwap {
  return {
    wallet, signature: `sig${++sigN}`, slot: 1, ts: iso(t), mint, side, tokenAmount: 1 / price, tokenBalanceBefore: 0, solAmount: 1, priceSol: price,
    quote: "SOL", quoteAmount: 1, solUsd: null, usdAmount: null, venue: "pumpswap", jitoTip: false, feeLamports: 5000, ...o,
  };
}

/** A stream state on a set clock: tracked wallets T*, analyzed (leader) wallets L*, creators looked up from a map. */
function setup(bounds = {}) {
  const db = openDb(":memory:");
  const clock = { t: T0 };
  const creators = new Map<string, string>();
  const lookups: string[] = [];
  const state: State = new StreamState(
    db,
    {
      now: () => clock.t,
      isTracked: (w) => w.startsWith("T") || w.startsWith("LT"),
      isAnalyzed: (w) => w.startsWith("L"),
      cachedCreator: () => null,
      lookupCreator: async (m) => (lookups.push(m), creators.get(m) ?? ""),
    },
    bounds,
  );
  /** Deliver a swap now (insert time = the clock), at block time = now unless given. */
  const feed = (wallet: string, mint: string, side: "buy" | "sell", price: number, o: Partial<ParsedSwap> & { t?: number } = {}) => {
    const { t, ...rest } = o;
    return state.onSwap(swap(wallet, mint, side, price, t ?? clock.t, rest), clock.t);
  };
  return { db, clock, state, feed, creators, lookups };
}

test("the trailing outlier filter: within 10× of the median of the previous 10 valid prices, no look-ahead, dust is no price", () => {
  const f = new TrailingFilter();
  assert.equal(f.accept(1), true, "a coin's first valid price is ok");
  assert.equal(f.accept(5), true);
  assert.equal(f.accept(100), false, "100× the median");
  assert.equal(f.accept(0.01), false);
  assert.equal(f.accept(2, 0.0005), false, "below 0.001 SOL");
  assert.equal(f.accept(2, 1, 0.5), false, "below 1 token: a micro-token unit error");
  assert.equal(f.accept(0), false);
  assert.equal(f.size, 4, "every valid price joins the window, ok or not; invalid ones don't");
  const rows = markOk([1, 1.1, 50, 1.2, 0.9].map((price) => ({ price, sol: 1 })));
  assert.deepEqual(rows.map((r) => r.ok), [true, true, false, true, true]);
});

/** derive.py's cases (brain/tests/test_data.py): `n` prints at `price` alternating between wallets, 0.1 SOL each. */
const tape = (n: number, price: number, wallets: string[], sol = 0.1, tokens?: number) =>
  Array.from({ length: n }, (_, i) => ({ wallet: wallets[i % wallets.length], price, sol, tokens: tokens ?? sol / price }));

test("the trailing filter heals after a real drop by several wallets, but never on one wallet's run alone (derive.build_prices parity)", () => {
  // A real 20× drop traded by two wallets: rejected while the window remembers the old level, ok from the 7th print.
  let ok = markOk([...tape(10, 1e-6, ["A1", "B2"]), ...tape(10, 5e-8, ["D4", "C3"], 0.5)]).map((r) => r.ok);
  assert.deepEqual(ok.slice(10), [...Array(6).fill(false), ...Array(4).fill(true)]);
  // One wallet's run at 1000× with whole tokens: the median reaches its level after 6 prints, but only its own wallet backs
  // it against the others in the window ("lone"), so it stays rejected; once two other wallets trade there it heals.
  const run = [...tape(10, 1e-6, ["A1", "B2"]), ...tape(9, 1e-3, ["Run9"], 0.002)];
  ok = markOk(run).map((r) => r.ok);
  assert.ok(ok.slice(10).every((x) => !x), "the run never forms a level on its own");
  ok = markOk([...run, ...tape(4, 1.1e-3, ["D4", "C3"]), ...tape(1, 1e-3, ["Run9"], 0.002)]).map((r) => r.ok);
  assert.ok(ok.slice(19).every(Boolean), "confirmed by other wallets: their prints and the run's next one pass");
  // Micro-token prints (0.005 tokens for 0.005 SOL at 1e6×) aren't valid: they never enter the window.
  const dust = markOk([...tape(10, 1e-6, ["A1", "B2"]), ...tape(8, 1, ["Dust9"], 0.005, 0.005), ...tape(4, 1e-6, ["C3"])]);
  assert.ok(dust.slice(10, 18).every((r) => !r.ok) && dust.slice(18).every((r) => r.ok));
  // A one-wallet rug at 1/100 (10 prints): rejected (out of range, then lone against the earlier wallets).
  ok = markOk([...tape(10, 1e-6, ["A1", "B2"]), ...tape(10, 1e-8, ["Rug9"], 0.5)]).map((r) => r.ok);
  assert.ok(ok.slice(10).every((x) => !x));
  // No look-ahead: a print's verdict is the same on the tape cut right after it.
  const mixed = [...run, ...tape(6, 2e-6, ["E5", "F6"])];
  const full = markOk(mixed).map((r) => r.ok);
  for (const cut of [3, 12, 19, 25]) assert.deepEqual(markOk(mixed.slice(0, cut)).map((r) => r.ok), full.slice(0, cut));
});

test("the golden filter cases (brain/spec/golden/filter.json): the same ok flags as the Python reference", () => {
  const golden = JSON.parse(fs.readFileSync(new URL("../../brain/spec/golden/filter.json", import.meta.url), "utf8")) as {
    cases: { name: string; input: { swaps: { wallet: string; price: number; sol: number; tokens: number }[] }; expected: { ok: boolean[] } }[];
  };
  assert.ok(golden.cases.length >= 10);
  for (const c of golden.cases) assert.deepEqual(markOk(c.input.swaps).map((r) => r.ok), c.expected.ok, c.name);
});

test("the ring: last hour of tracked swaps per coin, windows strict [T − W, T) on block time, the leader left out of the crowd, pruned and bounded", () => {
  const { db, clock, state, feed } = setup({ ring: 50, mints: 3 });
  feed("T1", "A", "buy", 1e-6);
  clock.t += 1000;
  feed("T2", "A", "buy", 1.1e-6);
  feed("T2", "A", "buy", 1e-3); // a bad print: kept in the ring, not ok
  clock.t += 1000;
  feed("L1", "A", "buy", 1.2e-6, { solAmount: 0.5 }); // the leader: analyzed and not tracked → not in the ring
  feed("T3", "A", "sell", 1.15e-6, { solAmount: 0.4 });
  clock.t += 1000;
  const t = clock.t;
  feed("T4", "A", "buy", 1.3e-6); // block time t, inserted at t: neither in the window nor known before t
  assert.deepEqual(state.recent("A", t).map((s) => s.wallet), ["T1", "T2", "T2", "T3"]);
  const f = state.flow("A", t, { exclude: "T1" });
  assert.deepEqual([f.okBuyers, f.buyers, f.sellers, f.okSwaps], [1, 1, 1, 3]);
  near(f.okBuySol, 1);
  near(f.netSol, 2 - 0.4);
  assert.equal(state.lastTracked("A", t)!.price, 1.15e-6, "the bad print is never the last price");
  assert.equal(state.lastTracked("A", t + 1)!.price, 1.3e-6);
  assert.equal(state.isOkPrice("A", 1e-3), false);

  // An hour later the swaps leave the ring; the coin's high is kept for dd_from_high.
  clock.t += RING_MS + MIN;
  state.tick();
  assert.equal(state.stats().swaps, 0);
  near(state.maxOkBefore("A", clock.t - MIN)!, 1.3e-6, 1e-15);
  assert.equal(state.flow("A").okSwaps, 0);

  // Bounds: 50 swaps per coin, 3 coins (the idlest one leaves first; its first sighting stays in the table).
  for (let i = 0; i < 80; i++) feed(`T${i}`, "B", "buy", 1e-6);
  assert.equal(state.recent("B", clock.t + 1, RING_MS).length, 50);
  for (const m of ["C", "D", "E"]) feed("T1", m, "buy", 1e-6);
  assert.equal(state.stats().mints, 3);
  assert.equal(state.recent("A", clock.t + 1, RING_MS).length, 0);
  assert.ok(state.firstSeen("A"), "evicted from memory, still in brain_token_first_seen");
  assert.equal(realRows(db), 0);
});

test("the windows are on block time; a swap counts only once delivered; the decision's block second never counts (features.yaml point_in_time)", () => {
  const { clock, state, feed } = setup();
  const T = T0 + 10 * MIN; // the leader's block second
  clock.t = T - 2 * MIN;
  feed("Tb", "M", "buy", 1e-6, { t: T - 7 * MIN }); // a backlog swap: delivered late, its block time out of the 5 min
  clock.t = T - 29_000;
  feed("Tc", "M", "buy", 1.5e-6, { t: T - 30_000 });
  clock.t = T - 10_000;
  feed("Te", "M", "buy", 3e-6, { t: T - 90_000 }); // older than T − 60 s on block time, delivered after it
  clock.t = T + 300;
  feed("Ta", "M", "buy", 1e-6, { t: T }); // another wallet in the leader's block second, delivered before the decision
  const t = T + 800; // the decision
  clock.t = T + 5_000;
  feed("Tf", "M", "buy", 5e-6, { t: T - 2 * MIN }); // delivered after the decision: unknown at t
  clock.t = T + 6_000;

  // Entry (end = T, known before t): Te and Tc. Not Tb (block time out of the 5 min, however late it came), not Ta (the
  // leader's block second), not Tf (not delivered yet). Exit (end = known = t): Ta counts too.
  const entry = state.flow("M", T, { exclude: "L1", knownBefore: t });
  assert.deepEqual([entry.okBuyers, entry.buyers, entry.okSwaps], [2, 2, 2]);
  near(entry.okBuySol, 2);
  assert.deepEqual(state.recent("M", t).map((s) => s.wallet), ["Te", "Tc", "Ta"], "oldest first by block time");
  assert.deepEqual(state.recent("M", T, 10 * MIN, t).map((s) => s.wallet), ["Tb", "Te", "Tc"]);
  assert.deepEqual(state.recent("M", T + 1_000, 5 * MIN, clock.t).map((s) => s.wallet), ["Tf", "Te", "Tc", "Ta"], "once delivered, Tf counts");

  // dd_from_high: the highest ok price with block time before T − 60 s, delivered before t.
  near(state.maxOkBefore("M", T - MIN, t)!, 3e-6, 1e-15);
  near(state.maxOkBefore("M", T - MIN, clock.t)!, 5e-6, 1e-15);
  near(state.maxOkBefore("M", T - 100_000, t)!, 1e-6, 1e-15);
  // Out of the ring, the high keeps its block time: Tf (ts T − 2 min) is still before a cut at T − 100 s.
  clock.t += RING_MS + MIN;
  state.tick();
  assert.equal(state.stats().swaps, 0);
  near(state.maxOkBefore("M", T - 100_000, clock.t)!, 5e-6, 1e-15);
  assert.equal(state.maxOkBefore("M", T - 3 * MIN, clock.t), null, "Tf's block time isn't before T − 3 min");
});

test("a coin loaded from more stored swaps than it reads warms its filter on the ones before, as the full-sequence filter would", () => {
  const { db, clock, state, feed } = setup();
  // 100 normal prints, one wallet's run at 1000× (never ok on the full tape), then normal prints: the newest OK_WARM_ROWS
  // start exactly at the run, which a cold filter would take as the coin's first (ok) prices and its high.
  const rows = [...tape(100, 1e-6, ["T1", "T2"]), ...tape(9, 1e-3, ["T9"], 0.002), ...tape(OK_WARM_ROWS - 9, 1e-6, ["T1", "T2"])];
  const put = db.prepare("INSERT INTO wallet_swaps (wallet, signature, slot, ts, mint, side, token_amount, sol_amount, price_sol) VALUES (?, ?, 1, ?, 'W', 'buy', ?, ?, ?)");
  db.transaction(() => rows.forEach((r, i) => put.run(r.wallet, `wm${i}`, iso(T0 - 2 * HOUR + i * 1000), r.tokens, r.sol, r.price)))();
  assert.ok(markOk(rows).slice(100, 109).every((r) => !r.ok));
  feed("T1", "W", "buy", 1e-6);
  near(state.maxOkBefore("W", clock.t - MIN, clock.t)!, 1e-6, 1e-15);
});

test("first sighting: persisted at the first tracked swap with the first ok price, kept across a restart, pruned after 8 days", async () => {
  const { db, clock, state, feed, creators, lookups } = setup();
  creators.set("A", "CREATOR");
  creators.set("B", "CREATOR");
  feed("L9", "Z", "buy", 1e-6); // an untracked leader's buy is no sighting
  assert.equal(state.firstSeen("Z"), null);
  feed("T1", "A", "buy", 1e-6, { solAmount: 0.005 }); // too small for the first price
  clock.t += 5000;
  feed("T2", "A", "buy", 2e-6, { solAmount: 0.5 });
  const a = state.firstSeen("A")!;
  assert.deepEqual([a.firstSeenAt, a.source, a.firstOkPrice], [T0, "stream", 2e-6]);
  // Creators are looked up at first sighting, at most BRAIN_CREATOR_LOOKUPS_PER_MIN (2) a minute.
  for (const m of ["B", "C", "D"]) feed("T1", m, "buy", 1e-6);
  await state.lookupCreators();
  assert.deepEqual(lookups, ["A", "B"]);
  clock.t += MIN;
  await state.lookupCreators();
  assert.deepEqual(lookups, ["A", "B", "C", "D"]);
  assert.equal(state.firstSeen("A")!.creator, "CREATOR");
  assert.equal(state.creatorCoins7d("CREATOR", clock.t, "A"), 1, "the other coin of the creator");

  // A new process reads the same sighting (not the next swap's time).
  const again = new StreamState(db, { now: () => clock.t + HOUR, isTracked: () => true, isAnalyzed: () => false, lookupCreator: async () => "" });
  again.onSwap(swap("T5", "A", "buy", 2.1e-6, clock.t + HOUR), clock.t + HOUR);
  assert.equal(again.firstSeen("A")!.firstSeenAt, T0);
  // A coin already in wallet_swaps when the stream first meets it: first seen at its earliest stored swap within 7 days.
  db.prepare("INSERT INTO wallet_swaps (wallet, signature, slot, ts, mint, side, token_amount, sol_amount, price_sol) VALUES ('T9', 'old', 1, ?, 'OLD', 'buy', 1, 1, 1e-6)").run(iso(T0 - 2 * HOUR));
  feed("T1", "OLD", "buy", 1e-6);
  assert.deepEqual([state.firstSeen("OLD")!.firstSeenAt, state.firstSeen("OLD")!.source], [T0 - 2 * HOUR, "db"]);

  clock.t += 9 * 86_400_000;
  state.tick();
  assert.equal((db.prepare("SELECT COUNT(*) n FROM brain_token_first_seen WHERE first_seen_at < ?").get(iso(clock.t - 8 * 86_400_000)) as { n: number }).n, 0);
});

test("the leader's holding: post-buy tokens and the share it sold since, for leader_sold_at_decision", () => {
  const { state, feed, clock } = setup();
  feed("L1", "A", "buy", 1e-6, { tokenAmount: 1000, tokenBalanceBefore: 3000 });
  clock.t += 2000;
  feed("L1", "A", "sell", 1e-6, { tokenAmount: 1000 });
  const h = state.leaderHolding("L1", "A")!;
  assert.deepEqual([h.postBuyTokens, h.soldTokens, h.firstSellTs], [4000, 1000, T0 + 2000]);
  near(h.soldFrac, 0.25);
  clock.t += 3 * HOUR;
  state.tick();
  assert.equal(state.leaderHolding("L1", "A"), null, "forgotten once idle");
});

/** A ledger on the stream state, with the y_quote quotes recorded. */
function ledgerSetup() {
  const s = setup();
  const quoted: { mint: string; tokens: number }[] = [];
  const ledger = new MirrorLedger(s.db, s.state, { now: () => s.clock.t, quoteSell: async (mint, tokens) => (quoted.push({ mint, tokens }), 0.09) });
  const row = (mint: string) => s.db.prepare("SELECT * FROM mirror_ledger WHERE mint = ?").get(mint) as Record<string, any>;
  return { ...s, ledger, quoted, row };
}

test("mirror ledger: strict late entry, exit at the first other wallet's sell 15 s after the leader's, y net of the haircut, known only once resolved", async () => {
  const { db, clock, feed, ledger, row, quoted } = ledgerSetup();
  feed("L1", "A", "buy", 1e-6, { solAmount: 0.1 }); // below 0.2 SOL: not copy-eligible
  assert.equal(row("A"), undefined);
  feed("L1", "A", "buy", 1e-6, { solAmount: 0.5 });
  assert.equal(row("A").leader, "L1");
  clock.t += 10_000;
  feed("T1", "A", "buy", 1.1e-6); // before buy + 15 s: not the entry
  clock.t += 10_000;
  feed("L1", "A", "buy", 1.15e-6, { solAmount: 0.1 }); // the leader's own swap: never the entry
  feed("T2", "A", "buy", 1.2e-6); // +20 s: the entry
  assert.equal(row("A").entry_px, 1.2e-6);
  clock.t += 5 * MIN;
  const sellAt = clock.t;
  feed("L1", "A", "sell", 1.5e-6);
  clock.t += 10_000;
  feed("T3", "A", "sell", 1.6e-6); // 10 s after the leader's sell: too early
  clock.t += 10_000;
  feed("T4", "A", "buy", 1.7e-6); // a buy: the mirror exits on a sell
  feed("T5", "A", "sell", 1.8e-6);
  const r = row("A");
  assert.equal(r.exit_kind, "leader_sell");
  near(r.y, 1.8 / 1.2 - 1 - MIRROR_COST);
  near(r.lr, Math.log(1 + r.y));
  assert.equal(r.resolved_at, iso(clock.t));
  assert.equal(r.leader_sell_ts, iso(sellAt));
  // cp_* read rows resolved in [t − 7 d, t): not yet at the resolving moment, then 1 row.
  assert.equal(ledger.cp("L1", clock.t).cp_n_7d, 0);
  const cp = ledger.cp("L1", clock.t + 1);
  assert.equal(cp.cp_n_7d, 1);
  near(cp.cp_lrshr_7d, logOutcome(r.y) / (1 + CP_SHRINK));
  assert.equal(cp.cp_win_7d, 1);
  assert.equal(ledger.cp("L1", clock.t + 8 * 86_400_000).cp_n_7d, 0, "out of the 7-day window");
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(quoted.map((q) => q.mint), ["A"]);
  near(row("A").y_quote, 0.09 / 0.1 - 1);
  assert.equal(ledger.openRows(), 0);
  assert.equal(realRows(db), 0);
});

test("mirror ledger: the −60% stop fills at the gap price; no entry → y null (excluded); no exit → grounded at 24 h, else dead (−1) at 30 h", async () => {
  const { clock, feed, ledger, row, state } = ledgerSetup();
  feed("L1", "S", "buy", 1e-6, { solAmount: 1 });
  feed("L1", "N", "buy", 1e-6, { solAmount: 1 });
  feed("L1", "G", "buy", 1e-6, { solAmount: 1 });
  feed("L1", "D", "buy", 1e-6, { solAmount: 1 });
  clock.t += 20_000;
  for (const m of ["S", "G", "D"]) feed("T1", m, "buy", 1e-6);
  clock.t += MIN;
  feed("T2", "S", "buy", 0.5e-6); // −50%
  feed("T2", "S", "sell", 0.3e-6); // −70%: the stop, at −70%
  near(row("S").y, 0.3 - 1 - MIRROR_COST);
  assert.equal(row("S").exit_kind, "stop");
  // N: nothing from another wallet in [15 s, 135 s].
  clock.t += 2 * MIN;
  await ledger.tick();
  assert.deepEqual([row("N").exit_kind, row("N").y], ["no_entry", null]);
  assert.equal(row("N").resolved_at, iso(T0 + 135_000));
  // G: the next ok price after 24 h (within 6 h) is its value.
  clock.t = T0 + 25 * HOUR;
  feed("T3", "G", "buy", 2e-6, { t: clock.t });
  assert.equal(row("G").exit_kind, "grounded");
  near(row("G").y, 2 - 1 - MIRROR_COST);
  // D: no ok tracked price by 24 h + 6 h: dead.
  clock.t = T0 + 31 * HOUR;
  await ledger.tick();
  assert.deepEqual([row("D").exit_kind, row("D").y, row("D").resolved_at], ["dead", -1, iso(T0 + 30 * HOUR)]);
  const cp = ledger.cp("L1", clock.t);
  assert.equal(cp.cp_n_7d, 3, "the no-entry row isn't counted");
  near(cp.cp_win_7d!, 1 / 3);
  assert.equal(ledger.openRows(), 0);
  assert.equal(state.stats().mints <= 4, true);
});

test("ps and dd ledgers: delayed jobs read the stored swaps when due; rows older than 8 days are pruned", async () => {
  const { db, clock, feed, ledger } = ledgerSetup();
  const put = (mint: string, t: number, price: number, wallet = "T1") =>
    db.prepare("INSERT INTO wallet_swaps (wallet, signature, slot, ts, mint, side, token_amount, sol_amount, price_sol) VALUES (?, ?, 1, ?, ?, 'buy', 1, 1, ?)").run(wallet, `w${++sigN}`, iso(t), mint, price);
  feed("L1", "A", "buy", 1e-6, { solAmount: 1 });
  feed("L1", "B", "buy", 1e-6, { solAmount: 1 });
  clock.t += 2 * MIN;
  const sellMin = Math.floor(clock.t / MIN) * MIN;
  feed("L1", "A", "sell", 1e-6);
  put("A", sellMin + 10_000, 1e-6); // the sell minute's close
  put("A", sellMin + 30 * MIN, 1.5e-6);
  put("A", sellMin + 59 * MIN, 1.4e-6); // the last ok price in the hour after
  put("A", sellMin + 61 * MIN, 9e-6); // after the hour
  put("A", T0 + 90 * MIN, 1e-6); // A traded 1–2 h after the buy: alive
  put("B", T0 + 30 * MIN, 1e-6); // B went quiet after 30 min: dead
  const ps = () => db.prepare("SELECT r, done, avail_at FROM ps_ledger WHERE mint = 'A'").get() as { r: number | null; done: number; avail_at: string };
  assert.equal(ps().avail_at, iso(sellMin + 61 * MIN));
  clock.t = sellMin + 60 * MIN;
  await ledger.runJobs();
  assert.equal(ps().done, 0, "not due yet");
  clock.t = T0 + 2 * HOUR + MIN;
  await ledger.runJobs();
  near(ps().r!, 0.4);
  near(ledger.psR("L1", clock.t)!, 0.4);
  const dd = db.prepare("SELECT mint, dead FROM dd_ledger WHERE done = 1 ORDER BY mint").all() as { mint: string; dead: number }[];
  assert.deepEqual(dd, [{ mint: "A", dead: 0 }, { mint: "B", dead: 1 }]);
  near(ledger.ddRate("L1", clock.t)!, 0.5);
  assert.equal(ledger.ddRate("L1", T0 + HOUR), null, "not available yet");

  clock.t += 9 * 86_400_000;
  await ledger.tick();
  const left = db.prepare("SELECT (SELECT COUNT(*) FROM mirror_ledger) + (SELECT COUNT(*) FROM ps_ledger) + (SELECT COUNT(*) FROM dd_ledger) n").get() as { n: number };
  assert.equal(left.n, 0);
  const plan = db.prepare("EXPLAIN QUERY PLAN SELECT COUNT(*) FROM mirror_ledger WHERE leader = ? AND resolved_at >= ? AND resolved_at < ?").all("L1", "a", "b") as { detail: string }[];
  assert.match(plan.map((p) => p.detail).join(" "), /idx_mirror_leader_resolved/);
});

test("delayed jobs of a hot coin: one read of its swaps answers them all, with the same r and dead flag as each job's own read", async () => {
  const { db, ledger } = ledgerSetup();
  // HOT: 4,000 swaps over 4 h by 50 wallets, a few 1000× prints, and silent from 2 h to 2 h 40 min; COLD: one swap.
  const N = 4000;
  const ins = db.prepare("INSERT INTO wallet_swaps (wallet, signature, slot, ts, mint, side, token_amount, sol_amount, price_sol) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  db.transaction(() => {
    for (let i = 0; i < N; i++) {
      const t = T0 + Math.floor((i / N) * 4 * HOUR);
      if (t >= T0 + 2 * HOUR && t < T0 + 2 * HOUR + 40 * MIN) continue;
      const p = (i % 397 === 0 ? 1e-3 : 1e-6) * (1 + 0.3 * Math.sin(i / 50));
      ins.run(`T${i % 50}`, `h${i}`, i, iso(t), "HOT", i % 2 ? "buy" : "sell", 0.5 / p, 0.5, p);
    }
    ins.run("T1", "c0", 1, iso(T0 + 70 * MIN), "COLD", "buy", 1e6, 1, 1e-6);
  })();
  const dd = db.prepare("INSERT INTO dd_ledger (leader, mint, buy_sig, buy_ts, avail_at) VALUES (?, ?, ?, ?, ?)");
  const ps = db.prepare("INSERT INTO ps_ledger (leader, mint, buy_sig, sell_ts, avail_at) VALUES (?, ?, ?, ?, ?)");
  for (let j = 0; j < 300; j++) {
    const b = T0 + j * 40_000; // buys spread over 3 h 20 min: several reads of HOT, not one per job
    const sell = b + 30_000 + j * 7;
    dd.run(`L${j}`, j % 30 ? "HOT" : "COLD", `b${j}`, iso(b), iso(b + DD_AVAIL_MS));
    ps.run(`L${j}`, j % 30 ? "HOT" : "COLD", `b${j}`, iso(sell), iso(Math.floor(sell / MIN) * MIN + PS_AVAIL_MS));
  }
  const now = T0 + 8 * HOUR;
  // Each job read on its own, as before.
  const wantPs = (db.prepare("SELECT id, mint, sell_ts FROM ps_ledger ORDER BY id").all() as { id: number; mint: string; sell_ts: string }[]).map((j) => ledger.postSellReturn(j.mint, Date.parse(j.sell_ts), now));
  const wantDd = (db.prepare("SELECT mint, buy_ts FROM dd_ledger ORDER BY id").all() as { mint: string; buy_ts: string }[]).map((j) => {
    const t = Date.parse(j.buy_ts);
    return ledger.okSwaps(j.mint, t + DD_FROM_MS, t + DD_TO_MS, now).some((s) => s.ok) ? 0 : 1;
  });
  const perJob = ledger.swapsRead;
  ledger.swapsRead = 0;
  assert.equal(await ledger.runJobs(now), 600);
  const gotPs = (db.prepare("SELECT r, done FROM ps_ledger ORDER BY id").all() as { r: number | null; done: number }[]);
  const gotDd = (db.prepare("SELECT dead, done FROM dd_ledger ORDER BY id").all() as { dead: number; done: number }[]);
  assert.ok(gotPs.every((r) => r.done === 1) && gotDd.every((r) => r.done === 1));
  gotPs.forEach((r, i) => (wantPs[i] === null ? assert.equal(r.r, null) : near(r.r!, wantPs[i]!, 1e-12)));
  assert.deepEqual(gotDd.map((r) => r.dead), wantDd);
  assert.ok(wantDd.some((d) => d === 1) && wantDd.some((d) => d === 0) && wantPs.some((r) => r === -1), "the test covers dead and live coins");
  assert.ok(ledger.swapsRead < 2 * N, `${ledger.swapsRead} swaps read (each job on its own: ${perJob})`);
  assert.ok(perJob > 50 * ledger.swapsRead);
  assert.equal(await ledger.runJobs(now), 0, "nothing left");
});

test("a restart picks up the open mirror rows and catches them up from wallet_swaps", () => {
  const { db, clock, feed, row } = ledgerSetup();
  feed("L1", "A", "buy", 1e-6, { solAmount: 1 });
  clock.t += 20_000;
  feed("T1", "A", "buy", 1e-6);
  db.prepare("INSERT INTO wallet_swaps (wallet, signature, slot, ts, mint, side, token_amount, sol_amount, price_sol) VALUES ('T1', 'e', 1, ?, 'A', 'buy', 1, 1, 1e-6)").run(iso(clock.t));
  const state2 = new StreamState(db, { now: () => clock.t, isTracked: () => true, isAnalyzed: (w) => w.startsWith("L"), lookupCreator: async () => "" });
  clock.t += MIN;
  db.prepare("INSERT INTO wallet_swaps (wallet, signature, slot, ts, mint, side, token_amount, sol_amount, price_sol) VALUES ('T2', 'x', 1, ?, 'A', 'sell', 1, 1, 0.2e-6)").run(iso(clock.t));
  const again = new MirrorLedger(db, state2, { now: () => clock.t });
  assert.equal(row("A").exit_kind, "stop", "the stored −80% swap stopped it");
  assert.equal(again.openRows(), 0);
});

test("ps ledger: every copy-eligible buy's first leader sell is recorded, whatever became of its mirror row; a coin gone dark is −1", async () => {
  const { db, clock, feed, ledger, row } = ledgerSetup();
  const ps = (mint: string) => db.prepare("SELECT * FROM ps_ledger WHERE mint = ?").get(mint) as Record<string, any> | undefined;
  // N: no other swap in [15 s, 135 s] (no entry), a tracked swap at +200 s, then the leader sells.
  feed("L1", "N", "buy", 1e-6, { solAmount: 1 });
  // S: an entry, a −67% stop, then the leader sells.
  feed("L1", "S", "buy", 1e-6, { solAmount: 1 });
  clock.t += 20_000;
  feed("T1", "S", "buy", 1e-6);
  clock.t += 20_000;
  feed("T2", "S", "sell", 0.33e-6);
  assert.equal(row("S").exit_kind, "stop");
  clock.t = T0 + 200_000;
  feed("T1", "N", "buy", 1e-6);
  assert.equal(row("N").exit_kind, "no_entry");
  clock.t += MIN;
  const sellAt = clock.t;
  feed("L1", "N", "sell", 1e-6);
  feed("L1", "S", "sell", 0.3e-6);
  feed("L1", "S", "sell", 0.3e-6, { signature: "second" }); // only its first sell
  assert.equal(ps("N")?.sell_ts, iso(sellAt), "no-entry row: still a ps row");
  assert.equal(ps("S")?.sell_ts, iso(sellAt), "stopped row: still a ps row");
  assert.equal((db.prepare("SELECT COUNT(*) n FROM ps_ledger").get() as { n: number }).n, 2);
  // A sell more than 24 h after the buy is no first sell of it.
  feed("L1", "X", "buy", 1e-6, { solAmount: 1 });
  clock.t += 25 * HOUR;
  await ledger.tick();
  feed("L1", "X", "sell", 1e-6);
  assert.equal(ps("X"), undefined);
  // No ok tracked price at all from the sell minute on: −1, not dropped.
  near(ledger.postSellReturn("DARK", sellAt, sellAt + 2 * HOUR)!, -1);
});

test("a restart: open rows resume from their stored entry and leader sell (a bot leader's sell isn't stored); waiting buys find a sell stored meanwhile", () => {
  const { db, clock, feed, row } = ledgerSetup();
  const put = (wallet: string, mint: string, side: "buy" | "sell", t: number, price: number) =>
    db.prepare("INSERT INTO wallet_swaps (wallet, signature, slot, ts, mint, side, token_amount, sol_amount, price_sol) VALUES (?, ?, 1, ?, ?, ?, 1, 1, ?)").run(wallet, `r${++sigN}`, iso(t), mint, side, price);
  // A: L1 is a bot (analyzed, not tracked): its sell came on the stream but isn't in wallet_swaps.
  feed("L1", "A", "buy", 1e-6, { solAmount: 1 });
  clock.t += 20_000;
  feed("T1", "A", "buy", 1e-6);
  put("T1", "A", "buy", clock.t, 1e-6);
  clock.t += MIN;
  feed("L1", "A", "sell", 1e-6);
  // B: L2 sells while the server is down; its sell is stored (a backfill).
  feed("L2", "B", "buy", 1e-6, { solAmount: 1 });
  const downAt = clock.t;
  clock.t += 5 * MIN;
  put("L2", "B", "sell", downAt + MIN, 1e-6);
  put("T5", "A", "sell", clock.t - 1000, 1.5e-6); // another wallet's sell after the bot's: the mirror exit
  const state2 = new StreamState(db, { now: () => clock.t, isTracked: (w) => w.startsWith("T"), isAnalyzed: (w) => w.startsWith("L"), lookupCreator: async () => "" });
  const again = new MirrorLedger(db, state2, { now: () => clock.t });
  assert.equal(row("A").exit_kind, "leader_sell", "the stored leader sell let the replay exit at the next sell");
  near(row("A").y, 1.5 - 1 - MIRROR_COST);
  const ps = db.prepare("SELECT mint, sell_ts FROM ps_ledger ORDER BY mint").all() as { mint: string; sell_ts: string }[];
  assert.deepEqual(ps, [{ mint: "A", sell_ts: iso(T0 + 80_000) }, { mint: "B", sell_ts: iso(downAt + MIN) }]);
  assert.equal(again.openRows(), 1, "B: no entry, resolved at the next tick");
});

test("the trailing filter read back from wallet_swaps matches the full-sequence filter at any window start", () => {
  const { db, ledger } = ledgerSetup();
  // The coin trades at 1e-6 (two wallets), one wallet's run at 1000× (never ok), a real 20× drop (heals), dust in between.
  const rows = [
    ...tape(20, 1e-6, ["T1", "T2"]), ...tape(9, 1e-3, ["T9"], 0.002), ...tape(3, 1, ["T8"], 0.005, 0.005),
    ...tape(15, 5e-8, ["T3", "T4"], 0.5), ...tape(5, 1e-6, ["T5"], 0.0001),
  ];
  rows.forEach((r, i) =>
    db.prepare("INSERT INTO wallet_swaps (wallet, signature, slot, ts, mint, side, token_amount, sol_amount, price_sol) VALUES (?, ?, 1, ?, 'RUG', 'sell', ?, ?, ?)")
      .run(r.wallet, `g${i}`, iso(T0 + i * 1000), r.tokens, r.sol, r.price),
  );
  const golden = markOk(rows).map((r) => r.ok);
  for (const k of [0, 5, 22, 29, 33, 40, 50]) {
    const got = ledger.okSwaps("RUG", T0 + k * 1000, T0 + rows.length * 1000, T0 + HOUR).map((s) => s.ok);
    assert.deepEqual(got, golden.slice(k), `from swap ${k}`);
  }
  assert.ok(golden.slice(20, 29).every((ok) => !ok) && golden.slice(38, 47).every(Boolean), "the run stays out, the real drop heals");
});

test("creator lookups: a failed one is tried again later (up to 3 times); a coin a leader just bought goes first", async () => {
  const { clock, state, feed } = setup();
  const asked: string[] = [];
  let fail = true;
  (state as unknown as { deps: { lookupCreator(m: string): Promise<string | null> } }).deps.lookupCreator = async (m) => {
    asked.push(m);
    if (fail && m === "A") throw new Error("429");
    return "C";
  };
  feed("T1", "A", "buy", 1e-6); // looked up at once: fails
  feed("T1", "B", "buy", 1e-6); // looked up at once
  for (const m of ["C", "D", "E"]) feed("T1", m, "buy", 1e-6); // over the 2 a minute: waiting
  await new Promise((r) => setImmediate(r));
  assert.equal(state.firstSeen("A")!.creator, null);
  feed("L1", "E", "buy", 1e-6, { solAmount: 0.5 }); // a copy-eligible buy of E: ahead of C and D
  clock.t += MIN;
  await state.lookupCreators();
  assert.deepEqual(asked, ["A", "B", "E", "C"]);
  clock.t += MIN; // A's retry is due 2 min after it failed, back in line behind D
  await state.lookupCreators();
  assert.deepEqual(asked.slice(4), ["D", "A"]);
  fail = false;
  clock.t += 8 * MIN;
  await state.lookupCreators();
  assert.deepEqual(asked.slice(6), ["A"]);
  assert.equal(state.firstSeen("A")!.creator, "C");
  assert.equal(state.stats().creatorQueue, 0);

  // A coin whose creator other code has stored meanwhile (token_info) is resolved from there, with no lookup.
  feed("T1", "F", "buy", 1e-6); // the minute's second lookup
  feed("T1", "G", "buy", 1e-6); // waits
  await new Promise((r) => setImmediate(r));
  (state as unknown as { deps: { cachedCreator(m: string): string | null } }).deps.cachedCreator = (m) => (m === "G" ? "STORED" : null);
  clock.t += MIN;
  await state.lookupCreators();
  assert.deepEqual(asked.slice(7), ["F"]);
  assert.equal(state.firstSeen("G")!.creator, "STORED");
});

test("creator lookups that can't keep up: the queue is bounded and what it drops is counted", () => {
  const { state, feed } = setup({ mints: 10 });
  for (let i = 0; i < 5_003; i++) feed("T1", `Q${i}`, "buy", 1e-6);
  // 2 asked at once (BRAIN_CREATOR_LOOKUPS_PER_MIN), 5,000 waiting, the oldest one dropped.
  assert.deepEqual([state.stats().creatorQueue, state.stats().creatorDropped], [5_000, 1]);
});

test("tracked_active_wallets_1h: the stream's count by insert time, persisted per whole hour; an hour no process saw whole is missing", () => {
  const { db, clock, state, feed } = setup();
  db.prepare("INSERT INTO wallet_swaps (wallet, signature, slot, ts, mint, side, token_amount, sol_amount, price_sol) VALUES ('OLD', 'h', 1, ?, 'A', 'buy', 1, 1, 1e-6)").run(iso(T0 + HOUR + 1000));
  feed("T1", "A", "buy", 1e-6); // hour 0: this process started in it (not whole)
  clock.t = T0 + HOUR + 1000;
  feed("T1", "A", "buy", 1e-6);
  feed("T2", "A", "buy", 1e-6);
  clock.t = T0 + 2 * HOUR + 1000;
  assert.equal(state.activeWallets1h(T0 + HOUR + 5000), null, "hour 0 wasn't seen whole: missing, not a wallet_swaps count");
  assert.equal(state.activeWallets1h(), 2, "hour 1 from the stream (before the next swap rolls it over)");
  feed("T3", "A", "buy", 1e-6);
  assert.equal(state.activeWallets1h(), 2);
  // A new process reads the count back; an hour it didn't see stays missing (the backfilled OLD swap isn't counted).
  const again = new StreamState(db, { now: () => clock.t, isTracked: () => true, isAnalyzed: () => false, lookupCreator: async () => "" });
  assert.equal(again.activeWallets1h(clock.t), 2);
  assert.equal(again.activeWallets1h(clock.t + HOUR), null);
});

test("shadow quotes: candidates (bots and pumpswap too) quoted at 5/15/30/60 s and on the leader's sells, under a hard per-minute cap", async () => {
  const db = openDb(":memory:");
  const clock = { t: T0 };
  const calls: number[] = [];
  const route = new Set(["A", "B"]);
  const q = new ShadowQuotes(db, {
    now: () => clock.t,
    random: () => 0,
    quoteSell: async (mint, tokens) => (calls.push(clock.t), route.has(mint) ? tokens * 1e-6 * 0.98 : null),
    lastTracked: () => ({ price: 1e-6, ts: clock.t - 2000 }),
  });
  const cand = (mint: string, leader = "BOT", t = clock.t) => ({ leader, mint, signature: `c${++sigN}`, priceSol: 1e-6, solAmount: 0.5, t, venue: "pumpswap (via bot)" });
  assert.equal(q.onCandidate({ ...cand("A"), solAmount: 0.1 }), false, "not copy-eligible");
  assert.equal(q.onCandidate(cand("A")), true);
  assert.equal(q.onCandidate(cand("A")), false, "one watch per leader and coin");
  assert.equal(q.pending(), HORIZONS_SEC.length);
  clock.t += 5_000;
  await q.runDue();
  clock.t += 10_000;
  await q.runDue();
  q.onLeaderSell("BOT", "A", clock.t);
  q.onLeaderSell("BOT", "A", clock.t); // the same sell delivered twice: quoted once
  await q.runDue();
  const rows = db.prepare("SELECT trigger, horizon_sec, status, sell_quote_sol, tracked_price_sol, tracked_price_age_sec FROM brain_shadow_quotes ORDER BY id").all() as Record<string, any>[];
  assert.deepEqual(rows.map((r) => [r.trigger, r.horizon_sec, r.status]), [["time", 5, "ok"], ["time", 15, "ok"], ["leader_sell", 15, "ok"]]);
  near(rows[0].sell_quote_sol, 0.098);
  assert.deepEqual([rows[0].tracked_price_sol, rows[0].tracked_price_age_sec], [1e-6, 2]);

  const last = () => (db.prepare("SELECT status FROM brain_shadow_quotes ORDER BY id DESC").get() as { status: string }).status;
  // The mirror ledger's exit quotes have their own share of the cap (2 of the 7 in any 60 s): never the shadow quotes'.
  const got = await Promise.all([1, 2, 3].map(() => q.tryQuote("B", 1e5)));
  assert.equal(got.filter((x) => x === undefined).length, 1, "the mirror's 2 a minute");
  clock.t += 15_000;
  await q.runDue(); // the 30 s quote: the shadow share (5) still has room
  assert.equal(last(), "ok");
  assert.equal(q.budget.left(clock.t), 1);
  q.budget.take(clock.t); // another candidate's quote takes the share's last one
  clock.t += 30_000;
  await q.runDue(); // the 60 s quote: over the share → stored as capped, not asked
  assert.equal(last(), "capped");
  for (let i = 0; i < calls.length; i++) assert.ok(calls.filter((c) => c > calls[i] - 60_000 && c <= calls[i]).length <= 7, "never more than 7 a minute");
  // A coin with no route (a new minute).
  clock.t += 60_000;
  route.delete("A");
  assert.equal(q.onCandidate(cand("A", "OTHER")), true);
  clock.t += 6_000;
  await q.runDue();
  assert.equal((db.prepare("SELECT status FROM brain_shadow_quotes ORDER BY id DESC").get() as { status: string }).status, "no_route");
  assert.equal(realRows(db), 0);

  const b = new QuoteBudget(() => 2);
  assert.deepEqual([b.take(0), b.take(1), b.take(2), b.left(59_999), b.take(60_000)], [true, true, false, 0, true]);
});

test("mirror exit quotes and shadow quotes in the same minute: the mirror's share never caps a shadow quote", async () => {
  const s = setup();
  const calls: number[] = [];
  const q = new ShadowQuotes(s.db, { now: () => s.clock.t, random: () => 0, quoteSell: async (_m, tokens) => (calls.push(s.clock.t), tokens * 1e-6), lastTracked: () => null });
  const ledger = new MirrorLedger(s.db, s.state, { now: () => s.clock.t, quoteSell: (mint, tokens) => q.tryQuote(mint, tokens) });
  assert.equal(q.onCandidate({ leader: "L9", mint: "X", signature: "cx", priceSol: 1e-6, solAmount: 0.5, t: s.clock.t }), true);
  const mints = ["M1", "M2", "M3", "M4", "M5", "M6"];
  for (const m of mints) s.feed("L1", m, "buy", 1e-6, { solAmount: 1 });
  for (const step of [5_000, 10_000]) {
    s.clock.t = T0 + step;
    await q.runDue();
  }
  s.clock.t = T0 + 20_000;
  for (const m of mints) s.feed("T1", m, "buy", 1e-6); // the mirror's entries
  s.clock.t = T0 + 21_000;
  for (const m of mints) s.feed("T2", m, "sell", 0.3e-6); // six −70% stops, fresh: each would like a y_quote
  await new Promise((r) => setImmediate(r));
  for (const step of [30_000, 60_000]) {
    s.clock.t = T0 + step;
    await q.runDue();
  }
  q.onLeaderSell("L9", "X", s.clock.t);
  await q.runDue();
  const shadow = s.db.prepare("SELECT status FROM brain_shadow_quotes").all() as { status: string }[];
  assert.deepEqual(shadow.map((r) => r.status), Array(HORIZONS_SEC.length + 1).fill("ok"), "no shadow quote capped");
  const quoted = s.db.prepare("SELECT COUNT(*) n FROM mirror_ledger WHERE y_quote IS NOT NULL").get() as { n: number };
  assert.equal(quoted.n, 2, "the mirror's 2 a minute");
  assert.equal(q.capped, mints.length - 2);
  assert.equal(ledger.openRows(), 0);
  for (let i = 0; i < calls.length; i++) assert.ok(calls.filter((c) => c > calls[i] - 60_000 && c <= calls[i]).length <= 7);
});

test("config: paper costs from sim.yaml; the Brain's server state never reaches the real engine or the public feed", () => {
  near(config.brainTxCostSol, 0.0003);
  const code = (f: string) =>
    fs
      .readFileSync(new URL(`../src/brain/${f}`, import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/--[^\n]*/g, "");
  for (const f of ["state.ts", "ledger.ts", "quotes.ts", "paper.ts", "schema.ts", "transitions.ts"]) {
    const src = code(f);
    assert.doesNotMatch(src, /RealExecutor|CopyEngine|signTransaction|sendTransaction|Keypair/, `${f}: no real execution`);
    assert.doesNotMatch(src, /(INSERT INTO|UPDATE|DELETE FROM)\s+(copy_trades|positions)\b/, `${f}: no copy_trades / positions writes`);
    assert.doesNotMatch(src, /\bsay\(|agent_log/, `${f}: server logs only`);
  }
});
