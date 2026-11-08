/**
 * BRAIN POLICY — the pure decision rules on top of the networks' outputs (brain/spec/CONTRACT.md). No I/O, no model:
 * the caller runs the nets (brain/model.ts) and passes the q values in, so every rule here is testable with plain arrays.
 *
 *   normalise     raw feature values → (v − mean) ÷ std, a missing or non-finite value → 0 (its training mean)
 *   routeSignal   hard gates first: a gated signal goes to neither account; else Explore with probability explore.rate,
 *                 else Brain
 *   decideEntry   Brain account: score = mean q − margin_c × std q over the ensemble, per action; the best stake (non-zero
 *                 action) by score, copied only when its score is > 0, else skip. A larger stake wins a tie only by being
 *                 strictly higher.
 *   decideExplore Explore account (Thompson sampling): one member picked by the rng decides, with curiosity × the
 *                 members' disagreement (std) added to every stake, so unfamiliar states get tried.
 *   decideSignal  the routed account's decision; with brain_enabled false the Brain account skips every signal
 *   decideExit    hold / sell_half (once) / sell_all from the exit net, under hard stops that always win:
 *                 the stop-loss (BRAIN_HARD_STOP_PCT) and the maximum hold (BRAIN_MAX_HOLD_HOURS). pickExit is the
 *                 network's part alone, for a caller that applies the stops itself (paper.ts, which confirms a stop with a
 *                 sell quote first).
 * Paper money only: nothing here places a trade. The stake is a fraction of the real per-trade size, never above 1.
 */
import { config } from "../config";

/** A source of uniform numbers in [0, 1): Math.random in the agent, a seeded one in tests. */
export type Rng = () => number;

/** The normalisation stored per net in the manifest. */
export interface Norm {
  mean: number[];
  std: number[];
}

export interface EntryDecision {
  /** Stake as a fraction of the real per-trade size (copySize): 0 = skip, never above 1. */
  stakeFrac: number;
  /** Index of the chosen action in the manifest's entry.actions (the skip action, 0, when skipping). */
  action: number;
  /** The scores that decided, per action: mean − margin_c × std (Brain), or one member's q plus the curiosity bonus (Explore). */
  q: number[];
  /** Mean and (population) standard deviation of q over the members, per action. */
  mean: number[];
  std: number[];
  explore: boolean;
  /** The member that decided an Explore entry. */
  member?: number;
  /** The Brain account skipped because the bundle has brain_enabled: false (exploration only). */
  disabled?: boolean;
}

export type ExitAction = "hold" | "sell_half" | "sell_all";

export interface ExitDecision {
  action: ExitAction;
  /** network = the exit net decided; stop_loss / max_hold = a hard stop overrode it. */
  reason: "network" | "stop_loss" | "max_hold";
  /** The exit net's q per action (hold, sell_half, sell_all), null when no net was run. */
  q: number[] | null;
}

/** An open Brain/Explore paper position, as the exit rule sees it. */
export interface ExitState {
  /** Return so far as a fraction of what went in: −0.6 = down 60%. */
  ret: number;
  heldMs: number;
  /** sell_half was already taken: it is allowed once. */
  soldHalf: boolean;
}

export interface HardStops {
  /** Sell everything at this loss, in percent (60 = −60%). */
  stopPct: number;
  maxHoldHours: number;
}

export const hardStops = (): HardStops => ({ stopPct: config.brainHardStopPct, maxHoldHours: config.brainMaxHoldHours });

export const EXIT_ACTIONS: readonly ExitAction[] = ["hold", "sell_half", "sell_all"];

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * Normalised float32 features in the manifest's order. `raw` is either an array in that order or a record by name;
 * a missing, null, NaN or infinite value becomes 0, i.e. the feature's training mean.
 */
export function normalise(
  raw: ArrayLike<number | null | undefined> | Record<string, number | null | undefined>,
  features: readonly string[],
  norm: Norm,
): Float32Array {
  const isArray = Array.isArray(raw) || ArrayBuffer.isView(raw);
  if (isArray && (raw as ArrayLike<unknown>).length !== features.length) {
    throw new Error(`expected ${features.length} feature values, got ${(raw as ArrayLike<unknown>).length}`);
  }
  const out = new Float32Array(features.length);
  for (let i = 0; i < features.length; i++) {
    const v = isArray ? (raw as ArrayLike<number | null | undefined>)[i] : (raw as Record<string, number | null | undefined>)[features[i]];
    const sd = norm.std[i];
    out[i] = finite(v) && finite(sd) && sd > 0 ? (v - norm.mean[i]) / sd : 0;
  }
  return out;
}

/** Per-action mean and population std of q over the ensemble members. A non-finite q counts as −∞ (never chosen). */
export function ensembleStats(qs: readonly (readonly number[])[]): { mean: number[]; std: number[] } {
  if (!qs.length) throw new Error("no ensemble members");
  const n = qs[0].length;
  const mean = new Array<number>(n).fill(0);
  const std = new Array<number>(n).fill(0);
  for (let a = 0; a < n; a++) {
    const xs = qs.map((q) => (finite(q[a]) ? q[a] : -Infinity));
    if (xs.some((x) => x === -Infinity)) {
      mean[a] = -Infinity;
      continue;
    }
    const m = xs.reduce((s, x) => s + x, 0) / xs.length;
    mean[a] = m;
    std[a] = Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / xs.length);
  }
  return { mean, std };
}

/**
 * The entry rule on one score vector (CONTRACT.md): the best stake, i.e. non-zero action, by score (a larger one needs a
 * strictly higher score), taken only when its score is above 0; otherwise skip. Returns the action index.
 */
export function pickStake(scores: readonly number[], actions: readonly number[]): number {
  let best = -1;
  for (let a = 0; a < actions.length; a++) {
    if (actions[a] <= 0 || !finite(scores[a])) continue;
    if (best < 0 || scores[a] > scores[best]) best = a;
  }
  if (best < 0 || scores[best] <= 0) return actions.findIndex((s) => s <= 0);
  return best;
}

function entry(scores: number[], actions: readonly number[], stats: { mean: number[]; std: number[] }, explore: boolean, member?: number): EntryDecision {
  const a = pickStake(scores, actions);
  const d: EntryDecision = { stakeFrac: a < 0 ? 0 : Math.min(1, Math.max(0, actions[a])), action: a, q: scores, mean: stats.mean, std: stats.std, explore };
  if (member !== undefined) d.member = member;
  return d;
}

/**
 * Brain account: score = the ensemble's mean q − marginC × its std, per action (the members' disagreement costs a stake).
 * `qs` is one q vector per member, in `actions` order.
 */
export function decideEntry(qs: readonly (readonly number[])[], actions: readonly number[], marginC = 0): EntryDecision {
  const stats = ensembleStats(qs);
  const c = finite(marginC) && marginC > 0 ? marginC : 0;
  return entry(stats.mean.map((m, a) => m - c * stats.std[a]), actions, stats, false);
}

/**
 * Explore account (Thompson sampling): the member the rng picks decides, with `curiosity × std` across members added
 * to every non-skip action, so the states the members disagree on get tried.
 */
export function decideExplore(qs: readonly (readonly number[])[], actions: readonly number[], curiosity: number, rng: Rng): EntryDecision {
  const stats = ensembleStats(qs);
  const member = Math.min(qs.length - 1, Math.max(0, Math.floor(rng() * qs.length)));
  const c = finite(curiosity) && curiosity > 0 ? curiosity : 0;
  const scores = qs[member].map((q, a) => (!finite(q) ? -Infinity : actions[a] > 0 ? q + c * stats.std[a] : q));
  return entry(scores, actions, stats, true, member);
}

/** Whether this signal goes to the Explore account: with probability `rate` (explore.rate in the manifest). */
export function routeToExplore(rate: number, rng: Rng): boolean {
  return finite(rate) && rate > 0 && rng() < rate;
}

/** What the manifest says about entries (model.ts BrainManifest). */
export interface SignalPolicy {
  actions: readonly number[];
  marginC: number;
  brainEnabled: boolean;
  exploreRate: number;
  curiosity: number;
}

export type Route = "gated" | "brain" | "explore";

/**
 * Hard gates first: a gated signal goes to neither account (the network isn't asked). Otherwise Explore with probability
 * explore.rate, else Brain. The rng is drawn only for a signal that passed the gates.
 */
export function routeSignal(gateName: string | null, p: Pick<SignalPolicy, "exploreRate">, rng: Rng): Route {
  if (gateName) return "gated";
  return routeToExplore(p.exploreRate, rng) ? "explore" : "brain";
}

/**
 * The routed account's decision on the members' q. Explore: Thompson sampling with the curiosity bonus. Brain: the margin
 * rule, or, with brain_enabled false, a skip (the bundle is for exploration only; its scores are kept for the log).
 */
export function decideSignal(route: "brain" | "explore", qs: readonly (readonly number[])[], p: SignalPolicy, rng: Rng): EntryDecision {
  if (route === "explore") return decideExplore(qs, p.actions, p.curiosity, rng);
  const d = decideEntry(qs, p.actions, p.marginC);
  if (p.brainEnabled) return d;
  const skip = p.actions.findIndex((s) => s <= 0);
  return { ...d, stakeFrac: 0, action: skip, disabled: true };
}

/**
 * The exit rule for one open position. Hard stops first (they hold even with no model: pass q = null), then the exit
 * net's argmax with sell_half masked once it was taken. Ties go to the earlier action (hold, then sell_half).
 */
export function decideExit(q: readonly number[] | null, state: ExitState, stops: HardStops = hardStops()): ExitDecision {
  const qOut = q ? [...q] : null;
  if (finite(state.ret) && state.ret <= -stops.stopPct / 100) return { action: "sell_all", reason: "stop_loss", q: qOut };
  if (state.heldMs >= stops.maxHoldHours * 3_600_000) return { action: "sell_all", reason: "max_hold", q: qOut };
  if (!q) return { action: "hold", reason: "network", q: qOut };
  return { action: pickExit(q, state.soldHalf), reason: "network", q: qOut };
}

/** The exit net's argmax, sell_half masked once taken; ties go to the earlier action (hold, then sell_half). No stops. */
export function pickExit(q: readonly number[], soldHalf: boolean): ExitAction {
  let best = 0;
  let bestQ = -Infinity;
  for (let a = 0; a < EXIT_ACTIONS.length; a++) {
    if (EXIT_ACTIONS[a] === "sell_half" && soldHalf) continue;
    const v = finite(q[a]) ? q[a] : -Infinity;
    if (v > bestQ) {
      best = a;
      bestQ = v;
    }
  }
  return EXIT_ACTIONS[best];
}

/** A small seeded rng (mulberry32), for tests and reproducible replays. */
export function seededRng(seed: number): Rng {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}
