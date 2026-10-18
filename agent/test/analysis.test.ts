import { test } from "node:test";
import assert from "node:assert/strict";
import { computeStats, realize, type SwapLite } from "../src/analysis/pnl";
import { classify, longestQuietHours } from "../src/analysis/classifier";
import { assignTier, type TierInput } from "../src/analysis/tiers";
import { D, H, iso, swap } from "./helpers";

const NOW = Date.parse("2026-10-18T12:00:00Z");
const cfg = { quitAfterDays: 7, minClosedForProven: 10, earlyBuySeconds: 600, crashMinExits: 3, crashMinShare: 0.25 };

test("realize: average cost, partial sells, closed positions", () => {
  const swaps = [
    swap({ ts: iso(3 * H, NOW), side: "buy", sol_amount: 1, token_amount: 100 }),
    swap({ ts: iso(2 * H, NOW), side: "buy", sol_amount: 3, token_amount: 100 }), // avg cost 0.02/token
    swap({ ts: iso(1 * H, NOW), side: "sell", sol_amount: 2, token_amount: 50 }), // cost 1 → +1
    swap({ ts: iso(0.5 * H, NOW), side: "sell", sol_amount: 3, token_amount: 150 }), // cost 3 → 0
  ];
  const r = realize(swaps, 600);
  assert.equal(r.closed.length, 1);
  assert.ok(Math.abs(r.closed[0].pnlSol - 1) < 1e-9);
  assert.ok(Math.abs(r.events.reduce((s, e) => s + e.pnlSol, 0) - 1) < 1e-9);
  assert.equal(r.open.size, 0);
});

test("realize: sells of tokens never seen bought can't fake profit", () => {
  const r = realize([swap({ ts: iso(H, NOW), side: "sell", sol_amount: 50, token_amount: 10 })], 600);
  assert.equal(r.events.length, 0);
  assert.equal(r.unmatchedSells, 1);
});

/** n closed round trips on different tokens; pnl per trade given by fn. */
function trades(n: number, pnl: (i: number) => number, opts: { daysBack?: number; early?: boolean } = {}): SwapLite[] {
  const out: SwapLite[] = [];
  for (let i = 0; i < n; i++) {
    const t = NOW - ((opts.daysBack ?? 6) * D * (i + 1)) / (n + 1);
    out.push(swap({ ts: new Date(t).toISOString(), mint: `M${i}`, side: "buy", sol_amount: 1, token_amount: 100, token_age_sec: opts.early ? 60 : 86_400 }));
    out.push(swap({ ts: new Date(t + 30 * 60_000).toISOString(), mint: `M${i}`, side: "sell", sol_amount: 1 + pnl(i), token_amount: 100 }));
  }
  return out;
}

function tierOf(swaps: SwapLite[], extra: Partial<TierInput> = {}) {
  const r = realize(swaps, 600);
  const stats = computeStats(swaps, r, NOW, 600);
  return assignTier({ stats, closed: r.closed, now: NOW, isFresh: false, groupSize: 1, funderTracked: null, previousTier: "unrated", creatorLinks: [], crashExits: [], symbols: new Map(), cfg, ...extra });
}

test("tiers: proven = many trades, mostly wins, profit spread out", () => {
  const t = tierOf(trades(14, (i) => (i % 4 === 0 ? -0.1 : 0.3)));
  assert.equal(t.tier, "proven", t.reason);
});

test("tiers: lucky streak = one trade carries the profit", () => {
  const t = tierOf(trades(12, (i) => (i === 0 ? 10 : i % 2 ? -0.1 : 0.05)));
  assert.equal(t.tier, "lucky_streak", t.reason);
  assert.match(t.reason, /One trade made/);
});

test("tiers: lucky streak = profitable but too few trades", () => {
  assert.equal(tierOf(trades(4, () => 0.5)).tier, "lucky_streak");
});

test("tiers: quitter after a week of silence", () => {
  const t = tierOf(trades(12, () => 0.3, { daysBack: 0 }).map((s) => ({ ...s, ts: iso(10 * D, Date.parse(s.ts)) })));
  assert.equal(t.tier, "quitter", t.reason);
});

test("tiers: insider pattern from repeated profitable launch-minute buys, with evidence", () => {
  const t = tierOf(trades(5, () => 2, { early: true }));
  assert.equal(t.tier, "insider", t.reason);
  assert.ok(t.evidence.filter((e) => e.kind === "early_entry").length >= 3);
});

test("tiers: insider pattern from a creator link", () => {
  const t = tierOf(trades(12, () => 0.2), { creatorLinks: [{ mint: "M0", symbol: "MOO", relation: "funded_by_creator", signature: "x", ts: iso(D, NOW) }] });
  assert.equal(t.tier, "insider");
  assert.match(t.evidence[0].detail, /funded by the creator of MOO/);
});

test("tiers: needs attention when a winner starts losing this week", () => {
  const old = trades(12, () => 0.5, { daysBack: 25 }).map((s) => ({ ...s, ts: iso(8 * D, Date.parse(s.ts)) }));
  const recent = trades(3, () => -0.4, { daysBack: 3 }).map((s) => ({ ...s, mint: `R${s.mint}` }));
  const t = tierOf([...old, ...recent]);
  assert.equal(t.tier, "needs_attention", t.reason);
  assert.equal(t.evidence[0].kind, "slipping");
});

test("tiers: needs attention for a big sibling group or a rotated wallet", () => {
  const base = trades(14, (i) => (i % 4 === 0 ? -0.1 : 0.3));
  assert.equal(tierOf(base, { groupSize: 8 }).tier, "needs_attention");
  assert.equal(tierOf(base, { funderTracked: { address: "Abcd1111111111111111111111111111111111111xyz", tier: "proven" } }).tier, "needs_attention");
  // a huge group is probably an exchange, not one person
  assert.equal(tierOf(base, { groupSize: 40 }).tier, "proven");
});

test("classifier: round-the-clock, clockwork, same-size trading = AI/bot", () => {
  const swaps: SwapLite[] = [];
  for (let i = 0; i < 300; i++) {
    const ts = new Date(NOW - i * 12 * 60_000).toISOString(); // every 12 min for ~2.5 days
    swaps.push(swap({ ts, mint: `M${i % 30}`, side: i % 2 ? "sell" : "buy", sol_amount: 0.37, token_amount: 10, jito_tip: 1, venue: "pumpfun" }));
  }
  const c = classify(swaps);
  assert.equal(c.kind, "ai", JSON.stringify(c.reasons));
  assert.ok(c.reasons.some((r) => /around the clock/.test(r.reason)));
});

test("classifier: sleeps, trades a few times a day in round sizes = human", () => {
  const swaps: SwapLite[] = [];
  const sizes = [0.5, 1, 0.25, 2, 1, 0.5];
  for (let day = 0; day < 6; day++) {
    for (let k = 0; k < 4; k++) {
      const ts = new Date(Date.parse("2026-10-10T14:00:00Z") + day * D + k * 97 * 60_000 + day * 13 * 60_000).toISOString();
      swaps.push(swap({ ts, mint: `D${day}${k}`, side: k % 2 ? "sell" : "buy", sol_amount: sizes[(day + k) % 6], token_amount: 10, venue: "jupiter" }));
    }
  }
  const c = classify(swaps);
  assert.equal(c.kind, "human", JSON.stringify(c.reasons));
});

test("classifier: too few swaps → unknown", () => {
  assert.equal(classify(trades(2, () => 0)).kind, "unknown");
});

test("longestQuietHours wraps around midnight", () => {
  const ts = [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20].map((h) => `2026-10-10T${String(h).padStart(2, "0")}:00:00Z`);
  assert.equal(longestQuietHours(ts), 12);
});

test("classifier: thousands of transactions an hour = AI/bot, even with few SOL swaps", () => {
  const c = classify(trades(2, () => 0), { txPerHour: 9000 });
  assert.equal(c.kind, "ai");
  assert.match(c.reasons[0].reason, /9,000 transactions per hour/);
});

test("P&L in SOL: bought with USDC, sold for SOL after SOL's price moved", () => {
  // Bought for $200 when SOL was $100 (= 2 SOL); sold for 2.5 SOL → +0.5 SOL.
  const r = realize(
    [
      swap({ ts: iso(2 * H, NOW), side: "buy", sol_amount: 2, token_amount: 1000 }),
      swap({ ts: iso(H, NOW), side: "sell", sol_amount: 2.5, token_amount: 1000 }),
    ],
    600,
  );
  assert.ok(Math.abs(r.closed[0].pnlSol - 0.5) < 1e-9);
});

import { isCrashExit, judgeExit } from "../src/analysis/crash";
import type { Candle } from "../src/market/geckoterminal";

const T0 = 1_760_000_400; // a 15-min candle boundary
const c = (i: number, o: number, h: number, l: number, cl: number): Candle => [T0 + i * 900, o, h, l, cl];
const crashCfg = { crashDropPct: 50, crashWindowMinutes: 60 };

test("crash rule: sold near the top, fell 70% within the hour → counts", () => {
  const candles = [c(-4, 0.9, 1.0, 0.9, 1.0), c(-1, 1.0, 1.05, 0.98, 1.0), c(0, 1.0, 1.0, 0.8, 0.8), c(1, 0.8, 0.8, 0.3, 0.35), c(4, 0.35, 0.4, 0.3, 0.32)];
  const j = judgeExit(candles, T0 + 60, 1.0, 60)!;
  assert.ok(j.nearTop);
  assert.ok(j.dropPct >= 69 && j.dropPct <= 71, `drop ${j.dropPct}`);
  assert.ok(j.minutesToLow <= 30);
  assert.equal(isCrashExit(j, crashCfg), true);
});

test("crash rule: a slow decay over days, or selling into a dump already under way, doesn't count", () => {
  // only -20% within the hour (the rest of the fall comes days later)
  const slow = [c(-2, 1, 1, 1, 1), c(0, 1, 1, 0.9, 0.9), c(3, 0.9, 0.9, 0.8, 0.8)];
  assert.equal(isCrashExit(judgeExit(slow, T0 + 60, 1.0, 60), crashCfg), false);
  // sold at 0.5 after the token already fell from 1.0 in the previous hour
  const intoDump = [c(-3, 1, 1, 0.9, 0.9), c(-1, 0.6, 0.6, 0.5, 0.5), c(0, 0.5, 0.5, 0.2, 0.2)];
  const j = judgeExit(intoDump, T0 + 60, 0.5, 60)!;
  assert.equal(j.nearTop, false);
  assert.equal(isCrashExit(j, crashCfg), false);
  // no candle data → can't judge
  assert.equal(judgeExit([], T0, 1, 60), null);
});

test("tiers: crash exits make an insider only as a real pattern (≥3 and ≥25% of closed trades)", () => {
  const exit = (i: number) => ({ mint: `M${i}`, symbol: `T${i}`, dropPct: 70, minutesToLow: 20, signature: `x${i}`, ts: iso(D, NOW) });
  const many = trades(40, (i) => (i % 4 === 0 ? -0.1 : 0.3));
  // 3 crash exits out of 40 closed trades = 7.5% → not insider
  assert.notEqual(tierOf(many, { crashExits: [0, 1, 2].map(exit) }).tier, "insider");
  // 4 out of 12 = 33% → insider
  const t = tierOf(trades(12, () => 0.3), { crashExits: [0, 1, 2, 3].map(exit) });
  assert.equal(t.tier, "insider");
  assert.match(t.reason, /sold right before 4 crashes \(33% of its trades\)/);
});

test("USD P&L: SOL's own price move isn't trading profit", () => {
  // Bought for 2 SOL when SOL = $100 ($200); sold for 2.5 SOL when SOL = $80 ($200).
  // In SOL that looks like +0.5; in dollars it's break-even.
  const r = realize(
    [
      swap({ ts: iso(2 * H, NOW), side: "buy", sol_amount: 2, usd_amount: 200, token_amount: 1000 }),
      swap({ ts: iso(H, NOW), side: "sell", sol_amount: 2.5, usd_amount: 200, token_amount: 1000 }),
    ],
    600,
  );
  assert.ok(Math.abs(r.closed[0].pnlSol - 0.5) < 1e-9);
  assert.equal(r.closed[0].pnlUsd, 0);
  assert.equal(r.closed[0].pnlPct, 0); // % return is in USD when known
});

test("USD P&L: mixes SOL- and USDC-settled legs, partial sells included", () => {
  const swaps = [
    swap({ ts: iso(3 * H, NOW), side: "buy", sol_amount: 1, usd_amount: 100, token_amount: 100 }), // paid 1 SOL @ $100
    swap({ ts: iso(2 * H, NOW), side: "buy", sol_amount: 2, usd_amount: 200, token_amount: 100 }), // paid $200 USDC
    swap({ ts: iso(H, NOW), side: "sell", sol_amount: 1.5, usd_amount: 180, token_amount: 100 }), // got $180 for half (cost $150)
    swap({ ts: iso(0.5 * H, NOW), side: "sell", sol_amount: 1, usd_amount: 120, token_amount: 100 }), // got $120 for the rest (cost $150)
  ];
  const r = realize(swaps, 600);
  assert.equal(r.closed[0].costUsd, 300);
  assert.equal(r.closed[0].proceedsUsd, 300);
  assert.equal(r.closed[0].pnlUsd, 0);
  assert.deepEqual(r.events.map((e) => e.pnlUsd), [30, -30]);
  const st = computeStats(swaps, r, NOW, 600);
  assert.equal(st.pnl_7d_usd, 0);
  assert.equal(st.avg_buy_usd, 150);
});

test("USD P&L: a leg with no known USD value makes that position's USD result unknown, not zero", () => {
  const r = realize(
    [
      swap({ ts: iso(2 * H, NOW), side: "buy", sol_amount: 1, usd_amount: null, token_amount: 10 }),
      swap({ ts: iso(H, NOW), side: "sell", sol_amount: 2, usd_amount: 200, token_amount: 10 }),
    ],
    600,
  );
  assert.equal(r.closed[0].pnlUsd, null);
  assert.equal(r.closed[0].pnlSol, 1);
  const st = computeStats([], r, NOW, 600);
  assert.equal(st.pnl_7d_usd, null);
});

test("tiers judge profit in USD and show dollars", () => {
  const t = tierOf(trades(14, (i) => (i % 4 === 0 ? -0.1 : 0.3)));
  assert.equal(t.tier, "proven");
  assert.match(t.reason, /^\+\$\d/);
});
