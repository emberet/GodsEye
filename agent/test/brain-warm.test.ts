/**
 * The warm start (brain/warm.ts): stored swaps replayed through the server's own ledger code, in block-time order on an
 * injected clock, give the rows the live stream would have written; a second run adds nothing; nothing touches real
 * trades. Made-up wallets and coins, an in-memory database, no network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, type DB } from "@godseye/shared";

const { warmLedgers } = await import("../src/brain/warm");
const { MIRROR_COST } = await import("../src/brain/ledger");

const T0 = Date.parse("2026-11-10T12:00:00Z");
const S = 1000;
let n = 0;
function stored(db: DB, wallet: string, mint: string, side: "buy" | "sell", price: number, t: number, sol = 0.1) {
  db.prepare(
    `INSERT INTO wallet_swaps (wallet, signature, slot, ts, mint, side, token_amount, token_balance_before, sol_amount, price_sol, venue, ins_ms)
     VALUES (?, ?, 1, ?, ?, ?, ?, 0, ?, ?, 'pumpswap', ?)`,
  ).run(wallet, `sig${++n}`, new Date(t).toISOString(), mint, side, sol / price, sol, price, t + 30 * S);
}

test("warm start: stored swaps give the mirror row the stream would have written, once", async () => {
  const db = openDb(":memory:");
  for (const w of ["L1", "T2", "T3", "T4", "T5"]) db.prepare("INSERT INTO wallets (address, first_seen_at, discovered_via) VALUES (?, ?, 'test')").run(w, new Date(T0 - 86_400_000).toISOString());
  stored(db, "L1", "A", "buy", 1e-6, T0, 0.5);                 // the leader's copy-eligible buy
  stored(db, "T2", "A", "buy", 1.2e-6, T0 + 20 * S);            // +20 s: the late copy's entry
  stored(db, "L1", "A", "sell", 1.5e-6, T0 + 5 * 60 * S);       // the leader sells
  stored(db, "T3", "A", "sell", 1.6e-6, T0 + 5 * 60 * S + 10 * S); // 10 s later: too early to be the exit
  stored(db, "T5", "A", "sell", 1.8e-6, T0 + 5 * 60 * S + 20 * S); // the exit
  const r = await warmLedgers(db, { fromMs: T0 - 60 * S, toMs: T0 + 3_600 * S });
  assert.equal(r.swaps, 5);
  assert.equal(r.mirrorRows, 1);
  const row = db.prepare("SELECT * FROM mirror_ledger").get() as Record<string, unknown>;
  assert.equal(row.leader, "L1");
  assert.equal(row.exit_kind, "leader_sell");
  assert.ok(Math.abs((row.y as number) - (1.8 / 1.2 - 1 - MIRROR_COST)) < 1e-9, String(row.y));
  assert.equal(row.resolved_at, new Date(T0 + 5 * 60 * S + 20 * S).toISOString(), "known when the stream would have seen the exit");
  assert.equal(row.y_quote, null, "no Jupiter quote in a replay");
  const again = await warmLedgers(db, { fromMs: T0 - 60 * S, toMs: T0 + 3_600 * S });
  assert.equal(again.mirrorRows, 0, "a second run keeps the rows it finds");
  const real = db.prepare("SELECT (SELECT COUNT(*) FROM copy_trades) + (SELECT COUNT(*) FROM positions) n").get() as { n: number };
  assert.equal(real.n, 0, "nothing touches real trades");
});
