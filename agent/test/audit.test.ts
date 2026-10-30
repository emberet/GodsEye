/**
 * Decision audit trail: wallet evaluations, per-buy decisions, and the log-only copyability gate. Synthetic data, an
 * in-memory database and stubbed quotes: nothing here touches the network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { openDb, type DB } from "@godseye/shared";
import type { ParsedSwap } from "../src/chain/parse";
import type { WeightInput } from "../src/learning/weights";
import { passCopyGate } from "./helpers";

process.env.COPY_BUDGET_SOL = "1";
process.env.COPY_MAX_TRADE_SOL = "0.1";
const { rawScore } = await import("../src/learning/weights");
const { runLearning } = await import("../src/learning/loop");
const { gateOf, scoreComponents, explain, stateOf, recordEvaluations, latestEvaluationId } = await import("../src/audit/evaluations");
const { judgeGate, limitsFrom, CopyabilityGate } = await import("../src/audit/gate");
const { DecisionAudit } = await import("../src/audit/decisions");
const { buildAuditReport, formatAuditReport, explainDecision, explainWallet } = await import("../src/audit/report");
const { auditTablesExist, ensureAuditTables } = await import("../src/audit/schema");
const { auditSettings } = await import("../src/audit/settings");
const { CopyEngine } = await import("../src/copy/engine");
const { config } = await import("../src/config");

const T0 = Date.parse("2026-10-20T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
let n = 0;
const mint = () => `Mint${String(++n).padStart(39, "1")}`;
const cfg = { maxLeaders: 10, copyLossDropSol: 0.2, minClosed: 10, minWinRate: 0.5 };
const input = (p: Partial<WeightInput> = {}): WeightInput => ({
  address: "W", tier: "proven", pnl7: 400, pnl30: 1500, closed30: 20, winRate30: 0.6, isFresh: false, copyPnl14: 0, copyClosed14: 0, oldWeight: 0, leadN: 0, leadMedian6h: null, ...p,
});
const history = {
  historyFrom: iso(T0 - 20 * 86_400_000), historyDone: true, txRead: 900, ageIsLowerBound: false, kind: "human", aiScore: 20, txPerHour: 3, bestTradeShare: 0.3,
  medianHoldSec: 600, sameBlockRoundTrips: 0, tierReason: null, lastActivityAt: iso(T0),
};

// ---- wallet evaluations ----

test("the deciding rule and the score components agree with the real weight formula for any input", () => {
  fc.assert(
    fc.property(
      fc.record({
        tier: fc.constantFrom("proven", "unrated", "quitter", "lucky_streak", "needs_attention", "insider"),
        pnl7: fc.double({ min: -500, max: 5000, noNaN: true }),
        pnl30: fc.double({ min: -2000, max: 20000, noNaN: true }),
        closed30: fc.integer({ min: 0, max: 80 }),
        winRate30: fc.option(fc.double({ min: 0, max: 1, noNaN: true }), { nil: null }),
        isFresh: fc.boolean(),
        copyPnl14: fc.double({ min: -2, max: 2, noNaN: true }),
        copyClosed14: fc.integer({ min: 0, max: 10 }),
        leadN: fc.integer({ min: 0, max: 40 }),
        leadMedian6h: fc.option(fc.double({ min: -60, max: 120, noNaN: true }), { nil: null }),
        copyableBuys: fc.option(fc.integer({ min: 0, max: 200 }), { nil: undefined }),
        copyableFrac: fc.double({ min: 0, max: 1, noNaN: true }),
      }),
      ({ copyableFrac, ...r }) => {
        const w = input({ ...r, tier: r.tier as WeightInput["tier"], copyableOk: Math.round((r.copyableBuys ?? 0) * copyableFrac) });
        const c30 = { ...cfg, minCopyableShare: 0.3 };
        const raw = rawScore(w, c30);
        const gate = gateOf(w, c30);
        assert.equal(gate === "ok", raw.weight > 0, `gate ${gate} but weight ${raw.weight}`);
        const c = scoreComponents(w, c30);
        if (gate === "ok") assert.ok(Math.abs(c!.score - raw.weight) <= 1e-9 * Math.max(1, raw.weight));
        else assert.equal(c, null);
      },
    ),
    { numRuns: 300 },
  );
});

test("states: copy when weighted, ignore for quitters and wallets with nothing to judge, block when listed, else watch", () => {
  assert.equal(stateOf(input(), 0.3, false), "copy");
  assert.equal(stateOf(input({ tier: "quitter" }), 0, false), "ignore");
  assert.equal(stateOf(input({ tier: "unrated", closed30: 0 }), 0, false), "ignore");
  assert.equal(stateOf(input({ tier: "unrated", closed30: 4 }), 0, false), "watch");
  assert.equal(stateOf(input({ tier: "lucky_streak" }), 0, false), "watch", "uncertainty isn't proof that a wallet is bad");
  assert.equal(stateOf(input(), 0.3, true), "block");
});

test("an explanation names the deciding rule, evidence both ways, what the data covers and what would change it", () => {
  const w = input({ tier: "unrated", closed30: 4, winRate30: 0.7 });
  const res = rawScore(w, cfg);
  const e = explain(w, res, cfg, { ...history, historyFrom: iso(T0 - 3 * 86_400_000), historyDone: false, kind: "ai", aiScore: 80, medianHoldSec: 8, bestTradeShare: 0.6 }, false, T0);
  assert.equal(e.gate, "few_closed");
  assert.equal(e.state, "watch");
  assert.match(e.reassess, /6 more closed trades/);
  assert.ok(e.evidenceFor.some((x) => /this week/.test(x)));
  assert.ok(e.evidenceAgainst.some((x) => /only 4 closed trades/.test(x)));
  assert.ok(e.evidenceAgainst.some((x) => /covers only 3 days/.test(x)), "a short window is said out loud");
  assert.ok(e.evidenceAgainst.some((x) => /older history has not been read/.test(x)));
  assert.ok(e.evidenceAgainst.some((x) => /behaves like a bot/.test(x)));
  assert.ok(e.evidenceAgainst.some((x) => /median hold 8 s/.test(x)));
  assert.ok(e.evidenceAgainst.some((x) => /60% of all winning trades/.test(x)));
  assert.ok(e.evidenceAgainst.some((x) => /what its buys do next is not measured/.test(x)));
});

test("insiders are explained, not blocked: the state follows the weight, the trade-level caveat is noted", () => {
  const w = input({ tier: "insider" });
  const res = rawScore(w, cfg);
  const e = explain(w, { weight: res.weight, reason: res.reason }, cfg, history, false, T0);
  assert.equal(e.state, "copy");
  assert.ok(e.evidenceAgainst.some((x) => /still copyable by decision/.test(x)));
});

test("a wallet that clears every rule but isn't among the top earners is 'not_in_top'", () => {
  const w = input();
  const e = explain(w, { weight: 0, reason: "x" }, cfg, history, false, T0);
  assert.equal(e.gate, "not_in_top");
  assert.equal(e.state, "watch");
});

function seedWallet(db: DB, address: string, o: { tier?: string; closed?: number; win?: number | null; pnl7?: number; pnl30?: number; weight?: number } = {}) {
  db.prepare("INSERT OR REPLACE INTO wallets (address, first_seen_at, discovered_via, tier, tier_reason, copy_weight, last_activity_at, history_from, history_done) VALUES (?, ?, 'test', ?, 'because', ?, ?, ?, 1)").run(
    address, iso(T0 - 9 * 86_400_000), o.tier ?? "proven", o.weight ?? 0, iso(Date.now()), iso(Date.now() - 8 * 86_400_000),
  );
  db.prepare("INSERT INTO wallet_stats (wallet, computed_at, swaps_total, swaps_7d, swaps_30d, pnl_7d_sol, pnl_30d_sol, pnl_all_sol, pnl_7d_usd, pnl_30d_usd, closed_7d, closed_30d, wins_30d, win_rate_30d) VALUES (?, ?, 40, 10, 40, 1, 5, 5, ?, ?, 5, ?, 12, ?)").run(
    address, iso(Date.now()), o.pnl7 ?? 500, o.pnl30 ?? 2000, o.closed ?? 20, o.win === undefined ? 0.6 : o.win,
  );
}
const evals = (db: DB, wallet?: string) => db.prepare(`SELECT * FROM wallet_evaluations ${wallet ? "WHERE wallet = ?" : ""} ORDER BY id`).all(...(wallet ? [wallet] : [])) as Record<string, any>[];

test("the learning loop leaves an evaluation for each wallet, and nothing more while nothing changes", () => {
  const db = openDb(":memory:");
  seedWallet(db, "GOOD");
  seedWallet(db, "GONE", { tier: "quitter" });
  seedWallet(db, "NEW", { tier: "unrated", closed: 3, win: 0.7 });
  passCopyGate(db);
  runLearning(db);
  const rows = evals(db);
  assert.equal(rows.length, 3);
  const by = Object.fromEntries(rows.map((r) => [r.wallet, r]));
  assert.equal(by.GOOD.state, "copy");
  assert.equal(by.GOOD.gate, "ok");
  assert.ok(by.GOOD.weight > 0);
  assert.equal(by.GONE.state, "ignore");
  assert.equal(by.GONE.gate, "quitter");
  assert.equal(by.NEW.state, "watch");
  assert.equal(by.NEW.gate, "few_closed");
  const inputs = JSON.parse(by.GOOD.inputs);
  assert.equal(inputs.closed30, 20);
  assert.equal(inputs.pnl7, 500);
  assert.equal(JSON.parse(by.GOOD.cutoffs).minClosed, 10);
  assert.ok(JSON.parse(by.GOOD.components).score > 0);
  assert.equal(JSON.parse(by.GOOD.data_quality).historyComplete, true);
  assert.equal(by.GOOD.mode, "paper");
  assert.equal(by.GOOD.changed, 1);

  passCopyGate(db);

  runLearning(db);
  assert.equal(evals(db).length, 3, "same facts, no new rows");
});

test("a changed tier, a crossed rule or a moved weight is written; an unchanged copied wallet is written again only after the heartbeat", () => {
  const db = openDb(":memory:");
  seedWallet(db, "A");
  seedWallet(db, "B", { tier: "unrated", closed: 3, win: 0.7 });
  const mk = (a: WeightInput[]) => {
    const results = new Map(a.map((w) => [w.address, rawScore(w, cfg)]));
    // a single copied wallet takes the whole weight
    for (const [k, v] of results) if (v.weight > 0) results.set(k, { ...v, weight: 1 });
    return { inputs: a, results, cfg, mode: "paper" };
  };
  const a0 = input({ address: "A" });
  const b0 = input({ address: "B", tier: "unrated", closed30: 3 });
  assert.equal(recordEvaluations(db, mk([a0, b0]), T0), 2);
  assert.equal(recordEvaluations(db, mk([a0, b0]), T0 + 60_000), 0);

  // B gets its tenth trade: the deciding rule changes.
  assert.equal(recordEvaluations(db, mk([a0, input({ address: "B", tier: "unrated", closed30: 12 })]), T0 + 120_000), 1);
  assert.equal(evals(db, "B").at(-1)!.state, "copy");
  assert.equal(evals(db, "B").length, 2);

  // A loses its Proven tier.
  recordEvaluations(db, mk([input({ address: "A", tier: "needs_attention" }), b0]), T0 + 180_000);
  assert.equal(evals(db, "A").at(-1)!.tier, "needs_attention");

  // Heartbeat: A (copied) is recorded again a day later, flagged as unchanged; the watched B is not.
  const before = evals(db).length;
  const written = recordEvaluations(db, mk([input({ address: "A", tier: "needs_attention" }), b0]), T0 + 25 * 3_600_000);
  assert.equal(written, 1);
  const last = evals(db, "A").at(-1)!;
  assert.equal(last.changed, 0);
  assert.equal(evals(db).length, before + 1);
  assert.equal(latestEvaluationId(db, "A"), last.id);
  assert.equal(latestEvaluationId(db, "NOBODY"), null);
});

test("a wallet listed in IGNORE_WALLETS is recorded as blocked, and a failure to record never reaches the loop", () => {
  const db = openDb(":memory:");
  seedWallet(db, "BAD");
  const w = input({ address: "BAD" });
  recordEvaluations(db, { inputs: [w], results: new Map([["BAD", { weight: 0.5, reason: "r" }]]), cfg, mode: "paper", blocked: ["BAD"] }, T0);
  assert.equal(evals(db, "BAD")[0].state, "block");
  assert.equal(evals(db, "BAD")[0].gate, "blocked");
  const broken = openDb(":memory:");
  broken.exec("DROP TABLE wallet_stats");
  assert.equal(recordEvaluations(broken, { inputs: [w], results: new Map([["BAD", { weight: 0, reason: "r" }]]), cfg, mode: "paper" }, T0), 0);
});

// ---- the copyability gate ----

const quote = (inSol: number, outTokens: number, impact: string | null, decimals = 6) => ({
  inAmount: String(Math.round(inSol * 1e9)), outAmount: String(Math.round(outTokens * 10 ** decimals)), priceImpactPct: impact, routePlan: [{ swapInfo: { label: "Pump.fun Amm" } }],
});
const limits = limitsFrom({ gateMaxImpactPct: 3, gateMaxDriftPct: 15, gateMaxRoundTripLossPct: 15, gateMaxFeePct: 5 });
const gateInput = (o: Partial<Parameters<typeof judgeGate>[0]> = {}): Parameters<typeof judgeGate>[0] => ({
  sizeSol: 0.1, leaderPriceSol: 0.001, ageSec: 4, ms: 300, decimals: 6, buy: quote(0.1, 100, "0.004"), sell: quote(0.0, 0, null), feeSol: 0.0010, ...o,
});
const sellOut = (sol: number) => ({ inAmount: "100000000", outAmount: String(Math.round(sol * 1e9)), priceImpactPct: "0" });

test("gate: a clean quote at a fair price passes every limit", () => {
  const g = judgeGate(gateInput({ sell: sellOut(0.093) }), limits);
  assert.equal(g.wouldBlock, false);
  assert.equal(g.status, "ok");
  assert.equal(g.quotePriceSol, 0.001);
  assert.equal(g.driftPct, 0);
  assert.ok(Math.abs(g.priceImpactPct! - 0.4) < 1e-9, "Jupiter reports a fraction: 0.004 is 0.4%");
  assert.ok(Math.abs(g.roundTripLossPct! - 7) < 1e-9);
  assert.equal(g.route, "Pump.fun Amm");
  assert.deepEqual(g.checks.map((c) => [c.check, c.result]), [["buy_quote", "pass"], ["price_impact", "pass"], ["entry_drift", "pass"], ["sell_quote", "pass"], ["round_trip", "pass"], ["exit_capacity", "na"], ["fees", "pass"]]);
});

test("gate: each limit blocks on its own, with a reason", () => {
  const impact = judgeGate(gateInput({ buy: quote(0.1, 100, "0.08"), sell: sellOut(0.09) }), limits);
  assert.equal(impact.wouldBlock, true);
  assert.match(impact.wouldBlockReasons.join(), /price impact 8\.00%/);

  const drift = judgeGate(gateInput({ buy: quote(0.1, 80, "0.001"), sell: sellOut(0.09) }), limits); // 0.00125 vs 0.001 paid
  assert.ok(Math.abs(drift.driftPct! - 25) < 1e-9);
  assert.match(drift.wouldBlockReasons.join(), /25\.0% above the leader's/);

  const trap = judgeGate(gateInput({ sell: sellOut(0.01) }), limits);
  assert.equal(trap.wouldBlock, true);
  assert.match(trap.wouldBlockReasons.join(), /loses 90\.0%/);

  const fees = judgeGate(gateInput({ sizeSol: 0.01, feeSol: 0.001, sell: sellOut(0.0093) }), limits);
  assert.ok(Math.abs(fees.feePct - 10) < 1e-9);
  assert.match(fees.wouldBlockReasons.join(), /fees up to 10\.0%/);
});

test("gate: a drained pool shows as 100% impact, and a missing quote is never permission", () => {
  const drained = judgeGate(gateInput({ buy: quote(0.1, 100, "1"), sell: sellOut(0.0001) }), limits);
  assert.equal(drained.priceImpactPct, 100);
  assert.equal(drained.wouldBlock, true);

  const noBuy = judgeGate(gateInput({ buy: null, sell: null, buyError: "No routes found" }), limits);
  assert.equal(noBuy.wouldBlock, true);
  assert.equal(noBuy.status, "incomplete");
  assert.deepEqual(noBuy.wouldBlockReasons, ["no buy quote"].concat(noBuy.wouldBlockReasons.slice(1)));
  assert.equal(noBuy.checks.find((c) => c.check === "buy_quote")!.detail, "No routes found");
  assert.equal(noBuy.checks.find((c) => c.check === "round_trip")!.result, "na");

  const noSell = judgeGate(gateInput({ sell: null, sellError: "429 Too Many Requests" }), limits);
  assert.equal(noSell.wouldBlock, true);
  assert.match(noSell.wouldBlockReasons.join(), /no sell quote/);

  const unknownImpact = judgeGate(gateInput({ buy: quote(0.1, 100, null), sell: sellOut(0.09) }), limits);
  assert.match(unknownImpact.wouldBlockReasons.join(), /price impact unknown/);
});

const settings = (o: Partial<typeof auditSettings> = {}) => ({ ...auditSettings, gateEnabled: true, gateConcurrency: 1, gateMaxQueue: 1, gateMinGapSeconds: 300, gateTimeoutMs: 200, gateMinSpacingMs: 0, gateRateLimitPauseSeconds: 60, ...o });
const req = (m = mint()) => ({ mint: m, sizeSol: 0.1, leaderPriceSol: 0.001, leaderTs: iso(Date.now() - 4000) });
function fakeDeps(o: { delay?: number; failSell?: boolean; noDecimals?: boolean } = {}) {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      decimals: async () => (o.noDecimals ? undefined : 6),
      quote: async (inMint: string, outMint: string, amount: bigint) => {
        calls.push(`${inMint === "So11111111111111111111111111111111111111112" ? "buy" : "sell"} ${amount}`);
        if (o.delay) await new Promise((r) => setTimeout(r, o.delay));
        if (inMint === "So11111111111111111111111111111111111111112") return quote(Number(amount) / 1e9, 100, "0.004");
        if (o.failSell) throw new Error("400 Bad Request: COULD_NOT_FIND_ANY_ROUTE");
        return sellOut(0.094);
      },
    },
  };
}

test("gate: quotes a buy at our size, then sells back exactly what it would return", async () => {
  const f = fakeDeps();
  const gate = new CopyabilityGate(f.deps, settings());
  const r = await gate.run(req());
  assert.ok("checks" in r);
  assert.deepEqual(f.calls, ["buy 100000000", `sell ${100 * 1e6}`]);
  assert.equal((r as { wouldBlock: boolean }).wouldBlock, false);
  assert.ok((r as { ageSec: number }).ageSec >= 3.9);
});

test("gate: a failing sell quote, unknown decimals and a hung quote all come back as results, not exceptions", async () => {
  const noRoute = await new CopyabilityGate(fakeDeps({ failSell: true }).deps, settings()).run(req());
  assert.ok("checks" in noRoute);
  assert.equal((noRoute as { wouldBlock: boolean }).wouldBlock, true);
  assert.match((noRoute as { error?: string }).error ?? "", /COULD_NOT_FIND_ANY_ROUTE/);

  const noDec = await new CopyabilityGate(fakeDeps({ noDecimals: true }).deps, settings()).run(req());
  assert.equal((noDec as { wouldBlock: boolean }).wouldBlock, true);
  assert.equal((noDec as { error?: string }).error, "token decimals unknown");

  const hung = await new CopyabilityGate(fakeDeps({ delay: 2000 }).deps, settings({ gateTimeoutMs: 30 })).run(req());
  assert.match((hung as { error?: string }).error ?? "", /timed out/);
  assert.equal((hung as { wouldBlock: boolean }).wouldBlock, true);
});

test("gate: quotes are spaced, and a 'too many requests' answer makes the gate stand down so it can't crowd out the real buy", async () => {
  const stamps: number[] = [];
  const spaced = new CopyabilityGate(
    { decimals: async () => 6, quote: async (i: string) => { stamps.push(Date.now()); return i === "So11111111111111111111111111111111111111112" ? quote(0.1, 100, "0.004") : sellOut(0.094); } },
    settings({ gateMinSpacingMs: 120 }),
  );
  await spaced.run(req());
  assert.equal(stamps.length, 2);
  assert.ok(stamps[1] - stamps[0] >= 110, "the sell quote waits for the spacing");

  let calls = 0;
  const busy = new CopyabilityGate(
    { decimals: async () => 6, quote: async () => { calls++; throw new Error('429  from lite-api.jup.ag: {"code":429,"message":"[API Gateway] Too many requests"}'); } },
    settings(),
  );
  const first = await busy.run(req());
  assert.ok("checks" in first);
  assert.equal((first as { wouldBlock: boolean }).wouldBlock, true, "an unavailable quote is still not permission");
  assert.deepEqual(await busy.run(req()), { skipped: "rate_limited" });
  assert.equal(calls, 1, "no further quotes while it stands down");
  assert.ok("checks" in (await busy.run(req(), Date.now() + 61_000)), "and it tries again afterwards");
});

test("gate: one token is quoted once per gap, a full queue is skipped, and it can be switched off", async () => {
  const gate = new CopyabilityGate(fakeDeps({ delay: 60 }).deps, settings());
  const m = mint();
  const t = Date.now();
  const first = gate.run(req(m), t);
  assert.deepEqual(await gate.run(req(m), t + 1000), { skipped: "throttled" });
  const second = gate.run(req(), t); // waits for the one slot
  assert.deepEqual(await gate.run(req(), t), { skipped: "queue_full" });
  assert.ok("checks" in (await first));
  assert.ok("checks" in (await second));
  assert.ok("checks" in (await gate.run(req(m), t + 301_000)), "after the gap it is quoted again");
  assert.deepEqual(await new CopyabilityGate(fakeDeps().deps, settings({ gateEnabled: false })).run(req()), { skipped: "disabled" });
});

// ---- decisions, through the real copy engine ----

const swap = (p: Partial<ParsedSwap> = {}): ParsedSwap => ({
  wallet: "LEADER", signature: `sig${++n}`, slot: 1, ts: new Date().toISOString(), mint: mint(), side: "buy", tokenAmount: 1000, tokenBalanceBefore: 0,
  solAmount: 1, priceSol: 0.001, venue: "pumpswap", jitoTip: false, feeLamports: 5000, quote: "SOL", quoteAmount: 1, solUsd: 150, usdAmount: 150, ...p,
});
const token = (db: DB, m: string, symbol = "MOO") =>
  db.prepare("INSERT OR REPLACE INTO token_info (mint, symbol, decimals, pool_created_at, checked_at) VALUES (?, ?, 6, '2026-01-01T00:00:00Z', ?)").run(m, symbol, new Date().toISOString());
const paper = {
  mode: "paper" as const,
  buy: async () => ({ signature: null, solAmount: 0.1, tokenAmount: 100, priceSol: 0.001 }),
  sell: async () => ({ signature: null, solAmount: 0, tokenAmount: 0, priceSol: 0 }),
};
function engine(o: { gate?: InstanceType<typeof CopyabilityGate> | null; weight?: number } = {}) {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO wallets (address, first_seen_at, discovered_via, copy_weight) VALUES ('LEADER', ?, 'test', ?)").run(iso(Date.now()), o.weight ?? 0.5);
  const audit = new DecisionAudit(db, o.gate ?? null);
  return { db, audit, eng: new CopyEngine(db, paper, null, null, audit) };
}
const decisions = (db: DB) => db.prepare("SELECT * FROM copy_decisions ORDER BY id").all() as Record<string, any>[];
const checksOf = (d: Record<string, any>) => JSON.parse(d.checks) as { check: string; result: string; detail?: string }[];

test("a bought copy records every check that ran, in order, with the fill and the leader's evaluation", async () => {
  const { db, eng } = engine();
  seedWallet(db, "LEADER", { weight: 0.5 });
  passCopyGate(db);
  runLearning(db); // gives the leader an evaluation row
  const s = swap();
  token(db, s.mint);
  await eng.onLeaderSwap(s, Date.now());
  const [d] = decisions(db);
  assert.equal(d.outcome, "bought");
  assert.equal(d.mode, "paper");
  assert.equal(d.leader_signature, s.signature);
  assert.equal(d.size_sol, 0.1);
  assert.equal(d.leader_price_sol, 0.001);
  assert.ok(d.lateness_sec >= 0 && d.lateness_sec < 5);
  assert.deepEqual(checksOf(d).map((c) => c.check), ["memecoin", "lateness", "limits", "execution"]);
  assert.ok(checksOf(d).every((c) => c.result === "pass"));
  assert.equal(d.wallet_eval_id, latestEvaluationId(db, "LEADER"));
  assert.ok(d.wallet_eval_id);
  assert.equal(d.copy_trade_id, (db.prepare("SELECT id FROM copy_trades WHERE leader_signature = ?").get(s.signature) as { id: number }).id);
});

test("a skip records the check that stopped it, even when copy_trades throttles the row", async () => {
  const { db, eng } = engine();
  const late = swap({ ts: iso(Date.now() - 120_000) });
  token(db, late.mint);
  await eng.onLeaderSwap(late, Date.now());
  const d1 = decisions(db)[0];
  assert.equal(d1.outcome, "skipped:late");
  assert.deepEqual(checksOf(d1).map((c) => [c.check, c.result]), [["memecoin", "pass"], ["late", "fail"]]);
  assert.match(checksOf(d1)[1].detail!, /seen 120s after the leader traded/);

  // Budget nearly used up: every further skip of this kind is throttled in copy_trades but still audited.
  db.prepare("INSERT INTO positions (mint, symbol, leader, mode, status, token_amount, tokens_bought, cost_sol, entry_price_sol, opened_at) VALUES ('HELD', 'H', 'LEADER', 'paper', 'open', 1, 1, 0.995, 0.001, ?)").run(iso(Date.now()));
  for (let i = 0; i < 3; i++) {
    const s = swap();
    token(db, s.mint);
    await eng.onLeaderSwap(s, Date.now());
  }
  const rest = decisions(db).slice(1);
  assert.deepEqual(rest.map((d) => d.outcome), ["skipped:budget", "skipped:budget", "skipped:budget"]);
  assert.ok((db.prepare("SELECT COUNT(*) n FROM copy_trades WHERE reason LIKE '%budget%'").get() as { n: number }).n <= 1, "copy_trades keeps one of them");

  // A weight too small for the minimum trade is also on record, not a silent return.
  const tiny = engine({ weight: 0.005 });
  const ts = swap();
  token(tiny.db, ts.mint);
  await tiny.eng.onLeaderSwap(ts, Date.now());
  assert.equal(decisions(tiny.db)[0].outcome, "skipped:size");
  assert.match(checksOf(decisions(tiny.db)[0]).at(-1)!.detail!, /less than the minimum trade/);
});

test("a blocked rug verdict is one failed check with the reasons, and the verdict is kept", async () => {
  const { db, eng } = engine();
  const s = swap();
  token(db, s.mint);
  db.prepare("INSERT INTO rug_checks (mint, symbol, verdict, blocks, warnings, rugcheck_score, checked_at) VALUES (?, 'MOO', 'blocked', ?, '[]', 90, ?)").run(s.mint, JSON.stringify(["top 10 holders hold 70%"]), new Date().toISOString());
  config.rugCheckEnabled = true;
  try {
    await eng.onLeaderSwap(s, Date.now());
  } finally {
    config.rugCheckEnabled = false;
  }
  const [d] = decisions(db);
  assert.equal(d.outcome, "skipped:rug");
  const rugChecks = checksOf(d).filter((c) => c.check.startsWith("rug"));
  assert.deepEqual(rugChecks.map((c) => [c.check, c.result, c.detail]), [["rug_screen", "fail", "top 10 holders hold 70%"]]);
  assert.equal(JSON.parse(d.rug).verdict, "blocked");
});

test("a second leader buying a token we hold is recorded, not silently dropped; non-memecoins and small buys are not candidates", async () => {
  const { db, eng } = engine();
  const first = swap();
  token(db, first.mint);
  await eng.onLeaderSwap(first, Date.now());
  const again = swap({ mint: first.mint });
  await eng.onLeaderSwap(again, Date.now());
  const d = decisions(db).find((x) => x.leader_signature === again.signature)!;
  assert.equal(d.outcome, "ignored:holding");
  assert.equal(checksOf(d).at(-1)!.check, "not_holding");

  const sol = swap({ mint: "So11111111111111111111111111111111111111112" });
  token(db, sol.mint, "SOL");
  await eng.onLeaderSwap(sol, Date.now());
  const small = swap({ solAmount: 0.05 });
  token(db, small.mint);
  await eng.onLeaderSwap(small, Date.now());
  assert.equal(decisions(db).filter((x) => x.mint === sol.mint || x.mint === small.mint).length, 0);

  await eng.onLeaderSwap(first, Date.now()); // the same signature seen twice (stream and poll): still one row
  assert.equal(decisions(db).filter((x) => x.leader_signature === first.signature).length, 1);
});

test("a failed buy is recorded with its error", async () => {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO wallets (address, first_seen_at, discovered_via, copy_weight) VALUES ('LEADER', ?, 'test', 0.5)").run(iso(Date.now()));
  const failing = { ...paper, buy: async () => { throw new Error("slippage exceeded"); } };
  const audit = new DecisionAudit(db, null);
  const eng = new CopyEngine(db, failing, null, null, audit);
  const s = swap();
  token(db, s.mint);
  await eng.onLeaderSwap(s, Date.now());
  const [d] = decisions(db);
  assert.equal(d.outcome, "buy_failed");
  assert.deepEqual(checksOf(d).at(-1), { check: "execution", result: "error", detail: "slippage exceeded" });
});

test("the gate runs on every candidate, with an empty wallet too, and its result lands on the decision whichever finishes first", async () => {
  // Gate slower than the decision: the row is written first and updated when the quotes return.
  const slow = new CopyabilityGate(fakeDeps({ delay: 80 }).deps, settings({ gateConcurrency: 4, gateMaxQueue: 10, gateTimeoutMs: 1000 }));
  const a = engine({ gate: slow });
  const s1 = swap();
  token(a.db, s1.mint);
  await a.eng.onLeaderSwap(s1, Date.now());
  assert.equal(decisions(a.db)[0].gate_status, "pending");
  await new Promise((r) => setTimeout(r, 300));
  const done = decisions(a.db)[0];
  assert.equal(done.gate_status, "done");
  const g = JSON.parse(done.gate);
  assert.equal(g.sizeSol, 0.1);
  assert.equal(g.wouldBlock, false);
  assert.equal(g.checks.length, 7, "six off the quotes, and the exit-capacity check (not applicable without pool reads)");

  // Gate faster than the decision: its result is already there when the row is written.
  const fast = new CopyabilityGate(fakeDeps().deps, settings({ gateConcurrency: 4, gateMaxQueue: 10 }));
  const b = engine({ gate: fast });
  const s2 = swap({ ts: iso(Date.now() - 120_000) }); // skipped as late, long after the quotes could return
  token(b.db, s2.mint);
  b.audit.begin(s2, Date.now(), 0.5);
  b.audit.candidate(s2, "MOO");
  await new Promise((r) => setTimeout(r, 50));
  b.audit.skipped(s2, "late", "too late");
  const row = decisions(b.db)[0];
  assert.equal(row.gate_status, "done");
  assert.equal(JSON.parse(row.gate).status, "ok");

  // Throttled for the same token soon after: the row says why no gate ran.
  const s3 = swap({ mint: s2.mint });
  b.audit.begin(s3, Date.now(), 0.5);
  b.audit.candidate(s3, "MOO");
  await new Promise((r) => setTimeout(r, 20));
  b.audit.skipped(s3, "late", "too late");
  const third = decisions(b.db).at(-1)!;
  assert.equal(third.gate_status, "skipped");
  assert.deepEqual(JSON.parse(third.gate), { skipped: "throttled" });
});

test("a buy the engine never finishes still gets a row, and a gate that throws is recorded as an error", async () => {
  const db = openDb(":memory:");
  const throwing = { run: async () => { throw new Error("boom"); } } as unknown as InstanceType<typeof CopyabilityGate>;
  const audit = new DecisionAudit(db, throwing);
  const s = swap();
  audit.begin(s, Date.now(), 0.5);
  audit.candidate(s, "MOO");
  await new Promise((r) => setTimeout(r, 20));
  audit.close(s);
  const [d] = decisions(db);
  assert.equal(d.outcome, "skipped:undecided");
  assert.equal(d.gate_status, "error");
  assert.deepEqual(JSON.parse(d.gate), { error: "boom" });
  audit.close(s); // closing twice adds nothing
  assert.equal(decisions(db).length, 1);
});

// ---- reading it back ----

test("the report counts outcomes and failed checks, and the explanations read like the decision they describe", async () => {
  const gate = new CopyabilityGate(fakeDeps({ failSell: true }).deps, settings({ gateConcurrency: 4, gateMaxQueue: 10 }));
  const { db, eng } = engine({ gate });
  seedWallet(db, "LEADER", { weight: 0.5 });
  passCopyGate(db);
  runLearning(db);
  const ok = swap();
  const late = swap({ ts: iso(Date.now() - 120_000) });
  for (const s of [ok, late]) {
    token(db, s.mint);
    await eng.onLeaderSwap(s, Date.now());
  }
  await new Promise((r) => setTimeout(r, 100));

  const r = buildAuditReport(db, Date.now() - 86_400_000);
  assert.equal(r.decisions, 2);
  assert.deepEqual(r.byOutcome, { bought: 1, "skipped:late": 1 });
  assert.equal(r.failedChecks.late, 1);
  assert.equal(r.gate.wouldBlock, 2, "no sell route in this stub, so both would have been blocked");
  assert.equal(r.gate.byReason.sell_quote, 2);
  assert.equal(r.wallets.byState.copy, 1);
  const text = formatAuditReport(r);
  assert.match(text, /COPY DECISIONS: 2/);
  assert.match(text, /log-only: it changed no decision/);
  assert.match(text, /would have blocked 2/);
  assert.match(text, /nothing settled yet/);

  const why = explainDecision(db, late.signature);
  assert.match(why, /SKIPPED:LATE/);
  assert.match(why, /✗ late: seen 120s after the leader traded/);
  assert.match(why, /gate \(log-only\): WOULD BLOCK/);
  assert.match(explainDecision(db, ok.mint), /BOUGHT/);
  assert.match(explainDecision(db, "nothing"), /No decision recorded/);

  const wallet = explainWallet(db, "LEADER");
  assert.match(wallet, /COPY {2}rule: ok/);
  assert.match(wallet, /\+ .*this week/);
  assert.match(wallet, /would change with:/);
  assert.match(explainWallet(db, "NOBODY"), /No evaluations recorded/);
});

test("with no audit tables or no rows the report says so instead of failing", () => {
  const bare = openDb(":memory:");
  assert.equal(auditTablesExist(bare), false);
  assert.equal(buildAuditReport(bare, 0).decisions, 0);
  assert.match(explainDecision(bare, "x"), /No audit trail yet/);
  ensureAuditTables(bare);
  assert.equal(auditTablesExist(bare), true);
  assert.match(formatAuditReport(buildAuditReport(bare, 0)), /Nothing recorded yet/);
});
