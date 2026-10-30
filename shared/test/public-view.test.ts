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
