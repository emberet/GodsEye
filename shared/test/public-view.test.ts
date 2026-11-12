import { test } from "node:test";
import assert from "node:assert/strict";
import { fullFeedEnabled, hideOwnWallet, hideSignatures, publicText, publicView, type PublicFeed } from "../src/public-view";
import { publicSnapshot, SNAPSHOT_KEYS, walletKey } from "../src/snapshot-store";
import { TIER_LABELS } from "../src/constants";

/** A made-up address, long enough to be treated as one. Built here so no address-like text sits in the file. */
const ADDRESS = "Wa11et".repeat(7);
/** A made-up transaction signature (88 characters), built here for the same reason. */
const SIGNATURE = "Sig5".repeat(22);

test("public summary hides the hot wallet address, shows its balance, keeps the rest", () => {
  const s = { copyMode: "real", paused: false, wallet: { pubkey: ADDRESS, balanceSol: 1.11, checkedAt: "2026-10-27T00:00:00Z" }, wins: 3 };
  const out = publicView("summary", s);
  assert.deepEqual(out.wallet, { pubkey: null, balanceSol: 1.11, checkedAt: "2026-10-27T00:00:00Z" });
  assert.equal(out.wins, 3);
  assert.equal(out.copyMode, "real");
  assert.ok(!JSON.stringify(out).includes(ADDRESS.slice(0, 6)));
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
  const w = publicView("wallet", {
    wallet: { address: "A", tier_reason: "a place among the top 8 earners" },
    weightHistory: [{ reason: "following wallets with ≥ 55% wins: median +4%" }],
    evidence: [{ detail: "wins 52% of trades; GodsEye currently follows ≥ 55% (learned)" }],
    smart: { reason: "+$900 this week; capped at 25% of the budget" },
  });
  assert.equal(w.wallet.tier_reason, "a place among the top earners");
  assert.equal(w.weightHistory[0].reason, "following wallets above the follow bar: median +4%");
  assert.equal(w.evidence[0].detail, "wins 52% of trades; win rate below the current follow bar");
  assert.equal(w.smart.reason, "+$900 this week; capped at its share of the budget");
  assert.ok(!JSON.stringify(w).match(/55%|top 8|25% of/));
});

test("owner override still reports full feed", () => {
  assert.equal(fullFeedEnabled({ GODSEYE_FULL_FEED: "1" }), true);
  assert.equal(fullFeedEnabled({}), false);
});

test("the full-feed switch is ignored by a production build and on Vercel", () => {
  assert.equal(fullFeedEnabled({ GODSEYE_FULL_FEED: "1", NODE_ENV: "production" }), false);
  assert.equal(fullFeedEnabled({ GODSEYE_FULL_FEED: "1", VERCEL: "1" }), false);
  assert.equal(fullFeedEnabled({ GODSEYE_FULL_FEED: "1", NODE_ENV: "development" }), true);
});

test("only listed fields are published: a new column is private until the view lists it", () => {
  const out = publicView("copies", {
    open: [{ id: 1, symbol: "COW", leader: "L", notes: "private" }],
    closed: [],
    trades: [{ id: 2, status: "filled", size_sol: 0.1, route: "private" }],
    debug: { anything: 1 },
  });
  assert.deepEqual(out, { open: [{ id: 1, symbol: "COW", leader: "L" }], closed: [], trades: [{ id: 2, status: "filled", size_sol: 0.1 }] });
});

test("the agent's own transaction is never published; a watched wallet's own transactions are", () => {
  const trade = { id: 1, leader: "L", status: "filled", signature: SIGNATURE, leader_signature: SIGNATURE };
  const copies = publicView("copies", { open: [], closed: [], trades: [trade] });
  const page = publicView("wallet", {
    wallet: { address: "L" },
    evidence: [{ id: 1, kind: "early_buy", detail: "bought in the first minute", signature: SIGNATURE }],
    swaps: [{ id: 1, signature: SIGNATURE }],
    copies: [trade],
  });
  for (const t of [...copies.trades, ...page.copies]) assert.deepEqual(t, { id: 1, leader: "L", status: "filled" });
  assert.equal(page.evidence[0].signature, SIGNATURE);
  assert.equal(page.swaps[0].signature, SIGNATURE);
});

test("a closing reason is published without a transaction signature or the agent's address", () => {
  const position = (exit_reason: string | null) => ({ id: 1, symbol: "COW", exit_reason });
  const closed = [position(`sold (found on chain) ${SIGNATURE}`), position(`sent to ${ADDRESS}`), position("stop-loss at -20.00%"), position(null)];
  const out = publicView("copies", { open: [], closed, trades: [] }, ADDRESS);
  assert.deepEqual(out.closed.map((p) => p.exit_reason), ["sold (found on chain) [signature hidden]", "", "stop-loss at -20.00%", null]);
});

test("text that names the agent's own wallet is blanked; a short or missing address blanks nothing", () => {
  const rows = [{ address: "A", tier_reason: `funded by ${ADDRESS}`, funder: ADDRESS }, { address: "B", tier_reason: "profitable", funder: "F" }];
  assert.deepEqual(publicView("wallets", rows, ADDRESS), [{ address: "A", tier_reason: "", funder: null }, { address: "B", tier_reason: "profitable", funder: "F" }]);
  assert.deepEqual(publicView("wallets", rows), rows);
  assert.deepEqual(publicView("wallets", rows, "fit"), rows);
  assert.deepEqual(publicView("wallets", { rows, total: 2 }, ADDRESS).rows[0], { address: "A", tier_reason: "", funder: null });
});

test("a wallet the agent funded reads like one whose funder was never found", () => {
  const rows = [{ address: "A", funder: ADDRESS, group_size: 3 }, { address: "B", funder: "F", group_size: 2 }, { address: "C", funder: null, group_size: 1 }];
  const out = publicView("wallets", rows, ADDRESS);
  assert.deepEqual(out, [{ address: "A", funder: null, group_size: 1 }, rows[1], rows[2]]);
  assert.deepEqual(publicView("wallets", out), out, "a second pass, as the hosted site does, changes nothing");
  assert.deepEqual(publicView("wallet", { wallet: rows[0], group: [] }, ADDRESS), { wallet: { address: "A", funder: null, group_size: 1 }, group: [] });
});

test("log helpers take out signatures and the agent's own address", () => {
  assert.equal(hideSignatures(`sent ${SIGNATURE}, then ${SIGNATURE}`), "sent [signature hidden], then [signature hidden]");
  assert.equal(hideSignatures(`wallet ${ADDRESS}`), `wallet ${ADDRESS}`);
  assert.equal(hideOwnWallet(`balance of ${ADDRESS} is low`, ADDRESS), "balance of [agent wallet] is low");
  assert.equal(hideOwnWallet(`balance of ${ADDRESS} is low`, null), `balance of ${ADDRESS} is low`);
});

test("proof entries show a buy or sell payload exactly as committed, and withhold any other", () => {
  const entry = (kind: string, payload: string) => ({ id: 1, kind, payload, prev_hash: "p", hash: "h", committed_at: "t" });
  const buy = JSON.stringify({ kind: "copy_buy", leader: "L", leader_signature: SIGNATURE, mint: "M", note: "Insider pattern" });
  const sell = JSON.stringify({ kind: "copy_sell", position_id: 3, reason: "stop-loss" });
  const body = {
    entries: [
      entry("copy_buy", buy),
      entry("copy_sell", sell),
      entry("copy_sell", JSON.stringify({ kind: "copy_sell", reason: `sold ${SIGNATURE}` })),
      entry("copy_buy", JSON.stringify({ kind: "copy_buy", leader: ADDRESS })),
      entry("wallet_flow", JSON.stringify({ kind: "wallet_flow", to: "somewhere" })),
    ],
    total: 5,
    chain: { ok: true, checked: 5 },
  };
  const out = publicView("proof", body, ADDRESS);
  assert.deepEqual(out.entries.map((e) => e.payload), [buy, sell, null, null, null]);
  // the fingerprints stay, so the chain can still be followed past a withheld entry
  assert.deepEqual(out.entries.map((e) => e.hash), ["h", "h", "h", "h", "h"]);
  assert.deepEqual(out.chain, { ok: true, checked: 5 });
  assert.equal(out.total, 5);
});

test("runners: X handles and the callers list are never published, nor a label that tells of an X account", () => {
  const catcher = (label: string) => ({ wallet: "W", hits: 3, label, x_handle: "somebody", qualifies: 1 });
  const body = {
    coinsWatched: 10,
    runners: [{ mint: "M", symbol: "COW", multiple: 12, source: "stream" }],
    catchers: ["insider", "sniper", "bot", "kol", "organic", "a_new_label"].map(catcher),
    callers: [{ author_id: "1", username: "somebody", followers: 9, linked_wallets: 2 }],
  };
  const out = publicView("runners", body);
  assert.deepEqual(out.catchers.map((c) => c.label), ["insider", "sniper", "bot", null, null, null]);
  assert.deepEqual(out.catchers[3], { wallet: "W", hits: 3, label: null, qualifies: 1 });
  assert.deepEqual(out.callers, []);
  assert.deepEqual(out.runners, body.runners);
  assert.ok(!JSON.stringify(out).includes("somebody"));
});

test("anything named social is dropped, even from a record of counts", () => {
  const out = publicView("summary", {
    wins: 1,
    socialMode: "shadow",
    tierCounts: { smart: 2, social_flagged: 1, note: "text" },
    stream: { status: "connected", socialQueue: 4 },
  });
  assert.deepEqual(out, { wins: 1, tierCounts: { smart: 2 }, stream: { status: "connected" } });
});

test("a value of the wrong kind is dropped, not passed through", () => {
  assert.deepEqual(publicView("copies", { open: "text", closed: [{ id: { nested: 1 } }], trades: null }), { open: [], closed: [{ id: null }], trades: null });
  assert.equal(publicView("summary", "text"), null);
  assert.equal(publicView("no_such_feed" as PublicFeed, { anything: 1 }), null);
});

test("an error answer never carries the agent's address", () => {
  assert.deepEqual(publicView("summary", { error: `no balance for ${ADDRESS}`, detail: "private" }, ADDRESS), { error: "Data is unavailable right now." });
  assert.deepEqual(publicView("summary", { error: 500 }), { error: "Data is unavailable right now." });
});

test("the public view of a public view is the same", () => {
  const body = {
    open: [{ id: 1, symbol: "COW", exit_reason: null, notes: "private" }],
    closed: [{ id: 2, exit_reason: `sold ${SIGNATURE}` }],
    trades: [{ id: 3, status: "skipped", reason: "liquidity 412 < min 500", weight: 0.3, signature: SIGNATURE }],
  };
  const once = publicView("copies", body, ADDRESS);
  assert.deepEqual(publicView("copies", once), once);
});

test("what goes to the public store is the public view of each feed; the agent's own page is left out", () => {
  const trade = { id: 1, leader: "L", status: "filled", signature: SIGNATURE };
  const snap = publicSnapshot(
    {
      summary: { wins: 1, wallet: { pubkey: ADDRESS, balanceSol: 2 } },
      logs: [{ id: 1, ts: "t", level: "info", message: "private" }],
      copies: { open: [], closed: [], trades: [trade] },
      live: [{ address: "W", swaps: 3, note: "private" }],
      runners: { catchers: [{ wallet: "W", label: "kol", x_handle: "somebody" }], callers: [{ username: "somebody" }] },
      [walletKey("L")]: { wallet: { address: "L", funder: ADDRESS }, copies: [trade] },
      [walletKey(ADDRESS)]: { wallet: { address: ADDRESS } },
      notes: { anything: "private" },
    },
    ADDRESS,
  );
  assert.deepEqual(Object.keys(snap).sort(), ["copies", "live", "logs", "runners", "summary", walletKey("L")].sort());
  assert.deepEqual(snap.summary, { wins: 1, wallet: { pubkey: null, balanceSol: 2 } });
  assert.deepEqual(snap.logs, []);
  assert.deepEqual(snap.live, [{ address: "W", swaps: 3 }]);
  assert.deepEqual(snap[walletKey("L")], { wallet: { address: "L", funder: null }, copies: [{ id: 1, leader: "L", status: "filled" }] });
  const json = JSON.stringify(snap);
  for (const secret of [ADDRESS, SIGNATURE, "somebody", "private"]) assert.ok(!json.includes(secret), secret);
});

test("every feed the agent publishes has a public view of its own", () => {
  for (const key of SNAPSHOT_KEYS) assert.notEqual(publicSnapshot({ [key]: {} })[key], null, key);
});
