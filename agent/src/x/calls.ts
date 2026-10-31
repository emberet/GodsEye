/**
 * WHO CALLS RUNNERS ON X — accounts that post a coin before it runs, and the wallets behind them.
 *
 *   1. Search: each runner (runners/define.ts) is searched on X from an hour before its first trade to an hour after its
 *      peak: its mint address, or its $TICKER next to pump / sol / solana / CA. The same number of coins that drew a crowd
 *      but didn't run are searched too, from an hour before to 6 hours after their first trade: the control. Without it,
 *      an account that posts every new coin would look like it calls every runner.
 *   2. Score: per account over 30 days, the runners it posted before they reached 3x ("early calls") against the
 *      non-runners it posted, the latter scaled up to all non-runners (only a sample was searched). Its hit rate's
 *      Wilson lower bound against the share of crowd coins that run; how many minutes ahead of the 3x; distinct days.
 *   3. Wallets: an address posted in the account's bio or tweets that trades (wallet_activity / runner buyers), or a
 *      wallet that bought the same coin within 2 minutes before the account's post, on 3+ different coins.
 * Observation only: nothing here buys anything.
 */
import { type DB, nowIso } from "@godseye/shared";
import { config } from "../config";
import { say } from "../log";
import { isWallet } from "../market/holders";
import { wilson } from "../shadow/labels";
import { ensureRunnerTables } from "../runners/schema";
import { searchAll, tweetsReadThisMonth, type XTweet, type XUser, xConfigured } from "./client";

const HOUR = 3_600_000;
/** X refuses an end_time less than ~10 s ago. */
const END_MARGIN_MS = 30_000;
const TIMING_WINDOW_MS = 2 * 60_000;
const TIMING_MIN_COINS = 3;
const ADDRESS = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;

/** Pure: the search for one coin. A ticker is only used when it is a plain word (a cashtag can't hold anything else). */
export function buildQuery(mint: string, symbol: string | null): string {
  const tag = symbol && /^[A-Za-z][A-Za-z0-9_]{0,14}$/.test(symbol) ? `($${symbol} (pump OR pumpfun OR sol OR solana OR CA))` : null;
  return `(${mint}${tag ? ` OR ${tag}` : ""}) -is:retweet`;
}

/** Pure: the window searched for a coin, clamped to what X allows (ends at least 30 s ago, starts before it ends). */
export function searchWindow(kind: "runner" | "control", firstSeen: number, peakAt: number, now = Date.now()): { from: string; to: string } | null {
  const fromMs = firstSeen - HOUR;
  const toMs = Math.min(now - END_MARGIN_MS, kind === "runner" ? Math.max(peakAt, firstSeen) + HOUR : firstSeen + 6 * HOUR, fromMs + 3 * 24 * HOUR);
  return toMs > fromMs + 60_000 ? { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() } : null;
}

/** Pure: addresses in a text that could be wallets (on-curve keys), minus `exclude` (the coin itself, known mints). */
export function addressesIn(text: string | undefined, exclude: Set<string>): string[] {
  return [...new Set(text?.match(ADDRESS) ?? [])].filter((a) => !exclude.has(a) && isWallet(a));
}

interface CoinRow {
  mint: string;
  symbol: string | null;
  first_seen: string;
  peak_at: string;
  x3_at: string | null;
}

function storeResults(db: DB, mint: string, tweets: XTweet[], users: XUser[]): void {
  const post = db.prepare(
    `INSERT OR IGNORE INTO x_posts (id, mint, author_id, ts, text, likes, reposts, replies, quotes, impressions, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const account = db.prepare(
    `INSERT OR REPLACE INTO x_accounts (id, username, name, followers, created_at, description, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const ts = nowIso();
  db.transaction(() => {
    for (const t of tweets) {
      const m = t.public_metrics ?? {};
      post.run(t.id, mint, t.author_id, t.created_at, t.text, m.like_count ?? null, m.retweet_count ?? null, m.reply_count ?? null, m.quote_count ?? null, m.impression_count ?? null, ts);
    }
    for (const u of users) account.run(u.id, u.username, u.name ?? null, u.public_metrics?.followers_count ?? null, u.created_at ?? null, u.description ?? null, ts);
  })();
}

/** Search up to `limit` coins not searched yet: half runners (newest first), half crowd coins that didn't run. */
export async function searchCoins(db: DB, limit: number, now = Date.now()): Promise<{ searched: number; tweets: number; capped: boolean }> {
  ensureRunnerTables(db);
  const since = new Date(now - 30 * 24 * HOUR).toISOString();
  const pick = (runner: number, n: number) =>
    db
      .prepare(
        `SELECT t.mint, COALESCE(t.symbol, i.symbol) symbol, t.first_seen, t.peak_at, t.x3_at FROM runner_tokens t LEFT JOIN token_info i ON i.mint = t.mint
          WHERE t.is_runner = ? AND t.first_seen >= ? AND t.buyers >= 15 AND t.mint NOT IN (SELECT mint FROM x_searches)
          ORDER BY ${runner ? "t.first_seen DESC" : "random()"} LIMIT ?`,
      )
      .all(runner, since, n) as CoinRow[];
  const runners = pick(1, Math.ceil(limit / 2));
  const controls = pick(0, Math.max(runners.length, 1));
  const record = db.prepare("INSERT OR REPLACE INTO x_searches (mint, kind, window_from, window_to, ran_at, tweets, searched_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
  let searched = 0;
  let tweets = 0;
  for (const [kind, c] of [...runners.map((c) => ["runner", c] as const), ...controls.map((c) => ["control", c] as const)]) {
    const w = searchWindow(kind, Date.parse(c.first_seen), Date.parse(c.peak_at), now);
    if (!w) continue;
    const r = await searchAll(db, buildQuery(c.mint, c.symbol), w.from, w.to);
    if (r.capped) return { searched, tweets, capped: true };
    storeResults(db, c.mint, r.tweets, r.users);
    record.run(c.mint, kind, w.from, w.to, kind === "runner" ? c.x3_at : null, r.tweets.length, nowIso());
    searched++;
    tweets += r.tweets.length;
  }
  return { searched, tweets, capped: false };
}

/** Wallets tied to X accounts: addresses in bios and tweets that trade, and buyers who keep buying just before a post. */
export function linkWallets(db: DB): number {
  ensureRunnerTables(db);
  const mints = new Set((db.prepare("SELECT mint FROM x_searches").all() as { mint: string }[]).map((r) => r.mint));
  const trades = db.prepare("SELECT 1 FROM wallet_activity WHERE address = ? UNION ALL SELECT 1 FROM runner_buyers WHERE wallet = ? LIMIT 1");
  const link = db.prepare(
    `INSERT INTO x_wallet_links (author_id, wallet, how, n, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(author_id, wallet, how) DO UPDATE SET n = excluded.n, updated_at = excluded.updated_at`,
  );
  const ts = nowIso();
  let n = 0;
  const found = new Map<string, { author: string; wallet: string; how: "bio" | "tweet"; n: number }>();
  for (const a of db.prepare("SELECT id, description FROM x_accounts WHERE description IS NOT NULL").all() as { id: string; description: string }[]) {
    for (const w of addressesIn(a.description, mints)) if (trades.get(w, w)) found.set(`${a.id}:${w}:bio`, { author: a.id, wallet: w, how: "bio", n: 1 });
  }
  for (const p of db.prepare("SELECT author_id, mint, text FROM x_posts").all() as { author_id: string; mint: string; text: string }[]) {
    for (const w of addressesIn(p.text, mints)) {
      if (!trades.get(w, w)) continue;
      const k = `${p.author_id}:${w}:tweet`;
      const e = found.get(k) ?? { author: p.author_id, wallet: w, how: "tweet" as const, n: 0 };
      e.n++;
      found.set(k, e);
    }
  }
  // Timing: buyers of the coin in the 2 minutes before the account's first post about it.
  const timing = db
    .prepare(
      `WITH firstpost AS (SELECT author_id, mint, MIN(ts) ts FROM x_posts GROUP BY author_id, mint)
       SELECT f.author_id, b.wallet, COUNT(DISTINCT f.mint) n FROM firstpost f JOIN runner_buyers b ON b.mint = f.mint
        WHERE b.ts <= f.ts AND b.ts >= strftime('%Y-%m-%dT%H:%M:%fZ', f.ts, ?)
        GROUP BY f.author_id, b.wallet HAVING n >= ?`,
    )
    .all(`-${TIMING_WINDOW_MS / 1000} seconds`, TIMING_MIN_COINS) as { author_id: string; wallet: string; n: number }[];
  db.transaction(() => {
    for (const e of found.values()) n += link.run(e.author, e.wallet, e.how, e.n, ts).changes;
    for (const t of timing) n += link.run(t.author_id, t.wallet, "timing", t.n, ts).changes;
  })();
  return n;
}

export interface CallerInput {
  /** Runners posted before they reached 3x (or before the peak when the 3x time is unknown). */
  early: number;
  /** All runners posted. */
  runners: number;
  /** Non-runner (control) coins posted. */
  controls: number;
}

/**
 * Pure: an account's hit rate lower bound. Its control posts stand for `scale` times as many non-runners (the share of
 * non-runners searched), so an account that posts every coin is judged on every coin it would have posted.
 */
export function callerHitRateLb(c: CallerInput, scale: number): number {
  const misses = Math.round(c.controls * scale) + (c.runners - c.early);
  return wilson(c.early, c.early + misses)?.lo ?? 0;
}

/** Score every account that posted a searched coin (last 30 days). */
export function scoreCallers(db: DB, now = Date.now()): { callers: number; beating: number; baseRate: number } {
  ensureRunnerTables(db);
  const since = new Date(now - 30 * 24 * HOUR).toISOString();
  const pop = db.prepare("SELECT SUM(is_runner = 1) r, SUM(is_runner = 0) c FROM runner_tokens WHERE first_seen >= ? AND buyers >= 15").get(since) as { r: number | null; c: number | null };
  const searched = db.prepare("SELECT SUM(kind = 'runner') r, SUM(kind = 'control') c FROM x_searches WHERE window_from >= ?").get(since) as { r: number | null; c: number | null };
  const base = (pop.r ?? 0) + (pop.c ?? 0) > 0 ? (pop.r ?? 0) / ((pop.r ?? 0) + (pop.c ?? 0)) : 0;
  // How many non-runners each searched control stands for, relative to the runners (all of which get searched).
  const runnerCoverage = (pop.r ?? 0) > 0 ? Math.min(1, (searched.r ?? 0) / (pop.r ?? 1)) : 1;
  const controlCoverage = (pop.c ?? 0) > 0 ? Math.min(1, (searched.c ?? 0) / (pop.c ?? 1)) : 1;
  const scale = controlCoverage > 0 ? runnerCoverage / controlCoverage : 1;

  const rows = db
    .prepare(
      `SELECT p.author_id, a.username, a.followers, s.kind, p.mint, MIN(p.ts) first_post, s.ran_at, t.peak_at
         FROM x_posts p JOIN x_searches s ON s.mint = p.mint LEFT JOIN x_accounts a ON a.id = p.author_id LEFT JOIN runner_tokens t ON t.mint = p.mint
        WHERE s.window_from >= ? GROUP BY p.author_id, p.mint`,
    )
    .all(since) as { author_id: string; username: string | null; followers: number | null; kind: string; mint: string; first_post: string; ran_at: string | null; peak_at: string | null }[];
  const by = new Map<string, { username: string | null; followers: number | null; early: number; runners: number; controls: number; leads: number[]; days: Set<string> }>();
  for (const r of rows) {
    const e = by.get(r.author_id) ?? { username: r.username, followers: r.followers, early: 0, runners: 0, controls: 0, leads: [], days: new Set<string>() };
    if (r.kind === "runner") {
      e.runners++;
      const mark = r.ran_at ?? r.peak_at;
      if (mark && r.first_post < mark) {
        e.early++;
        e.leads.push((Date.parse(mark) - Date.parse(r.first_post)) / 60_000);
        e.days.add(r.first_post.slice(0, 10));
      }
    } else e.controls++;
    by.set(r.author_id, e);
  }
  const wallets = db.prepare("SELECT GROUP_CONCAT(wallet || ':' || how, ',') w FROM x_wallet_links WHERE author_id = ?");
  const upsert = db.prepare(
    `INSERT OR REPLACE INTO x_callers (author_id, username, followers, calls, runner_calls, early_runner_calls, control_calls, hit_rate_lb, median_lead_min, days,
       linked_wallets, score, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let beating = 0;
  const ts = nowIso();
  db.transaction(() => {
    db.prepare("DELETE FROM x_callers").run();
    for (const [id, e] of by) {
      const lb = callerHitRateLb(e, scale);
      if (lb > base && e.early >= 3 && e.days.size >= 3) beating++;
      const leads = [...e.leads].sort((a, b) => a - b);
      const median = leads.length ? leads[leads.length >> 1] : null;
      const score = base > 0 ? (lb / base) * e.early : e.early;
      upsert.run(id, e.username, e.followers, e.runners + e.controls, e.runners, e.early, e.controls, lb, median, e.days.size, (wallets.get(id) as { w: string | null }).w, score, ts);
    }
  })();
  return { callers: by.size, beating, baseRate: base };
}

/** The hourly X job: search new coins, tie accounts to wallets, score the callers. */
export async function runXResearch(db: DB): Promise<string | null> {
  if (!xConfigured()) return null;
  const s = await searchCoins(db, config.xCoinsPerHour);
  const links = linkWallets(db);
  const c = scoreCallers(db);
  const used = tweetsReadThisMonth(db);
  if (s.capped) say("warn", `X research: this month's tweet cap (${config.xMonthlyTweetCap.toLocaleString("en-US")}) is reached; searching again next month.`);
  return `X research: searched ${s.searched} coins (${s.tweets} tweets; ${used.toLocaleString("en-US")} read this month), ${links} wallet links, ${c.callers} accounts scored, ${c.beating} beat the base rate (${(c.baseRate * 100).toFixed(1)}% of crowd coins run).`;
}
