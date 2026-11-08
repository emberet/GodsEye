/**
 * The Brain on the live stream (brain/runtime.ts): streamed swaps feed the stream state and the leader ledgers; an analyzed
 * wallet's buy becomes an entry decision (features.ts → hard gates → Brain / Explore → the ensemble → policy.ts) whose
 * transition keeps the feature vector and q; its sell asks the exit network at once. A stub model (a manifest naming the
 * golden columns, q from plain functions), a set clock and a stub market: no network, no ONNX, nothing real.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, type DB } from "@godseye/shared";
import type { ParsedSwap } from "../src/chain/parse";

process.env.COPY_BUDGET_SOL = "1";
process.env.COPY_MAX_TRADE_SOL = "0.1";
process.env.COPY_MIN_TRADE_SOL = "0.01";
process.env.COPY_MAX_POSITIONS = "0";
process.env.MIN_LEADER_BUY_SOL = "0.2";
process.env.BRAIN_TX_COST_SOL = "0.0003";
process.env.BRAIN_RENT_SOL = "0.002";
process.env.BRAIN_BANKROLL_SOL = "";
process.env.BRAIN_SHADOW_QUOTE_RATE = "1";
const F = await import("../src/brain/features");
const { BrainRuntime } = await import("../src/brain/runtime");
const { validateManifest } = await import("../src/brain/model");
type BrainModel = import("../src/brain/model").BrainModel;
type ModelSource = import("../src/brain/runtime").ModelSource;
/* eslint-disable @typescript-eslint/no-explicit-any */

const SPEC = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../brain/spec/golden");
const ENTRY = JSON.parse(fs.readFileSync(path.join(SPEC, "entry.json"), "utf8"));
const EXIT = JSON.parse(fs.readFileSync(path.join(SPEC, "exit.json"), "utf8"));
const STAKES = [0, 0.25, 0.5, 0.75, 1];
const T0 = Date.parse("2026-11-10T12:00:00Z");
const LEADER = "RtLeaderAAAA";
const CROWD = ["RtWalletB", "RtWalletC", "RtWalletD", "RtWalletE"];
const near = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);
const iso = (ms: number) => new Date(ms).toISOString();

/** A bundle as the runtime sees it: the golden columns, levels and norm; q from the given functions. */
function stubModels(o: { entryQ?: (x: Float32Array) => number[][]; exitQ?: (x: Float32Array) => number[]; brainEnabled?: boolean; marginC?: number; exploreRate?: number }) {
  const sha = "0".repeat(64);
  const manifest = validateManifest(
    {
      version: "rt-1", created_at: "", feature_spec_version: F.FEATURE_SPEC_VERSION, brain_enabled: o.brainEnabled ?? true,
      entry: {
        features: ENTRY.columns, norm: ENTRY.norm, members: ["entry-0.onnx", "entry-1.onnx"], input: "x", output: "q", actions: STAKES,
        margin_c: o.marginC ?? 0, categories: ENTRY.categories,
      },
      exit: { features: EXIT.columns, norm: EXIT.norm, file: "exit.onnx", input: "x", output: "q", actions: ["hold", "sell_half", "sell_all"] },
      explore: { rate: o.exploreRate ?? 0, curiosity: 0 }, metrics: {}, sha256: { "entry-0.onnx": sha, "entry-1.onnx": sha, "exit.onnx": sha },
    },
    { featureSpecVersion: F.FEATURE_SPEC_VERSION, entryColumns: F.entryColumns, exitColumns: F.exitColumns() },
  );
  const calls = { entry: [] as Float32Array[], exit: [] as Float32Array[] };
  const model: BrainModel = {
    version: manifest.version, dir: "", manifest,
    entryQ: async (x) => (calls.entry.push(x), (o.entryQ ?? (() => [[0, 0, 0, 0, 0]]))(x)),
    exitQ: async (x) => (calls.exit.push(x), (o.exitQ ?? (() => [1, 0, 0]))(x)),
    release: async () => {},
  };
  const models: ModelSource = { model, check: async () => ({ status: "unchanged", version: manifest.version }), close: async () => {} };
  return { models, calls };
}

let sigN = 0;
function swap(wallet: string, mint: string, side: "buy" | "sell", ts: number, o: Partial<ParsedSwap> = {}): ParsedSwap {
  return {
    wallet, signature: `RtSig${++sigN}`, slot: sigN, ts: iso(ts), mint, side, tokenAmount: 2.5e6, tokenBalanceBefore: 0, solAmount: 0.1, priceSol: 4e-8,
    quote: "SOL", quoteAmount: 0.1, solUsd: null, usdAmount: null, venue: "pumpfun", jitoTip: false, feeLamports: 5000, ...o,
  };
}

function setup(model: ReturnType<typeof stubModels>, rng: () => number = () => 0.5, onDb: (db: DB) => void = () => {}) {
  const db = openDb(":memory:");
  onDb(db);
  const add = db.prepare("INSERT INTO wallets (address, first_seen_at, discovered_via, tier, copy_weight) VALUES (?, ?, 'test', 'proven', 0)");
  for (const w of [LEADER, ...CROWD]) add.run(w, iso(T0 - 30 * 86_400_000));
  const clock = { t: T0 - 20 * 60_000 };
  const prices = new Map<string, number>();
  const sold: { mint: string; tokens: number }[] = [];
  const shadowQuotes: string[] = [];
  const rt = new BrainRuntime(
    db,
    {
      now: () => clock.t,
      wait: async (ms) => void (clock.t += ms),
      delayMs: 2000,
      quoteBuy: async (mint, sol) => (prices.has(mint) ? { tokens: sol / prices.get(mint)!, priceSol: prices.get(mint)! } : null),
      quoteSell: async (mint, tokens) => (sold.push({ mint, tokens }), prices.has(mint) ? tokens * prices.get(mint)! : null),
      screen: async () => true,
      baselineLeaders: () => [],
      baselineSize: () => 0,
    },
    {
      dir: "brain-rt",
      rng,
      models: model.models,
      state: { lookupCreator: async () => "", cachedCreator: () => null },
      quotes: { random: () => 0, quoteSell: async (mint) => (shadowQuotes.push(mint), 1) },
    },
  );
  return { db, rt, clock, prices, sold, shadowQuotes };
}

const transitions = (db: DB, kind?: string): Record<string, any>[] =>
  (db.prepare(`SELECT * FROM brain_transitions ${kind ? "WHERE kind = ?" : ""} ORDER BY id`).all(...(kind ? [kind] : [])) as Record<string, any>[]).map((r) => ({
    ...r, features: JSON.parse(r.features), q: r.q ? JSON.parse(r.q) : null, info: r.info ? JSON.parse(r.info) : null,
  }));
const positions = (db: DB, account?: string) =>
  db.prepare(`SELECT * FROM brain_paper_positions ${account ? "WHERE account = ?" : ""} ORDER BY id`).all(...(account ? [account] : [])) as Record<string, any>[];
const count = (db: DB, table: string) => (db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n;

/** A coin with a crowd: tracked buys and a sell in the 5 minutes before T0, each delivered 400 ms after its block. */
function crowd(s: ReturnType<typeof setup>, mint: string, venue = "pumpfun") {
  s.prices.set(mint, 4e-8);
  const at = (ts: number) => ((s.clock.t = ts + 400), s.clock.t);
  s.rt.onSwap(swap(CROWD[0], mint, "buy", T0 - 15 * 60_000, { venue, priceSol: 3e-8 }), at(T0 - 15 * 60_000));
  for (const [k, w] of CROWD.entries()) s.rt.onSwap(swap(w, mint, "buy", T0 - 240_000 + k * 30_000, { venue, priceSol: 4e-8 * (1 + k / 100) }), at(T0 - 240_000 + k * 30_000));
  s.rt.onSwap(swap(CROWD[1], mint, "sell", T0 - 60_000, { venue }), at(T0 - 60_000));
}

test("a leader buy: the decision runs after the stream's call, from the live features, with the manifest's margin; the transition keeps the vector and q", async () => {
  // 1.0 has the best mean (0.5) but the members disagree (std 0.4): with margin_c 1 the Brain stakes 0.5 (score 0.2 vs 0.1)
  const m = stubModels({ entryQ: () => [[0, 0.1, 0.2, 0.2, 0.9], [0, 0.1, 0.2, 0.2, 0.1]], marginC: 1 });
  const s = setup(m);
  const MINT = "RtMintAAAApump";
  crowd(s, MINT);
  const candidates: string[] = [];
  const onCandidate = s.rt.quotes.onCandidate.bind(s.rt.quotes);
  s.rt.quotes.onCandidate = (c) => (candidates.push(`${c.leader}|${c.mint}`), onCandidate(c));
  s.clock.t = T0 + 800;
  const buy = swap(LEADER, MINT, "buy", T0, { solAmount: 0.5, priceSol: 4.2e-8, tokenAmount: 0.5 / 4.2e-8, feeLamports: 120_000 });
  const t0 = performance.now();
  s.rt.onSwap(buy, T0 + 800);
  const syncMs = performance.now() - t0;
  // Nothing decided inside the stream's call: no network run, no DB scan, no transition yet.
  assert.equal(m.calls.entry.length, 0);
  assert.equal(count(s.db, "brain_transitions"), 0);
  assert.ok(syncMs < 20, `onSwap of a leader buy took ${syncMs.toFixed(1)} ms`);
  // The ledgers followed the state: the copy-eligible buy opened its mirror and dd rows.
  assert.equal(count(s.db, "mirror_ledger"), 1);
  assert.equal(count(s.db, "dd_ledger"), 1);

  await s.rt.drain();
  const [e] = transitions(s.db, "entry");
  assert.equal(e.account, "brain");
  assert.equal(e.action, 0.5);
  assert.equal(e.model_version, "rt-1");
  near(e.q[4], 0.1, 1e-9);
  near(e.q[2], 0.2, 1e-9);
  assert.deepEqual(e.info.q_members, [[0, 0.1, 0.2, 0.2, 0.9], [0, 0.1, 0.2, 0.2, 0.1]]);
  assert.equal(e.info.margin_c, 1);
  assert.equal(e.info.gate, null);
  assert.equal(e.info.decided_at, iso(T0 + 800));
  assert.ok(e.info.feature_ms < 50, `features took ${e.info.feature_ms} ms`);

  // The logged vector is exactly features.ts on the server's sources at t, normalised with the manifest's norm and levels.
  assert.equal(e.features.length, ENTRY.columns.length);
  const sig = { wallet: LEADER, mint: MINT, solAmount: 0.5, priceSol: 4.2e-8, venue: "pumpfun", feeLamports: 120_000, T: T0 };
  const src = F.liveSources({ db: s.db, state: s.rt.state, ledger: s.rt.ledger, socialModelVersion: () => null });
  const raw = F.entryRaw(sig, T0 + 800, src);
  const want = F.entryVector(raw, ENTRY.categories, ENTRY.norm);
  e.features.forEach((v: number, i: number) => near(v, want[i], 1e-12));
  assert.deepEqual(e.info.raw, F.rawForLog(raw));
  near(Array.from(m.calls.entry[0])[0], want[0], 1e-6);
  // ... and it saw the crowd (4 other wallets' ok buys in [T − 5 min, T)), the first sighting 15 min back (when the stream
  // delivered the coin's first swap), the fee, the venue
  assert.equal(raw.m_buyers_5m, 4);
  near(raw.mint_first_seen_age_min as number, (T0 + 800 - (T0 - 15 * 60_000 + 400)) / 60_000);
  near(raw.log_fee as number, Math.log1p(120_000));
  assert.equal(raw.venue_group, "pumpfun_curve");
  near(raw.signal_lateness_sec as number, 0.8);

  // The position: 0.5 × COPY_MAX_TRADE_SOL, after the copy delay, with the leader's holding and venue kept for the exit head.
  const [p] = positions(s.db, "brain");
  near(p.cost_sol, 0.05);
  assert.equal(p.venue, "pumpfun");
  near(p.leader_post_buy_tokens, 0.5 / 4.2e-8, 1e-3);
  assert.equal(e.position_id, p.id);
  assert.equal(positions(s.db, "explore").length, 0);
  // The shadow-quote sampler was offered the candidate (its timer isn't started here: nothing asked yet).
  assert.deepEqual(candidates, [`${LEADER}|${MINT}`]);
  assert.equal(s.shadowQuotes.length, 0);
});

test("the leader's sell asks the exit network at once, with the exit vector features.ts computes; sell_all closes the paper position", async () => {
  let exitAction = [1, 0, 0]; // hold
  const m = stubModels({ entryQ: () => [[0, 0, 0, 0, 0.3], [0, 0, 0, 0, 0.3]], exitQ: () => exitAction });
  const s = setup(m);
  const MINT = "RtMintBBBBpump";
  crowd(s, MINT);
  s.clock.t = T0 + 800;
  s.rt.onSwap(swap(LEADER, MINT, "buy", T0, { solAmount: 0.5, priceSol: 4.2e-8, tokenAmount: 1e7 }), T0 + 800);
  await s.rt.drain();
  const [p] = positions(s.db, "brain");
  near(p.cost_sol, 0.1);
  assert.equal(p.status, "open");

  // A tracked swap at an ok price only marks the coin (an exit check at most every 15 s): hold.
  s.prices.set(MINT, 5e-8);
  s.clock.t = T0 + 20_000;
  s.rt.onSwap(swap(CROWD[2], MINT, "buy", T0 + 19_600, { priceSol: 5e-8 }), s.clock.t);
  await s.rt.drain();
  const before = m.calls.exit.length;

  // The leader sells 60% of its holding: evaluated at once (no tick), leader_sold set, leader_sold_frac 0.6.
  exitAction = [0, 0, 1];
  const sells: string[] = [];
  const onLeaderSell = s.rt.quotes.onLeaderSell.bind(s.rt.quotes);
  s.rt.quotes.onLeaderSell = (l, mint, t) => (sells.push(`${l}|${mint}|${t}`), onLeaderSell(l, mint, t));
  s.clock.t = T0 + 25_000;
  s.rt.onSwap(swap(LEADER, MINT, "sell", T0 + 24_500, { tokenAmount: 6e6, tokenBalanceBefore: 1e7, priceSol: 5e-8, solAmount: 0.3 }), s.clock.t);
  await s.rt.drain();
  assert.equal(m.calls.exit.length, before + 1, "one exit evaluation, on the sell");
  const exits = transitions(s.db, "exit");
  const last = exits.at(-1)!;
  assert.equal(last.action, 2, "sell_all");
  assert.deepEqual(last.q, [0, 0, 1]);
  assert.equal(last.features.length, EXIT.columns.length);
  const col = (name: string) => last.features[EXIT.columns.indexOf(name)];
  const z = (name: string, v: number) => (v - EXIT.norm.mean[EXIT.columns.indexOf(name)]) / EXIT.norm.std[EXIT.columns.indexOf(name)];
  near(col("leader_sold"), z("leader_sold", 1));
  near(col("leader_sold_frac"), z("leader_sold_frac", 0.6));
  near(col("entry_venue_pumpswap"), z("entry_venue_pumpswap", 0));
  near(col("position"), z("position", 1));
  // the coin's 5-min flow at t, the leader left out: CROWD[2] bought at T0 + 19.6 s
  assert.ok(col("oth_buyers_5m") > z("oth_buyers_5m", 0));
  const [c] = positions(s.db, "brain");
  assert.equal(c.status, "closed");
  assert.ok(s.sold.some((x) => x.mint === MINT), "sold at a quote");
  // the ledgers saw the sell (a ps row waits for its hour), and the shadow quotes were told
  assert.equal(count(s.db, "ps_ledger"), 1);
  assert.deepEqual(sells, [`${LEADER}|${MINT}|${T0 + 24_500}`]);
});

test("hard gates first: a young AMM coin's buy is logged as a skip with info.gate, and the network isn't asked", async () => {
  const m = stubModels({ entryQ: () => [[0, 1, 1, 1, 1], [0, 1, 1, 1, 1]] });
  const s = setup(m);
  const MINT = "RtMintCCCC";
  s.prices.set(MINT, 2e-4);
  s.clock.t = T0 + 700;
  // the coin's first sighting is this very swap, on pumpswap
  s.rt.onSwap(swap(LEADER, MINT, "buy", T0, { solAmount: 1, priceSol: 2e-5, tokenAmount: 5e4, venue: "pumpswap" }), T0 + 700);
  await s.rt.drain();
  assert.equal(m.calls.entry.length, 0);
  const [e] = transitions(s.db, "entry");
  assert.deepEqual([e.account, e.action, e.q, e.done, e.reward], ["brain", 0, null, 1, 0]);
  assert.equal(e.info.gate, "young_amm");
  assert.equal(e.features.length, ENTRY.columns.length, "the vector is still logged");
  assert.equal(e.info.raw.mint_first_seen_age_min, null);
  assert.equal(positions(s.db).length, 0);
});

test("brain_enabled false: the Brain account skips every signal; Explore (routed at explore.rate) still trades with Thompson sampling", async () => {
  const qs = () => [[0, 0.2, 0.1, 0.1, 0.1], [0, 0.1, 0.1, 0.1, 0.3]];
  // rng 0.9: not explored → Brain, which skips
  const off = setup(stubModels({ entryQ: qs, brainEnabled: false, exploreRate: 0.5 }), () => 0.9);
  crowd(off, "RtMintDDDDpump");
  off.clock.t = T0 + 800;
  off.rt.onSwap(swap(LEADER, "RtMintDDDDpump", "buy", T0, { solAmount: 0.5 }), T0 + 800);
  await off.rt.drain();
  const [b] = transitions(off.db, "entry");
  assert.deepEqual([b.account, b.action, b.info.brain_enabled], ["brain", 0, false]);
  assert.equal(positions(off.db).length, 0);

  // rng 0.2: explored (0.2 < 0.5), member floor(0.2 × 2) = 0 decides → 0.25
  const on = setup(stubModels({ entryQ: qs, brainEnabled: false, exploreRate: 0.5 }), () => 0.2);
  crowd(on, "RtMintEEEEpump");
  on.clock.t = T0 + 800;
  on.rt.onSwap(swap(LEADER, "RtMintEEEEpump", "buy", T0, { solAmount: 0.5 }), T0 + 800);
  await on.rt.drain();
  const [x] = transitions(on.db, "entry");
  assert.deepEqual([x.account, x.action, x.info.member], ["explore", 0.25, 0]);
  const [p] = positions(on.db);
  assert.deepEqual([p.account, p.explore], ["explore", 1]);
  near(p.cost_sol, 0.025);
});

test("tickLedgers runs the state's and the ledgers' clocks: a mirror row with no follower in [buy + 15 s, buy + 135 s] resolves as no_entry", async () => {
  const s = setup(stubModels({}));
  crowd(s, "RtMintFFFFpump");
  s.clock.t = T0 + 800;
  s.rt.onSwap(swap(LEADER, "RtMintFFFFpump", "buy", T0, { solAmount: 0.5 }), T0 + 800);
  await s.rt.drain();
  const row = () => s.db.prepare("SELECT exit_kind, resolved_at, y FROM mirror_ledger").get() as { exit_kind: string | null; resolved_at: string | null; y: number | null };
  assert.equal(row().resolved_at, null);
  s.clock.t = T0 + 4 * 60_000;
  await s.rt.tickLedgers();
  assert.deepEqual([row().exit_kind, row().y], ["no_entry", null]);
  assert.ok(row().resolved_at);
});

test("the stream's hot path stays synchronous and cheap: thousands of swaps, the leader scans only in the async buy path, never a throw", async () => {
  const m = stubModels({});
  let scans = 0;
  // Count the leader scans (features.ts liveSources prepares its statement when the runtime is made).
  const s = setup(m, () => 0.5, (db) => {
    const prepare = db.prepare.bind(db);
    (db as any).prepare = (sql: string) => {
      const st = prepare(sql);
      if (/FROM wallet_swaps WHERE wallet = \? AND ts >= \?/.test(sql)) {
        const all = st.all.bind(st);
        (st as any).all = (...a: unknown[]) => (scans++, all(...a));
      }
      return st;
    };
  });
  let signals = 0;
  const t0 = performance.now();
  for (let k = 0; k < 3_000; k++) {
    s.clock.t = T0 - 600_000 + k * 100;
    const leader = k % 50 === 49;
    if (leader) signals++;
    const sw = leader
      ? swap(LEADER, `RtCoin${k % 300}pump`, "buy", s.clock.t - 300, { solAmount: 0.5 })
      : swap(CROWD[k % CROWD.length], `RtCoin${k % 300}pump`, k % 3 ? "buy" : "sell", s.clock.t - 300, { priceSol: 1e-7 * (1 + (k % 7) / 100) });
    s.rt.onSwap(sw, s.clock.t);
    assert.equal(scans, 0, "no DB scan inside the stream's call");
  }
  const ms = performance.now() - t0;
  assert.ok(ms < 1_500, `3,000 swaps took ${ms.toFixed(0)} ms`);
  // garbage never throws out of onSwap
  assert.doesNotThrow(() => s.rt.onSwap({ ...swap(CROWD[0], "RtCoinXpump", "buy", T0), ts: "not a time", priceSol: NaN, solAmount: -1 }));
  assert.doesNotThrow(() => s.rt.onSwap({} as ParsedSwap));
  await s.rt.drain();
  // each copy-eligible leader buy was decided once, after the stream's call; the crowd's 0.1 SOL buys are no signal
  assert.equal(m.calls.entry.length, signals);
  assert.equal(scans, signals);
  console.log(`onSwap: ${((ms / 3_000) * 1000).toFixed(1)} µs a swap (3,000 swaps over 300 coins, ${signals} signals)`);
});
