/**
 * Proof-ledger integrity (property tests), database migrations, the read-only website connection and
 * the public API's input handling.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { openDb, openDbReadonly } from "../src/db";
import { canonicalJson, commitProof, verifyProofChain, type ProofEntry } from "../src/proof";
import { getProof } from "../src/dashboard-data";
import { intParam } from "../../dashboard/lib/params";

const ledger = (n: number) => {
  const db = openDb(":memory:");
  for (let i = 0; i < n; i++) commitProof(db, i % 2 ? "copy_sell" : "copy_buy", { i, mint: `M${i}`, size_sol: i / 10 });
  return db.prepare("SELECT * FROM proof_ledger ORDER BY id").all() as ProofEntry[];
};

test("property: the same data hashes the same whatever order its keys are in", () => {
  fc.assert(
    fc.property(fc.dictionary(fc.string({ maxLength: 8 }), fc.oneof(fc.integer(), fc.string(), fc.boolean(), fc.constant(null))), (obj) => {
      const reversed = Object.fromEntries(Object.entries(obj).reverse());
      assert.equal(canonicalJson(obj), canonicalJson(reversed));
    }),
  );
});

test("property: changing any field of any entry, deleting or reordering entries breaks the chain", () => {
  const entries = ledger(8);
  assert.equal(verifyProofChain(entries).ok, true);
  fc.assert(
    fc.property(fc.integer({ min: 0, max: 7 }), fc.constantFrom("payload", "prev_hash", "hash"), fc.string({ minLength: 1, maxLength: 5 }), (i, field, junk) => {
      const copy = entries.map((e) => ({ ...e }));
      (copy[i] as unknown as Record<string, string>)[field] += junk;
      const v = verifyProofChain(copy);
      assert.equal(v.ok, false);
      assert.ok(v.brokenAtId !== undefined && v.brokenAtId <= copy[Math.min(7, i + 1)].id);
    }),
  );
  for (let i = 0; i < 7; i++) {
    assert.equal(verifyProofChain(entries.filter((_, j) => j !== i)).ok, false, `deleting entry ${i + 1}`);
    const swapped = [...entries];
    [swapped[i], swapped[i + 1]] = [swapped[i + 1], swapped[i]];
    assert.equal(verifyProofChain(swapped).ok, false, `swapping entries ${i + 1} and ${i + 2}`);
  }
  // Known limit: without an outside anchor, dropping the newest entries leaves a valid (shorter) chain.
  assert.equal(verifyProofChain(entries.slice(0, 5)).ok, true);
});

test("proof API: page sizes are clamped and nonsense never reaches SQL", () => {
  const db = openDb(":memory:");
  for (let i = 0; i < 3; i++) commitProof(db, "copy_buy", { i });
  assert.equal(getProof(db, NaN, NaN).entries.length, 3);
  assert.equal(getProof(db, 1e9, -5).entries.length, 3);
  assert.equal(getProof(db, 2, 0).entries.length, 2);
  assert.equal(getProof(db, 50, 0).chain.ok, true);
  assert.equal(intParam("abc", 50, 1, 200), 50);
  assert.equal(intParam("", 50, 1, 200), 50);
  assert.equal(intParam(null, 50, 1, 200), 50);
  assert.equal(intParam("1e9", 50, 1, 200), 200);
  assert.equal(intParam("-3", 0, 0, 1000), 0);
  assert.equal(intParam("12.9", 0, 0, 1000), 12);
  assert.equal(intParam("Infinity", 7, 0, 10), 7);
});

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "godseye-mig-")), "test.db");

test("migrations: an older database gains every new column and its one-time fix, and reopening is a no-op", () => {
  const file = tmpFile();
  let db = openDb(file);
  db.prepare("INSERT INTO smart_flows (signature, wallet, mint, side, usd, price_usd, ts) VALUES ('s', 'w', 'm', 'buy', 1, 1, '2026-01-01')").run();
  db.prepare("UPDATE smart_flows SET ret_1h = 5e9").run();
  // Make it look like a database from before these columns existed.
  for (const [table, col] of [["positions", "fee_sol"], ["copy_trades", "fee_sol"], ["smart_flows", "returns_cleaned"], ["token_info", "launch_checked_at"]]) db.exec(`ALTER TABLE ${table} DROP COLUMN ${col}`);
  db.close();

  db = openDb(file);
  const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
  assert.ok(cols("positions").includes("fee_sol"));
  assert.ok(cols("copy_trades").includes("fee_sol"));
  assert.ok(cols("token_info").includes("launch_checked_at"));
  assert.equal((db.prepare("SELECT ret_1h FROM smart_flows").get() as { ret_1h: number | null }).ret_1h, null, "impossible returns cleared once");
  db.prepare("UPDATE smart_flows SET ret_1h = 5e9").run();
  const before = cols("positions").length;
  db.close();

  db = openDb(file);
  assert.equal(cols("positions").length, before);
  assert.equal((db.prepare("SELECT ret_1h FROM smart_flows").get() as { ret_1h: number }).ret_1h, 5e9, "the one-time fix doesn't run again");
  db.close();
});

test("the website's connection is read-only, and tests can't open a database outside the temp folder", () => {
  const file = tmpFile();
  openDb(file).close();
  const ro = openDbReadonly(file);
  assert.throws(() => ro.prepare("INSERT INTO agent_meta (key, value, updated_at) VALUES ('x', 'y', '')").run(), /readonly/i);
  ro.close();
  assert.throws(() => openDbReadonly(path.join(os.tmpdir(), "does-not-exist", "x.db")));
  assert.throws(() => openDb(path.join(process.cwd(), "data", "godseye.db")), /outside the temp folder/);
});
