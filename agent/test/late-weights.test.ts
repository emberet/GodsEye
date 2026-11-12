/**
 * Late-copier weights in shadow (learning/late-weights.ts): judged by mirror-ledger outcomes, through every rule but the
 * profit ones, written next to the real weights. Made-up wallets, an in-memory database.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "@godseye/shared";
import type { WeightInput } from "../src/learning/weights";

const { lateWeights, recordLateWeights } = await import("../src/learning/late-weights");
const { ensureBrainTables } = await import("../src/brain/schema");

const cfg = { maxLeaders: 10, maxShare: 1, copyLossDropSol: 0.2, minClosed: 10, minWinRate: 0.5 };
const w = (address: string, p: Partial<WeightInput> = {}): WeightInput => ({
  address, tier: "proven", pnl7: -100, pnl30: -100, closed30: 30, winRate30: 0.6, isFresh: false, copyPnl14: 0, copyClosed14: 0, oldWeight: 0, ...p,
});

test("weights from what a late copier earned: shrunk, scaled by evidence, only wallets the other rules let through", () => {
  const db = openDb(":memory:");
  ensureBrainTables(db);
  const now = Date.parse("2026-11-13T12:00:00Z");
  const row = db.prepare("INSERT INTO mirror_ledger (leader, mint, buy_ts, buy_sig, lr, y, resolved_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  const put = (leader: string, k: number, lr: number) => {
    for (let i = 0; i < k; i++) row.run(leader, `m${leader}${i}`, new Date(now - 86_400_000).toISOString(), `s${leader}${i}`, lr, Math.expm1(lr), new Date(now - 3_600_000).toISOString(), new Date(now).toISOString());
  };
  put("GOOD", 20, 0.2);
  put("THIN", 5, 0.4);
  put("BAD", 20, -0.1);
  put("BOT", 20, 0.3);
  const inputs = [w("GOOD"), w("THIN"), w("BAD"), w("BOT", { botGate: "a bot" }), w("NONE")];
  const late = lateWeights(db, inputs, cfg, now);
  assert.equal(late.get("BAD")!.weight, 0, "a late copy of it lost");
  assert.equal(late.get("BOT")!.weight, 0, "the bot gate still applies");
  assert.equal(late.get("NONE")!.weight, 0);
  const good = (20 * 0.2) / 40; // shrunk by 20 rows, full evidence
  const thin = ((5 * 0.4) / 25) * (5 / 20);
  assert.ok(Math.abs(late.get("GOOD")!.weight - good / (good + thin)) < 1e-9);
  assert.ok(Math.abs(late.get("THIN")!.weight - thin / (good + thin)) < 1e-9);
  // Written next to the real weight, for wallets with either.
  const n = recordLateWeights(db, inputs, new Map([["BAD", { weight: 0.5, reason: "" }]]), cfg, now);
  assert.equal(n, 3);
  const bad = db.prepare("SELECT weight, late_weight, cp_n_7d FROM weight_shadow WHERE wallet = 'BAD'").get() as { weight: number; late_weight: number; cp_n_7d: number };
  assert.deepEqual(bad, { weight: 0.5, late_weight: 0, cp_n_7d: 20 });
});

test("without the brain's tables there is nothing to judge by, and no error", () => {
  const db = openDb(":memory:");
  assert.equal([...lateWeights(db, [w("A")], cfg).values()].every((v) => v.weight === 0), true);
});
