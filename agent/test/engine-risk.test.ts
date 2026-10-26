/**
 * Copy-engine risk limits, failure handling, fees and crash recovery. Synthetic data, an in-memory
 * database and a fake executor: nothing here signs or sends a transaction.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { dataPath, openDb, type DB } from "@godseye/shared";
import type { ParsedSwap } from "../src/chain/parse";
import type { Executor, Fill } from "../src/copy/executor";

process.env.COPY_BUDGET_SOL = "1";
process.env.COPY_MAX_TRADE_SOL = "0.1";
process.env.COPY_MAX_POSITIONS = "3";
process.env.COPY_DAILY_LOSS_LIMIT_SOL = "0.5";
const { CopyEngine, isPaused } = await import("../src/copy/engine");
const { recoverPending, reconcile } = await import("../src/copy/recovery");
const { RealExecutor } = await import("../src/copy/executor");
const { getCopies, getSummary } = await import("@godseye/shared/dashboard-data");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();
let n = 0;
const mint = () => `Mint${String(++n).padStart(39, "1")}`;

/** A paper executor that takes a little time (so concurrent buys really overlap) and can be told to fail. */
class SlowExecutor implements Executor {
  mode: "real" | "paper" = "paper";
  calls: string[] = [];
  failBuy: string | null = null;
  failSell: string | null = null;
  feeSol: number | undefined = undefined;
  constructor(private delayMs = 20) {}
  async buy(m: string, sol: number): Promise<Fill> {
    this.calls.push(`buy ${m} ${sol}`);
    await sleep(this.delayMs);
    if (this.failBuy) throw new Error(this.failBuy);
    return { signature: null, solAmount: sol, tokenAmount: sol * 1000, priceSol: 0.001, feeSol: this.feeSol };
  }
  async sell(m: string, tokens: number): Promise<Fill> {
    this.calls.push(`sell ${m} ${tokens}`);
    await sleep(this.delayMs);
    if (this.failSell) throw new Error(this.failSell);
    return { signature: null, solAmount: tokens * 0.002, tokenAmount: tokens, priceSol: 0.002, feeSol: this.feeSol };
  }
}

function setup(opts: { weight?: number; mode?: "real" | "paper"; delayMs?: number } = {}) {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO wallets (address, first_seen_at, discovered_via, copy_weight) VALUES ('LEADER', ?, 'test', ?)").run(now(), opts.weight ?? 0.5);
  const ex = new SlowExecutor(opts.delayMs);
  ex.mode = opts.mode ?? "paper";
  return { db, ex, engine: new CopyEngine(db, ex, null) };
}
function token(db: DB, m = mint(), symbol = "MOO"): string {
  db.prepare("INSERT INTO token_info (mint, symbol, decimals, pool_created_at, checked_at) VALUES (?, ?, 6, '2026-01-01T00:00:00Z', ?)").run(m, symbol, now());
  return m;
}
const swap = (p: Partial<ParsedSwap>): ParsedSwap => ({
  wallet: "LEADER", signature: `sig${Math.random()}`, slot: 1, ts: now(), mint: "", side: "buy",
  tokenAmount: 1000, tokenBalanceBefore: 0, solAmount: 1, priceSol: 0.001, venue: "jupiter", jitoTip: false, feeLamports: 5000, quote: "SOL", quoteAmount: 1, solUsd: null, usdAmount: null, ...p,
});
const count = (db: DB, sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as { n: number }).n;
function openPosition(db: DB, o: { mint?: string; mode: "real" | "paper"; cost?: number; tokens?: number }) {
  db.prepare(
    `INSERT INTO positions (mint, symbol, leader, mode, status, token_amount, tokens_bought, cost_sol, entry_price_sol, opened_at)
     VALUES (?, 'X', 'LEADER', ?, 'open', ?, ?, ?, 0.001, ?)`,
  ).run(o.mint ?? mint(), o.mode, o.tokens ?? 100, o.tokens ?? 100, o.cost ?? 0.1, now());
}

test("limits: many simultaneous buys of different coins never exceed max positions", async () => {
  const { db, ex, engine } = setup({ delayMs: 30 });
  const mints = Array.from({ length: 10 }, () => token(db));
  await Promise.all(mints.map((m) => engine.onLeaderSwap(swap({ mint: m }))));
  assert.equal(ex.calls.length, 3, ex.calls.join("\n"));
  assert.equal(count(db, "SELECT COUNT(*) n FROM positions WHERE status='open'"), 3);
});

test("limits: in-flight buys count against the budget", async () => {
  process.env.COPY_MAX_POSITIONS = "3";
  const { db, ex, engine } = setup({ weight: 1, delayMs: 30 });
  // 0.895 SOL of the 1 SOL budget is already in open positions: room for one more 0.1 buy, not two.
  openPosition(db, { mode: "paper", cost: 0.895 });
  const [a, b] = [token(db), token(db)];
  await Promise.all([engine.onLeaderSwap(swap({ mint: a })), engine.onLeaderSwap(swap({ mint: b }))]);
  assert.equal(ex.calls.length, 1, ex.calls.join("\n"));
  const spent = (db.prepare("SELECT SUM(cost_sol) s FROM positions WHERE status='open'").get() as { s: number }).s;
  assert.ok(spent <= 1 + 1e-9, `budget overshot: ${spent}`);
});

test("limits: only the current mode counts (real positions don't block paper copies, and the other way round)", async () => {
  const { db, ex, engine } = setup();
  for (let i = 0; i < 3; i++) openPosition(db, { mode: "real", cost: 0.4 });
  db.prepare("INSERT INTO positions (mint, leader, mode, status, token_amount, tokens_bought, cost_sol, entry_price_sol, opened_at, closed_at, pnl_sol) VALUES (?, 'LEADER', 'real', 'closed', 0, 1, 1, 1, ?, ?, -5)").run(mint(), now(), now());
  await engine.onLeaderSwap(swap({ mint: token(db) }));
  assert.equal(ex.calls.length, 1, "real positions and real losses must not limit paper copying");
});

test("limits: the daily loss limit stops new buys but never sells", async () => {
  const { db, ex, engine } = setup();
  const held = token(db);
  await engine.onLeaderSwap(swap({ mint: held }));
  assert.equal(ex.calls.length, 1);
  db.prepare("INSERT INTO positions (mint, leader, mode, status, token_amount, tokens_bought, cost_sol, entry_price_sol, opened_at, closed_at, pnl_sol) VALUES (?, 'LEADER', 'paper', 'closed', 0, 1, 1, 1, ?, ?, -0.6)").run(mint(), now(), now());
  await engine.onLeaderSwap(swap({ mint: token(db) }));
  assert.equal(ex.calls.length, 1, "no buy after the loss limit");
  assert.match((db.prepare("SELECT reason FROM copy_trades WHERE status='skipped'").get() as { reason: string }).reason, /daily loss limit/);
  await engine.onLeaderSwap(swap({ mint: held, side: "sell", tokenAmount: 1000, tokenBalanceBefore: 1000 }));
  assert.match(ex.calls[1], /^sell/, "the leader's sell is still mirrored");
  assert.equal(count(db, "SELECT COUNT(*) n FROM positions WHERE mint=? AND status='closed'", held), 1);
});

test("pause: the data/PAUSE file stops buys (in the test's own temp folder)", async () => {
  const { db, ex, engine } = setup();
  const file = dataPath("PAUSE");
  assert.ok(file.startsWith(process.env.GODSEYE_ROOT!), "tests must never write the real data folder");
  fs.writeFileSync(file, "");
  try {
    assert.equal(isPaused(db), true);
    await engine.onLeaderSwap(swap({ mint: token(db) }));
    assert.equal(ex.calls.length, 0);
  } finally {
    fs.rmSync(file);
  }
  assert.equal(isPaused(db), false);
});

test("failed swap: the copy is marked failed, no position is opened, and the error is redacted publicly", async () => {
  const { db, ex, engine } = setup();
  ex.failBuy = "fetch failed https://rpc.example.com/?api-key=SECRET123 from 203.0.113.9";
  await engine.onLeaderSwap(swap({ mint: token(db) }));
  assert.equal(count(db, "SELECT COUNT(*) n FROM positions"), 0);
  const row = db.prepare("SELECT status, error FROM copy_trades").get() as { status: string; error: string };
  assert.equal(row.status, "failed");
  db.prepare("INSERT INTO agent_meta (key, value, updated_at) VALUES ('copy_mode', 'paper', '')").run();
  const shown = getCopies(db).trades[0].error!;
  assert.doesNotMatch(shown, /SECRET123|203\.0\.113\.9/);
});

test("failed sell: the position stays open and the failure is recorded", async () => {
  const { db, ex, engine } = setup();
  const m = token(db);
  await engine.onLeaderSwap(swap({ mint: m }));
  ex.failSell = "slippage";
  await engine.onLeaderSwap(swap({ mint: m, side: "sell", tokenAmount: 1000, tokenBalanceBefore: 1000 }));
  assert.equal(count(db, "SELECT COUNT(*) n FROM positions WHERE status='open'"), 1);
  assert.equal(count(db, "SELECT COUNT(*) n FROM copy_trades WHERE side='sell' AND status='failed'"), 1);
});

test("fees: recorded on both legs and taken out of P&L", async () => {
  const { db, ex, engine } = setup();
  ex.feeSol = 0.001;
  const m = token(db);
  await engine.onLeaderSwap(swap({ mint: m }));
  await engine.onLeaderSwap(swap({ mint: m, side: "sell", tokenAmount: 1000, tokenBalanceBefore: 1000 }));
  const p = db.prepare("SELECT fee_sol, pnl_sol, cost_sol, proceeds_sol FROM positions").get() as { fee_sol: number; pnl_sol: number; cost_sol: number; proceeds_sol: number };
  assert.ok(Math.abs(p.fee_sol - 0.002) < 1e-12);
  assert.ok(Math.abs(p.pnl_sol - (p.proceeds_sol - p.cost_sol - 0.002)) < 1e-12, `pnl ${p.pnl_sol}`);
  assert.equal(count(db, "SELECT COUNT(*) n FROM copy_trades WHERE fee_sol = 0.001"), 2);
});

test("fees: a position whose buy fee wasn't recorded stays 'not recorded' instead of half-counted", async () => {
  const { db, ex, engine } = setup();
  const m = token(db);
  await engine.onLeaderSwap(swap({ mint: m })); // no fee on the buy
  ex.feeSol = 0.001;
  await engine.onLeaderSwap(swap({ mint: m, side: "sell", tokenAmount: 1000, tokenBalanceBefore: 1000 }));
  const p = db.prepare("SELECT fee_sol, pnl_sol FROM positions").get() as { fee_sol: number | null; pnl_sol: number };
  assert.equal(p.fee_sol, null);
  assert.ok(Math.abs(p.pnl_sol - 0.1) < 1e-12);
});

test("duplicates: a repeated leader trade adds no copy, no position and no proof entry", async () => {
  const { db, ex, engine } = setup();
  const s = swap({ mint: token(db) });
  await engine.onLeaderSwap(s);
  await engine.onLeaderSwap(s);
  await Promise.all([engine.onLeaderSwap(s), engine.onLeaderSwap(s)]);
  assert.equal(ex.calls.length, 1);
  assert.equal(count(db, "SELECT COUNT(*) n FROM proof_ledger"), 1);
  assert.equal(count(db, "SELECT COUNT(*) n FROM wallet_swaps"), 1);
});

test("real money is unreachable from tests: RealExecutor refuses to be built", () => {
  assert.throws(() => new RealExecutor({} as never), /never build a real executor/);
});

function pending(db: DB, o: { side?: "buy" | "sell"; mode?: "real" | "paper"; created?: string; m?: string }) {
  const m = o.m ?? mint();
  db.prepare(
    `INSERT INTO copy_trades (leader, leader_signature, leader_ts, mint, symbol, side, mode, status, size_sol, created_at)
     VALUES ('LEADER', ?, ?, ?, 'X', ?, ?, 'pending', 0.1, ?)`,
  ).run(`sig${Math.random()}`, now(), m, o.side ?? "buy", o.mode ?? "real", o.created ?? "2026-01-01T00:00:00.000Z");
  return m;
}

test("recovery: interrupted buys become positions only when the wallet holds the coin", async () => {
  const db = openDb(":memory:");
  const landed = pending(db, {});
  const missing = pending(db, {});
  const unreadable = pending(db, {});
  pending(db, { mode: "paper" });
  pending(db, { side: "sell" });
  const fresh = pending(db, { created: "2099-01-01T00:00:00.000Z" }); // still in flight: not touched
  const held = async (m: string) => (m === landed ? 100 : m === missing ? 0 : m === unreadable ? null : 0);
  const r = await recoverPending(db, { before: "2026-06-01T00:00:00.000Z", held });
  assert.deepEqual(r, { opened: 1, failed: 3, left: 1 });
  const pos = db.prepare("SELECT mint, token_amount, cost_sol, fee_sol FROM positions").all() as { mint: string; token_amount: number; cost_sol: number; fee_sol: null }[];
  assert.deepEqual(pos, [{ mint: landed, token_amount: 100, cost_sol: 0.1, fee_sol: null }]);
  assert.equal((db.prepare("SELECT status FROM copy_trades WHERE mint=?").get(fresh) as { status: string }).status, "pending");
  assert.equal((db.prepare("SELECT status FROM copy_trades WHERE mint=?").get(unreadable) as { status: string }).status, "pending");
  // Running it again changes nothing that was already settled.
  const again = await recoverPending(db, { before: "2026-06-01T00:00:00.000Z", held });
  assert.deepEqual(again, { opened: 0, failed: 0, left: 1 });
  assert.equal(count(db, "SELECT COUNT(*) n FROM positions"), 1);
});

test("reconcile: reports positions that don't match the wallet, changes nothing", async () => {
  const db = openDb(":memory:");
  const a = mint();
  const b = mint();
  openPosition(db, { mint: a, mode: "real", tokens: 100 });
  openPosition(db, { mint: b, mode: "real", tokens: 100 });
  const off = await reconcile(db, async (m) => (m === a ? 50 : 100));
  assert.deepEqual(off, [{ mint: a, recorded: 100, held: 50 }]);
  assert.equal(count(db, "SELECT COUNT(*) n FROM positions WHERE status='open'"), 2);
});

test("dashboard money: paper and real never mix, unknown dollars stay unknown, win rate is 0–1", () => {
  const db = openDb(":memory:");
  const close = (mode: string, pnlSol: number, pnlUsd: number | null, fee: number | null = null) =>
    db.prepare("INSERT INTO positions (mint, leader, mode, status, token_amount, tokens_bought, cost_sol, entry_price_sol, opened_at, closed_at, pnl_sol, pnl_usd, fee_sol) VALUES (?, 'L', ?, 'closed', 0, 1, 1, 1, ?, ?, ?, ?, ?)")
      .run(mint(), mode, now(), now(), pnlSol, pnlUsd, fee);
  close("real", 1, 150, 0.01);
  close("real", -0.5, -75, null);
  close("paper", 10, 1500);
  db.prepare("INSERT INTO agent_meta (key, value, updated_at) VALUES ('copy_mode', 'real', '')").run();
  let s = getSummary(db);
  assert.equal(s.copyMode, "real");
  assert.equal(s.closedPositions, 2);
  assert.equal(s.realizedPnlSol, 0.5);
  assert.equal(s.realizedPnlUsd, 75);
  assert.equal(s.winRate, 0.5);
  assert.equal(s.feesSol, 0.01);
  assert.equal(s.feesUnrecorded, 1);
  // A trade with no dollar value and no SOL price: the dollar total is unknown, not a smaller number.
  close("real", 0.2, null);
  s = getSummary(db);
  assert.equal(s.realizedPnlUsd, null);
  assert.equal(s.realizedPnlSol, 0.7);
  db.prepare("UPDATE agent_meta SET value='paper' WHERE key='copy_mode'").run();
  s = getSummary(db);
  assert.equal(s.closedPositions, 1);
  assert.equal(s.realizedPnlUsd, 1500);
  assert.equal(s.feesUnrecorded, 0);
  db.prepare("DELETE FROM agent_meta WHERE key='copy_mode'").run();
  assert.equal(getSummary(db).copyMode, null, "an unreported mode is never claimed as real money");
});

test("dashboard stream: green only when connected, live and recently fed", () => {
  const db = openDb(":memory:");
  const meta = (k: string, v: string) => db.prepare("INSERT OR REPLACE INTO agent_meta (key, value, updated_at) VALUES (?, ?, '')").run(k, v);
  meta("heartbeat", now());
  meta("agent_status", "live");
  meta("stream_status", "connected");
  meta("stream_last_at", now());
  assert.equal(getSummary(db).stream.healthy, true);
  meta("stream_last_at", new Date(Date.now() - 5 * 60_000).toISOString());
  assert.equal(getSummary(db).stream.healthy, false, "connected but silent");
  meta("stream_last_at", now());
  meta("heartbeat", new Date(Date.now() - 60 * 60_000).toISOString());
  assert.equal(getSummary(db).stream.healthy, false, "agent dead, status left at connected");
  meta("heartbeat", now());
  meta("stream_status", "stopped");
  assert.equal(getSummary(db).stream.healthy, false);
});
