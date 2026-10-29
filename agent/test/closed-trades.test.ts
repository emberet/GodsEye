import { test } from "node:test";
import assert from "node:assert/strict";
import { getMeta, openDb } from "@godseye/shared";
import { realize } from "../src/analysis/pnl";
import { backfillClosedTrades, BACKFILL_META_KEY, closedTradeRows } from "../src/analysis/closed-trades";
import { recomputeStats } from "../src/analysis/analyze";
import { analysisRate, copyRpcRate, noteCopyRpc } from "../src/chain/rpc-budget";
import { config, STREAM_PROMOTE_MIN_CLOSED_FLOOR, STREAM_PROMOTE_PNL_FLOOR_USD } from "../src/config";
import { swap } from "./helpers";

const T0 = Date.parse("2026-10-20T00:00:00Z");
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();

test("closedTradeRows: epoch seconds, hold, SOL return, entry details from the opening buy", () => {
  const r = realize([
    swap({ ts: at(0), side: "buy", sol_amount: 1, token_amount: 100, token_age_sec: 90.4, venue: "pumpfun", jito_tip: 1, slot: 7 }),
    swap({ ts: at(5), side: "buy", sol_amount: 1, token_amount: 100, venue: "raydium" }),
    swap({ ts: at(30), side: "sell", sol_amount: 3, token_amount: 200 }),
  ], 600);
  const [row] = closedTradeRows("W", r.closed);
  assert.equal(row.entry_ts, T0 / 1000);
  assert.equal(row.exit_ts, T0 / 1000 + 1800);
  assert.equal(row.hold_sec, 1800);
  assert.equal(row.entry_sol, 2);
  assert.equal(row.exit_sol, 3);
  assert.equal(row.pnl_sol, 1);
  assert.equal(row.return_pct, 50);
  assert.equal(row.token_age_sec_at_entry, 90);
  assert.equal(row.venue_entry, "pumpfun");
  assert.equal(row.jito_tip_entry, 1);
  assert.equal(row.entry_slot, 7);
  assert.equal(row.entry_price_sol, 0.01);
});

function seed(db: ReturnType<typeof openDb>) {
  const ins = db.prepare(
    "INSERT INTO wallet_swaps (wallet, signature, slot, ts, mint, side, token_amount, sol_amount, price_sol, venue, jito_tip, token_age_sec) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'jupiter', 0, NULL)",
  );
  let n = 0;
  for (const w of ["A", "B"]) for (let k = 0; k < 3; k++) {
    const m = `M${k}`;
    ins.run(w, `${w}${n++}`, 1, at(k * 60), m, "buy", 100, 1, 0.01);
    ins.run(w, `${w}${n++}`, 2, at(k * 60 + 10), m, "sell", 100, 1 + (k - 1) * 0.5, (1 + (k - 1) * 0.5) / 100);
  }
  ins.run("A", "open1", 3, at(500), "M9", "buy", 100, 1, 0.01); // still open: no closed trade
}

test("backfill: one row per round trip, idempotent, matches realize()", () => {
  const db = openDb(":memory:");
  seed(db);
  const first = backfillClosedTrades(db, 600);
  assert.equal(first.trades, 6);
  assert.equal(first.wallets, 2);
  assert.equal(getMeta(db, BACKFILL_META_KEY), "done");
  const snap = () => db.prepare("SELECT wallet, mint, entry_ts, exit_ts, entry_sol, exit_sol, pnl_sol, return_pct, hold_sec, entry_price_rank FROM closed_trades ORDER BY wallet, mint").all();
  const before = snap();
  assert.equal(before.length, 6);
  assert.equal(backfillClosedTrades(db, 600).skipped, true);
  backfillClosedTrades(db, 600, { force: true });
  backfillClosedTrades(db, 600, { force: true });
  assert.deepEqual(snap(), before);
  const total = (db.prepare("SELECT SUM(pnl_sol) s FROM closed_trades WHERE wallet = 'A'").get() as { s: number }).s;
  assert.ok(Math.abs(total - 0) < 1e-9); // -0.5 + 0 + 0.5
});

test("analysis keeps closed_trades current incrementally", () => {
  const db = openDb(":memory:");
  seed(db);
  recomputeStats(db, "A");
  assert.equal((db.prepare("SELECT COUNT(*) n FROM closed_trades WHERE wallet = 'A'").get() as { n: number }).n, 3);
  db.prepare("INSERT INTO wallet_swaps (wallet, signature, slot, ts, mint, side, token_amount, sol_amount, price_sol) VALUES ('A', 'close9', 4, ?, 'M9', 'sell', 100, 2, 0.02)").run(at(520));
  recomputeStats(db, "A");
  recomputeStats(db, "A");
  const rows = db.prepare("SELECT mint, pnl_sol FROM closed_trades WHERE wallet = 'A' ORDER BY mint").all() as { mint: string; pnl_sol: number }[];
  assert.equal(rows.length, 4);
  assert.equal(rows.at(-1)!.mint, "M9");
  assert.equal(rows.at(-1)!.pnl_sol, 1);
});

test("RPC guard: analysis leaves the copy reserve and yields to copy bursts", () => {
  assert.equal(analysisRate(75, 0.2, 0), 60);
  assert.equal(analysisRate(75, 0.2, 15), 60); // within the reserve
  assert.equal(analysisRate(75, 0.2, 35), 40); // 20 over the reserve comes out of analysis
  assert.equal(analysisRate(75, 0.2, 1000), 1); // never fully starved
  const now = 5_000_500;
  noteCopyRpc(3, now);
  noteCopyRpc(2, now + 100);
  assert.equal(copyRpcRate(now + 200), 5);
  assert.equal(copyRpcRate(now + 1000), 5); // previous second still counts
  assert.equal(copyRpcRate(now + 5000), 0);
});

test("wider discovery defaults, bounded by the unchanged RPC cap and promotion floors", () => {
  assert.equal(config.discoverPools, 40);
  assert.equal(config.discoverMaxNewPerRun, 100);
  assert.equal(config.analyzePerRun, 90);
  assert.equal(config.analyzeConcurrency, 12);
  assert.equal(config.rpcMaxRps, 75);
  assert.equal(config.rpcCopyReserve, 0.2);
  assert.equal(config.streamPromotePnlUsd, 50);
  assert.equal(config.streamPromoteMinClosed, 2);
  assert.ok(config.streamPromotePnlUsd >= STREAM_PROMOTE_PNL_FLOOR_USD && config.streamPromoteMinClosed >= STREAM_PROMOTE_MIN_CLOSED_FLOOR);
  assert.equal(config.copyMode, "paper"); // the test env sets paper; the code default stays "real"
});

test("background backfill: slices resume where the last one stopped and end up the same as the one-shot run", async () => {
  const { backfillClosedTradesStep } = await import("../src/analysis/closed-trades");
  const snap = (db: ReturnType<typeof openDb>) => db.prepare("SELECT * FROM closed_trades ORDER BY wallet, mint").all();
  const oneShot = openDb(":memory:");
  seed(oneShot);
  backfillClosedTrades(oneShot, 600);
  const db = openDb(":memory:");
  seed(db);
  let t = 0;
  const clock = () => (t += 10); // every wallet "takes" longer than the 5 ms budget: one wallet per slice
  const steps = [];
  for (let i = 0; i < 10; i++) {
    const r = backfillClosedTradesStep(db, 600, 5, clock);
    steps.push(r);
    if (r.done) break;
  }
  assert.deepEqual(steps.map((r) => [r.wallets, r.done]), [[1, false], [1, false], [0, true]]);
  assert.equal(getMeta(db, BACKFILL_META_KEY), "done");
  assert.deepEqual(snap(db), snap(oneShot));
  assert.deepEqual(backfillClosedTradesStep(db, 600, 5, clock), { done: true, wallets: 0, trades: 0 });
});
