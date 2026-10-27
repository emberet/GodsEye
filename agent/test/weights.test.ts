import { test } from "node:test";
import assert from "node:assert/strict";
import { computeWeights, copySize, rawScore, type WeightInput } from "../src/learning/weights";

const base: Omit<WeightInput, "address"> = { tier: "proven", pnl7: 2, pnl30: 6, closed30: 20, winRate30: 0.6, isFresh: false, copyPnl14: 0, copyClosed14: 0, oldWeight: 0 };
const cfg = { maxLeaders: 3, copyLossDropSol: 0.2, minClosed: 10, minWinRate: 0.5 };

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

test("only wallets with a track record are copied: no lucky streaks, no thin histories", () => {
  const w = computeWeights(
    [
      { ...base, address: "lucky", tier: "lucky_streak", pnl7: 50, closed30: 7 },
      { ...base, address: "thin", tier: "unrated", pnl7: 30, closed30: 6 },
      { ...base, address: "busy", tier: "insider", pnl7: 3, closed30: 25 }, // enough trades, not Proven: allowed
      { ...base, address: "proven", tier: "proven", pnl7: 2, closed30: 8 }, // Proven is always allowed
    ],
    cfg,
  );
  assert.equal(w.get("lucky")!.weight, 0);
  assert.match(w.get("lucky")!.reason, /lucky streak/);
  assert.equal(w.get("thin")!.weight, 0);
  assert.match(w.get("thin")!.reason, /only 6 closed trades seen so far \(10 needed/);
  assert.ok(w.get("busy")!.weight > 0);
  assert.ok(w.get("proven")!.weight > 0);
});

test("a copied wallet that becomes a lucky streak is dropped at once", () => {
  const w = computeWeights([{ ...base, address: "a", tier: "lucky_streak", oldWeight: 1 }, { ...base, address: "b" }], cfg);
  assert.equal(w.get("a")!.weight, 0);
  assert.equal(w.get("b")!.weight, 1);
});

test("learned lead score scales copy weight: wallets whose buys lead price get more", () => {
  const w = computeWeights(
    [
      { ...base, address: "leads", leadN: 20, leadMedian6h: 40 },
      { ...base, address: "plain" },
      { ...base, address: "tops", leadN: 20, leadMedian6h: -30 },
    ],
    cfg,
  );
  assert.ok(w.get("leads")!.weight > w.get("plain")!.weight);
  assert.ok(w.get("plain")!.weight > w.get("tops")!.weight);
  assert.match(w.get("leads")!.reason, /its buys move \+40% in 6h/);
});

test("the follow bar applies: below the learned win rate, no weight", () => {
  const w = computeWeights([{ ...base, address: "a", winRate30: 0.58 }, { ...base, address: "b", winRate30: 0.7 }], { ...cfg, minWinRate: 0.65 });
  assert.equal(w.get("a")!.weight, 0);
  assert.match(w.get("a")!.reason, /wins 58% of trades; GodsEye currently follows ≥ 65% \(learned\)/);
  assert.equal(w.get("b")!.weight, 1);
});

test("bot gate and copy gate: a wallet failing either gets no weight, with that reason", () => {
  const cfg = { copyLossDropSol: 0.2, minClosed: 10, minWinRate: 0.5 };
  const w = { address: "W", tier: "proven" as const, pnl7: 400, pnl30: 1500, closed30: 20, winRate30: 0.6, isFresh: false, copyPnl14: 0, copyClosed14: 0, oldWeight: 0 };
  assert.ok(rawScore(w, cfg).weight > 0);
  assert.ok(rawScore({ ...w, botGate: null, copyGate: null }, cfg).weight > 0);
  assert.deepEqual(rawScore({ ...w, botGate: "bot: median hold 8 s" }, cfg), { weight: 0, reason: "bot: median hold 8 s" });
  assert.deepEqual(rawScore({ ...w, copyGate: "copy replay: median −3%" }, cfg), { weight: 0, reason: "copy replay: median −3%" });
});
