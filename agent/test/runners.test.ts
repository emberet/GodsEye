/**
 * Runner research (runners/): the live tape, the data-driven runner definition, the catcher score and the shadow-only
 * flag that keeps research wallets from ever being copied. In-memory database, synthetic swaps: no network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { openDb, type DB } from "@godseye/shared";
import type { ParsedSwap } from "../src/chain/parse";
import { passCopyGate } from "./helpers";

process.env.COPY_BUDGET_SOL = "1";
process.env.COPY_MAX_TRADE_SOL = "0.1";
const { RunnerTape, PUMP_LAUNCH_PRICE_SOL, fromTape, saveCoins, tapeSettings } = await import("../src/runners/tape");
const { defineRunners, mcapCut } = await import("../src/runners/define");
const { scoreCatcher, scoreCatchers } = await import("../src/runners/score");
const { buyersFrom, pumpCurveAddress } = await import("../src/runners/chain");
const { pricePath } = await import("../src/runners/backfill");
const { runLearning, currentLeaders, SHADOW_REASON } = await import("../src/learning/loop");
const { isWallet } = await import("../src/market/holders");

const T0 = Date.parse("2026-10-30T12:00:00.000Z");
const P = PUMP_LAUNCH_PRICE_SOL;
let sig = 0;
function swap(o: Partial<ParsedSwap> & { wallet: string; t: number; price: number }): ParsedSwap {
  return {
    signature: `s${++sig}`, slot: 1000 + Math.floor((o.t - T0) / 400), ts: new Date(o.t).toISOString(), mint: "COIN1pump", side: "buy",
    tokenAmount: 0.1 / o.price, tokenBalanceBefore: 0, solAmount: 0.1, priceSol: o.price, quote: "SOL", quoteAmount: 0.1, solUsd: 200, usdAmount: 20,
    venue: "pumpfun", jitoTip: false, feeLamports: 5000, ...o,
  };
}

/** A launch: 150 buyers in the first minutes, then a run to `peakX` held for 15 minutes, one wild print, and some sells. */
function runCoin(tape: InstanceType<typeof RunnerTape>, mint = "COIN1pump", peakX = 40) {
  for (let i = 0; i < 150; i++) tape.record(swap({ mint, wallet: `buyer${i}`, t: T0 + i * 1000, price: P * (1 + i * 0.02) }), T0 + i * 1000);
  for (let m = 3; m < 18; m++) for (let k = 0; k < 3; k++) tape.record(swap({ mint, wallet: `late${m}${k}`, t: T0 + m * 60_000 + k * 1000, price: P * peakX }), T0 + m * 60_000);
  tape.record(swap({ mint, wallet: "fat-finger", t: T0 + 18 * 60_000, price: P * 5000 }), T0 + 18 * 60_000); // one wild print, in a minute with two normal ones
  tape.record(swap({ mint, wallet: "late-a", t: T0 + 18 * 60_000 + 500, price: P * peakX }), T0 + 18 * 60_000);
  tape.record(swap({ mint, wallet: "late-b", t: T0 + 18 * 60_000 + 900, price: P * peakX }), T0 + 18 * 60_000);
  tape.record(swap({ mint, wallet: "buyer0", side: "sell", t: T0 + 10 * 60_000, price: P * peakX, tokenAmount: (0.1 / P) / 2, solAmount: 2 }), T0 + 10 * 60_000);
}

test("tape: follows a launch from the start, keeps the first 100 buyers in order, and one odd print can't make the peak", () => {
  const tape = new RunnerTape();
  tape.delayMs = 2000;
  runCoin(tape);
  // A coin first seen well above the launch price (seen mid-life) isn't followed.
  tape.record(swap({ mint: "LATEpump", wallet: "x", t: T0, price: P * 50 }), T0);
  assert.equal(tape.size, 1);
  tape.evict(T0 + 25 * 3_600_000);
  const [c] = tape.takeFinished();
  assert.equal(c.buyers.length, tapeSettings.maxBuyers);
  assert.deepEqual(c.buyers.slice(0, 3).map((b) => b.wallet), ["buyer0", "buyer1", "buyer2"]);
  assert.ok(Math.abs(c.multiple / 40 - 1) < 0.15, `peak ≈ 40x, got ${c.multiple}`);
  assert.ok(c.minutesAbove5 >= 15);
  assert.ok(c.x3At !== null && c.x3At >= T0);
  const b0 = c.buyers[0];
  assert.ok(b0.soldTokens > 0 && b0.soldSol === 2);
  assert.ok(b0.copyPrice !== null && b0.copyPrice > b0.price, "a copy 2 s later pays the next buyer's price");
});

test("saving: every early buy the tape saw is counted (runner or not); buyers are kept only for coins close to running", () => {
  const db = openDb(":memory:");
  const tape = new RunnerTape();
  runCoin(tape);
  // A dud: 20 buyers, never moves.
  for (let i = 0; i < 20; i++) tape.record(swap({ mint: "DUDpump", wallet: `buyer${i}`, t: T0 + i * 1000, price: P }), T0 + i * 1000);
  tape.evict(T0 + 25 * 3_600_000);
  const r = saveCoins(db, tape.takeFinished().map(fromTape));
  assert.deepEqual(r, { kept: 2, candidates: 1 });
  const buyer0 = db.prepare("SELECT early_buys FROM runner_early_counts WHERE wallet = 'buyer0'").get() as { early_buys: number };
  assert.equal(buyer0.early_buys, 2);
  assert.equal((db.prepare("SELECT COUNT(*) n FROM runner_buyers WHERE mint = 'DUDpump'").get() as { n: number }).n, 0);
  const first = db.prepare("SELECT sniper, sold_pct, exit_x FROM runner_buyers WHERE mint = 'COIN1pump' AND wallet = 'buyer0'").get() as { sniper: number; sold_pct: number; exit_x: number };
  assert.equal(first.sniper, 1, "bought in the launch slot");
  assert.ok(Math.abs(first.sold_pct - 0.5) < 1e-6);
  assert.ok(first.exit_x > 30);
  const late = db.prepare("SELECT sniper FROM runner_buyers WHERE mint = 'COIN1pump' AND wallet = 'buyer90'").get() as { sniper: number };
  assert.equal(late.sniper, 0);
});

test("definition: the market-cap cut-off is the top share of coins with a crowd, never below the floor", () => {
  const mcaps = Array.from({ length: 1000 }, (_, i) => (i + 1) * 1000);
  assert.equal(mcapCut(mcaps, 0.01, 50_000), 991_000);
  assert.equal(mcapCut(mcaps.slice(0, 40), 0.01, 50_000), 50_000);
  const db = openDb(":memory:");
  const tape = new RunnerTape();
  runCoin(tape);
  tape.evict(T0 + 25 * 3_600_000);
  saveCoins(db, tape.takeFinished().map(fromTape));
  const def = defineRunners(db, T0 + 2 * 3_600_000);
  assert.equal(def.runners, 1);
  assert.equal((db.prepare("SELECT is_runner FROM runner_tokens").get() as { is_runner: number }).is_runner, 1);
});

test("price path from stored swaps: minute medians, so a lone print isn't the peak", () => {
  const pts = [
    { t: T0, price: P, solUsd: 200 },
    { t: T0 + 60_000, price: 10 * P, solUsd: 200 },
    { t: T0 + 60_500, price: 10 * P, solUsd: 200 },
    { t: T0 + 61_000, price: 900 * P, solUsd: 200 },
    { t: T0 + 120_000, price: 4 * P, solUsd: 200 },
  ];
  const p = pricePath(pts, P);
  assert.ok(Math.abs(p.peak / P - 10) < 1e-9);
  assert.equal(p.minutesAbove5, 1);
  assert.equal(p.x3At, T0 + 60_000);
});

test("catcher score: a wallet that buys every launch scores below one that picks 3 runners in 10", () => {
  const hit = (i: number) => ({ mint: `m${i}`, day: `2026-10-2${i}`, entryX: 1.2, xToPeak: 30, soldPct: 1, exitX: 8, copyX: 1.1, sniper: false });
  const hits = [hit(1), hit(2), hit(3)];
  const base = 0.01;
  const sprayer = scoreCatcher(hits, 1000, base);
  const picker = scoreCatcher(hits, 10, base);
  assert.equal(sprayer.qualifies, false);
  assert.equal(picker.qualifies, true);
  assert.ok(picker.score > sprayer.score);
  // Unknown denominator: can't qualify yet.
  assert.equal(scoreCatcher(hits, null, base).qualifies, false);
  // A buy no copy could follow (a copy would have paid 3x its price) isn't a hit.
  assert.equal(scoreCatcher([hit(1), hit(2), { ...hit(3), copyX: 3 }], 10, base).hits, 2);
});

function seedWallet(db: DB, address: string) {
  const now = new Date().toISOString();
  db.prepare("INSERT OR REPLACE INTO wallets (address, first_seen_at, discovered_via, tier, tier_reason, copy_weight, last_activity_at, history_from, history_done) VALUES (?, ?, 'test', 'proven', 'because', 0, ?, ?, 1)").run(
    address, new Date(Date.now() - 9 * 86_400_000).toISOString(), now, new Date(Date.now() - 8 * 86_400_000).toISOString(),
  );
  db.prepare("INSERT INTO wallet_stats (wallet, computed_at, swaps_total, swaps_7d, swaps_30d, pnl_7d_sol, pnl_30d_sol, pnl_all_sol, pnl_7d_usd, pnl_30d_usd, closed_7d, closed_30d, wins_30d, win_rate_30d) VALUES (?, ?, 40, 10, 40, 1, 5, 5, 500, 2000, 5, 20, 12, 0.6)").run(address, now);
}

test("a shadow-only wallet never gets a copy weight, however good its record", () => {
  const db = openDb(":memory:");
  seedWallet(db, "GOOD");
  seedWallet(db, "RESEARCH");
  db.prepare("UPDATE wallets SET shadow_only = 1, copy_weight = 0.5 WHERE address = 'RESEARCH'").run();
  passCopyGate(db);
  const leaders = runLearning(db);
  assert.ok(leaders.includes("GOOD"));
  assert.ok(!leaders.includes("RESEARCH"));
  const r = db.prepare("SELECT copy_weight, weight_reason FROM wallets WHERE address = 'RESEARCH'").get() as { copy_weight: number; weight_reason: string };
  assert.deepEqual(r, { copy_weight: 0, weight_reason: SHADOW_REASON });
  assert.ok(!currentLeaders(db).includes("RESEARCH"));
});

test("scoring adds unknown wallets with 2+ runner hits as shadow only, and labels launch-block buyers snipers", () => {
  const db = openDb(":memory:");
  const tape = new RunnerTape();
  runCoin(tape, "AAApump");
  runCoin(tape, "BBBpump");
  tape.evict(T0 + 25 * 3_600_000);
  saveCoins(db, tape.takeFinished().map(fromTape));
  defineRunners(db, T0 + 2 * 3_600_000);
  seedWallet(db, "buyer5"); // already known: its flag is left alone
  const r = scoreCatchers(db, T0 + 2 * 3_600_000);
  assert.equal(r.added, 50, "at most 50 a run");
  const added = db.prepare("SELECT COUNT(*) n, SUM(shadow_only) s FROM wallets WHERE discovered_via = 'runner_catcher'").get() as { n: number; s: number };
  assert.deepEqual(added, { n: 50, s: 50 });
  assert.equal((db.prepare("SELECT shadow_only FROM wallets WHERE address = 'buyer5'").get() as { shadow_only: number }).shadow_only, 0);
  assert.equal((db.prepare("SELECT label FROM runner_catchers WHERE wallet = 'buyer0'").get() as { label: string }).label, "sniper");
});

test("chain read: first buyers in order with their sells and the price a copy would have paid; the curve address is a PDA", () => {
  const ev = (t: number, slot: number, wallet: string, side: "buy" | "sell", price: number) => ({ t, slot, wallet, side, price, sol: 1, tokens: 1 / price });
  const { buyers, buys } = buyersFrom([ev(0, 1, "A", "buy", 1), ev(1000, 2, "B", "buy", 2), ev(3000, 3, "C", "buy", 3), ev(4000, 4, "A", "sell", 5)], 2000, 2);
  assert.equal(buys, 3);
  assert.deepEqual(buyers.map((b) => b.wallet), ["A", "B"]);
  assert.equal(buyers[0].copyPrice, 3);
  assert.equal(buyers[0].soldSol, 1);
  const mint = Keypair.generate().publicKey.toBase58();
  assert.equal(pumpCurveAddress(mint), pumpCurveAddress(mint));
  assert.equal(isWallet(pumpCurveAddress(mint)), false);
});

test("prices in the wrong units are ignored: no pump.fun coin runs 200,000x", () => {
  const tape = new RunnerTape();
  for (let i = 0; i < 10; i++) tape.record(swap({ mint: "UNITSpump", wallet: `w${i}`, t: T0 + i * 1000, price: P }), T0 + i * 1000);
  for (let m = 1; m < 20; m++) tape.record(swap({ mint: "UNITSpump", wallet: `x${m}`, t: T0 + m * 60_000, price: P * 1e9 }), T0 + m * 60_000);
  tape.evict(T0 + 25 * 3_600_000);
  const [c] = tape.takeFinished();
  assert.ok(c.multiple < 2);
});
