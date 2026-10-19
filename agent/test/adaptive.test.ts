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
