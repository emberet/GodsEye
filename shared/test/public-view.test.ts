import { test } from "node:test";
import assert from "node:assert/strict";
import { fullFeedEnabled, publicText, publicView } from "../src/public-view";
import { TIER_LABELS } from "../src/constants";

test("public summary hides the hot wallet address, shows its balance, keeps the rest", () => {
  const s = { copyMode: "real", paused: false, wallet: { pubkey: "52NhExampleExampleExampleExamplepzMQ", balanceSol: 1.11, checkedAt: "2026-10-27T00:00:00Z" }, wins: 3 };
  const out = publicView("summary", s);
  assert.deepEqual(out.wallet, { pubkey: null, balanceSol: 1.11, checkedAt: "2026-10-27T00:00:00Z" });
  assert.equal(out.wins, 3);
  assert.equal(out.copyMode, "real");
  assert.ok(!JSON.stringify(out).includes("52Nh"));
});

test("public logs are empty", () => {
  assert.deepEqual(publicView("logs", [{ id: 1, ts: "t", level: "info", message: "secret detail" }]), []);
});

test("public copies keep the outcome, not the decision internals", () => {
  const trade = (status: string) => ({ id: 1, leader: "L", leader_signature: "sig", status, reason: "liquidity 412 < min 500; weight 0.31", error: status === "failed" ? "Jupiter 0x1771 at 10.0.0.1" : null, weight: 0.31, latency_ms: 812, size_sol: 0.1 });
  const out = publicView("copies", { open: [], closed: [], trades: [trade("skipped"), trade("failed"), trade("filled")] });
  const [skipped, failed, filled] = out.trades as Array<Record<string, unknown>>;
  assert.equal(skipped.reason, "Skipped by GodsEye's safety checks");
  assert.equal(failed.error, "The trade did not go through");
  assert.equal(filled.reason, null);
  for (const t of out.trades as Array<Record<string, unknown>>) {
    assert.equal(t.weight, null);
    assert.equal(t.latency_ms, null);
    assert.equal(t.size_sol, 0.1);
  }
  assert.ok(!JSON.stringify(out).includes("min 500"));
});

test("tuning thresholds are hidden from smart and leaders feeds", () => {
  const bar = { key: "follow_min_win_rate", value: 0.55, target: null, samples: 9, reason: "r", updated_at: "t" };
  assert.equal(publicView("smart", { followBar: bar, activeWallets: 2 }).followBar, null);
  const l = publicView("leaders", { leaders: [], changes: [], budgetSol: 1, followBar: bar, followBarHistory: [{ x: 1 }] });
  assert.equal(l.followBar, null);
  assert.deepEqual(l.followBarHistory, []);
  assert.ok(!JSON.stringify(l).includes("follow_min_win_rate"));
});

test("the insider tier is worded as an early-entry pattern publicly; the enum is unchanged", () => {
  const w = [{ address: "a", tier: "insider", tier_reason: "Insider pattern: 51 profitable launch-minute buys" }];
  const out = publicView("wallets", w);
  assert.equal(out[0].tier, "insider");
  assert.equal(out[0].tier_reason, "Early-entry pattern: 51 profitable launch-minute buys");
  assert.equal(TIER_LABELS.insider, "Early-entry pattern");
  assert.equal(publicText("an insider pattern"), "an early-entry pattern");
});

test("error answers pass through and the owner flag is opt-in", () => {
  const e = { error: "nope" };
  assert.deepEqual(publicView("summary", e), e);
  assert.equal(fullFeedEnabled({}), false);
  assert.equal(fullFeedEnabled({ GODSEYE_FULL_FEED: "true" }), false);
  assert.equal(fullFeedEnabled({ GODSEYE_FULL_FEED: "1" }), true);
});

test("learned thresholds are redacted from leader and change reasons, wallet stats kept", () => {
  const body = {
    leaders: [
      { address: "A", weight_reason: "wins 64% of trades; GodsEye currently follows ≥ 80% (learned)" },
      { address: "B", weight_reason: "+$1,200 this week; +$3,400 this month; 22 closed trades; 71% wins; not in the top 8 earners" },
      { address: "C", weight_reason: "+$900 this week; capped at 25% of the budget" },
      { address: "D", weight_reason: "only 4 closed trades seen so far (10 needed before GodsEye copies a wallet)" },
    ],
    changes: [{ reason: "wins 52% of trades; GodsEye currently follows ≥ 55% (learned)" }],
    followBar: null, followBarHistory: [],
  };
  const out = publicView("leaders", body) as typeof body;
  const [a, b, c, d] = out.leaders.map((l) => l.weight_reason);
  assert.equal(a, "wins 64% of trades; win rate below the current follow bar");
  assert.equal(b, "+$1,200 this week; +$3,400 this month; 22 closed trades; 71% wins; not currently among the top earners");
  assert.equal(c, "+$900 this week; capped at its share of the budget");
  assert.equal(d, "only 4 closed trades seen so far (below GodsEye's current minimum)");
  assert.equal(out.changes[0].reason, "wins 52% of trades; win rate below the current follow bar");
  const json = JSON.stringify(out);
  for (const leak of ["80%", "55%", "top 8", "25% of", "10 needed", "(learned)"]) assert.ok(!json.includes(leak), leak);
  // the original object (what the owner feed returns with GODSEYE_FULL_FEED=1) is untouched
  assert.ok(body.leaders[0].weight_reason.includes("≥ 80%"));
});

test("threshold redaction applies to every feed, including wallet pages", () => {
  const w = publicView("wallet", { history: [{ reason: "following wallets with ≥ 55% wins: median +4%" }], evaluation: ["a place among the top 8 earners"] });
  assert.ok(!JSON.stringify(w).match(/55%|top 8/));
});

test("owner override still reports full feed", () => {
  assert.equal(fullFeedEnabled({ GODSEYE_FULL_FEED: "1" }), true);
  assert.equal(fullFeedEnabled({}), false);
});
