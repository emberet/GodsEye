/**
 * A pump.fun coin's launch read back from Solana: its first buyers, for coins the live tape didn't see from the start.
 *
 * The coin's bonding-curve account (seeds "bonding-curve" + mint under the pump.fun program) only trades until the coin
 * migrates, so its signatures can be paged back to the very first (`allSignatures`, metered) where the mint's can run to
 * hundreds of thousands. Paging starts at `before` when given (a stored swap from when the coin first reached 3x): a runner's
 * curve can hold tens of thousands of transactions, but early buys all come before that. The oldest transactions are read (`fetchParsed`: ERPC when HISTORY_TX_RPC_URL is set) and every
 * wallet whose balance of the coin changed is parsed with the same parser as everything else.
 */
import { PublicKey } from "@solana/web3.js";
import { allSignatures, fetchParsed } from "../chain/history";
import { parseSwaps } from "../chain/parse";
import { isWallet } from "../market/holders";
import { solUsdAt } from "../market/solprice";
import { type BuyerRow, tapeSettings } from "./tape";

export const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

export function pumpCurveAddress(mint: string): string {
  return PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), new PublicKey(mint).toBuffer()], new PublicKey(PUMP_PROGRAM))[0].toBase58();
}

export interface LaunchEvent {
  t: number;
  slot: number;
  wallet: string;
  side: "buy" | "sell";
  price: number;
  sol: number;
  tokens: number;
}

export interface ChainLaunch {
  first: number;
  firstSlot: number;
  creator: string | null;
  buyers: BuyerRow[];
  buys: number;
  swaps: number;
}

/** Pure: the first `maxBuyers` distinct buyers from a coin's swaps in order, with what they sold and what a copy would have paid. */
export function buyersFrom(events: LaunchEvent[], delayMs: number, maxBuyers = tapeSettings.maxBuyers): { buyers: BuyerRow[]; buys: number } {
  const byWallet = new Map<string, BuyerRow>();
  let buys = 0;
  for (const e of events) {
    const b = byWallet.get(e.wallet);
    if (e.side === "buy") {
      buys++;
      if (b) {
        b.sol += e.sol;
        b.tokens += e.tokens;
      } else if (byWallet.size < maxBuyers) {
        byWallet.set(e.wallet, { wallet: e.wallet, rank: byWallet.size + 1, t: e.t, slot: e.slot, price: e.price, sol: e.sol, tokens: e.tokens, soldTokens: 0, soldSol: 0, copyPrice: null });
      }
    } else if (b) {
      b.soldTokens += e.tokens;
      b.soldSol += e.sol;
    }
  }
  const buyers = [...byWallet.values()];
  for (const b of buyers) b.copyPrice = events.find((e) => e.t >= b.t + delayMs && e.slot > (b.slot ?? 0))?.price ?? null;
  return { buyers, buys };
}

/**
 * The launch of a pump.fun coin from Solana, or null when its curve has more than `maxPages` × 1000 transactions (before
 * `before`, when given: too busy to page back cheaply) or none could be read. Reads the oldest `readTxs` transactions.
 */
export async function launchFromChain(mint: string, opts: { maxPages: number; readTxs: number; delayMs: number; before?: string }): Promise<ChainLaunch | null> {
  const { sigs, exhausted } = await allSignatures(pumpCurveAddress(mint), opts.maxPages, opts.before);
  if (!sigs.length) throw new Error("no transactions on its pump.fun curve");
  if (!exhausted) return null;
  const oldest = sigs.filter((s) => !s.err).reverse().slice(0, opts.readTxs);
  const txs = await fetchParsed(oldest.map((s) => s.signature));
  const events: LaunchEvent[] = [];
  let creator: string | null = null;
  txs.forEach((tx, i) => {
    if (!tx) return;
    creator ??= tx.transaction.message.accountKeys[0]?.pubkey.toString() ?? null;
    const t = (tx.blockTime ?? oldest[i].blockTime ?? 0) * 1000;
    const owners = new Set(
      [...(tx.meta?.preTokenBalances ?? []), ...(tx.meta?.postTokenBalances ?? [])].filter((b) => b.mint === mint && b.owner && isWallet(b.owner)).map((b) => b.owner!),
    );
    for (const owner of owners) {
      for (const s of parseSwaps(tx, owner, { solUsdAt })) {
        if (s.mint !== mint || !(s.solAmount > 0) || !(s.priceSol > 0)) continue;
        events.push({ t, slot: oldest[i].slot, wallet: owner, side: s.side, price: s.priceSol, sol: s.solAmount, tokens: s.tokenAmount });
      }
    }
  });
  if (!events.length) return null;
  const { buyers, buys } = buyersFrom(events, opts.delayMs);
  return { first: events[0].t, firstSlot: oldest[0].slot, creator, buyers, buys, swaps: events.length };
}
