/**
 * PumpSwap pools pump.fun opened itself when a coin left its curve (the "canonical" pool), told apart from pools anyone
 * else opened for the same coin. The migration opens the pool from an address pump.fun derives from the coin (seed
 * "pool-authority" under the pump.fun program) and that address is the pool's creator; a pool someone else opened names
 * them instead, and they can take its liquidity back. Checked against a live pool on 2026-11-12.
 */
import { PublicKey } from "@solana/web3.js";
import { copyRpcUrl } from "../config";
import { fetchJson } from "../http";
import type { JupQuote } from "../market/jupiter";
import { POOL_PROGRAMS } from "./state";

/** Jupiter's name for PumpSwap in a route. */
const PUMPSWAP_LABEL = "Pump.fun Amm";

/** The address pump.fun's migration opens a coin's PumpSwap pool from. */
export function migrationAuthority(mint: string): string {
  return PublicKey.findProgramAddressSync([Buffer.from("pool-authority"), new PublicKey(mint).toBuffer()], new PublicKey(POOL_PROGRAMS.PUMP_CURVE))[0].toBase58();
}

/** True when this PumpSwap pool account was opened by pump.fun's own migration (creator at byte 11, the coin at byte 43). */
export function isCanonicalPumpPool(data: Buffer): boolean {
  if (data.length < 75) return false;
  const creator = new PublicKey(data.subarray(11, 43)).toBase58();
  const coin = new PublicKey(data.subarray(43, 75)).toBase58();
  return creator === migrationAuthority(coin);
}

/** How many of the PumpSwap pools a route goes through pump.fun's migration didn't open. Throws when they can't be read. */
export async function strangePumpPools(route: JupQuote["routePlan"]): Promise<number> {
  const pools = [...new Set(route.filter((r) => r.swapInfo.label === PUMPSWAP_LABEL && r.swapInfo.ammKey).map((r) => r.swapInfo.ammKey!))];
  if (!pools.length) return 0;
  const res = await fetchJson<{ result?: { value?: ({ owner: string; data: [string, string] } | null)[] }; error?: { message: string } }>(copyRpcUrl(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getMultipleAccounts", params: [pools, { encoding: "base64" }] }),
  });
  const accounts = res.result?.value;
  if (res.error || !accounts || accounts.length !== pools.length) throw new Error("couldn't read the route's pools");
  return accounts.filter((a) => !a || a.owner !== POOL_PROGRAMS.PUMP_AMM || !isCanonicalPumpPool(Buffer.from(a.data[0], "base64"))).length;
}
