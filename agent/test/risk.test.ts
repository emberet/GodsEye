/**
 * The risk governor (copy/risk.ts): score kept per unit, so deposits and withdrawals are never wins or losses; the day's
 * stop and the self-pause; the per-trade share f; the limits a buy gets; and the engine's buy check under it.
 * Synthetic numbers, an in-memory database and a fake executor: nothing signs or sends anything.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { getMeta, openDb, setMeta, type DB } from "@godseye/shared";
import type { ParsedSwap } from "../src/chain/parse";
import type { Executor, Fill } from "../src/copy/executor";

const { config } = await import("../src/config");
const { ceilingsOf, effectiveLimits, limitsFrom, railsOf, readRiskState, RESET_HIGH_KEY, riskLook, riskStep, STALE_MS } = await import("../src/copy/risk");
type RiskState = import("../src/copy/risk").RiskState;
type Look = import("../src/copy/risk").Look;
const { CopyEngine } = await import("../src/copy/engine");
const { attachLogDb } = await import("../src/log");

const rails = { maxTradePct: 10, startTradePct: 5, minTradePct: 3, dailyStopPct: 20, drawdownPausePct: 50, minTradeSol: 0.05, minEquitySol: 0.5 };
const noCeil = { maxTradeSol: 5, budgetSol: Infinity, minTradeSol: 0.01 };
const T0 = Date.parse("2026-11-20T10:00:00.000Z");
const MIN = 60_000;
const look = (p: Partial<Look>): Look => ({ now: T0, value: 10, reserve: 0.05, flows: [], busy: false, closed: 0, recentReturn: null, resetHigh: false, ...p });
/** Runs looks one after another, each starting from the last state. */
function run(looks: Partial<Look>[], start: RiskState | null = null) {
  let s = start;
  const steps = looks.map((l, i) => {
    const st = riskStep(s, look({ now: T0 + i * MIN, ...l }), rails);
    s = st.state;
    return st;
  });
  return { steps, state: s! };
}
const near = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);

test("the first look starts at 1 SOL a unit on what is there; equity leaves the fee reserve out", () => {
  const { state } = run([{ value: 4 }]);
  near(state.units, 4);
  near(state.nav, 1);
  near(state.high, 1);
  near(state.equity, 3.95);
  near(state.f, 0.05);
  assert.equal(state.day, "2026-11-20");
});

test("a deposit buys units and a withdrawal redeems them: neither moves the value per unit, the high or a stop", () => {
  // 10 SOL, the value grows to 12 (+20%), then 5 SOL comes in, then 13.6 SOL goes out.
  const { steps, state } = run([{ value: 10 }, { value: 12 }, { value: 12 }, { value: 17, flows: [5] }, { value: 17 }, { value: 3.4, flows: [-13.6] }, { value: 3.4 }]);
  near(steps[3].priced[0].nav, 1.2);
  near(steps[3].priced[0].units, 5 / 1.2);
  near(state.nav, 1.2);
  near(state.high, 1.2);
  near(steps[5].priced[0].units, -13.6 / 1.2);
  near(state.units, 3.4 / 1.2);
  assert.ok(steps.every((s) => !s.stopped && !s.drawdown), "no stop, no pause from money moving");
  assert.equal(state.stoppedDay, null);
});

test("the day's stop: 20% down per unit, open losses counted, once two looks in a row show it; a new day starts fresh", () => {
  const one = run([{ value: 10 }, { value: 7.9 }]);
  assert.equal(one.steps[1].stopped, false, "a single look below the line is not enough");
  const two = run([{ value: 10 }, { value: 7.9 }, { value: 7.9 }]);
  assert.equal(two.steps[2].stopped, true);
  assert.equal(two.state.stoppedDay, "2026-11-20");
  const again = riskStep(two.state, look({ now: T0 + 3 * MIN, value: 7 }), rails);
  assert.equal(again.stopped, false, "it fires once a day");
  // Next UTC day: the day starts again from the value then.
  const tomorrow = riskStep(again.state, look({ now: T0 + 24 * 60 * MIN, value: 7 }), rails);
  assert.equal(tomorrow.state.day, "2026-11-21");
  near(tomorrow.state.dayStart, 0.7);
  assert.equal(tomorrow.stopped, false);
  // A dip under the line while a withdrawal isn't listed yet, priced at the next look: no stop.
  const lag = run([{ value: 10 }, { value: 6 }, { value: 6, flows: [-4] }, { value: 6 }]);
  assert.ok(lag.steps.every((s) => !s.stopped), "an unlisted withdrawal must not fire the day's stop");
  near(lag.state.nav, 1);
});

test("the self-pause: 50% below the highest value per unit, two looks in a row; a deposit doesn't hide a loss", () => {
  const { steps } = run([{ value: 10 }, { value: 4.9 }, { value: 4.9 }]);
  assert.equal(steps[1].drawdown, false);
  assert.equal(steps[2].drawdown, true);
  // Losing half and topping the wallet back up with a deposit: still half down per unit.
  const topped = run([{ value: 10 }, { value: 5 }, { value: 5 }, { value: 10, flows: [5] }, { value: 10 }]);
  assert.equal(topped.steps[4].drawdown, true);
  near(topped.state.nav, 0.5);
  // The owner resumes: the high starts again from here.
  const reset = riskStep(topped.state, look({ now: T0 + 5 * MIN, value: 10, resetHigh: true }), rails);
  near(reset.state.high, 0.5);
  assert.equal(reset.drawdown, false);
});

test("the high: a one-look spike, or a look with trades under way, doesn't lift it", () => {
  near(run([{ value: 10 }, { value: 30 }, { value: 10 }]).state.high, 1, 1e-9);
  near(run([{ value: 10 }, { value: 12, busy: true }, { value: 12, busy: true }]).state.high, 1);
  near(run([{ value: 10 }, { value: 12 }, { value: 12 }]).state.high, 1.2);
});

test("f, the share a trade gets: 5% until 30 closed trades, then half a point up on profit, a point down on loss, every 10 trades, inside 3–10%", () => {
  near(run([{ closed: 29, recentReturn: 0.5 }]).state.f, 0.05);
  const up = run([{ closed: 30, recentReturn: 0.1 }]);
  near(up.state.f, 0.055);
  near(riskStep(up.state, look({ now: T0 + MIN, closed: 35, recentReturn: 0.1 }), rails).state.f, 0.055, 1e-12); // only every 10
  near(riskStep(up.state, look({ now: T0 + MIN, closed: 40, recentReturn: -0.1 }), rails).state.f, 0.045);
  let s = up.state;
  for (let i = 1; i <= 20; i++) s = riskStep(s, look({ now: T0 + i * MIN, closed: 30 + i * 10, recentReturn: -0.2 }), rails).state;
  near(s.f, 0.03);
  for (let i = 21; i <= 60; i++) s = riskStep(s, look({ now: T0 + i * MIN, closed: 30 + i * 10, recentReturn: 0.2 }), rails).state;
  near(s.f, 0.1);
  near(riskStep(up.state, look({ now: T0 + MIN, closed: 40, recentReturn: -0.1, busy: true }), rails).state.f, 0.055, 1e-12);
});

test("an emptied wallet starts again at 1 SOL a unit with the next deposit", () => {
  const { state } = run([{ value: 10 }, { value: 0, flows: [-10] }, { value: 0 }, { value: 2, flows: [2] }, { value: 2 }]);
  near(state.units, 2);
  near(state.nav, 1);
  near(state.high, 1);
});

const fresh = (p: Partial<RiskState> = {}): RiskState => ({ ...run([{ value: 10 }]).state, ...p });

test("limits: size = what it has × f, at least 0.05 SOL up to the 10% rail; under 0.5 SOL no buys", () => {
  const at = (equity: number, f = 0.05) => limitsFrom(fresh({ equity, f }), equity, rails, noCeil, T0);
  const big = at(2);
  assert.ok(big.ok);
  near(big.copyMaxTradeSol, 0.1);
  near(big.copyBudgetSol, 2);
  near(big.copyMinTradeSol, 0.05);
  const small = at(0.6);
  assert.ok(small.ok);
  near(small.copyMaxTradeSol, 0.05, 1e-6); // 3% would be 0.018: up to the 10% rail (0.06) to reach 0.05
  const tiny = at(0.4);
  assert.ok(!tiny.ok && tiny.key === "risk-small");
  const capped = limitsFrom(fresh({ equity: 100, f: 0.1 }), 100, rails, { ...noCeil, maxTradeSol: 0.3, budgetSol: 2 }, T0);
  assert.ok(capped.ok);
  near(capped.copyMaxTradeSol, 0.3);
  near(capped.copyBudgetSol, 2);
  const below = limitsFrom(fresh({ equity: 2 }), 2, rails, { ...noCeil, maxTradeSol: 0.02 }, T0);
  assert.ok(!below.ok && below.key === "risk-ceiling");
});

test("limits: money not recorded yet is never traded, an unreadable wallet blocks, an old look blocks, the day's stop blocks", () => {
  const s = fresh({ equity: 2 });
  const inflow = limitsFrom(s, 20, rails, noCeil, T0);
  assert.ok(inflow.ok);
  near(inflow.copyMaxTradeSol, 0.1, 1e-9); // sized on the 2 SOL the ledger knows of, not the 20 the wallet shows
  const outflow = limitsFrom(s, 1, rails, noCeil, T0);
  assert.ok(outflow.ok);
  near(outflow.copyMaxTradeSol, 0.05, 1e-9);
  const unread = limitsFrom(s, null, rails, noCeil, T0);
  assert.ok(!unread.ok && unread.key === "risk-unread");
  const old = limitsFrom(s, 2, rails, noCeil, T0 + STALE_MS + 1);
  assert.ok(!old.ok && old.key === "risk-stale");
  const none = limitsFrom(null, 2, rails, noCeil, T0);
  assert.ok(!none.ok && none.key === "risk-none");
  const stopped = limitsFrom(fresh({ equity: 2, stoppedDay: "2026-11-20" }), 2, rails, noCeil, T0);
  assert.ok(!stopped.ok && stopped.key === "risk-day");
  assert.ok(limitsFrom(fresh({ equity: 2, stoppedDay: "2026-11-19" }), 2, rails, noCeil, T0).ok, "yesterday's stop is over");
});

test("ceilings: the fixed limits count only when written in .env; the hard cap always does", () => {
  const off = { maxTrade: false, budget: false, dailyLoss: false };
  const c0 = ceilingsOf({ ...config, fixedInEnv: off, copyMaxTradeSol: 0.1, copyBudgetSol: 1 });
  assert.equal(c0.maxTradeSol, 5);
  assert.equal(c0.budgetSol, Infinity);
  const c1 = ceilingsOf({ ...config, fixedInEnv: { maxTrade: true, budget: true, dailyLoss: false }, copyMaxTradeSol: 0.1, copyBudgetSol: 1 });
  assert.equal(c1.maxTradeSol, 0.1);
  assert.equal(c1.budgetSol, 1);
  assert.deepEqual(railsOf(config), rails, "the defaults are the owner's Aggressive rails");
});

// ---------------------------------------------------------------- the database side

function db0(): DB {
  return openDb(":memory:");
}
function flow(db: DB, sol: number, slot: number, kind = sol > 0 ? "deposit" : "withdrawal") {
  db.prepare("INSERT INTO wallet_flows (signature, slot, ts, kind, sol, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(`f${Math.random()}`, slot, new Date(T0).toISOString(), kind, sol, new Date(T0).toISOString());
}
function position(db: DB, o: { cost: number; price?: number | null; tokens?: number }) {
  db.prepare(
    `INSERT INTO positions (mint, symbol, leader, mode, status, token_amount, tokens_bought, cost_sol, entry_price_sol, last_price_sol, opened_at)
     VALUES (?, 'X', 'LEADER', 'real', 'open', ?, ?, ?, 0.001, ?, ?)`,
  ).run(`M${Math.random()}`, o.tokens ?? 1000, o.tokens ?? 1000, o.cost, o.price ?? null, new Date(T0).toISOString());
}

test("riskLook prices only the flows up to the balance's slot, and values open positions at no more than cost", () => {
  const db = db0();
  riskLook(db, config, 10, 100, T0);
  flow(db, 5, 150);
  flow(db, 3, 250); // after the balance's slot: waits for a later look
  riskLook(db, config, 15, 200, T0 + MIN);
  const rows = db.prepare("SELECT sol, units, nav FROM wallet_flows ORDER BY slot").all() as { sol: number; units: number | null; nav: number | null }[];
  near(rows[0].units!, 5);
  near(rows[0].nav!, 1);
  assert.equal(rows[1].units, null);
  // A position worth 10× its cost counts at cost; one worth half counts at half.
  position(db, { cost: 1, price: 0.01 }); // 1000 tokens × 0.01 = 10 SOL
  riskLook(db, config, 14, 200, T0 + 2 * MIN);
  riskLook(db, config, 14, 200, T0 + 3 * MIN);
  near(readRiskState(db)!.nav, 1);
  near(readRiskState(db)!.high, 1);
  position(db, { cost: 2, price: 0.001 }); // 1000 × 0.001 = 1 SOL
  riskLook(db, config, 12, 200, T0 + 4 * MIN);
  near(readRiskState(db)!.nav, 14 / 15);
});

test("riskLook pauses itself at the drawdown line, tells the owner, and `resume` restarts the high", () => {
  const db = db0();
  attachLogDb(db);
  try {
    riskLook(db, config, 10, 1, T0);
    riskLook(db, config, 4, 1, T0 + MIN);
    riskLook(db, config, 4, 1, T0 + 2 * MIN);
  } finally {
    attachLogDb(null as unknown as DB);
  }
  assert.equal(getMeta(db, "copy_paused"), "1");
  assert.equal(getMeta(db, "copy_paused_by"), "drawdown");
  const said = (db.prepare("SELECT message FROM agent_log ORDER BY id").all() as { message: string }[]).map((r) => r.message).join("\n");
  assert.match(said, /Day's stop/);
  assert.match(said, /Paused itself: 50% or more below its high/);
  assert.match(said, /Owner alert \(self_pause\)/);
  const pub = JSON.parse(getMeta(db, "risk_limits")!) as { selfPaused: boolean; stoppedToday: boolean; fromHighPct: number };
  assert.equal(pub.selfPaused, true);
  assert.equal(pub.stoppedToday, true);
  near(pub.fromHighPct, -60, 1e-6);
  // What `npm run resume` does after a self-pause:
  setMeta(db, "copy_paused", "0");
  setMeta(db, RESET_HIGH_KEY, "1");
  riskLook(db, config, 4, 1, T0 + 3 * MIN);
  near(readRiskState(db)!.high, 0.4);
  assert.equal(getMeta(db, RESET_HIGH_KEY), "0");
  riskLook(db, config, 4, 1, T0 + 4 * MIN);
  assert.equal(getMeta(db, "copy_paused"), "0", "no second pause from the same loss");
});

test("the public summary holds figures only: no address, no signature", () => {
  const db = db0();
  flow(db, 2, 5);
  riskLook(db, config, 10, 1, T0);
  riskLook(db, config, 12, 10, T0 + MIN);
  const text = getMeta(db, "risk_limits")!;
  assert.doesNotMatch(text, /[1-9A-HJ-NP-Za-km-z]{32,}/);
  const pub = JSON.parse(text) as Record<string, unknown>;
  assert.deepEqual(Object.keys(pub).sort(), ["at", "dayChangePct", "equitySol", "fromHighPct", "rails", "selfPaused", "stoppedToday", "tradePct", "tradeSol"]);
});

// ---------------------------------------------------------------- the engine's buy check under the governor

class RealFake implements Executor {
  mode = "real" as const;
  calls: string[] = [];
  async buy(_m: string, sol: number): Promise<Fill> {
    this.calls.push(`buy ${sol}`);
    return { signature: null, solAmount: sol, tokenAmount: sol * 1000, priceSol: 0.001, feeSol: 0 };
  }
  async sell(_m: string, tokens: number): Promise<Fill> {
    this.calls.push(`sell ${tokens}`);
    return { signature: null, solAmount: tokens * 0.001, tokenAmount: tokens, priceSol: 0.001, feeSol: 0 };
  }
}
let n = 0;
function engineSetup() {
  const db = db0();
  db.prepare("INSERT INTO wallets (address, first_seen_at, discovered_via, copy_weight) VALUES ('LEADER', ?, 'test', 0.5)").run(new Date().toISOString());
  const mint = `Mint${String(++n).padStart(39, "1")}`;
  db.prepare("INSERT INTO token_info (mint, symbol, decimals, pool_created_at, checked_at) VALUES (?, 'MOO', 6, '2026-01-01T00:00:00Z', ?)").run(mint, new Date().toISOString());
  const ex = new RealFake();
  return { db, ex, mint, engine: new CopyEngine(db, ex, Keypair.generate().publicKey, null, null) };
}
const leaderBuy = (mint: string): ParsedSwap => ({
  wallet: "LEADER", signature: `sig${Math.random()}`, slot: 1, ts: new Date().toISOString(), mint, side: "buy",
  tokenAmount: 1000, tokenBalanceBefore: 0, solAmount: 1, priceSol: 0.001, venue: "jupiter", jitoTip: false, feeLamports: 5000, quote: "SOL", quoteAmount: 1, solUsd: null, usdAmount: null,
});
/** The engine's wallet reads answer `sol`, or fail (null). */
const setBalance = (engine: InstanceType<typeof CopyEngine>, sol: number | null) => {
  engine.balanceOf = async () => {
    if (sol === null) throw new Error("node down");
    return sol;
  };
};

test("engine: with real money a buy is sized from the wallet (here 4 SOL × 5% = 0.2 SOL)", async () => {
  const { db, ex, mint, engine } = engineSetup();
  riskLook(db, config, 4.05, 1);
  setBalance(engine, 4.05);
  await engine.onLeaderSwap(leaderBuy(mint));
  assert.deepEqual(ex.calls, ["buy 0.2"]);
});

test("engine: a wallet that can't be read blocks new buys and changes nothing else", async () => {
  const { db, ex, mint, engine } = engineSetup();
  riskLook(db, config, 4.05, 1);
  const before = getMeta(db, "risk_state");
  setBalance(engine, null);
  await engine.onLeaderSwap(leaderBuy(mint));
  assert.equal(ex.calls.length, 0);
  assert.match((db.prepare("SELECT reason FROM copy_trades WHERE status='skipped'").get() as { reason: string }).reason, /balance can't be read/);
  assert.equal(getMeta(db, "risk_state"), before, "no anchor moves");
  assert.equal(getMeta(db, "copy_paused"), null);
});

test("engine: no fresh look, or the day's stop, means no buy; a leader's sell still goes through", async () => {
  const { db, ex, mint, engine } = engineSetup();
  setBalance(engine, 4);
  await engine.onLeaderSwap(leaderBuy(mint));
  assert.equal(ex.calls.length, 0, "no look yet");
  riskLook(db, config, 4.05, 1);
  await engine.onLeaderSwap(leaderBuy(mint));
  assert.equal(ex.calls.length, 1);
  const s = readRiskState(db)!;
  setMeta(db, "risk_state", JSON.stringify({ ...s, stoppedDay: s.day }));
  assert.ok(!effectiveLimits(db, config, 4).ok);
  await engine.onLeaderSwap({ ...leaderBuy(mint), side: "sell", tokenAmount: 1000, tokenBalanceBefore: 1000 });
  assert.match(ex.calls[1] ?? "", /^sell/, "the day's stop never holds back a sell");
});
