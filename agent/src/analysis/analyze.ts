/**
 * ANALYSIS — turning a wallet address into a public profile.
 *
 * For each wallet (new ones first, then the least recently checked):
 *   1. read its new transactions and keep the SOL-priced swaps
 *   2. first time only: find its first transaction → age, "fresh" or not, and who funded it
 *   3. look up when each token it bought launched → how early it buys
 *   4. compute realized P&L, win rate, etc.
 *   5. gather evidence (creator links, sales right before a crash — see crash.ts)
 *   6. assign a tier and an AI / human verdict, with reasons
 */
import { type DB, isNonMemecoinSymbol, nowIso, SOL_MINT, type Tier } from "@godseye/shared";
import { config } from "../config";
import { say, short } from "../log";
import { mintLaunchBefore, readWalletHistory } from "../chain/history";
import { rpcCallsSoFar, rpcUsage } from "../chain/rpc-budget";
import type { ParsedSwap } from "../chain/parse";
import { cachedTokenInfo, launchDue, recordLaunch, tokenInfo } from "../market/tokens";
import { getPrices } from "../market/prices";
import { classify } from "./classifier";
import { computeStats, realize, type SwapLite } from "./pnl";
import { assignTier, STATE_EVIDENCE, type TierInput } from "./tiers";
import { checkExit, isCrashExit } from "./crash";

/** Wallets whose public page changed since the last publish (for the hosted website). */
export const dirtyWallets = new Set<string>();

interface WalletRowDb {
  address: string;
  tier: Tier;
  funder: string | null;
  is_fresh: number;
  chain_created_at: string | null;
  last_signature: string | null;
  last_analyzed_at: string | null;
  tx_per_hour: number | null;
}

/** Where an analysis run's time goes (milliseconds), reset at the start of each run. */
const runTime = { history: 0, launches: 0, creators: 0, crashes: 0 };
async function timed<T>(key: keyof typeof runTime, fn: () => Promise<T>): Promise<T> {
  const t = Date.now();
  try {
    return await fn();
  } finally {
    runTime[key] += Date.now() - t;
  }
}

/** How many token launch lookups one analysis run may make (GeckoTerminal is rate-limited). */
const TOKEN_LOOKUPS_PER_RUN = 20;
const CREATOR_LOOKUPS_PER_WALLET = 5;
/** Candle lookups for "sold before a crash" per analysis run (each sale is checked once, then cached). */
const CRASH_CHECKS_PER_RUN = 12;

export function insertSwaps(db: DB, swaps: ParsedSwap[]): number {
  const ins = db.prepare(
    `INSERT OR IGNORE INTO wallet_swaps (wallet, signature, slot, ts, mint, side, token_amount, token_balance_before, sol_amount, price_sol, venue, jito_tip, fee_lamports, token_age_sec, quote, quote_amount, sol_usd, usd_amount)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let n = 0;
  db.transaction(() => {
    for (const s of swaps) {
      const launched = cachedTokenInfo(db, s.mint)?.pool_created_at;
      const age = launched ? (Date.parse(s.ts) - Date.parse(launched)) / 1000 : null;
      n += ins.run(s.wallet, s.signature, s.slot, s.ts, s.mint, s.side, s.tokenAmount, s.tokenBalanceBefore, s.solAmount, s.priceSol, s.venue, s.jitoTip ? 1 : 0, s.feeLamports, age !== null && age >= 0 ? age : null, s.quote, s.quoteAmount, s.solUsd, s.usdAmount).changes;
    }
  })();
  return n;
}

/** Coins per wallet whose launch time is looked up in one analysis (each costs 1–4 RPC calls). */
const LAUNCH_MINTS_PER_WALLET = 25;
const LAUNCH_LOOKUPS_IN_FLIGHT = 5;
/** RugCheck creator lookups per run: only for coins whose creator Solana couldn't give (slow, rate-limited). */
const RUGCHECK_LOOKUPS_PER_RUN = 20;

/**
 * Fill in "seconds after launch" for this wallet's buys. Launch times come from Solana first (the mint's
 * first transaction: cheap, and the true launch), and from GeckoTerminal only when Solana can't settle it.
 */
async function fillTokenAges(db: DB, wallet: string, budget: { left: number }): Promise<void> {
  const missing = db
    .prepare(
      `SELECT mint, MIN(ts) first_ts,
              (SELECT signature FROM wallet_swaps f WHERE f.wallet = w.wallet AND f.mint = w.mint AND f.side = 'buy' ORDER BY f.ts LIMIT 1) first_sig
         FROM wallet_swaps w WHERE wallet = ? AND side = 'buy' AND token_age_sec IS NULL
        GROUP BY mint ORDER BY MAX(ts) DESC LIMIT ?`,
    )
    .all(wallet, LAUNCH_MINTS_PER_WALLET) as { mint: string; first_ts: string; first_sig: string }[];
  const setAges = (mint: string, launchAt: string) =>
    db.prepare(
      `UPDATE wallet_swaps SET token_age_sec = MAX(0, (julianday(ts) - julianday(?)) * 86400.0)
        WHERE wallet = ? AND mint = ? AND token_age_sec IS NULL AND ts >= ?`,
    ).run(launchAt, wallet, mint, launchAt);
  // A few coins at a time: each is a couple of RPC calls, mostly waiting on the network.
  let next = 0;
  const one = async ({ mint, first_ts, first_sig }: (typeof missing)[number]) => {
    let info = cachedTokenInfo(db, mint);
    if (info?.pool_created_at) {
      setAges(mint, info.pool_created_at);
      return;
    }
    // 1) Solana: walk the mint's history back from this wallet's first buy.
    const chain = await mintLaunchBefore(mint, first_sig, first_ts).catch(() => null);
    if (chain?.exact) {
      recordLaunch(db, mint, chain.at, chain.creator);
      setAges(mint, chain.at);
      return;
    }
    // Not the very first transaction, but already old enough at the first buy: ages are lower bounds,
    // which is all "early buy" needs (they can't be early).
    if (chain && (Date.parse(first_ts) - Date.parse(chain.at)) / 1000 > config.earlyBuySeconds) {
      setAges(mint, chain.at);
      return;
    }
    // 2) GeckoTerminal (rate-limited): very busy launches, or when Solana couldn't answer.
    if (launchDue(info) && budget.left > 0) {
      budget.left--;
      info = await tokenInfo(db, mint, { launch: true }).catch(() => null);
      if (info?.pool_created_at) setAges(mint, info.pool_created_at);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(LAUNCH_LOOKUPS_IN_FLIGHT, missing.length) }, async () => {
      while (next < missing.length) await one(missing[next++]);
    }),
  );
}

/**
 * Recompute a wallet's P&L stats from the swaps already stored (no network).
 * Memecoins only: drops stored swaps of tokens whose looked-up symbol says otherwise (e.g. EURC).
 */
export function recomputeStats(db: DB, address: string, now = Date.now()) {
  const symbolsNow = db
    .prepare("SELECT DISTINCT s.mint, t.symbol FROM wallet_swaps s JOIN token_info t ON t.mint = s.mint WHERE s.wallet = ? AND t.symbol IS NOT NULL")
    .all(address) as { mint: string; symbol: string }[];
  const drop = symbolsNow.filter((x) => isNonMemecoinSymbol(x.symbol)).map((x) => x.mint);
  if (drop.length) db.prepare(`DELETE FROM wallet_swaps WHERE wallet = ? AND mint IN (${drop.map(() => "?").join(",")})`).run(address, ...drop);
  const swaps = db
    .prepare("SELECT signature, ts, mint, side, token_amount, sol_amount, usd_amount, price_sol, venue, jito_tip, token_age_sec FROM wallet_swaps WHERE wallet = ? ORDER BY ts")
    .all(address) as SwapLite[];
  const r = realize(swaps, config.earlyBuySeconds);
  const stats = computeStats(swaps, r, now, config.earlyBuySeconds);
  db.prepare(
    `INSERT INTO wallet_stats (wallet, computed_at, swaps_total, swaps_7d, swaps_30d, pnl_7d_sol, pnl_30d_sol, pnl_all_sol, pnl_7d_usd, pnl_30d_usd, pnl_all_usd,
        closed_7d, closed_30d, wins_30d, win_rate_30d, best_trade_share, avg_buy_sol, avg_buy_usd, avg_hold_minutes, early_buys, early_buy_rate, first_trade_at, last_trade_at)
     VALUES (@wallet, @computed_at, @swaps_total, @swaps_7d, @swaps_30d, @pnl_7d_sol, @pnl_30d_sol, @pnl_all_sol, @pnl_7d_usd, @pnl_30d_usd, @pnl_all_usd,
        @closed_7d, @closed_30d, @wins_30d, @win_rate_30d, @best_trade_share, @avg_buy_sol, @avg_buy_usd, @avg_hold_minutes, @early_buys, @early_buy_rate, @first_trade_at, @last_trade_at)
     ON CONFLICT(wallet) DO UPDATE SET computed_at=excluded.computed_at, swaps_total=excluded.swaps_total, swaps_7d=excluded.swaps_7d, swaps_30d=excluded.swaps_30d,
        pnl_7d_sol=excluded.pnl_7d_sol, pnl_30d_sol=excluded.pnl_30d_sol, pnl_all_sol=excluded.pnl_all_sol,
        pnl_7d_usd=excluded.pnl_7d_usd, pnl_30d_usd=excluded.pnl_30d_usd, pnl_all_usd=excluded.pnl_all_usd,
        closed_7d=excluded.closed_7d, closed_30d=excluded.closed_30d, wins_30d=excluded.wins_30d, win_rate_30d=excluded.win_rate_30d,
        best_trade_share=excluded.best_trade_share, avg_buy_sol=excluded.avg_buy_sol, avg_buy_usd=excluded.avg_buy_usd,
        avg_hold_minutes=excluded.avg_hold_minutes, early_buys=excluded.early_buys, early_buy_rate=excluded.early_buy_rate,
        first_trade_at=excluded.first_trade_at, last_trade_at=excluded.last_trade_at`,
  ).run({ wallet: address, computed_at: nowIso(), ...stats });
  return { swaps, r, stats };
}

/** Recompute stats for every analyzed wallet from stored swaps (fast; used after P&L rules change). */
export function recomputeAllStats(db: DB): number {
  const rows = db.prepare("SELECT address FROM wallets WHERE last_analyzed_at IS NOT NULL").all() as { address: string }[];
  db.transaction(() => rows.forEach((w) => recomputeStats(db, w.address)))();
  return rows.length;
}

export async function analyzeWallet(
  db: DB,
  address: string,
  budget = { left: TOKEN_LOOKUPS_PER_RUN },
  crashBudget = { left: CRASH_CHECKS_PER_RUN },
  rugBudget = { left: RUGCHECK_LOOKUPS_PER_RUN },
): Promise<void> {
  const row = db.prepare("SELECT * FROM wallets WHERE address = ?").get(address) as WalletRowDb | undefined;
  if (!row) return;
  const firstLook = !row.last_analyzed_at;
  const now = Date.now();

  // 1–2) New transactions (+ origin on first look)
  const h = await timed("history", () => readWalletHistory(address, {
    sinceSignature: row.last_signature,
    limit: firstLook ? config.historyTxLimit : 1000,
    findOrigin: firstLook,
    // First look: the last HISTORY_DAYS days, capped at HISTORY_TX_LIMIT transactions.
    sinceMs: firstLook ? now - config.historyDays * 86_400_000 : undefined,
  }));
  insertSwaps(db, h.swaps);
  let { funder, chain_created_at: createdAt, is_fresh: isFresh } = row;
  let lowerBound = 0;
  let txPerHour = row.tx_per_hour;
  if (firstLook) {
    const spanHours = h.oldestSeenAt ? (now - Date.parse(h.oldestSeenAt)) / 3_600_000 : 0;
    txPerHour = h.signaturesSeen >= 20 ? h.signaturesSeen / Math.max(0.25, spanHours) : null;
    createdAt = h.oldestSeenAt;
    lowerBound = h.reachedOrigin ? 0 : 1;
    funder = h.funder;
    isFresh = h.reachedOrigin && createdAt !== null && now - Date.parse(createdAt) < config.freshWalletDays * 86_400_000 ? 1 : 0;
  } else if (isFresh && createdAt && now - Date.parse(createdAt) >= config.freshWalletDays * 86_400_000) {
    isFresh = 0;
  }

  // 3) How early it buys
  await timed("launches", () => fillTokenAges(db, address, budget));

  // 4) Performance
  const { swaps, r, stats } = recomputeStats(db, address, now);

  // 5) Evidence
  const symbols = new Map<string, string>();
  for (const m of new Set(swaps.map((s) => s.mint))) {
    const sym = cachedTokenInfo(db, m)?.symbol;
    if (sym) symbols.set(m, sym);
  }
  const sym = (m: string) => symbols.get(m) ?? `${m.slice(0, 4)}…`;

  const creatorLinks: TierInput["creatorLinks"] = [];
  const earlyMints = [...new Set(swaps.filter((s) => s.side === "buy" && s.token_age_sec !== null && s.token_age_sec <= config.earlyBuySeconds).map((s) => s.mint))];
  for (const mint of earlyMints.slice(0, CREATOR_LOOKUPS_PER_WALLET)) {
    // Usually known already: read from the mint's first transaction while finding its launch time.
    let info = cachedTokenInfo(db, mint);
    if (info?.creator === null && rugBudget.left > 0) {
      rugBudget.left--;
      info = await timed("creators", () => tokenInfo(db, mint, { creator: true })).catch(() => null);
    }
    if (!info?.creator) continue;
    const firstBuy = swaps.find((s) => s.mint === mint && s.side === "buy")!;
    if (info.creator === address) creatorLinks.push({ mint, symbol: sym(mint), relation: "is_creator", signature: firstBuy.signature, ts: firstBuy.ts });
    else if (funder && info.creator === funder) creatorLinks.push({ mint, symbol: sym(mint), relation: "funded_by_creator", signature: firstBuy.signature, ts: firstBuy.ts });
  }

  // Profitable exits in the last 30 days, newest first: did the price crash right after? (cached per sale)
  const crashExits: TierInput["crashExits"] = [];
  const exits = r.closed.filter((c) => c.pnlSol > 0 && now - Date.parse(c.closedAt) < 30 * 86_400_000).reverse();
  for (const c of exits) {
    const j = await timed("crashes", () => checkExit(db, { mint: c.mint, signature: c.lastSellSignature, ts: c.closedAt, sellPriceSol: c.lastSellPriceSol }, config, crashBudget));
    if (isCrashExit(j ?? null, config)) crashExits.push({ mint: c.mint, symbol: sym(c.mint), dropPct: j!.dropPct, minutesToLow: j!.minutesToLow, signature: c.lastSellSignature, ts: c.closedAt });
  }

  // 6) Tier + AI/human
  const groupSize = funder ? (db.prepare("SELECT COUNT(*) n FROM wallets WHERE funder = ?").get(funder) as { n: number }).n + (row.funder ? 0 : 1) : 1;
  const funderRow = funder ? (db.prepare("SELECT address, tier FROM wallets WHERE address = ?").get(funder) as { address: string; tier: Tier } | undefined) : undefined;
  const t = assignTier({
    stats, closed: r.closed, now, isFresh: isFresh === 1, groupSize, funderTracked: funderRow ?? null, previousTier: row.tier,
    creatorLinks, crashExits, symbols,
    cfg: {
      quitAfterDays: config.quitAfterDays, minClosedForProven: config.minClosedForProven, earlyBuySeconds: config.earlyBuySeconds,
      crashMinExits: config.crashMinExits, crashMinShare: config.crashMinShare,
    },
  });
  const c = classify(swaps, { txPerHour });

  db.transaction(() => {
    db.prepare(
      `UPDATE wallets SET tier=?, tier_reason=?, tier_changed_at=CASE WHEN tier != ? THEN ? ELSE tier_changed_at END,
          kind=?, ai_score=?, kind_reasons=?, tx_per_hour=?, funder=?, chain_created_at=?, age_is_lower_bound=CASE WHEN ? THEN ? ELSE age_is_lower_bound END,
          is_fresh=?, last_analyzed_at=?, last_activity_at=COALESCE(?, last_activity_at), last_signature=?, analyze_errors=0,
          history_from=CASE WHEN ? THEN ? ELSE COALESCE(history_from, ?) END,
          history_oldest_sig=CASE WHEN ? THEN ? ELSE history_oldest_sig END,
          history_tx_read=history_tx_read + CASE WHEN ? THEN ? ELSE 0 END,
          history_done=CASE WHEN ? THEN ? ELSE history_done END
        WHERE address=?`,
    ).run(t.tier, t.reason, t.tier, nowIso(), c.kind, c.score, JSON.stringify(c.reasons), txPerHour, funder, createdAt, firstLook ? 1 : 0, lowerBound,
      isFresh, nowIso(), stats.last_trade_at ?? h.activityAt, h.newestSignature, firstLook ? 1 : 0, h.historyFrom ?? stats.first_trade_at, stats.first_trade_at,
      firstLook ? 1 : 0, h.oldestSignature, firstLook ? 1 : 0, h.read, firstLook ? 1 : 0, h.historyDone ? 1 : 0, address);
    // "State" evidence (e.g. inactive, slipping) describes now, so it's replaced; event evidence (a specific trade) is kept.
    db.prepare(`DELETE FROM wallet_evidence WHERE wallet = ? AND kind IN (${STATE_EVIDENCE.map(() => "?").join(",")})`).run(address, ...STATE_EVIDENCE);
    const ev = db.prepare(
      `INSERT INTO wallet_evidence (wallet, kind, detail, mint, signature, ts) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(wallet, kind, mint, signature) DO UPDATE SET detail = excluded.detail, ts = excluded.ts`,
    );
    for (const e of t.evidence) ev.run(address, e.kind, e.detail, e.mint ?? "", e.signature ?? "", e.ts);
  })();
  dirtyWallets.add(address);

  if (t.tier !== row.tier && (t.tier !== "unrated" || row.tier !== "unrated")) {
    say("wallet", `${short(address)} → ${t.tier.replace("_", " ")} (${c.kind === "ai" ? "AI/bot" : c.kind}${c.score !== null ? ` ${c.score}` : ""}): ${t.reason}`);
  }
  if (firstLook && isFresh) say("wallet", `Fresh wallet ${short(address)} (created ${createdAt?.slice(0, 16).replace("T", " ")} UTC${funder ? `, funded by ${short(funder)}` : ""}) — grouped and classified ${c.kind === "ai" ? "AI/bot" : c.kind}.`);
}

/**
 * Read further back in a wallet's history: from the oldest transaction read so far, back to HISTORY_DAYS
 * days or until HISTORY_TX_LIMIT transactions have been read in all. Returns transactions read.
 */
export async function deepenHistory(db: DB, address: string, now = Date.now()): Promise<number> {
  const row = db.prepare("SELECT history_oldest_sig, history_tx_read FROM wallets WHERE address = ?").get(address) as
    | { history_oldest_sig: string | null; history_tx_read: number }
    | undefined;
  if (!row) return 0;
  const before = row.history_oldest_sig ?? (db.prepare("SELECT signature FROM wallet_swaps WHERE wallet = ? ORDER BY ts LIMIT 1").get(address) as { signature: string } | undefined)?.signature;
  const left = config.historyDeepTxLimit - row.history_tx_read;
  if (!before || left <= 0) {
    db.prepare("UPDATE wallets SET history_done = 1 WHERE address = ?").run(address);
    return 0;
  }
  const h = await timed("history", () => readWalletHistory(address, { sinceSignature: null, before, limit: left, findOrigin: false, sinceMs: now - config.historyDays * 86_400_000 }));
  insertSwaps(db, h.swaps);
  db.prepare(
    `UPDATE wallets SET
        history_from = CASE WHEN ? IS NOT NULL AND (history_from IS NULL OR ? < history_from) THEN ? ELSE history_from END,
        history_oldest_sig = COALESCE(?, history_oldest_sig),
        history_tx_read = history_tx_read + ?,
        history_done = ?
      WHERE address = ?`,
  ).run(h.historyFrom, h.historyFrom, h.historyFrom, h.oldestSignature, h.read, h.historyDone || h.read === 0 ? 1 : 0, address);
  return h.read;
}

/** Analyze the wallets most in need of it: never-analyzed first, then the stalest. Leaders always get a turn. */
export async function runAnalysis(db: DB, limit = config.analyzePerRun): Promise<number> {
  const callsBefore = rpcCallsSoFar();
  const startedAt = Date.now();
  for (const k of Object.keys(runTime) as (keyof typeof runTime)[]) runTime[k] = 0;
  const staleBefore = new Date(Date.now() - config.reanalyzeMinutes * 60_000).toISOString();
  const rows = db
    .prepare(
      `SELECT address FROM wallets
        WHERE analyze_errors < 5 AND (last_analyzed_at IS NULL OR last_analyzed_at < ?)
        ORDER BY last_analyzed_at IS NOT NULL, copy_weight > 0 DESC,
                 -- never studied: wallets the live stream saw making money first, then the newest found
                 (last_analyzed_at IS NULL AND discovered_via = 'live_stream') DESC,
                 CASE WHEN last_analyzed_at IS NULL THEN first_seen_at END DESC,
                 last_analyzed_at
        LIMIT ?`,
    )
    .all(staleBefore, limit) as { address: string }[];
  const budget = { left: TOKEN_LOOKUPS_PER_RUN };
  const crashBudget = { left: CRASH_CHECKS_PER_RUN };
  const rugBudget = { left: RUGCHECK_LOOKUPS_PER_RUN };
  let done = 0;
  // Several wallets at once: each is mostly waiting on the network; the RPC budget sets the overall pace.
  let next = 0;
  const worker = async () => {
    while (next < rows.length) {
      const { address } = rows[next++];
      try {
        await analyzeWallet(db, address, budget, crashBudget, rugBudget);
        done++;
      } catch (e) {
        db.prepare("UPDATE wallets SET analyze_errors = analyze_errors + 1 WHERE address = ?").run(address);
        say("warn", `Couldn't analyze ${short(address)}: ${(e as Error).message.slice(0, 140)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(config.analyzeConcurrency, rows.length)) }, worker));
  // Wallets studied before history was read by days: read further back, copied wallets first.
  let deepened = 0;
  let deepTx = 0;
  const deepen = db
    .prepare(
      `SELECT w.address FROM wallets w
         LEFT JOIN wallet_stats s ON s.wallet = w.address
         LEFT JOIN smart_wallets sm ON sm.address = w.address AND sm.active = 1
        WHERE w.last_analyzed_at IS NOT NULL AND w.history_done = 0 AND w.analyze_errors < 5
          -- deep history only where it matters: wallets GodsEye copies or follows, or that are making money
          AND (w.copy_weight > 0 OR sm.address IS NOT NULL OR w.tier IN ('proven', 'insider') OR (s.pnl_30d_usd > 0 AND s.closed_30d >= 3))
        ORDER BY w.copy_weight > 0 DESC, sm.address IS NOT NULL DESC, w.tier = 'proven' DESC, s.pnl_30d_usd DESC
        LIMIT ?`,
    )
    .all(config.historyDeepenPerRun) as { address: string }[];
  await Promise.all(deepen.map(async ({ address }) => {
    try {
      deepTx += await deepenHistory(db, address);
      await analyzeWallet(db, address, budget, crashBudget, rugBudget); // re-score with the longer history
      deepened++;
    } catch (e) {
      // e.g. the RPC can't find the stored cursor transaction: keep the history it has and stop retrying,
      // or this wallet would take a deepening slot every run.
      db.prepare("UPDATE wallets SET history_done = 1 WHERE address = ?").run(address);
      say("warn", `Couldn't read further back for ${short(address)}, keeping the history it has: ${(e as Error).message.slice(0, 200)}`);
    }
  }));
  if (done || deepened) {
    const calls = rpcCallsSoFar() - callsBefore;
    const secs = Math.max(1, (Date.now() - startedAt) / 1000);
    say(
      "info",
      `Analyzed ${done} wallet${done === 1 ? "" : "s"}${deepened ? `, read further back for ${deepened} (${deepTx.toLocaleString("en-US")} older transactions)` : ""} · ${calls.toLocaleString("en-US")} RPC requests in ${Math.round(secs)}s (${(calls / secs).toFixed(1)}/sec, cap ${config.rpcMaxRps}/sec, ${(rpcUsage(Math.ceil(secs / 60)).throttled).toLocaleString("en-US")} rate-limited). Time: transactions ${Math.round(runTime.history / 1000)}s, coin launch times ${Math.round(runTime.launches / 1000)}s, creators ${Math.round(runTime.creators / 1000)}s, crash checks ${Math.round(runTime.crashes / 1000)}s.`,
    );
  }
  return done;
}
