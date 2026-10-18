/**
 * Birdeye — optional backup price feed. Only used if you put a
 * BIRDEYE_API_KEY in .env (free tier: https://docs.birdeye.so).
 */
import { config } from "../config";
import { fetchJson } from "../http";

export async function birdeyePrices(mints: string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (!config.birdeyeApiKey || mints.length === 0) return map;
  // Free tier: query tokens one at a time to stay inside the plan.
  for (const mint of mints.slice(0, 10)) {
    try {
      const res = await fetchJson<{ success: boolean; data?: { value: number } }>(
        `https://public-api.birdeye.so/defi/price?address=${mint}`,
        { headers: { "X-API-KEY": config.birdeyeApiKey, "x-chain": "solana" }, retries: 0 },
      );
      if (res.success && res.data?.value) map.set(mint, res.data.value);
    } catch {
      /* skip */
    }
  }
  return map;
}
