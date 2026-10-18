/**
 * Jupiter — Solana's main swap router. Free "lite" API, no key needed
 * (an optional key from portal.jup.ag uses the pro host).
 *  - jupiterPrices(): current USD prices for many tokens at once
 *  - jupiterQuote():  "if I swapped X for Y right now, what would I get?"
 *  - jupiterSwapTx(): an unsigned swap transaction for a quote (GodsEye checks it before signing)
 */
import { config } from "../config";
import { fetchJson } from "../http";

const host = () => (config.jupiterApiKey ? "https://api.jup.ag" : "https://lite-api.jup.ag");
const headers = (): Record<string, string> => (config.jupiterApiKey ? { "x-api-key": config.jupiterApiKey } : {});

export interface JupPrice {
  usdPrice: number;
  decimals: number;
  liquidity?: number;
  priceChange24h?: number;
}

export async function jupiterPrices(mints: string[]): Promise<Map<string, JupPrice>> {
  const map = new Map<string, JupPrice>();
  for (let i = 0; i < mints.length; i += 50) {
    const chunk = mints.slice(i, i + 50);
    const res = await fetchJson<Record<string, JupPrice | null>>(`${host()}/price/v3?ids=${chunk.join(",")}`, {
      headers: headers(),
    });
    for (const [mint, p] of Object.entries(res)) if (p && p.usdPrice > 0) map.set(mint, p);
  }
  return map;
}

export interface JupQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  /** Minimum the swap may return after slippage. */
  otherAmountThreshold: string;
  priceImpactPct: string;
  routePlan: { swapInfo: { label?: string } }[];
}

export async function jupiterQuote(inputMint: string, outputMint: string, amountAtomic: bigint, slippageBps = 50): Promise<JupQuote> {
  const url = `${host()}/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountAtomic}&slippageBps=${slippageBps}&restrictIntermediateTokens=true`;
  return fetchJson<JupQuote>(url, { headers: headers(), retries: 1 });
}

export interface JupSwapTx {
  swapTransaction: string;
  lastValidBlockHeight: number;
}

export async function jupiterSwapTx(quote: JupQuote, userPublicKey: string): Promise<JupSwapTx> {
  return fetchJson<JupSwapTx>(`${host()}/swap/v1/swap`, {
    method: "POST",
    headers: { ...headers(), "content-type": "application/json" },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: config.priorityFeeMaxLamports, priorityLevel: "veryHigh" } },
    }),
    retries: 1,
  });
}
