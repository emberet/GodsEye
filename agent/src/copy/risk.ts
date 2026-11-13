/**
 * THE RISK GOVERNOR — in real mode the agent sets its own limits from what it holds, inside the owner's outer rails
 * (RISK_* in config.ts; "Aggressive", 2026-11-11: 10% a trade, a day's stop at 20% down, a self-pause at 50% down).
 *
 * It keeps score like a fund. What the agent holds is split into units: a deposit buys units and a withdrawal redeems
 * them at the value per unit (NAV) of that moment, so adding or taking out SOL never looks like a win or a loss. Every
 * minute (the positions job) the risk look:
 *   1. values the wallet: its SOL, open positions at no more than their cost (an open loss counts at once, an open gain
 *      only once it is sold, so one freak price can't lift the high), buys under way at their size, less SOL set aside.
 *      A move counts once two looks in a row show it;
 *   2. prices the flows the funding ledger found since the last look (funding/ledger.ts);
 *   3. checks the day's stop (20% down per unit since the day's first look: no new buys until the next UTC day) and the
 *      self-pause (50% below the highest NAV: paused until the owner runs `npm run resume`, which restarts the high);
 *   4. moves f, the share of the wallet a trade gets: 5% to start, never under 3% or over the 10% rail. Only after 30
 *      closed trades, and then every 10 more: half a point up when the last 30 made money, a point down when they lost.
 * A buy then gets (effectiveLimits): size = what the agent has to trade with × f, at least 0.05 SOL (a small wallet goes
 * up to the 10% rail to reach it); with under 0.5 SOL to trade with it doesn't buy. A wallet that can't be read is
 * unknown, not empty: no buys, and nothing else changes. Money the ledger hasn't recorded yet is never traded: the size
 * comes from the smaller of the last look and the wallet now. COPY_MAX_TRADE_SOL, COPY_BUDGET_SOL and
 * COPY_DAILY_LOSS_LIMIT_SOL stay on top as ceilings when they are written in .env; HARD_MAX_COPY_TRADE_SOL always does.
 * None of this ever holds back a sell.
 *
 * The state is one private agent_meta row (risk_state); the site gets a short public summary (risk_limits).
 */
import { type DB, getMeta, HARD_MAX_COPY_TRADE_SOL, nowIso, setMeta } from "@godseye/shared";
import type { Config } from "../config";
import { alert } from "../alerts";
import { say } from "../log";

/** An amount of SOL, unsigned. */
const amount = (n: number): string => `${n.toFixed(4)} SOL`;

export interface Rails {
  maxTradePct: number;
  startTradePct: number;
  minTradePct: number;
  dailyStopPct: number;
  drawdownPausePct: number;
  minTradeSol: number;
  minEquitySol: number;
}

export const railsOf = (c: Config): Rails => ({
  maxTradePct: c.riskMaxTradePct,
  startTradePct: c.riskStartTradePct,
  minTradePct: c.riskMinTradePct,
  dailyStopPct: c.riskDailyStopPct,
  drawdownPausePct: c.riskDrawdownPausePct,
  minTradeSol: c.riskMinTradeSol,
  minEquitySol: c.riskMinEquitySol,
});

export interface RiskState {
  units: number;
  /** NAV per unit at the last look, and the highest one seen. */
  nav: number;
  high: number;
  /** The UTC day of `dayStart`, the NAV per unit at that day's first look. */
  day: string;
  dayStart: number;
  /** The UTC day the day's stop fired, or null. */
  stoppedDay: string | null;
  /** Share of what it has to trade with that a trade gets (0.05 = 5%). */
  f: number;
  /** Closed trades (since `since`) counted when f last moved. */
  fAt: number;
  /** When the governor started counting closed trades. */
  since: string;
  /** What it had to trade with at the last look (SOL): the value less the fee reserve. */
  equity: number;
  /** When the last look was. */
  at: string;
}

/** One look's readings. */
export interface Look {
  now: number;
  /** SOL in the wallet + open positions at no more than cost + buys under way at their size − SOL set aside. */
  value: number;
  reserve: number;
  /** Flows not priced yet, oldest first (SOL: + in, − out). */
  flows: number[];
  /** Trades are under way: the high and f are left alone this time (a sell's SOL can be in before its position closes). */
  busy: boolean;
  /** Closed trades since the governor began, and the SOL return of the last 30 (P&L / cost; null with fewer). */
  closed: number;
  recentReturn: number | null;
  /** The owner resumed after a self-pause: the high starts again from here. */
  resetHigh: boolean;
}

export interface Step {
  state: RiskState;
  /** Units and NAV for each flow, in the order given. */
  priced: { units: number; nav: number }[];
  /** The day's stop fired at this look. */
  stopped: boolean;
  /** NAV is at or below the self-pause line. */
  drawdown: boolean;
}

const EPS = 1e-9;
const STEP_AFTER = 30;
const STEP_EVERY = 10;
const STEP_UP = 0.005;
const STEP_DOWN = 0.01;
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

/** One look: prices the new flows and moves the state. Pure. */
export function riskStep(prev: RiskState | null, look: Look, rails: Rails): Step {
  const day = dayOf(look.now);
  const lo = rails.minTradePct / 100;
  const hi = rails.maxTradePct / 100;
  const s: RiskState = prev
    ? { ...prev }
    : { units: 0, nav: 1, high: 1, day, dayStart: 1, stoppedDay: null, f: clamp(rails.startTradePct / 100, lo, hi), fAt: 0, since: new Date(look.now).toISOString(), equity: 0, at: "" };
  const before = look.value - look.flows.reduce((a, b) => a + b, 0);
  let navBefore = s.units > EPS ? before / s.units : 0;
  const restart = s.units <= EPS || navBefore <= EPS;
  if (restart) {
    // Nothing in units yet (first look) or the wallet was emptied: start again at 1 SOL a unit on what is there now.
    s.units = Math.max(0, before);
    navBefore = 1;
    s.high = 1;
    s.dayStart = 1;
    s.day = day;
  }
  const priced = look.flows.map((sol) => {
    const units = sol / navBefore;
    s.units = Math.max(0, s.units + units);
    return { units, nav: navBefore };
  });
  s.nav = s.units > EPS ? look.value / s.units : navBefore;
  if (s.day !== day) {
    s.day = day;
    s.dayStart = s.nav;
  }
  // A move counts only once two looks in a row show it: a transfer the wallet's history doesn't list yet (it lags the
  // balance by a moment) is priced at the next look, and must neither lift the high nor fire a stop meanwhile.
  const last = prev && !restart ? prev.nav : s.nav;
  const held = Math.min(s.nav, last);
  const low = Math.max(s.nav, last);
  if (look.resetHigh) s.high = s.nav;
  else if (!look.busy) s.high = Math.max(s.high, held);
  let stopped = false;
  if (s.stoppedDay !== day && s.units > EPS && low <= s.dayStart * (1 - rails.dailyStopPct / 100)) {
    s.stoppedDay = day;
    stopped = true;
  }
  const drawdown = s.units > EPS && low <= s.high * (1 - rails.drawdownPausePct / 100);
  s.f = clamp(s.f, lo, hi);
  if (!look.busy && look.closed >= STEP_AFTER && look.closed - s.fAt >= STEP_EVERY && look.recentReturn !== null) {
    if (look.recentReturn > 0) s.f = Math.min(hi, s.f + STEP_UP);
    else if (look.recentReturn < 0) s.f = Math.max(lo, s.f - STEP_DOWN);
    s.fAt = look.closed;
  }
  s.equity = Math.max(0, look.value - look.reserve);
  s.at = new Date(look.now).toISOString();
  return { state: s, priced, stopped, drawdown };
}

/** The ceilings on top of the governor: the fixed settings written in .env, and the hard cap. */
export interface Ceilings {
  maxTradeSol: number;
  budgetSol: number;
  /** COPY_MIN_TRADE_SOL: the smallest trade is the larger of it and the rail's. */
  minTradeSol: number;
}

export const ceilingsOf = (c: Config): Ceilings => ({
  maxTradeSol: Math.min(HARD_MAX_COPY_TRADE_SOL, c.fixedInEnv.maxTrade ? c.copyMaxTradeSol : Infinity),
  budgetSol: c.fixedInEnv.budget ? c.copyBudgetSol : Infinity,
  minTradeSol: c.copyMinTradeSol,
});

export interface Limits {
  copyMaxTradeSol: number;
  copyBudgetSol: number;
  copyMinTradeSol: number;
}

export type LimitsResult = ({ ok: true } & Limits & { f: number; equity: number }) | { ok: false; key: string; reason: string };

/** A last look older than this is no ground to buy on. */
export const STALE_MS = 3 * 60_000;

/** What a buy may spend now. `freshEquity`: what it has to trade with by the wallet's balance now (null = unreadable). Pure. */
export function limitsFrom(state: RiskState | null, freshEquity: number | null, rails: Rails, ceil: Ceilings, now: number): LimitsResult {
  if (!state) return { ok: false, key: "risk-none", reason: "the agent hasn't worked out its limits yet" };
  const age = now - Date.parse(state.at);
  if (!(age <= STALE_MS)) return { ok: false, key: "risk-stale", reason: `its limits were last worked out ${Math.round(age / 60_000)} min ago` };
  if (freshEquity === null) return { ok: false, key: "risk-unread", reason: "the wallet's balance can't be read right now" };
  if (state.stoppedDay === dayOf(now)) return { ok: false, key: "risk-day", reason: `the day's stop: ${rails.dailyStopPct}% down since the day began (UTC); sells go on` };
  const equity = Math.min(state.equity, freshEquity);
  if (equity < rails.minEquitySol) return { ok: false, key: "risk-small", reason: `only ${amount(equity)} to trade with (it trades from ${rails.minEquitySol} SOL)` };
  const minTrade = Math.max(rails.minTradeSol, ceil.minTradeSol);
  const most = (equity * rails.maxTradePct) / 100;
  if (minTrade > most) return { ok: false, key: "risk-small", reason: `the smallest trade (${minTrade} SOL) is above ${rails.maxTradePct}% of ${amount(equity)}` };
  const size = Math.min(ceil.maxTradeSol, Math.max(minTrade, Math.min(most, equity * state.f)));
  if (size < minTrade) return { ok: false, key: "risk-ceiling", reason: `COPY_MAX_TRADE_SOL (${ceil.maxTradeSol}) is below the smallest trade (${minTrade} SOL)` };
  return { ok: true, copyMaxTradeSol: Number(size.toFixed(6)), copyBudgetSol: Math.min(equity, ceil.budgetSol), copyMinTradeSol: minTrade, f: state.f, equity };
}

// ---------------------------------------------------------------- reading and writing the database

const STATE_KEY = "risk_state";
/** Written by `npm run resume` after a self-pause: the next look restarts the high. */
export const RESET_HIGH_KEY = "risk_reset_high";
/** SOL kept out of trading (the owner's share of creator rewards until it is paid out; Phase 3). */
export const SET_ASIDE_KEY = "funding_set_aside_sol";

export function readRiskState(db: DB): RiskState | null {
  try {
    const v = JSON.parse(getMeta(db, STATE_KEY) || "null") as RiskState | null;
    return v && typeof v === "object" && Number.isFinite(v.units) && typeof v.at === "string" ? v : null;
  } catch {
    return null;
  }
}

/** Open real positions at no more than their cost, and real buys under way at their size (SOL). */
export function heldValue(db: DB): { positions: number; pending: number } {
  const positions = (db
    .prepare(
      `SELECT COALESCE(SUM(MIN(cost, COALESCE(mark, cost))), 0) v FROM (
         SELECT CASE WHEN tokens_bought > 0 THEN cost_sol * token_amount / tokens_bought ELSE cost_sol END cost, last_price_sol * token_amount mark
         FROM positions WHERE status = 'open' AND mode = 'real')`,
    )
    .get() as { v: number }).v;
  const pending = (db.prepare("SELECT COALESCE(SUM(size_sol), 0) v FROM copy_trades WHERE side = 'buy' AND status = 'pending' AND mode = 'real'").get() as { v: number }).v;
  return { positions, pending };
}

const setAside = (db: DB): number => Math.max(0, Number(getMeta(db, SET_ASIDE_KEY) ?? 0) || 0);

/** What the agent has to trade with if the wallet holds `balanceSol` now: positions and buys under way counted as in the look. */
export function equityNow(db: DB, balanceSol: number, reserveSol: number): number {
  const h = heldValue(db);
  return Math.max(0, balanceSol + h.positions + h.pending - setAside(db) - reserveSol);
}

/** What a buy may spend now (real mode, governor on). `balanceSol`: the wallet's SOL now, null when it can't be read. */
export function effectiveLimits(db: DB, c: Config, balanceSol: number | null, now = Date.now()): LimitsResult {
  return limitsFrom(readRiskState(db), balanceSol === null ? null : equityNow(db, balanceSol, c.walletReserveSol), railsOf(c), ceilingsOf(c), now);
}

/** The public summary for the site: sizes and stops in plain figures, nothing about flows or the wallet's history. */
export interface PublicLimits {
  at: string;
  tradeSol: number;
  tradePct: number;
  equitySol: number;
  dayChangePct: number;
  fromHighPct: number;
  stoppedToday: boolean;
  selfPaused: boolean;
  /** Why the next trade is 0: too little to trade with, the day's stop, or another hold (unread wallet, stale look). */
  blocked: "small" | "day" | "other" | null;
  rails: { maxTradePct: number; dailyStopPct: number; drawdownPausePct: number; minEquitySol: number };
}

/**
 * The minute's risk look (real mode): values the wallet at `balanceSol`, prices the unpriced flows up to `slot` (the
 * balance's own slot, so a flow is never counted before the balance shows it), moves the state, and acts on the stops.
 */
export function riskLook(db: DB, c: Config, balanceSol: number, slot: number, now = Date.now()): Step {
  const rails = railsOf(c);
  const prev = readRiskState(db);
  const flows = db.prepare("SELECT id, sol FROM wallet_flows WHERE units IS NULL AND slot <= ? ORDER BY slot, id").all(slot) as { id: number; sol: number }[];
  const h = heldValue(db);
  const value = balanceSol + h.positions + h.pending - setAside(db);
  const busy = (db.prepare("SELECT COUNT(*) n FROM copy_trades WHERE status = 'pending' AND mode = 'real'").get() as { n: number }).n > 0;
  const since = prev?.since ?? new Date(now).toISOString();
  const closed = (db.prepare("SELECT COUNT(*) n FROM positions WHERE status = 'closed' AND mode = 'real' AND closed_at >= ?").get(since) as { n: number }).n;
  const last = db
    .prepare("SELECT COALESCE(SUM(pnl_sol), 0) p, COALESCE(SUM(cost_sol), 0) c, COUNT(*) n FROM (SELECT pnl_sol, cost_sol FROM positions WHERE status = 'closed' AND mode = 'real' AND closed_at >= ? ORDER BY closed_at DESC LIMIT 30)")
    .get(since) as { p: number; c: number; n: number };
  const resetHigh = getMeta(db, RESET_HIGH_KEY) === "1";
  const step = riskStep(prev, { now, value, reserve: c.walletReserveSol, flows: flows.map((f) => f.sol), busy, closed, recentReturn: last.n >= 30 && last.c > 0 ? last.p / last.c : null, resetHigh }, rails);
  const s = step.state;
  db.transaction(() => {
    const price = db.prepare("UPDATE wallet_flows SET units = ?, nav = ? WHERE id = ?");
    flows.forEach((f, i) => price.run(step.priced[i].units, step.priced[i].nav, f.id));
    setMeta(db, STATE_KEY, JSON.stringify(s));
    if (resetHigh) setMeta(db, RESET_HIGH_KEY, "0");
  })();
  if (prev && Math.abs(s.f - prev.f) > EPS) say("info", `Trade size now ${(s.f * 100).toFixed(1)}% of the wallet (was ${(prev.f * 100).toFixed(1)}%): the last 30 closed trades ${s.f > prev.f ? "made" : "lost"} money.`);
  if (step.stopped) {
    const text = `Day's stop: down ${rails.dailyStopPct}% or more since the day began (open losses counted). No new buys until tomorrow (UTC); sells and exits keep running.`;
    say("warn", text);
    void alert(db, "daily_stop", text, s.day);
  }
  if (step.drawdown && getMeta(db, "copy_paused") !== "1") {
    setMeta(db, "copy_paused", "1");
    setMeta(db, "copy_paused_by", "drawdown");
    const text = `Paused itself: ${rails.drawdownPausePct}% or more below its high (per unit, so deposits and withdrawals don't count). Sells and exits keep running. "npm run resume" starts buying again from here.`;
    say("warn", text);
    void alert(db, "self_pause", text);
  }
  const l = limitsFrom(s, s.equity, rails, ceilingsOf(c), now);
  const pub: PublicLimits = {
    at: nowIso(),
    tradeSol: l.ok ? l.copyMaxTradeSol : 0,
    tradePct: Number((s.f * 100).toFixed(2)),
    equitySol: Number(s.equity.toFixed(4)),
    dayChangePct: Number(((s.nav / s.dayStart - 1) * 100).toFixed(2)),
    fromHighPct: Number(((s.nav / s.high - 1) * 100).toFixed(2)),
    stoppedToday: s.stoppedDay === s.day,
    selfPaused: getMeta(db, "copy_paused") === "1" && getMeta(db, "copy_paused_by") === "drawdown",
    blocked: l.ok ? null : l.key === "risk-small" ? "small" : l.key === "risk-day" ? "day" : "other",
    rails: { maxTradePct: rails.maxTradePct, dailyStopPct: rails.dailyStopPct, drawdownPausePct: rails.drawdownPausePct, minEquitySol: rails.minEquitySol },
  };
  setMeta(db, "risk_limits", JSON.stringify(pub));
  return step;
}
