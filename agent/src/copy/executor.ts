/**
 * Executes GodsEye's copy trades.
 *   real  — Jupiter swap from GodsEye's wallet, checked (verify.ts) before signing
 *   paper — same Jupiter quote, nothing sent (for testing a setup)
 */
import { PublicKey, VersionedTransaction, type Keypair } from "@solana/web3.js";
import { LAMPORTS_PER_SOL, SOL_MINT } from "@godseye/shared";
import { config } from "../config";
import { connection } from "../rpc";
import { jupiterQuote, jupiterSwapTx, type JupQuote } from "../market/jupiter";
import { tokenDecimals } from "../market/decimals";
import { fetchParsedOne } from "../chain/history";
import { parseSwap, tradeCostSol } from "../chain/parse";
import { solUsdAt } from "../market/solprice";
import { simulateCheck, staticCheck } from "./verify";

export interface Fill {
  signature: string | null;
  solAmount: number;
  tokenAmount: number;
  priceSol: number;
  /** Network fee, tips and token-account rent this trade cost, in SOL (undefined = not known, e.g. paper). */
  feeSol?: number;
}

export interface Executor {
  mode: "real" | "paper";
  buy(mint: string, sol: number): Promise<Fill>;
  /** Sell `tokens` (or everything GodsEye holds of this token if `all`). */
  sell(mint: string, tokens: number, all: boolean): Promise<Fill>;
}

async function decimalsOf(mint: string): Promise<number> {
  const d = await tokenDecimals(mint);
  if (d === undefined) throw new Error("couldn't read token decimals");
  return d;
}

const fillFromQuote = (side: "buy" | "sell", q: JupQuote, decimals: number, signature: string | null): Fill => {
  const sol = Number(side === "buy" ? q.inAmount : q.outAmount) / LAMPORTS_PER_SOL;
  const tokens = Number(side === "buy" ? q.outAmount : q.inAmount) / 10 ** decimals;
  if (!(tokens > 0) || !(sol > 0)) throw new Error(`quote has no ${tokens > 0 ? "SOL" : "tokens"} on one side`);
  return { signature, solAmount: sol, tokenAmount: tokens, priceSol: sol / tokens };
};

export class PaperExecutor implements Executor {
  mode = "paper" as const;
  async buy(mint: string, sol: number): Promise<Fill> {
    const q = await jupiterQuote(SOL_MINT, mint, BigInt(Math.floor(sol * LAMPORTS_PER_SOL)), config.slippageBps);
    return fillFromQuote("buy", q, await decimalsOf(mint), null);
  }
  async sell(mint: string, tokens: number): Promise<Fill> {
    const dec = await decimalsOf(mint);
    const q = await jupiterQuote(mint, SOL_MINT, BigInt(Math.floor(tokens * 10 ** dec)), config.slippageBps);
    return fillFromQuote("sell", q, dec, null);
  }
}

export class RealExecutor implements Executor {
  mode = "real" as const;
  constructor(private keypair: Keypair) {
    if (process.env.GODSEYE_TEST === "1") throw new Error("Tests must never build a real executor (it signs and sends transactions).");
  }

  private async heldAtomic(mint: string): Promise<bigint> {
    const res = await connection().getParsedTokenAccountsByOwner(this.keypair.publicKey, { mint: new PublicKey(mint) });
    return res.value.reduce((s, a) => s + BigInt((a.account.data.parsed as { info: { tokenAmount: { amount: string } } }).info.tokenAmount.amount), 0n);
  }

  private async execute(side: "buy" | "sell", mint: string, quote: JupQuote): Promise<Fill> {
    const conn = connection();
    const wallet = this.keypair.publicKey;
    const built = await jupiterSwapTx(quote, wallet.toBase58());
    const tx = VersionedTransaction.deserialize(Buffer.from(built.swapTransaction, "base64"));

    const problem = staticCheck(tx, wallet, config.priorityFeeMaxLamports);
    if (problem) throw new Error(`refused to sign: ${problem}`);
    await simulateCheck(
      conn, tx, wallet,
      side === "buy"
        ? { side, mint, inLamports: BigInt(quote.inAmount), minTokensOut: BigInt(quote.otherAmountThreshold) }
        : { side, minLamportsOut: BigInt(quote.otherAmountThreshold) },
    );

    tx.sign([this.keypair]);
    const signature = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 3 });
    // Confirm against the blockhash the transaction was actually built with.
    const conf = await conn.confirmTransaction({ signature, blockhash: tx.message.recentBlockhash, lastValidBlockHeight: built.lastValidBlockHeight }, "confirmed");
    if (conf.value.err) throw new Error(`transaction failed on-chain: ${JSON.stringify(conf.value.err)} (${signature})`);

    // Record what really happened, not what the quote said.
    const landed = await fetchParsedOne(signature);
    const parsed = landed ? parseSwap(landed, wallet.toBase58(), { solUsdAt }) : null;
    const feeSol = landed ? tradeCostSol(landed, wallet.toBase58(), side, parsed && parsed.mint === mint ? parsed.solAmount : null) : undefined;
    if (parsed && parsed.mint === mint) return { signature, solAmount: parsed.solAmount, tokenAmount: parsed.tokenAmount, priceSol: parsed.priceSol, feeSol: feeSol ?? undefined };
    return { ...fillFromQuote(side, quote, await decimalsOf(mint), signature), feeSol: feeSol ?? undefined };
  }

  async buy(mint: string, sol: number): Promise<Fill> {
    const q = await jupiterQuote(SOL_MINT, mint, BigInt(Math.floor(sol * LAMPORTS_PER_SOL)), config.slippageBps);
    return this.execute("buy", mint, q);
  }

  async sell(mint: string, tokens: number, all: boolean): Promise<Fill> {
    const held = await this.heldAtomic(mint);
    if (held === 0n) throw new Error("GodsEye holds none of this token");
    const dec = await decimalsOf(mint);
    const wanted = BigInt(Math.floor(tokens * 10 ** dec));
    const amount = all || wanted >= held ? held : wanted;
    const q = await jupiterQuote(mint, SOL_MINT, amount, config.slippageBps);
    return this.execute("sell", mint, q);
  }
}
