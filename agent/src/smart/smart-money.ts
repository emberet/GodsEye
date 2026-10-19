/**
 * SMART MONEY — where are the wallets that make money putting it right now?
 *
 *   1. Who counts as smart money (refreshed every 5 min):
 *        • analyzed wallets with a track record: ≥ MIN_CLOSED_FOR_PROVEN closed trades in
 *          30 days, profitable in USD, a win rate at or above the learned follow bar
 *          (learning/adaptive.ts), not a Lucky streak or Quitter
 *        • wallets winning big on the live stream right now: ≥ SMART_LIVE_MIN_PNL_USD realized
 *          over ≥ SMART_LIVE_MIN_CLOSED closed trades, win rate ≥ the follow bar + 5 points
 *      …minus wallets whose buys tend to go down afterwards (learned, see 3).
 *   2. Every memecoin trade a smart wallet makes on the live stream is recorded (smart_flows).
 *      When SMART_SIGNAL_WALLETS (3) smart wallets buy the same token within
 *      SMART_SIGNAL_WINDOW_MINUTES (60) for ≥ SMART_SIGNAL_MIN_USD, that's an "accumulate"
 *      signal; the same for selling is an "exit" signal.
 *   3. Learning: 1, 6 and 24 hours later GodsEye checks what the price did after every smart
 *      buy and every signal. A wallet's "lead score" (share of its buys that were up 6 hours
 *      later, and the median 6-hour move) decides whether it stays smart money and scales
 *      how much GodsEye copies it.
 * Prices come from the stream itself: the USD value of each swap ÷ tokens, for every memecoin
 * traded, so no extra API calls are needed.
 */
import { type DB, nowIso, setMeta } from "@godseye/shared";
import { config } from "../config";
import { say } from "../log";
import type { ParsedSwap } from "../chain/parse";
import type { LiveBook } from "../stream/live-book";
import { symbolOf, tokenInfo } from "../market/tokens";
import { FOLLOW_MIN_WIN_RATE, getParam } from "../learning/adaptive";

export const HORIZONS = [
  { col: "ret_1h", bit: 1, ms: 3_600_000 },
  { col: "ret_6h", bit: 2, ms: 6 * 3_600_000 },
  { col: "ret_24h", bit: 4, ms: 24 * 3_600_000 },
] as const;
/** A return is only measured if GodsEye checks within this long after the horizon (else the price is too late to mean anything). */
const LATE_MS = 2 * 3_600_000;
/** A price older than this before the horizon can't stand for "the price then". */
const STALE_MS = 6 * 3_600_000;
/** Don't repeat the same signal for a token within this long. */
const SIGNAL_COOLDOWN_MS = 6 * 3_600_000;
/** Buys measured before a wallet's lead score counts. */
export const LEAD_MIN_N = 10;

export interface FlowEvent {
  ts: number;
  wallet: string;
  side: "buy" | "sell";
  usd: number;
}

/** Pure: does this window of smart trades on one token make a signal? */
export function detectSignal(
  events: FlowEvent[],
  now: number,
  cfg: { wallets: number; windowMinutes: number; minUsd: number },
): { kind: "accumulate" | "exit"; wallets: string[]; usd: number } | null {
  const recent = events.filter((e) => now - e.ts <= cfg.windowMinutes * 60_000);
  for (const kind of ["accumulate", "exit"] as const) {
    // net per wallet in the window: buyers for accumulate, sellers for exit
    const net = new Map<string, number>();
    for (const e of recent) net.set(e.wallet, (net.get(e.wallet) ?? 0) + (e.side === "buy" ? e.usd : -e.usd));
    const side = [...net.entries()].filter(([, v]) => (kind === "accumulate" ? v > 0 : v < 0));
    const usd = side.reduce((s, [, v]) => s + Math.abs(v), 0);
    if (side.length >= cfg.wallets && usd >= cfg.minUsd) return { kind, wallets: side.map(([w]) => w), usd };
  }
  return null;
}

export const returnPct = (from: number | null, to: number | null): number | null => (from && to ? (to / from - 1) * 100 : null);

/** Pure: a wallet's lead score from the 6-hour returns after its buys. */
export function leadStats(rets: number[]): { n: number; hitRate: number | null; median: number | null } {
  if (!rets.length) return { n: 0, hitRate: null, median: null };
  const sorted = [...rets].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return { n: rets.length, hitRate: rets.filter((r) => r > 0).length / rets.length, median };
}

type Price = { usd: number; ts: number; firstSeen: number };

export class SmartMoney {
  private smart = new Map<string, { source: "analyzed" | "live"; winRate: number }>();
  private prices = new Map<string, Price>();
  /** Mints smart money has touched in the last ~26 h: their prices are saved for measuring returns. */
  private watched = new Map<string, number>();
  private recent = new Map<string, FlowEvent[]>();
  private lastSignal = new Map<string, number>();
  private pending: { s: ParsedSwap; priceUsd: number | null; winRate: number }[] = [];

  constructor(
    private db: DB,
    private book: LiveBook | null,
  ) {
    for (const r of db.prepare("SELECT mint, MAX(ts) ts, kind FROM smart_signals GROUP BY mint, kind").all() as { mint: string; ts: string; kind: string }[]) {
      this.lastSignal.set(`${r.kind}:${r.mint}`, Date.parse(r.ts));
    }
  }

  get size(): number {
    return this.smart.size;
  }

  isSmart(wallet: string): boolean {
    return this.smart.has(wallet);
  }

  /** Every parsed swap from the stream comes through here. */
  onSwap(s: ParsedSwap, now = Date.now()): void {
    const priceUsd = s.usdAmount !== null && s.tokenAmount > 0 ? s.usdAmount / s.tokenAmount : null;
    if (priceUsd) {
      const p = this.prices.get(s.mint);
      this.prices.set(s.mint, { usd: priceUsd, ts: now, firstSeen: p?.firstSeen ?? now });
    }
    if (!this.smart.has(s.wallet)) return;
    this.watched.set(s.mint, now);
    this.pending.push({ s, priceUsd, winRate: this.smart.get(s.wallet)!.winRate });
    if (s.usdAmount === null) return;
    const list = (this.recent.get(s.mint) ?? []).filter((e) => now - e.ts <= config.smartSignalWindowMinutes * 60_000);
    list.push({ ts: now, wallet: s.wallet, side: s.side, usd: s.usdAmount });
    this.recent.set(s.mint, list);
    const sig = detectSignal(list, now, { wallets: config.smartSignalWallets, windowMinutes: config.smartSignalWindowMinutes, minUsd: config.smartSignalMinUsd });
    if (!sig) return;
    const key = `${sig.kind}:${s.mint}`;
    if (now - (this.lastSignal.get(key) ?? 0) < SIGNAL_COOLDOWN_MS) return;
    this.lastSignal.set(key, now);
    const firstSeen = this.prices.get(s.mint)?.firstSeen;
    this.db
      .prepare("INSERT INTO smart_signals (ts, mint, kind, wallets, wallet_count, usd, price_usd, token_age_min) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(new Date(now).toISOString(), s.mint, sig.kind, JSON.stringify(sig.wallets), sig.wallets.length, sig.usd, priceUsd, firstSeen ? (now - firstSeen) / 60_000 : null);
    void tokenInfo(this.db, s.mint).catch(() => null).then(() => {
      const verb = sig.kind === "accumulate" ? "buying" : "dumping";
      say("learn", `Smart money ${verb} ${symbolOf(this.db, s.mint)}: ${sig.wallets.length} smart wallets, $${Math.round(sig.usd).toLocaleString("en-US")} in ${config.smartSignalWindowMinutes} min.`);
    });
  }

  /** Save recorded smart trades and the prices needed to measure them. */
  flush(now = Date.now()): void {
    const batch = this.pending.splice(0);
    const ins = this.db.prepare("INSERT OR IGNORE INTO smart_flows (signature, ts, wallet, mint, side, usd, price_usd, wallet_win_rate) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    const px = this.db.prepare(
      `INSERT INTO token_prices (mint, price_usd, ts, first_seen_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(mint) DO UPDATE SET price_usd = excluded.price_usd, ts = excluded.ts`,
    );
    this.db.transaction(() => {
      for (const { s, priceUsd, winRate } of batch) ins.run(s.signature, s.ts, s.wallet, s.mint, s.side, s.usdAmount, priceUsd, winRate);
      for (const [mint, at] of this.watched) {
        if (now - at > 26 * 3_600_000) {
          this.watched.delete(mint);
          continue;
        }
        const p = this.prices.get(mint);
        if (p) px.run(mint, p.usd, new Date(p.ts).toISOString(), new Date(p.firstSeen).toISOString());
      }
    })();
    // Keep the in-memory price map from growing without bound: forget tokens quiet for a day and not watched.
    if (this.prices.size > 200_000) for (const [m, p] of this.prices) if (now - p.ts > 86_400_000 && !this.watched.has(m)) this.prices.delete(m);
  }

  /** 1 / 6 / 24 hours on: what did the price do after each smart trade and signal? */
  evaluate(now = Date.now()): number {
    let measured = 0;
    for (const table of ["smart_flows", "smart_signals"] as const) {
      for (const h of HORIZONS) {
        const due = this.db
          .prepare(`SELECT id, mint, ts, price_usd FROM ${table} WHERE (checked & ?) = 0 AND ts <= ?`)
          .all(h.bit, new Date(now - h.ms).toISOString()) as { id: number; mint: string; ts: string; price_usd: number | null }[];
        const upd = this.db.prepare(`UPDATE ${table} SET ${h.col} = ?, checked = checked | ? WHERE id = ?`);
        this.db.transaction(() => {
          for (const r of due) {
            const horizon = Date.parse(r.ts) + h.ms;
            const p = this.prices.get(r.mint) ?? this.dbPrice(r.mint);
            const usable = now - horizon <= LATE_MS && p && p.ts >= horizon - STALE_MS;
            const ret = usable ? returnPct(r.price_usd, p!.usd) : null;
            upd.run(ret, h.bit, r.id);
            if (ret !== null) measured++;
          }
        })();
      }
    }
    return measured;
  }

  private dbPrice(mint: string): Price | null {
    const r = this.db.prepare("SELECT price_usd, ts, first_seen_at FROM token_prices WHERE mint = ?").get(mint) as { price_usd: number; ts: string; first_seen_at: string } | undefined;
    return r ? { usd: r.price_usd, ts: Date.parse(r.ts), firstSeen: Date.parse(r.first_seen_at) } : null;
  }

  /** Recompute who counts as smart money, with each wallet's learned lead score. */
  refresh(): { active: number; dropped: number } {
    const ts = nowIso();
    // The win-rate bar is learned (learning/adaptive.ts), not fixed.
    const bar = getParam(this.db, FOLLOW_MIN_WIN_RATE, config.followWinRateStart);
    const since14 = new Date(Date.now() - 14 * 86_400_000).toISOString();
    const lead = new Map<string, number[]>();
    for (const r of this.db.prepare("SELECT wallet, ret_6h FROM smart_flows WHERE side = 'buy' AND ret_6h IS NOT NULL AND ts >= ?").all(since14) as { wallet: string; ret_6h: number }[]) {
      (lead.get(r.wallet) ?? lead.set(r.wallet, []).get(r.wallet)!).push(r.ret_6h);
    }
    const candidates = new Map<string, { source: "analyzed" | "live"; pnl: number; closed: number; win: number }>();
    const analyzed = this.db
      .prepare(
        `SELECT w.address, s.pnl_30d_usd pnl, s.closed_30d closed, s.win_rate_30d win FROM wallets w JOIN wallet_stats s ON s.wallet = w.address
          WHERE s.closed_30d >= ? AND s.pnl_30d_usd > 0 AND s.win_rate_30d >= ? AND w.tier NOT IN ('quitter', 'lucky_streak')`,
      )
      .all(config.minClosedForProven, bar) as { address: string; pnl: number; closed: number; win: number }[];
    for (const a of analyzed) candidates.set(a.address, { source: "analyzed", pnl: a.pnl, closed: a.closed, win: a.win });
    // Wallets judged on live trades alone need a bit more (less evidence than a full analysis).
    for (const w of this.book?.smartCandidates(config.smartLiveMinPnlUsd, config.smartLiveMinClosed, Math.min(1, bar + 0.05)) ?? []) {
      if (!candidates.has(w.address)) candidates.set(w.address, { source: "live", pnl: w.pnlUsd, closed: w.closed, win: w.wins / w.closed });
    }
    const next = new Map<string, { source: "analyzed" | "live"; winRate: number }>();
    let dropped = 0;
    const up = this.db.prepare(
      `INSERT INTO smart_wallets (address, source, pnl_usd, closed, win_rate, lead_n, lead_hit_rate, lead_median_6h, active, reason, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(address) DO UPDATE SET source=excluded.source, pnl_usd=excluded.pnl_usd, closed=excluded.closed, win_rate=excluded.win_rate,
         lead_n=excluded.lead_n, lead_hit_rate=excluded.lead_hit_rate, lead_median_6h=excluded.lead_median_6h, active=excluded.active,
         reason=excluded.reason, updated_at=excluded.updated_at`,
    );
    this.db.transaction(() => {
      for (const [address, c] of candidates) {
        const l = leadStats(lead.get(address) ?? []);
        const buysTops = l.n >= LEAD_MIN_N && l.median !== null && l.median <= config.smartDropMedianRet6h;
        const reason = buysTops
          ? `its buys are down a median ${Math.round(l.median!)}% six hours later (${l.n} measured) — follows, doesn't lead`
          : `${c.source === "analyzed" ? "track record" : "winning live"}: +$${Math.round(c.pnl).toLocaleString("en-US")} over ${c.closed} trades, ${Math.round(c.win * 100)}% wins`;
        if (buysTops) dropped++;
        else next.set(address, { source: c.source, winRate: c.win });
        up.run(address, c.source, c.pnl, c.closed, c.win, l.n, l.hitRate, l.median, buysTops ? 0 : 1, reason, ts);
      }
      // Wallets that no longer qualify at all
      const keep = [...candidates.keys()];
      this.db.prepare(`UPDATE smart_wallets SET active = 0, reason = 'no longer qualifies', updated_at = ? WHERE active = 1 ${keep.length ? `AND address NOT IN (${keep.map(() => "?").join(",")})` : ""}`).run(ts, ...keep);
    })();
    const added = [...next.keys()].filter((a) => !this.smart.has(a)).length;
    this.smart = next;
    setMeta(this.db, "smart_wallets_active", next.size);
    if (added) say("learn", `Smart money: ${next.size} wallets (${added} new)${dropped ? `, ${dropped} dropped for buying tops` : ""}.`);
    return { active: next.size, dropped };
  }
}
