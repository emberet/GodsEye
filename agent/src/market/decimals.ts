/** How many decimal places a token uses (needed to read swap quotes). Cached. */
import { PublicKey } from "@solana/web3.js";
import { copyConnection } from "../rpc";

const cache = new Map<string, number>();

export async function tokenDecimals(mint: string): Promise<number | undefined> {
  if (cache.has(mint)) return cache.get(mint);
  try {
    const supply = await copyConnection().getTokenSupply(new PublicKey(mint));
    cache.set(mint, supply.value.decimals);
    return supply.value.decimals;
  } catch {
    return undefined;
  }
}
