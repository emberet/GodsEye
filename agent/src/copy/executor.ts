/**
 * Executes GodsEye's copy trades.
 *   real  — Jupiter swap from GodsEye's wallet, checked (verify.ts) before signing
 *   paper — same Jupiter quote, nothing sent (for testing a setup)
 */
import { PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction, type Keypair } from "@solana/web3.js";
import { LAMPORTS_PER_SOL, SOL_MINT } from "@godseye/shared";
import { config } from "../config";
import { copyConnection } from "../rpc";
import { jupiterQuote, jupiterSwapTx, type JupQuote } from "../market/jupiter";
import { tokenDecimals } from "../market/decimals";
import { fetchParsedOne } from "../chain/history";
import { noteCopyRpc } from "../chain/rpc-budget";
import { parseSwap, tradeCostSol } from "../chain/parse";
import { solUsdAt } from "../market/solprice";
import { simulateCheck, staticCheck } from "./verify";

/**
 * SPL Token CloseAccount (instruction 9, the same in Token-2022): an empty token account's rent (~0.002 SOL) goes back to
 * `owner`. The program refuses it unless the balance is zero.
 */
export function closeAccountIx(account: PublicKey, owner: PublicKey, programId: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: account, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data: Buffer.from([9]),
  });
}

/** Closes per transaction (each instruction is small; this keeps one failure from costing many). */
const CLOSES_PER_TX = 12;

const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const BASE_FEE_SOL = 0.000005;

/** How often an unconfirmed transaction is sent again. */
const RESEND_MS = 2000;

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
  /** SOL a sell of `tokens` would get right now (a quote, nothing sent); null if no route. */
  quoteSellSol?(mint: string, tokens: number): Promise<number | null>;
}

async function sellQuoteSol(mint: string, tokens: number): Promise<number | null> {
  const amount = BigInt(Math.floor(tokens * 10 ** (await decimalsOf(mint))));
  if (amount <= 0n) return null;
  const q = await jupiterQuote(mint, SOL_MINT, amount, config.slippageBps);
  const sol = Number(q.outAmount) / LAMPORTS_PER_SOL;
  return sol > 0 ? sol : null;
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
  quoteSellSol = sellQuoteSol;
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
  quoteSellSol = sellQuoteSol;
  constructor(private keypair: Keypair) {
    if (process.env.GODSEYE_TEST === "1") throw new Error("Tests must never build a real executor (it signs and sends transactions).");
  }

  private async heldAtomic(mint: string): Promise<bigint> {
    noteCopyRpc();
    const res = await copyConnection().getParsedTokenAccountsByOwner(this.keypair.publicKey, { mint: new PublicKey(mint) });
    return res.value.reduce((s, a) => s + BigInt((a.account.data.parsed as { info: { tokenAmount: { amount: string } } }).info.tokenAmount.amount), 0n);
  }

  private async execute(side: "buy" | "sell", mint: string, quote: JupQuote): Promise<Fill> {
    const conn = copyConnection();
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
    const raw = tx.serialize();
    noteCopyRpc();
    const signature = await conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 3 });
    // Until it confirms or its blockhash expires, send the same signed transaction again every 2 s: a single send that a
    // busy leader dropped left buys "expired: block height exceeded". Re-sending costs nothing; it can only land once.
    let settled = false;
    const resend = (async () => {
      while (!settled) {
        await new Promise((r) => setTimeout(r, RESEND_MS));
        if (settled) break;
        noteCopyRpc();
        await conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => undefined);
      }
    })();
    // Confirm against the blockhash the transaction was actually built with.
    const conf = await conn
      .confirmTransaction({ signature, blockhash: tx.message.recentBlockhash, lastValidBlockHeight: built.lastValidBlockHeight }, "confirmed")
      .finally(() => {
        settled = true;
      });
    await resend;
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

  /**
   * Close the wallet's empty token accounts (of one mint, or all) and take their rent back: a buy pays ~0.002 SOL to open
   * one, about 2% of a 0.1 SOL copy, and it stays locked until the account is closed. Returns SOL reclaimed, net of fees.
   */
  async reclaimRent(mint?: string): Promise<number> {
    const conn = copyConnection();
    const owner = this.keypair.publicKey;
    const lists = await Promise.all(
      mint
        ? [conn.getParsedTokenAccountsByOwner(owner, { mint: new PublicKey(mint) })]
        : [TOKEN_PROGRAM, TOKEN_2022_PROGRAM].map((p) => conn.getParsedTokenAccountsByOwner(owner, { programId: new PublicKey(p) })),
    );
    lists.forEach(() => noteCopyRpc());
    const empty = lists
      .flatMap((l) => l.value)
      .filter((a) => (a.account.data.parsed as { info: { tokenAmount: { amount: string } } }).info.tokenAmount.amount === "0");
    let back = 0;
    for (let i = 0; i < empty.length; i += CLOSES_PER_TX) {
      const batch = empty.slice(i, i + CLOSES_PER_TX);
      noteCopyRpc();
      const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
      const msg = new TransactionMessage({ payerKey: owner, recentBlockhash: blockhash, instructions: batch.map((a) => closeAccountIx(a.pubkey, owner, a.account.owner)) }).compileToV0Message();
      const tx = new VersionedTransaction(msg);
      tx.sign([this.keypair]);
      noteCopyRpc();
      const signature = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
      const conf = await conn.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
      if (conf.value.err) throw new Error(`closing token accounts failed on-chain: ${JSON.stringify(conf.value.err)} (${signature})`);
      back += batch.reduce((s, a) => s + a.account.lamports, 0) / LAMPORTS_PER_SOL - BASE_FEE_SOL;
    }
    return back;
  }

  async sell(mint: string, tokens: number, all: boolean): Promise<Fill> {
    const held = await this.heldAtomic(mint);
    if (held === 0n) throw new Error("GodsEye holds none of this token");
    const dec = await decimalsOf(mint);
    const wanted = BigInt(Math.floor(tokens * 10 ** dec));
    const amount = all || wanted >= held ? held : wanted;
    const q = await jupiterQuote(mint, SOL_MINT, amount, config.slippageBps);
    const fill = await this.execute("sell", mint, q);
    if (amount !== held) return fill;
    // Sold everything: the token account is empty, so take its rent back and count it against this trade's costs.
    const back = await this.reclaimRent(mint).catch(() => 0);
    return back > 0 && fill.feeSol !== undefined ? { ...fill, feeSol: fill.feeSol - back } : fill;
  }
}
