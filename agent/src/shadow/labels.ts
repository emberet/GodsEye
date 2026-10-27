/**
 * What happened to a shadow-logged token, as layered labels rather than one "rugged" flag (the definitions published
 * work uses differ, so each stays its own column and can be re-cut later). Pure: stored samples in, labels out.
 *
 *   collapse50 / collapse90  price, or the value of selling a copy-sized position, fell to ≤ 50% / ≤ 10% of the leader's
 *                            entry within the first hour (a sellable drawdown or worse)
 *   unexitable               at some mark, selling a copy-sized position would return under 10% of what it cost
 *   routeLost                Jupiter quoted a sell earlier and later cannot (a quote that failed on a busy or unreachable API doesn't count)
 *   liquidityDrop            pool liquidity fell to ≤ 10% of the first value seen
 *   dark                     the token was priced once and later is not priced at any mark an hour or more after entry
 *   neverPriced              no price source ever quoted it — unknown, NOT survived and NOT rugged
 * "rugLike" is any of collapse90, unexitable, routeLost, liquidityDrop, dark.
 */

export interface SamplePoint {
  horizonSec: number;
  status: "ok" | "no_price" | "missed";
  priceUsd: number | null;
  liquidityUsd: number | null;
  sellQuoteSol: number | null;
  /** Why there is no sell quote, when there isn't one. */
  sellQuoteError?: string | null;
}

export interface Labels {
  /** Samples that were actually taken (not missed). */
  taken: number;
  priced: number;
  /** The hour after entry has passed, so the 1-hour labels are settled. */
  hourSettled: boolean;
  collapse50: boolean;
  collapse90: boolean;
  unexitable: boolean;
  routeLost: boolean;
  liquidityDrop: boolean;
  dark: boolean;
  neverPriced: boolean;
  rugLike: boolean;
  /** Lowest of price ÷ entry price and sell value ÷ position cost over the first hour (null: nothing to compare). */
  worstFirstHour: number | null;
}

const HOUR = 3600;

/** A quote that failed because the API was busy or unreachable says nothing about whether the token can be sold. */
export const isTransientQuoteError = (msg: string | null | undefined): boolean => !!msg && /^(429|5\d\d) |fetch failed|abort|timeout|timed out|network|ECONN|ENOTFOUND/i.test(msg);

export function labelOutcome(entryPriceUsd: number | null, simSizeSol: number | null, samples: SamplePoint[]): Labels {
  const s = [...samples].filter((x) => x.status !== "missed").sort((a, b) => a.horizonSec - b.horizonSec);
  const priced = s.filter((x) => x.status === "ok" && x.priceUsd !== null && x.priceUsd > 0);
  const priceRatio = (x: SamplePoint) => (entryPriceUsd && entryPriceUsd > 0 && x.priceUsd ? x.priceUsd / entryPriceUsd : null);
  const exitRatio = (x: SamplePoint) => (simSizeSol && simSizeSol > 0 && x.sellQuoteSol !== null ? x.sellQuoteSol / simSizeSol : null);
  const firstHour = s.filter((x) => x.horizonSec <= HOUR);
  const ratios = firstHour.flatMap((x) => [priceRatio(x), exitRatio(x)].filter((r): r is number => r !== null));
  const worst = ratios.length ? Math.min(...ratios) : null;

  const quoted = s.filter((x) => x.sellQuoteSol !== null);
  const firstQuote = quoted[0];
  const routeLost = !!firstQuote && s.some((x) => x.horizonSec > firstQuote.horizonSec && x.sellQuoteSol === null && !isTransientQuoteError(x.sellQuoteError));
  const unexitable = s.some((x) => {
    const r = exitRatio(x);
    return r !== null && r < 0.1;
  });
  const liq = s.filter((x) => x.liquidityUsd !== null && x.liquidityUsd > 0);
  const liquidityDrop = liq.length > 1 && liq.some((x) => x !== liq[0] && (x.liquidityUsd as number) <= 0.1 * (liq[0].liquidityUsd as number));
  const firstPriced = priced[0];
  const dark = !!firstPriced && s.some((x) => x.horizonSec >= HOUR && x.horizonSec > firstPriced.horizonSec && x.status === "no_price") && !priced.some((x) => x.horizonSec >= HOUR);
  const collapse90 = worst !== null && worst <= 0.1;
  return {
    taken: s.length,
    priced: priced.length,
    hourSettled: s.some((x) => x.horizonSec >= HOUR),
    collapse50: worst !== null && worst <= 0.5,
    collapse90,
    unexitable,
    routeLost,
    liquidityDrop,
    dark,
    neverPriced: s.length > 0 && priced.length === 0,
    rugLike: collapse90 || unexitable || routeLost || liquidityDrop || dark,
    worstFirstHour: worst,
  };
}

/** Wilson 95% interval for k of n (share, 0..1); null when n is 0. */
export function wilson(k: number, n: number): { lo: number; hi: number } | null {
  if (!n) return null;
  const z = 1.96;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / d;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return { lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) };
}
