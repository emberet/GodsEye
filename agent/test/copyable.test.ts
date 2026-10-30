import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "@godseye/shared";
import { insertSwaps } from "../src/analysis/analyze";
import { clearCopyable, copyableOf, refreshCopyable } from "../src/learning/copyable";
import { computeWeights, rawScore, type WeightInput } from "../src/learning/weights";
import type { ParsedSwap } from "../src/chain/parse";

const NOW = Date.parse("2026-10-30T12:00:00.000Z");
const DAY = 86_400_000;
let k = 0;
const swap = (wallet: string, mint: string, side: "buy" | "sell", ageMs: number): ParsedSwap => ({
  wallet, signature: `sig${++k}`, slot: k, ts: new Date(NOW - ageMs).toISOString(), mint, side, tokenAmount: 10, tokenBalanceBefore: 0, solAmount: 0.1, priceSol: 0.01,
  venue: "pumpswap", jitoTip: false, feeLamports: 5000, quote: "SOL", quoteAmount: 0.1, solUsd: null, usdAmount: null,
});

test("copyable share: pump.fun coins and screened passes count; screened blocks, other coins, sells and old buys don't", async () => {
  clearCopyable();
  const db = openDb(":memory:");
  const rug = db.prepare("INSERT INTO rug_checks (mint, symbol, verdict, blocks, warnings, rugcheck_score, checked_at) VALUES (?, 'X', ?, '[]', '[]', 0, ?)");
  rug.run("PassedMoon", "pass", new Date(NOW).toISOString());
  rug.run("RuggedPump", "blocked", new Date(NOW).toISOString());
  insertSwaps(db, [
    swap("W", "AaaPump1pump", "buy", DAY), // pump.fun, not screened: copyable
    swap("W", "PassedMoon", "buy", DAY), // screened and passed: copyable
    swap("W", "RuggedPump", "buy", DAY), // ends in "pump" but the screen blocked it
    swap("W", "LaunchedElsewhere", "buy", DAY), // not pump.fun, not screened: unlocked pool liquidity, as nearly all such coins are
    swap("W", "AaaPump1pump", "sell", DAY), // sells don't count
    swap("W", "OldPump2pump", "buy", 20 * DAY), // outside the 14 days
  ]);
  assert.equal(await refreshCopyable(db, ["W", "W"], { now: NOW }), 1);
  assert.deepEqual({ ...copyableOf("W"), at: 0 }, { buys: 4, ok: 2, at: 0 });
  assert.equal(await refreshCopyable(db, ["W"], { now: NOW + 60_000 }), 0, "kept for an hour");
  assert.equal(await refreshCopyable(db, ["W"], { now: NOW + 3_600_000 }), 1, "then measured again");
});

const base: WeightInput = { address: "W", tier: "proven", pnl7: 400, pnl30: 1500, closed30: 20, winRate30: 0.6, isFresh: false, copyPnl14: 0, copyClosed14: 0, oldWeight: 0 };
const cfg = { copyLossDropSol: 0.2, minClosed: 10, minWinRate: 0.5, minCopyableShare: 0.3 };

test("weight scales with the copyable share; below the minimum, no weight; too few buys measured, no effect", () => {
  const full = rawScore(base, cfg).weight;
  assert.ok(Math.abs(rawScore({ ...base, copyableBuys: 100, copyableOk: 50 }, cfg).weight - full * 0.5) < 1e-9);
  assert.match(rawScore({ ...base, copyableBuys: 100, copyableOk: 50 }, cfg).reason, /50% of its buys copyable/);
  assert.deepEqual(rawScore({ ...base, copyableBuys: 120, copyableOk: 24 }, cfg), {
    weight: 0,
    reason: "only 20% of its 120 buys in 14 days were coins GodsEye can copy (the rest have pool liquidity the creator can pull)",
  });
  assert.equal(rawScore({ ...base, copyableBuys: 9, copyableOk: 0 }, cfg).weight, full, "9 buys are too few to judge");
  assert.equal(rawScore({ ...base, copyableBuys: 50, copyableOk: 0 }, { ...cfg, minCopyableShare: 0 }).weight, 0, "none copyable is never worth a slot");
});

test("a copy slot goes to a wallet whose buys get copied over a bigger earner whose buys don't", () => {
  const w = computeWeights(
    [
      { ...base, address: "earner", pnl7: 4000, copyableBuys: 1100, copyableOk: 0 },
      { ...base, address: "copyable", pnl7: 900, copyableBuys: 80, copyableOk: 72 },
      { ...base, address: "middling", pnl7: 2500, copyableBuys: 200, copyableOk: 70 },
    ],
    { ...cfg, maxLeaders: 1 },
  );
  assert.equal(w.get("copyable")!.weight, 1);
  assert.equal(w.get("earner")!.weight, 0);
  assert.match(w.get("middling")!.reason, /35% of its buys copyable; not in the top 1 earners/);
});
