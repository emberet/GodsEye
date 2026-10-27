/**
 * COPYABILITY GATE (log-only) — could THIS buy be copied at a fair price, right now, at our size?
 *
 * A wallet being good doesn't make a trade copyable. For every candidate buy this asks Jupiter for two quotes at the size
 * GodsEye would use — buy, then sell the tokens that buy would return — and records
 *   • price impact (what Jupiter reports; a fraction, so 0.03 is 3%, and 1 is a drained pool);
 *   • entry drift: our quoted price against the price the leader paid;
 *   • round trip: how much of the money a buy-then-sell at this size would lose, quoted now (both fees, both impacts);
 *   • fees: the worst-case network and priority fee as a share of the trade;
 * and what each limit in settings.ts would have decided. A missing quote counts as "would block": an unavailable check is
 * never permission to trade.
 *
 * It decides nothing. The engine keeps buying exactly as before; the result is stored with the decision (copy_decisions.gate)
 * so the limits can be calibrated against how those tokens actually did (the shadow log) before any of them is switched on.
 */
import { LAMPORTS_PER_SOL, SOL_MINT } from "@godseye/shared";
import { config } from "../config";
import { jupiterQuote } from "../market/jupiter";
import { tokenDecimals } from "../market/decimals";
import { exitCapacity, readPools, type PoolView } from "../pools/state";
import { auditSettings, type AuditSettings } from "./settings";

export type GateCheckName = "buy_quote" | "price_impact" | "entry_drift" | "sell_quote" | "round_trip" | "exit_capacity" | "fees";

export interface GateCheck {
  check: GateCheckName;
  result: "pass" | "fail" | "na";
  value: number | null;
  limit: number | null;
  detail?: string;
}

export interface GateLimits {
  /** Exit capacity (SOL sellable before the price falls exitDropPct) must be at least this many times the trade. */
  minExitMultiple: number;
  exitDropPct: number;
  maxImpactPct: number;
  maxDriftPct: number;
  maxRoundTripLossPct: number;
  maxFeePct: number;
}

export interface GateResult {
  status: "ok" | "incomplete";
  sizeSol: number;
  /** Seconds from the leader's swap to the quotes. */
  ageSec: number | null;
  /** How long the quotes took, ms. */
  ms: number;
  route: string | null;
  tokensOut: number | null;
  quotePriceSol: number | null;
  leaderPriceSol: number;
  driftPct: number | null;
  /** As Jupiter reports it, in percent (1 = 1%). */
  priceImpactPct: number | null;
  sellOutSol: number | null;
  /** SOL lost by buying `sizeSol` and selling it back at once, in percent of the size. */
  roundTripLossPct: number | null;
  feePct: number;
  /** The pools the buy went through, read from chain: reserves and how much could be sold into them. */
  pools: GatePool[];
  /** SOL sellable into the SOL-quoted pools of the route before the price falls limits.exitDropPct (null = none could be read). */
  exitCapacitySol: number | null;
  checks: GateCheck[];
  wouldBlock: boolean;
  wouldBlockReasons: string[];
  limits: GateLimits;
  /** Why a quote is missing, if one is. */
  error?: string;
}

/** One pool of the route, as read from chain (or why it couldn't be). */
export interface GatePool {
  label: string | null;
  address: string;
  family: string | null;
  /** SOL held / the SOL a seller can put in before the price falls exitDropPct. */
  quoteReserveSol: number | null;
  exitCapacitySol: number | null;
  closed: boolean | null;
  note?: string;
}

/** The pieces of a Jupiter quote used here. */
export interface QuoteLike {
  inAmount: string;
  outAmount: string;
  priceImpactPct?: string | null;
  routePlan?: { swapInfo?: { label?: string; ammKey?: string; inputMint?: string; outputMint?: string } }[];
}

export interface GateInput {
  sizeSol: number;
  leaderPriceSol: number;
  ageSec: number | null;
  ms: number;
  decimals: number | null;
  buy: QuoteLike | null;
  sell: QuoteLike | null;
  /** The route's pools as read from chain; undefined = not read. */
  pools?: GatePool[];
  buyError?: string;
  sellError?: string;
  /** Worst-case network + priority fee for one swap, SOL. */
  feeSol: number;
}

export const limitsFrom = (
  s: Pick<AuditSettings, "gateMaxImpactPct" | "gateMaxDriftPct" | "gateMaxRoundTripLossPct" | "gateMaxFeePct"> & Partial<Pick<AuditSettings, "gateMinExitMultiple" | "gateExitDropPct">> = auditSettings,
): GateLimits => ({
  minExitMultiple: s.gateMinExitMultiple ?? 3,
  exitDropPct: s.gateExitDropPct ?? 20,
  maxImpactPct: s.gateMaxImpactPct,
  maxDriftPct: s.gateMaxDriftPct,
  maxRoundTripLossPct: s.gateMaxRoundTripLossPct,
  maxFeePct: s.gateMaxFeePct,
});

const finite = (x: number): number | null => (Number.isFinite(x) ? x : null);

/** Pure: quotes in, what each limit would have decided out. */
export function judgeGate(i: GateInput, limits: GateLimits = limitsFrom()): GateResult {
  const checks: GateCheck[] = [];
  const reasons: string[] = [];
  const fail = (c: GateCheck, why: string) => {
    checks.push(c);
    if (c.result === "fail") reasons.push(why);
  };

  const tokensOut = i.buy && i.decimals !== null ? Number(i.buy.outAmount) / 10 ** i.decimals : null;
  const inSol = i.buy ? Number(i.buy.inAmount) / LAMPORTS_PER_SOL : null;
  const quotePrice = tokensOut && inSol && tokensOut > 0 ? inSol / tokensOut : null;

  // 1) a buy quote at all
  if (!i.buy || !quotePrice) fail({ check: "buy_quote", result: "fail", value: null, limit: null, detail: i.buyError ?? (i.buy ? "quote returns no tokens" : "no quote") }, "no buy quote");
  else checks.push({ check: "buy_quote", result: "pass", value: quotePrice, limit: null });

  // 2) price impact
  const impactRaw = i.buy?.priceImpactPct === undefined || i.buy?.priceImpactPct === null ? NaN : Number(i.buy.priceImpactPct) * 100;
  const impact = finite(impactRaw);
  if (!i.buy) checks.push({ check: "price_impact", result: "na", value: null, limit: limits.maxImpactPct });
  else if (impact === null) fail({ check: "price_impact", result: "fail", value: null, limit: limits.maxImpactPct, detail: "quote reports no price impact" }, "price impact unknown");
  else fail({ check: "price_impact", result: impact > limits.maxImpactPct ? "fail" : "pass", value: impact, limit: limits.maxImpactPct }, `price impact ${impact.toFixed(2)}% (limit ${limits.maxImpactPct}%)`);

  // 3) drift from the price the leader paid
  const drift = quotePrice && i.leaderPriceSol > 0 ? (quotePrice / i.leaderPriceSol - 1) * 100 : null;
  if (drift === null) checks.push({ check: "entry_drift", result: "na", value: null, limit: limits.maxDriftPct });
  else fail({ check: "entry_drift", result: drift > limits.maxDriftPct ? "fail" : "pass", value: drift, limit: limits.maxDriftPct }, `price already ${drift.toFixed(1)}% above the leader's (limit ${limits.maxDriftPct}%)`);

  // 4) a sell quote for what the buy would return, and the round trip
  const sellOut = i.sell ? Number(i.sell.outAmount) / LAMPORTS_PER_SOL : null;
  if (!i.buy) checks.push({ check: "sell_quote", result: "na", value: null, limit: null });
  else if (!i.sell || sellOut === null) fail({ check: "sell_quote", result: "fail", value: null, limit: null, detail: i.sellError ?? "no quote" }, "no way to sell it back (no sell quote)");
  else checks.push({ check: "sell_quote", result: "pass", value: sellOut, limit: null });
  const roundTrip = sellOut !== null && inSol ? (1 - sellOut / inSol) * 100 : null;
  if (roundTrip === null) checks.push({ check: "round_trip", result: "na", value: null, limit: limits.maxRoundTripLossPct });
  else fail({ check: "round_trip", result: roundTrip > limits.maxRoundTripLossPct ? "fail" : "pass", value: roundTrip, limit: limits.maxRoundTripLossPct }, `a buy then sell at this size loses ${roundTrip.toFixed(1)}% (limit ${limits.maxRoundTripLossPct}%)`);

  // 5) can the pools the buy went through take our position back? (read from chain; venues whose depth isn't readable add nothing)
  const readable = (i.pools ?? []).filter((p) => p.exitCapacitySol !== null);
  const capacity = readable.length ? readable.reduce((s, p) => s + (p.exitCapacitySol as number), 0) : null;
  if (capacity === null) checks.push({ check: "exit_capacity", result: "na", value: null, limit: limits.minExitMultiple, detail: i.pools ? "no pool of the route is one whose depth can be read" : "pools not read" });
  else {
    const multiple = i.sizeSol > 0 ? capacity / i.sizeSol : Infinity;
    fail(
      { check: "exit_capacity", result: multiple < limits.minExitMultiple ? "fail" : "pass", value: finite(multiple), limit: limits.minExitMultiple, detail: `${capacity.toFixed(3)} SOL can be sold in before the price falls ${limits.exitDropPct}%` },
      `the pool can take only ${multiple.toFixed(1)}× the position back before a ${limits.exitDropPct}% fall (needs ${limits.minExitMultiple}×)`,
    );
  }

  // 6) fees against the size
  const feePct = i.sizeSol > 0 ? (i.feeSol / i.sizeSol) * 100 : Infinity;
  fail({ check: "fees", result: feePct > limits.maxFeePct ? "fail" : "pass", value: finite(feePct), limit: limits.maxFeePct }, `fees up to ${feePct.toFixed(1)}% of the trade (limit ${limits.maxFeePct}%)`);

  const route = i.buy?.routePlan?.map((r) => r.swapInfo?.label).filter(Boolean).join(" → ") || null;
  return {
    status: i.buy && i.sell ? "ok" : "incomplete",
    sizeSol: i.sizeSol,
    ageSec: i.ageSec,
    ms: i.ms,
    route,
    tokensOut,
    quotePriceSol: quotePrice,
    leaderPriceSol: i.leaderPriceSol,
    driftPct: drift,
    priceImpactPct: impact,
    sellOutSol: sellOut,
    roundTripLossPct: roundTrip,
    feePct: finite(feePct) ?? -1,
    pools: i.pools ?? [],
    exitCapacitySol: capacity,
    checks,
    wouldBlock: reasons.length > 0,
    wouldBlockReasons: reasons,
    limits,
    ...(i.buyError || i.sellError ? { error: i.buyError ?? i.sellError } : {}),
  };
}

export interface GateDeps {
  quote(inputMint: string, outputMint: string, amountAtomic: bigint): Promise<QuoteLike>;
  decimals(mint: string): Promise<number | undefined>;
  /** Pool state from chain (pools/state.ts). Optional: without it the exit-capacity check is not made. */
  pools?(addresses: string[]): Promise<(PoolView | { address: string; unreadable: string })[]>;
}

export const liveGateDeps: GateDeps = {
  // No retry: a busy API is waited out by the gate itself, not hammered.
  quote: (inputMint, outputMint, amount) => jupiterQuote(inputMint, outputMint, amount, config.slippageBps, 0),
  decimals: tokenDecimals,
  pools: (addresses) => readPools(addresses),
};

export type GateRun = GateResult | { skipped: "throttled" | "queue_full" | "disabled" | "rate_limited" };

export interface GateRequest {
  mint: string;
  sizeSol: number;
  leaderPriceSol: number;
  leaderTs: string;
}

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });

export class CopyabilityGate {
  private active = 0;
  private waiting: (() => void)[] = [];
  private lastRun = new Map<string, number>();
  private lastQuoteAt = 0;
  private pausedUntil = 0;

  constructor(
    private deps: GateDeps = liveGateDeps,
    private s: AuditSettings = auditSettings,
  ) {}

  /** Quotes one candidate. Never throws; returns a skip marker when throttled or when too many are waiting. */
  async run(req: GateRequest, now = Date.now()): Promise<GateRun> {
    if (!this.s.gateEnabled) return { skipped: "disabled" };
    if (now < this.pausedUntil) return { skipped: "rate_limited" };
    const last = this.lastRun.get(req.mint);
    if (last !== undefined && now - last < this.s.gateMinGapSeconds * 1000) return { skipped: "throttled" };
    if (this.active >= this.s.gateConcurrency && this.waiting.length >= this.s.gateMaxQueue) return { skipped: "queue_full" };
    this.lastRun.set(req.mint, now);
    if (this.lastRun.size > 5000) for (const [m, t] of this.lastRun) if (now - t > this.s.gateMinGapSeconds * 1000) this.lastRun.delete(m);
    const release = await this.slot();
    try {
      return await this.quoteAndJudge(req);
    } finally {
      release();
    }
  }

  private slot(): Promise<() => void> {
    const release = () => {
      this.active--;
      this.waiting.shift()?.();
    };
    if (this.active < this.s.gateConcurrency) {
      this.active++;
      return Promise.resolve(release);
    }
    return new Promise((resolve) =>
      this.waiting.push(() => {
        this.active++;
        resolve(release);
      }),
    );
  }

  /** One quote, spaced from the last, and the gate stands down for a while if Jupiter says it is being asked too much. */
  private async quoted<T>(fn: () => Promise<T>): Promise<T> {
    const wait = this.lastQuoteAt + this.s.gateMinSpacingMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastQuoteAt = Date.now();
    try {
      return await withTimeout(fn(), this.s.gateTimeoutMs);
    } catch (e) {
      if (/\b429\b|too many requests|rate.?limit/i.test((e as Error).message)) this.pausedUntil = Date.now() + this.s.gateRateLimitPauseSeconds * 1000;
      throw e;
    }
  }

  private async quoteAndJudge(req: GateRequest): Promise<GateResult> {
    const t0 = Date.now();
    const limits = limitsFrom(this.s);
    const feeSol = (config.priorityFeeMaxLamports + 5_000) / LAMPORTS_PER_SOL;
    let decimals: number | null = null;
    let buy: QuoteLike | null = null;
    let sell: QuoteLike | null = null;
    let buyError: string | undefined;
    let sellError: string | undefined;
    try {
      decimals = (await withTimeout(this.deps.decimals(req.mint), this.s.gateTimeoutMs)) ?? null;
      if (decimals === null) buyError = "token decimals unknown";
    } catch (e) {
      buyError = `decimals: ${(e as Error).message.slice(0, 120)}`;
    }
    if (decimals !== null) {
      try {
        buy = await this.quoted(() => this.deps.quote(SOL_MINT, req.mint, BigInt(Math.floor(req.sizeSol * LAMPORTS_PER_SOL))));
      } catch (e) {
        buyError = (e as Error).message.slice(0, 160);
      }
    }
    if (buy && Number(buy.outAmount) > 0) {
      try {
        sell = await this.quoted(() => this.deps.quote(req.mint, SOL_MINT, BigInt(buy!.outAmount)));
      } catch (e) {
        sellError = (e as Error).message.slice(0, 160);
      }
    }
    const pools = buy ? await this.readRoutePools(buy, req.mint, limits.exitDropPct) : undefined;
    return judgeGate(
      { sizeSol: req.sizeSol, leaderPriceSol: req.leaderPriceSol, ageSec: (Date.now() - Date.parse(req.leaderTs)) / 1000, ms: Date.now() - t0, decimals, buy, sell, pools, buyError, sellError, feeSol },
      limits,
    );
  }

  /** The pools that hold the token on this route, read from chain. Never throws; a failed read leaves the capacity unknown. */
  private async readRoutePools(buy: QuoteLike, mint: string, dropPct: number): Promise<GatePool[] | undefined> {
    if (!this.deps.pools) return undefined;
    const hops = (buy.routePlan ?? []).map((h) => h.swapInfo).filter((h): h is NonNullable<typeof h> => !!h?.ammKey && h.outputMint === mint);
    if (!hops.length) return [];
    try {
      const views = await withTimeout(this.deps.pools([...new Set(hops.map((h) => h.ammKey as string))]), this.s.gateTimeoutMs);
      const byAddr = new Map(views.map((v) => [v.address, v]));
      return hops.map((h) => {
        const v = byAddr.get(h.ammKey as string);
        if (!v) return { label: h.label ?? null, address: h.ammKey as string, family: null, quoteReserveSol: null, exitCapacitySol: null, closed: null, note: "not read" };
        if ("unreadable" in v) return { label: h.label ?? null, address: v.address, family: null, quoteReserveSol: null, exitCapacitySol: null, closed: null, note: v.unreadable };
        return {
          label: h.label ?? null, address: v.address, family: v.family, quoteReserveSol: v.quoteIsSol ? v.quoteReserve : null, exitCapacitySol: exitCapacity(v, dropPct), closed: v.closed,
          ...(v.quoteIsSol ? {} : { note: "not priced in SOL" }),
        };
      });
    } catch (e) {
      return [{ label: null, address: "", family: null, quoteReserveSol: null, exitCapacitySol: null, closed: null, note: `pool read failed: ${(e as Error).message.slice(0, 100)}` }];
    }
  }
}
