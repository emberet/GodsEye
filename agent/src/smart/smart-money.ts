/**
 * SMART MONEY — where are the wallets that make money putting it right now?
 *
 *   1. Who counts as smart money (refreshed every 5 min):
 *        • analyzed wallets with a track record: ≥ MIN_CLOSED_FOR_PROVEN closed trades in
 *          30 days, profitable in USD, a win rate at or above the learned follow bar
 *          (learning/adaptive.ts), not a Lucky streak or Quitter
 *        • wallets winning big on the live stream right now: ≥ SMART_LIVE_MIN_PNL_USD realized
 *          over ≥ SMART_LIVE_MIN_CLOSED closed trades, win rate ≥ the follow bar + 5 points
 *      …minus wallets whose buys tend to go down afterwards (learned, see 3), and minus bots and
 *      wallets that copying wouldn't have paid on (the bot gate and copy gate, see copy-check.ts).
 *   2. Every memecoin trade a smart wallet makes on the live stream is recorded (smart_flows).
 *      Non-memecoins (stablecoins, majors, wrapped/bridged tokens, tokenized stocks) are left out:
 *      skipped on arrival when already known, and purged once a new token's name shows what it is.
 *      When SMART_SIGNAL_WALLETS (3) smart wallets buy the same token within
 *      SMART_SIGNAL_WINDOW_MINUTES (60) for ≥ SMART_SIGNAL_MIN_USD, that's an "accumulate"
 *      signal; the same for selling is an "exit" signal.
 *   3. Learning: 1, 6 and 24 hours later GodsEye checks what the price did after every smart
 *      buy and every signal. A wallet's "lead score" (share of its buys that were up 6 hours
 *      later, and the median 6-hour move) decides whether it stays smart money and scales
 *      how much GodsEye copies it.
 * Prices come from the stream itself: the USD value of each swap ÷ tokens, for every memecoin
 * traded, so no extra API calls are needed.
 *
 * Only tokens with real, independent demand count (organic.ts): the stream keeps a small tally of every swap
 * by every wallet, flows are always recorded, but a signal is made only when the token's crowd is broad enough
 * and the wallets behind it aren't one funder's, and the feed hides tokens judged thin or wash (and, via
 * organic-market.ts, tokens whose pool is empty).
 */
import { type DB, isNonMemecoin, nowIso, setMeta } from "@godseye/shared";
import { config } from "../config";
import { say } from "../log";
import type { ParsedSwap } from "../chain/parse";
import type { LiveBook } from "../stream/live-book";
import { cachedTokenInfo, symbolOf, tokenInfo } from "../market/tokens";
import { FOLLOW_MIN_WIN_RATE, getParam } from "../learning/adaptive";
import { MAX_PLAUSIBLE_RETURN_PCT } from "../replay/model";
import { botCfg, botReason, botSigns, copyReason, replayCfg, storedReplays } from "./copy-check";
import { assess, backfillFromTape, getVerdict, independentVoters, MintTally, organicSettings, saveAssessment } from "./organic";
import { checkMarkets, marketSettings } from "./organic-market";

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

export { MAX_PLAUSIBLE_RETURN_PCT };

export const returnPct = (from: number | null, to: number | null): number | null => {
  if (!from || !to) return null;
  const r = (to / from - 1) * 100;
  return r > MAX_PLAUSIBLE_RETURN_PCT ? null : r;
};

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
  /** Every swap on the stream, per token (organic.ts). */
  readonly tally = new MintTally();
  private gated = 0;
  private gatedLogged = new Map<string, number>();
  private lastPersist = 0;
  private lastMarket = 0;
  private marketBusy = false;
  private funderQuery: ReturnType<DB["prepare"]> | null = null;
  /** Tokens whose name has been asked for, so each is looked up once. */
  private named = new Set<string>();

  constructor(
    private db: DB,
    private book: LiveBook | null,
    /** Look up names of new tokens (needed to spot non-memecoins). Off in tests: no network. */
    private opts: { lookupNames?: boolean; purgeEveryMs?: number } = {},
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
    if (organicSettings.enabled) this.tally.record(s, this.smart.has(s.wallet), now);
    if (!this.smart.has(s.wallet)) return;
    if (this.notMeme(s.mint)) return;
    this.watched.set(s.mint, now);
    this.pending.push({ s, priceUsd, winRate: this.smart.get(s.wallet)!.winRate });
    if (s.usdAmount === null) return;
    const list = (this.recent.get(s.mint) ?? []).filter((e) => now - e.ts <= config.smartSignalWindowMinutes * 60_000);
    list.push({ ts: now, wallet: s.wallet, side: s.side, usd: s.usdAmount });
    this.recent.set(s.mint, list);
    const sig = detectSignal(list, now, { wallets: config.smartSignalWallets, windowMinutes: config.smartSignalWindowMinutes, minUsd: config.smartSignalMinUsd });
    if (!sig) return;
    const blocked = this.signalBlocker(s.mint, sig.wallets, now);
    if (blocked) {
      this.gated++;
      if (now - (this.gatedLogged.get(s.mint) ?? 0) > 3_600_000) {
        this.gatedLogged.set(s.mint, now);
        void tokenInfo(this.db, s.mint).catch(() => null).then(() => say("info", `Smart money: not signalling ${symbolOf(this.db, s.mint)}: ${blocked}.`));
      }
      return;
    }
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

  /** Why a signal on this token shouldn't be made (null = it may): too few independent wallets, or no real crowd or pool behind the token. */
  private signalBlocker(mint: string, wallets: string[], now: number): string | null {
    if (!organicSettings.enabled) return null;
    this.funderQuery ??= this.db.prepare("SELECT funder FROM wallets WHERE address = ?");
    const q = this.funderQuery;
    const funderOf = (w: string) => (q.get(w) as { funder: string | null } | undefined)?.funder ?? null;
    const independent = independentVoters(wallets, funderOf);
    if (independent < config.smartSignalWallets) return `only ${independent} of its ${wallets.length} wallets are independent (the rest share a funder)`;
    const st = this.tally.stats(mint, now);
    if (st) {
      const a = assess(st);
      if (a.verdict !== "organic") return `${a.verdict}: ${a.reasons[0]}`;
    }
    const stored = getVerdict(this.db, mint);
    if (stored?.market === "thin") return `no real pool: ${stored.market_reason}`;
    return null;
  }

  /** Once a minute: judge every token smart money touched from the tally, keep the verdicts, and ask Jupiter about their pools. */
  private persistOrganic(now: number): void {
    if (!organicSettings.enabled || now - this.lastPersist < 60_000) return;
    this.lastPersist = now;
    this.db.transaction(() => {
      for (const mint of this.watched.keys()) {
        const st = this.tally.stats(mint, now);
        if (st) saveAssessment(this.db, mint, assess(st), st, "stream", now);
      }
    })();
    this.tally.evict(now);
    setMeta(this.db, "smart_signals_gated", this.gated);
    if (this.opts.lookupNames && marketSettings.enabled && !this.marketBusy && now - this.lastMarket >= marketSettings.everySeconds * 1000) {
      this.lastMarket = now;
      this.marketBusy = true;
      void checkMarkets(this.db, undefined, undefined, now)
        .then((r) => {
          if (r.thin) say("learn", `Smart money: ${r.thin} token${r.thin === 1 ? "" : "s"} left out of the feed because their pool is empty or missing (checked ${r.checked} with Jupiter).`);
        })
        .catch(() => undefined)
        .finally(() => (this.marketBusy = false));
    }
  }

  /** Save recorded smart trades and the prices needed to measure them. */
  flush(now = Date.now()): void {
    const batch = this.pending.splice(0);
    if (this.opts.lookupNames) {
      for (const { s } of batch) {
        if (this.named.has(s.mint) || cachedTokenInfo(this.db, s.mint)) continue;
        this.named.add(s.mint);
        void tokenInfo(this.db, s.mint).catch(() => null);
      }
    }
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
    this.persistOrganic(now);
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

  private notMeme(mint: string): boolean {
    return isNonMemecoin(mint, cachedTokenInfo(this.db, mint)?.symbol);
  }

  private purgedAt = 0;

  /** Delete recorded smart trades and signals on tokens that turned out not to be memecoins. */
  purgeNonMemecoins(): { flows: number; signals: number } {
    const all = (this.db.prepare("SELECT DISTINCT mint FROM smart_flows UNION SELECT DISTINCT mint FROM smart_signals").all() as { mint: string }[]).map((r) => r.mint);
    // Tokens recorded before their name was known: look them up so the next pass can judge them.
    if (this.opts.lookupNames) {
      for (const m of all) {
        if (this.named.has(m) || cachedTokenInfo(this.db, m)) continue;
        this.named.add(m);
        void tokenInfo(this.db, m).catch(() => null);
      }
    }
    const mints = all.filter((m) => this.notMeme(m));
    let flows = 0;
    let signals = 0;
    const delF = this.db.prepare("DELETE FROM smart_flows WHERE mint = ?");
    const delS = this.db.prepare("DELETE FROM smart_signals WHERE mint = ?");
    this.db.transaction(() => {
      for (const m of mints) {
        flows += delF.run(m).changes;
        signals += delS.run(m).changes;
        this.recent.delete(m);
        this.watched.delete(m);
      }
    })();
    if (flows || signals) say("learn", `Smart money: removed ${flows} trade${flows === 1 ? "" : "s"} and ${signals} signal${signals === 1 ? "" : "s"} on tokens that aren't memecoins (${mints.map((m) => symbolOf(this.db, m)).join(", ")}).`);
    return { flows, signals };
  }

  private dbPrice(mint: string): Price | null {
    const r = this.db.prepare("SELECT price_usd, ts, first_seen_at FROM token_prices WHERE mint = ?").get(mint) as { price_usd: number; ts: string; first_seen_at: string } | undefined;
    return r ? { usd: r.price_usd, ts: Date.parse(r.ts), firstSeen: Date.parse(r.first_seen_at) } : null;
  }

  /** Wallets with the track record to be smart money, before the lead score, bot and copy gates. */
  candidates(): Map<string, { source: "analyzed" | "live"; pnl: number; closed: number; win: number }> {
    // The win-rate bar is learned (learning/adaptive.ts), not fixed.
    const bar = getParam(this.db, FOLLOW_MIN_WIN_RATE, config.followWinRateStart);
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
    return candidates;
  }

  /** Recompute who counts as smart money, with each wallet's learned lead score. */
  refresh(): { active: number; dropped: number; bots: number; uncopyable: number } {
    // Once an hour, not every refresh: it scans every recorded smart trade (~1 s of blocked event loop at 300k rows).
    if (Date.now() - this.purgedAt >= (this.opts.purgeEveryMs ?? 3_600_000)) {
      this.purgedAt = Date.now();
      this.purgeNonMemecoins();
    }
    if (organicSettings.enabled) backfillFromTape(this.db); // tokens traded before the live tally existed: judge what the stored swaps can show
    const ts = nowIso();
    const since14 = new Date(Date.now() - 14 * 86_400_000).toISOString();
    const lead = new Map<string, number[]>();
    for (const r of this.db.prepare("SELECT wallet, ret_6h FROM smart_flows WHERE side = 'buy' AND ret_6h IS NOT NULL AND ts >= ?").all(since14) as { wallet: string; ret_6h: number }[]) {
      (lead.get(r.wallet) ?? lead.set(r.wallet, []).get(r.wallet)!).push(r.ret_6h);
    }
    const candidates = this.candidates();
    const signs = botSigns(this.db, [...candidates.keys()]);
    const replays = storedReplays(this.db);
    const bCfg = botCfg();
    const rCfg = replayCfg();
    const next = new Map<string, { source: "analyzed" | "live"; winRate: number }>();
    let dropped = 0;
    let bots = 0;
    let uncopyable = 0;
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
        const bot = buysTops ? null : botReason(signs.get(address) ?? { median_hold_sec: null, tx_per_hour: null, same_block_round_trips: null }, bCfg);
        const noCopy = buysTops || bot ? null : copyReason(replays.get(address) ?? null, rCfg);
        const replay = replays.get(address);
        const reason = buysTops
          ? `its buys are down a median ${Math.round(l.median!)}% six hours later (${l.n} measured) — follows, doesn't lead`
          : bot ?? noCopy ??
            `${c.source === "analyzed" ? "track record" : "winning live"}: +$${Math.round(c.pnl).toLocaleString("en-US")} over ${c.closed} trades, ${Math.round(c.win * 100)}% wins; copying it ${replay!.delay_sec} s late made a median +${replay!.median_ret_pct!.toFixed(1)}%`;
        const ok = !buysTops && !bot && !noCopy;
        if (buysTops) dropped++;
        else if (bot) bots++;
        else if (noCopy) uncopyable++;
        if (ok) next.set(address, { source: c.source, winRate: c.win });
        up.run(address, c.source, c.pnl, c.closed, c.win, l.n, l.hitRate, l.median, ok ? 1 : 0, reason, ts);
      }
      // Wallets that no longer qualify at all
      const keep = [...candidates.keys()];
      this.db.prepare(`UPDATE smart_wallets SET active = 0, reason = 'no longer qualifies', updated_at = ? WHERE active = 1 ${keep.length ? `AND address NOT IN (${keep.map(() => "?").join(",")})` : ""}`).run(ts, ...keep);
    })();
    const added = [...next.keys()].filter((a) => !this.smart.has(a)).length;
    this.smart = next;
    setMeta(this.db, "smart_wallets_active", next.size);
    if (added) say("learn", `Smart money: ${next.size} wallets (${added} new)${dropped ? `, ${dropped} dropped for buying tops` : ""}${bots ? `, ${bots} bots left out` : ""}${uncopyable ? `, ${uncopyable} not worth copying (or not replayed yet)` : ""}.`);
    return { active: next.size, dropped, bots, uncopyable };
  }
}
