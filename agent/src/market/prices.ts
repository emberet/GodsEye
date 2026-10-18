/**
 * "What's the price right now?" — asks Jupiter first, then Birdeye (if you
 * have a key), then GeckoTerminal. First good answer wins.
 */
import { SOL_MINT } from "@godseye/shared";
import { birdeyePrices } from "./birdeye";
import { fetchTokenPools } from "./geckoterminal";
import { jupiterPrices, type JupPrice } from "./jupiter";

export interface PriceQuote {
  priceUsd: number;
  source: "jupiter" | "birdeye" | "geckoterminal";
  decimals?: number;
}

export async function getPrices(mints: string[]): Promise<Map<string, PriceQuote>> {
  const wanted = [...new Set(mints)];
  const out = new Map<string, PriceQuote>();
  let jup = new Map<string, JupPrice>();
  try {
    jup = await jupiterPrices(wanted);
  } catch (e) {
    console.warn(`Jupiter price API unavailable: ${(e as Error).message}`);
  }
  for (const [m, p] of jup) out.set(m, { priceUsd: p.usdPrice, source: "jupiter", decimals: p.decimals });

  let missing = wanted.filter((m) => !out.has(m));
  if (missing.length) {
    const be = await birdeyePrices(missing);
    for (const [m, p] of be) out.set(m, { priceUsd: p, source: "birdeye" });
    missing = wanted.filter((m) => !out.has(m));
  }
  if (missing.length) {
    try {
      const gt = await fetchTokenPools(missing);
      for (const [m, p] of gt) out.set(m, { priceUsd: p.priceUsd, source: "geckoterminal" });
    } catch (e) {
      console.warn(`GeckoTerminal price lookup failed: ${(e as Error).message}`);
    }
  }
  return out;
}

export async function getSolUsd(): Promise<number> {
  const p = await getPrices([SOL_MINT]);
  const v = p.get(SOL_MINT)?.priceUsd;
  if (!v) throw new Error("could not fetch SOL price");
  return v;
}
