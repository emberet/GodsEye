import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "@godseye/shared";
import { adaptThresholds, FOLLOW_MIN_WIN_RATE, getParam, learnWinRateThreshold, type Outcome } from "../src/learning/adaptive";

const cfg = { floor: 0.4, ceiling: 0.8, maxStep: 0.05, minSamples: 20 };
/** n outcomes from wallets with this win rate, each returning `ret` %. */
const many = (n: number, winRate: number, ret: number): Outcome[] => Array.from({ length: n }, () => ({ winRate, ret }));

test("not enough data → the bar stays where it is", () => {
  const l = learnWinRateThreshold(many(5, 0.6, 50), 0.5, cfg, "copy trades");
  assert.equal(l.value, 0.5);
  assert.equal(l.changed, false);
  assert.match(l.reason, /waiting for data: 5\/20/);
});

test("copies of ~52% wallets lose, ~65% win → the bar rises to the lowest level that excludes the losers", () => {
  const outcomes = [...many(40, 0.52, -12), ...many(30, 0.65, 15)];
  const first = learnWinRateThreshold(outcomes, 0.45, cfg, "copy trades");
  assert.equal(first.target, 0.55);
  assert.equal(first.value, 0.5); // max 5 points per cycle
  assert.match(first.reason, /45% → 50%: following wallets with ≥ 55% wins: median \+15\.0% \(30 copy trades\); below that: median -12\.0% \(40\)/);
  const second = learnWinRateThreshold(outcomes, first.value, cfg, "copy trades");
  assert.equal(second.value, 0.55);
  assert.equal(learnWinRateThreshold(outcomes, second.value, cfg, "copy trades").changed, false);
});

test("lower-win-rate wallets turn out profitable too → the bar comes down", () => {
  const outcomes = [...many(40, 0.45, 8), ...many(30, 0.7, 20)];
  const l = learnWinRateThreshold(outcomes, 0.6, cfg, "copy trades");
  assert.equal(l.target, 0.4);
  assert.equal(l.value, 0.55);
});

test("nothing pays at any bar → it gets stricter, never past the ceiling", () => {
  const l = learnWinRateThreshold([...many(30, 0.5, -5), ...many(30, 0.75, -3)], 0.78, cfg, "copy trades");
  assert.equal(l.target, 0.8);
  assert.equal(l.value, 0.8);
  assert.match(l.reason, /getting stricter/);
});

test("in the database: learns from shadow copies until real copy trades exist, then from those", () => {
  const db = openDb(":memory:");
  const now = new Date().toISOString();
  const flow = db.prepare("INSERT INTO smart_flows (signature, ts, wallet, mint, side, usd, price_usd, wallet_win_rate, ret_6h, checked) VALUES (?, ?, 'w', 'm', 'buy', 100, 1, ?, ?, 7)");
  for (let i = 0; i < 30; i++) flow.run(`a${i}`, now, 0.52, -10);
  for (let i = 0; i < 25; i++) flow.run(`b${i}`, now, 0.66, 12);
  assert.equal(adaptThresholds(db), 0.55);
  assert.equal(getParam(db, FOLLOW_MIN_WIN_RATE, 0), 0.55);
  const hist = db.prepare("SELECT old_value, new_value, reason FROM param_history").get() as { old_value: number; new_value: number; reason: string };
  assert.equal(hist.old_value, 0.5);
  assert.match(hist.reason, /shadow copies of smart buys \(6h results\)/);

  // Real copy trades now say even 50% wallets were fine → it follows the real results.
  const pos = db.prepare("INSERT INTO positions (mint, symbol, leader, mode, status, token_amount, tokens_bought, cost_sol, entry_price_sol, opened_at, closed_at, pnl_sol, pnl_pct, leader_win_rate) VALUES ('m','M','L','real','closed',0,1,1,1,?,?,0.1,?,?)");
  for (let i = 0; i < 25; i++) pos.run(now, now, 10, 0.5);
  assert.equal(adaptThresholds(db), 0.5);
  assert.match((db.prepare("SELECT reason FROM learning_params").get() as { reason: string }).reason, /copy trades/);
});

test("before 6-hour results exist, it learns from 1-hour shadow results", () => {
  const db = openDb(":memory:");
  const now = new Date().toISOString();
  const flow = db.prepare("INSERT INTO smart_flows (signature, ts, wallet, mint, side, usd, price_usd, wallet_win_rate, ret_1h, checked) VALUES (?, ?, 'w', 'm', 'buy', 100, 1, ?, ?, 1)");
  for (let i = 0; i < 30; i++) flow.run(`a${i}`, now, 0.52, -10);
  for (let i = 0; i < 25; i++) flow.run(`b${i}`, now, 0.66, 12);
  assert.equal(adaptThresholds(db), 0.55);
  assert.match((db.prepare("SELECT reason FROM learning_params").get() as { reason: string }).reason, /1h results/);
});

test("learning loop: weights stay between 0 and 1, add up to at most the whole budget, and only go to eligible wallets", async () => {
  const { runLearning } = await import("../src/learning/loop");
  const db = openDb(":memory:");
  const now = new Date().toISOString();
  const add = (address: string, tier: string, pnl: number, winRate: number, closed: number) => {
    db.prepare("INSERT INTO wallets (address, first_seen_at, discovered_via, tier, last_analyzed_at) VALUES (?, ?, 'test', ?, ?)").run(address, now, tier, now);
    db.prepare(
      `INSERT INTO wallet_stats (wallet, computed_at, swaps_total, swaps_7d, swaps_30d, pnl_7d_sol, pnl_30d_sol, pnl_all_sol, pnl_7d_usd, pnl_30d_usd, closed_7d, closed_30d, wins_30d, win_rate_30d)
       VALUES (?, ?, 100, 50, 100, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(address, now, pnl, pnl * 2, pnl * 2, pnl * 150, pnl * 300, closed, closed, Math.round(closed * winRate), winRate);
  };
  for (let i = 0; i < 12; i++) add(`P${i}`, "proven", 1 + i, 0.55 + i * 0.02, 30 + i);
  add("LOSER", "proven", -5, 0.3, 40);
  add("BOT", "unproven", 50, 0.9, 2);
  runLearning(db);
  const w = db.prepare("SELECT address, copy_weight FROM wallets").all() as { address: string; copy_weight: number }[];
  const total = w.reduce((s, r) => s + r.copy_weight, 0);
  assert.ok(total <= 1 + 1e-9, `weights add up to ${total}`);
  for (const r of w) assert.ok(r.copy_weight >= 0 && r.copy_weight <= 1, `${r.address} ${r.copy_weight}`);
  assert.equal(w.find((r) => r.address === "LOSER")!.copy_weight, 0, "a losing wallet isn't copied");
  assert.equal(w.find((r) => r.address === "BOT")!.copy_weight, 0, "an unproven wallet isn't copied");
  assert.ok(w.some((r) => r.copy_weight > 0), "someone qualifies");
});
