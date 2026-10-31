/**
 * RUNNER-CATCHERS — wallets that keep buying runners early, scored against how often they buy launches that don't run.
 *
 * Over the last 30 days, for each wallet among the early buyers of runners (runners/define.ts):
 *   hits         distinct runners it bought early (among the first buyers, at ≤ RUNNER_EARLY_MAX_X the first price) that a
 *                copy could have followed: what a copy would have paid (our real delay later) was at most 1.5x its price,
 *                or unknown
 *   early buys   every launch it bought early, runner or not: what the live tape counted, or (for a wallet GodsEye has
 *                analyzed) its stored pump.fun buys at launch prices, whichever is larger
 *   hit rate     hits ÷ early buys, judged by its 95% Wilson lower bound against the base rate: the share of all early buys
 *                the tape saw that were runner buys. Buying every launch can't beat that; picking runners does.
 *   entry, capture   the median peak ÷ entry, and the median SOL back ÷ SOL in on what it sold
 * Labels: insider (made the coin, or funded by who did), sniper (most hits bought in the launch block), bot (the bot gate),
 * kol (tied to an X account, x/calls.ts), else organic. Insiders stay copyable; the label only says what they are.
 * A wallet qualifies with 3+ hits on 3+ days, a known hit rate whose lower bound beats the base rate.
 *
 * Wallets with 2+ hits that GodsEye doesn't know yet are added for analysis as SHADOW ONLY (wallets.shadow_only = 1):
 * analyzed and watched, never copied (learning/loop.ts). Observation only.
 */
import { type DB, nowIso } from "@godseye/shared";
import { say, short } from "../log";
import { addWallet } from "../discovery/discover";
import { wilson } from "../shadow/labels";
import { botCfg, botReason, botSigns } from "../smart/copy-check";
import { ensureRunnerTables } from "./schema";
import { PUMP_LAUNCH_PRICE_SOL, tapeSettings } from "./tape";

export const scoreSettings = {
  windowDays: 30,
  minHits: 3,
  minDays: 3,
  /** A copy that would have paid more than this multiple of the wallet's price couldn't follow it. */
  maxCopyX: 1.5,
  /** Hits needed before an unknown wallet is added for (shadow-only) analysis. */
  addMinHits: 2,
  maxAddsPerRun: 50,
};

export interface Hit {
  mint: string;
  day: string;
  entryX: number;
  xToPeak: number;
  soldPct: number;
  exitX: number | null;
  copyX: number | null;
  sniper: boolean;
}

export interface CatcherScore {
  hits: number;
  allHits: number;
  earlyBuys: number | null;
  hitRate: number | null;
  hitRateLb: number | null;
  days: number;
  medianEntryX: number | null;
  medianXToPeak: number | null;
  capture: number | null;
  copyableShare: number | null;
  sniperShare: number;
  qualifies: boolean;
  score: number;
}

const med = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Pure: one wallet's score from its runner hits, its early-buy count (null = unknown) and the base rate. */
export function scoreCatcher(hits: Hit[], earlyBuys: number | null, baseRate: number, s = scoreSettings): CatcherScore {
  const followable = hits.filter((h) => h.copyX === null || h.copyX <= s.maxCopyX);
  const known = hits.filter((h) => h.copyX !== null);
  const n = followable.length;
  const denom = earlyBuys === null ? null : Math.max(earlyBuys, n);
  const lb = denom ? wilson(n, denom)!.lo : null;
  const days = new Set(followable.map((h) => h.day)).size;
  const qualifies = n >= s.minHits && days >= s.minDays && lb !== null && lb > baseRate;
  // Lift over the base rate × hits: picking runners often beats picking one once.
  const score = lb !== null && baseRate > 0 ? (lb / baseRate) * n : n;
  const sold = followable.filter((h) => h.soldPct > 0 && h.exitX !== null);
  return {
    hits: n, allHits: hits.length, earlyBuys: denom, hitRate: denom ? n / denom : null, hitRateLb: lb, days,
    medianEntryX: med(followable.map((h) => h.entryX)), medianXToPeak: med(followable.map((h) => h.xToPeak)), capture: med(sold.map((h) => h.exitX!)),
    copyableShare: known.length ? known.filter((h) => h.copyX! <= s.maxCopyX).length / known.length : null,
    sniperShare: hits.length ? hits.filter((h) => h.sniper).length / hits.length : 0,
    qualifies, score,
  };
}

/** The share of all early buys the tape saw (last `days`) that were buys of runners. */
export function baseRate(db: DB, since: string): number {
  const day = since.slice(0, 10);
  const total = (db.prepare("SELECT COALESCE(SUM(early_buys), 0) n FROM runner_early_counts WHERE day >= ?").get(day) as { n: number }).n;
  const runnerBuys = (
    db.prepare(
      `SELECT COUNT(*) n FROM runner_buyers b JOIN runner_tokens t ON t.mint = b.mint
        WHERE t.is_runner = 1 AND t.source = 'stream' AND t.first_seen >= ? AND b.entry_x <= ?`,
    ).get(since, tapeSettings.earlyMaxX) as { n: number }
  ).n;
  return total > 0 ? runnerBuys / total : 0;
}

export function scoreCatchers(db: DB, now = Date.now(), s = scoreSettings): { wallets: number; qualifying: number; added: number; baseRate: number } {
  ensureRunnerTables(db);
  const since = new Date(now - s.windowDays * 86_400_000).toISOString();
  const base = baseRate(db, since);
  const rows = db
    .prepare(
      `SELECT b.wallet, b.mint, substr(t.first_seen, 1, 10) day, b.entry_x, b.x_to_peak, b.sold_pct, b.exit_x, b.copy_x, b.sniper
         FROM runner_buyers b JOIN runner_tokens t ON t.mint = b.mint
        WHERE t.is_runner = 1 AND t.first_seen >= ? AND b.entry_x <= ?`,
    )
    .all(since, tapeSettings.earlyMaxX) as { wallet: string; mint: string; day: string; entry_x: number; x_to_peak: number; sold_pct: number; exit_x: number | null; copy_x: number | null; sniper: number }[];
  const all = new Map<string, Hit[]>();
  for (const r of rows) {
    const list = all.get(r.wallet) ?? [];
    list.push({ mint: r.mint, day: r.day, entryX: r.entry_x, xToPeak: r.x_to_peak, soldPct: r.sold_pct, exitX: r.exit_x, copyX: r.copy_x, sniper: r.sniper === 1 });
    all.set(r.wallet, list);
  }
  // One runner is luck: only wallets with a second one are worth the queries below (this runs inside the agent).
  const byWallet = new Map([...all].filter(([, h]) => h.length >= s.addMinHits));

  const tapeCount = db.prepare("SELECT COALESCE(SUM(early_buys), 0) n FROM runner_early_counts WHERE wallet = ? AND day >= ?");
  const analyzed = db.prepare("SELECT last_analyzed_at FROM wallets WHERE address = ?");
  const storedCount = db.prepare(
    `SELECT COUNT(DISTINCT mint) n FROM wallet_swaps WHERE wallet = ? AND side = 'buy' AND mint LIKE '%pump' AND price_sol <= ? AND ts >= ?`,
  );
  const madeIt = db.prepare(
    `SELECT 1 FROM token_info t WHERE t.mint IN (SELECT mint FROM runner_buyers WHERE wallet = ?) AND (t.creator = ? OR t.creator = (SELECT funder FROM wallets WHERE address = ?)) LIMIT 1`,
  );
  const handle = db.prepare(
    "SELECT a.username FROM x_wallet_links l JOIN x_accounts a ON a.id = l.author_id WHERE l.wallet = ? ORDER BY l.how = 'bio' DESC, l.n DESC LIMIT 1",
  );
  const prior = db.prepare("SELECT first_added_at FROM runner_catchers WHERE wallet = ?");
  const upsert = db.prepare(
    `INSERT OR REPLACE INTO runner_catchers (wallet, hits, early_buys, hit_rate, hit_rate_lb, base_rate, days, median_entry_x, median_x_to_peak, capture,
       copyable_share, label, x_handle, score, qualifies, first_added_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const signs = botSigns(db, [...byWallet.keys()]);
  const bCfg = botCfg();
  const ts = nowIso();
  let qualifying = 0;
  const toAdd: { wallet: string; hits: number; score: number }[] = [];
  db.transaction(() => {
    db.prepare("DELETE FROM runner_catchers").run();
    for (const [wallet, hits] of byWallet) {
      const isAnalyzed = !!(analyzed.get(wallet) as { last_analyzed_at: string | null } | undefined)?.last_analyzed_at;
      const fromTape = (tapeCount.get(wallet, since.slice(0, 10)) as { n: number }).n;
      const fromSwaps = isAnalyzed ? (storedCount.get(wallet, PUMP_LAUNCH_PRICE_SOL * tapeSettings.earlyMaxX, since) as { n: number }).n : 0;
      // Unknown until the tape has seen it buy launches or GodsEye has read its history.
      const early = fromTape || fromSwaps ? Math.max(fromTape, fromSwaps) : null;
      const sc = scoreCatcher(hits, early, base, s);
      if (sc.hits === 0) continue;
      const x = (handle.get(wallet) as { username: string } | undefined)?.username ?? null;
      const sign = signs.get(wallet);
      const label = madeIt.get(wallet, wallet, wallet) ? "insider"
        : sc.sniperShare > 0.5 ? "sniper"
        : sign && botReason(sign, bCfg) ? "bot"
        : x ? "kol"
        : "organic";
      if (sc.qualifies) qualifying++;
      upsert.run(
        wallet, sc.hits, sc.earlyBuys ?? 0, sc.hitRate ?? 0, sc.hitRateLb ?? 0, base, sc.days, sc.medianEntryX, sc.medianXToPeak, sc.capture, sc.copyableShare,
        label, x, sc.score, sc.qualifies ? 1 : 0, (prior.get(wallet) as { first_added_at: string } | undefined)?.first_added_at ?? ts, ts,
      );
      if (sc.hits >= s.addMinHits) toAdd.push({ wallet, hits: sc.hits, score: sc.score });
    }
  })();

  // Unknown wallets with enough hits: analyzed and watched, never copied.
  let added = 0;
  const shadow = db.prepare("UPDATE wallets SET shadow_only = 1 WHERE address = ?");
  for (const w of toAdd.sort((a, b) => b.score - a.score)) {
    if (added >= s.maxAddsPerRun) break;
    if (addWallet(db, w.wallet, "runner_catcher", `bought ${w.hits} runners early`)) {
      shadow.run(w.wallet);
      added++;
      if (added <= 3) say("wallet", `Runner research: ${short(w.wallet)} bought ${w.hits} runners early — added for analysis (shadow only, never copied).`);
    }
  }
  return { wallets: byWallet.size, qualifying, added, baseRate: base };
}
