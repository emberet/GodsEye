/**
 * THE LEADER LEDGERS — what copying each leader would have got, written as the stream goes, for the leader features
 * (brain/spec/features.yaml cp_*, ps_r_7d, dd_rate_7d). Each row says when its outcome became known, so a feature at t
 * reads only rows known before t.
 *
 *   mirror_ledger  a strict late copy of every copy-eligible leader buy (an analyzed wallet, >= MIN_LEADER_BUY_SOL):
 *                  entry  the first ok tracked swap by another wallet in [buy + 15 s, buy + 135 s] (none: y null, excluded)
 *                  exit   the first ok tracked SELL by another wallet from max(leader's first sell + 15 s, entry + 1 s)
 *                  stop   the first ok price at or below −60% after the entry fills there (the gap, not −60%)
 *                  hold   no exit by buy + 24 h: the next ok tracked price within 6 h (grounded), else −1 (dead)
 *                  y = exit / entry − 1 − 0.026; resolved_at = when the deciding swap reached the server (or the deadline)
 *   ps_ledger      the coin's return in the hour after the leader's first sell (delayed job at sell minute + 61 min); each
 *                  copy-eligible buy waits 24 h for that sell on its own, whatever became of its mirror row (no entry, a stop,
 *                  not followed), so ps_r_7d isn't computed on the rows that happened to stay open
 *   dd_ledger      whether the coin went silent 1–2 h after the buy (delayed job at buy + 2 h 15 s)
 *
 * The mirror follows the stream swap by swap (StreamState.subscribe); after a restart, rows still open are caught up from
 * wallet_swaps (from their stored entry and leader sell), and buys still waiting for the leader's sell look for it there.
 * The delayed jobs read wallet_swaps (idx_swaps_mint_ts) when due: a coin's due jobs are answered from one read of its swaps
 * (marked once), in slices of at most JOB_SLICE_MS with the stream let through between them. Rows are kept 8 days (features
 * read 7). Each swap's writes (and each slice's) go in one transaction: one commit, not one per row, on the stream's thread.
 * Paper and research only: nothing here touches copy_trades or positions.
 */
import { type DB, isNonMemecoin } from "@godseye/shared";
import { config } from "../config";
import { ensureBrainTables } from "./schema";
import { markOk, OK_TAIL, type StreamState, type StreamSwap, TrailingFilter, VALID_PRICE_SQL, WINDOW_7D_MS } from "./state";

export const ENTRY_FROM_MS = 15_000;
export const ENTRY_TO_MS = 135_000;
export const EXIT_AFTER_SELL_MS = 15_000;
export const MIRROR_STOP = -0.6;
export const MIRROR_HOLD_MS = 24 * 3_600_000;
export const GROUNDED_MS = 6 * 3_600_000;
/** The fixed cost haircut of a mirror copy (features.yaml cp_lrshr_7d). */
export const MIRROR_COST = 0.026;
/** cp_lrshr_7d shrinks a leader's mean log outcome toward 0 by this many rows. */
export const CP_SHRINK = 20;
export const PS_WINDOW_MS = 60 * 60_000;
export const PS_AVAIL_MS = 61 * 60_000;
export const DD_FROM_MS = 60 * 60_000;
export const DD_TO_MS = 120 * 60_000;
export const DD_AVAIL_MS = 2 * 3_600_000 + 15_000;
export const LEDGER_KEEP_MS = 8 * 86_400_000;
/** Deadlines wait this long for stream stragglers (lateness p99 is 17 s). */
const GRACE_MS = 60_000;
const MAX_OPEN = 200_000;
const MAX_SELL_WATCH = 200_000;
/** Due jobs of each kind read at a time (a tick reads again while there are more and time left). */
const JOB_BATCH = 2_000;
/** One read of a coin's swaps covers its due jobs' windows within this span (each job's window is at most 61 min). */
const JOB_SPAN_MS = 2 * 3_600_000;
/** Rows one such read may return (a coin-hour held 13,223 tracked swaps at the most on 10-28). */
const JOB_READ_ROWS = 60_000;
/** The stream waits at most about this long for one slice of jobs (one transaction). */
const JOB_SLICE_MS = 50;
/** A tick spends at most this long on jobs in all; the rest wait for the next tick (logged). */
const JOBS_BUDGET_MS = 15_000;
const CATCH_UP_ROWS = 20_000;
const PRUNE_EVERY_MS = 3_600_000;
const QUOTE_FRESH_MS = 60_000;

const iso = (ms: number) => new Date(ms).toISOString();
const ms = (s: string | null) => (s ? Date.parse(s) : NaN);
const clip = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
/** ln(1 + clip(y, −0.99, 10)): what cp_lrshr_7d sums. */
export const logOutcome = (y: number) => Math.log(1 + clip(y, -0.99, 10));

export type ExitKind = "leader_sell" | "stop" | "grounded" | "dead" | "no_entry";

/** An open mirror row in memory. */
interface Mirror {
  id: number;
  leader: string;
  mint: string;
  buyTs: number;
  entryTs: number | null;
  entryPx: number | null;
  leaderSellTs: number | null;
  sig: string;
}

/** A copy-eligible buy waiting (24 h) for the leader's first sell after it: its ps_ledger row. */
interface SellWatch {
  sig: string;
  buyTs: number;
}

/** One swap as the ledger steps on it (stream, or wallet_swaps when catching up). */
type Step = Pick<StreamSwap, "wallet" | "side" | "price" | "ts" | "at" | "ok" | "tracked">;

export interface LedgerDeps {
  now(): number;
  /**
   * A Jupiter sell quote for y_quote (quotes.ts ShadowQuotes.tryQuote: a sample, under the mirror's own share of the cap);
   * undefined = not asked. Optional.
   */
  quoteSell?(mint: string, tokens: number): Promise<number | null | undefined>;
}

/** A due ps or dd job: the window [from, to) of its coin's swaps it reads. */
interface Job {
  kind: "ps" | "dd";
  id: number;
  from: number;
  to: number;
  /** ps: the leader's sell time. */
  sellTs: number;
}

/** OK swaps of one coin, oldest first. */
type OkSwap = { ts: number; price: number };

/** The first index of `ok` with ts >= t. */
function lowerBound(ok: OkSwap[], t: number): number {
  let lo = 0;
  let hi = ok.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ok[mid].ts < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** ps_r_7d's r from the coin's ok swaps in [sell minute, sell minute + 61 min), oldest first (MirrorLedger.postSellReturn). */
export function psReturn(ok: OkSwap[], sellTs: number): number | null {
  const sellMin = Math.floor(sellTs / 60_000) * 60_000;
  const end = sellMin + PS_AVAIL_MS;
  if (!ok.length) return -1;
  let bar = -1;
  for (const m of [0, 1, 2].map((k) => sellMin + k * 60_000)) {
    if (ok.some((s) => s.ts >= m && s.ts < m + 60_000)) {
      bar = m;
      break;
    }
  }
  if (bar < 0) return null;
  const close = ok.filter((s) => s.ts >= bar && s.ts < bar + 60_000).at(-1)!.price;
  const after = ok.filter((s) => s.ts >= bar + 60_000 && s.ts < end).at(-1);
  return after ? clip(after.price / close - 1, -1, 10) : -1;
}

export interface CpStats {
  n: number;
  lrSum: number;
  wins: number;
}

export class MirrorLedger {
  private deps: LedgerDeps;
  private open = new Map<number, Mirror>();
  private byMint = new Map<string, Set<Mirror>>();
  /** leader|mint → its buys waiting for its first sell (apart from the mirror rows: those resolve or go unfollowed). */
  private sellWatch = new Map<string, SellWatch[]>();
  private watching = 0;
  private lastPrune = 0;
  private ticking = false;
  private warned = 0;
  /** Stored swaps read (the delayed jobs, a restart's catch-up) since start (server log and tests). */
  swapsRead = 0;

  constructor(private db: DB, private state: StreamState, deps: Partial<LedgerDeps> = {}) {
    ensureBrainTables(db);
    this.deps = { now: Date.now, ...deps };
    const now = this.deps.now();
    this.db.transaction(() => this.recover(now))();
    state.subscribe((s) => this.onSwap(s));
  }

  private warn(message: string): void {
    const now = Date.now();
    if (now < this.warned) return;
    this.warned = now + 10 * 60_000;
    console.warn(`[brain] ledger: ${message.slice(0, 160)}`);
  }

  /** One kept swap: a copy-eligible buy opens rows; any swap steps the coin's open rows; a leader's sell ends its watches. */
  onSwap(s: StreamSwap): void {
    try {
      const rows = this.byMint.get(s.mint);
      const sold = s.analyzed && s.side === "sell" && this.sellWatch.has(`${s.wallet}|${s.mint}`);
      const opens = s.analyzed && s.side === "buy" && s.sol >= config.minLeaderBuySol && !isNonMemecoin(s.mint, null);
      if (!rows && !sold && !opens) return; // most swaps: nothing to write
      this.db.transaction(() => {
        if (rows) for (const r of [...rows]) this.step(r, s);
        if (sold) this.leaderSold(s.wallet, s.mint, s.ts, s.at);
        if (opens) this.openRow(s);
      })();
    } catch (e) {
      this.warn((e as Error).message);
    }
  }

  private openRow(s: StreamSwap): void {
    const n = this.state.activeWallets1h(s.at);
    const created = iso(s.at);
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO mirror_ledger (leader, mint, buy_ts, buy_sig, leader_sol, leader_price_sol, n_tracked_wallets, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(s.wallet, s.mint, iso(s.ts), s.signature, s.sol, s.price, n, created);
    if (!res.changes) return;
    this.db
      .prepare("INSERT OR IGNORE INTO dd_ledger (leader, mint, buy_sig, buy_ts, avail_at, n_tracked_wallets) VALUES (?, ?, ?, ?, ?, ?)")
      .run(s.wallet, s.mint, s.signature, iso(s.ts), iso(s.ts + DD_AVAIL_MS), n);
    this.watchSell(s.wallet, s.mint, s.signature, s.ts);
    this.track({ id: Number(res.lastInsertRowid), leader: s.wallet, mint: s.mint, buyTs: s.ts, entryTs: null, entryPx: null, leaderSellTs: null, sig: s.signature });
  }

  private track(r: Mirror): void {
    if (this.open.size >= MAX_OPEN) {
      this.warn(`more than ${MAX_OPEN} open mirror rows: the newest isn't followed`);
      return;
    }
    this.open.set(r.id, r);
    let set = this.byMint.get(r.mint);
    if (!set) this.byMint.set(r.mint, (set = new Set()));
    set.add(r);
  }

  private watchSell(leader: string, mint: string, sig: string, buyTs: number): void {
    if (this.watching >= MAX_SELL_WATCH) {
      this.warn(`more than ${MAX_SELL_WATCH} buys waiting for the leader's sell: the newest isn't watched`);
      return;
    }
    const key = `${leader}|${mint}`;
    let list = this.sellWatch.get(key);
    if (!list) this.sellWatch.set(key, (list = []));
    list.push({ sig, buyTs });
    this.watching++;
  }

  /** The leader sold the coin at `ts` (any sell, priced or not): its first sell after each waiting buy (within 24 h) is that buy's ps row. */
  private leaderSold(leader: string, mint: string, ts: number, at: number): void {
    const key = `${leader}|${mint}`;
    const list = this.sellWatch.get(key);
    if (!list) return;
    const wait = list.filter((w) => ts < w.buyTs);
    for (const w of list) if (ts >= w.buyTs && ts <= w.buyTs + MIRROR_HOLD_MS) this.writePs(leader, mint, w.sig, ts, at);
    this.watching -= list.length - wait.length;
    if (wait.length) this.sellWatch.set(key, wait);
    else this.sellWatch.delete(key);
  }

  private writePs(leader: string, mint: string, sig: string, sellTs: number, at: number): void {
    const sellMin = Math.floor(sellTs / 60_000) * 60_000;
    this.db
      .prepare("INSERT OR IGNORE INTO ps_ledger (leader, mint, buy_sig, sell_ts, avail_at, n_tracked_wallets) VALUES (?, ?, ?, ?, ?, ?)")
      .run(leader, mint, sig, iso(sellTs), iso(sellMin + PS_AVAIL_MS), this.state.activeWallets1h(at));
  }

  private untrack(r: Mirror): void {
    this.open.delete(r.id);
    const set = this.byMint.get(r.mint);
    set?.delete(r);
    if (set && !set.size) this.byMint.delete(r.mint);
  }

  /** One swap of the row's coin, in stream order. */
  private step(r: Mirror, s: Step): void {
    if (s.ts < r.buyTs) return;
    // The leader's first sell after its buy (any of its sells, priced or not): the exit clock (the ps row is its watch's).
    if (s.wallet === r.leader && s.side === "sell" && r.leaderSellTs === null && s.ts <= r.buyTs + MIRROR_HOLD_MS) {
      r.leaderSellTs = s.ts;
      this.db.prepare("UPDATE mirror_ledger SET leader_sell_ts = ? WHERE id = ?").run(iso(s.ts), r.id);
    }
    if (!s.tracked || !s.ok) return;
    if (r.entryTs === null) {
      if (s.ts > r.buyTs + ENTRY_TO_MS) return this.resolve(r, "no_entry", null, null, r.buyTs + ENTRY_TO_MS);
      if (s.wallet !== r.leader && s.ts >= r.buyTs + ENTRY_FROM_MS) {
        r.entryTs = s.ts;
        r.entryPx = s.price;
        this.db.prepare("UPDATE mirror_ledger SET entry_ts = ?, entry_px = ? WHERE id = ?").run(iso(s.ts), s.price, r.id);
      }
      return;
    }
    if (s.ts <= r.entryTs) return;
    const entry = r.entryPx!;
    if (s.ts >= r.buyTs + MIRROR_HOLD_MS) {
      // No exit within 24 h: valued at the next ok tracked price (grounded), if it came within 6 h.
      if (s.ts <= r.buyTs + MIRROR_HOLD_MS + GROUNDED_MS) this.resolve(r, s.price <= entry * (1 + MIRROR_STOP) ? "stop" : "grounded", s.price, s.ts, s.at);
      return;
    }
    if (s.price <= entry * (1 + MIRROR_STOP)) return this.resolve(r, "stop", s.price, s.ts, s.at);
    if (r.leaderSellTs !== null && s.wallet !== r.leader && s.side === "sell" && s.ts >= Math.max(r.leaderSellTs + EXIT_AFTER_SELL_MS, r.entryTs + 1_000)) {
      this.resolve(r, "leader_sell", s.price, s.ts, s.at);
    }
  }

  /** The row's outcome is known at `at`: y (null without an entry), its log, and a sell quote at a fresh exit. */
  private resolve(r: Mirror, kind: ExitKind, exitPx: number | null, exitTs: number | null, at: number): void {
    const y = kind === "no_entry" ? null : kind === "dead" ? -1 : exitPx! / r.entryPx! - 1 - MIRROR_COST;
    this.db
      .prepare("UPDATE mirror_ledger SET exit_ts = ?, exit_px = ?, exit_kind = ?, y = ?, lr = ?, resolved_at = ? WHERE id = ? AND resolved_at IS NULL")
      .run(exitTs === null ? null : iso(exitTs), exitPx, kind, y, y === null ? null : logOutcome(y), iso(at), r.id);
    this.untrack(r);
    const now = this.deps.now();
    if (exitPx && r.entryPx && exitTs !== null && now - exitTs <= QUOTE_FRESH_MS && this.deps.quoteSell) {
      const stake = config.copyMaxTradeSol;
      void this.deps
        .quoteSell(r.mint, stake / r.entryPx)
        .then((sol) => {
          if (typeof sol === "number" && sol >= 0) this.db.prepare("UPDATE mirror_ledger SET y_quote = ? WHERE id = ?").run(sol / stake - 1, r.id);
        })
        .catch(() => undefined);
    }
  }

  /** Once a minute: deadlines of open rows, (hourly) rows older than 8 days, then the due delayed jobs. */
  async tick(now = this.deps.now()): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      this.db.transaction(() => this.due(now))();
      await this.runJobs(now);
    } catch (e) {
      this.warn((e as Error).message);
    } finally {
      this.ticking = false;
    }
  }

  /** The open rows' deadlines, the sell watches that ran out and (hourly) the prune: one transaction. */
  private due(now: number): void {
    for (const r of [...this.open.values()]) {
      if (r.entryTs === null && now > r.buyTs + ENTRY_TO_MS + GRACE_MS) this.resolve(r, "no_entry", null, null, r.buyTs + ENTRY_TO_MS);
      else if (r.entryTs !== null && now > r.buyTs + MIRROR_HOLD_MS + GROUNDED_MS + GRACE_MS) this.resolve(r, "dead", null, null, r.buyTs + MIRROR_HOLD_MS + GROUNDED_MS);
    }
    // Buys whose leader didn't sell within 24 h: no ps row.
    for (const [key, list] of this.sellWatch) {
      const wait = list.filter((w) => now <= w.buyTs + MIRROR_HOLD_MS + GRACE_MS);
      this.watching -= list.length - wait.length;
      if (!wait.length) this.sellWatch.delete(key);
      else if (wait.length < list.length) this.sellWatch.set(key, wait);
    }
    if (now - this.lastPrune >= PRUNE_EVERY_MS) {
      this.lastPrune = now;
      this.prune(now);
    }
  }

  /**
   * The ps and dd jobs whose time has come. A coin's jobs are answered from one read of its swaps over their windows
   * (within JOB_SPAN_MS), marked once: a hot coin's hundreds of buys a minute cost one read, not hundreds. They run in
   * slices of about JOB_SLICE_MS (one transaction each), the stream let through between slices, for at most
   * JOBS_BUDGET_MS a call; what's left waits for the next tick. Resolves with the jobs done.
   */
  async runJobs(now = this.deps.now()): Promise<number> {
    const started = performance.now();
    const setPs = this.db.prepare("UPDATE ps_ledger SET r = ?, done = 1 WHERE id = ? AND done = 0");
    const setDd = this.db.prepare("UPDATE dd_ledger SET dead = ?, done = 1 WHERE id = ? AND done = 0");
    let done = 0;
    for (;;) {
      const ps = this.db.prepare("SELECT id, mint, sell_ts FROM ps_ledger WHERE done = 0 AND avail_at <= ? ORDER BY avail_at LIMIT ?").all(iso(now), JOB_BATCH) as {
        id: number; mint: string; sell_ts: string;
      }[];
      const dd = this.db.prepare("SELECT id, mint, buy_ts FROM dd_ledger WHERE done = 0 AND avail_at <= ? ORDER BY avail_at LIMIT ?").all(iso(now), JOB_BATCH) as {
        id: number; mint: string; buy_ts: string;
      }[];
      if (!ps.length && !dd.length) return done;
      const byMint = new Map<string, Job[]>();
      const add = (mint: string, j: Job) => {
        let list = byMint.get(mint);
        if (!list) byMint.set(mint, (list = []));
        list.push(j);
      };
      for (const j of ps) {
        const sellTs = ms(j.sell_ts);
        const sellMin = Math.floor(sellTs / 60_000) * 60_000;
        add(j.mint, { kind: "ps", id: j.id, from: sellMin, to: sellMin + PS_AVAIL_MS, sellTs });
      }
      for (const j of dd) add(j.mint, { kind: "dd", id: j.id, from: ms(j.buy_ts) + DD_FROM_MS, to: ms(j.buy_ts) + DD_TO_MS, sellTs: NaN });
      // Each coin's jobs in runs whose windows fit in JOB_SPAN_MS: one read each.
      const groups: { mint: string; jobs: Job[] }[] = [];
      for (const [mint, jobs] of byMint) {
        jobs.sort((a, b) => a.from - b.from);
        let g: Job[] = [];
        for (const j of jobs) {
          if (g.length && j.to - g[0].from > JOB_SPAN_MS) groups.push({ mint, jobs: g }), (g = []);
          g.push(j);
        }
        groups.push({ mint, jobs: g });
      }
      for (let i = 0; i < groups.length; ) {
        const slice = performance.now();
        this.db.transaction(() => {
          do {
            const { mint, jobs } = groups[i++];
            for (const [j, v] of this.answer(mint, jobs, now)) (j.kind === "ps" ? setPs : setDd).run(v, j.id);
            done += jobs.length;
          } while (i < groups.length && performance.now() - slice < JOB_SLICE_MS);
        })();
        if (performance.now() - started > JOBS_BUDGET_MS) {
          const left = this.db
            .prepare("SELECT (SELECT COUNT(*) FROM ps_ledger WHERE done = 0 AND avail_at <= ?) + (SELECT COUNT(*) FROM dd_ledger WHERE done = 0 AND avail_at <= ?) n")
            .get(iso(now), iso(now)) as { n: number };
          if (left.n) this.warn(`${left.n} due ps/dd jobs wait for the next tick (${done} done in ${JOBS_BUDGET_MS / 1000} s)`);
          return done;
        }
        await new Promise((r) => setImmediate(r)); // the stream goes first
      }
      if (ps.length < JOB_BATCH && dd.length < JOB_BATCH) return done;
    }
  }

  /**
   * One coin's jobs from one read of its stored swaps over their windows (okSwaps: warmed up once, marked once). A read cut
   * at JOB_READ_ROWS answers the jobs whose window it covers; the others read their own window as before.
   * ps: its r (psReturn); dd: 0 if an ok swap came in its window, else 1 (dead).
   */
  private answer(mint: string, jobs: Job[], now: number): [Job, number | null][] {
    const from = Math.min(...jobs.map((j) => j.from));
    const to = Math.max(...jobs.map((j) => j.to));
    const read = this.okSwaps(mint, from, to, now, JOB_READ_ROWS);
    // Cut at the cap: rows up to the last one's ts may be missing some at that ts; earlier ones are all there.
    const covered = read.length >= JOB_READ_ROWS ? read[read.length - 1].ts : Infinity;
    const all = read.filter((s) => s.ok);
    return jobs.map((j) => {
      const ok = j.to <= covered ? all : this.okSwaps(mint, j.from, j.to, now).filter((s) => s.ok);
      const lo = lowerBound(ok, j.from);
      if (j.kind === "dd") return [j, lo < ok.length && ok[lo].ts < j.to ? 0 : 1];
      return [j, psReturn(ok.slice(lo, lowerBound(ok, j.to)), j.sellTs)];
    });
  }

  /**
   * ps_r_7d's r: the last ok price in the hour after the sell minute's bar / that bar's close − 1, clipped to [−1, 10].
   * A coin with no ok price at all from the sell minute on = −1 (gone dark: it counts, it isn't dropped). The bar is the
   * first minute from the sell minute (within 2 min) with an ok price; none while the coin traded later = null (dropped).
   * No ok price in the hour after the bar = −1.
   */
  postSellReturn(mint: string, sellTs: number, now = this.deps.now()): number | null {
    const sellMin = Math.floor(sellTs / 60_000) * 60_000;
    return psReturn(this.okSwaps(mint, sellMin, sellMin + PS_AVAIL_MS, now).filter((s) => s.ok), sellTs);
  }

  /**
   * The coin's stored swaps with ts in [from, to), as the server had them at `now`, each marked by the trailing filter,
   * warmed up on the last OK_TAIL valid prices within 7 days before `from`: all the full-sequence filter remembers there.
   */
  okSwaps(mint: string, from: number, to: number, now = this.deps.now(), limit = CATCH_UP_ROWS): (Step & { sol: number })[] {
    const before = this.db
      .prepare(
        `SELECT wallet, price_sol price, sol_amount sol, token_amount tokens FROM wallet_swaps
         WHERE mint = ? AND ts >= ? AND ts < ? AND ${VALID_PRICE_SQL} ORDER BY ts DESC, slot DESC, id DESC LIMIT ${OK_TAIL}`,
      )
      .all(mint, iso(from - WINDOW_7D_MS), iso(from)) as { wallet: string; price: number; sol: number; tokens: number }[];
    const filter = new TrailingFilter();
    for (const b of before.reverse()) filter.accept(b.price, b.sol, b.tokens, b.wallet);
    const rows = this.db
      .prepare("SELECT wallet, side, price_sol price, sol_amount sol, token_amount tokens, ts FROM wallet_swaps WHERE mint = ? AND ts >= ? AND ts < ? ORDER BY ts, slot, id LIMIT ?")
      .all(mint, iso(from), iso(Math.min(to, now + 1)), limit) as { wallet: string; side: "buy" | "sell"; price: number; sol: number; tokens: number; ts: string }[];
    this.swapsRead += rows.length + before.length;
    return markOk(rows.map((r) => ({ ...r, ts: ms(r.ts), at: now, tracked: true })), filter);
  }

  /**
   * After a restart: the rows still open (bought in the last 31 h) are followed again from their stored entry and leader
   * sell (what the stream saw, a bot leader's sell included, which wallet_swaps doesn't keep), caught up from wallet_swaps
   * on the swaps after them. Buys of the last 24 h without a ps row wait for the leader's sell again, found in wallet_swaps
   * if it came while the server was down.
   */
  private recover(now: number): void {
    const rows = this.db
      .prepare("SELECT id, leader, mint, buy_ts, buy_sig, entry_ts, entry_px, leader_sell_ts FROM mirror_ledger WHERE resolved_at IS NULL AND buy_ts >= ?")
      .all(iso(now - MIRROR_HOLD_MS - GROUNDED_MS - 3_600_000)) as {
      id: number; leader: string; mint: string; buy_ts: string; buy_sig: string; entry_ts: string | null; entry_px: number | null; leader_sell_ts: string | null;
    }[];
    for (const x of rows) {
      const entryTs = x.entry_ts && x.entry_px ? ms(x.entry_ts) : null;
      this.track({
        id: x.id, leader: x.leader, mint: x.mint, buyTs: ms(x.buy_ts), entryTs, entryPx: entryTs === null ? null : x.entry_px,
        leaderSellTs: x.leader_sell_ts ? ms(x.leader_sell_ts) : null, sig: x.buy_sig,
      });
    }
    for (const [mint, set] of [...this.byMint]) {
      const from = Math.min(...[...set].map((r) => r.entryTs ?? r.buyTs));
      for (const s of this.okSwaps(mint, from, now + 1, now)) for (const r of [...set]) if (this.open.has(r.id)) this.step(r, s);
    }

    const waiting = this.db
      .prepare(
        `SELECT m.leader, m.mint, m.buy_sig, m.buy_ts, m.leader_sell_ts FROM mirror_ledger m
         WHERE m.buy_ts >= ? AND NOT EXISTS (SELECT 1 FROM ps_ledger p WHERE p.buy_sig = m.buy_sig AND p.leader = m.leader AND p.mint = m.mint)`,
      )
      .all(iso(now - MIRROR_HOLD_MS - GRACE_MS)) as { leader: string; mint: string; buy_sig: string; buy_ts: string; leader_sell_ts: string | null }[];
    const firstSell = this.db.prepare("SELECT ts FROM wallet_swaps WHERE wallet = ? AND ts >= ? AND ts <= ? AND mint = ? AND side = 'sell' ORDER BY ts LIMIT 1");
    for (const w of waiting) {
      const buyTs = ms(w.buy_ts);
      const stored = (firstSell.get(w.leader, w.buy_ts, iso(buyTs + MIRROR_HOLD_MS), w.mint) as { ts: string } | undefined)?.ts;
      const sellTs = Math.min(w.leader_sell_ts ? ms(w.leader_sell_ts) : Infinity, stored ? ms(stored) : Infinity);
      if (Number.isFinite(sellTs)) this.writePs(w.leader, w.mint, w.buy_sig, sellTs, now);
      else this.watchSell(w.leader, w.mint, w.buy_sig, buyTs);
    }
  }

  /** Rows older than 8 days go (every feature window is 7 days). */
  prune(now = this.deps.now()): void {
    const cut = iso(now - LEDGER_KEEP_MS);
    this.db.prepare("DELETE FROM mirror_ledger WHERE buy_ts < ?").run(cut);
    this.db.prepare("DELETE FROM ps_ledger WHERE avail_at < ?").run(cut);
    this.db.prepare("DELETE FROM dd_ledger WHERE avail_at < ?").run(cut);
  }

  // ---------------------------------------------------------------- feature reads: rows known in [t − 7 d, t)

  /** The leader's mirror rows resolved in [t − 7 d, t) with a y: count, sum of ln(1 + clip(y)), wins (y > 0). */
  cpStats(leader: string, t = this.deps.now()): CpStats {
    const r = this.db
      .prepare("SELECT COUNT(*) n, COALESCE(SUM(lr), 0) lr, COALESCE(SUM(y > 0), 0) w FROM mirror_ledger WHERE leader = ? AND resolved_at >= ? AND resolved_at < ? AND y IS NOT NULL")
      .get(leader, iso(t - WINDOW_7D_MS), iso(t)) as { n: number; lr: number; w: number };
    return { n: r.n, lrSum: r.lr, wins: r.w };
  }

  /** cp_lrshr_7d, cp_n_7d, cp_win_7d (null = missing: no rows). */
  cp(leader: string, t = this.deps.now()): { cp_lrshr_7d: number; cp_n_7d: number; cp_win_7d: number | null } {
    const s = this.cpStats(leader, t);
    return { cp_lrshr_7d: s.lrSum / (s.n + CP_SHRINK), cp_n_7d: s.n, cp_win_7d: s.n ? s.wins / s.n : null };
  }

  /** ps_r_7d: the mean r of the leader's rows available in [t − 7 d, t) (null = missing). */
  psR(leader: string, t = this.deps.now()): number | null {
    const r = this.db
      .prepare("SELECT COUNT(r) n, SUM(r) s FROM ps_ledger WHERE leader = ? AND avail_at >= ? AND avail_at < ? AND done = 1")
      .get(leader, iso(t - WINDOW_7D_MS), iso(t)) as { n: number; s: number | null };
    return r.n ? r.s! / r.n : null;
  }

  /** dd_rate_7d: the share of the leader's buys available in [t − 7 d, t) whose coin went silent (null = missing). */
  ddRate(leader: string, t = this.deps.now()): number | null {
    const r = this.db
      .prepare("SELECT COUNT(dead) n, SUM(dead) s FROM dd_ledger WHERE leader = ? AND avail_at >= ? AND avail_at < ? AND done = 1")
      .get(leader, iso(t - WINDOW_7D_MS), iso(t)) as { n: number; s: number | null };
    return r.n ? r.s! / r.n : null;
  }

  /** Open rows in memory (for the server log and tests). */
  openRows(): number {
    return this.open.size;
  }
}
