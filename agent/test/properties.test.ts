/**
 * Property tests (fast-check): accounting invariants that must hold for any trade history, not just the
 * hand-picked examples in analysis.test.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { openDb } from "@godseye/shared";
import { realize, type SwapLite } from "../src/analysis/pnl";
import { copySize } from "../src/learning/weights";
import { insertSwaps } from "../src/analysis/analyze";
import { tradeCostSol } from "../src/chain/parse";
import type { ParsedSwap } from "../src/chain/parse";
import { swapTx, WALLET } from "./helpers";

const EPS = 1e-6;
const close = (a: number, b: number, eps = EPS) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b));
const T0 = Date.parse("2026-10-01T00:00:00Z");
const ts = (i: number) => new Date(T0 + i * 60_000).toISOString();

const sw = (i: number, mint: string, side: "buy" | "sell", tokens: number, sol: number, usd: number | null): SwapLite => ({
  signature: `s${i}`, ts: ts(i), mint, side, token_amount: tokens, sol_amount: sol, usd_amount: usd, price_sol: sol / tokens, venue: "jupiter", jito_tip: 0, token_age_sec: null,
});

/** Per coin: some buys, then sells that add up to exactly what was bought (the position closes cleanly). */
const roundTrip = fc.record({
  buys: fc.array(fc.record({ tokens: fc.double({ min: 1, max: 1e6, noNaN: true }), sol: fc.double({ min: 0.001, max: 50, noNaN: true }) }), { minLength: 1, maxLength: 5 }),
  sellParts: fc.array(fc.double({ min: 0.05, max: 1, noNaN: true }), { minLength: 1, maxLength: 5 }),
  sellPrices: fc.array(fc.double({ min: 1e-7, max: 1e-2, noNaN: true }), { minLength: 5, maxLength: 5 }),
  usdKnown: fc.boolean(),
});

function history(coins: fc.RecordValue<{ buys: { tokens: number; sol: number }[]; sellParts: number[]; sellPrices: number[]; usdKnown: boolean }>[]) {
  const swaps: SwapLite[] = [];
  let i = 0;
  coins.forEach((c, k) => {
    const mint = `M${k}`;
    let bought = 0;
    for (const b of c.buys) {
      swaps.push(sw(i++, mint, "buy", b.tokens, b.sol, c.usdKnown ? b.sol * 150 : null));
      bought += b.tokens;
    }
    const total = c.sellParts.reduce((s, x) => s + x, 0);
    let left = bought;
    c.sellParts.forEach((part, j) => {
      const tokens = j === c.sellParts.length - 1 ? left : (bought * part) / total;
      left -= tokens;
      const sol = tokens * c.sellPrices[j];
      swaps.push(sw(i++, mint, "sell", tokens, sol, sol * 150));
    });
  });
  return swaps;
}

test("property: a closed position's cost is everything paid for it, and its P&L is proceeds − cost", () => {
  fc.assert(
    fc.property(fc.array(roundTrip, { minLength: 1, maxLength: 4 }), (coins) => {
      const swaps = history(coins);
      const r = realize(swaps, 60);
      assert.equal(r.open.size, 0);
      assert.equal(r.closed.length, coins.length);
      const paid = swaps.filter((s) => s.side === "buy").reduce((t, s) => t + s.sol_amount, 0);
      const got = swaps.filter((s) => s.side === "sell").reduce((t, s) => t + s.sol_amount, 0);
      assert.ok(close(r.closed.reduce((t, c) => t + c.costSol, 0), paid), "cost conserved");
      assert.ok(close(r.closed.reduce((t, c) => t + c.proceedsSol, 0), got), "proceeds conserved");
      for (const c of r.closed) assert.ok(close(c.pnlSol, c.proceedsSol - c.costSol));
      // Realized events add up to the closed positions' P&L.
      assert.ok(close(r.events.reduce((t, e) => t + e.pnlSol, 0), r.closed.reduce((t, c) => t + c.pnlSol, 0), 1e-5));
      // A position with any buy of unknown dollar value has an unknown dollar result, never a wrong one.
      coins.forEach((c, k) => {
        const pos = r.closed.find((x) => x.mint === `M${k}`)!;
        if (!c.usdKnown) assert.equal(pos.pnlUsd, null);
        else assert.ok(pos.pnlUsd !== null && close(pos.pnlUsd, (pos.proceedsUsd ?? 0) - (pos.costUsd ?? 0)));
      });
    }),
    { numRuns: 300 },
  );
});

test("property: partial sells keep the books balanced (realized + cost still held = proceeds − cost paid + cost held)", () => {
  fc.assert(
    fc.property(
      fc.array(fc.record({ tokens: fc.double({ min: 1, max: 1e6, noNaN: true }), sol: fc.double({ min: 0.001, max: 50, noNaN: true }) }), { minLength: 1, maxLength: 4 }),
      fc.array(fc.record({ share: fc.double({ min: 0.01, max: 0.2, noNaN: true }), price: fc.double({ min: 1e-7, max: 1e-2, noNaN: true }) }), { minLength: 1, maxLength: 4 }),
      (buys, sells) => {
        const swaps: SwapLite[] = [];
        let i = 0;
        let bought = 0;
        for (const b of buys) {
          swaps.push(sw(i++, "M", "buy", b.tokens, b.sol, b.sol * 150));
          bought += b.tokens;
        }
        // At most 80% sold in total: the position stays open.
        for (const s of sells) {
          const tokens = bought * s.share;
          swaps.push(sw(i++, "M", "sell", tokens, tokens * s.price, tokens * s.price * 150));
        }
        const r = realize(swaps, 60);
        const open = r.open.get("M")!;
        assert.ok(open, "still open");
        const paid = buys.reduce((t, b) => t + b.sol, 0);
        const proceeds = swaps.filter((s) => s.side === "sell").reduce((t, s) => t + s.sol_amount, 0);
        const realized = r.events.reduce((t, e) => t + e.pnlSol, 0);
        assert.ok(close(realized, proceeds - (paid - open.costSol), 1e-5), `${realized} vs ${proceeds - (paid - open.costSol)}`);
        assert.ok(open.costSol <= paid + EPS && open.costSol >= 0);
      },
    ),
    { numRuns: 300 },
  );
});

test("property: replaying the same history gives the same books, whatever order the swaps arrive in", () => {
  fc.assert(
    fc.property(fc.array(roundTrip, { minLength: 1, maxLength: 3 }), fc.integer(), (coins, seed) => {
      const swaps = history(coins);
      const shuffled = [...swaps].sort((a, b) => ((a.signature.length * 31 + seed) % 7) - ((b.signature.length * 17 + seed) % 5) || a.signature.localeCompare(b.signature) * (seed % 2 ? 1 : -1));
      const a = realize(swaps, 60);
      const b = realize(shuffled, 60);
      assert.deepEqual(b.closed, a.closed);
      assert.deepEqual([...b.open], [...a.open]);
    }),
    { numRuns: 200 },
  );
});

test("property: storing the same swaps twice (or interleaved) never double-counts them", () => {
  fc.assert(
    fc.property(fc.array(fc.tuple(fc.integer({ min: 0, max: 30 }), fc.constantFrom<"buy" | "sell">("buy", "sell")), { minLength: 1, maxLength: 20 }), (raw) => {
      const db = openDb(":memory:");
      const swaps: ParsedSwap[] = raw.map(([k, side]) => ({
        wallet: WALLET, signature: `sig${k}`, slot: k, ts: ts(k), mint: "M", side, tokenAmount: 10, tokenBalanceBefore: 0, solAmount: 0.1, priceSol: 0.01,
        venue: "jupiter", jitoTip: false, feeLamports: 5000, quote: "SOL", quoteAmount: 0.1, solUsd: null, usdAmount: null,
      }));
      insertSwaps(db, swaps);
      insertSwaps(db, [...swaps].reverse());
      insertSwaps(db, swaps);
      const unique = new Set(swaps.map((s) => s.signature)).size;
      assert.equal((db.prepare("SELECT COUNT(*) n FROM wallet_swaps").get() as { n: number }).n, unique);
    }),
    { numRuns: 100 },
  );
});

test("property: copy size is 0 or between the minimum and maximum, and never more than the weight's share", () => {
  fc.assert(
    fc.property(
      fc.double({ min: 0, max: 1, noNaN: true }),
      fc.double({ min: 0.01, max: 100, noNaN: true }),
      fc.double({ min: 0.001, max: 0.05, noNaN: true }),
      fc.double({ min: 0.05, max: 5, noNaN: true }),
      (weight, budget, min, max) => {
        const size = copySize(weight, { copyBudgetSol: budget, copyMinTradeSol: min, copyMaxTradeSol: max });
        assert.ok(size === 0 || (size >= min - 1e-6 && size <= max + 1e-6), `${size}`);
        assert.ok(size <= budget * weight + 1e-6);
      },
    ),
  );
});

test("property: a trade's extra cost (fees, tips, rent) is never negative and adds up with the price", () => {
  fc.assert(
    fc.property(fc.double({ min: 0.001, max: 10, noNaN: true }), fc.integer({ min: 5000, max: 2_000_000 }), fc.boolean(), (sol, feeLamports, buy) => {
      const solDelta = buy ? -sol - feeLamports / 1e9 : sol - feeLamports / 1e9;
      const tx = swapTx({ solDelta, tokenBefore: buy ? 0 : 100, tokenAfter: buy ? 100 : 0, fee: feeLamports });
      const cost = tradeCostSol(tx, WALLET, buy ? "buy" : "sell", sol)!;
      assert.ok(cost >= 0);
      assert.ok(Math.abs(cost - feeLamports / 1e9) < 2e-9, `${cost} vs ${feeLamports / 1e9}`);
    }),
  );
});
