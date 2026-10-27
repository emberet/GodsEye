/**
 * MARKET CHECK — does the token have a real pool with money in it, right now?
 *
 * The stream tally (organic.ts) says whether independent wallets traded a token. It can't say the pool is still there: a
 * Meteora DBC token that graduated is often left with a drained DAMM v2 pair holding about a dollar (DexScreener then shows
 * almost nothing, though thousands of swaps happened on the way). Jupiter's token search lists liquidity, holders, its organic
 * score and an audit flag for a token, free and without a key. Every few minutes the tokens smart money is trading are asked
 * for in one request; a token with no pool worth the name is marked "thin" and falls out of the feed and its signals.
 *
 * Fail-open and labelled: if Jupiter can't be reached, nothing is changed. Never blocks the stream (called without waiting).
 */
import { type DB, envBool, envNum } from "@godseye/shared";
import { config } from "../config";
import { fetchJson } from "../http";
import { ensureOrganicTable } from "./organic";

export const marketSettings = {
  enabled: envBool("ORGANIC_MARKET_CHECK", true),
  /** A pool holding less than this (USD) is not a market. */
  minLiquidityUsd: envNum("ORGANIC_MIN_LIQUIDITY_USD", 500),
  /** A token Jupiter has no record of is "thin" only after it has existed this long (new tokens take a moment to be indexed). */
  noListingAfterMinutes: envNum("ORGANIC_NO_LISTING_AFTER_MINUTES", 15),
  /** Ask again about a token after this long. */
  refreshMinutes: envNum("ORGANIC_MARKET_REFRESH_MINUTES", 20),
  everySeconds: envNum("ORGANIC_MARKET_EVERY_SECONDS", 90),
  perRun: envNum("ORGANIC_MARKET_PER_RUN", 50),
};
export type MarketSettings = typeof marketSettings;

/** The fields of Jupiter's token search (tokens/v2/search) used here. */
export interface JupToken {
  id: string;
  liquidity: number | null;
  holderCount: number | null;
  organicScore: number | null;
  organicScoreLabel: string | null;
  suspicious: boolean | null;
}

const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);

/** Pure: Jupiter's answer into the fields we keep, by mint. */
export function parseJupiterTokens(json: unknown): Map<string, JupToken> {
  const out = new Map<string, JupToken>();
  if (!Array.isArray(json)) return out;
  for (const t of json as Record<string, unknown>[]) {
    if (!t || typeof t.id !== "string") continue;
    const audit = (t.audit ?? {}) as Record<string, unknown>;
    out.set(t.id, {
      id: t.id,
      liquidity: num(t.liquidity),
      holderCount: num(t.holderCount),
      organicScore: num(t.organicScore),
      organicScoreLabel: typeof t.organicScoreLabel === "string" ? t.organicScoreLabel : null,
      suspicious: typeof audit.isSus === "boolean" ? audit.isSus : null,
    });
  }
  return out;
}

export interface MarketJudgement {
  /** ok: a pool with money · thin: none worth the name · null: can't say yet */
  market: "ok" | "thin" | null;
  reason: string;
}

/** Pure: is the token's market real? `t` is null when Jupiter has no record of it. */
export function judgeMarket(t: JupToken | null, ageMin: number, s: MarketSettings = marketSettings): MarketJudgement {
  if (!t) {
    return ageMin >= s.noListingAfterMinutes
      ? { market: "thin", reason: `Jupiter has no record of the token after ${Math.round(ageMin)} min: no pool it can route to` }
      : { market: null, reason: "not listed yet" };
  }
  if (t.liquidity === null) return { market: null, reason: "Jupiter gives no liquidity figure" };
  if (t.liquidity < s.minLiquidityUsd) return { market: "thin", reason: `its pool holds $${t.liquidity < 0.01 ? t.liquidity.toExponential(1) : t.liquidity < 10 ? t.liquidity.toFixed(2) : t.liquidity.toFixed(0)} of liquidity ($${s.minLiquidityUsd} needed)` };
  return { market: "ok", reason: `pool liquidity $${Math.round(t.liquidity).toLocaleString("en-US")}` };
}

export type TokenFetcher = (mints: string[]) => Promise<Map<string, JupToken>>;

/** One request for up to 100 mints. Keyless works; JUPITER_API_KEY, when set, is sent. */
export const fetchJupiterTokens: TokenFetcher = async (mints) => {
  const json = await fetchJson<unknown>(`https://api.jup.ag/tokens/v2/search?query=${mints.join(",")}`, {
    headers: config.jupiterApiKey ? { "x-api-key": config.jupiterApiKey } : {},
    retries: 0,
    timeoutMs: 8_000,
  });
  return parseJupiterTokens(json);
};

/** Mints worth asking about now: judged by the stream as not-yet-bad, and not checked recently. Oldest check first. */
export function dueForMarketCheck(db: DB, s: MarketSettings = marketSettings, now = Date.now()): { mint: string; ageMin: number }[] {
  ensureOrganicTable(db);
  const stale = new Date(now - s.refreshMinutes * 60_000).toISOString();
  return (
    db
      .prepare(
        `SELECT mint, (julianday(?) - julianday(first_assessed_at)) * 1440 AS age_min FROM token_organic
          WHERE tally_verdict IN ('organic', 'unknown') AND (enriched_at IS NULL OR enriched_at < ?)
          ORDER BY enriched_at IS NOT NULL, enriched_at LIMIT ?`,
      )
      .all(new Date(now).toISOString(), stale, s.perRun) as { mint: string; age_min: number }[]
  ).map((r) => ({ mint: r.mint, ageMin: r.age_min }));
}

/** Asks Jupiter about the due tokens and records what it says. Returns how many tokens were marked thin. Fail-open. */
export async function checkMarkets(db: DB, fetcher: TokenFetcher = fetchJupiterTokens, s: MarketSettings = marketSettings, now = Date.now()): Promise<{ checked: number; thin: number }> {
  const due = dueForMarketCheck(db, s, now);
  if (!due.length) return { checked: 0, thin: 0 };
  let found: Map<string, JupToken>;
  try {
    found = await fetcher(due.map((d) => d.mint));
  } catch {
    return { checked: 0, thin: 0 };
  }
  const ts = new Date(now).toISOString();
  const upd = db.prepare(
    `UPDATE token_organic SET market = ?, market_reason = ?, liquidity_usd = ?, holders = ?, jup_organic_score = ?, jup_label = ?, jup_suspicious = ?, enriched_at = ?,
       verdict = CASE WHEN ? = 'thin' THEN 'thin' ELSE tally_verdict END WHERE mint = ?`,
  );
  let thin = 0;
  db.transaction(() => {
    for (const d of due) {
      const t = found.get(d.mint) ?? null;
      const j = judgeMarket(t, d.ageMin, s);
      if (j.market === "thin") thin++;
      upd.run(j.market, j.reason, t?.liquidity ?? null, t?.holderCount ?? null, t?.organicScore ?? null, t?.organicScoreLabel ?? null, t?.suspicious === null || t?.suspicious === undefined ? null : t.suspicious ? 1 : 0, ts, j.market, d.mint);
    }
  })();
  return { checked: due.length, thin };
}
