import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { archivedDays, archiveSwapsStep, openDb, readArchivedDay, restoreDays } from "../src";

const NOW = Date.parse("2026-10-30T12:00:00.000Z");
const DAY = 86_400_000;

function setup() {
  const db = openDb(":memory:");
  const wallet = db.prepare("INSERT INTO wallets (address, first_seen_at, discovered_via, copy_weight, junk_reason) VALUES (?, '2026-01-01', 't', ?, ?)");
  wallet.run("NORMAL", 0, null);
  wallet.run("BOT", 0, "bot: median hold 3 s");
  wallet.run("LEADER", 0.4, null);
  wallet.run("HOLDER", 0, null);
  db.prepare("INSERT INTO positions (mint, symbol, leader, mode, status, token_amount, tokens_bought, cost_sol, entry_price_sol, opened_at) VALUES ('M', 'M', 'HOLDER', 'real', 'open', 1, 1, 0.1, 0.1, ?)").run(new Date(NOW).toISOString());
  const swap = db.prepare(
    "INSERT INTO wallet_swaps (wallet, signature, slot, ts, mint, side, token_amount, sol_amount, price_sol, venue, usd_amount) VALUES (?, ?, 1, ?, 'M', 'buy', 10, 0.1, 0.01, 'pumpswap', 19.5)",
  );
  let k = 0;
  for (const w of ["NORMAL", "BOT", "LEADER", "HOLDER"]) for (const age of [40, 31, 20, 8, 2]) swap.run(w, `${w}-${age}-${++k}`, new Date(NOW - age * DAY).toISOString());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ge-archive-"));
  return { db, dir };
}

const left = (db: ReturnType<typeof openDb>, wallet: string) =>
  (db.prepare("SELECT ts FROM wallet_swaps WHERE wallet = ? ORDER BY ts").all(wallet) as { ts: string }[]).map((r) => Math.round((NOW - Date.parse(r.ts)) / DAY));

test("archive: past the hot window everyone's swaps move out, junk wallets' sooner; copied and held wallets keep everything", () => {
  const { db, dir } = setup();
  let steps = 0;
  while (!archiveSwapsStep(db, { dir, hotDays: 30, junkHotDays: 7, batch: 2, now: NOW }).done) steps++;
  assert.ok(steps > 1, "worked in slices");
  assert.deepEqual(left(db, "NORMAL"), [20, 8, 2]);
  assert.deepEqual(left(db, "BOT"), [2]);
  assert.deepEqual(left(db, "LEADER"), [40, 31, 20, 8, 2]);
  assert.deepEqual(left(db, "HOLDER"), [40, 31, 20, 8, 2]);
  const days = archivedDays(dir).map((d) => d.day);
  assert.deepEqual(days, ["2026-09-20", "2026-09-29", "2026-10-10", "2026-10-22"]);
  const rows = days.flatMap((d) => readArchivedDay(dir, d));
  assert.equal(rows.length, 6, "NORMAL at 40 and 31 days, BOT at 40, 31, 20 and 8");
});

test("archive: restore puts every column back and skips duplicates from an interrupted step", () => {
  const { db, dir } = setup();
  while (!archiveSwapsStep(db, { dir, hotDays: 30, junkHotDays: 7, now: NOW }).done);
  const archived = archivedDays(dir).flatMap((d) => readArchivedDay(dir, d.day));
  const copy = openDb(":memory:");
  const days = archivedDays(dir).map((d) => d.day);
  assert.equal(restoreDays(copy, dir, days), archived.length);
  assert.equal(restoreDays(copy, dir, days), 0, "a second restore adds nothing");
  const back = copy.prepare("SELECT wallet, signature, ts, venue, usd_amount FROM wallet_swaps ORDER BY signature").all();
  assert.deepEqual(back, archived.map((r) => ({ wallet: r.wallet, signature: r.signature, ts: r.ts, venue: r.venue, usd_amount: r.usd_amount })).sort((a, b) => String(a.signature).localeCompare(String(b.signature))));
});
