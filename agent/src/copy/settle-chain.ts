/**
 * SETTLE CHAIN — what the settle steps (recovery.ts) read from the chain about GodsEye's own trades: whether a
 * transaction landed, the block height, the trade a transaction made, and a coin's latest transactions in the wallet.
 */
import { PublicKey } from "@solana/web3.js";
import { fetchParsedOne } from "../chain/history";
import { detectVenue, parseSwaps, tradeCostSol, type TokenBalanceLike, type TxLike } from "../chain/parse";
import { noteCopyRpc } from "../chain/rpc-budget";
import { withTimeout } from "../jobs";
import { TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from "../market/mint-profile";
import { solUsdAt } from "../market/solprice";
import { copyConnection } from "../rpc";
import type { ChainTrade, SettleChain } from "./recovery";
import { associatedTokenAddress } from "./verify";

/** A swap for less SOL than this doesn't parse as one (parse.ts drops it as noise): a dead coin sold for dust. */
const DUST_SOL = 0.0001;
/** A read the node hasn't answered by now is given up: the settle steps ask again on their next pass, so a node that
 *  hangs never holds up the positions job (the exit checks run in it). */
const READ_MS = 20_000;

/**
 * The trade `wallet` made in `mint` in this transaction; null when it made none (the transaction failed, or it only
 * moved tokens: a transfer, a closed account).
 */
export function tradeOf(tx: TxLike, wallet: string, mint: string, signature: string): ChainTrade | null {
  const meta = tx.meta;
  if (!meta || meta.err) return null;
  const atMs = (tx.blockTime ?? Date.now() / 1000) * 1000;
  const swap = parseSwaps(tx, wallet, { solUsdAt }).find((s) => s.mint === mint);
  if (swap) {
    // Only a swap against SOL itself moved the wallet's SOL by its amount; for any other, the fee and tips are the cost.
    const feeSol = tradeCostSol(tx, wallet, swap.side, swap.quote === "SOL" ? swap.solAmount : null) ?? undefined;
    return { side: swap.side, atMs, fill: { signature, solAmount: swap.solAmount, tokenAmount: swap.tokenAmount, priceSol: swap.priceSol, feeSol } };
  }
  // A sell for dust: the tokens left through a DEX and next to no SOL came back.
  const idx = tx.transaction.message.accountKeys.findIndex((k) => k.pubkey.toString() === wallet);
  if (idx < 0 || !detectVenue(tx)) return null;
  const held = (balances: TokenBalanceLike[] | null | undefined): number =>
    (balances ?? []).filter((b) => b.owner === wallet && b.mint === mint).reduce((s, b) => s + Number(b.uiTokenAmount.amount) / 10 ** b.uiTokenAmount.decimals, 0);
  const sold = held(meta.preTokenBalances) - held(meta.postTokenBalances);
  const sol = Math.max(0, (meta.postBalances[idx] - meta.preBalances[idx] + (idx === 0 ? meta.fee : 0)) / 1e9);
  if (!(sold > 0) || sol >= DUST_SOL) return null;
  return { side: "sell", atMs, fill: { signature, solAmount: sol, tokenAmount: sold, priceSol: sol / sold, feeSol: tradeCostSol(tx, wallet, "sell", null) ?? undefined } };
}

/** The chain as the settle steps read it, for GodsEye's own wallet. */
export function walletChain(wallet: PublicKey): SettleChain {
  const owner = wallet.toBase58();
  return {
    async status(signature) {
      noteCopyRpc();
      const s = (await withTimeout(copyConnection().getSignatureStatuses([signature], { searchTransactionHistory: true }), READ_MS, "transaction status")).value[0];
      return s ? { err: s.err, confirmed: s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized" } : undefined;
    },
    blockHeight() {
      noteCopyRpc();
      return withTimeout(copyConnection().getBlockHeight("confirmed"), READ_MS, "block height");
    },
    async trade(signature, mint) {
      const tx = await withTimeout(fetchParsedOne(signature), READ_MS, "transaction");
      if (!tx) throw new Error("the transaction can't be read yet");
      return tradeOf(tx, owner, mint, signature);
    },
    async tokenHistory(mint, limit) {
      // The coin's token account in the wallet, under either token program (a closed account keeps its history).
      const accounts = [TOKEN_PROGRAM, TOKEN_2022_PROGRAM].map((program) => associatedTokenAddress(wallet, new PublicKey(mint), new PublicKey(program)));
      const lists = await Promise.all(
        accounts.map((account) => {
          noteCopyRpc();
          return withTimeout(copyConnection().getSignaturesForAddress(account, { limit }, "confirmed"), READ_MS, "token history");
        }),
      );
      const landed = new Map(lists.flat().filter((s) => !s.err).map((s) => [s.signature, s]));
      return [...landed.values()].sort((a, b) => b.slot - a.slot).map((s) => ({ signature: s.signature, atMs: s.blockTime ? s.blockTime * 1000 : null }));
    },
  };
}
