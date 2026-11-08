/**
 * wallet_swaps.ins_ms: when GodsEye stored a swap (epoch ms). A fresh database has the column; an old one gets it on open
 * (NULL for the rows already there); the archive keeps it and a restore puts it back as stored, NULL included.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { archiveSwapsStep, openDb, readArchivedDay, restoreDays } from "../src";

const NOW = Date.parse("2026-11-07T12:00:00.000Z");
const DAY = 86_400_000;
const cols = (db: { prepare(sql: string): { all(): unknown[] } }) => (db.prepare("PRAGMA table_info(wallet_swaps)").all() as { name: string; type: string }[]).map((c) => [c.name, c.type]);

test("a new database has wallet_swaps.ins_ms; an old one gets it on open, NULL for the rows it already had", () => {
  assert.deepEqual(cols(openDb(":memory:")).find(([n]) => n === "ins_ms"), ["ins_ms", "INTEGER"]);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ge-insms-")), "old.db");
  const old = new Database(file);
  old.exec(`CREATE TABLE wallet_swaps (id INTEGER PRIMARY KEY AUTOINCREMENT, wallet TEXT NOT NULL, signature TEXT NOT NULL, slot INTEGER NOT NULL,
    ts TEXT NOT NULL, mint TEXT NOT NULL, side TEXT NOT NULL, token_amount REAL NOT NULL, token_balance_before REAL NOT NULL DEFAULT 0,
    sol_amount REAL NOT NULL, price_sol REAL NOT NULL, venue TEXT, jito_tip INTEGER NOT NULL DEFAULT 0, fee_lamports INTEGER NOT NULL DEFAULT 0,
    token_age_sec REAL, UNIQUE (signature, wallet, mint));
    INSERT INTO wallet_swaps (wallet, signature, slot, ts, mint, side, token_amount, sol_amount, price_sol) VALUES ('W', 's1', 1, '2026-11-01T00:00:00Z', 'M', 'buy', 1, 0.5, 0.5);`);
  old.close();
  const db = openDb(file);
  assert.ok(cols(db).some(([n]) => n === "ins_ms"));
  assert.equal((db.prepare("SELECT ins_ms FROM wallet_swaps").get() as { ins_ms: number | null }).ins_ms, null);
  db.close();
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test("the archive keeps ins_ms, and a restore leaves it as stored (NULL stays NULL)", () => {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO wallets (address, first_seen_at, discovered_via, copy_weight) VALUES ('W', '2026-01-01', 't', 0)").run();
  const swap = db.prepare("INSERT INTO wallet_swaps (wallet, signature, slot, ts, mint, side, token_amount, sol_amount, price_sol, ins_ms) VALUES ('W', ?, 1, ?, 'M', 'buy', 1, 0.5, 0.5, ?)");
  const stored = NOW - 40 * DAY + 3_600_000; // stored an hour after its block time (a backfill)
  swap.run("a", new Date(NOW - 40 * DAY).toISOString(), stored);
  swap.run("b", new Date(NOW - 40 * DAY + 1000).toISOString(), null); // stored before the column existed
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ge-insms-arch-"));
  while (!archiveSwapsStep(db, { dir, hotDays: 30, junkHotDays: 0, now: NOW }).done);
  const day = new Date(NOW - 40 * DAY).toISOString().slice(0, 10);
  assert.deepEqual(readArchivedDay(dir, day).map((r) => [r.signature, r.ins_ms]), [["a", stored], ["b", null]]);
  const copy = openDb(":memory:");
  assert.equal(restoreDays(copy, dir, [day]), 2);
  assert.deepEqual(copy.prepare("SELECT signature, ins_ms FROM wallet_swaps ORDER BY signature").all(), [{ signature: "a", ins_ms: stored }, { signature: "b", ins_ms: null }]);
  fs.rmSync(dir, { recursive: true, force: true });
});
