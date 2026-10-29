import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "@godseye/shared";
import type { ParsedSwap } from "../src/chain/parse";
import { detectSignal, leadStats, returnPct, SmartMoney } from "../src/smart/smart-money";
import { botReason, copyReason, junkReason, refreshCopyReplays, worstCase } from "../src/smart/copy-check";

/** A copy replay that passes the copy gate (median +5% over 20 copies, well covered). */
const copyable = (db: ReturnType<typeof openDb>, wallet: string, median = 5, n = 20, coverage = 0.9) =>
  db.prepare("INSERT OR REPLACE INTO copy_replays (wallet, delay_sec, n, coverage, median_ret_pct, computed_at) VALUES (?, 5, ?, ?, ?, ?)").run(wallet, n, coverage, median, new Date().toISOString());

const cfg = { wallets: 3, windowMinutes: 60, minUsd: 500 };
const T = Date.parse("2026-10-19T00:00:00Z");
const ev = (min: number, wallet: string, side: "buy" | "sell", usd: number) => ({ ts: T + min * 60_000, wallet, side, usd });

test("signal: 3 smart wallets buying the same token within an hour", () => {
  const s = detectSignal([ev(0, "a", "buy", 200), ev(10, "b", "buy", 300), ev(20, "c", "buy", 400)], T + 25 * 60_000, cfg)!;
  assert.equal(s.kind, "accumulate");
  assert.deepEqual(s.wallets.sort(), ["a", "b", "c"]);
  assert.equal(s.usd, 900);
});

test("signal: not enough wallets, too little money, or spread over too long → nothing", () => {
  assert.equal(detectSignal([ev(0, "a", "buy", 900), ev(1, "a", "buy", 900), ev(2, "b", "buy", 900)], T + 3 * 60_000, cfg), null);
  assert.equal(detectSignal([ev(0, "a", "buy", 100), ev(1, "b", "buy", 100), ev(2, "c", "buy", 100)], T + 3 * 60_000, cfg), null);
  assert.equal(detectSignal([ev(0, "a", "buy", 400), ev(30, "b", "buy", 400), ev(90, "c", "buy", 400)], T + 91 * 60_000, cfg), null);
});

test("signal: a wallet that bought and sold nets out; three dumping is an exit", () => {
  const s = detectSignal([ev(0, "a", "sell", 300), ev(5, "b", "sell", 300), ev(9, "c", "sell", 300)], T + 10 * 60_000, cfg)!;
  assert.equal(s.kind, "exit");
  assert.equal(detectSignal([ev(0, "a", "buy", 300), ev(1, "a", "sell", 300), ev(2, "b", "buy", 300), ev(3, "c", "buy", 300)], T + 4 * 60_000, cfg), null);
});

test("lead stats and returns", () => {
  assert.deepEqual(leadStats([10, -5, 30, 20]), { n: 4, hitRate: 0.75, median: 15 });
  assert.equal(returnPct(2, 3), 50);
  assert.equal(returnPct(null, 3), null);
});

const swap = (wallet: string, side: "buy" | "sell", usd: number, priceUsd: number, i: number): ParsedSwap => ({
  wallet, signature: `sig${i}`, slot: i, ts: new Date(T + i * 60_000).toISOString(), mint: "MEME", side,
  tokenAmount: usd / priceUsd, tokenBalanceBefore: 0, solAmount: usd / 100, priceSol: priceUsd / 100, quote: "SOL", quoteAmount: usd / 100,
  solUsd: 100, usdAmount: usd, venue: "pumpswap", jitoTip: false, feeLamports: 5000,
});

/** A broad, ordinary crowd trading the token (not smart wallets): what a real market looks like to the organic check. */
const crowd = (sm: SmartMoney, mint: string, n = 18) => {
  for (let k = 0; k < n; k++) sm.onSwap({ ...swap(`crowd${k}`, "buy", 40, 1, 100 + k), mint, signature: `crowd-${mint}-${k}` }, T - 120_000 + k * 1000);
};

test("end to end: smart wallets converge → signal → price measured 1h later → learning", () => {
  const db = openDb(":memory:");
  const now = new Date().toISOString();
  for (const w of ["A", "B", "C", "D"]) {
    db.prepare("INSERT INTO wallets (address, first_seen_at, discovered_via, tier) VALUES (?, ?, 'test', 'proven')").run(w, now);
    db.prepare("INSERT INTO wallet_stats (wallet, computed_at, swaps_total, swaps_7d, swaps_30d, pnl_7d_sol, pnl_30d_sol, pnl_all_sol, pnl_30d_usd, closed_7d, closed_30d, wins_30d, win_rate_30d) VALUES (?, ?, 40, 10, 40, 1, 5, 5, 500, 5, 20, 12, 0.6)").run(w, now);
    copyable(db, w);
  }
  const sm = new SmartMoney(db, null);
  assert.equal(sm.refresh().active, 4);

  crowd(sm, "MEME");
  // Three smart wallets buy MEME at $1 within minutes
  sm.onSwap(swap("A", "buy", 300, 1, 0), T);
  sm.onSwap(swap("B", "buy", 300, 1, 1), T + 60_000);
  sm.onSwap(swap("C", "buy", 300, 1, 2), T + 120_000);
  sm.flush(T + 120_000);
  const sig = db.prepare("SELECT * FROM smart_signals").get() as { kind: string; wallet_count: number; usd: number };
  assert.equal(sig.kind, "accumulate");
  assert.equal(sig.wallet_count, 3);
  assert.equal((db.prepare("SELECT COUNT(*) n FROM smart_flows").get() as { n: number }).n, 3);

  // An hour later someone trades it at $1.50 → +50%
  sm.onSwap(swap("someone", "buy", 50, 1.5, 70), T + 70 * 60_000);
  assert.ok(sm.evaluate(T + 70 * 60_000) >= 1);
  const measured = db.prepare("SELECT ret_1h FROM smart_signals").get() as { ret_1h: number };
  assert.ok(Math.abs(measured.ret_1h - 50) < 1e-9, `ret ${measured.ret_1h}`);
});

test("learning: a wallet whose buys keep dropping stops counting as smart money", () => {
  const db = openDb(":memory:");
  const now = new Date().toISOString();
  db.prepare("INSERT INTO wallets (address, first_seen_at, discovered_via, tier) VALUES ('TOPS', ?, 'test', 'proven')").run(now);
  db.prepare("INSERT INTO wallet_stats (wallet, computed_at, swaps_total, swaps_7d, swaps_30d, pnl_7d_sol, pnl_30d_sol, pnl_all_sol, pnl_30d_usd, closed_7d, closed_30d, wins_30d, win_rate_30d) VALUES ('TOPS', ?, 40, 10, 40, 1, 5, 5, 500, 5, 20, 12, 0.6)").run(now);
  for (let i = 0; i < 12; i++) {
    db.prepare("INSERT INTO smart_flows (signature, ts, wallet, mint, side, usd, price_usd, ret_6h, checked) VALUES (?, ?, 'TOPS', ?, 'buy', 100, 1, -40, 7)").run(`s${i}`, now, `M${i}`);
  }
  const sm = new SmartMoney(db, null);
  assert.equal(sm.refresh().active, 0);
  const row = db.prepare("SELECT active, reason, lead_n, lead_median_6h FROM smart_wallets").get() as { active: number; reason: string; lead_n: number; lead_median_6h: number };
  assert.equal(row.active, 0);
  assert.equal(row.lead_n, 12);
  assert.match(row.reason, /follows, doesn't lead/);
});

test("non-memecoins never count as smart money: skipped when known, purged once named", () => {
  const db = openDb(":memory:");
  const now = new Date().toISOString();
  for (const w of ["A", "B", "C"]) {
    db.prepare("INSERT INTO wallets (address, first_seen_at, discovered_via, tier) VALUES (?, ?, 'test', 'proven')").run(w, now);
    db.prepare("INSERT INTO wallet_stats (wallet, computed_at, swaps_total, swaps_7d, swaps_30d, pnl_7d_sol, pnl_30d_sol, pnl_all_sol, pnl_30d_usd, closed_7d, closed_30d, wins_30d, win_rate_30d) VALUES (?, ?, 40, 10, 40, 1, 5, 5, 500, 5, 20, 12, 0.6)").run(w, now);
    copyable(db, w);
  }
  const named = (mint: string, symbol: string) => db.prepare("INSERT INTO token_info (mint, symbol, checked_at) VALUES (?, ?, ?)").run(mint, symbol, now);
  const sm = new SmartMoney(db, null);
  sm.refresh();
  const on = (wallet: string, mint: string, i: number) => sm.onSwap({ ...swap(wallet, "buy", 300, 1, i), mint }, T + i * 60_000);

  // Already known as a tokenized stock → never recorded, no signal
  named("AVGO", "AVGOx");
  on("A", "AVGO", 0);
  on("B", "AVGO", 1);
  on("C", "AVGO", 2);
  // Not named yet when bought, turns out to be wrapped Monero
  crowd(sm, "WXMR");
  on("A", "WXMR", 3);
  on("B", "WXMR", 4);
  on("C", "WXMR", 5);
  // A real memecoin
  on("A", "MEME", 6);
  sm.flush(T + 6 * 60_000);
  const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  assert.equal(count("SELECT COUNT(*) n FROM smart_flows WHERE mint = 'AVGO'"), 0);
  assert.equal(count("SELECT COUNT(*) n FROM smart_flows WHERE mint = 'WXMR'"), 3);
  assert.equal(count("SELECT COUNT(*) n FROM smart_signals WHERE mint = 'WXMR'"), 1);

  named("WXMR", "wXMR");
  sm.refresh();
  assert.equal(count("SELECT COUNT(*) n FROM smart_flows WHERE mint = 'WXMR'"), 0);
  assert.equal(count("SELECT COUNT(*) n FROM smart_signals"), 0);
  assert.equal(count("SELECT COUNT(*) n FROM smart_flows WHERE mint = 'MEME'"), 1);
});

test("price moves above 1,000x are treated as pricing errors", () => {
  assert.equal(returnPct(1, 1.5), 50);
  assert.equal(returnPct(1, 900), 89_900);
  assert.equal(returnPct(1, 2_000), null);
  assert.equal(returnPct(0.000001, 50), null);
});

const bCfg = { minHoldSec: 15, maxTxPerHour: 20, maxSameBlock: 0 };
const rCfg = { minCopies: 10, minCoverage: 0.5 };

test("bot gate: seconds-long holds, high frequency or same-block round trips; unknowns don't count against a wallet", () => {
  const human = { median_hold_sec: 600, tx_per_hour: 3, same_block_round_trips: 0 };
  assert.equal(botReason(human, bCfg), null);
  assert.equal(botReason({ median_hold_sec: null, tx_per_hour: null, same_block_round_trips: null }, bCfg), null);
  assert.match(botReason({ ...human, median_hold_sec: 8 }, bCfg)!, /median hold 8 s/);
  assert.equal(botReason({ ...human, median_hold_sec: 15 }, bCfg), null);
  assert.match(botReason({ ...human, tx_per_hour: 180 }, bCfg)!, /180 transactions an hour/);
  assert.match(botReason({ ...human, same_block_round_trips: 1 }, bCfg)!, /same block 1 time$/);
});

test("copy gate sees the worse of the replays at the expected and the slower delay", () => {
  const at5 = { delaySec: 5, medianRetPct: 0.8 };
  const at15 = { delaySec: 15, medianRetPct: -2.3 };
  assert.equal(worstCase([at5, at15]), at15);
  assert.equal(worstCase([at15, at5]), at15);
  const noFills = { delaySec: 15, medianRetPct: null };
  assert.equal(worstCase([at5, noFills]), noFills);
  assert.equal(worstCase([at5]), at5);
});

test("copy gate: a median return no honest wallet earns is rejected, not rewarded", () => {
  const cfgMax = { ...rCfg, maxMedianPct: 100 };
  const r = { delay_sec: 5, n: 20, coverage: 0.9, median_ret_pct: 729 };
  assert.match(copyReason(r, cfgMax)!, /not believable/);
  assert.equal(copyReason({ ...r, median_ret_pct: 40 }, cfgMax), null);
  assert.equal(copyReason(r, rCfg), null); // no ceiling configured
});

test("copy gate: needs a replay, enough copies, enough tape, and a positive median", () => {
  const ok = { delay_sec: 5, n: 20, coverage: 0.9, median_ret_pct: 3 };
  assert.equal(copyReason(ok, rCfg), null);
  assert.match(copyReason(null, rCfg)!, /waiting/);
  assert.match(copyReason({ ...ok, n: 4 }, rCfg)!, /only 4 copyable buys/);
  assert.match(copyReason({ ...ok, coverage: 0.02 }, rCfg)!, /too few other swaps/);
  assert.match(copyReason({ ...ok, median_ret_pct: -3.2 }, rCfg)!, /5 s late made a median −3\.2%/);
  assert.match(copyReason({ ...ok, median_ret_pct: 0 }, rCfg)!, /median/);
});

test("smart money: profitable bots and wallets copying loses on are left out, with the reason", () => {
  const db = openDb(":memory:");
  const now = new Date().toISOString();
  const add = (w: string, hold: number, tph: number) => {
    db.prepare("INSERT INTO wallets (address, first_seen_at, discovered_via, tier, tx_per_hour) VALUES (?, ?, 'test', 'proven', ?)").run(w, now, tph);
    db.prepare("INSERT INTO wallet_stats (wallet, computed_at, swaps_total, swaps_7d, swaps_30d, pnl_7d_sol, pnl_30d_sol, pnl_all_sol, pnl_30d_usd, closed_7d, closed_30d, wins_30d, win_rate_30d, median_hold_sec) VALUES (?, ?, 40, 10, 40, 1, 5, 5, 500, 5, 20, 12, 0.6, ?)").run(w, now, hold);
  };
  add("GOOD", 900, 2);
  copyable(db, "GOOD");
  add("SCALPER", 8, 2);
  copyable(db, "SCALPER");
  add("LOSES", 900, 2);
  copyable(db, "LOSES", -3);
  add("UNREPLAYED", 900, 2);
  const r = new SmartMoney(db, null).refresh();
  assert.deepEqual([r.active, r.bots, r.uncopyable], [1, 1, 2]);
  const why = new Map((db.prepare("SELECT address, active, reason FROM smart_wallets").all() as { address: string; active: number; reason: string }[]).map((x) => [x.address, x]));
  assert.equal(why.get("GOOD")!.active, 1);
  assert.match(why.get("GOOD")!.reason, /copying it 5 s late made a median \+5\.0%/);
  assert.match(why.get("SCALPER")!.reason, /^bot: median hold 8 s/);
  assert.match(why.get("LOSES")!.reason, /median −3\.0%/);
  assert.match(why.get("UNREPLAYED")!.reason, /waiting for its copy replay/);
});

test("copy replays: missing ones are replayed and stored; fresh ones are left alone", async () => {
  const db = openDb(":memory:");
  const t0 = Date.now() - 3_600_000;
  const ins = db.prepare("INSERT INTO wallet_swaps (wallet, signature, slot, ts, mint, side, token_amount, token_balance_before, sol_amount, price_sol) VALUES (?, ?, ?, ?, 'MEME', ?, ?, ?, ?, ?)");
  // The leader buys 1 SOL at 0.001, others trade it up, the leader sells at 0.002
  ins.run("L", "b", 1, new Date(t0).toISOString(), "buy", 1000, 0, 1, 0.001);
  for (let i = 0; i < 20; i++) ins.run("X", `x${i}`, 2 + i, new Date(t0 + (i + 1) * 3_000).toISOString(), "buy", 10, 0, 0.01 * (1 + i / 20), 0.001 * (1 + i / 20));
  ins.run("L", "s", 99, new Date(t0 + 120_000).toISOString(), "sell", 1000, 1000, 2, 0.002);
  assert.equal(await refreshCopyReplays(db, ["L"], { budgetMs: 10_000 }), 1);
  const row = db.prepare("SELECT n, delay_sec, implausible FROM copy_replays WHERE wallet = 'L'").get() as { n: number; delay_sec: number; implausible: number };
  // stored at the slower of the two delays (5 s and 3× that), where this fixture's price run-up makes the copy do worse
  assert.deepEqual([row.n, row.delay_sec, row.implausible], [1, 15, 0]);
  assert.equal(await refreshCopyReplays(db, ["L"], { budgetMs: 10_000 }), 0);
});

test("junk: a bot, or a replay with enough evidence that copying lost; no replay or thin evidence isn't junk", () => {
  const human = { median_hold_sec: 600, tx_per_hour: 3, same_block_round_trips: 0 };
  const replay = { delay_sec: 5, n: 20, coverage: 0.9, median_ret_pct: -3 };
  assert.match(junkReason({ ...human, tx_per_hour: 180 }, null, bCfg, rCfg)!, /^bot:/);
  assert.match(junkReason(human, replay, bCfg, rCfg)!, /median −3\.0%/);
  assert.equal(junkReason(human, null, bCfg, rCfg), null);
  assert.equal(junkReason(human, { ...replay, n: 4 }, bCfg, rCfg), null);
  assert.equal(junkReason(human, { ...replay, coverage: 0.1 }, bCfg, rCfg), null);
  assert.equal(junkReason(human, { ...replay, median_ret_pct: 4 }, bCfg, rCfg), null);
});
