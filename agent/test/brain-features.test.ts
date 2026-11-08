/**
 * The Brain's inputs (brain/features.ts) against brain/spec/golden/entry.json and exit.json, raw and normalised, to 1e-6:
 * once with every source read from the case (the golden shapes), once with the DB and ledger sources read by the server's
 * own queries (liveSources over an in-memory database holding the case's rows), and the layout against features.yaml.
 * Then the latency budget: a whole entry vector from the live sources, for a busy bot leader on a crowded coin, under
 * 50 ms. In-memory database, a set clock: no network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, type DB } from "@godseye/shared";
import type { ParsedSwap } from "../src/chain/parse";

process.env.MIN_LEADER_BUY_SOL = "0.2";
const F = await import("../src/brain/features");
const { StreamState } = await import("../src/brain/state");
const { MirrorLedger, logOutcome } = await import("../src/brain/ledger");
const { ensureSocialTables } = await import("../src/social/schema");
const { validateManifest } = await import("../src/brain/model");
type EntrySources = import("../src/brain/features").EntrySources;
type RawValues = import("../src/brain/features").RawValues;

const SPEC = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../brain/spec");
const read = (name: string) => JSON.parse(fs.readFileSync(path.join(SPEC, "golden", name), "utf8"));
const ENTRY = read("entry.json");
const EXIT = read("exit.json");
const W7 = 7 * 86_400_000;
const TOL = 1e-6;

/** Epoch ms of an ISO string (a DB row) or a number (in-memory state); null stays null. */
const msec = (v: unknown): number | null => (v === null || v === undefined ? null : typeof v === "string" ? Date.parse(v) : Math.round(Number(v)));

/* eslint-disable @typescript-eslint/no-explicit-any */
type Case = { name: string; input: any; expected: { gate?: string | null; raw: Record<string, number | string | null>; vector: number[] } };

/** A golden entry case's sources: each reads the case the way the server's structure would answer (README "Entry case input"). */
function caseSources(c: any): EntrySources {
  const led = c.ledgers ?? {};
  const db = c.db ?? {};
  const T = Date.parse(c.swap.ts);
  const in7 = (v: unknown, t: number) => {
    const a = msec(v);
    return a !== null && t - W7 <= a && a < t;
  };
  const ring = (c.ring ?? []).map((r: any) => ({ ...r, ts: msec(r.ts)!, at: msec(r.at)! }));
  return {
    cp: (_l, t) => {
      const rows = (led.mirror ?? []).filter((r: any) => r.y !== null && r.y !== undefined && in7(r.resolved_at, t));
      const n = rows.length;
      const lr = rows.reduce((s: number, r: any) => s + (r.lr !== null && r.lr !== undefined ? r.lr : logOutcome(r.y)), 0);
      return { cp_lrshr_7d: lr / (n + 20), cp_n_7d: n, cp_win_7d: n ? rows.filter((r: any) => r.y > 0).length / n : null };
    },
    psR: (_l, t) => {
      const xs = (led.ps ?? []).filter((r: any) => r.done && r.r !== null && r.r !== undefined && in7(r.avail_at, t)).map((r: any) => r.r as number);
      return xs.length ? xs.reduce((a: number, b: number) => a + b, 0) / xs.length : null;
    },
    ddRate: (_l, t) => {
      const xs = (led.dd ?? []).filter((r: any) => r.done && r.dead !== null && r.dead !== undefined && in7(r.avail_at, t)).map((r: any) => Number(r.dead));
      return xs.length ? xs.reduce((a: number, b: number) => a + b, 0) / xs.length : null;
    },
    leaderSwaps: () => (db.wallet_swaps ?? []).map((r: any) => ({ mint: r.mint, side: r.side, sol: r.sol_amount, ts: msec(r.ts)! })),
    ring: (_m, end, w, known) => ring.filter((r: any) => r.at < known && r.ts >= end - w && r.ts < end),
    maxOkBefore: (_m, cut, t) => {
      const lo = T - W7;
      const highs = ring.filter((r: any) => r.ok && r.at < t && r.ts >= lo && r.ts < cut).map((r: any) => r.price as number);
      const hm = c.hist_max;
      if (hm && msec(hm.at)! < t && msec(hm.ts)! >= lo && msec(hm.ts)! < cut) highs.push(hm.price);
      return highs.length ? Math.max(...highs) : null;
    },
    firstSeen: () => c.first_seen ?? null,
    creatorCoins7d: (_c, t, except) => (db.creator_coins ?? []).filter((r: any) => r.mint !== except && in7(r.first_seen_at, t)).length,
    leaderHolding: () => c.leader_holding ?? null,
    activeWallets1h: () => c.active_wallets_1h ?? null,
    tokenInfo: () => (db.token_info ? { poolCreatedAt: msec(db.token_info.pool_created_at), launchCheckedAt: msec(db.token_info.launch_checked_at) } : null),
    social: () => (db.social_scores ? { score: db.social_scores.score, modelVersion: db.social_scores.model_version, updatedAt: msec(db.social_scores.updated_at) } : null),
    socialModelVersion: () => db.social_model_version ?? null,
  };
}

const signalOf = (c: any) => ({
  wallet: c.swap.wallet, mint: c.swap.mint, solAmount: c.swap.sol_amount, priceSol: c.swap.price_sol, venue: c.swap.venue,
  feeLamports: c.swap.fee_lamports, T: Date.parse(c.swap.ts),
});
const screenOf = (c: any) => (c.screen ? { failed: !!c.screen.failed, lpLockedPct: c.screen.lp_locked_pct ?? null } : null);

function sameRaw(name: string, got: RawValues, want: Case["expected"]["raw"]): void {
  assert.deepEqual(Object.keys(got).sort(), Object.keys(want).sort(), `${name}: feature names`);
  for (const [k, w] of Object.entries(want)) {
    const g = got[k];
    if (w === null) assert.ok(typeof g === "number" && Number.isNaN(g), `${name}.${k}: ${g}, expected missing`);
    else if (typeof w === "string") assert.equal(g, w, `${name}.${k}`);
    else assert.ok(typeof g === "number" && Math.abs(g - w) <= TOL, `${name}.${k}: ${g}, expected ${w}`);
  }
}

function sameVector(name: string, got: number[], want: number[], cols: string[]): void {
  assert.equal(got.length, want.length, `${name}: vector length`);
  got.forEach((g, i) => assert.ok(Math.abs(g - want[i]) <= TOL, `${name} ${cols[i]}: ${g}, expected ${want[i]}`));
}

// ---------------------------------------------------------------------------------------------------------------------
// The layout

/** features.yaml's `entry` / `exit` lists: name, transform, missing_flag and default of each (a reader for its regular shape). */
function specFeatures(head: "entry" | "exit"): { name: string; transform: string; missingFlag: boolean; default: string }[] {
  const lines = fs.readFileSync(path.join(SPEC, "features.yaml"), "utf8").split("\n");
  const start = lines.indexOf(`${head}:`);
  assert.ok(start >= 0, `features.yaml has no ${head}:`);
  const out: { name: string; transform: string; missingFlag: boolean; default: string }[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break; // the next top-level key
    const name = /^ {2}- name: (\S+)/.exec(line);
    if (name) out.push({ name: name[1], transform: "none", missingFlag: false, default: "0" });
    const kv = /^ {4}(transform|missing_flag|default): (.+)$/.exec(line);
    if (kv && out.length) {
      const v = kv[2].trim().replace(/^"(.*)"$/, "$1");
      const cur = out[out.length - 1];
      if (kv[1] === "transform") cur.transform = v;
      else if (kv[1] === "missing_flag") cur.missingFlag = v === "true";
      else cur.default = v;
    }
  }
  return out;
}

test("the feature lists follow features.yaml: names, order, transforms, missing flags and defaults; the version too", () => {
  const yaml = fs.readFileSync(path.join(SPEC, "features.yaml"), "utf8");
  assert.equal(Number(/^version: (\d+)/m.exec(yaml)![1]), F.FEATURE_SPEC_VERSION);
  assert.equal(ENTRY.feature_spec_version, F.FEATURE_SPEC_VERSION);
  for (const [head, ours] of [["entry", F.ENTRY_FEATURES], ["exit", F.EXIT_FEATURES]] as const) {
    const spec = specFeatures(head);
    assert.deepEqual(ours.map((x) => x.name), spec.map((x) => x.name), `${head} names`);
    for (const [i, s] of spec.entries()) {
      const o = ours[i];
      assert.equal(o.transform, s.transform, `${s.name} transform`);
      assert.equal(o.missingFlag, s.missingFlag, `${s.name} missing_flag`);
      if (s.default === "train_mean" || o.transform === "onehot") assert.equal(String(o.default), s.default, `${s.name} default`);
      else assert.equal(o.default, Number(s.default), `${s.name} default`);
    }
  }
  assert.deepEqual(F.ENTRY_FEATURES.map((x) => x.name), ENTRY.features);
  assert.deepEqual(F.entryColumns(ENTRY.categories), ENTRY.columns);
  assert.deepEqual(F.EXIT_FEATURES.map((x) => x.name), EXIT.features);
  assert.deepEqual(F.exitColumns(), EXIT.columns);
  assert.throws(() => F.entryColumns({}), /categories\.venue_group: no levels/);
  // venue_group's rules, first match wins
  const groups = /venue_groups:\n((?: {6}- .+\n)+)/.exec(yaml)![1];
  assert.equal(groups.trim().split("\n").length, F.VENUE_GROUPS.length);
  for (const g of F.VENUE_GROUPS) assert.ok(groups.includes(`level: ${g.level}`), g.level);
  assert.deepEqual(
    ["pumpfun", "PumpSwap (via bot)", "meteora damm v2", "meteora dbc", "raydium launchlab", "orca whirlpool", "jupiter", "lifinity", null, " "].map(F.venueGroup),
    ["pumpfun_curve", "pumpswap", "meteora_damm_v2", "meteora_other", "raydium", "orca", "jupiter", "other", "missing", "missing"],
  );
});

// ---------------------------------------------------------------------------------------------------------------------
// The golden cases

test("entry: every golden case, raw values, gate and normalised vector, to 1e-6", () => {
  assert.ok(ENTRY.cases.length >= 49, `${ENTRY.cases.length} entry cases`);
  for (const c of ENTRY.cases as Case[]) {
    const sig = signalOf(c.input);
    const t = Date.parse(c.input.now);
    const src = caseSources(c.input);
    const raw = F.entryRaw(sig, t, src);
    sameRaw(c.name, raw, c.expected.raw);
    assert.equal(F.entryGate(sig, t, src, screenOf(c.input)), c.expected.gate ?? null, `${c.name}: gate`);
    sameVector(c.name, F.entryVector(raw, ENTRY.categories, ENTRY.norm), c.expected.vector, ENTRY.columns);
  }
});

test("exit: every golden case, raw values and normalised vector, to 1e-6", () => {
  assert.ok(EXIT.cases.length >= 11, `${EXIT.cases.length} exit cases`);
  for (const c of EXIT.cases as Case[]) {
    const i = c.input;
    const t = Date.parse(i.now);
    const ring = (i.ring ?? []).map((r: any) => ({ ...r, ts: msec(r.ts)!, at: msec(r.at)! }));
    const raw = F.exitRaw({
      ...i.state,
      tokens: i.position.tokens, tokens_left: i.position.tokens_left, venue: i.position.venue ?? null,
      flow: F.ringFlow(ring, t, i.position.leader ?? null),
      active_wallets_1h: i.active_wallets_1h ?? null,
      leader_ps_r_7d: i.leader_ps_r_7d ?? null,
    });
    sameRaw(c.name, raw, c.expected.raw);
    sameVector(c.name, F.exitVector(raw, EXIT.norm), c.expected.vector, EXIT.columns);
  }
});

test("a model manifest carrying the golden levels and norm passes the runtime's column check and reproduces every vector", () => {
  const sha = "0".repeat(64);
  const m = validateManifest(
    {
      version: "golden", created_at: "", feature_spec_version: F.FEATURE_SPEC_VERSION, brain_enabled: true,
      entry: { features: ENTRY.columns, norm: ENTRY.norm, members: ["entry-0.onnx"], input: "x", output: "q", actions: [0, 0.25, 0.5, 0.75, 1], margin_c: 0.5, categories: ENTRY.categories },
      exit: { features: EXIT.columns, norm: EXIT.norm, file: "exit.onnx", input: "x", output: "q", actions: ["hold", "sell_half", "sell_all"] },
      explore: { rate: 0.1, curiosity: 0.5 }, metrics: {}, sha256: { "entry-0.onnx": sha, "exit.onnx": sha },
    },
    { featureSpecVersion: F.FEATURE_SPEC_VERSION, entryColumns: F.entryColumns, exitColumns: F.exitColumns() },
  );
  for (const c of ENTRY.cases as Case[]) {
    const raw = F.entryRaw(signalOf(c.input), Date.parse(c.input.now), caseSources(c.input));
    sameVector(c.name, F.entryVector(raw, m.entry.categories, m.entry.norm), c.expected.vector, m.entry.features);
  }
  for (const c of EXIT.cases as Case[]) sameVector(c.name, F.exitVector(c.expected.raw, m.exit.norm), c.expected.vector, m.exit.features);
});

test("encode / normalise: missing values, defaults, unseen levels, and a norm of the wrong width", () => {
  const cats = { venue_group: ["pumpswap", "missing", "other"] };
  const x = F.encode({ venue_group: "orca" }, F.ENTRY_FEATURES, cats);
  const cols = F.entryColumns(cats);
  const at = (c: string) => x[cols.indexOf(c)];
  assert.equal(at("venue_group=other"), 1, "an unseen level is other");
  assert.equal(at("venue_group=pumpswap"), 0);
  assert.ok(Number.isNaN(at("cp_win_7d")) && at("cp_win_7d_missing") === 1, "train_mean: NaN until normalised, flagged");
  assert.equal(at("b_size_ratio"), 0, "a numeric default, before the transform");
  assert.equal(at("signal_lateness_sec"), Math.log1p(1));
  assert.equal(at("hour_cos"), 1);
  assert.equal(at("social_missing"), 1);
  assert.equal(F.encode({}, F.ENTRY_FEATURES, cats)[cols.indexOf("venue_group=missing")], 1, "no venue: the default level");
  const z = F.normalise(x, { mean: x.map(() => 0.5), std: x.map(() => 2) });
  assert.equal(z[cols.indexOf("cp_win_7d")], 0, "missing → the training mean");
  assert.ok(z.every(Number.isFinite));
  assert.throws(() => F.normalise(x, { mean: [0], std: [1] }), /norm has 1 columns/);
  assert.deepEqual([F.transform("signed_log", -Math.E + 1), F.transform("log10", 0.5), F.transform("clip:-1,3", 7)], [-1, 0, 3]);
  assert.deepEqual(F.rawForLog({ a: NaN, b: 1, c: "pumpswap" }), { a: null, b: 1, c: "pumpswap" });
});

// ---------------------------------------------------------------------------------------------------------------------
// The server's own queries on the case's rows

const iso = (ms: number) => new Date(ms).toISOString();
let seq = 0;

/** The case's DB rows and ledger rows, written where the server keeps them. */
function materialise(db: DB, c: any): void {
  const leader = c.swap.wallet;
  const d = c.db ?? {};
  const put = db.prepare(
    "INSERT INTO wallet_swaps (wallet, signature, slot, ts, mint, side, token_amount, sol_amount, price_sol) VALUES (?, ?, 0, ?, ?, ?, 1000, ?, 1e-6)",
  );
  for (const r of d.wallet_swaps ?? []) put.run(leader, `sig${++seq}`, r.ts, r.mint, r.side, r.sol_amount);
  if (d.token_info) {
    db.prepare("INSERT INTO token_info (mint, pool_created_at, checked_at, launch_checked_at) VALUES (?, ?, ?, ?)").run(
      c.swap.mint, d.token_info.pool_created_at ?? null, c.now, d.token_info.launch_checked_at ?? null,
    );
  }
  const creator = c.first_seen?.creator;
  if (creator) {
    const fs1 = db.prepare("INSERT INTO brain_token_first_seen (mint, first_seen_at, source, creator, creator_resolved_at) VALUES (?, ?, 'stream', ?, ?)");
    // The coin's own row (one per mint): it never counts, whatever its first_seen_at.
    for (const r of d.creator_coins ?? []) if (r.mint !== c.swap.mint) fs1.run(r.mint, r.first_seen_at, creator, r.first_seen_at);
    fs1.run(c.swap.mint, iso(c.first_seen.firstSeenAt), creator, c.now);
  }
  if (d.social_scores) {
    ensureSocialTables(db);
    const s = d.social_scores;
    db.prepare("INSERT INTO social_scores (wallet, score, n_posts, model_version, updated_at) VALUES (?, ?, 1, ?, ?)").run(leader, s.score, s.model_version, s.updated_at);
  }
  const led = c.ledgers ?? {};
  const m = db.prepare("INSERT INTO mirror_ledger (leader, mint, buy_ts, buy_sig, y, lr, resolved_at, exit_kind, created_at) VALUES (?, 'M', ?, ?, ?, ?, ?, 'leader_sell', ?)");
  for (const r of led.mirror ?? []) m.run(leader, r.resolved_at, `b${++seq}`, r.y ?? null, r.lr ?? (r.y === null || r.y === undefined ? null : logOutcome(r.y)), r.resolved_at, r.resolved_at);
  const p = db.prepare("INSERT INTO ps_ledger (leader, mint, buy_sig, sell_ts, avail_at, r, done) VALUES (?, 'M', ?, ?, ?, ?, ?)");
  for (const r of led.ps ?? []) p.run(leader, `b${++seq}`, r.avail_at, r.avail_at, r.r ?? null, r.done ? 1 : 0);
  const q = db.prepare("INSERT INTO dd_ledger (leader, mint, buy_sig, buy_ts, avail_at, dead, done) VALUES (?, 'M', ?, ?, ?, ?, ?)");
  for (const r of led.dd ?? []) q.run(leader, `b${++seq}`, r.avail_at, r.avail_at, r.dead ?? null, r.done ? 1 : 0);
}

test("entry: the server's queries (ledgers, the leader scan, creators, token_info, social_scores) reproduce every case", () => {
  for (const c of ENTRY.cases as Case[]) {
    const i = c.input;
    const t = Date.parse(i.now);
    const db = openDb(":memory:");
    const state = new StreamState(db, { now: () => t, lookupCreator: async () => "" });
    const ledger = new MirrorLedger(db, state, { now: () => t });
    materialise(db, i);
    const live = F.liveSources({ db, state, ledger, socialModelVersion: () => i.db?.social_model_version ?? null });
    // The ring, the first sighting, the holding and the hourly count are in-memory state the case gives as is.
    const own = caseSources(i);
    const src: EntrySources = { ...live, ring: own.ring, maxOkBefore: own.maxOkBefore, firstSeen: own.firstSeen, leaderHolding: own.leaderHolding, activeWallets1h: own.activeWallets1h };
    const raw = F.entryRaw(signalOf(i), t, src);
    sameRaw(`${c.name} (live)`, raw, c.expected.raw);
    sameVector(`${c.name} (live)`, F.entryVector(raw, ENTRY.categories, ENTRY.norm), c.expected.vector, ENTRY.columns);
    db.close();
  }
});

test("live sources: no social_scores table yet reads as no row; a table made later is read", () => {
  const db = openDb(":memory:");
  const state = new StreamState(db, { lookupCreator: async () => "" });
  const ledger = new MirrorLedger(db, state);
  const live = F.liveSources({ db, state, ledger, socialModelVersion: () => "s1" });
  if (!(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'social_scores'").get())) assert.equal(live.social("W"), null);
  ensureSocialTables(db);
  db.prepare("INSERT OR REPLACE INTO social_scores (wallet, score, n_posts, model_version, updated_at) VALUES ('W', 0.2, 3, 's1', '2026-11-10T12:00:00.000Z')").run();
  assert.deepEqual(live.social("W"), { score: 0.2, modelVersion: "s1", updatedAt: Date.parse("2026-11-10T12:00:00.000Z") });
  assert.equal(live.tokenInfo("nope"), null);
});

test("live sources: the leader scan keeps the insert-time rule (a row stored at or after t was not known)", () => {
  const db = openDb(":memory:");
  const state = new StreamState(db, { lookupCreator: async () => "" });
  const ledger = new MirrorLedger(db, state);
  const live = F.liveSources({ db, state, ledger, socialModelVersion: () => null });
  const T = Date.parse("2026-11-10T12:00:00.000Z");
  const t = T + 800;
  const put = db.prepare("INSERT INTO wallet_swaps (wallet, signature, slot, ts, mint, side, token_amount, sol_amount, price_sol, ins_ms) VALUES ('L', ?, 0, ?, ?, 'buy', 1000, 0.5, 1e-6, ?)");
  put.run("old", iso(T - 3_600_000), "A", null); // stored before ins_ms existed: counts
  put.run("live", iso(T - 60_000), "B", T - 59_000); // stored a second after its block: counts
  put.run("edge", iso(T - 30_000), "C", t); // stored exactly at t: not known
  put.run("backfill", iso(T - 7_200_000), "D", t + 5_000); // an old swap backfilled after the decision
  put.run("window", iso(T - W7 - 5_000), "E", null); // out of the 7-day window (and the scan's 1 s slack)
  assert.deepEqual(live.leaderSwaps("L", T - W7, T, t).map((r) => r.mint).sort(), ["A", "B"]);
  const sig = { wallet: "L", mint: "X", solAmount: 0.5, priceSol: 1e-6, venue: "pumpfun", feeLamports: 0, T };
  const raw = F.entryRaw(sig, t, live);
  assert.deepEqual([raw.b_n_24h, raw.leader_n_prior7], [2, 2]);
  db.close();
});

// ---------------------------------------------------------------------------------------------------------------------
// The latency budget

test("latency: a whole entry vector from the live sources stays under 50 ms (busy bot leader, crowded coin)", async () => {
  const T0 = Date.parse("2026-11-10T12:00:00Z");
  let now = T0 - 70 * 60_000;
  const db = openDb(":memory:");
  const LEADER = "BusyBotLeader";
  const MINT = "CrowdedMintpump";
  const wallets = Array.from({ length: 300 }, (_, k) => `Tracked${k}`);
  const addW = db.prepare("INSERT INTO wallets (address, first_seen_at, discovered_via) VALUES (?, ?, 'manual')");
  for (const w of [LEADER, ...wallets]) addW.run(w, iso(T0 - 30 * 86_400_000));
  const state = new StreamState(db, { now: () => now, lookupCreator: async () => "CreatorX" });
  const ledger = new MirrorLedger(db, state, { now: () => now });

  // The leader's last 7 days: 6,000 swaps over 1,500 coins (a bot), stored in wallet_swaps.
  const put = db.prepare("INSERT INTO wallet_swaps (wallet, signature, slot, ts, mint, side, token_amount, sol_amount, price_sol) VALUES (?, ?, 0, ?, ?, ?, 1000, ?, 1e-6)");
  db.transaction(() => {
    for (let k = 0; k < 6_000; k++) put.run(LEADER, `L${k}`, iso(T0 - W7 + k * 100_000), `Coin${k % 1500}pump`, k % 3 ? "buy" : "sell", 0.05 + (k % 7) * 0.1);
  })();
  // Its ledgers: 400 mirror rows, 300 ps rows, 300 dd rows in the week.
  db.transaction(() => {
    for (let k = 0; k < 400; k++) {
      db.prepare("INSERT INTO mirror_ledger (leader, mint, buy_ts, buy_sig, y, lr, resolved_at, created_at) VALUES (?, 'M', ?, ?, ?, ?, ?, ?)").run(
        LEADER, iso(T0 - k * 1_000_000), `m${k}`, (k % 5) / 10 - 0.2, logOutcome((k % 5) / 10 - 0.2), iso(T0 - k * 1_000_000), iso(T0),
      );
    }
    for (let k = 0; k < 300; k++) {
      db.prepare("INSERT INTO ps_ledger (leader, mint, buy_sig, sell_ts, avail_at, r, done) VALUES (?, 'M', ?, ?, ?, 0.1, 1)").run(LEADER, `p${k}`, iso(T0 - k * 1_500_000), iso(T0 - k * 1_500_000));
      db.prepare("INSERT INTO dd_ledger (leader, mint, buy_sig, buy_ts, avail_at, dead, done) VALUES (?, 'M', ?, ?, ?, ?, 1)").run(LEADER, `d${k}`, iso(T0 - k * 1_500_000), iso(T0 - k * 1_500_000), k % 2);
    }
  })();
  db.prepare("INSERT INTO token_info (mint, pool_created_at, checked_at, launch_checked_at) VALUES (?, ?, ?, ?)").run(MINT, iso(T0 - 3_600_000), iso(T0), iso(T0 - 1_800_000));

  // The coin's last 70 minutes on the stream: 4,000 tracked swaps by 300 wallets.
  const swap = (wallet: string, k: number, ts: number): ParsedSwap => ({
    wallet, signature: `S${k}`, slot: k, ts: iso(ts), mint: MINT, side: k % 4 ? "buy" : "sell", tokenAmount: 1e6, tokenBalanceBefore: 0,
    solAmount: 0.1 + (k % 9) * 0.05, priceSol: 4e-8 * (1 + (k % 13) / 50), quote: "SOL", quoteAmount: 0.1, solUsd: null, usdAmount: null,
    venue: "pumpfun", jitoTip: false, feeLamports: 5000,
  });
  for (let k = 0; k < 4_000; k++) {
    now = T0 - 70 * 60_000 + k * 1_050;
    state.onSwap(swap(wallets[k % wallets.length], k, now - 400), now);
  }
  now = T0 + 800;
  const leaderBuy = { ...swap(LEADER, 99_999, T0), side: "buy" as const, solAmount: 1.5, feeLamports: 150_000 };
  const kept = state.onSwap(leaderBuy, now)!;
  assert.ok(kept && state.stats().swaps > 3_000, `ring holds ${state.stats().swaps} swaps`);

  const live = F.liveSources({ db, state, ledger, socialModelVersion: () => null });
  const sig = { wallet: LEADER, mint: MINT, solAmount: 1.5, priceSol: leaderBuy.priceSol, venue: "pumpfun", feeLamports: 150_000, T: T0 };
  const times: number[] = [];
  let z: number[] = [];
  for (let k = 0; k < 100; k++) {
    const t0 = performance.now();
    const raw = F.entryRaw(sig, now, live);
    F.entryGate(sig, now, live);
    z = F.entryVector(raw, ENTRY.categories, ENTRY.norm);
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const raw = F.entryRaw(sig, now, live);
  assert.equal(z.length, ENTRY.columns.length);
  assert.ok((raw.b_n_24h as number) > 100 && (raw.cp_n_7d as number) > 0 && (raw.m_buyers_5m as number) > 50, "the sources were all read");
  assert.ok(times[times.length - 1] < 50, `slowest entry vector ${times[times.length - 1].toFixed(1)} ms (median ${times[50].toFixed(1)} ms)`);
  console.log(`entry vector: median ${times[50].toFixed(2)} ms, slowest ${times[times.length - 1].toFixed(2)} ms (ring ${state.stats().swaps} swaps, scan 6,000 rows)`);
  await new Promise((r) => setImmediate(r)); // the stub creator lookups write their answers first
  db.close();
});
