import { test } from "node:test";
import assert from "node:assert/strict";
import { computeWeights, copySize, type WeightInput } from "../src/learning/weights";

const base: Omit<WeightInput, "address"> = { tier: "proven", pnl7: 2, pnl30: 6, closed30: 20, winRate30: 0.6, isFresh: false, copyPnl14: 0, copyClosed14: 0, oldWeight: 0 };
const cfg = { maxLeaders: 3, copyLossDropSol: 0.2 };

test("weights go to whoever is making money, and add up to 1", () => {
  const w = computeWeights(
    [
      { ...base, address: "big", pnl7: 9 },
      { ...base, address: "small", pnl7: 1 },
      { ...base, address: "loser", pnl7: -1 },
    ],
    cfg,
  );
  assert.ok(w.get("big")!.weight > w.get("small")!.weight);
  assert.equal(w.get("loser")!.weight, 0);
  assert.match(w.get("loser")!.reason, /not making money/);
  const sum = [...w.values()].reduce((s, x) => s + x.weight, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9);
});

test("a leader that turns unprofitable is dropped immediately, even with a high old weight", () => {
  const w = computeWeights([{ ...base, address: "a", pnl7: -0.01, oldWeight: 0.9 }, { ...base, address: "b" }], cfg);
  assert.equal(w.get("a")!.weight, 0);
  assert.equal(w.get("b")!.weight, 1);
});

test("GodsEye learns from its own copies: a winning wallet whose copies lose is dropped", () => {
  const w = computeWeights([{ ...base, address: "uncopyable", pnl7: 20, copyPnl14: -0.5, copyClosed14: 4 }, { ...base, address: "ok" }], cfg);
  assert.equal(w.get("uncopyable")!.weight, 0);
  assert.match(w.get("uncopyable")!.reason, /GodsEye's copies/);
});

test("only the top N earners are copied; quitters never", () => {
  const inputs = ["a", "b", "c", "d", "e"].map((a, i) => ({ ...base, address: a, pnl7: 10 - i }));
  inputs.push({ ...base, address: "q", tier: "quitter", pnl7: 50 });
  const w = computeWeights(inputs, cfg);
  assert.deepEqual([...w.entries()].filter(([, v]) => v.weight > 0).map(([k]) => k).sort(), ["a", "b", "c"]);
  assert.match(w.get("d")!.reason, /not in the top 3/);
});

test("weights move halfway toward the new target (no whiplash)", () => {
  const w = computeWeights([{ ...base, address: "a", oldWeight: 0.1 }, { ...base, address: "b", oldWeight: 0.9 }], cfg);
  // equal targets 0.5/0.5 → smoothed 0.3/0.7
  assert.ok(Math.abs(w.get("a")!.weight - 0.3) < 1e-9);
});

test("copy size follows weight within the min/max", () => {
  const c = { copyBudgetSol: 1, copyMinTradeSol: 0.01, copyMaxTradeSol: 0.1 };
  assert.equal(copySize(0.05, c), 0.05);
  assert.equal(copySize(0.5, c), 0.1);
  assert.equal(copySize(0.005, c), 0);
});
