/**
 * Brain model runtime (brain/model.ts, brain/policy.ts): bundle loading with hash checks, hot reload and rollback, and
 * the pure entry / explore / exit rules of brain/spec/CONTRACT.md. The bundles are tiny PyTorch nets exported to ONNX by
 * test/fixtures/brain/make-fixtures.py, with the q values PyTorch computed for one input. In-memory database, no network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, repoRoot } from "@godseye/shared";

const { BrainModels, loadBundle, validateManifest, ensureBrainModelTables } = await import("../src/brain/model");
const { normalise, decideEntry, decideExplore, decideExit, decideSignal, routeSignal, routeToExplore, pickStake, ensembleStats, hardStops, seededRng } =
  await import("../src/brain/policy");

const FIX = fileURLToPath(new URL("./fixtures/brain/", import.meta.url));
const expected = JSON.parse(fs.readFileSync(path.join(FIX, "expected.json"), "utf8"));
const V1 = expected.v1.version as string;
const V2 = expected.v2.version as string;
const BAD = JSON.parse(fs.readFileSync(path.join(FIX, "bad-hash", "manifest.json"), "utf8")).version as string;
const STAKES = [0, 0.25, 0.5, 0.75, 1];

let dirs = 0;
/** A fresh BRAIN_DIR under the test root with the given fixture bundles in models/<version>/. Returns its name. */
function brainDir(bundles: string[]): string {
  const name = `brain-${++dirs}`;
  const root = path.join(repoRoot(), name);
  for (const b of bundles) {
    const version = JSON.parse(fs.readFileSync(path.join(FIX, b, "manifest.json"), "utf8")).version;
    fs.cpSync(path.join(FIX, b), path.join(root, "models", version), { recursive: true });
  }
  return name;
}

/** Points <dir>/current at models/<version> atomically, as the push script does. */
function point(dir: string, version: string): void {
  const root = path.join(repoRoot(), dir);
  const tmp = path.join(root, `current.tmp-${Date.now()}-${Math.random()}`);
  fs.symlinkSync(path.join("models", version), tmp);
  fs.renameSync(tmp, path.join(root, "current"));
}

const close = (a: number[], b: number[], tol = 1e-5) => {
  assert.equal(a.length, b.length);
  a.forEach((x, i) => assert.ok(Math.abs(x - b[i]) <= tol, `q[${i}] = ${x}, expected ${b[i]}`));
};

const rows = (db: ReturnType<typeof openDb>) =>
  Object.fromEntries(
    (db.prepare("SELECT version, status, error FROM brain_models").all() as { version: string; status: string; error: string | null }[]).map((r) => [
      r.version,
      r,
    ]),
  );

test("load: a valid bundle runs, matches PyTorch's numbers, and a batch of one is fast", async () => {
  const dir = brainDir(["v1"]);
  const m = await loadBundle(path.join(repoRoot(), dir, "models", V1));
  try {
    assert.equal(m.version, V1);
    assert.equal(m.manifest.entry.members.length, 5);
    const qs = await m.entryQ(Float32Array.from(expected.v1.entry_x));
    assert.equal(qs.length, 5);
    qs.forEach((q, i) => close(q, expected.v1.entry_q[i]));
    close(await m.exitQ(Float32Array.from(expected.v1.exit_x)), expected.v1.exit_q);
    await assert.rejects(m.entryQ(new Float32Array(3)), /3 inputs for 4 features/);

    const x = Float32Array.from(expected.v1.entry_x);
    const xs = Float32Array.from(expected.v1.exit_x);
    const times: number[] = [];
    for (let i = 0; i < 200; i++) {
      const t0 = performance.now();
      await m.entryQ(x);
      await m.exitQ(xs);
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    assert.ok(times[100] < 5, `median entry (5 members) + exit run ${times[100].toFixed(2)} ms`);
  } finally {
    await m.release();
  }
});

test("manifest: the shape is checked against the contract", () => {
  const good = JSON.parse(fs.readFileSync(path.join(FIX, "v1", "manifest.json"), "utf8"));
  assert.equal(validateManifest(good).version, V1);
  const bad = (f: (m: any) => void, re: RegExp, opts = {}) => {
    const m = structuredClone(good);
    f(m);
    assert.throws(() => validateManifest(m, opts), re);
  };
  bad((m) => m.entry.norm.mean.pop(), /entry\.norm: 3 means and 4 stds for 4 features/);
  bad((m) => m.exit.features.push("extra"), /exit\.norm/);
  bad((m) => (m.entry.norm.std[0] = 0), /std: must be > 0/);
  bad((m) => (m.entry.actions = [0, 0.5, 1.5]), /above 1x/);
  bad((m) => (m.entry.actions = [0.25, 0.5, 1]), /first action must be 0/);
  bad((m) => (m.entry.actions = [0, 0.5, 0.25]), /must increase/);
  bad((m) => (m.exit.actions = ["hold", "sell_all"]), /exit\.actions/);
  bad((m) => (m.entry.members[0] = "../../etc/passwd"), /entry\.members/);
  bad((m) => delete m.sha256["exit.onnx"], /no hash for exit\.onnx/);
  bad((m) => (m.explore.rate = 2), /explore\.rate/);
  bad((m) => (m.feature_spec_version = 2), /feature_spec_version 2, the runtime implements 1/, { featureSpecVersion: 1 });

  // brain_enabled (default true), entry.margin_c (default 0), entry.categories (default none)
  const v = validateManifest(good);
  assert.deepEqual([v.brain_enabled, v.entry.margin_c, v.entry.categories], [true, 0, {}]);
  const with_ = (f: (m: any) => void) => {
    const m = structuredClone(good);
    f(m);
    return validateManifest(m);
  };
  assert.equal(with_((m) => (m.brain_enabled = false)).brain_enabled, false);
  assert.equal(with_((m) => (m.entry.margin_c = 0.5)).entry.margin_c, 0.5);
  assert.deepEqual(with_((m) => (m.entry.categories = { venue_group: ["pumpswap", "other"] })).entry.categories, { venue_group: ["pumpswap", "other"] });
  bad((m) => (m.brain_enabled = "yes"), /brain_enabled: must be true or false/);
  // real_test (default false): the Brain sleeve's licence, set only by a real-test or a real-test-passing promoted push
  assert.equal(v.real_test, false);
  assert.equal(with_((m) => (m.real_test = true)).real_test, true);
  bad((m) => (m.real_test = "true"), /real_test: must be true or false/);
  bad((m) => (m.entry.margin_c = -1), /margin_c: must be a number ≥ 0/);
  bad((m) => (m.entry.margin_c = "0.5"), /margin_c/);
  bad((m) => (m.entry.categories = ["pumpswap"]), /entry\.categories: not an object/);
  bad((m) => (m.entry.categories = { venue_group: [] }), /venue_group: not a list of levels/);
  bad((m) => (m.entry.categories = { venue_group: ["pumpswap", "pumpswap", "other"] }), /duplicate levels/);
  bad((m) => (m.entry.categories = { venue_group: ["pumpswap"] }), /no "other" level/);

  // the columns the runtime computes: the bundle must name exactly those (features.ts with its categories)
  const cols = (cats: Record<string, string[]>) => {
    if (!cats.venue_group) throw new Error("categories.venue_group: no levels");
    return ["a", ...cats.venue_group.map((l) => `venue_group=${l}`)];
  };
  const named = (m: any) => {
    m.entry.categories = { venue_group: ["pumpswap", "other"] };
    m.entry.features = ["a", "venue_group=pumpswap", "venue_group=other"];
    m.entry.norm = { mean: [0, 0, 0], std: [1, 1, 1] };
  };
  const ok = structuredClone(good);
  named(ok);
  assert.deepEqual(validateManifest(ok, { entryColumns: cols, exitColumns: good.exit.features }).entry.features, ["a", "venue_group=pumpswap", "venue_group=other"]);
  bad((m) => (named(m), m.entry.features.reverse()), /entry\.features: not the 3 columns this runtime computes/, { entryColumns: cols });
  bad((m) => delete m.entry.categories, /entry\.categories: categories\.venue_group: no levels/, { entryColumns: cols });
  bad((m) => m.exit.features.reverse(), /exit\.features: not the 3 columns/, { exitColumns: good.exit.features });
});

test("hot reload: picks up a new current, a bad hash is rejected and the previous model stays active", async () => {
  const db = openDb(":memory:");
  const dir = brainDir(["v1", "v2", "bad-hash"]);
  const host = new BrainModels(db, { dir, releaseDelayMs: 10 });
  const cur = () => host.model; // a getter: read again after every check
  try {
    assert.deepEqual(await host.check(), { status: "missing" });
    assert.equal(cur(), null);

    point(dir, V1);
    const t1 = Date.parse("2026-11-06T12:00:00Z");
    assert.deepEqual(await host.check(t1), { status: "loaded", version: V1 });
    assert.equal(cur()?.version, V1);
    assert.equal((await host.check(t1 + 60_000)).status, "unchanged");
    assert.equal((db.prepare("SELECT loaded_at FROM brain_models WHERE version = ?").get(V1) as { loaded_at: string }).loaded_at, "2026-11-06T12:00:00.000Z");

    point(dir, V2);
    assert.deepEqual(await host.check(t1 + 120_000), { status: "loaded", version: V2 });
    const qs = await cur()!.entryQ(Float32Array.from(expected.v2.entry_x));
    qs.forEach((q, i) => close(q, expected.v2.entry_q[i]));
    assert.equal(rows(db)[V1].status, "previous");
    assert.equal(rows(db)[V2].status, "active");

    point(dir, BAD);
    const r = await host.check(t1 + 180_000);
    assert.equal(r.status, "failed");
    assert.equal(r.version, BAD);
    assert.match(r.error!, /sha256 mismatch for entry-0\.onnx/);
    assert.equal(cur()?.version, V2, "the previous model stays in use");
    assert.equal(host.lastError?.version, BAD);
    assert.deepEqual(rows(db)[BAD], { version: BAD, status: "failed", error: "sha256 mismatch for entry-0.onnx" });
    assert.equal(rows(db)[V2].status, "active");
    // the same bad bundle isn't retried every minute
    assert.equal((await host.check(t1 + 240_000)).status, "unchanged");
    close(await cur()!.exitQ(Float32Array.from(expected.v2.exit_x)), expected.v2.exit_q);

    // a rollback to v1 works and clears the error
    point(dir, V1);
    assert.deepEqual(await host.check(t1 + 300_000), { status: "loaded", version: V1 });
    assert.equal(host.lastError, null);
    assert.equal(rows(db)[V1].status, "active");
    assert.equal(rows(db)[V2].status, "previous");
    assert.equal((db.prepare("SELECT COUNT(*) n FROM brain_models WHERE status = 'active'").get() as { n: number }).n, 1);
  } finally {
    await host.close();
  }
});

test("hot reload: a broken first bundle leaves no model and never throws; concurrent checks don't double-load", async () => {
  const db = openDb(":memory:");
  const dir = brainDir(["bad-hash", "v1"]);
  const host = new BrainModels(db, { dir });
  const cur = () => host.model;
  try {
    point(dir, BAD);
    assert.equal((await host.check()).status, "failed");
    assert.equal(cur(), null);

    // a bundle with an unreadable manifest is recorded under its folder name
    const junk = path.join(repoRoot(), dir, "models", "junk");
    fs.mkdirSync(junk);
    fs.writeFileSync(path.join(junk, "manifest.json"), "{not json");
    point(dir, "junk");
    const r = await host.check();
    assert.equal(r.status, "failed");
    assert.equal(r.version, "junk");
    assert.match(r.error!, /^manifest\.json:/);
    assert.ok(!r.error!.includes(repoRoot()), "errors name files, not full paths");

    point(dir, V1);
    const [a, b] = await Promise.all([host.check(), host.check()]);
    assert.deepEqual([a.status, b.status], ["loaded", "busy"]);
    assert.equal(cur()?.version, V1);
  } finally {
    await host.close();
  }
  // the table can be ensured twice
  ensureBrainModelTables(db);
});

// ---------------------------------------------------------------------------------------------------------------------
// policy

test("normalise: (v − mean) ÷ std in the manifest's order; missing or non-finite values become 0", () => {
  const features = ["a", "b", "c", "d"];
  const norm = { mean: [1, 2, 3, 4], std: [2, 4, 1, 0.5] };
  assert.deepEqual(Array.from(normalise([3, 2, NaN, undefined], features, norm)), [1, 0, 0, 0]);
  assert.deepEqual(Array.from(normalise({ d: 5, a: -1, c: Infinity }, features, norm)), [-1, 0, 0, 2]);
  assert.deepEqual(Array.from(normalise([null, 6, 3, 4], features, norm)), [0, 1, 0, 0]);
  assert.throws(() => normalise([1, 2], features, norm), /expected 4 feature values/);
});

test("entry: mean q over the members, the best stake by score; copy only when that score is > 0 (skip's own q isn't compared); ties go small", () => {
  // the mean picks 0.5, though one member alone prefers 1.0
  const d = decideEntry([[0, 0.1, 0.3, 0.2, 0.9], [0, 0.1, 0.3, 0.2, -0.5]], STAKES);
  assert.equal(d.stakeFrac, 0.5);
  assert.equal(d.action, 2);
  assert.equal(d.explore, false);
  assert.equal(d.member, undefined);
  close(d.mean, [0, 0.1, 0.3, 0.2, 0.2]);
  close(d.std, [0, 0, 0, 0, 0.7]);
  assert.deepEqual(d.q, d.mean);

  // best stake mean ≤ 0: skip, even when skip's own q is lower
  assert.equal(decideEntry([[-1, -0.2, -0.1, 0, -0.3]], STAKES).stakeFrac, 0);
  assert.equal(decideEntry([[-1, -0.2, -0.1, 0, -0.3]], STAKES).action, 0);
  // CONTRACT.md: the best non-zero action is taken when its score is > 0, whatever q says for skip (skip's reward is 0)
  assert.equal(decideEntry([[0.4, 0.3, 0.1, 0.1, 0.1]], STAKES).stakeFrac, 0.25);
  assert.equal(decideEntry([[0.4, 0, -0.1, -0.1, -0.1]], STAKES).stakeFrac, 0, "a best score of exactly 0 is a skip");
  // stakes tied with each other: the smaller one; a larger one wins only when strictly higher
  assert.equal(decideEntry([[0, 0.2, 0.2, 0.2, 0.2]], STAKES).stakeFrac, 0.25);
  assert.equal(decideEntry([[0, 0.2, 0.2, 0.2, 0.2000001]], STAKES).stakeFrac, 1);
  // a NaN never wins
  assert.equal(decideEntry([[0, NaN, 0.1, NaN, NaN]], STAKES).stakeFrac, 0.5);
  assert.equal(decideEntry([[0, NaN, NaN, NaN, NaN]], STAKES).stakeFrac, 0);
  assert.equal(pickStake([0, 0.1], [0, 1]), 1);
});

test("explore: Thompson (one member picked by the rng) plus curiosity × std on every stake, reproducible with a seed", () => {
  const qs = [
    [0.05, -0.1, 0.0, 0.1, 0.02],
    [0.05, 0.1, 0.0, -0.3, -0.2],
    [0.05, 0.0, 0.0, 0.2, 0.6],
  ];
  const { std } = ensembleStats(qs);
  // rng 0.5 → member 1: its own q prefers 0.25
  const d0 = decideExplore(qs, STAKES, 0, () => 0.5);
  assert.equal(d0.member, 1);
  assert.equal(d0.explore, true);
  assert.equal(d0.stakeFrac, 0.25);
  // with curiosity the members' disagreement on 1.0 (std ≈ 0.34, vs 0.08 on 0.25) lifts it to the top
  const d1 = decideExplore(qs, STAKES, 2, () => 0.5);
  assert.equal(d1.stakeFrac, 1);
  close(d1.q, [0.05, 0.1 + 2 * std[1], 0, -0.3 + 2 * std[3], -0.2 + 2 * std[4]]);
  assert.equal(d1.q[0], 0.05, "no bonus on skip");
  // rng 0.99 → the last member; rng 0 → the first
  assert.equal(decideExplore(qs, STAKES, 0, () => 0.99).member, 2);
  assert.equal(decideExplore(qs, STAKES, 0, () => 0).member, 0);

  // seeded: the same seed gives the same picks, and every member gets picked
  const run = (seed: number) => {
    const rng = seededRng(seed);
    return Array.from({ length: 300 }, () => decideExplore(qs, STAKES, 0.5, rng).member!);
  };
  assert.deepEqual(run(7), run(7));
  assert.notDeepEqual(run(7), run(8));
  assert.deepEqual([...new Set(run(7))].sort(), [0, 1, 2]);

  // routing: about rate of signals go to Explore
  const rng = seededRng(42);
  const n = Array.from({ length: 10_000 }, () => routeToExplore(0.1, rng)).filter(Boolean).length;
  assert.ok(n > 900 && n < 1100, `${n} of 10000 routed`);
  assert.equal(routeToExplore(0, () => 0), false);
});

test("entry: the stake never goes above 1x the real size", () => {
  const rng = seededRng(1);
  for (let i = 0; i < 500; i++) {
    const qs = Array.from({ length: 5 }, () => STAKES.map(() => rng() * 2 - 1));
    assert.ok(decideEntry(qs, STAKES).stakeFrac <= 1);
    assert.ok(decideExplore(qs, STAKES, 10, rng).stakeFrac <= 1);
  }
});

test("entry: score = mean q − margin_c × std q per action, so the members' disagreement costs a stake", () => {
  // 1.0 has the best mean (0.5) but the members disagree on it (std 0.4); 0.5 they agree on (0.2)
  const qs = [
    [0, 0.1, 0.2, 0.2, 0.9],
    [0, 0.1, 0.2, 0.2, 0.1],
  ];
  assert.equal(decideEntry(qs, STAKES).stakeFrac, 1, "no margin: the best mean");
  assert.equal(decideEntry(qs, STAKES, 0.5).stakeFrac, 1, "0.5 − 0.5 × 0.4 = 0.3 still beats 0.2");
  const d = decideEntry(qs, STAKES, 1);
  assert.equal(d.stakeFrac, 0.5, "0.5 − 1 × 0.4 = 0.1 no longer does");
  close(d.q, [0, 0.1, 0.2, 0.2, 0.1]);
  close(d.mean, [0, 0.1, 0.2, 0.2, 0.5]);
  close(d.std, [0, 0, 0, 0, 0.4]);
  // a margin that pushes every score to ≤ 0 is a skip
  assert.equal(decideEntry([[0, 0.3, 0, 0, 0], [0, -0.1, 0, 0, 0]], STAKES, 1).stakeFrac, 0);
  // a negative or non-finite margin counts as 0
  assert.equal(decideEntry(qs, STAKES, -3).stakeFrac, 1);
  assert.equal(decideEntry(qs, STAKES, NaN).stakeFrac, 1);
});

test("signals: hard gates first (no network, no coin flip), then Explore at explore.rate; brain_enabled false skips every Brain signal", () => {
  const policy = { actions: STAKES, marginC: 0, brainEnabled: true, exploreRate: 0.1, curiosity: 0 };
  let draws = 0;
  const rng = (v: number) => () => (draws++, v);
  assert.equal(routeSignal("young_amm", policy, rng(0)), "gated");
  assert.equal(draws, 0, "a gated signal draws nothing");
  assert.equal(routeSignal(null, policy, rng(0.05)), "explore");
  assert.equal(routeSignal(null, policy, rng(0.5)), "brain");
  assert.equal(routeSignal(null, { exploreRate: 0 }, rng(0)), "brain");

  const qs = [[0, 0.1, 0.3, 0.2, 0.1]];
  const on = decideSignal("brain", qs, policy, rng(0));
  assert.deepEqual([on.stakeFrac, on.action, on.disabled], [0.5, 2, undefined]);
  // an explore-only bundle (gate exit 3): the Brain account skips, its scores kept for the log
  const off = decideSignal("brain", qs, { ...policy, brainEnabled: false }, rng(0));
  assert.deepEqual([off.stakeFrac, off.action, off.disabled], [0, 0, true]);
  close(off.q, qs[0]);
  // ... while Explore still trades on it
  const ex = decideSignal("explore", qs, { ...policy, brainEnabled: false }, rng(0));
  assert.deepEqual([ex.stakeFrac, ex.explore, ex.member], [0.5, true, 0]);
  // the margin comes from the policy
  const two = [[0, 0.1, 0.2, 0.2, 0.9], [0, 0.1, 0.2, 0.2, 0.1]];
  assert.equal(decideSignal("brain", two, { ...policy, marginC: 1 }, rng(0)).stakeFrac, 0.5);
});

test("exit: hard stops override the network; sell_half only once; ties hold", () => {
  const stops = { stopPct: 60, maxHoldHours: 24 };
  const hold = [1, 0, 0];
  const H = 3_600_000;
  assert.deepEqual(decideExit(hold, { ret: -0.6, heldMs: H, soldHalf: false }, stops), { action: "sell_all", reason: "stop_loss", q: hold });
  assert.equal(decideExit(hold, { ret: -0.59, heldMs: H, soldHalf: false }, stops).action, "hold");
  assert.deepEqual(decideExit(hold, { ret: 3, heldMs: 24 * H, soldHalf: false }, stops), { action: "sell_all", reason: "max_hold", q: hold });
  // stops hold without a model too
  assert.equal(decideExit(null, { ret: -0.9, heldMs: 0, soldHalf: false }, stops).reason, "stop_loss");
  assert.deepEqual(decideExit(null, { ret: 0.1, heldMs: 0, soldHalf: false }, stops), { action: "hold", reason: "network", q: null });
  // the defaults come from BRAIN_HARD_STOP_PCT / BRAIN_MAX_HOLD_HOURS
  assert.deepEqual(hardStops(), { stopPct: 60, maxHoldHours: 24 });
  assert.equal(decideExit(hold, { ret: -0.61, heldMs: 0, soldHalf: false }).reason, "stop_loss");

  const half = [0.1, 0.5, 0.3];
  assert.equal(decideExit(half, { ret: 1, heldMs: H, soldHalf: false }, stops).action, "sell_half");
  assert.equal(decideExit(half, { ret: 1, heldMs: H, soldHalf: true }, stops).action, "sell_all", "sell_half masked: next best");
  assert.equal(decideExit([0.4, 0.5, 0.3], { ret: 1, heldMs: H, soldHalf: true }, stops).action, "hold");
  assert.equal(decideExit([0.2, 0.2, 0.2], { ret: 0, heldMs: H, soldHalf: false }, stops).action, "hold");
  assert.equal(decideExit([NaN, NaN, 0.1], { ret: 0, heldMs: H, soldHalf: false }, stops).action, "sell_all");
});
