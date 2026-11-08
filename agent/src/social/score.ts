/**
 * THE PRIVATE SOCIAL SCORE — runs the social model the Mac trains (brain/brain/social/train.py) on every wallet with an
 * owner-grade X link, once an hour, and writes social_scores(wallet, score, n_posts, model_version, updated_at) for the
 * brain's entry features (social_score / social_missing in brain/spec/features.yaml).
 *
 *   <BRAIN_DIR>/social/current → models/<version>/   manifest.json + social.onnx   (CONTRACT.md "Social score")
 *
 * `current` is resolved once per run and both files are read from that directory; social.onnx is used only when its
 * sha256 matches the manifest. score = the model's predicted 14-day copy return − manifest.pop_mean (0 = no information);
 * the entry features multiply it by the 18/(18 + n_own) shrink. Without a model (or with a bad one) nothing is written.
 * Nor with a model that did not pass its pre-registered out-of-time test (manifest.gate.passed, features.yaml social.gate):
 * social gets no weight until it does, so its wallets stay social_missing.
 *
 * The inputs are computed here exactly as brain/brain/social/features.py computes them for training (point in time at
 * `now`); brain/brain/social/golden.json holds cases both sides reproduce (test/social-score.test.ts). Change one side,
 * change the other and regenerate the golden file.
 *
 * HIDDEN: like the collector, nothing here reaches say(), agent_log, the snapshot or the API; the console gets counts.
 * Paper and observation only: nothing here trades.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { type DB, nowIso } from "@godseye/shared";
import { brainRoot } from "../brain/model";
import { ensureSocialTables } from "./schema";

const DAY = 86_400;
const WINDOW_30D = 30 * DAY;
const WINDOW_7D = 7 * DAY;
/** A post and the wallet's first buy of its coin pair up within ±24 h; fewer than MIN_PAIRS pairs = missing. */
const PAIR_WINDOW = DAY;
const MIN_PAIRS = 3;
/** An author linked to more wallets than this is a tracker: its mentions are not owner-grade. */
const TRACKER_WALLETS = 3;
const OWNER_HOW = new Set(["bio", "tweet", "timing"]);
const SHRINK_N = 18;
const BATCH = 1024;
export const SOCIAL_MODEL_FILE = "social.onnx";
const LOG = "[social]";

/** The social inputs in features.yaml order: name, transform, and whether the spec gives it a `<name>_missing` flag. */
export const SOCIAL_INPUTS: { name: string; transform: "none" | "log1p" | "signed_log" | "clip3"; flag: boolean }[] = [
  { name: "acct_age_days", transform: "log1p", flag: true },
  { name: "followers_log", transform: "none", flag: true },
  { name: "follower_growth_7d", transform: "clip3", flag: true },
  { name: "post_rate_7d", transform: "log1p", flag: true },
  { name: "ca_share_30d", transform: "none", flag: true },
  { name: "buy_before_call_share_30d", transform: "none", flag: true },
  { name: "median_call_lag_min", transform: "signed_log", flag: true },
  { name: "engagement_med_30d", transform: "none", flag: true },
  { name: "mentioned_by_callers_30d", transform: "log1p", flag: true },
  { name: "wallets_per_account", transform: "log1p", flag: true },
  { name: "accounts_per_wallet", transform: "log1p", flag: false },
  { name: "funder_cluster_size", transform: "log1p", flag: true },
  { name: "own_record_shrunk", transform: "none", flag: false },
];
/** The model's input columns: each input, then its missing flag. */
export const SOCIAL_FEATURES = SOCIAL_INPUTS.flatMap((i) => (i.flag ? [i.name, `${i.name}_missing`] : [i.name]));

// ---------------------------------------------------------------------------------------------------------------------
// The inputs (features.py raw_inputs, line for line). Times are unix seconds.

/** Unix seconds from an ISO time or a number (ms above 1e11); null when missing or unreadable. */
export function toSec(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? (v < 1e11 ? v : v / 1000) : null;
  const ms = Date.parse(String(v));
  return Number.isFinite(ms) ? ms / 1000 : null;
}

const num = (v: unknown): number | null => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));
const jsonList = (v: unknown): string[] => {
  try {
    const a = JSON.parse(String(v ?? "[]"));
    return Array.isArray(a) ? a.map(String) : [];
  } catch {
    return [];
  }
};
/** numpy's median: the middle value, or the mean of the two middle ones. */
export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[n >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2;
}
/** Index of the last element < x in an ascending array (bisect_left − 1); −1 when none. */
function lastBefore(a: number[], x: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}
/** Index of the last element ≤ x (bisect_right − 1); −1 when none. */
function lastAtOrBefore(a: number[], x: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid] <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

interface Post {
  ts: number;
  fetched: number;
  eng: number;
  mints: string[];
}

/** What the inputs read, loaded once per run (see loadSocialIndex). */
export interface SocialIndex {
  linksByWallet: Map<string, { author: string; how: string; firstSeen: number }[]>;
  linksByAuthor: Map<string, { wallet: string; firstSeen: number }[]>;
  created: Map<string, number | null>;
  snaps: Map<string, { fetched: number[]; followers: (number | null)[]; tweets: (number | null)[] }>;
  postsByAuthor: Map<string, Post[]>;
  mentionsByWallet: Map<string, { author: string; ts: number; fetched: number }[]>;
  /** The wallet's first buy of a coin: [ts, when the server had it]; null = none. */
  firstBuy(wallet: string, mint: string): [number, number] | null;
  /** The wallet's copy outcomes, sorted by resolved_at. */
  ledger(wallet: string): { resolvedAt: number[]; y: number[] };
  /** Null when wallets has no funder_filled_at (the input is then missing for everyone, as in training). */
  funder(wallet: string): { funder: string | null; filled: number | null; group: { firstSeen: number | null; filled: number | null }[] } | null;
}

const push = <K, V>(m: Map<K, V[]>, k: K, v: V) => {
  const a = m.get(k);
  if (a) a.push(v);
  else m.set(k, [v]);
};

/** The wallet's owner-grade accounts at t, sorted. */
export function ownerAccounts(ix: SocialIndex, wallet: string, t: number): string[] {
  const out = new Set<string>();
  for (const l of ix.linksByWallet.get(wallet) ?? []) {
    if (l.firstSeen >= t) continue;
    if (OWNER_HOW.has(l.how)) out.add(l.author);
    else if (l.how === "mention" && new Set((ix.linksByAuthor.get(l.author) ?? []).filter((x) => x.firstSeen < t).map((x) => x.wallet)).size <= TRACKER_WALLETS) out.add(l.author);
  }
  return [...out].sort();
}

/** The owner account with the most followers in its latest snapshot before t (none = −1; ties: the lowest id). */
function primaryAccount(ix: SocialIndex, accounts: string[], t: number): string {
  let best = accounts[0];
  let bestF = -Infinity;
  for (const a of accounts) {
    const s = ix.snaps.get(a);
    const i = s ? lastBefore(s.fetched, t) : -1;
    const f = (i >= 0 ? s!.followers[i] : null) ?? -1;
    if (f > bestF) {
      best = a;
      bestF = f;
    }
  }
  return best;
}

/** The raw inputs of `wallet` at t (null = missing) and n_posts; null when it has no owner-grade link. */
export function rawSocialInputs(ix: SocialIndex, wallet: string, t: number, popMean: number): { raw: Record<string, number | null>; nPosts: number } | null {
  const owners = ownerAccounts(ix, wallet, t);
  if (!owners.length) return null;
  const acct = primaryAccount(ix, owners, t);
  const v: Record<string, number | null> = {};

  const s = ix.snaps.get(acct);
  const i = s ? lastBefore(s.fetched, t) : -1;
  const created = ix.created.get(acct) ?? null;
  v.acct_age_days = i >= 0 && created !== null ? Math.max(0, (t - created) / DAY) : null;
  v.followers_log = v.follower_growth_7d = v.post_rate_7d = null;
  if (s && i >= 0) {
    const f = s.followers;
    const tw = s.tweets;
    if (f[i] !== null) v.followers_log = Math.log1p(Math.max(f[i]!, 0));
    const j = lastAtOrBefore(s.fetched, s.fetched[i] - WINDOW_7D);
    if (j >= 0) {
      if (f[i] !== null && f[j] !== null) v.follower_growth_7d = Math.log((Math.max(f[i]!, 0) + 1) / (Math.max(f[j]!, 0) + 1));
      if (tw[i] !== null && tw[j] !== null) v.post_rate_7d = Math.max(0, tw[i]! - tw[j]!) / ((s.fetched[i] - s.fetched[j]) / DAY);
    }
  }

  const posts = (ix.postsByAuthor.get(acct) ?? []).filter((p) => p.ts >= t - WINDOW_30D && p.ts < t && p.fetched < t);
  v.ca_share_30d = posts.length ? posts.filter((p) => p.mints.length).length / posts.length : null;
  const engaged = posts.filter((p) => p.fetched - p.ts >= DAY).map((p) => Math.log1p(p.eng));
  v.engagement_med_30d = engaged.length ? median(engaged) : null;
  const lags: number[] = [];
  for (const p of posts) {
    for (const m of p.mints) {
      const b = ix.firstBuy(wallet, m);
      if (b && b[0] < t && b[1] < t && Math.abs(p.ts - b[0]) <= PAIR_WINDOW) lags.push((p.ts - b[0]) / 60);
    }
  }
  const enough = lags.length >= MIN_PAIRS;
  v.buy_before_call_share_30d = enough ? lags.filter((x) => x > 0).length / lags.length : null;
  v.median_call_lag_min = enough ? median(lags) : null;

  const ownerSet = new Set(owners);
  v.mentioned_by_callers_30d = new Set(
    (ix.mentionsByWallet.get(wallet) ?? []).filter((m) => m.ts >= t - WINDOW_30D && m.ts < t && m.fetched < t && !ownerSet.has(m.author)).map((m) => m.author),
  ).size;
  v.wallets_per_account = new Set((ix.linksByAuthor.get(acct) ?? []).filter((l) => l.firstSeen < t).map((l) => l.wallet)).size;
  v.accounts_per_wallet = new Set((ix.linksByWallet.get(wallet) ?? []).filter((l) => l.firstSeen < t).map((l) => l.author)).size;

  v.funder_cluster_size = null;
  const fu = ix.funder(wallet);
  if (fu && fu.funder !== null && fu.filled !== null && fu.filled < t) {
    v.funder_cluster_size = fu.group.filter((g) => g.firstSeen !== null && g.firstSeen < t && g.filled !== null && g.filled < t).length;
  }

  const led = ix.ledger(wallet);
  let sum = 0;
  let n = 0;
  for (let k = 0; k < led.resolvedAt.length; k++) {
    if (led.resolvedAt[k] >= t - WINDOW_7D && led.resolvedAt[k] < t) {
      sum += led.y[k];
      n++;
    }
  }
  v.own_record_shrunk = (sum + SHRINK_N * popMean) / (n + SHRINK_N);
  return { raw: v, nPosts: posts.length };
}

/** The model's input row before normalisation: transformed inputs, a missing one replaced by its fill, then its flag. */
export function socialVector(raw: Record<string, number | null>, fill: number[]): number[] {
  const out: number[] = [];
  SOCIAL_INPUTS.forEach((inp, k) => {
    const r = raw[inp.name];
    const miss = r === null || r === undefined;
    let x = fill[k];
    if (!miss) {
      if (inp.transform === "log1p") x = Math.log1p(Math.max(r, 0));
      else if (inp.transform === "signed_log") x = Math.sign(r) * Math.log1p(Math.abs(r));
      else if (inp.transform === "clip3") x = Math.min(Math.max(r, -3), 3);
      else x = r;
    }
    out.push(x);
    if (inp.flag) out.push(miss ? 1 : 0);
  });
  return out;
}

/**
 * The 30-day window of posts the inputs read. A range on ts, served by idx_social_posts_ts: without that index it scans
 * and sorts every post, slow enough to reach the slow-SQL log.
 */
export const POSTS_WINDOW_SQL =
  "SELECT author_id, ts, fetched_at, likes, reposts, replies, quotes, mints, wallets FROM social_posts WHERE ts >= ? AND ts < ? AND fetched_at < ? ORDER BY ts";

const hasTable = (db: DB, name: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
const hasColumn = (db: DB, table: string, col: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === col);

/** Loads what the inputs at `t` (unix seconds) read: links, profiles, the 30-day posts; buys, outcomes and funders on demand. */
export function loadSocialIndex(db: DB, t: number): SocialIndex {
  ensureSocialTables(db);
  db.exec("CREATE INDEX IF NOT EXISTS idx_social_posts_ts ON social_posts(ts)");
  const iso = (s: number) => new Date(s * 1000).toISOString();
  const ix: SocialIndex = {
    linksByWallet: new Map(),
    linksByAuthor: new Map(),
    created: new Map(),
    snaps: new Map(),
    postsByAuthor: new Map(),
    mentionsByWallet: new Map(),
    firstBuy: () => null,
    ledger: () => ({ resolvedAt: [], y: [] }),
    funder: () => null,
  };
  for (const r of db.prepare("SELECT wallet, author_id, how, first_seen_at FROM social_wallet_accounts").all() as Record<string, string>[]) {
    const fs = toSec(r.first_seen_at);
    if (fs === null) continue;
    push(ix.linksByWallet, r.wallet, { author: r.author_id, how: r.how, firstSeen: fs });
    push(ix.linksByAuthor, r.author_id, { wallet: r.wallet, firstSeen: fs });
  }
  for (const r of db.prepare("SELECT id, created_at FROM social_accounts").all() as Record<string, string>[]) ix.created.set(r.id, toSec(r.created_at));
  const snaps = db.prepare("SELECT account_id, fetched_at, followers, tweets FROM social_account_snapshots WHERE fetched_at < ? ORDER BY account_id, fetched_at").all(iso(t)) as Record<string, unknown>[];
  for (const r of snaps) {
    const f = toSec(r.fetched_at);
    if (f === null) continue;
    const id = String(r.account_id);
    let s = ix.snaps.get(id);
    if (!s) ix.snaps.set(id, (s = { fetched: [], followers: [], tweets: [] }));
    s.fetched.push(f);
    s.followers.push(num(r.followers));
    s.tweets.push(num(r.tweets));
  }
  const posts = db.prepare(POSTS_WINDOW_SQL).all(iso(t - WINDOW_30D), iso(t), iso(t)) as Record<string, unknown>[];
  for (const r of posts) {
    const ts = toSec(r.ts);
    const fetched = toSec(r.fetched_at);
    if (ts === null || fetched === null) continue;
    const author = String(r.author_id);
    const eng = (num(r.likes) ?? 0) + (num(r.reposts) ?? 0) + (num(r.replies) ?? 0) + (num(r.quotes) ?? 0);
    push(ix.postsByAuthor, author, { ts, fetched, eng, mints: jsonList(r.mints) });
    for (const w of new Set(jsonList(r.wallets))) push(ix.mentionsByWallet, w, { author, ts, fetched });
  }

  // A swap is on the server when it is in wallet_swaps: known when it happened.
  const firstBuy = db.prepare("SELECT MIN(ts) ts FROM wallet_swaps WHERE wallet = ? AND mint = ? AND side = 'buy'");
  ix.firstBuy = (wallet, mint) => {
    const ts = toSec((firstBuy.get(wallet, mint) as { ts: string | null } | undefined)?.ts);
    return ts === null ? null : [ts, ts];
  };
  if (hasTable(db, "mirror_ledger")) {
    const ledger = db.prepare("SELECT y, resolved_at FROM mirror_ledger WHERE leader = ? AND y IS NOT NULL");
    ix.ledger = (wallet) => {
      const rows = (ledger.all(wallet) as { y: number; resolved_at: unknown }[])
        .map((r) => ({ y: Number(r.y), at: toSec(r.resolved_at) }))
        .filter((r): r is { y: number; at: number } => r.at !== null && Number.isFinite(r.y))
        .sort((a, b) => a.at - b.at);
      return { resolvedAt: rows.map((r) => r.at), y: rows.map((r) => r.y) };
    };
  }
  if (hasColumn(db, "wallets", "funder_filled_at")) {
    const own = db.prepare("SELECT funder, funder_filled_at FROM wallets WHERE address = ?");
    const group = db.prepare("SELECT first_seen_at, funder_filled_at FROM wallets WHERE funder = ?");
    ix.funder = (wallet) => {
      const r = own.get(wallet) as { funder: string | null; funder_filled_at: string | null } | undefined;
      if (!r?.funder) return { funder: null, filled: null, group: [] };
      const g = group.all(r.funder) as { first_seen_at: string | null; funder_filled_at: string | null }[];
      return { funder: r.funder, filled: toSec(r.funder_filled_at), group: g.map((x) => ({ firstSeen: toSec(x.first_seen_at), filled: toSec(x.funder_filled_at) })) };
    };
  }
  return ix;
}

/** Every wallet with an owner-grade link at t: its input row (before normalisation) and n_posts. */
export function socialRows(db: DB, t: number, popMean: number, fill: number[]): Map<string, { vector: number[]; nPosts: number }> {
  const ix = loadSocialIndex(db, t);
  const out = new Map<string, { vector: number[]; nPosts: number }>();
  for (const wallet of [...ix.linksByWallet.keys()].sort()) {
    const r = rawSocialInputs(ix, wallet, t, popMean);
    if (r) out.set(wallet, { vector: socialVector(r.raw, fill), nPosts: r.nPosts });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// The bundle

export interface SocialManifest {
  version: string;
  feature_spec_version: number;
  features: string[];
  norm: { mean: number[]; std: number[] };
  fill: number[];
  file: string;
  input: string;
  output: string;
  pop_mean: number;
  /** The trainer's out-of-time test (train.py gate): scores are written only when it passed. */
  gate_passed: boolean;
  sha256: Record<string, string>;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isNumArr = (v: unknown): v is number[] => Array.isArray(v) && v.every((x) => typeof x === "number" && Number.isFinite(x));
const isPlainName = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9._-]+$/.test(v) && v !== "." && v !== "..";

/** Checks a social manifest.json; throws with the first problem. The features must be exactly the ones computed here. */
export function validateSocialManifest(raw: unknown): SocialManifest {
  if (!isObj(raw)) throw new Error("manifest is not an object");
  if (!isPlainName(raw.version)) throw new Error("version: missing or not a plain name");
  if (typeof raw.feature_spec_version !== "number") throw new Error("feature_spec_version: missing");
  if ("entry" in raw) throw new Error("this is a brain model bundle, not a social one");
  const f = raw.features;
  if (!Array.isArray(f) || f.join() !== SOCIAL_FEATURES.join()) throw new Error("features: not the social inputs this scorer computes (update score.ts with features.py)");
  const norm = raw.norm;
  if (!isObj(norm) || !isNumArr(norm.mean) || !isNumArr(norm.std) || norm.mean.length !== f.length || norm.std.length !== f.length) {
    throw new Error("norm: needs a numeric mean and std per feature");
  }
  if (norm.std.some((s) => s <= 0)) throw new Error("norm.std: must be > 0");
  if (!isNumArr(raw.fill) || raw.fill.length !== SOCIAL_INPUTS.length) throw new Error("fill: needs one number per input");
  const file = raw.file ?? SOCIAL_MODEL_FILE;
  if (file !== SOCIAL_MODEL_FILE) throw new Error(`file: must be ${SOCIAL_MODEL_FILE}`);
  if (typeof raw.input !== "string" || !raw.input || typeof raw.output !== "string" || !raw.output) throw new Error("input/output names missing");
  if (typeof raw.pop_mean !== "number" || !Number.isFinite(raw.pop_mean)) throw new Error("pop_mean: missing");
  const sha = raw.sha256;
  if (!isObj(sha) || typeof sha[file] !== "string" || !/^[0-9a-fA-F]{64}$/.test(sha[file] as string)) throw new Error(`sha256: no hash for ${file}`);
  return {
    version: raw.version,
    feature_spec_version: raw.feature_spec_version,
    features: f as string[],
    norm: { mean: norm.mean, std: norm.std },
    fill: raw.fill,
    file,
    input: raw.input,
    output: raw.output,
    pop_mean: raw.pop_mean,
    gate_passed: isObj(raw.gate) && raw.gate.passed === true,
    sha256: sha as Record<string, string>,
  };
}

/** The social folder: <BRAIN_DIR>/social. */
export const socialRoot = (dir?: string): string => path.join(brainRoot(dir), "social");

/** Reads the bundle `current` points at (resolved once): its manifest and the hash-checked model bytes. Null = no model. */
export function readSocialBundle(dir?: string): { manifest: SocialManifest; model: Uint8Array } | null {
  let real: string;
  try {
    real = fs.realpathSync(path.join(socialRoot(dir), "current"));
  } catch {
    return null;
  }
  const read = (name: string) => {
    try {
      return fs.readFileSync(path.join(real, name));
    } catch (e) {
      throw new Error(`cannot read ${name} (${(e as NodeJS.ErrnoException).code ?? "error"})`);
    }
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(read("manifest.json").toString("utf8"));
  } catch (e) {
    throw new Error(`manifest.json: ${(e as Error).message}`);
  }
  const manifest = validateSocialManifest(parsed);
  const bytes = read(manifest.file);
  if (crypto.createHash("sha256").update(bytes).digest("hex") !== manifest.sha256[manifest.file].toLowerCase()) throw new Error(`sha256 mismatch for ${manifest.file}`);
  return { manifest, model: new Uint8Array(bytes) };
}

// ---------------------------------------------------------------------------------------------------------------------
// The hourly job

export interface SocialScoreResult {
  /**
   * scored = rows written · missing = no model · gated = the model didn't pass its out-of-time test · failed = the model
   * was rejected or couldn't run. Only `scored` writes anything.
   */
  status: "scored" | "missing" | "gated" | "failed";
  version?: string;
  wallets: number;
  /** Wallets whose prediction wasn't a finite number (not written). */
  skipped: number;
  error?: string;
}

export interface SocialScoreOptions {
  /** BRAIN_DIR (default config.brainDir). */
  dir?: string;
  now?: number;
}

/** One scoring run (the hourly job). Never throws. */
export async function runSocialScore(db: DB, opts: SocialScoreOptions = {}): Promise<SocialScoreResult> {
  const res: SocialScoreResult = { status: "missing", wallets: 0, skipped: 0 };
  let bundle: ReturnType<typeof readSocialBundle>;
  try {
    bundle = readSocialBundle(opts.dir);
  } catch (e) {
    console.log(`${LOG} social model rejected: ${(e as Error).message}; no scores written.`);
    return { ...res, status: "failed", error: (e as Error).message };
  }
  if (!bundle) return res;
  const m = bundle.manifest;
  res.version = m.version;
  if (!m.gate_passed) {
    console.log(`${LOG} social model ${m.version} hasn't passed its out-of-time test; no scores written.`);
    return { ...res, status: "gated" };
  }
  const t = (opts.now ?? Date.now()) / 1000;
  try {
    const rows = socialRows(db, t, m.pop_mean, m.fill);
    const wallets = [...rows.keys()];
    const ort = await import("onnxruntime-node");
    const session = await ort.InferenceSession.create(bundle.model, { executionProviders: ["cpu"], intraOpNumThreads: 1, interOpNumThreads: 1 });
    const F = m.features.length;
    const scores: number[] = [];
    try {
      for (let i = 0; i < wallets.length; i += BATCH) {
        const chunk = wallets.slice(i, i + BATCH);
        const x = new Float32Array(chunk.length * F);
        chunk.forEach((w, r) => rows.get(w)!.vector.forEach((v, k) => (x[r * F + k] = (v - m.norm.mean[k]) / m.norm.std[k])));
        const out = await session.run({ [m.input]: new ort.Tensor("float32", x, [chunk.length, F]) });
        const y = out[m.output];
        if (!y || y.data.length !== chunk.length) throw new Error(`output ${m.output} has ${y?.data.length ?? 0} values for ${chunk.length} wallets`);
        for (const v of y.data as Float32Array) scores.push(v - m.pop_mean);
      }
    } finally {
      await session.release().catch(() => undefined);
    }
    const put = db.prepare(
      `INSERT INTO social_scores (wallet, score, n_posts, model_version, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(wallet) DO UPDATE SET score = excluded.score, n_posts = excluded.n_posts, model_version = excluded.model_version, updated_at = excluded.updated_at`,
    );
    const at = opts.now !== undefined ? new Date(opts.now).toISOString() : nowIso();
    db.transaction(() => {
      wallets.forEach((w, i) => {
        if (!Number.isFinite(scores[i])) {
          res.skipped++;
          return;
        }
        put.run(w, scores[i], rows.get(w)!.nPosts, m.version, at);
        res.wallets++;
      });
    })();
    res.status = "scored";
    console.log(`${LOG} scored ${res.wallets} linked wallets with social model ${m.version}${res.skipped ? ` (${res.skipped} skipped: no finite score)` : ""}.`);
  } catch (e) {
    res.status = "failed";
    res.error = (e as Error).message;
    console.log(`${LOG} social scoring failed: ${res.error}; no scores written.`);
  }
  return res;
}
