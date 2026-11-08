/**
 * The private social score (social/score.ts): the inputs reproduce brain/brain/social/golden.json (what the trainer
 * computes), the bundle is read through `current` once and hash-checked, nothing is written without a model (or with one
 * that is bad or hasn't passed its out-of-time test), and the scores never reach the snapshot or a public feed.
 * The ONNX models are tiny linear nets built here byte by byte, so no model file lives in the repo. In-memory database,
 * temp folders, no network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type DB, openDb } from "@godseye/shared";
import { buildDashboardSnapshot, getWalletDetail } from "@godseye/shared/dashboard-data";
import { publicView, type PublicFeed } from "@godseye/shared/public-view";

const { POSTS_WINDOW_SQL, SOCIAL_FEATURES, SOCIAL_INPUTS, loadSocialIndex, readSocialBundle, runSocialScore, socialRows, validateSocialManifest } = await import("../src/social/score");
const { ensureSocialTables } = await import("../src/social/schema");
const { ensureBrainTables } = await import("../src/brain/schema");

const GOLDEN = JSON.parse(fs.readFileSync(fileURLToPath(new URL("../../brain/brain/social/golden.json", import.meta.url)), "utf8"));
const T_MS = Date.parse(GOLDEN.t);
/** The golden wallets with an owner-grade link at t (the others' expected vector is null). */
const LINKED = Object.keys(GOLDEN.expected).filter((w) => GOLDEN.expected[w]).sort();
const F = SOCIAL_FEATURES.length;

// ---------------------------------------------------------------------------------------------------------------------
// A linear ONNX model, y = x · w + b, encoded as protobuf by hand (onnx.proto field numbers).

const varint = (n: number): number[] => {
  const out: number[] = [];
  let v = BigInt(n);
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return out;
};
const key = (field: number, wire: number) => varint((field << 3) | wire);
const bytes = (field: number, b: number[] | Uint8Array) => [...key(field, 2), ...varint(b.length), ...b];
const str = (field: number, s: string) => bytes(field, [...Buffer.from(s, "utf8")]);
const int = (field: number, n: number) => [...key(field, 0), ...varint(n)];
const floats = (field: number, xs: number[]) => bytes(field, [...new Uint8Array(new Float32Array(xs).buffer)]);
const tensor = (name: string, dims: number[], xs: number[]) => [...dims.flatMap((d) => int(1, d)), ...int(2, 1), ...floats(4, xs), ...str(8, name)];
const valueInfo = (name: string, dims: (number | string)[]) => {
  const shape = dims.flatMap((d) => bytes(1, typeof d === "number" ? int(1, d) : str(2, d)));
  return [...str(1, name), ...bytes(2, bytes(1, [...int(1, 1), ...bytes(2, shape)]))];
};
const node = (inputs: string[], output: string, op: string) => [...inputs.flatMap((i) => str(1, i)), ...str(2, output), ...str(4, op)];

/** An ONNX model mapping x [n, F] to y [n, 1] = x · w + b (float32). */
function linearOnnx(w: number[], b: number, names = { input: "x", output: "y" }): Uint8Array {
  const graph = [
    ...bytes(1, node([names.input, "w"], "xw", "MatMul")),
    ...bytes(1, node(["xw", "b"], names.output, "Add")),
    ...str(2, "social-test"),
    ...bytes(5, tensor("w", [w.length, 1], w)),
    ...bytes(5, tensor("b", [1], [b])),
    ...bytes(11, valueInfo(names.input, ["n", w.length])),
    ...bytes(12, valueInfo(names.output, ["n", 1])),
  ];
  return new Uint8Array([...int(1, 8), ...str(2, "godseye-test"), ...bytes(7, graph), ...bytes(8, [...str(1, ""), ...int(2, 17)])]);
}

// ---------------------------------------------------------------------------------------------------------------------
// Bundles in a temp BRAIN_DIR: social/models/<version>/ and social/current -> models/<version>

const W = SOCIAL_FEATURES.map((_, k) => (k % 3 === 0 ? 0.01 * (k + 1) : -0.005 * k));
const B = -0.02;
const POP = GOLDEN.pop_mean as number;
const NORM = { mean: SOCIAL_FEATURES.map((_, k) => 0.05 * k), std: SOCIAL_FEATURES.map((_, k) => 1 + 0.1 * k) };

function manifest(version: string, model: Uint8Array, over: Record<string, unknown> = {}) {
  return {
    version,
    kind: "social",
    created_at: "2026-12-01T00:00:00Z",
    feature_spec_version: 1,
    features: SOCIAL_FEATURES,
    norm: NORM,
    fill: GOLDEN.fill,
    file: "social.onnx",
    input: "x",
    output: "y",
    pop_mean: POP,
    shrink_n: 18,
    gate: { passed: true, wallets: 412, spearman: 0.21 },
    sha256: { "social.onnx": crypto.createHash("sha256").update(model).digest("hex") },
    ...over,
  };
}

/** A BRAIN_DIR with the given social bundles; `current` points at the last one. */
function brainDir(bundles: { version: string; model?: Uint8Array; manifest?: Record<string, unknown> }[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "godseye-social-"));
  for (const b of bundles) {
    const model = b.model ?? linearOnnx(W, B);
    const d = path.join(dir, "social", "models", b.version);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "social.onnx"), model);
    fs.writeFileSync(path.join(d, "manifest.json"), JSON.stringify(b.manifest ?? manifest(b.version, model)));
  }
  if (bundles.length) point(dir, bundles[bundles.length - 1].version);
  return dir;
}

function point(dir: string, version: string): void {
  const link = path.join(dir, "social", "current");
  fs.rmSync(link, { force: true });
  fs.symlinkSync(path.join("models", version), link);
}

// ---------------------------------------------------------------------------------------------------------------------
// The golden tables in a database, as the server stores them

function goldenDb(): DB {
  const db = openDb(":memory:");
  ensureSocialTables(db);
  ensureBrainTables(db);
  db.exec("ALTER TABLE wallets ADD COLUMN funder_filled_at TEXT");
  const tb = GOLDEN.tables as Record<string, Record<string, unknown>[]>;
  const insert = (table: string, rows: Record<string, unknown>[], extra: (r: Record<string, unknown>, i: number) => Record<string, unknown> = () => ({})) => {
    rows.forEach((r, i) => {
      const row = { ...r, ...extra(r, i) };
      const cols = Object.keys(row);
      db.prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map((c) => `@${c}`).join(", ")})`).run(row);
    });
  };
  insert("social_wallet_accounts", tb.social_wallet_accounts);
  insert("social_accounts", tb.social_accounts);
  insert("social_account_snapshots", tb.social_account_snapshots);
  insert("social_posts", tb.social_posts);
  insert("wallet_swaps", tb.wallet_swaps);
  insert("mirror_ledger", tb.mirror_ledger, (r, i) => ({ buy_sig: `goldbuy${i}`, created_at: r.buy_ts }));
  insert("wallets", tb.wallets, () => ({ discovered_via: "manual" }));
  return db;
}

/** Runs fn with the console captured; returns its result and what it printed. */
async function quiet<T>(fn: () => Promise<T>): Promise<{ res: T; out: string }> {
  const lines: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  try {
    return { res: await fn(), out: lines.join("\n") };
  } finally {
    console.log = log;
  }
}

const scores = (db: DB) => db.prepare("SELECT wallet, score, n_posts, model_version, updated_at FROM social_scores ORDER BY wallet").all() as {
  wallet: string;
  score: number;
  n_posts: number;
  model_version: string;
  updated_at: string;
}[];

/** What the linear model gives for an input row (float64; ONNX runs float32). */
const expectScore = (v: number[]) => v.reduce((s, x, k) => s + ((x - NORM.mean[k]) / NORM.std[k]) * W[k], B) - POP;

// ---------------------------------------------------------------------------------------------------------------------

test("social inputs: the scorer reproduces the trainer's golden vectors to 1e-6", () => {
  assert.deepEqual(SOCIAL_FEATURES, GOLDEN.features, "score.ts and features.py list the same inputs in the same order");
  assert.equal(SOCIAL_INPUTS.length, GOLDEN.fill.length);
  const rows = socialRows(goldenDb(), T_MS / 1000, POP, GOLDEN.fill);
  const expected = GOLDEN.expected as Record<string, { vector: number[]; n_posts: number } | null>;
  for (const [wallet, exp] of Object.entries(expected)) {
    const got = rows.get(wallet);
    if (exp === null) {
      assert.equal(got, undefined, `${wallet} has no owner-grade link at t`);
      continue;
    }
    assert.ok(got, `${wallet} is scored`);
    assert.equal(got.nPosts, exp.n_posts, `${wallet} n_posts`);
    assert.equal(got.vector.length, exp.vector.length);
    got.vector.forEach((v, k) => assert.ok(Math.abs(v - exp.vector[k]) <= 1e-6, `${wallet} ${GOLDEN.features[k]}: ${v} vs ${exp.vector[k]}`));
  }
  assert.deepEqual([...rows.keys()].sort(), LINKED, "no other wallet is scored");
});

test("social inputs: own_record_shrunk counts every mirror_ledger row, a coin bought twice included (as the trainer does)", () => {
  const db = goldenDb();
  const repeats = db.prepare("SELECT COUNT(*) n FROM mirror_ledger GROUP BY leader, mint HAVING n > 1").all();
  assert.ok(repeats.length, "the golden ledger has a repeat buy of one coin");
  const led = loadSocialIndex(db, T_MS / 1000).ledger("GoldW1aaaa");
  assert.equal(led.y.length, (GOLDEN.tables.mirror_ledger as { leader: string }[]).filter((r) => r.leader === "GoldW1aaaa").length);
});

test("social inputs: the 30-day posts window is an index range, not a scan of every post", () => {
  const db = goldenDb();
  loadSocialIndex(db, T_MS / 1000);
  const plan = (db.prepare(`EXPLAIN QUERY PLAN ${POSTS_WINDOW_SQL}`).all("a", "b", "c") as { detail: string }[]).map((r) => r.detail).join("; ");
  assert.match(plan, /idx_social_posts_ts/, plan);
  assert.doesNotMatch(plan, /TEMP B-TREE/, "no sort of the whole table");
});

test("social inputs: without funder_filled_at the funder input is missing for everyone, as in training", () => {
  const db = openDb(":memory:");
  ensureSocialTables(db);
  db.prepare("INSERT INTO social_wallet_accounts (wallet, author_id, how, n, first_seen_at, updated_at) VALUES ('w', 'a', 'bio', 1, '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')").run();
  db.prepare("INSERT INTO wallets (address, first_seen_at, discovered_via, funder) VALUES ('w', '2026-10-01', 'manual', 'f')").run();
  const row = socialRows(db, T_MS / 1000, POP, GOLDEN.fill).get("w");
  assert.ok(row);
  const at = SOCIAL_FEATURES.indexOf("funder_cluster_size_missing");
  assert.equal(row.vector[at], 1);
  assert.equal(row.vector[SOCIAL_FEATURES.indexOf("own_record_shrunk")], POP, "no mirror ledger: no copies, the population mean");
});

test("hourly score: runs the model on every owner-linked wallet and writes centred scores", async () => {
  const db = goldenDb();
  const dir = brainDir([{ version: "2026-12-01T00-00-00Z" }]);
  const { res, out } = await quiet(() => runSocialScore(db, { dir, now: T_MS }));
  assert.ok(LINKED.length >= 3);
  assert.deepEqual(res, { status: "scored", version: "2026-12-01T00-00-00Z", wallets: LINKED.length, skipped: 0 });
  const rows = socialRows(db, T_MS / 1000, POP, GOLDEN.fill);
  const got = scores(db);
  assert.deepEqual(got.map((r) => r.wallet), LINKED);
  for (const r of got) {
    assert.ok(Math.abs(r.score - expectScore(rows.get(r.wallet)!.vector)) < 1e-5, `${r.wallet}: ${r.score}`);
    assert.equal(r.n_posts, rows.get(r.wallet)!.nPosts);
    assert.equal(r.model_version, "2026-12-01T00-00-00Z");
    assert.equal(r.updated_at, GOLDEN.t);
  }
  assert.ok(!/Gold/.test(out), "the console gets counts only, never a wallet");
  assert.equal((db.prepare("SELECT COUNT(*) n FROM agent_log").get() as { n: number }).n, 0, "nothing in the published log feed");

  // An hour later with a new model: rows are updated in place, one per wallet.
  const model = linearOnnx(W.map((x) => 2 * x), B);
  fs.mkdirSync(path.join(dir, "social", "models", "v2"));
  fs.writeFileSync(path.join(dir, "social", "models", "v2", "social.onnx"), model);
  fs.writeFileSync(path.join(dir, "social", "models", "v2", "manifest.json"), JSON.stringify(manifest("v2", model)));
  point(dir, "v2");
  await quiet(() => runSocialScore(db, { dir, now: T_MS + 3_600_000 }));
  assert.deepEqual(scores(db).map((r) => [r.wallet, r.model_version]), LINKED.map((w) => [w, "v2"]));
});

test("hourly score: no model, a bad hash, a wrong manifest or a failed out-of-time test write nothing", async () => {
  const db = goldenDb();
  const none = fs.mkdtempSync(path.join(os.tmpdir(), "godseye-social-"));
  assert.deepEqual((await quiet(() => runSocialScore(db, { dir: none, now: T_MS }))).res, { status: "missing", wallets: 0, skipped: 0 });

  const model = linearOnnx(W, B);
  const bad = brainDir([{ version: "bad", model, manifest: manifest("bad", model, { sha256: { "social.onnx": "0".repeat(64) } }) }]);
  const r1 = await quiet(() => runSocialScore(db, { dir: bad, now: T_MS }));
  assert.equal(r1.res.status, "failed");
  assert.match(r1.res.error ?? "", /sha256 mismatch/);

  const wrong = brainDir([{ version: "wrong", model, manifest: manifest("wrong", model, { features: [...SOCIAL_FEATURES].reverse() }) }]);
  assert.equal((await quiet(() => runSocialScore(db, { dir: wrong, now: T_MS }))).res.status, "failed");

  const brainBundle = brainDir([{ version: "entry", model, manifest: { ...manifest("entry", model), entry: {} } }]);
  assert.match((await quiet(() => runSocialScore(db, { dir: brainBundle, now: T_MS }))).res.error ?? "", /brain model bundle/);

  const gated = brainDir([{ version: "gated", model, manifest: manifest("gated", model, { gate: { passed: false, reason: "212 validation wallets" } }) }]);
  const r2 = await quiet(() => runSocialScore(db, { dir: gated, now: T_MS }));
  assert.equal(r2.res.status, "gated");
  assert.match(r2.out, /hasn't passed its out-of-time test/);
  const noGate = brainDir([{ version: "nogate", model, manifest: manifest("nogate", model, { gate: undefined }) }]);
  assert.equal((await quiet(() => runSocialScore(db, { dir: noGate, now: T_MS }))).res.status, "gated", "no recorded test counts as not passed");

  const badOutput = brainDir([{ version: "names", model, manifest: manifest("names", model, { output: "q" }) }]);
  assert.equal((await quiet(() => runSocialScore(db, { dir: badOutput, now: T_MS }))).res.status, "failed", "a session error is caught");

  assert.deepEqual(scores(db), [], "nothing was written by any of them");
});

test("bundle: `current` is resolved once and both files come from that directory", () => {
  const dir = brainDir([{ version: "v1" }, { version: "v2", model: linearOnnx(W, 0.5) }]);
  point(dir, "v1");
  const b = readSocialBundle(dir);
  assert.ok(b);
  assert.equal(b.manifest.version, "v1");
  assert.deepEqual(Buffer.from(b.model), fs.readFileSync(path.join(dir, "social", "models", "v1", "social.onnx")));
  // A model file swapped under the manifest's feet is refused.
  fs.writeFileSync(path.join(dir, "social", "models", "v1", "social.onnx"), linearOnnx(W, 0.5));
  assert.throws(() => readSocialBundle(dir), /sha256 mismatch/);
  assert.equal(readSocialBundle(fs.mkdtempSync(path.join(os.tmpdir(), "godseye-social-"))), null, "no current: no model");
});

test("manifest: checked against the inputs this scorer computes", () => {
  const model = linearOnnx(W, B);
  const ok = validateSocialManifest(manifest("v1", model));
  assert.equal(ok.gate_passed, true);
  assert.throws(() => validateSocialManifest(manifest("../x", model)), /version/);
  assert.throws(() => validateSocialManifest(manifest("v1", model, { norm: { mean: NORM.mean, std: NORM.std.map(() => 0) } })), /std/);
  assert.throws(() => validateSocialManifest(manifest("v1", model, { fill: [1] })), /fill/);
  assert.throws(() => validateSocialManifest(manifest("v1", model, { file: "../social.onnx" })), /file/);
  assert.throws(() => validateSocialManifest(manifest("v1", model, { pop_mean: null })), /pop_mean/);
});

/** Every key in a JSON value, at any depth. */
function keys(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) for (const x of v) keys(x, out);
  else if (v && typeof v === "object")
    for (const [k, x] of Object.entries(v)) {
      out.push(k);
      keys(x, out);
    }
  return out;
}

test("HIDDEN: the scores the job writes never reach the dashboard snapshot, a public feed or a wallet page", async () => {
  const db = goldenDb();
  const version = "zz-hidden-social-model";
  const model = linearOnnx(W, 0.123456789);
  await quiet(() => runSocialScore(db, { dir: brainDir([{ version, model, manifest: manifest(version, model) }]), now: T_MS }));
  const written = scores(db);
  assert.equal(written.length, LINKED.length, "the guard runs on real score rows");

  const snap = buildDashboardSnapshot(db);
  const feedOf: Record<string, PublicFeed> = { live: "stream" };
  const pub: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(snap)) pub[k] = publicView(feedOf[k] ?? (k as PublicFeed), v);
  for (const r of written) {
    const detail = getWalletDetail(db, r.wallet);
    const views = { snapshot: snap, public: pub, walletPage: detail, publicWalletPage: publicView("wallet", detail) };
    for (const [name, body] of Object.entries(views)) {
      const json = JSON.stringify(body);
      assert.ok(!json.includes(version), `${name} leaks the social model`);
      // The score itself, at the precision any formatter would print it.
      for (const digits of [6, 4]) assert.ok(!json.includes(r.score.toFixed(digits)), `${name} leaks a social score`);
      assert.deepEqual(keys(body).filter((k) => /social/i.test(k)), [], `${name} has social keys`);
    }
  }
});
