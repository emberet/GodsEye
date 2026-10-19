import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { openDb } from "../src/db";

test("migration: history_from is backfilled from stored swaps and old 30-day wording is fixed", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const file = join(mkdtempSync(join(tmpdir(), "ge-")), "t.db");
  // An older database: no history_from column yet.
  const db = openDb(file);
  db.close();
  const raw = new Database(file);
  raw.exec("ALTER TABLE wallets DROP COLUMN history_from");
  raw.prepare("INSERT INTO wallets (address, first_seen_at, discovered_via, tier, tier_reason, last_analyzed_at) VALUES ('W', '2026-10-19T00:00:00Z', 'test', 'unrated', 'Only 2 closed trades in 30 days', '2026-10-19T00:00:00Z')").run();
  raw.prepare(
    "INSERT INTO wallet_swaps (wallet, signature, slot, ts, mint, side, token_amount, token_balance_before, sol_amount, price_sol, jito_tip, fee_lamports) VALUES ('W', 's1', 1, '2026-10-18T05:00:00.000Z', 'M', 'buy', 1, 0, 1, 1, 0, 5000), ('W', 's2', 2, '2026-10-18T09:00:00.000Z', 'M', 'sell', 1, 1, 2, 2, 0, 5000)",
  ).run();
  raw.close();
  const again = openDb(file);
  const w = again.prepare("SELECT history_from, tier_reason FROM wallets WHERE address = 'W'").get() as { history_from: string; tier_reason: string };
  assert.equal(w.history_from, "2026-10-18T05:00:00.000Z");
  assert.equal(w.tier_reason, "Only 2 closed trades seen so far");
  again.close();
});
