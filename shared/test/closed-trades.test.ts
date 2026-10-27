import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db";
import { entryPriceRank, isoToEpochSec, pruneHistory, upsertClosedTrades, type ClosedTradeRow } from "../src/closed-trades";

const row = (p: Partial<ClosedTradeRow> = {}): ClosedTradeRow => ({
  wallet: "W", mint: "M", entry_slot: 1, entry_ts: 1_760_000_000, exit_ts: 1_760_000_600, entry_sol: 1, exit_sol: 1.5, pnl_sol: 0.5,
  return_pct: 50, hold_sec: 600, token_age_sec_at_entry: 120, venue_entry: "pumpfun", jito_tip_entry: 1, entry_price_sol: null, ...p,
});
const insertSwap = (db: ReturnType<typeof openDb>, sig: string, wallet: string, ts: string, price: number, mint = "M") =>
  db.prepare("INSERT INTO wallet_swaps (wallet, signature, slot, ts, mint, side, token_amount, sol_amount, price_sol) VALUES (?, ?, 1, ?, ?, 'buy', 1, ?, ?)").run(wallet, sig, ts, mint, price, price);

test("closed_trades: exact schema, unique key and indexes exist", () => {
  const db = openDb(":memory:");
  const cols = (db.prepare("PRAGMA table_info(closed_trades)").all() as { name: string; type: string; notnull: number }[]);
  const byName = Object.fromEntries(cols.map((c) => [c.name, c]));
  for (const [n, t] of Object.entries({ id: "INTEGER", wallet: "TEXT", mint: "TEXT", entry_slot: "INTEGER", entry_ts: "INTEGER", exit_ts: "INTEGER", entry_sol: "REAL", exit_sol: "REAL", pnl_sol: "REAL", return_pct: "REAL", hold_sec: "INTEGER", token_age_sec_at_entry: "INTEGER", venue_entry: "TEXT", jito_tip_entry: "REAL", entry_price_rank: "REAL" }))
    assert.equal(byName[n]?.type, t, n);
  assert.equal(byName.wallet.notnull, 1);
  assert.equal(byName.entry_ts.notnull, 1);
  const idx = (db.prepare("PRAGMA index_list(closed_trades)").all() as { name: string }[]).map((i) => i.name);
  assert.ok(idx.includes("idx_closed_trades_wallet_ts") && idx.includes("idx_closed_trades_mint_ts"));
  const swapIdx = (db.prepare("PRAGMA index_list(wallet_swaps)").all() as { name: string }[]).map((i) => i.name);
  assert.ok(swapIdx.includes("idx_swaps_mint_ts") && swapIdx.includes("idx_swaps_ts"));
});

test("upsertClosedTrades is idempotent and refreshes on the unique key", () => {
  const db = openDb(":memory:");
  upsertClosedTrades(db, [row(), row({ mint: "M2" })]);
  upsertClosedTrades(db, [row(), row({ mint: "M2" })]);
  assert.equal((db.prepare("SELECT COUNT(*) n FROM closed_trades").get() as { n: number }).n, 2);
  upsertClosedTrades(db, [row({ exit_sol: 2, pnl_sol: 1 })]);
  const r = db.prepare("SELECT pnl_sol, COUNT(*) OVER () n FROM closed_trades WHERE mint = 'M'").get() as { pnl_sol: number; n: number };
  assert.equal(r.pnl_sol, 1);
});

test("entryPriceRank: position of the entry in the observed price path, null when too thin", () => {
  const db = openDb(":memory:");
  const exit = isoToEpochSec("2026-10-20T01:00:00.000Z");
  [1, 2, 3, 4].forEach((p, i) => insertSwap(db, `s${i}`, "X", `2026-10-20T00:0${i}:00.000Z`, p));
  assert.equal(entryPriceRank(db, "M", 2, exit), null); // 4 observations < 5
  insertSwap(db, "s9", "Y", "2026-10-20T00:30:00.000Z", 5);
  insertSwap(db, "late", "Y", "2026-10-21T00:00:00.000Z", 0.1); // after exit: ignored
  assert.equal(entryPriceRank(db, "M", 1, exit), 0);
  assert.equal(entryPriceRank(db, "M", 3, exit), 0.4);
  assert.equal(entryPriceRank(db, "M", 0, exit), null);
});

test("pruneHistory keeps recent swaps, copied wallets and closed_trades", () => {
  const db = openDb(":memory:");
  const now = Date.parse("2026-10-27T00:00:00Z");
  db.prepare("INSERT INTO wallets (address, first_seen_at, discovered_via, copy_weight) VALUES ('LEAD', '2026-01-01', 't', 0.5)").run();
  insertSwap(db, "old", "W", "2026-06-01T00:00:00.000Z", 1);
  insertSwap(db, "oldLead", "LEAD", "2026-06-01T00:00:00.000Z", 1);
  insertSwap(db, "new", "W", "2026-10-20T00:00:00.000Z", 1);
  upsertClosedTrades(db, [row({ entry_ts: isoToEpochSec("2026-06-01T00:00:00Z") })]);
  db.prepare("INSERT INTO wallet_activity (address, first_seen_at, last_seen_at, swaps, buys, sells, volume_sol) VALUES ('A', '2026-01-01', '2026-01-02', 1, 1, 0, 1), ('B', '2026-10-26', '2026-10-26', 1, 1, 0, 1)").run();
  const r = pruneHistory(db, { swapsDays: 90, activityDays: 30, now });
  assert.deepEqual(r, { swaps: 1, activity: 1 });
  const sigs = (db.prepare("SELECT signature FROM wallet_swaps ORDER BY signature").all() as { signature: string }[]).map((x) => x.signature);
  assert.deepEqual(sigs, ["new", "oldLead"]);
  assert.equal((db.prepare("SELECT COUNT(*) n FROM closed_trades").get() as { n: number }).n, 1);
  assert.deepEqual(pruneHistory(db, { swapsDays: 0, activityDays: 0, now }), { swaps: 0, activity: 0 });
});
