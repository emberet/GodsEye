/**
 * THE BRAIN SLEEVE — real copies the Brain decides, once a model has earned it.
 *
 * Licence: the loaded model's manifest says `real_test: true` (the Mac's gate passed its real-test check: every sanity
 * and safety check, scored on the server's real-money rails; brain/brain/gate.py) and `brain_enabled`. Without one the
 * sleeve is off and the rules copy everything. REAL_DECIDER: auto (default) and split share the signals; brain gives the
 * sleeve every signal; rules switches it off. It turns on by itself when a licensed model loads, and says so.
 *
 *   - Each leader signal goes to the rules or to the sleeve by a hash of its signature, so the two are compared on the
 *     same kind of signals and never fight over one coin (the engine leaves the sleeve's signals alone).
 *   - First version: only wallets the rules already copy (a weight above 0), like the rules.
 *   - Real follows the paper twin: a real Brain buy starts when the paper Brain account takes the signal (before the
 *     paper copy delay, which only simulates GodsEye's lag), staked at the same fraction of the per-trade size; it sells
 *     what its twin sells, when its twin sells. Every engine check applies (CopyEngine.brainBuy): the governor's limits,
 *     the rug screen, the checks before signing; the engine's hard stops sit on top. If the Brain goes quiet (the twin is
 *     gone, or the licence ends), the position falls back to the rules' exits.
 *   - A decision later than BRAIN_SLEEVE_MAX_DELAY_SECONDS after the leader's trade is no trade.
 *   - Who decided is on every row (positions.decider, copy_trades.decider); the rules' own learning ignores Brain trades.
 *   - The sleeve's share starts at 50% and moves 10 points at a time, within 20–80%, only after MIN_CLOSED closed trades
 *     on both sides since the last move: towards the side whose closed trades made more per SOL staked.
 * State: one agent_meta row (brain_sleeve). Nothing it says names a wallet beyond the engine's usual short form.
 */
import { createHash } from "node:crypto";
import { type DB, getMeta, nowIso, setMeta } from "@godseye/shared";
import type { ParsedSwap } from "../chain/parse";
import type { CopyEngine, EngineSleeve } from "../copy/engine";
import type { PositionRow } from "../copy/fills";
import { say } from "../log";
import type { LeaderBuy, PaperSleeve } from "./paper";

export type RealDecider = "auto" | "rules" | "split" | "brain";

const STATE_KEY = "brain_sleeve";
const START_SHARE = 0.5;
const SHARE_STEP = 0.1;
const SHARE_MIN = 0.2;
const SHARE_MAX = 0.8;
/** Closed trades needed on each side, since the last move, before the share moves. */
export const MIN_CLOSED = 20;
/** A Brain position whose twin hasn't linked yet is still the Brain's this long (the twin fills after the copy delay). */
const LINK_GRACE_MS = 10 * 60_000;

interface SleeveState {
  share: number;
  /** Closed trades are counted from here (the last move). */
  since: string;
  /** The licensed model the sleeve last ran, or null while it was off (to say when it turns on or off). */
  model: string | null;
}

/** Where a signal goes, from its signature alone: a number in [0, 1). */
export function signalHash(signature: string): number {
  return createHash("sha256").update(signature).digest().readUInt32BE(0) / 2 ** 32;
}

/** The leader's buy as the engine reads a swap. */
function asSwap(s: LeaderBuy): ParsedSwap {
  return {
    wallet: s.leader, signature: s.signature, slot: 0, ts: new Date(s.t).toISOString(), mint: s.mint, side: "buy",
    tokenAmount: s.tokenAmount ?? 0, tokenBalanceBefore: s.tokenBalanceBefore ?? 0, solAmount: s.solAmount, priceSol: s.priceSol,
    venue: s.venue ?? "unknown", jitoTip: false, feeLamports: 0, quote: "SOL", quoteAmount: s.solAmount, solUsd: null, usdAmount: null,
  } as ParsedSwap;
}

export interface SleeveDeps {
  /** The model the sleeve may follow now: the loaded one when it is licensed (real_test and brain_enabled), else null. */
  licensed(): { version: string } | null;
  decider: RealDecider;
  maxDelaySeconds: number;
  now?: () => number;
}

export class BrainSleeve implements EngineSleeve, PaperSleeve {
  /** Paper twins that opened before their real buy landed: leader signature -> paper position id. */
  private links = new Map<string, number>();
  private inflight = new Set<Promise<unknown>>();
  private now: () => number;

  constructor(
    private db: DB,
    private engine: Pick<CopyEngine, "brainBuy" | "brainSell">,
    private deps: SleeveDeps,
  ) {
    this.now = deps.now ?? Date.now;
  }

  private state(): SleeveState {
    try {
      const v = JSON.parse(getMeta(this.db, STATE_KEY) || "null") as SleeveState | null;
      if (v && typeof v.share === "number") return v;
    } catch {
      // a broken row starts over
    }
    return { share: START_SHARE, since: new Date(this.now()).toISOString(), model: null };
  }

  /** The sleeve runs: not switched off, and a licensed model is loaded. */
  active(): boolean {
    return this.deps.decider !== "rules" && this.deps.licensed() !== null;
  }

  /** The share of signals the sleeve decides while it runs. */
  share(): number {
    return this.deps.decider === "brain" ? 1 : this.state().share;
  }

  takes(leaderSignature: string): boolean {
    return this.active() && signalHash(leaderSignature) < this.share();
  }

  entry(s: LeaderBuy, stakeFrac: number, modelVersion: string | null): void {
    if (!this.takes(s.signature) || !(stakeFrac > 0)) return;
    if ((this.now() - s.t) / 1000 > this.deps.maxDelaySeconds) return; // a slow decision: no trade
    const p = this.engine.brainBuy(asSwap(s), this.now(), stakeFrac, modelVersion ?? this.deps.licensed()?.version ?? null);
    this.inflight.add(p);
    void p.finally(() => this.inflight.delete(p));
  }

  opened(paperId: number, leaderSignature: string): void {
    if (!this.link(leaderSignature, paperId)) this.links.set(leaderSignature, paperId);
  }

  bought(leaderSignature: string): void {
    const paperId = this.links.get(leaderSignature);
    if (paperId !== undefined && this.link(leaderSignature, paperId)) this.links.delete(leaderSignature);
  }

  /** Ties the real Brain position bought on this signal to its paper twin; false while there is none yet. */
  private link(leaderSignature: string, paperId: number): boolean {
    const r = this.db
      .prepare(
        `UPDATE positions SET brain_paper_id = ? WHERE status = 'open' AND decider = 'brain' AND brain_paper_id IS NULL
           AND id = (SELECT position_id FROM copy_trades WHERE leader_signature = ? AND decider = 'brain' AND side = 'buy' AND position_id IS NOT NULL)`,
      )
      .run(paperId, leaderSignature);
    return r.changes > 0;
  }

  sold(paperId: number, fraction: number, closed: boolean, reason: string): void {
    const pos = this.db.prepare("SELECT id FROM positions WHERE status = 'open' AND decider = 'brain' AND brain_paper_id = ?").get(paperId) as { id: number } | undefined;
    if (!pos) return;
    const p = this.engine.brainSell(pos.id, closed ? 1 : Math.max(0, Math.min(1, fraction)), reason);
    this.inflight.add(p);
    void p.finally(() => this.inflight.delete(p));
  }

  follows(pos: PositionRow): boolean {
    if (!this.active()) return false;
    if (pos.brain_paper_id == null) return this.now() - Date.parse(pos.opened_at) < LINK_GRACE_MS;
    const twin = this.db.prepare("SELECT status FROM brain_paper_positions WHERE id = ?").get(pos.brain_paper_id) as { status: string } | undefined;
    return twin?.status === "open";
  }

  /** Every few minutes: says when the sleeve turns on or off, and moves the share once both sides have enough closed trades. */
  step(): void {
    const s = this.state();
    const model = this.active() ? (this.deps.licensed()?.version ?? null) : null;
    if (model !== s.model) {
      if (model && !s.model) say("info", `Brain sleeve on: model ${model} passed the real-money check. It decides ${Math.round(this.share() * 100)}% of real copies; the rules decide the rest.`);
      else if (!model) say("info", "Brain sleeve off: no licensed model is loaded. The rules decide every real copy; open Brain positions fall back to the rules' exits.");
      else say("info", `Brain sleeve now follows model ${model}.`);
      s.model = model;
    }
    if (this.deps.decider !== "brain" && model) {
      const side = (d: string) =>
        this.db
          .prepare("SELECT COUNT(*) n, COALESCE(SUM(pnl_sol), 0) p, COALESCE(SUM(cost_sol), 0) c FROM positions WHERE status = 'closed' AND decider = ? AND closed_at >= ?")
          .get(d, s.since) as { n: number; p: number; c: number };
      const b = side("brain");
      const r = side("rules");
      if (b.n >= MIN_CLOSED && r.n >= MIN_CLOSED && b.c > 0 && r.c > 0) {
        const rb = b.p / b.c;
        const rr = r.p / r.c;
        const next = Math.round(Math.min(SHARE_MAX, Math.max(SHARE_MIN, s.share + (rb > rr ? SHARE_STEP : rb < rr ? -SHARE_STEP : 0))) * 100) / 100;
        if (next !== s.share)
          say("info", `Brain sleeve share ${Math.round(s.share * 100)}% → ${Math.round(next * 100)}%: over the last ${b.n} Brain and ${r.n} rules trades, the ${rb > rr ? "Brain" : "rules"} made more per SOL staked (${(rb * 100).toFixed(1)}% vs ${(rr * 100).toFixed(1)}%).`);
        s.share = next;
        s.since = nowIso();
      }
    }
    setMeta(this.db, STATE_KEY, JSON.stringify(s));
  }

  /** Waits for the buys and sells under way (tests, shutdown). */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.inflight]);
  }
}
