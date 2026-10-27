/**
 * SHADOW SAMPLER — what did each logged token do next?
 *
 * Every minute, for each shadow candidate (log.ts) that has reached 1 min, 5 min, 15 min, 30 min, 1 h, 6 h or 24 h
 * since the leader's buy, record:
 *   • the price and pool liquidity from the price sources GodsEye already uses (they see every trade, unlike the stored
 *     swap tape, which only has tracked wallets and goes silent after a pull);
 *   • what selling a copy-sized position would return right now, as Jupiter quotes it: the price a trade log can't show
 *     when liquidity is going or gone;
 *   • at the first two marks, RugCheck's report again, to see how soon it fills in for a new token.
 * "No price" is stored as a result (no_price), and a mark GodsEye was too late for as missed: gaps are never silent.
 */
import { type DB, nowIso, SOL_MINT } from "@godseye/shared";
import { config } from "../config";
import { jupiterQuote } from "../market/jupiter";
import { tokenDecimals } from "../market/decimals";
import { getPrices, type PriceQuote } from "../market/prices";
import { readRugCheck, rugcheckFacts, type RugCheckSummary } from "../market/rugcheck";

export const HORIZONS_SEC = [60, 300, 900, 1800, 3600, 21_600, 86_400] as const;
/** RugCheck is asked again at these marks only. */
export const RUGCHECK_HORIZONS_SEC: readonly number[] = [60, 300];
/** A sample taken later than this after its mark no longer says what the price was at the mark. */
export const lateToleranceSec = (horizonSec: number): number => Math.min(3600, Math.max(120, horizonSec / 4));
const QUOTE_CONCURRENCY = 3;

export interface SamplerDeps {
  prices: (mints: string[]) => Promise<Map<string, PriceQuote>>;
  /** SOL back for selling `tokens` (whole tokens) of a mint right now; throws when there is no quote. */
  sellQuoteSol: (mint: string, tokens: number, decimals: number) => Promise<number>;
  decimals: (mint: string) => Promise<number | undefined>;
  rugcheck: (mint: string) => Promise<RugCheckSummary | null>;
}

export const liveDeps: SamplerDeps = {
  prices: getPrices,
  sellQuoteSol: async (mint, tokens, decimals) => {
    const atomic = BigInt(Math.max(1, Math.floor(tokens * 10 ** decimals)));
    const q = await jupiterQuote(mint, SOL_MINT, atomic, config.slippageBps);
    return Number(q.outAmount) / 1e9;
  },
  decimals: tokenDecimals,
  rugcheck: readRugCheck,
};

interface Candidate {
  id: number;
  mint: string;
  seen_at: string;
  entry_price_sol: number;
  sim_size_sol: number | null;
}

type Due = Candidate & { horizonSec: number };

async function inBatches<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += size) await Promise.all(items.slice(i, i + size).map(fn));
}

/** Takes every sample that is due. Returns how many rows it wrote. */
export async function sampleDue(db: DB, now = Date.now(), deps: SamplerDeps = liveDeps): Promise<number> {
  const horizonMax = HORIZONS_SEC[HORIZONS_SEC.length - 1];
  const from = new Date(now - (horizonMax + lateToleranceSec(horizonMax)) * 1000).toISOString();
  const candidates = db.prepare("SELECT id, mint, seen_at, entry_price_sol, sim_size_sol FROM shadow_candidates WHERE seen_at >= ?").all(from) as Candidate[];
  if (!candidates.length) return 0;
  const have = new Set(
    (db.prepare("SELECT candidate_id, horizon_sec FROM shadow_samples WHERE candidate_id IN (SELECT id FROM shadow_candidates WHERE seen_at >= ?)").all(from) as { candidate_id: number; horizon_sec: number }[]).map(
      (r) => `${r.candidate_id}:${r.horizon_sec}`,
    ),
  );
  const missed = db.prepare("INSERT OR IGNORE INTO shadow_samples (candidate_id, horizon_sec, sampled_at, status) VALUES (?, ?, ?, 'missed')");
  const due: Due[] = [];
  let written = 0;
  for (const c of candidates) {
    const seen = Date.parse(c.seen_at);
    for (const h of HORIZONS_SEC) {
      if (have.has(`${c.id}:${h}`)) continue;
      const dueAt = seen + h * 1000;
      if (dueAt > now) continue;
      if (now > dueAt + lateToleranceSec(h) * 1000) written += missed.run(c.id, h, nowIso()).changes;
      else due.push({ ...c, horizonSec: h });
    }
  }
  if (!due.length) return written;

  const mints = [...new Set(due.map((d) => d.mint))];
  // SOL rides along as a canary: if even SOL gets no price, the price sources are down, and "no price" would be a false result.
  // Nothing is recorded then; the marks stay due and are tried again next minute (or become missed once they are too late).
  const prices = await deps.prices([...mints, SOL_MINT]).catch(() => new Map<string, PriceQuote>());
  if (!prices.has(SOL_MINT)) return written;
  const decimals = new Map<string, number | undefined>();
  await inBatches(mints, QUOTE_CONCURRENCY, async (m) => void decimals.set(m, prices.get(m)?.decimals ?? (await deps.decimals(m).catch(() => undefined))));

  const insert = db.prepare(
    `INSERT OR IGNORE INTO shadow_samples
       (candidate_id, horizon_sec, sampled_at, status, price_usd, price_source, liquidity_usd, sell_quote_sol, sell_quote_error, rugcheck_ok, rugcheck_score, rugcheck_pools, lp_locked_pct)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  await inBatches(due, QUOTE_CONCURRENCY, async (d) => {
    const q = prices.get(d.mint);
    let sellSol: number | null = null;
    let sellErr: string | null = null;
    const dec = decimals.get(d.mint);
    if (!d.sim_size_sol || !(d.entry_price_sol > 0)) sellErr = "no position size to quote";
    else if (dec === undefined) sellErr = "token decimals unknown";
    else {
      try {
        sellSol = await deps.sellQuoteSol(d.mint, d.sim_size_sol / d.entry_price_sol, dec);
      } catch (e) {
        sellErr = (e as Error).message.slice(0, 160);
      }
    }
    let rc = { ok: null as number | null, score: null as number | null, pools: null as number | null, locked: null as number | null };
    if (RUGCHECK_HORIZONS_SEC.includes(d.horizonSec)) {
      const f = rugcheckFacts(await deps.rugcheck(d.mint).catch(() => null));
      rc = { ok: f.ok ? 1 : 0, score: f.score, pools: f.pools, locked: f.lockedPct };
    }
    written += insert.run(d.id, d.horizonSec, nowIso(), q ? "ok" : "no_price", q?.priceUsd ?? null, q?.source ?? null, q?.liquidityUsd ?? null, sellSol, sellErr, rc.ok, rc.score, rc.pools, rc.locked).changes;
  });
  return written;
}
