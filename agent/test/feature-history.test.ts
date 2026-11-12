/**
 * Feature history (learning/history.ts): values kept elsewhere only as the latest are appended as they were when made.
 * Made-up wallets and coins, an in-memory database.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, QUANT_SCHEMA_SQL } from "@godseye/shared";

const { snapshotHistory } = await import("../src/learning/history");
const { saveVerdict } = await import("../src/market/rugcheck");

const rows = (db: ReturnType<typeof openDb>, kind: string) =>
  db.prepare("SELECT key, at, value FROM feature_history WHERE kind = ? ORDER BY id").all(kind) as { key: string; at: string; value: string }[];

test("each saved rug verdict is kept, not only the latest", () => {
  const db = openDb(":memory:");
  saveVerdict(db, "CoinA", "AAA", { verdict: "pass", blocks: [], warnings: ["w1"], rugcheckScore: 3 } as never, false);
  saveVerdict(db, "CoinA", "AAA", { verdict: "blocked", blocks: ["mint authority"], warnings: [], rugcheckScore: 9 } as never, false);
  const h = rows(db, "rug_check");
  assert.deepEqual(h.map((r) => [r.key, JSON.parse(r.value).verdict]), [["CoinA", "pass"], ["CoinA", "blocked"]]);
  assert.equal((db.prepare("SELECT COUNT(*) n FROM rug_checks").get() as { n: number }).n, 1, "the cache still keeps one row");
});

test("new skill verdicts are picked up once, at their own time; clusters once a day", () => {
  const db = openDb(":memory:");
  db.exec(QUANT_SCHEMA_SQL);
  const skill = db.prepare("INSERT OR REPLACE INTO wallet_skill (wallet, computed_at, n_trades, verdict) VALUES (?, ?, 30, ?)");
  skill.run("W1", 1_763_000_000, "luck");
  const now = Date.parse("2026-11-13T10:00:00Z");
  db.prepare("INSERT INTO wallets (address, first_seen_at, discovered_via, copy_weight, funder) VALUES ('W1', ?, 't', 0.3, 'F1'), ('W2', ?, 't', 0, 'F1'), ('W3', ?, 't', 0, 'F2')").run(new Date(now).toISOString(), new Date(now).toISOString(), new Date(now).toISOString());
  assert.equal(snapshotHistory(db, now), 2, "one skill verdict, one copied wallet's cluster");
  assert.equal(rows(db, "wallet_skill")[0].at, new Date(1_763_000_000_000).toISOString());
  assert.deepEqual(JSON.parse(rows(db, "cluster")[0].value), { funder: "F1", group_size: 2, copy_weight: 0.3 });
  assert.equal(snapshotHistory(db, now + 3_600_000), 0, "nothing new within the day");
  skill.run("W1", 1_763_086_400, "skill");
  assert.equal(snapshotHistory(db, now + 86_400_000), 2, "the new verdict, and the next day's cluster snapshot");
  assert.deepEqual(rows(db, "wallet_skill").map((r) => JSON.parse(r.value).verdict), ["luck", "skill"]);
});
