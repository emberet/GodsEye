/**
 * The Brain on the live stream: feeds every streamed swap to the stream state and the leader ledgers, routes the signals
 * into the paper accounts (paper.ts) with the model's decisions, and keeps the model bundle fresh (model.ts). Paper money
 * only: the real copy engine never sees any of it (no executor that signs, no copy_trades or positions rows).
 *
 *   onSwap          every swap, synchronous and cheap (the stream loop mustn't stall): StreamState records it (the
 *                   MirrorLedger follows it by subscription); what the state kept marks held coins and, for an analyzed
 *                   wallet's sell, asks the exit network at once (paper.ts onStreamSwap); an untracked print moves a held
 *                   coin's price but not its age. An analyzed wallet's buy is a signal: the shadow quotes may sample it,
 *                   and the paper book decides on it. The in-memory parts the features need at decision time t (the
 *                   coin's first sighting, the leader's holding) are taken right there; the DB reads (the leader's
 *                   wallet_swaps scan, the ledgers, token_info, social_scores) run in the async buy path, after the
 *                   stream's call has returned.
 *   decideEntry     features.ts entry vector → hard gates first (a gated signal: the Brain logs a skip with info.gate,
 *                   the network isn't asked) → Explore with probability explore.rate, else Brain (policy.ts), each with the
 *                   manifest's margin_c / curiosity; brain_enabled false = the Brain account skips. The transition keeps
 *                   the normalised vector (`features`), the decisive scores (`q`) and, in info, the raw values, every
 *                   member's q with their mean / std, the margin and the gate.
 *   decideExit      features.ts exit vector (ExitState + the coin's 5-min flow + the hour's active wallets + the entry's
 *                   ps_r_7d) → the exit net's argmax (policy.ts pickExit; paper.ts applies the hard stops itself).
 *   tick            once a minute: a newly pushed model, then the open paper positions.
 *   tickLedgers     once a minute: the state's windows and creator lookups, the ledgers' deadlines and delayed jobs.
 *   start / stop    the shadow-quote sampler (every second, unref'd).
 *
 * Without a model Brain and Explore don't trade (Baseline still does). Server log only (console), never say(): the feature
 * vectors carry social_score, which is private.
 */
import fs from "node:fs";
import path from "node:path";
import type { DB } from "@godseye/shared";
import { config } from "../config";
import type { ParsedSwap } from "../chain/parse";
import { socialRoot } from "../social/score";
import {
  entryColumns, entryGate, entryRaw, entryVector, type EntrySignal, type EntrySources, exitColumns, exitRaw, exitVector, FEATURE_SPEC_VERSION,
  liveSources, rawForLog,
} from "./features";
import { MirrorLedger } from "./ledger";
import { type BrainCheck, type BrainManifest, type BrainModel, BrainModels } from "./model";
import { type EntryDecision, type EntryDecisions, type ExitDecision, type ExitState, type LeaderBuy, PaperBook, type PaperDeps, type PaperPosition } from "./paper";
import { decideSignal, pickExit, type Rng, routeSignal, type SignalPolicy } from "./policy";
import { type ShadowQuoteDeps, ShadowQuotes } from "./quotes";
import { type StreamStateDeps, StreamState, type StreamSwap } from "./state";

const ANALYZED_TTL_MS = 10 * 60_000;
/** The live social model's version is read again after this long. */
const SOCIAL_TTL_MS = 5 * 60_000;
/** Signals waiting for their decision (bounded: a decision follows within the stream's call). */
const SIGNALS_MAX = 5_000;
const PS_CACHE_MAX = 10_000;
const WARN_QUIET_MS = 10 * 60_000;

/** The model in use and its hot reload (model.ts BrainModels; a stub in tests). */
export interface ModelSource {
  readonly model: BrainModel | null;
  check(now?: number): Promise<BrainCheck>;
  close(): Promise<void>;
}

export interface BrainRuntimeOptions {
  /** Reject bundles built for another feature spec (default features.ts FEATURE_SPEC_VERSION). */
  featureSpecVersion?: number;
  /** BRAIN_DIR (default config.brainDir). */
  dir?: string;
  /** The clock of the state, the ledgers, the quotes and the book (default the book's deps.now, else Date.now). */
  now?: () => number;
  /** Exploration's coin flips and Thompson picks (default Math.random). */
  rng?: Rng;
  state?: Partial<StreamStateDeps>;
  quotes?: Partial<ShadowQuoteDeps>;
  /** The model source (default the hot-reloaded bundle under BRAIN_DIR, checked against the columns features.ts computes). */
  models?: ModelSource;
}

/** What the features need from the moment the stream delivered a signal (decision time t). */
interface Signal {
  swap: ParsedSwap;
  t: number;
  first: ReturnType<StreamState["firstSeen"]>;
  holding: ReturnType<StreamState["leaderHolding"]>;
}

const iso = (ms: number) => new Date(ms).toISOString();
const signalKey = (signature: string, leader: string, mint: string) => `${signature}|${leader}|${mint}`;

/** The manifest's entry policy (policy.ts SignalPolicy). */
export const signalPolicy = (m: BrainManifest): SignalPolicy => ({
  actions: m.entry.actions,
  marginC: m.entry.margin_c,
  brainEnabled: m.brain_enabled,
  exploreRate: m.explore.rate,
  curiosity: m.explore.curiosity,
});

export class BrainRuntime {
  readonly models: ModelSource;
  readonly book: PaperBook;
  readonly state: StreamState;
  readonly ledger: MirrorLedger;
  readonly quotes: ShadowQuotes;
  private sources: EntrySources;
  private now: () => number;
  private rng: Rng;
  private analyzed: { set: Set<string>; at: number } | null = null;
  private signals = new Map<string, Signal>();
  private psCache = new Map<number, number | null>();
  private social: { version: string | null; at: number } | null = null;
  private inflight = new Set<Promise<unknown>>();
  private warned = new Map<string, number>();

  constructor(
    private db: DB,
    deps: Partial<PaperDeps> = {},
    private opts: BrainRuntimeOptions = {},
  ) {
    this.now = opts.now ?? deps.now ?? Date.now;
    this.rng = opts.rng ?? Math.random;
    this.models =
      opts.models ??
      new BrainModels(db, { dir: opts.dir, featureSpecVersion: opts.featureSpecVersion ?? FEATURE_SPEC_VERSION, entryColumns, exitColumns: exitColumns() });
    this.state = new StreamState(db, { now: this.now, ...opts.state });
    this.quotes = new ShadowQuotes(db, {
      now: this.now,
      lastTracked: (mint, t) => this.state.lastTracked(mint, t),
      ...(deps.bucket ? { bucket: deps.bucket } : {}),
      ...opts.quotes,
    });
    // The mirror ledger follows the state (it subscribes); its y_quote samples share the shadow quotes' cap.
    this.ledger = new MirrorLedger(db, this.state, { now: this.now, quoteSell: (mint, tokens) => this.quotes.tryQuote(mint, tokens) });
    this.sources = liveSources({ db, state: this.state, ledger: this.ledger, socialModelVersion: () => this.socialModelVersion() });
    this.book = new PaperBook(db, {
      now: this.now,
      isAnalyzed: (w) => this.isAnalyzed(w),
      lastTracked: (mint, t) => this.state.lastTracked(mint, t),
      decideEntry: (s) => this.decideEntry(s),
      decideExit: (pos, st) => this.decideExit(pos, st),
      ...deps,
    });
  }

  /** Any wallet in the wallets table, cached (one lookup per swap would be thousands a minute). */
  isAnalyzed(wallet: string): boolean {
    const now = Date.now();
    if (!this.analyzed || now - this.analyzed.at > ANALYZED_TTL_MS) {
      const rows = this.db.prepare("SELECT address FROM wallets").all() as { address: string }[];
      this.analyzed = { set: new Set(rows.map((r) => r.address)), at: now };
    }
    return this.analyzed.set.has(wallet);
  }

  /** Server log only, at most once per 10 min per kind. */
  private warn(key: string, message: string): void {
    const now = Date.now();
    if (now < (this.warned.get(key) ?? 0)) return;
    this.warned.set(key, now + WARN_QUIET_MS);
    console.warn(`[brain] ${message.slice(0, 200)}`);
  }

  /** A promise the stream doesn't wait for: kept until it settles (drain), its failure logged. */
  private track(p: Promise<unknown>, what: string): void {
    const q = p.catch((e: Error) => this.warn(what, `${what} failed: ${e.message}`));
    this.inflight.add(q);
    void q.finally(() => this.inflight.delete(q));
  }

  /**
   * One streamed swap, `now` = when the stream delivered it. Synchronous and cheap; never throws and never waits: the
   * decisions it starts run on their own (drain() waits for them).
   */
  onSwap(swap: ParsedSwap, now = this.now()): void {
    if (config.brainMode === "off") return;
    try {
      const kept = this.state.onSwap(swap, now);
      if (!kept || !kept.tracked) {
        // Not a tracked wallet's: its price moves a held coin's mark, but not the mark's age (the stale quote still comes).
        if (swap.priceSol > 0) {
          void this.book
            .onPrice(swap.mint, swap.priceSol, Date.parse(swap.ts) || now, swap.solAmount, { tracked: false, tokens: swap.tokenAmount, wallet: swap.wallet })
            .catch((e: Error) => this.warn("price", `paper price failed: ${e.message}`));
        }
        if (!kept) return;
      }
      // A tracked ok price marks the held coin; an analyzed wallet's sell asks the exit network at once.
      if (kept.tracked || kept.analyzed) this.track(this.book.onStreamSwap(kept), "paper stream swap");
      if (!kept.analyzed) return;
      if (kept.side === "sell") this.quotes.onLeaderSell(kept.wallet, kept.mint, kept.ts);
      else this.signal(kept, swap);
    } catch (e) {
      this.warn("swap", `stream swap failed: ${(e as Error).message}`);
    }
  }

  /** An analyzed wallet's buy: its decision-time context, the shadow quotes' sample, then the paper book. */
  private signal(kept: StreamSwap, swap: ParsedSwap): void {
    const key = signalKey(kept.signature, kept.wallet, kept.mint);
    const first = this.state.firstSeen(kept.mint);
    this.signals.set(key, { swap, t: kept.at, first: first && { ...first }, holding: this.state.leaderHolding(kept.wallet, kept.mint) });
    if (this.signals.size > SIGNALS_MAX) this.signals.delete(this.signals.keys().next().value!);
    this.quotes.onCandidate({ leader: kept.wallet, mint: kept.mint, signature: kept.signature, priceSol: kept.price, solAmount: kept.sol, t: kept.ts, venue: kept.venue });
    const buy: LeaderBuy = {
      leader: kept.wallet, mint: kept.mint, symbol: null, solAmount: kept.sol, priceSol: kept.price, signature: kept.signature, t: kept.ts,
      venue: kept.venue, tokenAmount: kept.tokens, tokenBalanceBefore: kept.tokenBalanceBefore,
    };
    this.track(this.book.onLeaderBuy(buy).finally(() => this.signals.delete(key)), "paper buy");
  }

  /** The entry decision of one signal (PaperDeps.decideEntry): features, gates, routing, the ensemble, the policy. */
  async decideEntry(s: LeaderBuy): Promise<EntryDecisions | null> {
    const ctx = this.signals.get(signalKey(s.signature, s.leader, s.mint));
    const model = this.models.model;
    if (!ctx || !model) return null;
    // The DB reads below run off the stream's call stack: the swap that started this has returned.
    await new Promise<void>((r) => setImmediate(r));
    const m = model.manifest;
    const t0 = performance.now();
    const sig: EntrySignal = { wallet: s.leader, mint: s.mint, solAmount: ctx.swap.solAmount, priceSol: ctx.swap.priceSol, venue: ctx.swap.venue, feeLamports: ctx.swap.feeLamports, T: s.t };
    // At decision time t: the first sighting and the holding as they were when the stream delivered the buy.
    const src: EntrySources = { ...this.sources, firstSeen: () => ctx.first, leaderHolding: () => ctx.holding };
    const raw = entryRaw(sig, ctx.t, src);
    const gated = entryGate(sig, ctx.t, src);
    const features = entryVector(raw, m.entry.categories, m.entry.norm);
    const info: Record<string, unknown> = { gate: gated, decided_at: iso(ctx.t), feature_ms: Math.round((performance.now() - t0) * 100) / 100, raw: rawForLog(raw) };
    const policy = signalPolicy(m);
    const route = routeSignal(gated, policy, this.rng);
    if (route === "gated") return { brain: { stakeFrac: 0, q: null, features, modelVersion: m.version, info } };
    const qs = await model.entryQ(Float32Array.from(features));
    const d = decideSignal(route, qs, policy, this.rng);
    const out: EntryDecision = {
      stakeFrac: d.stakeFrac, q: d.q, features, modelVersion: m.version,
      info: {
        ...info, q_mean: d.mean, q_std: d.std, q_members: qs, margin_c: policy.marginC,
        ...(d.member !== undefined ? { member: d.member } : {}), ...(d.disabled ? { brain_enabled: false } : {}),
      },
    };
    return route === "explore" ? { explore: out } : { brain: out };
  }

  /** The exit decision of one open Brain/Explore position (PaperDeps.decideExit); null without a model (hold). */
  async decideExit(pos: PaperPosition, st: ExitState): Promise<ExitDecision | null> {
    const model = this.models.model;
    if (!model) return null;
    const t = this.now();
    const flow = this.state.flow(pos.mint, t, { exclude: pos.leader, knownBefore: t });
    const raw = exitRaw({
      ret_now: st.ret_now, peak_ret: st.peak_ret, minutes_held: st.minutes_held, leader_sold: st.leader_sold, half_sold: st.half_sold,
      minutes_since_price: st.minutes_since_price, quote_failed: st.quote_failed, mins_since_tracked_price: st.mins_since_tracked_price,
      sell_quote_ratio: st.sell_quote_ratio, ret_5m_ago: st.ret_5m_ago, leader_sold_frac: st.leader_sold_frac, minutes_since_leader_sold: st.minutes_since_leader_sold,
      tokens: pos.tokens, tokens_left: pos.tokens_left, venue: pos.venue,
      flow: { oth_buyers_5m: flow.buyers, oth_sellers_5m: flow.sellers, oth_net_sol_5m: flow.netSol, pts_5m: flow.okSwaps },
      active_wallets_1h: this.state.activeWallets1h(t),
      leader_ps_r_7d: this.entryPsR(pos.id),
    });
    const features = exitVector(raw, model.manifest.exit.norm);
    const q = await model.exitQ(Float32Array.from(features));
    return { action: pickExit(q, st.half_sold), q, features, modelVersion: model.manifest.version };
  }

  /** The position's ps_r_7d as its entry decision saw it (the entry transition's info.raw), carried to the exit head. */
  private entryPsR(positionId: number): number | null {
    if (this.psCache.has(positionId)) return this.psCache.get(positionId)!;
    const row = this.db.prepare("SELECT info FROM brain_transitions WHERE position_id = ? AND kind = 'entry' ORDER BY id LIMIT 1").get(positionId) as
      | { info: string | null }
      | undefined;
    if (!row) return null;
    let v: number | null = null;
    try {
      const r = (JSON.parse(row.info ?? "{}") as { raw?: { ps_r_7d?: unknown } }).raw?.ps_r_7d;
      v = typeof r === "number" && Number.isFinite(r) ? r : null;
    } catch {
      /* unreadable info: missing */
    }
    if (this.psCache.size >= PS_CACHE_MAX) this.psCache.clear();
    this.psCache.set(positionId, v);
    return v;
  }

  /** The live social model's version (<BRAIN_DIR>/social/current/manifest.json), read again every few minutes. */
  socialModelVersion(): string | null {
    const now = this.now();
    if (!this.social || now - this.social.at > SOCIAL_TTL_MS) {
      let version: string | null = null;
      try {
        const dir = fs.realpathSync(path.join(socialRoot(this.opts.dir), "current"));
        const v = (JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")) as { version?: unknown }).version;
        version = typeof v === "string" && v ? v : null;
      } catch {
        /* no social model */
      }
      this.social = { version, at: now };
    }
    return this.social.version;
  }

  /** Once a minute: pick up a newly pushed model, then manage the open paper positions. Not gated by the real pause. */
  async tick(now = this.now()): Promise<void> {
    if (config.brainMode === "off") return;
    await this.models.check(now); // logs what it loads or rejects
    await this.book.tick(now);
  }

  /** Once a minute: the stream state's windows, bounds and creator lookups, then the ledgers' deadlines and delayed jobs. */
  async tickLedgers(now = this.now()): Promise<void> {
    if (config.brainMode === "off") return;
    this.state.tick(now);
    await this.ledger.tick(now);
  }

  /** Daily: shadow quotes older than 30 days go (pulled to the Mac long before). */
  prune(now = this.now()): void {
    this.quotes.prune(30, now);
  }

  /** The shadow-quote sampler. */
  start(): void {
    if (config.brainMode !== "off") this.quotes.start();
  }

  /** Waits for every decision and stream hook started so far (tests, shutdown). */
  async drain(): Promise<void> {
    while (this.inflight.size) await Promise.allSettled([...this.inflight]);
  }

  async close(): Promise<void> {
    this.quotes.stop();
    await this.models.close();
  }
}
