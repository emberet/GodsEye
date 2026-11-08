/**
 * The Brain's hard gates (brain/gates.ts) against the cases brain/spec/golden/entry.json pins, and the same gates in the
 * real copy screen (copy/engine.ts copyBuy, COPY_BRAIN_GATES): audited skips, nothing bought. In-memory database, a fake
 * executor (nothing sent), wallet_swaps.ins_ms stamped by insertSwaps.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "@godseye/shared";
import type { ParsedSwap } from "../src/chain/parse";
import type { Executor, Fill } from "../src/copy/executor";
import { MINT } from "./helpers";

process.env.RUG_CHECK_ENABLED = "false";
process.env.COPY_BUDGET_SOL = "1";
process.env.COPY_MAX_TRADE_SOL = "0.1";
process.env.MIN_LEADER_BUY_SOL = "0.2";
process.env.COPY_MAX_DELAY_SECONDS = "60";
delete process.env.COPY_BRAIN_GATES;
const { gate, gateReason, GATES } = await import("../src/brain/gates");
const { CopyEngine, firstSeenAt } = await import("../src/copy/engine");
const { insertSwaps } = await import("../src/analysis/analyze");
const { config } = await import("../src/config");

interface GoldenCase {
  name: string;
  input: {
    now: string;
    swap: { sol_amount: number; price_sol: number | null; venue: string | null; ts: string };
    first_seen: { firstSeenAt: number } | null;
    screen: { failed: boolean; lp_locked_pct: number | null } | null;
  };
  expected: { gate: string | null };
}
const golden = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../../brain/spec/golden/entry.json"), "utf8")) as { cases: GoldenCase[] };

test("gate() reproduces every gate case in brain/spec/golden/entry.json", () => {
  assert.ok(golden.cases.length >= 40);
  const fired = new Set<string>();
  for (const c of golden.cases) {
    const { swap, first_seen, screen } = c.input;
    const signal = { solAmount: swap.sol_amount, priceSol: swap.price_sol, venue: swap.venue, t: Date.parse(swap.ts) };
    const ctx = { now: Date.parse(c.input.now), firstSeenAt: first_seen?.firstSeenAt ?? null, screen: screen && { failed: screen.failed, lpLockedPct: screen.lp_locked_pct } };
    const got = gate(signal, ctx);
    assert.equal(got, c.expected.gate, c.name);
    if (got) {
      fired.add(got);
      assert.ok(gateReason(got, signal, ctx).length > 0);
    }
  }
  assert.deepEqual([...fired].sort(), [...GATES].sort(), "every gate has a golden case");
});

test("gate() order: the first gate in features.yaml order wins; thresholds come from the context", () => {
  const now = Date.parse("2026-11-10T12:00:00.000Z");
  const all = { solAmount: 0.1, priceSol: 5e-4, venue: "pumpswap", t: now - 120_000 };
  const ctx = { now, firstSeenAt: null, screen: { failed: true, lpLockedPct: 0 } };
  assert.equal(gate(all, ctx), "below_min_leader_buy");
  assert.equal(gate({ ...all, solAmount: 1 }, ctx), "too_late");
  assert.equal(gate({ ...all, solAmount: 1, t: now }, ctx), "pumpswap_hiprice");
  assert.equal(gate({ ...all, solAmount: 1, t: now, priceSol: 1e-6 }, ctx), "young_amm");
  assert.equal(gate({ ...all, solAmount: 1, t: now, priceSol: 1e-6, venue: "pumpfun" }, ctx), "screen_dead");
  assert.equal(gate({ ...all, solAmount: 1, t: now, priceSol: 1e-6, venue: "pumpfun" }, { ...ctx, screen: null }), null);
  assert.equal(gate({ ...all, solAmount: 0.1, t: now, priceSol: 1e-6, venue: "pumpfun" }, { ...ctx, screen: null, minLeaderBuySol: 0.05 }), null);
  assert.equal(gate({ ...all, solAmount: 1, priceSol: 1e-6, venue: "pumpfun" }, { ...ctx, screen: null, maxLateSec: 300 }), null);
});

class FakeExecutor implements Executor {
  mode = "paper" as const;
  calls: string[] = [];
  async buy(_mint: string, sol: number): Promise<Fill> {
    this.calls.push(`buy ${sol}`);
    return { signature: null, solAmount: sol, tokenAmount: sol * 1000, priceSol: 0.001 };
  }
  async sell(_mint: string, tokens: number): Promise<Fill> {
    this.calls.push(`sell ${tokens}`);
    return { signature: null, solAmount: tokens * 0.002, tokenAmount: tokens, priceSol: 0.002 };
  }
}

function setup() {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO wallets (address, first_seen_at, discovered_via, copy_weight) VALUES ('LEADER', ?, 'test', 0.5)").run(new Date().toISOString());
  db.prepare("INSERT INTO token_info (mint, symbol, decimals, pool_created_at, checked_at) VALUES (?, 'MOO', 6, '2026-01-01T00:00:00Z', ?)").run(MINT, new Date().toISOString());
  const ex = new FakeExecutor();
  return { db, ex, engine: new CopyEngine(db, ex, null) };
}
const leaderSwap = (p: Partial<ParsedSwap>): ParsedSwap => ({
  wallet: "LEADER", signature: `gsig${Math.random()}`, slot: 1, ts: new Date().toISOString(), mint: MINT, side: "buy",
  tokenAmount: 1000, tokenBalanceBefore: 0, solAmount: 1, priceSol: 1e-6, venue: "pumpswap", jitoTip: false, feeLamports: 5000, quote: "SOL", quoteAmount: 1, solUsd: null, usdAmount: null, ...p,
});
const decision = (db: ReturnType<typeof openDb>) =>
  db.prepare("SELECT outcome, checks FROM copy_decisions ORDER BY rowid DESC LIMIT 1").get() as { outcome: string; checks: string } | undefined;

test("insertSwaps stamps wallet_swaps.ins_ms with the insert time; a re-delivered swap keeps its first one", () => {
  const db = openDb(":memory:");
  const s = leaderSwap({ ts: new Date(Date.now() - 3_600_000).toISOString() });
  const before = Date.now();
  insertSwaps(db, [s]);
  const first = (db.prepare("SELECT ins_ms FROM wallet_swaps").get() as { ins_ms: number }).ins_ms;
  assert.ok(first >= before && first <= Date.now(), "insert time, not the block time");
  insertSwaps(db, [s]);
  assert.equal((db.prepare("SELECT COUNT(*) n, MAX(ins_ms) m FROM wallet_swaps").get() as { n: number; m: number }).m, first);
  // first sighting by insert time: a backfilled old swap stored now is a coin seen now.
  assert.equal(firstSeenAt(db, MINT, Date.now()), first);
  assert.equal(firstSeenAt(db, MINT, before - 1), null, "not yet stored then");
});

test("the real copy screen applies the gates after the lateness check: audited skips, nothing bought", async () => {
  assert.equal(config.copyBrainGates, true, "on by default");
  {
    // A pumpswap coin at ≥ 1e-4 SOL a token.
    const { db, ex, engine } = setup();
    await engine.onLeaderSwap(leaderSwap({ priceSol: 2e-4 }));
    assert.deepEqual(ex.calls, []);
    assert.match((db.prepare("SELECT reason FROM copy_trades").get() as { reason: string }).reason, /brain gate pumpswap_hiprice/);
    const d = decision(db)!;
    assert.equal(d.outcome, "skipped:gate");
    assert.match(d.checks, /"check":"gate","result":"fail","detail":"brain gate pumpswap_hiprice/);
  }
  {
    // A pumpswap coin GodsEye first saw with this very buy: young_amm.
    const { db, ex, engine } = setup();
    await engine.onLeaderSwap(leaderSwap({}));
    assert.deepEqual(ex.calls, []);
    assert.match((db.prepare("SELECT reason FROM copy_trades").get() as { reason: string }).reason, /brain gate young_amm: a pumpswap coin/);
  }
  {
    // The same coin seen 20 minutes ago (stored then): it passes, and the check is in the audit.
    const { db, ex, engine } = setup();
    insertSwaps(db, [leaderSwap({ wallet: "OTHER", ts: new Date(Date.now() - 20 * 60_000).toISOString() })]);
    db.prepare("UPDATE wallet_swaps SET ins_ms = ?").run(Date.now() - 20 * 60_000);
    await engine.onLeaderSwap(leaderSwap({}));
    assert.deepEqual(ex.calls, ["buy 0.1"]);
    assert.match(decision(db)!.checks, /"check":"brain_gates","result":"pass"/);
  }
  {
    // A late buy is skipped as late, before the gates (the lateness check comes first).
    const { db, ex, engine } = setup();
    await engine.onLeaderSwap(leaderSwap({ priceSol: 2e-4, ts: new Date(Date.now() - 10 * 60_000).toISOString() }));
    assert.deepEqual(ex.calls, []);
    assert.match((db.prepare("SELECT reason FROM copy_trades").get() as { reason: string }).reason, /seen \d+s after/);
  }
  {
    // COPY_BRAIN_GATES=false: today's screen only.
    config.copyBrainGates = false;
    try {
      const { ex, engine } = setup();
      await engine.onLeaderSwap(leaderSwap({ priceSol: 2e-4 }));
      assert.deepEqual(ex.calls, ["buy 0.1"]);
    } finally {
      config.copyBrainGates = true;
    }
  }
  {
    // Non-AMM venues (pumpfun, jupiter) at a normal price pass, never seen or not.
    const { ex, engine } = setup();
    await engine.onLeaderSwap(leaderSwap({ venue: "pumpfun" }));
    assert.deepEqual(ex.calls, ["buy 0.1"]);
  }
});
