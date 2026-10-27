/**
 * Organic tokens: the tally of every swap, the verdict, signal gating, the market check, the feed filter and the venue labels.
 * Synthetic data, an in-memory database and stubbed Jupiter answers: nothing here touches the network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, type DB } from "@godseye/shared";
import { getSmartMoney } from "@godseye/shared/dashboard-data";
import type { ParsedSwap } from "../src/chain/parse";
import { parseSwap, detectVenue } from "../src/chain/parse";
import { LABEL_ONLY_VENUES, VENUES } from "../src/chain/programs";
import { assess, backfillFromTape, ensureOrganicTable, getVerdict, independentVoters, MintTally, organicSettings, saveAssessment, type MintStats } from "../src/smart/organic";
import { checkMarkets, dueForMarketCheck, judgeMarket, marketSettings, parseJupiterTokens, type JupToken } from "../src/smart/organic-market";
import { SmartMoney } from "../src/smart/smart-money";
import { swapTx, WALLET } from "./helpers";

const T = Date.parse("2026-10-26T12:00:00Z");
let n = 0;
const sw = (wallet: string, side: "buy" | "sell", sol: number, o: Partial<ParsedSwap> & { tMs?: number } = {}): ParsedSwap => {
  const { tMs, ...rest } = o;
  return {
    wallet, signature: `s${++n}`, slot: n, ts: new Date(tMs ?? T).toISOString(), mint: "TOK", side, tokenAmount: sol * 1000, tokenBalanceBefore: 0,
    solAmount: sol, priceSol: 0.001, quote: "SOL", quoteAmount: sol, solUsd: 100, usdAmount: sol * 100, venue: "pumpswap", jitoTip: false, feeLamports: 5000, ...rest,
  };
};
/** `k` different ordinary wallets each buying about `sol`. */
const buyers = (tally: MintTally, k: number, sol = 0.5, mint = "TOK", smart = false, t0 = T) => {
  for (let i = 0; i < k; i++) tally.record(sw(`${smart ? "smart" : "w"}${i}`, "buy", sol + i * 0.01, { mint, tMs: t0 + i * 1000 }), smart, t0 + i * 1000);
};
const stats = (tally: MintTally, now: number, mint = "TOK"): MintStats => tally.stats(mint, now)!;

// ---- the tally ----

test("tally: counts makers, buyers, volume and how concentrated it is", () => {
  const tally = new MintTally();
  buyers(tally, 18);
  tally.record(sw("w0", "sell", 0.3), false, T + 60_000);
  const s = stats(tally, T + 2 * 60_000);
  assert.equal(s.makers, 18);
  assert.equal(s.buyers, 18);
  assert.equal(s.sellers, 1);
  assert.equal(s.swaps, 19);
  assert.equal(s.buys, 18);
  assert.equal(s.sells, 1);
  assert.ok(s.top1Share < 0.1);
  assert.ok(s.top3Share < 0.2);
  assert.ok(s.effectiveMakers > 16, `effective ${s.effectiveMakers}`);
  assert.equal(s.roundTripShare, 0);
  assert.equal(tally.stats("NOPE"), null);
});

test("tally: a buy sold back soon after, in about the same amount, is a round trip; a late or different sale is not", () => {
  const tally = new MintTally();
  tally.record(sw("a", "buy", 1, { tMs: T }), false, T);
  tally.record(sw("a", "sell", 1, { tMs: T + 60_000 }), false, T + 60_000); // sold back in a minute: round trip
  tally.record(sw("b", "buy", 1, { tMs: T }), false, T);
  tally.record(sw("b", "sell", 1, { tMs: T + 20 * 60_000 }), false, T + 20 * 60_000); // 20 minutes later: not
  tally.record(sw("c", "buy", 1, { tMs: T }), false, T);
  tally.record(sw("c", "sell", 0.4, { tMs: T + 30_000 }), false, T + 30_000); // a partial sale: not
  const s = stats(tally, T + 21 * 60_000);
  assert.ok(Math.abs(s.roundTripShare - 2 / 5.4) < 1e-9, `share ${s.roundTripShare}`); // 2 of the 5.4 SOL traded
  assert.equal(s.cycleWallets, 0);

  const cyc = new MintTally();
  for (let i = 0; i < 3; i++) {
    cyc.record(sw("x", "buy", 1, { tMs: T + i * 10_000 }), false, T + i * 10_000);
    cyc.record(sw("x", "sell", 1, { tMs: T + i * 10_000 + 2000 }), false, T + i * 10_000 + 2000);
  }
  assert.equal(stats(cyc, T + 60_000).cycleWallets, 1);
});

test("tally: memory stays bounded: a cap on wallets per token, a cap on tokens, and quiet tokens are forgotten", () => {
  const small = { ...organicSettings, maxMakersPerMint: 5, maxMints: 3, idleMinutes: 30 };
  const tally = new MintTally(small);
  buyers(tally, 12, 0.5, "BIG");
  const s = stats(tally, T + 1000, "BIG");
  assert.equal(s.makers, 5);
  assert.equal(s.capped, true);
  assert.equal(s.swaps, 12, "the swaps beyond the cap still count");
  assert.ok(Math.abs(s.volumeSol - (0.5 * 12 + 0.01 * 66)) < 1e-9, "and so does their volume");

  for (const m of ["A", "B", "C", "D", "E"]) tally.record(sw("z", "buy", 1, { mint: m }), false, T + 1000);
  assert.ok(tally.size <= 3, `${tally.size} tokens kept`);

  const idle = new MintTally(small);
  idle.record(sw("z", "buy", 1, { mint: "OLD" }), false, T);
  idle.record(sw("z", "buy", 1, { mint: "NEW" }), false, T + 40 * 60_000);
  assert.equal(idle.evict(T + 40 * 60_000), 1);
  assert.deepEqual(idle.mintsSeen(), ["NEW"]);
});

// ---- the verdict ----

test("verdict: a broad, ordinary crowd is organic, with a score", () => {
  const tally = new MintTally();
  buyers(tally, 25, 0.5);
  const a = assess(stats(tally, T + 12 * 60_000));
  assert.equal(a.verdict, "organic");
  assert.ok(a.score > 50, `score ${a.score}`);
  assert.match(a.reasons[0], /25 wallets, 25 buyers \(25 not smart\)/);
});

test("verdict: one wallet churning against another (hundreds of swaps, two wallets) is thin, however much it trades", () => {
  const tally = new MintTally();
  for (let i = 0; i < 380; i++) tally.record(sw(i % 2 ? "seller" : "buyer", i % 2 ? "sell" : "buy", 1 + (i % 7) * 0.13, { tMs: T + i * 1000 }), false, T + i * 1000);
  const a = assess(stats(tally, T + 400_000));
  assert.equal(a.verdict, "thin");
  assert.match(a.reasons.join(), /3 wallets make 100% of the volume/);
});

test("verdict: the same wallets buying and selling the same amounts back is wash, even with a broad-looking crowd", () => {
  const tally = new MintTally();
  for (let i = 0; i < 20; i++) {
    tally.record(sw(`w${i}`, "buy", 1, { tMs: T + i * 5000 }), false, T + i * 5000);
    tally.record(sw(`w${i}`, "sell", 1, { tMs: T + i * 5000 + 2000 }), false, T + i * 5000 + 2000);
  }
  const a = assess(stats(tally, T + 5 * 60_000));
  assert.equal(a.verdict, "wash");
  assert.match(a.reasons[0], /100% of the volume is wallets buying and selling the same tokens back/);
});

test("verdict: too early is 'unknown', and the same few wallets become 'thin' once the token has had its chance", () => {
  const tally = new MintTally();
  buyers(tally, 5, 0.5);
  assert.equal(assess(stats(tally, T + 2 * 60_000)).verdict, "unknown");
  const later = assess(stats(tally, T + 11 * 60_000));
  assert.equal(later.verdict, "thin");
  assert.match(later.reasons.join(), /only 5 different wallets/);
});

test("verdict: buyers who are all smart wallets (copy-bots following each other) are not independent demand", () => {
  const tally = new MintTally();
  buyers(tally, 20, 0.5, "TOK", true);
  const a = assess(stats(tally, T + 11 * 60_000));
  assert.equal(a.verdict, "thin");
  assert.match(a.reasons.join(), /only 0 buyers besides smart wallets/);
  const mixed = new MintTally();
  buyers(mixed, 20, 0.5, "TOK", false);
  for (let i = 0; i < 4; i++) mixed.record(sw(`smart${i}`, "buy", 0.5, { tMs: T + 30_000 + i }), true, T + 30_000 + i);
  assert.equal(assess(stats(mixed, T + 11 * 60_000)).verdict, "organic");
});

test("verdict: a token with more wallets than the tally keeps is treated as a broad crowd", () => {
  const tally = new MintTally({ ...organicSettings, maxMakersPerMint: 10 });
  buyers(tally, 40, 0.5);
  const st = stats(tally, T + 11 * 60_000);
  assert.equal(st.capped, true);
  assert.equal(assess(st).verdict, "organic");
});

test("independence: wallets sharing a funder count once; wallets with no known funder count one each", () => {
  const funder: Record<string, string> = { a: "F", b: "F", c: "F", d: "G" };
  const of = (w: string) => funder[w] ?? null;
  assert.equal(independentVoters(["a", "b", "c"], of), 1);
  assert.equal(independentVoters(["a", "b", "d"], of), 2);
  assert.equal(independentVoters(["a", "x", "y"], of), 3);
  assert.equal(independentVoters([], of), 0);
});

// ---- smart money uses it ----

function smartDb(wallets: string[], funders: Record<string, string> = {}) {
  const db = openDb(":memory:");
  const now = new Date().toISOString();
  for (const w of wallets) {
    db.prepare("INSERT INTO wallets (address, first_seen_at, discovered_via, tier, funder) VALUES (?, ?, 'test', 'proven', ?)").run(w, now, funders[w] ?? null);
    db.prepare("INSERT INTO wallet_stats (wallet, computed_at, swaps_total, swaps_7d, swaps_30d, pnl_7d_sol, pnl_30d_sol, pnl_all_sol, pnl_30d_usd, closed_7d, closed_30d, wins_30d, win_rate_30d) VALUES (?, ?, 40, 10, 40, 1, 5, 5, 500, 5, 20, 12, 0.6)").run(w, now);
    db.prepare("INSERT OR REPLACE INTO copy_replays (wallet, delay_sec, n, coverage, median_ret_pct, computed_at) VALUES (?, 5, 20, 0.9, 5, ?)").run(w, now);
  }
  const sm = new SmartMoney(db, null);
  sm.refresh();
  return { db, sm };
}
const crowdOn = (sm: SmartMoney, mint: string, k = 18) => {
  for (let i = 0; i < k; i++) sm.onSwap(sw(`crowd${i}`, "buy", 0.4, { mint, tMs: T - 120_000 + i * 1000 }), T - 120_000 + i * 1000);
};
const smartBuys = (sm: SmartMoney, mint: string, wallets: string[], at = T) => wallets.forEach((w, i) => sm.onSwap(sw(w, "buy", 3, { mint, tMs: at + i * 60_000 }), at + i * 60_000));
const count = (db: DB, sql: string) => (db.prepare(sql).get() as { n: number }).n;

test("signals: three smart wallets buying a token nobody else trades make no signal, but their trades are still recorded", () => {
  const { db, sm } = smartDb(["A", "B", "C"]);
  smartBuys(sm, "EMPTY", ["A", "B", "C"]);
  sm.flush(T + 3 * 60_000);
  assert.equal(count(db, "SELECT COUNT(*) n FROM smart_signals"), 0);
  assert.equal(count(db, "SELECT COUNT(*) n FROM smart_flows WHERE mint = 'EMPTY'"), 3);
  assert.equal((db.prepare("SELECT value FROM agent_meta WHERE key = 'smart_signals_gated'").get() as { value: string }).value, "1");
});

test("signals: with a real crowd behind the token the same three wallets do make one", () => {
  const { db, sm } = smartDb(["A", "B", "C"]);
  crowdOn(sm, "REAL");
  smartBuys(sm, "REAL", ["A", "B", "C"]);
  assert.equal(count(db, "SELECT COUNT(*) n FROM smart_signals WHERE mint = 'REAL'"), 1);
});

test("signals: wallets that share a funder are one voice, so they can't make a signal on their own", () => {
  const same = smartDb(["A", "B", "C"], { A: "F", B: "F", C: "F" });
  crowdOn(same.sm, "REAL");
  smartBuys(same.sm, "REAL", ["A", "B", "C"]);
  assert.equal(count(same.db, "SELECT COUNT(*) n FROM smart_signals"), 0);

  const two = smartDb(["A", "B", "C"], { A: "F", B: "F" });
  crowdOn(two.sm, "REAL");
  smartBuys(two.sm, "REAL", ["A", "B", "C"]);
  assert.equal(count(two.db, "SELECT COUNT(*) n FROM smart_signals"), 0, "two independent voices are fewer than three");

  const three = smartDb(["A", "B", "C", "D"], { A: "F", B: "F", C: "G", D: "H" });
  crowdOn(three.sm, "REAL");
  smartBuys(three.sm, "REAL", ["A", "B", "C", "D"]);
  assert.equal(count(three.db, "SELECT COUNT(*) n FROM smart_signals"), 1, "three funder groups are enough");
});

test("signals: a token the market check found to have no pool makes no signal, however many wallets traded it", () => {
  const { db, sm } = smartDb(["A", "B", "C"]);
  crowdOn(sm, "DRAINED");
  smartBuys(sm, "DRAINED", ["A"]);
  sm.flush(T + 5 * 60_000); // the verdict is kept
  db.prepare("UPDATE token_organic SET market = 'thin', market_reason = 'its pool holds $0 of liquidity', verdict = 'thin' WHERE mint = 'DRAINED'").run();
  smartBuys(sm, "DRAINED", ["B", "C"], T + 6 * 60_000);
  assert.equal(count(db, "SELECT COUNT(*) n FROM smart_signals"), 0);
});

test("the stream's verdict is kept each minute, and an 'unknown' never replaces a conclusive one", () => {
  const { db, sm } = smartDb(["A"]);
  crowdOn(sm, "REAL", 25);
  smartBuys(sm, "REAL", ["A"]);
  sm.flush(T + 11 * 60_000);
  const v = getVerdict(db, "REAL")!;
  assert.equal(v.verdict, "organic");
  assert.equal(v.source, "stream");
  assert.ok(JSON.parse(v.stats!).makers >= 25);
  saveAssessment(db, "REAL", { verdict: "unknown", score: 0, reasons: ["too early"] }, null, "stream");
  assert.equal(getVerdict(db, "REAL")!.verdict, "organic");
  saveAssessment(db, "REAL", { verdict: "wash", score: 0, reasons: ["recycled"] }, null, "stream");
  assert.equal(getVerdict(db, "REAL")!.verdict, "wash", "a conclusive new verdict does replace it");
});

// ---- the market check ----

const jup = (o: Partial<JupToken> = {}): JupToken => ({ id: "M", liquidity: 25_000, holderCount: 400, organicScore: 60, organicScoreLabel: "medium", suspicious: false, ...o });

test("market: Jupiter's token search is read into the fields we use (a real drained token's shape)", () => {
  const m = parseJupiterTokens([
    {
      id: "51rRP8hKNGNTucWaBQkuQoVFgifRUCM4majBSbK81e6B", symbol: "GME", decimals: 6, holderCount: 13, liquidity: 3.0473874659884564e-7,
      stats24h: { numBuys: 8090, numTraders: 2135 }, audit: { isSus: true, devMints: 60 }, organicScore: 0, organicScoreLabel: "low", firstPool: { createdAt: "2026-10-25T16:23:06Z" },
    },
    { symbol: "no id" },
  ]);
  const t = m.get("51rRP8hKNGNTucWaBQkuQoVFgifRUCM4majBSbK81e6B")!;
  assert.equal(t.holderCount, 13);
  assert.ok(t.liquidity! < 1e-6);
  assert.equal(t.suspicious, true);
  assert.equal(t.organicScoreLabel, "low");
  assert.equal(m.size, 1);
  assert.equal(parseJupiterTokens({ error: "x" }).size, 0);
});

test("market: a pool with money is fine; an empty one, or none after the token has had time to be listed, is not", () => {
  assert.equal(judgeMarket(jup(), 30).market, "ok");
  const drained = judgeMarket(jup({ liquidity: 3e-7 }), 30);
  assert.equal(drained.market, "thin");
  assert.match(drained.reason, /its pool holds \$3\.0e-7 of liquidity/);
  assert.equal(judgeMarket(jup({ liquidity: 120 }), 30).market, "thin");
  assert.equal(judgeMarket(null, 5).market, null, "a new token may simply not be listed yet");
  assert.equal(judgeMarket(null, 40).market, "thin");
  assert.equal(judgeMarket(jup({ liquidity: null }), 30).market, null, "no figure is no judgement");
});

function organicRow(db: DB, mint: string, verdict: string, ageMin = 30) {
  ensureOrganicTable(db);
  const first = new Date(Date.now() - ageMin * 60_000).toISOString();
  db.prepare("INSERT INTO token_organic (mint, verdict, tally_verdict, score, source, reasons, assessed_at, first_assessed_at) VALUES (?, ?, ?, 50, 'stream', '[]', ?, ?)").run(mint, verdict, verdict, first, first);
}

test("market: only tokens the stream hasn't already ruled out are asked about, oldest check first, a few at a time", () => {
  const db = openDb(":memory:");
  organicRow(db, "ORG", "organic");
  organicRow(db, "UNK", "unknown");
  organicRow(db, "BAD", "thin");
  organicRow(db, "WASH", "wash");
  const due = dueForMarketCheck(db, marketSettings).map((d) => d.mint).sort();
  assert.deepEqual(due, ["ORG", "UNK"]);
  assert.equal(dueForMarketCheck(db, { ...marketSettings, perRun: 1 }).length, 1);
});

test("market: a drained pool turns the verdict to thin, survives the next stream assessment, and recovers when liquidity returns", async () => {
  const db = openDb(":memory:");
  organicRow(db, "DBC", "organic");
  const drained = async () => new Map([["DBC", jup({ id: "DBC", liquidity: 0.4 })]]);
  const r = await checkMarkets(db, drained, marketSettings, Date.now());
  assert.deepEqual(r, { checked: 1, thin: 1 });
  let v = getVerdict(db, "DBC")!;
  assert.equal(v.verdict, "thin");
  assert.equal(v.tally_verdict, "organic");
  assert.equal(v.market, "thin");
  assert.equal(v.jup_label, "medium");
  assert.ok(v.enriched_at);

  // The stream still thinks it is organic (lots of past swaps): the empty pool wins.
  saveAssessment(db, "DBC", { verdict: "organic", score: 80, reasons: ["25 wallets"] }, null, "stream");
  v = getVerdict(db, "DBC")!;
  assert.equal(v.verdict, "thin");
  assert.match(v.reasons, /its pool holds \$0\.40 of liquidity/);

  // Not asked again straight away; asked again later, the pool is back.
  assert.equal(dueForMarketCheck(db, marketSettings).length, 0);
  const later = Date.now() + 25 * 60_000;
  const back = async () => new Map([["DBC", jup({ id: "DBC", liquidity: 9_000 })]]);
  await checkMarkets(db, back, marketSettings, later);
  v = getVerdict(db, "DBC")!;
  assert.equal(v.market, "ok");
  assert.equal(v.verdict, "organic");
});

test("market: when Jupiter can't be reached nothing changes", async () => {
  const db = openDb(":memory:");
  organicRow(db, "X", "organic");
  const r = await checkMarkets(db, async () => { throw new Error("429 Too Many Requests"); }, marketSettings);
  assert.deepEqual(r, { checked: 0, thin: 0 });
  const v = getVerdict(db, "X")!;
  assert.equal(v.verdict, "organic");
  assert.equal(v.market, null);
  assert.equal(v.enriched_at, null);
});

// ---- tokens traded before the tally existed ----

test("backfill: tokens from before the live tally are judged from the stored swaps, which can only call them thin, wash or unknown", () => {
  const db = openDb(":memory:");
  const now = new Date(T).toISOString();
  const flow = db.prepare("INSERT INTO smart_flows (signature, ts, wallet, mint, side, usd, price_usd) VALUES (?, ?, ?, ?, 'buy', 100, 1)");
  const tape = db.prepare("INSERT INTO wallet_swaps (wallet, signature, slot, ts, mint, side, token_amount, sol_amount, price_sol) VALUES (?, ?, 1, ?, ?, ?, ?, ?, 0.001)");
  for (const m of ["CHURN", "BROAD", "STREAMED"]) flow.run(`f-${m}`, now, "A", m);
  for (let i = 0; i < 60; i++) tape.run(i % 2 ? "sellerW" : "buyerW", `c${i}`, new Date(T + i * 1000).toISOString(), "CHURN", i % 2 ? "sell" : "buy", 1000 + i * 37, 1 + (i % 5) * 0.2);
  for (let i = 0; i < 30; i++) tape.run(`w${i}`, `b${i}`, new Date(T + i * 1000).toISOString(), "BROAD", "buy", 1000, 0.5);
  organicRow(db, "STREAMED", "organic");
  assert.equal(backfillFromTape(db, organicSettings, T + 60_000), 2);
  const churn = getVerdict(db, "CHURN")!;
  assert.equal(churn.verdict, "thin");
  assert.equal(churn.source, "tape");
  assert.equal(getVerdict(db, "BROAD")!.verdict, "unknown", "tracked wallets undercount, so the tape never vouches for a token");
  assert.equal(getVerdict(db, "STREAMED")!.verdict, "organic", "and never overrides the stream");
  assert.equal(backfillFromTape(db, organicSettings, T + 120_000), 0, "each token once");
});

// ---- the feed ----

test("feed: tokens judged thin or wash are not listed, organic ones are labelled with their crowd, others are marked unverified", () => {
  const db = openDb(":memory:");
  const flow = db.prepare("INSERT INTO smart_flows (signature, ts, wallet, mint, side, usd, price_usd) VALUES (?, ?, ?, ?, 'buy', ?, 1)");
  const at = new Date(Date.now() - 600_000).toISOString();
  const sig = db.prepare("INSERT INTO smart_signals (ts, mint, kind, wallets, wallet_count, usd) VALUES (?, ?, 'accumulate', '[]', 3, 900)");
  for (const [m, usd] of [["GOOD", 500], ["JUNK", 9000], ["WASHY", 8000], ["NEW", 300], ["OLDER", 200]] as const) {
    flow.run(`f-${m}`, at, "A", m, usd);
    sig.run(at, m);
  }
  ensureOrganicTable(db);
  const put = db.prepare("INSERT INTO token_organic (mint, verdict, tally_verdict, score, source, reasons, stats, assessed_at, first_assessed_at) VALUES (?, ?, ?, ?, 'stream', '[]', ?, ?, ?)");
  put.run("GOOD", "organic", "organic", 70, JSON.stringify({ makers: 41 }), at, at);
  put.run("JUNK", "thin", "thin", 0, JSON.stringify({ makers: 2 }), at, at);
  put.run("WASHY", "wash", "wash", 0, JSON.stringify({ makers: 30 }), at, at);
  put.run("NEW", "unknown", "unknown", 0, JSON.stringify({ makers: 3 }), at, at);
  const data = getSmartMoney(db);
  assert.deepEqual(data.flows.map((f) => f.mint).sort(), ["GOOD", "NEW", "OLDER"]);
  const by = Object.fromEntries(data.flows.map((f) => [f.mint, f]));
  assert.equal(by.GOOD.organic, "organic");
  assert.equal(by.GOOD.traders, 41);
  assert.equal(by.GOOD.organic_score, 70);
  assert.equal(by.NEW.organic, "unverified");
  assert.equal(by.OLDER.organic, "unverified", "no verdict yet");
  assert.equal(by.OLDER.traders, null);
  assert.deepEqual(data.signals.map((g) => g.mint).sort(), ["GOOD", "NEW", "OLDER"]);
  assert.equal(data.signals.find((g) => g.mint === "GOOD")!.organic, "organic");
  // The scorecard counts only the signals that are listed.
  db.prepare("UPDATE smart_signals SET ret_1h = 40").run();
  db.prepare("UPDATE smart_signals SET ret_1h = -90 WHERE mint IN ('JUNK', 'WASHY')").run();
  const acc1h = getSmartMoney(db).scorecard.find((s) => s.kind === "accumulate" && s.horizon === "1h")!;
  assert.equal(acc1h.signals, 3);
  assert.equal(acc1h.median_ret, 40);
});

test("feed: a database that has no verdicts yet (an older one) still works and lists everything as unverified", () => {
  const db = openDb(":memory:");
  const at = new Date(Date.now() - 600_000).toISOString();
  db.prepare("INSERT INTO smart_flows (signature, ts, wallet, mint, side, usd, price_usd) VALUES ('f', ?, 'A', 'ANY', 'buy', 100, 1)").run(at);
  const data = getSmartMoney(db);
  assert.equal(data.flows.length, 1);
  assert.equal(data.flows[0].organic, "unverified");
  assert.equal(data.flows[0].traders, null);
});

// ---- venue labels ----

test("venues: Meteora's bonding curve and the pool its tokens migrate to are labelled, but not subscribed to", () => {
  const DBC = "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN";
  const DAMM = "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG";
  assert.equal(LABEL_ONLY_VENUES[DBC], "meteora dbc");
  assert.equal(LABEL_ONLY_VENUES[DAMM], "meteora damm v2");
  assert.equal(VENUES[DBC], undefined, "the stream subscribes to VENUES: DBC is left out on purpose");
  assert.equal(VENUES[DAMM], undefined);
  const direct = parseSwap(swapTx({ solDelta: -1, tokenBefore: 0, tokenAfter: 100, programs: [DBC] }), WALLET)!;
  assert.equal(direct.venue, "meteora dbc");
  const viaBot = parseSwap(swapTx({ solDelta: -1, tokenBefore: 0, tokenAfter: 100, programs: ["BotRouter111111111111111111111111111111111"], inner: [DBC] }), WALLET)!;
  assert.equal(viaBot.venue, "meteora dbc (via bot)");
  const migrated = parseSwap(swapTx({ solDelta: -1, tokenBefore: 0, tokenAfter: 100, programs: [DAMM] }), WALLET)!;
  assert.equal(migrated.venue, "meteora damm v2");
  // Routed through Jupiter it is still "jupiter": the aggregator ranks first
  const routed = parseSwap(swapTx({ solDelta: -1, tokenBefore: 0, tokenAfter: 100, programs: ["JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"], inner: [DBC] }), WALLET)!;
  assert.equal(routed.venue, "jupiter");
  assert.equal(detectVenue(swapTx({ solDelta: -1, tokenBefore: 0, tokenAfter: 100, programs: ["11111111111111111111111111111111"] })), null);
});
