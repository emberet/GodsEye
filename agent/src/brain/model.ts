/**
 * BRAIN MODEL — loads the bundle the Mac trainer pushes (brain/spec/CONTRACT.md "Model bundle") and runs it with
 * onnxruntime-node. Paper money only: this file runs networks, it never trades.
 *
 *   <BRAIN_DIR>/current  → models/<version>/   manifest.json + entry-*.onnx (the ensemble) + exit.onnx
 *
 * A bundle is used only when its manifest has the right shape and every file's sha256 matches the manifest; the runtime
 * also has it name exactly the feature columns it computes (features.ts: entry.features from features.yaml and the bundle's
 * entry.categories, exit.features). brain_enabled (default true: a manifest without it predates explore-only pushes),
 * entry.margin_c (default 0) and entry.categories are read here; the policy (policy.ts) applies them. The agent
 * calls check() every minute: a new `current` target is loaded and swapped in; a bundle that fails keeps the previous
 * model running, is recorded as failed in brain_models, and is not retried until `current` (or its manifest) changes.
 * Nothing here throws out of check(). Sessions are made once per load, single-threaded: a batch of one is well under 5 ms.
 * Server log only (console): nothing here reaches say() or the public feed.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { InferenceSession } from "onnxruntime-node";
import { type DB, repoRoot } from "@godseye/shared";
import { config } from "../config";
import type { Norm } from "./policy";
import { EXIT_ACTIONS } from "./policy";

export interface BrainNetSpec {
  features: string[];
  norm: Norm;
  input: string;
  output: string;
}

export interface BrainManifest {
  version: string;
  created_at: string;
  feature_spec_version: number;
  entry: BrainNetSpec & {
    members: string[];
    actions: number[];
    /** The Brain account's score is mean q − margin_c × std q over the members (CONTRACT.md); default 0. */
    margin_c: number;
    /** One-hot levels per categorical feature, in column order, `other` included (features.yaml conventions.categorical). */
    categories: Record<string, string[]>;
  };
  exit: BrainNetSpec & { file: string; actions: string[] };
  /** false = an explore-only bundle (the gate's exit 3): the Brain account skips every signal. Default true. */
  brain_enabled: boolean;
  explore: { rate: number; curiosity: number };
  metrics: Record<string, unknown>;
  sha256: Record<string, string>;
}

/** A loaded bundle. Inputs are normalised features (policy.ts normalise) in the manifest's order. */
export interface BrainModel {
  version: string;
  /** The bundle's real directory (models/<version>/). */
  dir: string;
  manifest: BrainManifest;
  /** q per entry action, one vector per ensemble member. */
  entryQ(x: Float32Array): Promise<number[][]>;
  /** q per exit action (hold, sell_half, sell_all). */
  exitQ(x: Float32Array): Promise<number[]>;
  release(): Promise<void>;
}

const SQL = `
CREATE TABLE IF NOT EXISTS brain_models (
  version TEXT PRIMARY KEY,
  loaded_at TEXT,
  manifest TEXT,
  -- active = in use · previous = replaced by a newer one · failed = rejected (bad shape, hash or session)
  status TEXT CHECK (status IN ('active','previous','failed')),
  error TEXT
);
`;

const ensured = new WeakSet<DB>();
/** The brain_models table (created here, like the runner tables, not in the shared schema). */
export function ensureBrainModelTables(db: DB): void {
  if (ensured.has(db)) return;
  db.exec(SQL);
  ensured.add(db);
}

/** The brain folder (BRAIN_DIR), resolved against the repo root like data/. */
export function brainRoot(dir = config.brainDir): string {
  return path.resolve(repoRoot(), dir);
}

// ---------------------------------------------------------------------------------------------------------------------
// Manifest shape

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isNumArr = (v: unknown): v is number[] => Array.isArray(v) && v.every((x) => typeof x === "number" && Number.isFinite(x));
const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string" && x.length > 0);
/** A plain file name inside the bundle: no folders, no way out of it. */
const isBundleFile = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9._-]+$/.test(v) && v !== "." && v !== "..";

function net(m: Record<string, unknown>, key: "entry" | "exit"): BrainNetSpec {
  const n = m[key];
  if (!isObj(n)) throw new Error(`${key}: missing`);
  if (!isStrArr(n.features) || !n.features.length) throw new Error(`${key}.features: not a list of names`);
  if (new Set(n.features).size !== n.features.length) throw new Error(`${key}.features: duplicate names`);
  const norm = n.norm;
  if (!isObj(norm) || !isNumArr(norm.mean) || !isNumArr(norm.std)) throw new Error(`${key}.norm: needs numeric mean and std`);
  if (norm.mean.length !== n.features.length || norm.std.length !== n.features.length) {
    throw new Error(`${key}.norm: ${norm.mean.length} means and ${norm.std.length} stds for ${n.features.length} features`);
  }
  if (norm.std.some((s) => s <= 0)) throw new Error(`${key}.norm.std: must be > 0`);
  if (typeof n.input !== "string" || !n.input || typeof n.output !== "string" || !n.output) throw new Error(`${key}: input/output names missing`);
  return { features: n.features, norm: { mean: norm.mean, std: norm.std }, input: n.input, output: n.output };
}

/** What a bundle must agree with besides the contract's shape. */
export interface ManifestChecks {
  /** Reject bundles built for another feature spec (features.ts FEATURE_SPEC_VERSION). */
  featureSpecVersion?: number;
  /** The entry columns the runtime computes for the bundle's categories (features.ts entryColumns); throws on bad ones. */
  entryColumns?: (categories: Record<string, string[]>) => string[];
  /** The exit columns the runtime computes (features.ts exitColumns()). */
  exitColumns?: string[];
}

function categories(v: unknown): Record<string, string[]> {
  if (v === undefined) return {};
  if (!isObj(v)) throw new Error("entry.categories: not an object of level lists");
  for (const [name, levels] of Object.entries(v)) {
    if (!isStrArr(levels) || !levels.length) throw new Error(`entry.categories.${name}: not a list of levels`);
    if (new Set(levels).size !== levels.length) throw new Error(`entry.categories.${name}: duplicate levels`);
    if (!levels.includes("other")) throw new Error(`entry.categories.${name}: no "other" level (unseen levels map to it)`);
  }
  return v as Record<string, string[]>;
}

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Checks a parsed manifest.json against the contract; throws with the first problem found. */
export function validateManifest(raw: unknown, opts: ManifestChecks = {}): BrainManifest {
  if (!isObj(raw)) throw new Error("manifest is not an object");
  if (typeof raw.version !== "string" || !isBundleFile(raw.version)) throw new Error("version: missing or not a plain name");
  if (typeof raw.feature_spec_version !== "number") throw new Error("feature_spec_version: missing");
  if (opts.featureSpecVersion !== undefined && raw.feature_spec_version !== opts.featureSpecVersion) {
    throw new Error(`feature_spec_version ${raw.feature_spec_version}, the runtime implements ${opts.featureSpecVersion}`);
  }

  const entry = net(raw, "entry");
  const e = raw.entry as Record<string, unknown>;
  if (!isStrArr(e.members) || !e.members.length || !e.members.every(isBundleFile)) throw new Error("entry.members: not a list of file names");
  const acts = e.actions;
  if (!isNumArr(acts) || acts.length < 2) throw new Error("entry.actions: needs skip plus at least one stake");
  if (acts[0] !== 0) throw new Error("entry.actions: the first action must be 0 (skip)");
  for (let i = 1; i < acts.length; i++) if (!(acts[i] > acts[i - 1])) throw new Error("entry.actions: stakes must increase");
  if (acts[acts.length - 1] > 1) throw new Error("entry.actions: a stake above 1x the real size");
  const marginC = e.margin_c ?? 0;
  if (typeof marginC !== "number" || !Number.isFinite(marginC) || marginC < 0) throw new Error("entry.margin_c: must be a number ≥ 0");
  const cats = categories(e.categories);
  if (opts.entryColumns) {
    let want: string[];
    try {
      want = opts.entryColumns(cats);
    } catch (err) {
      throw new Error(`entry.categories: ${(err as Error).message}`);
    }
    if (!sameList(entry.features, want)) throw new Error(`entry.features: not the ${want.length} columns this runtime computes (features.yaml with entry.categories)`);
  }

  const exit = net(raw, "exit");
  const x = raw.exit as Record<string, unknown>;
  if (!isBundleFile(x.file)) throw new Error("exit.file: not a file name");
  if (!isStrArr(x.actions) || x.actions.join() !== EXIT_ACTIONS.join()) throw new Error(`exit.actions: must be ${EXIT_ACTIONS.join(", ")}`);
  if (opts.exitColumns && !sameList(exit.features, opts.exitColumns)) throw new Error(`exit.features: not the ${opts.exitColumns.length} columns this runtime computes (features.yaml)`);
  if (raw.brain_enabled !== undefined && typeof raw.brain_enabled !== "boolean") throw new Error("brain_enabled: must be true or false");

  const ex = raw.explore;
  if (!isObj(ex) || typeof ex.rate !== "number" || !(ex.rate >= 0 && ex.rate <= 1)) throw new Error("explore.rate: must be in [0, 1]");
  if (typeof ex.curiosity !== "number" || !(ex.curiosity >= 0) || !Number.isFinite(ex.curiosity)) throw new Error("explore.curiosity: must be ≥ 0");

  const sha = raw.sha256;
  if (!isObj(sha)) throw new Error("sha256: missing");
  for (const f of [...e.members, x.file]) {
    if (typeof sha[f] !== "string" || !/^[0-9a-fA-F]{64}$/.test(sha[f] as string)) throw new Error(`sha256: no hash for ${f}`);
  }

  return {
    version: raw.version,
    created_at: typeof raw.created_at === "string" ? raw.created_at : "",
    feature_spec_version: raw.feature_spec_version,
    entry: { ...entry, members: e.members, actions: acts, margin_c: marginC, categories: cats },
    exit: { ...exit, file: x.file, actions: x.actions },
    brain_enabled: raw.brain_enabled !== false,
    explore: { rate: ex.rate, curiosity: ex.curiosity },
    metrics: isObj(raw.metrics) ? raw.metrics : {},
    sha256: sha as Record<string, string>,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Loading

/** Reads a file of the bundle; errors name the file, never the full path. */
function readBundleFile(dir: string, name: string): Buffer {
  try {
    return fs.readFileSync(path.join(dir, name));
  } catch (e) {
    throw new Error(`cannot read ${name} (${(e as NodeJS.ErrnoException).code ?? "error"})`);
  }
}

const SESSION_OPTIONS: InferenceSession.SessionOptions = {
  executionProviders: ["cpu"],
  graphOptimizationLevel: "all",
  intraOpNumThreads: 1,
  interOpNumThreads: 1,
};

/**
 * Loads one bundle directory: shape check, every file's sha256, one session per net, and a warm-up run that checks the
 * input/output names and widths. Throws on any problem (and releases what it made).
 */
export async function loadBundle(dir: string, opts: ManifestChecks = {}): Promise<BrainModel> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readBundleFile(dir, "manifest.json").toString("utf8"));
  } catch (e) {
    throw new Error(`manifest.json: ${(e as Error).message}`);
  }
  const m = validateManifest(parsed, opts);

  const bytes = new Map<string, Buffer>();
  for (const f of [...m.entry.members, m.exit.file]) {
    const buf = readBundleFile(dir, f);
    const got = crypto.createHash("sha256").update(buf).digest("hex");
    if (got !== m.sha256[f].toLowerCase()) throw new Error(`sha256 mismatch for ${f}`);
    bytes.set(f, buf);
  }

  const ort = await import("onnxruntime-node");
  const made: InferenceSession[] = [];
  const open = async (f: string) => {
    // the hashed bytes themselves, so the file can't change between the check and the load
    const s = await ort.InferenceSession.create(new Uint8Array(bytes.get(f)!), SESSION_OPTIONS);
    made.push(s);
    return s;
  };

  const run = async (s: InferenceSession, spec: BrainNetSpec, x: Float32Array, width: number, what: string): Promise<number[]> => {
    if (x.length !== spec.features.length) throw new Error(`${what}: ${x.length} inputs for ${spec.features.length} features`);
    const out = await s.run({ [spec.input]: new ort.Tensor("float32", x, [1, x.length]) });
    const t = out[spec.output];
    if (!t || t.data.length !== width) throw new Error(`${what}: output ${spec.output} has ${t?.data.length ?? 0} values, expected ${width}`);
    return Array.from(t.data as Float32Array);
  };

  try {
    const members: InferenceSession[] = [];
    for (const f of m.entry.members) members.push(await open(f));
    const exitSession = await open(m.exit.file);
    for (const [s, spec, name] of [...members.map((s, i) => [s, m.entry, m.entry.members[i]] as const), [exitSession, m.exit, m.exit.file] as const]) {
      if (!s.inputNames.includes(spec.input)) throw new Error(`${name}: no input named ${spec.input}`);
      if (!s.outputNames.includes(spec.output)) throw new Error(`${name}: no output named ${spec.output}`);
    }
    // warm-up, which also checks each net's widths
    const zEntry = new Float32Array(m.entry.features.length);
    for (let i = 0; i < members.length; i++) await run(members[i], m.entry, zEntry, m.entry.actions.length, m.entry.members[i]);
    await run(exitSession, m.exit, new Float32Array(m.exit.features.length), m.exit.actions.length, m.exit.file);

    let released = false;
    return {
      version: m.version,
      dir,
      manifest: m,
      entryQ: (x) => Promise.all(members.map((s, i) => run(s, m.entry, x, m.entry.actions.length, m.entry.members[i]))),
      exitQ: (x) => run(exitSession, m.exit, x, m.exit.actions.length, m.exit.file),
      async release() {
        if (released) return;
        released = true;
        await Promise.allSettled(made.map((s) => s.release()));
      },
    };
  } catch (e) {
    await Promise.allSettled(made.map((s) => s.release()));
    throw e;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Hot reload

export interface BrainCheck {
  /** loaded = a new bundle is now in use · failed = a new bundle was rejected (the previous one stays) ·
   *  unchanged = nothing new (or the same rejected bundle) · missing = no `current` link yet · busy = a load is running */
  status: "loaded" | "failed" | "unchanged" | "missing" | "busy";
  version?: string;
  error?: string;
}

export interface BrainModelsOptions extends ManifestChecks {
  /** BRAIN_DIR (default config.brainDir), relative to the repo root. */
  dir?: string;
  /** How long a replaced model's sessions stay open for runs already in flight. */
  releaseDelayMs?: number;
}

/** The model in use, its hot reload, and the brain_models record of every load. */
export class BrainModels {
  private active: BrainModel | null = null;
  private activeKey: string | null = null;
  private failedKey: string | null = null;
  private loading: Promise<BrainCheck> | null = null;
  private retiring = new Set<BrainModel>();
  /** The last load failure (version and reason), kept until a load succeeds. */
  lastError: { version: string; error: string; at: string } | null = null;
  readonly root: string;

  constructor(
    private db: DB | null,
    private opts: BrainModelsOptions = {},
  ) {
    this.root = brainRoot(opts.dir);
    if (db) ensureBrainModelTables(db);
  }

  /** The model in use, or null before the first good bundle. */
  get model(): BrainModel | null {
    return this.active;
  }

  /** Loads `current` when it points somewhere new. Never throws: a bad bundle leaves the previous model in use. */
  check(now = Date.now()): Promise<BrainCheck> {
    if (this.loading) return Promise.resolve({ status: "busy" });
    this.loading = this.checkNow(now)
      .catch((e): BrainCheck => ({ status: "failed", error: (e as Error).message }))
      .finally(() => {
        this.loading = null;
      });
    return this.loading;
  }

  private async checkNow(now: number): Promise<BrainCheck> {
    const link = path.join(this.root, "current");
    let dir: string;
    try {
      dir = fs.realpathSync(link);
    } catch {
      return { status: "missing" };
    }
    let mtime = "none";
    try {
      mtime = String(fs.statSync(path.join(dir, "manifest.json")).mtimeMs);
    } catch {
      /* loadBundle reports it */
    }
    const key = `${dir}|${mtime}`;
    if (key === this.activeKey || key === this.failedKey) return { status: "unchanged", version: this.active?.version };

    const at = new Date(now).toISOString();
    try {
      const model = await loadBundle(dir, this.opts);
      const old = this.active;
      this.active = model;
      this.activeKey = key;
      this.failedKey = null;
      this.lastError = null;
      if (old) this.retire(old);
      this.record(model.version, at, JSON.stringify(model.manifest), "active", null);
      console.log(
        `[brain] model ${model.version} loaded (${model.manifest.entry.members.length} entry nets${model.manifest.brain_enabled ? "" : ", explore only"})${old ? `, replacing ${old.version}` : ""}`,
      );
      return { status: "loaded", version: model.version };
    } catch (e) {
      const error = (e as Error).message;
      const { version, manifest } = bundleIdentity(dir);
      this.failedKey = key;
      this.lastError = { version, error, at };
      this.record(version, at, manifest, "failed", error);
      console.warn(`[brain] model ${version} rejected: ${error}; ${this.active ? `keeping ${this.active.version}` : "no model in use"}`);
      return { status: "failed", version, error };
    }
  }

  private retire(model: BrainModel): void {
    this.retiring.add(model);
    const t = setTimeout(() => {
      this.retiring.delete(model);
      void model.release();
    }, this.opts.releaseDelayMs ?? 60_000);
    t.unref?.();
  }

  private record(version: string, at: string, manifest: string | null, status: "active" | "failed", error: string | null): void {
    if (!this.db) return;
    try {
      if (status === "active") {
        this.db.transaction(() => {
          this.db!.prepare("UPDATE brain_models SET status = 'previous' WHERE status = 'active' AND version != ?").run(version);
          this.db!.prepare(
            `INSERT INTO brain_models (version, loaded_at, manifest, status, error) VALUES (?, ?, ?, 'active', NULL)
             ON CONFLICT(version) DO UPDATE SET loaded_at = excluded.loaded_at, manifest = excluded.manifest, status = 'active', error = NULL`,
          ).run(version, at, manifest);
        })();
      } else {
        // a failed reload of the version in use doesn't mark the running model failed
        this.db
          .prepare(
            `INSERT INTO brain_models (version, loaded_at, manifest, status, error) VALUES (?, ?, ?, 'failed', ?)
             ON CONFLICT(version) DO UPDATE SET loaded_at = excluded.loaded_at, manifest = excluded.manifest, status = 'failed', error = excluded.error
             WHERE brain_models.status != 'active'`,
          )
          .run(version, at, manifest, error);
      }
    } catch {
      /* never crash because of the record */
    }
  }

  /** Releases every session (the agent's shutdown, tests). */
  async close(): Promise<void> {
    const all = [...this.retiring, ...(this.active ? [this.active] : [])];
    this.active = null;
    this.activeKey = null;
    this.retiring.clear();
    await Promise.allSettled(all.map((m) => m.release()));
  }
}

/** The version and manifest text of a bundle that failed, as far as they can be read. */
function bundleIdentity(dir: string): { version: string; manifest: string | null } {
  try {
    const text = fs.readFileSync(path.join(dir, "manifest.json"), "utf8");
    const v = (JSON.parse(text) as { version?: unknown }).version;
    return { version: typeof v === "string" && v ? v : path.basename(dir), manifest: text };
  } catch {
    return { version: path.basename(dir), manifest: null };
  }
}
