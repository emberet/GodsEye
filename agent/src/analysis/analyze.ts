/**
 * ANALYSIS — turning a wallet address into a public profile.
 *
 * For each wallet (new ones first, then the least recently checked):
 *   1. read its new transactions and keep the SOL-priced swaps
 *   2. first time only: find its first transaction → age, "fresh" or not, and who funded it
 *   3. look up when each token it bought launched → how early it buys
 *   4. compute realized P&L, win rate, etc.
 *   5. gather evidence (creator links, sells right before a crash)
 *   6. assign a tier and an AI / human verdict, with reasons
 */
import { type DB, nowIso, SOL_MINT, type Tier } from "@godseye/shared";
import { config } from "../config";
import { say, short } from "../log";
import { readWalletHistory } from "../chain/history";
import type { ParsedSwap } from "../chain/parse";
import { cachedTokenInfo, tokenInfo } from "../market/tokens";
import { getPrices } from "../market/prices";
import { classify } from "./classifier";
import { computeStats, realize, type SwapLite } from "./pnl";
import { assignTier, STATE_EVIDENCE, type TierInput } from "./tiers";

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

/** How many token launch lookups one analysis run may make (GeckoTerminal is rate-limited). */
const TOKEN_LOOKUPS_PER_RUN = 20;
const CREATOR_LOOKUPS_PER_WALLET = 5;

export function insertSwaps(db: DB, swaps: ParsedSwap[]): number {
  const ins = db.prepare(
    `INSERT OR IGNORE INTO wallet_swaps (wallet, signature, slot, ts, mint, side, token_amount, token_balance_before, sol_amount, price_sol, venue, jito_tip, fee_lamports, token_age_sec)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let n = 0;
  db.transaction(() => {
    for (const s of swaps) {
      const launched = cachedTokenInfo(db, s.mint)?.pool_created_at;
      const age = launched ? (Date.parse(s.ts) - Date.parse(launched)) / 1000 : null;
      n += ins.run(s.wallet, s.signature, s.slot, s.ts, s.mint, s.side, s.tokenAmount, s.tokenBalanceBefore, s.solAmount, s.priceSol, s.venue, s.jitoTip ? 1 : 0, s.feeLamports, age !== null && age >= 0 ? age : null).changes;
    }
  })();
  return n;
}

/** Fill in "seconds after launch" for buys whose token launch time is now known. */
async function fillTokenAges(db: DB, wallet: string, budget: { left: number }): Promise<void> {
  const missing = db
    .prepare("SELECT DISTINCT mint FROM wallet_swaps WHERE wallet = ? AND side = 'buy' AND token_age_sec IS NULL ORDER BY ts DESC LIMIT 25")
    .all(wallet) as { mint: string }[];
  for (const { mint } of missing) {
    let info = cachedTokenInfo(db, mint);
    if (!info && budget.left > 0) {
      budget.left--;
      info = await tokenInfo(db, mint).catch(() => null);
    }
    if (info?.pool_created_at) {
      db.prepare(
        `UPDATE wallet_swaps SET token_age_sec = MAX(0, (julianday(ts) - julianday(?)) * 86400.0)
          WHERE wallet = ? AND mint = ? AND token_age_sec IS NULL AND ts >= ?`,
      ).run(info.pool_created_at, wallet, mint, info.pool_created_at);
    }
  }
}

export async function analyzeWallet(db: DB, address: string, budget = { left: TOKEN_LOOKUPS_PER_RUN }): Promise<void> {
  const row = db.prepare("SELECT * FROM wallets WHERE address = ?").get(address) as WalletRowDb | undefined;
  if (!row) return;
  const firstLook = !row.last_analyzed_at;
  const now = Date.now();

  // 1–2) New transactions (+ origin on first look)
  const h = await readWalletHistory(address, {
    sinceSignature: row.last_signature,
    limit: firstLook ? config.historyTxLimit : 1000,
    findOrigin: firstLook,
  });
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
  await fillTokenAges(db, address, budget);

  // 4) Performance
  const swaps = db
    .prepare("SELECT signature, ts, mint, side, token_amount, sol_amount, price_sol, venue, jito_tip, token_age_sec FROM wallet_swaps WHERE wallet = ? ORDER BY ts")
    .all(address) as SwapLite[];
  const r = realize(swaps, config.earlyBuySeconds);
  const stats = computeStats(swaps, r, now, config.earlyBuySeconds);
  db.prepare(
    `INSERT INTO wallet_stats (wallet, computed_at, swaps_total, swaps_7d, swaps_30d, pnl_7d_sol, pnl_30d_sol, pnl_all_sol, closed_7d, closed_30d, wins_30d,
        win_rate_30d, best_trade_share, avg_buy_sol, avg_hold_minutes, early_buys, early_buy_rate, first_trade_at, last_trade_at)
     VALUES (@wallet, @computed_at, @swaps_total, @swaps_7d, @swaps_30d, @pnl_7d_sol, @pnl_30d_sol, @pnl_all_sol, @closed_7d, @closed_30d, @wins_30d,
        @win_rate_30d, @best_trade_share, @avg_buy_sol, @avg_hold_minutes, @early_buys, @early_buy_rate, @first_trade_at, @last_trade_at)
     ON CONFLICT(wallet) DO UPDATE SET computed_at=excluded.computed_at, swaps_total=excluded.swaps_total, swaps_7d=excluded.swaps_7d, swaps_30d=excluded.swaps_30d,
        pnl_7d_sol=excluded.pnl_7d_sol, pnl_30d_sol=excluded.pnl_30d_sol, pnl_all_sol=excluded.pnl_all_sol, closed_7d=excluded.closed_7d, closed_30d=excluded.closed_30d,
        wins_30d=excluded.wins_30d, win_rate_30d=excluded.win_rate_30d, best_trade_share=excluded.best_trade_share, avg_buy_sol=excluded.avg_buy_sol,
        avg_hold_minutes=excluded.avg_hold_minutes, early_buys=excluded.early_buys, early_buy_rate=excluded.early_buy_rate,
        first_trade_at=excluded.first_trade_at, last_trade_at=excluded.last_trade_at`,
  ).run({ wallet: address, computed_at: nowIso(), ...stats });

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
    const info = await tokenInfo(db, mint, { creator: true }).catch(() => null);
    if (!info?.creator) continue;
    const firstBuy = swaps.find((s) => s.mint === mint && s.side === "buy")!;
    if (info.creator === address) creatorLinks.push({ mint, symbol: sym(mint), relation: "is_creator", signature: firstBuy.signature, ts: firstBuy.ts });
    else if (funder && info.creator === funder) creatorLinks.push({ mint, symbol: sym(mint), relation: "funded_by_creator", signature: firstBuy.signature, ts: firstBuy.ts });
  }

  const recentExits = r.closed.filter((c) => c.pnlSol > 0 && now - Date.parse(c.closedAt) < 7 * 86_400_000).slice(-30);
  const crashExits: TierInput["crashExits"] = [];
  if (recentExits.length) {
    const prices = await getPrices([SOL_MINT, ...recentExits.map((c) => c.mint)]).catch(() => new Map());
    const solUsd = prices.get(SOL_MINT)?.priceUsd;
    for (const c of recentExits) {
      const usd = prices.get(c.mint)?.priceUsd;
      if (solUsd && usd) crashExits.push({ mint: c.mint, symbol: sym(c.mint), sellPriceSol: c.lastSellPriceSol, nowPriceSol: usd / solUsd, signature: c.lastSellSignature, ts: c.closedAt });
    }
  }

  // 6) Tier + AI/human
  const groupSize = funder ? (db.prepare("SELECT COUNT(*) n FROM wallets WHERE funder = ?").get(funder) as { n: number }).n + (row.funder ? 0 : 1) : 1;
  const funderRow = funder ? (db.prepare("SELECT address, tier FROM wallets WHERE address = ?").get(funder) as { address: string; tier: Tier } | undefined) : undefined;
  const t = assignTier({
    stats, closed: r.closed, now, isFresh: isFresh === 1, groupSize, funderTracked: funderRow ?? null, previousTier: row.tier,
    creatorLinks, crashExits, symbols,
    cfg: { quitAfterDays: config.quitAfterDays, minClosedForProven: config.minClosedForProven, earlyBuySeconds: config.earlyBuySeconds },
  });
  const c = classify(swaps, { txPerHour });

  db.transaction(() => {
    db.prepare(
      `UPDATE wallets SET tier=?, tier_reason=?, tier_changed_at=CASE WHEN tier != ? THEN ? ELSE tier_changed_at END,
          kind=?, ai_score=?, kind_reasons=?, tx_per_hour=?, funder=?, chain_created_at=?, age_is_lower_bound=CASE WHEN ? THEN ? ELSE age_is_lower_bound END,
          is_fresh=?, last_analyzed_at=?, last_activity_at=COALESCE(?, last_activity_at), last_signature=?, analyze_errors=0
        WHERE address=?`,
    ).run(t.tier, t.reason, t.tier, nowIso(), c.kind, c.score, JSON.stringify(c.reasons), txPerHour, funder, createdAt, firstLook ? 1 : 0, lowerBound,
      isFresh, nowIso(), stats.last_trade_at ?? h.activityAt, h.newestSignature, address);
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

/** Analyze the wallets most in need of it: never-analyzed first, then the stalest. Leaders always get a turn. */
export async function runAnalysis(db: DB, limit = config.analyzePerRun): Promise<number> {
  const staleBefore = new Date(Date.now() - config.reanalyzeMinutes * 60_000).toISOString();
  const rows = db
    .prepare(
      `SELECT address FROM wallets
        WHERE analyze_errors < 5 AND (last_analyzed_at IS NULL OR last_analyzed_at < ?)
        ORDER BY last_analyzed_at IS NOT NULL, copy_weight > 0 DESC, last_analyzed_at
        LIMIT ?`,
    )
    .all(staleBefore, limit) as { address: string }[];
  const budget = { left: TOKEN_LOOKUPS_PER_RUN };
  let done = 0;
  for (const { address } of rows) {
    try {
      await analyzeWallet(db, address, budget);
      done++;
    } catch (e) {
      db.prepare("UPDATE wallets SET analyze_errors = analyze_errors + 1 WHERE address = ?").run(address);
      say("warn", `Couldn't analyze ${short(address)}: ${(e as Error).message.slice(0, 140)}`);
    }
  }
  if (done) say("info", `Analyzed ${done} wallet${done === 1 ? "" : "s"}.`);
  return done;
}
