/**
 * Shyft's token API: a token's name, symbol and decimals, for SPL and Token-2022 mints alike.
 * Much faster than GeckoTerminal (paid Shyft plans allow 10 API calls/sec; GeckoTerminal's free API
 * ~9 a minute), so names come from here and GeckoTerminal is kept for launch times and price candles.
 * Uses SHYFT_API_KEY, or the api_key already in a Shyft SOLANA_RPC_URL.
 */
import { config, rpcUrl } from "../config";
import { fetchJson } from "../http";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MIN_GAP_MS = 125; // 8/sec, under the plans' 10 API calls/sec
let nextFree = 0;

export function shyftApiKey(): string | null {
  if (config.shyftApiKey) return config.shyftApiKey;
  const url = rpcUrl();
  if (!/shyft\.to/i.test(url)) return null;
  return url.match(/[?&]api_key=([^&]+)/i)?.[1] ?? null;
}

export interface ShyftToken {
  symbol: string | null;
  name: string | null;
  decimals: number | null;
}

/** Name, symbol and decimals of a token, or null if Shyft isn't configured or doesn't know it. */
export async function fetchShyftToken(mint: string): Promise<ShyftToken | null> {
  const key = shyftApiKey();
  if (!key) return null;
  const now = Date.now();
  const start = Math.max(now, nextFree);
  nextFree = start + MIN_GAP_MS;
  if (start > now) await sleep(start - now);
  const res = await fetchJson<{ success?: boolean; result?: { symbol?: string; name?: string; decimals?: number } }>(
    `https://api.shyft.to/sol/v1/token/get_info?network=mainnet-beta&token_address=${mint}`,
    { headers: { "x-api-key": key }, retries: 1, timeoutMs: 10_000 },
  );
  if (!res.success || !res.result) return null;
  const sym = res.result.symbol?.trim();
  return { symbol: sym ? sym : null, name: res.result.name?.trim() || null, decimals: typeof res.result.decimals === "number" ? res.result.decimals : null };
}
