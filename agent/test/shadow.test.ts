/**
 * Shadow log: candidates, the screen's raw inputs, follow-up samples, labels and the report. Synthetic data, an in-memory
 * database and stubbed screens, prices and quotes: nothing here touches the network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, type DB } from "@godseye/shared";
import type { ParsedSwap } from "../src/chain/parse";
import type { Screen } from "../src/market/rugcheck";
import type { PriceQuote } from "../src/market/prices";

process.env.RUG_CHECK_ENABLED = "false";
process.env.SHADOW_MAX_SCREENS = "1";
process.env.SHADOW_MAX_QUEUE = "1";
process.env.COPY_MAX_TRADE_SOL = "0.1";
process.env.COPY_BUDGET_SOL = "1";
const { ShadowLogger, screenStatusOf } = await import("../src/shadow/log");
const { sampleDue, HORIZONS_SEC, lateToleranceSec } = await import("../src/shadow/sampler");
const { labelOutcome, wilson, isTransientQuoteError } = await import("../src/shadow/labels");
const { buildReport, formatReport } = await import("../src/shadow/report");
const { CopyEngine } = await import("../src/copy/engine");
const { rugcheckFacts, saveVerdict, screenToken } = await import("../src/market/rugcheck");

const T0 = Date.parse("2026-10-20T12:00:00.000Z");
const SOL = "So11111111111111111111111111111111111111112";
let n = 0;
const mint = () => `Mint${String(++n).padStart(39, "1")}`;
const swap = (p: Partial<ParsedSwap> = {}): ParsedSwap => ({
  wallet: "LEADER", signature: `sig${++n}`, slot: 1, ts: new Date(T0).toISOString(), mint: mint(), side: "buy", tokenAmount: 1000, tokenBalanceBefore: 0,
  solAmount: 1, priceSol: 0.001, venue: "pumpswap", jitoTip: false, feeLamports: 5000, quote: "SOL", quoteAmount: 1, solUsd: 150, usdAmount: 150, ...p,
});

const cleanScreen = (over: Partial<Screen> = {}): Screen => ({
  onchain: { mintAuthority: null, freezeAuthority: null, extensions: [{ extension: "transferHook", state: { programId: "Hook" } }] },
  rc: { score_normalised: 12, risks: [], markets: [{ marketType: "pump_fun_amm", lp: { lpLockedPct: 100, quoteUSD: 1000, baseUSD: 1000 } }] },
  holders: { launchBundlePct: 31, launchBuyers: 4, clusterPct: 18, clusterSize: 3, clusterFromCreator: false, top10Pct: 42, insiderPct: null },
  holdersStatus: "ok",
  verdict: { verdict: "pass", blocks: [], warnings: ["has a transfer hook"], rugcheckScore: 12 },
  chainMs: 40, rugcheckMs: 300, holdersMs: 900,
  ...over,
});

function setup(screen: (m: string) => Promise<Screen> = async () => cleanScreen()) {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO wallets (address, first_seen_at, discovered_via, copy_weight) VALUES ('LEADER', ?, 'test', 0.5)").run(new Date(T0).toISOString());
  return { db, log: new ShadowLogger(db, screen) };
}
const count = (db: DB, sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as { n: number }).n;
const row = (db: DB, m: string) => db.prepare("SELECT * FROM shadow_candidates WHERE mint = ?").get(m) as Record<string, any>;

test("a copyable buy is logged once per token, with the leader's price and the age of the token", async () => {
  const { db, log } = setup();
  const m = mint();
  db.prepare("INSERT INTO token_info (mint, symbol, decimals, pool_created_at, checked_at) VALUES (?, 'MOO', 6, ?, ?)").run(m, new Date(T0 - 90_000).toISOString(), new Date(T0).toISOString());
  const s = swap({ mint: m });
  const id = log.observe(s, T0 + 2_000, 0.5, "MOO");
  assert.ok(id);
  assert.equal(log.observe(swap({ mint: m, signature: "another" }), T0 + 9_000, 0.5, "MOO"), null, "second buy of the same token adds nothing");
  await log.idle();
  const r = row(db, m);
  assert.equal(r.symbol, "MOO");
  assert.equal(r.leader_signature, s.signature);
  assert.equal(r.entry_price_sol, 0.001);
  assert.equal(r.entry_price_usd, 0.15);
  assert.equal(r.token_age_sec, 90);
  assert.equal(r.venue, "pumpswap");
  assert.equal(r.sim_size_sol, 0.1, "size a copy would have had: weight × budget, capped at the per-trade maximum");
  assert.equal(r.seen_at, new Date(T0 + 2_000).toISOString());
  assert.equal(JSON.parse(r.limits).top10MaxPct, 50, "the cutoffs in force are kept with the row");
  assert.equal(count(db, "SELECT COUNT(*) n FROM shadow_candidates"), 1);
});

test("the screen's raw inputs and verdict are stored, and the verdict warms the rug-check cache", async () => {
  const { db, log } = setup();
  const s = swap();
  log.observe(s, T0, 0.5, "MOO");
  await log.idle();
  const r = row(db, s.mint);
  assert.equal(r.screen_status, "done");
  assert.equal(r.verdict, "pass");
  assert.equal(r.top10_pct, 42);
  assert.equal(r.launch_bundle_pct, 31);
  assert.equal(r.cluster_pct, 18);
  assert.equal(r.cluster_size, 3);
  assert.equal(r.cluster_from_creator, 0);
  assert.equal(r.insider_pct, null);
  assert.equal(r.rugcheck_ok, 1);
  assert.equal(r.rugcheck_score, 12);
  assert.equal(r.rugcheck_pools, 1);
  assert.equal(r.lp_locked_pct, 100);
  assert.equal(r.mint_authority, null);
  assert.deepEqual(JSON.parse(r.extensions), [{ extension: "transferHook", state: { programId: "Hook" } }]);
  assert.deepEqual([r.chain_ms, r.rugcheck_ms, r.holders_ms], [40, 300, 900]);
  assert.ok(r.screen_ms >= 0 && r.screened_at);
  const cached = db.prepare("SELECT verdict FROM rug_checks WHERE mint = ?").get(s.mint) as { verdict: string };
  assert.equal(cached.verdict, "pass");
});

test("an incomplete screen keeps what it read but gives no verdict, as the live path would not trade it either", async () => {
  const unreadable = setup(async () => cleanScreen({ onchain: null, rc: null, holders: null, verdict: null }));
  const a = swap();
  unreadable.log.observe(a, T0, 0.5, "A");
  await unreadable.log.idle();
  assert.equal(row(unreadable.db, a.mint).screen_status, "chain_unreadable");
  assert.equal(row(unreadable.db, a.mint).verdict, null);
  assert.equal(count(unreadable.db, "SELECT COUNT(*) n FROM rug_checks"), 0);

  const slow = setup(async () => cleanScreen({ holders: null, holdersStatus: "timeout", verdict: { verdict: "blocked", blocks: ["creator can mint more tokens (mint authority)"], warnings: [], rugcheckScore: null } }));
  const b = swap();
  slow.log.observe(b, T0, 0.5, "B");
  await slow.log.idle();
  const r = row(slow.db, b.mint);
  assert.equal(r.screen_status, "holders_timeout");
  assert.equal(r.verdict, null, "no verdict from half a screen");
  assert.match(r.blocks, /mint authority/, "but the on-chain block it did find is kept");
  assert.equal(r.top10_pct, null);
  assert.equal(count(slow.db, "SELECT COUNT(*) n FROM rug_checks"), 0, "a half screen isn't cached as a verdict");

  assert.equal(screenStatusOf(cleanScreen({ holdersStatus: "failed" })), "holders_failed");
  assert.equal(screenStatusOf(cleanScreen({ holdersStatus: "off" })), "done");
});

test("a screen that throws is recorded as an error, and never reaches the caller", async () => {
  const { db, log } = setup(async () => {
    throw new Error("rpc down");
  });
  const s = swap();
  assert.doesNotThrow(() => log.observe(s, T0, 0.5, "X"));
  await log.idle();
  assert.equal(row(db, s.mint).screen_status, "error");
});

test("when screens back up, extra candidates are still logged, marked queue_full", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const { db, log } = setup(async () => {
    await gate;
    return cleanScreen();
  });
  const [a, b, c] = [swap(), swap(), swap()];
  for (const s of [a, b, c]) log.observe(s, T0, 0.5, "X");
  assert.equal(row(db, c.mint).screen_status, "queue_full", "1 running + 1 waiting is the limit set above");
  release();
  await log.idle();
  assert.equal(row(db, a.mint).screen_status, "done");
  assert.equal(row(db, b.mint).screen_status, "done");
  assert.equal(row(db, c.mint).entry_price_sol, 0.001, "still a candidate, with its follow-up to come");
});

test("the copy engine logs a buy it then skips, and records why", async () => {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO wallets (address, first_seen_at, discovered_via, copy_weight) VALUES ('LEADER', ?, 'test', 0.5)").run(new Date().toISOString());
  const log = new ShadowLogger(db, async () => cleanScreen());
  const ex = { mode: "paper" as const, buy: async () => ({ signature: null, solAmount: 0.1, tokenAmount: 100, priceSol: 0.001 }), sell: async () => ({ signature: null, solAmount: 0, tokenAmount: 0, priceSol: 0 }) };
  const engine = new CopyEngine(db, ex, null, log);
  const m = mint();
  db.prepare("INSERT INTO token_info (mint, symbol, decimals, pool_created_at, checked_at) VALUES (?, 'MOO', 6, '2026-01-01T00:00:00Z', ?)").run(m, new Date().toISOString());

  const late = swap({ mint: m, ts: new Date(Date.now() - 120_000).toISOString() });
  await engine.onLeaderSwap(late, Date.now());
  await log.idle();
  assert.equal(row(db, m).copy_outcome, "late");
  assert.equal((db.prepare("SELECT status FROM copy_trades WHERE mint = ?").get(m) as { status: string }).status, "skipped");

  const fresh = swap({ mint: mint(), ts: new Date().toISOString() });
  db.prepare("INSERT INTO token_info (mint, symbol, decimals, pool_created_at, checked_at) VALUES (?, 'NEW', 6, '2026-01-01T00:00:00Z', ?)").run(fresh.mint, new Date().toISOString());
  await engine.onLeaderSwap(fresh, Date.now());
  await log.idle();
  assert.equal(row(db, fresh.mint).copy_outcome, "bought");
  assert.equal(row(db, fresh.mint).screen_status, "done", "screened even though the engine's own rug check was off");

  const notMeme = swap({ mint: "So11111111111111111111111111111111111111112" });
  db.prepare("INSERT INTO token_info (mint, symbol, decimals, pool_created_at, checked_at) VALUES (?, 'SOL', 9, '2026-01-01T00:00:00Z', ?)").run(notMeme.mint, new Date().toISOString());
  await engine.onLeaderSwap(notMeme, Date.now());
  assert.equal(count(db, "SELECT COUNT(*) n FROM shadow_candidates WHERE mint = ?", notMeme.mint), 0, "non-memecoins aren't candidates");
});

test("the screen is the same one the live path caches from, and two callers share one look", async () => {
  const a = screenToken("DoesNotExist1111111111111111111111111111111");
  const b = screenToken("DoesNotExist1111111111111111111111111111111");
  assert.equal(a, b, "same in-flight look");
  const s = await a;
  assert.equal(s.onchain, null, "no network in tests: unreadable");
  assert.equal(s.verdict, null);
  const facts = rugcheckFacts({ score_normalised: 80, markets: [{ lp: { lpLockedPct: 0, quoteUSD: 1, baseUSD: 1 } }, { lp: null }] });
  assert.deepEqual(facts, { ok: true, score: 80, pools: 1, lockedPct: 0 });
  assert.deepEqual(rugcheckFacts(null), { ok: false, score: null, pools: 0, lockedPct: null });
  const db = openDb(":memory:");
  saveVerdict(db, "M", "SYM", { verdict: "blocked", blocks: ["x"], warnings: [], rugcheckScore: 90 }, false);
  assert.equal((db.prepare("SELECT verdict FROM rug_checks WHERE mint = 'M'").get() as { verdict: string }).verdict, "blocked");
});

// ---- sampler ----

function candidate(db: DB, p: { seenAt: number; entrySol?: number; entryUsd?: number; size?: number | null; mint?: string }) {
  const m = p.mint ?? mint();
  const id = Number(
    db
      .prepare(
        `INSERT INTO shadow_candidates (mint, symbol, leader, leader_signature, leader_ts, seen_at, leader_sol, entry_price_sol, entry_price_usd, sim_size_sol)
         VALUES (?, 'X', 'LEADER', ?, ?, ?, 1, ?, ?, ?)`,
      )
      .run(m, `s${++n}`, new Date(p.seenAt).toISOString(), new Date(p.seenAt).toISOString(), p.entrySol ?? 0.001, p.entryUsd ?? 0.15, p.size === undefined ? 0.1 : p.size).lastInsertRowid,
  );
  return { id, mint: m };
}
const samples = (db: DB, id: number) => db.prepare("SELECT * FROM shadow_samples WHERE candidate_id = ? ORDER BY horizon_sec").all(id) as Record<string, any>[];

function deps(over: Record<string, any> = {}) {
  const calls = { prices: 0, quotes: [] as { mint: string; tokens: number; decimals: number }[], rugchecks: 0 };
  return {
    calls,
    d: {
      prices: async (mints: string[]) => {
        calls.prices++;
        return new Map<string, PriceQuote>(mints.map((m) => [m, { priceUsd: 0.12, source: "jupiter" as const, decimals: 6, liquidityUsd: 5000 }]));
      },
      sellQuoteSol: async (m: string, tokens: number, decimals: number) => {
        calls.quotes.push({ mint: m, tokens, decimals });
        return 0.09;
      },
      decimals: async () => 6,
      rugcheck: async () => {
        calls.rugchecks++;
        return { score_normalised: 5, markets: [{ lp: { lpLockedPct: 100, quoteUSD: 1, baseUSD: 1 } }] };
      },
      ...over,
    },
  };
}

test("sampler: nothing is taken before a mark is due; a due mark is priced, quoted for a copy-sized sell, and not repeated", async () => {
  const { db } = setup();
  const c = candidate(db, { seenAt: T0 });
  const { d, calls } = deps();
  assert.equal(await sampleDue(db, T0 + 30_000, d), 0);
  assert.equal(calls.prices, 0);

  assert.equal(await sampleDue(db, T0 + 61_000, d), 1);
  const [s] = samples(db, c.id);
  assert.equal(s.horizon_sec, 60);
  assert.equal(s.status, "ok");
  assert.equal(s.price_usd, 0.12);
  assert.equal(s.price_source, "jupiter");
  assert.equal(s.liquidity_usd, 5000);
  assert.equal(s.sell_quote_sol, 0.09);
  assert.equal(calls.quotes[0].tokens, 100, "0.1 SOL at 0.001 SOL per token");
  assert.equal(calls.quotes[0].decimals, 6);
  assert.equal(s.rugcheck_ok, 1, "RugCheck is asked again at the first marks");
  assert.equal(s.rugcheck_pools, 1);
  assert.equal(await sampleDue(db, T0 + 62_000, d), 0, "already taken");
  assert.equal(samples(db, c.id).length, 1);
});

test("sampler: RugCheck is only re-asked at the first two marks", async () => {
  const { db } = setup();
  const c = candidate(db, { seenAt: T0 });
  const { d, calls } = deps();
  await sampleDue(db, T0 + 60_000, d);
  await sampleDue(db, T0 + 300_000, d);
  await sampleDue(db, T0 + 900_000, d);
  assert.equal(calls.rugchecks, 2);
  const rows = samples(db, c.id);
  assert.deepEqual(rows.map((r) => r.horizon_sec), [60, 300, 900]);
  assert.equal(rows[2].rugcheck_ok, null);
});

test("sampler: a token nobody quotes is a no_price result, a failed sell quote keeps its reason, and neither stops the rest", async () => {
  const { db } = setup();
  const c = candidate(db, { seenAt: T0 });
  const { d } = deps({
    prices: async () => new Map([[SOL, { priceUsd: 150, source: "jupiter" as const }]]), // SOL is priced, this token is not
    sellQuoteSol: async () => {
      throw new Error("400 Bad Request from lite-api.jup.ag: COULD_NOT_FIND_ANY_ROUTE");
    },
  });
  await sampleDue(db, T0 + 61_000, d);
  const [s] = samples(db, c.id);
  assert.equal(s.status, "no_price");
  assert.equal(s.price_usd, null);
  assert.equal(s.sell_quote_sol, null);
  assert.match(s.sell_quote_error, /COULD_NOT_FIND_ANY_ROUTE/);
});

test("sampler: when the price sources themselves are down nothing is recorded as 'no price', and the mark is retried", async () => {
  const { db } = setup();
  const c = candidate(db, { seenAt: T0 });
  const down = deps({ prices: async () => new Map() }); // not even SOL comes back
  assert.equal(await sampleDue(db, T0 + 61_000, down.d), 0);
  assert.equal(samples(db, c.id).length, 0);
  const thrown = deps({
    prices: async () => {
      throw new Error("offline");
    },
  });
  assert.equal(await sampleDue(db, T0 + 70_000, thrown.d), 0);
  const up = deps();
  assert.equal(await sampleDue(db, T0 + 100_000, up.d), 1, "next minute it works, still inside the allowed lateness");
  assert.equal(samples(db, c.id)[0].status, "ok");
});

test("sampler: a mark that is long past (the agent was off) is recorded as missed, with no price taken", async () => {
  const { db } = setup();
  const c = candidate(db, { seenAt: T0 });
  const { d, calls } = deps();
  const late = T0 + 60_000 + lateToleranceSec(60) * 1000 + 5_000;
  await sampleDue(db, late, d);
  const rows = samples(db, c.id);
  assert.equal(rows.find((r) => r.horizon_sec === 60)!.status, "missed");
  assert.equal(rows.find((r) => r.horizon_sec === 60)!.price_usd, null);
  assert.ok(rows.every((r) => r.horizon_sec <= 300), "later marks aren't due yet");
  assert.equal(calls.prices, 0, "nothing worth pricing");
  assert.equal(lateToleranceSec(60), 120);
  assert.equal(lateToleranceSec(86_400), 3600);
});

test("sampler: all seven marks are taken over a day, and a missing position size or unknown decimals only costs the quote", async () => {
  const { db } = setup();
  const full = candidate(db, { seenAt: T0 });
  const noSize = candidate(db, { seenAt: T0, size: null });
  const { d } = deps({ decimals: async () => undefined, prices: async (ms: string[]) => new Map(ms.map((m) => [m, { priceUsd: 0.1, source: "birdeye" as const }])) });
  for (const h of HORIZONS_SEC) await sampleDue(db, T0 + h * 1000 + 1_000, d);
  assert.deepEqual(samples(db, full.id).map((r) => r.horizon_sec), [...HORIZONS_SEC]);
  const s = samples(db, noSize.id)[0];
  assert.equal(s.status, "ok");
  assert.equal(s.sell_quote_sol, null);
  assert.equal(s.sell_quote_error, "no position size to quote");
  assert.equal(samples(db, full.id)[0].sell_quote_error, "token decimals unknown");
});

// ---- labels ----

const pt = (horizonSec: number, priceUsd: number | null, o: { liq?: number | null; sell?: number | null; status?: "ok" | "no_price" | "missed" } = {}) => ({
  horizonSec, status: o.status ?? (priceUsd === null ? ("no_price" as const) : ("ok" as const)), priceUsd, liquidityUsd: o.liq ?? null, sellQuoteSol: o.sell === undefined ? null : o.sell,
});

test("labels: a healthy token has none of them", () => {
  const l = labelOutcome(0.1, 0.1, [pt(60, 0.11, { sell: 0.1 }), pt(300, 0.12, { sell: 0.11 }), pt(3600, 0.2, { sell: 0.19, liq: 9000 })]);
  assert.equal(l.rugLike, false);
  assert.equal(l.collapse50, false);
  assert.equal(l.hourSettled, true);
  assert.equal(l.worstFirstHour, 1.0 * 0.1 / 0.1);
});

test("labels: a drop to 10% within the hour is a collapse, and a 50% drop is only the lesser one", () => {
  const half = labelOutcome(0.1, 0.1, [pt(60, 0.09), pt(300, 0.05), pt(3600, 0.06)]);
  assert.equal(half.collapse50, true);
  assert.equal(half.collapse90, false);
  assert.equal(half.rugLike, false);
  const dead = labelOutcome(0.1, 0.1, [pt(60, 0.09), pt(300, 0.01), pt(3600, 0.008)]);
  assert.equal(dead.collapse90, true);
  assert.equal(dead.rugLike, true);
  const late = labelOutcome(0.1, 0.1, [pt(60, 0.1), pt(3600, 0.1), pt(21_600, 0.001)]);
  assert.equal(late.collapse90, false, "the collapse labels are about the first hour");
});

test("labels: a price that looks fine but a sell that returns nothing is unexitable, and a lost route is its own label", () => {
  const stuck = labelOutcome(0.1, 0.1, [pt(60, 0.1, { sell: 0.095 }), pt(300, 0.1, { sell: 0.004 })]);
  assert.equal(stuck.unexitable, true);
  assert.equal(stuck.collapse90, true, "the sell value counts as a price, since the price feed lags a pull");
  assert.equal(stuck.rugLike, true);
  const lost = labelOutcome(0.1, 0.1, [pt(60, 0.1, { sell: 0.095 }), pt(300, 0.1, { sell: null })]);
  assert.equal(lost.routeLost, true);
  const busy = labelOutcome(0.1, 0.1, [pt(60, 0.1, { sell: 0.095 }), { ...pt(300, 0.1, { sell: null }), sellQuoteError: "429 Too Many Requests from lite-api.jup.ag" }]);
  assert.equal(busy.routeLost, false, "a busy quote API says nothing about the route");
  assert.equal(isTransientQuoteError("fetch failed"), true);
  assert.equal(isTransientQuoteError("503 Service Unavailable from lite-api.jup.ag"), true);
  assert.equal(isTransientQuoteError("400 Bad Request from lite-api.jup.ag: COULD_NOT_FIND_ANY_ROUTE"), false);
  assert.equal(isTransientQuoteError(null), false);
  const gone = labelOutcome(0.1, 0.1, [pt(60, 0.1, { sell: 0.095 }), { ...pt(300, 0.1, { sell: null }), sellQuoteError: "400 Bad Request from lite-api.jup.ag: COULD_NOT_FIND_ANY_ROUTE" }]);
  assert.equal(gone.routeLost, true);
  const neverQuoted = labelOutcome(0.1, 0.1, [pt(60, 0.1, { sell: null }), pt(300, 0.1, { sell: null })]);
  assert.equal(neverQuoted.routeLost, false, "no route from the start isn't a route that was lost");
});

test("labels: liquidity falling to a tenth, and a token that goes unpriced after being priced", () => {
  assert.equal(labelOutcome(0.1, 0.1, [pt(60, 0.1, { liq: 20_000 }), pt(300, 0.1, { liq: 1_500 })]).liquidityDrop, true);
  assert.equal(labelOutcome(0.1, 0.1, [pt(60, 0.1, { liq: 20_000 }), pt(300, 0.1, { liq: 15_000 })]).liquidityDrop, false);
  const dark = labelOutcome(0.1, 0.1, [pt(60, 0.1), pt(300, 0.1), pt(3600, null), pt(21_600, null)]);
  assert.equal(dark.dark, true);
  assert.equal(dark.rugLike, true);
  const recovers = labelOutcome(0.1, 0.1, [pt(60, 0.1), pt(3600, null), pt(21_600, 0.1)]);
  assert.equal(recovers.dark, false, "a price at the 6 h mark after all");
});

test("labels: never priced is unknown, not survived and not rugged; missed marks count for nothing", () => {
  const l = labelOutcome(0.1, 0.1, [pt(60, null), pt(300, null), pt(3600, null)]);
  assert.equal(l.neverPriced, true);
  assert.equal(l.dark, false);
  assert.equal(l.rugLike, false);
  const missed = labelOutcome(0.1, 0.1, [pt(60, null, { status: "missed" })]);
  assert.equal(missed.taken, 0);
  assert.equal(missed.neverPriced, false);
  assert.equal(missed.hourSettled, false);
  assert.equal(labelOutcome(null, null, [pt(60, 0.1), pt(3600, 0.1)]).worstFirstHour, null, "no entry price, nothing to compare with");
});

test("wilson interval brackets the share and widens for small samples", () => {
  const a = wilson(10, 100)!;
  assert.ok(a.lo < 0.1 && a.hi > 0.1);
  const b = wilson(1, 10)!;
  assert.ok(b.hi - b.lo > a.hi - a.lo);
  assert.equal(wilson(0, 0), null);
  assert.equal(wilson(0, 20)!.lo, 0);
});

// ---- report ----

test("report: counts, coverage and outcomes by verdict and by cutoff, with unscreened and unsettled kept apart", async () => {
  const { db, log } = setup();
  const now = T0 + 7_200_000;
  const mk = async (opts: { verdict: "pass" | "blocked"; top10: number; priceAt60m: number | null; sell5?: number | null }) => {
    const s = swap({ ts: new Date(T0).toISOString() });
    const view = cleanScreen({
      holders: { launchBundlePct: 5, launchBuyers: 1, clusterPct: 0, clusterSize: 0, clusterFromCreator: false, top10Pct: opts.top10, insiderPct: null },
      verdict: { verdict: opts.verdict, blocks: opts.verdict === "blocked" ? ["top 10 holders hold 70%"] : [], warnings: [], rugcheckScore: 10 },
    });
    const logger = new ShadowLogger(db, async () => view);
    logger.observe(s, T0, 0.5, "T");
    await logger.idle();
    const id = (row(db, s.mint) as { id: number }).id;
    db.prepare("UPDATE shadow_candidates SET entry_price_usd = 0.1, sim_size_sol = 0.1 WHERE id = ?").run(id);
    const put = (h: number, status: string, price: number | null, sell: number | null) =>
      db.prepare("INSERT INTO shadow_samples (candidate_id, horizon_sec, sampled_at, status, price_usd, sell_quote_sol, rugcheck_ok, rugcheck_pools) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(id, h, new Date(T0 + h * 1000).toISOString(), status, price, sell, h <= 300 ? 1 : null, h <= 300 ? 1 : null);
    put(60, price(0.1), 0.1, 0.098);
    put(300, price(0.1), 0.1, opts.sell5 === undefined ? 0.098 : opts.sell5);
    put(3600, opts.priceAt60m === null ? "no_price" : "ok", opts.priceAt60m, opts.priceAt60m === null ? null : 0.09);
    return s.mint;
  };
  const price = (p: number) => (p > 0 ? "ok" : "no_price");
  await mk({ verdict: "pass", top10: 30, priceAt60m: 0.12 });
  await mk({ verdict: "pass", top10: 35, priceAt60m: 0.011 }); // fell 89%: a 50% drop but not a 90% one
  await mk({ verdict: "pass", top10: 20, priceAt60m: 0.005 }); // ≥ 90%
  await mk({ verdict: "blocked", top10: 70, priceAt60m: null }); // went unpriced
  const pending = swap({ ts: new Date(now - 30_000).toISOString() }); // too new to have a settled hour
  log.observe(pending, now - 30_000, 0.5, "NEW");
  await log.idle();

  const r = buildReport(db, T0 - 1000, now);
  assert.equal(r.total, 5);
  assert.equal(r.byVerdict.pass, 4, "the pending one passed the screen too");
  assert.equal(r.byVerdict.blocked, 1);
  const pass = r.byVerdictOutcome.find((g) => g.group === "pass")!;
  assert.equal(pass.n, 4);
  assert.equal(pass.settled, 3, "the unsettled one isn't counted in the rates");
  assert.equal(pass.collapse90, 1);
  assert.equal(pass.collapse50, 2);
  const over = r.byRule.find((x) => x.rule.startsWith("top-10"))!;
  assert.equal(over.over.n, 1);
  assert.equal(over.over.rugLike, 1, "the blocked one went unpriced after being priced");
  assert.equal(over.under.n, 4);
  assert.equal(r.coverage.find((c) => c.horizonSec === 3600)!.ok, 3);
  assert.equal(r.coverage.find((c) => c.horizonSec === 3600)!.noPrice, 1);
  assert.equal(r.coverage.find((c) => c.horizonSec === 60)!.notYetDue, 1);
  assert.equal(r.rugcheckFilledIn.at300s, 1);
  assert.equal(r.latencyMs.chain, 40);

  const text = formatReport(r);
  assert.match(text, /5 tokens logged/);
  assert.match(text, /OUTCOME BY SCREEN VERDICT/);
  assert.match(text, /top-10 holders > 50%/);
  assert.match(text, /never priced = unknown/);
  assert.match(formatReport(buildReport(openDb(":memory:"), 0)), /Nothing logged yet/);
});
