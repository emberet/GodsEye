import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "@godseye/shared";
import { buyFill, DEFAULT_PARAMS, type LeaderSwap, type Obs, type ReplayParams, sellFill, simulateMint, Tape } from "../src/replay/model";
import { calibration, pool, replayWallet, summarizeWallet } from "../src/replay/run";
import { summarize } from "../src/replay/summary";

const T0 = Date.parse("2026-10-20T00:00:00Z");
const MIN = 60_000;
/** Clean maths: no fees, no tx costs, a pool so deep that nothing moves the price. */
const CLEAN: ReplayParams = { ...DEFAULT_PARAMS, feeBps: 0, txCostSol: 0, defaultDepthSol: 1e9, delaySec: 5, landSec: 2, sizeSol: 0.1 };
const tapeOf = (obs: Obs[], p: ReplayParams = CLEAN) => new Tape(obs, p.feeBps, p.defaultDepthSol, p.depthWindowSec * 1000);
const ob = (sec: number, side: "buy" | "sell", price: number, sol = 0.001, sig?: string): Obs => ({ t: T0 + sec * 1000, side, price, sol, sig });
const ls = (sec: number, side: "buy" | "sell", price: number, o: Partial<LeaderSwap> = {}): LeaderSwap => ({
  t: T0 + sec * 1000, side, price, solAmount: 1, tokenAmount: 1 / price, tokenBalanceBefore: side === "sell" ? 1 / price : 0, signature: `L${sec}${side}`, ...o,
});
const run = (obs: Obs[], swaps: LeaderSwap[], p: Partial<ReplayParams> = {}, endSec = 3600) => {
  const params = { ...CLEAN, ...p };
  return simulateMint(tapeOf(obs, params), "MEME", swaps, T0 + endSec * 1000, params);
};

test("tape: prices carry the DEX fee, the mid does not", () => {
  const t = tapeOf([ob(0, "buy", 1.01), ob(1, "sell", 0.99)], { ...CLEAN, feeBps: 100 });
  assert.ok(Math.abs(t.mid(t.obs[0]) - 1) < 1e-9);
  assert.ok(Math.abs(t.mid(t.obs[1]) - 1) < 1e-9);
});

test("tape: the price at a time is the price after the last swap before it, plus that swap's own impact", () => {
  const t = tapeOf([ob(0, "buy", 1, 1), ob(10, "sell", 2, 1)], { ...CLEAN, defaultDepthSol: 10 });
  assert.equal(t.midAt(T0 - 1), null);
  const a = t.midAt(T0 + 5000)!;
  assert.ok(Math.abs(a.mid - 1.1) < 1e-9, "a 1 SOL buy into 10 SOL of depth leaves the price 10% above its average");
  assert.equal(a.ageSec, 5);
  assert.ok(Math.abs(t.midAt(T0 + 10_000)!.mid - 2 / 1.1) < 1e-9, "a sell leaves it below");
});

test("tape: pool depth is recovered from how the price moved with the flow", () => {
  let x = 50;
  let y = 1000;
  const obs: Obs[] = [];
  for (let i = 0; i < 14; i++) {
    const buy = i % 4 !== 3;
    if (buy) {
      const d = 1 + (i % 3);
      const tokens = (y * d) / (x + d);
      obs.push(ob(i * 5, "buy", d / tokens, d));
      x += d;
      y -= tokens;
    } else {
      const dy = y * 0.02;
      const sol = (x * dy) / (y + dy);
      obs.push(ob(i * 5, "sell", sol / dy, sol));
      x -= sol;
      y += dy;
    }
  }
  const depth = tapeOf(obs).depthAt(obs.length - 1);
  assert.ok(Math.abs(depth - x) / x < 0.25, `estimated ${depth.toFixed(1)}, pool has ${x.toFixed(1)}`);
});

test("tape: too little data → the default depth; swaps far apart say nothing", () => {
  assert.equal(tapeOf([ob(0, "buy", 1), ob(1, "buy", 1.1)], { ...CLEAN, defaultDepthSol: 7 }).depthAt(1), 7);
  assert.equal(tapeOf([ob(0, "buy", 1), ob(300, "buy", 2), ob(600, "buy", 3), ob(900, "buy", 4), ob(1200, "buy", 5)], { ...CLEAN, defaultDepthSol: 7 }).depthAt(4), 7);
});

test("fills: fee and impact work against the follower on both sides", () => {
  const b = buyFill(1, 0.5, 50, 100);
  assert.ok(Math.abs(b.price - 1.01 * 1.01) < 1e-9);
  assert.ok(Math.abs(b.tokens * b.price - 0.5) < 1e-9);
  const s = sellFill(1, 10, 50, 100);
  assert.ok(Math.abs(s.price - 0.99 / (1 + 10 / 50)) < 1e-9);
  assert.ok(s.sol < 10);
  // a silly depth can't invent a 100× move
  assert.ok(buyFill(1, 100, 0.01, 0).price <= 4 + 1e-9);
});

test("replay: flat price, no costs → copying is the same as the leader", () => {
  const obs = [ob(0, "buy", 1, 1, "L0buy"), ob(60, "sell", 1, 1, "L60sell")];
  const [e] = run(obs, [ls(0, "buy", 1), ls(60, "sell", 1)]);
  assert.ok(Math.abs(e.pnlSol) < 1e-9);
  assert.equal(e.exitReason, "leader sold");
  assert.equal(e.closed, true);
});

test("replay: price runs away after the leader buys → the follower enters worse and earns less", () => {
  const obs = [ob(0, "buy", 1, 1, "L0buy"), ob(3, "buy", 1.5), ob(100, "sell", 2, 1, "L100sell")];
  const swaps = [ls(0, "buy", 1), ls(100, "sell", 2)];
  const [real] = run(obs, swaps);
  const [ideal] = run(obs, swaps, { ideal: true });
  assert.ok(Math.abs(ideal.retPct - 100) < 1e-6);
  assert.ok(Math.abs(real.retPct - 100 / 3) < 1e-6, `got ${real.retPct}`);
  assert.ok(Math.abs(real.entryDrift - 0.5) < 1e-6);
  // before the run-up lands (a 2 s delay) the follower still gets the leader's price
  const [fast] = run(obs, swaps, { delaySec: 2 });
  assert.ok(Math.abs(fast.retPct - 100) < 1e-6);
});

test("replay: every transaction costs its fee, round trip", () => {
  const obs = [ob(0, "buy", 1, 1, "L0buy"), ob(60, "sell", 1, 1, "L60sell")];
  const [e] = run(obs, [ls(0, "buy", 1), ls(60, "sell", 1)], { txCostSol: 0.001 });
  assert.ok(Math.abs(e.pnlSol - -0.002) < 1e-9);
  assert.ok(Math.abs(e.costSol - 0.101) < 1e-9);
});

test("replay: DEX fees on both sides and the leader's own impact eat the return", () => {
  const p = { feeBps: 100, defaultDepthSol: 10 };
  // the leader's 1 SOL buy into 10 SOL of depth moved the price; the follower buys after it
  const obs = [ob(0, "buy", 1.01, 1, "L0buy"), ob(60, "sell", 0.99, 0.5, "L60sell")];
  const [e] = run(obs, [ls(0, "buy", 1.01), ls(60, "sell", 0.99)], p);
  assert.ok(e.entryDrift > 0.1, `entry drift ${e.entryDrift}`);
  assert.ok(e.retPct < -10);
});

test("replay: stop-loss exits on the minute grid when the leader never sells", () => {
  const obs = [ob(0, "buy", 1, 1, "L0buy"), ob(120, "sell", 0.6, 0.5)];
  const [real] = run(obs, [ls(0, "buy", 1)], { delaySec: 1 });
  assert.equal(real.exitReason, "stop-loss");
  assert.equal(real.closed, true);
  assert.ok(Math.abs(real.retPct - -40) < 1e-6);
  // a gentler drop doesn't trigger it
  const [calm] = run([ob(0, "buy", 1, 1, "L0buy"), ob(120, "sell", 0.8, 0.5)], [ls(0, "buy", 1)], { delaySec: 1 });
  assert.equal(calm.exitReason, "still open");
});

test("replay: take-profit and max-hold", () => {
  const [tp] = run([ob(0, "buy", 1, 1, "L0buy"), ob(300, "buy", 5, 0.5)], [ls(0, "buy", 1)], { delaySec: 1 });
  assert.equal(tp.exitReason, "take-profit");
  assert.ok(tp.retPct > 300);
  const [hold] = run([ob(0, "buy", 1, 1, "L0buy"), ob(7200, "buy", 1, 0.5)], [ls(0, "buy", 1)], { delaySec: 1, maxHoldHours: 1 }, 3 * 3600);
  assert.equal(hold.exitReason, "max-hold");
  assert.equal(hold.closed, true);
});

test("replay: still open when the data ends → marked at the last price, flagged open", () => {
  const [e] = run([ob(0, "buy", 1, 1, "L0buy"), ob(600, "sell", 0.9, 0.1)], [ls(0, "buy", 1)], { txCostSol: 0.001 }, 1800);
  assert.equal(e.closed, false);
  assert.equal(e.exitReason, "still open");
  assert.ok(Math.abs(e.pnlSol - (0.09 - 0.1 - 0.002)) < 1e-9);
});

test("replay: leader sells in pieces → the follower sells the same share each time", () => {
  const obs = [ob(0, "buy", 1, 1, "L0buy"), ob(60, "sell", 2, 0.5, "L60sell"), ob(120, "sell", 2, 0.5, "L120sell")];
  const swaps = [
    ls(0, "buy", 1, { tokenAmount: 100 }),
    ls(60, "sell", 2, { tokenAmount: 50, tokenBalanceBefore: 100 }),
    ls(120, "sell", 2, { tokenAmount: 50, tokenBalanceBefore: 50 }),
  ];
  const eps = run(obs, swaps, { delaySec: 0 });
  assert.equal(eps.length, 1);
  assert.equal(eps[0].exitReason, "leader sold");
  assert.ok(Math.abs(eps[0].retPct - 100) < 1e-6);
  assert.equal(eps[0].leaderFirstSellSec, 60);
});

test("replay: copy-engine rules — small buys skipped, no second position while holding, re-entry after exit", () => {
  const obs = [ob(0, "buy", 1, 0.1, "L0buy"), ob(10, "buy", 1, 1, "L10buy"), ob(60, "sell", 1, 1, "L60sell"), ob(100, "buy", 1, 1, "L100buy"), ob(160, "sell", 1, 1, "L160sell")];
  assert.equal(run(obs, [ls(0, "buy", 1, { solAmount: 0.1 })]).length, 0);
  const eps = run(obs, [ls(10, "buy", 1), ls(20, "buy", 1), ls(60, "sell", 1), ls(100, "buy", 1), ls(160, "sell", 1)]);
  assert.equal(eps.length, 2);
  assert.deepEqual(eps.map((e) => e.entrySignature), ["L10buy", "L100buy"]);
});

test("replay: no price on the tape → no copy", () => {
  assert.equal(run([], [ls(0, "buy", 1)]).length, 0);
});

test("summary: copy cost, drift, concentration and the confidence interval", () => {
  const obs = [ob(0, "buy", 1, 1, "L0buy"), ob(3, "buy", 1.5), ob(100, "sell", 2, 1, "L100sell")];
  const swaps = [ls(0, "buy", 1), ls(100, "sell", 2)];
  const s = summarize(5, run(obs, swaps), run(obs, swaps, { ideal: true }));
  assert.equal(s.n, 1);
  assert.equal(s.winRate, 1);
  assert.ok(Math.abs(s.idealMeanRetPct! - 100) < 1e-6);
  assert.ok(Math.abs(s.copyCostPp! - (100 - 100 / 3)) < 1e-6);
  assert.ok(Math.abs(s.medianDriftPct! - 50) < 1e-6);
  assert.equal(s.top1Share, 1);
  assert.equal(s.ciHalfPct, null, "one position has no interval");
  assert.equal(summarize(5, [], []).meanRetPct, null);
  const losers = run([ob(0, "buy", 1, 1, "L0buy"), ob(60, "sell", 0.5, 1, "L60sell")], [ls(0, "buy", 1), ls(60, "sell", 0.5)]);
  assert.equal(summarize(5, losers, []).top1Share, null, "no share of a profit that isn't there");
});

// ---- from the database ----
const swapRow = (db: ReturnType<typeof openDb>, wallet: string, mint: string, sec: number, side: "buy" | "sell", price: number, sol: number, before = 0) =>
  db
    .prepare(
      `INSERT INTO wallet_swaps (wallet, signature, slot, ts, mint, side, token_amount, token_balance_before, sol_amount, price_sol)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(wallet, `${wallet}-${mint}-${sec}-${side}`, 1000 + sec, new Date(T0 + sec * 1000).toISOString(), mint, side, sol / price, before, sol, price);

test("database: a leader's swaps replayed against every wallet's swaps in the token", () => {
  const db = openDb(":memory:");
  swapRow(db, "leader", "MEME", 0, "buy", 1, 1);
  swapRow(db, "other", "MEME", 3, "buy", 1.5, 0.01);
  swapRow(db, "leader", "MEME", 100, "sell", 2, 1, 0.5);
  swapRow(db, "leader", "USDCX", 0, "buy", 1, 1); // a non-memecoin
  db.prepare("INSERT INTO token_info (mint, symbol, checked_at) VALUES ('USDCX', 'USDC', ?)").run(new Date().toISOString());
  const r = replayWallet(db, "leader", [2, 5], { feeBps: 0, txCostSol: 0, defaultDepthSol: 1e9 }, { endT: T0 + 7200_000 });
  assert.equal(r.ideal.length, 1, "the stablecoin is skipped");
  const [s2, s5] = summarizeWallet(r);
  assert.ok(s2.meanRetPct! > s5.meanRetPct!, "later is worse");
  assert.ok(Math.abs(s5.meanRetPct! - 100 / 3) < 1e-6);
  const p = pool([r], [2, 5]);
  assert.equal(p[1].n, 1);
  db.close();
});

test("database: real copies are compared with the leader's price", () => {
  const db = openDb(":memory:");
  assert.equal(calibration(db).n, 0);
  swapRow(db, "leader", "MEME", 0, "buy", 1, 1);
  db.prepare(
    `INSERT INTO copy_trades (leader, leader_signature, leader_ts, mint, side, mode, status, price_sol, fee_sol, latency_ms, created_at)
     VALUES ('leader', 'leader-MEME-0-buy', ?, 'MEME', 'buy', 'real', 'filled', 1.2, 0.002, 4000, ?)`,
  ).run(new Date(T0).toISOString(), new Date().toISOString());
  const c = calibration(db);
  assert.equal(c.n, 1);
  assert.equal(c.medianLatencySec, 4);
  assert.ok(Math.abs(c.medianDriftPct! - 20) < 1e-9);
  assert.equal(c.medianFeeSol, 0.002);
  db.close();
});

test("tape: a fixed depth overrides the estimate", () => {
  const t = new Tape([ob(0, "buy", 1, 1), ob(10, "sell", 2, 1)], 0, 7, 600_000, 20);
  assert.equal(t.depthAt(1), 20);
  assert.ok(Math.abs(t.midAt(T0 + 5000)!.mid - 1.05) < 1e-9);
});

test("database: only leader trades before the cut-off are replayed, but exits still use later prices", () => {
  const db = openDb(":memory:");
  swapRow(db, "leader", "MEME", 0, "buy", 1, 1);
  swapRow(db, "leader", "MEME", 100, "sell", 2, 1, 0.5);
  swapRow(db, "leader", "MEME", 5000, "buy", 1, 1);
  swapRow(db, "leader", "MEME", 5100, "sell", 1, 1, 1);
  const p = { feeBps: 0, txCostSol: 0, defaultDepthSol: 1e9 };
  assert.equal(replayWallet(db, "leader", [5], p, { endT: T0 + 7200_000 }).ideal.length, 2);
  const early = replayWallet(db, "leader", [5], p, { endT: T0 + 7200_000, untilMs: T0 + 1000_000 });
  assert.equal(early.ideal.length, 1);
  assert.equal(early.ideal[0].entrySignature, "leader-MEME-0-buy");
  const late = replayWallet(db, "leader", [5], p, { endT: T0 + 7200_000, sinceMs: T0 + 1000_000 });
  assert.equal(late.ideal.length, 1);
  db.close();
});
