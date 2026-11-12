/**
 * Executes GodsEye's copy trades.
 *   real  — Jupiter swap from GodsEye's wallet, checked (verify.ts) before signing
 *   paper — same Jupiter quote, nothing sent (for testing a setup)
 */
import { PublicKey, SendTransactionError, TransactionInstruction, TransactionMessage, VersionedTransaction, type Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { LAMPORTS_PER_SOL, SOL_MINT } from "@godseye/shared";
import { config } from "../config";
import { copyConnection } from "../rpc";
import { jupiterQuote, jupiterSwapTx, type JupQuote, refuseHighImpact } from "../market/jupiter";
import { tokenDecimals } from "../market/decimals";
import { fetchParsedOne } from "../chain/history";
import { noteCopyRpc } from "../chain/rpc-budget";
import { parseSwap, tradeCostSol } from "../chain/parse";
import { solUsdAt } from "../market/solprice";
import { jitoSend } from "./jito";
import { overheadLamports, simulateCheck, staticCheck } from "./verify";

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

/** How often an unconfirmed transaction is sent again (blocks take ~200 ms and a blockhash lives ~30 s). */
const RESEND_MS = 1000;
/** How often the chain is asked whether the transaction landed. */
const POLL_MS = 500;
/** The block height is read on every Nth poll. */
const HEIGHT_EVERY = 4;
/** Reads in a row that may fail before the outcome is left to the settle step. */
const MAX_UNREAD = 6;
/** Longest wait for a result (a stalled chain never passes the last valid height). */
const LANDING_MAX_MS = 75_000;
/** Blocks past a transaction's last valid height before "it never landed" is believed (a node can lag). */
export const EXPIRY_MARGIN_BLOCKS = 20;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface Fill {
  signature: string | null;
  solAmount: number;
  tokenAmount: number;
  priceSol: number;
  /** Network fee, tips and token-account rent this trade cost, in SOL (undefined = not known, e.g. paper). */
  feeSol?: number;
}

/** Called once a transaction is signed, before it is sent, so its signature is on record whatever happens next. */
export type OnSigned = (signature: string, lastValidBlockHeight: number) => void;

export interface Executor {
  mode: "real" | "paper";
  buy(mint: string, sol: number, onSigned?: OnSigned): Promise<Fill>;
  /** Sell `tokens` (or everything GodsEye holds of this token if `all`), allowing `slippageBps` (default COPY_SLIPPAGE_BPS). */
  sell(mint: string, tokens: number, all: boolean, slippageBps?: number, onSigned?: OnSigned): Promise<Fill>;
  /** SOL a sell of `tokens` would get right now (a quote, nothing sent); null if no route. */
  quoteSellSol?(mint: string, tokens: number): Promise<number | null>;
}

/**
 * A signed transaction whose outcome isn't known: it may have landed. The trade must stay pending and be settled from the
 * chain (recovery.ts), never marked failed.
 */
export class UnsettledError extends Error {
  constructor(readonly signature: string, readonly lastValidBlockHeight: number, why: string) {
    super(`outcome not known yet (${why}); settling from the chain (${signature})`);
    this.name = "UnsettledError";
  }
}

/** A sell found none of the token in the wallet. */
export class NothingHeldError extends Error {
  constructor() {
    super("GodsEye holds none of this token");
    this.name = "NothingHeldError";
  }
}

type SigStatus = { err: unknown; confirmed: boolean } | undefined;

export interface LandingProbe {
  /** The signature's status, undefined when the chain has no record of it; `history` also searches older blocks. Throws if unread. */
  status(history: boolean): Promise<SigStatus>;
  /** Confirmed block height. */
  blockHeight(): Promise<number>;
  /** Send the same signed transaction again. */
  resend(): Promise<unknown>;
  sleep(ms: number): Promise<unknown>;
  now?(): number;
}

export type Landing = { status: "landed" } | { status: "failed"; err: unknown } | { status: "expired" } | { status: "unknown"; why: string };

/**
 * Wait for a sent transaction's result by asking the chain (no websocket: a dropped subscription used to report landed
 * swaps as expired). "expired" is only said once the chain is past the transaction's last valid block, plus a margin, and a
 * search through history still finds nothing. Anything unclear is "unknown", which the caller must treat as "may have landed".
 */
export async function awaitLanding(lastValidBlockHeight: number, p: LandingProbe, o: { pollMs?: number; resendMs?: number; maxMs?: number } = {}): Promise<Landing> {
  const pollMs = o.pollMs ?? POLL_MS;
  const resendMs = o.resendMs ?? RESEND_MS;
  const maxMs = o.maxMs ?? LANDING_MAX_MS;
  const now = p.now ?? Date.now;
  const started = now();
  let lastSend = started;
  let unread = 0;
  const result = (s: SigStatus): Landing | null => (s?.confirmed ? (s.err ? { status: "failed", err: s.err } : { status: "landed" }) : null);
  const unknown = (why: string): Landing => ({ status: "unknown", why: why.slice(0, 160) });
  for (let i = 1; ; i++) {
    await p.sleep(pollMs);
    try {
      const done = result(await p.status(false));
      if (done) return done;
      unread = 0;
    } catch (e) {
      if (++unread >= MAX_UNREAD) return unknown(`the chain couldn't be read: ${(e as Error).message}`);
    }
    if (i % HEIGHT_EVERY === 0) {
      const height = await p.blockHeight().catch(() => null);
      if (height !== null && height > lastValidBlockHeight + EXPIRY_MARGIN_BLOCKS) {
        // It can't land any more. One last look, through history too, before believing it never did.
        try {
          const last = await p.status(true);
          return result(last) ?? (last ? unknown("seen on chain but not confirmed") : { status: "expired" });
        } catch (e) {
          return unknown(`the chain couldn't be read: ${(e as Error).message}`);
        }
      }
    }
    if (now() - started >= maxMs) return unknown(`no result after ${Math.round(maxMs / 1000)} s`);
    if (now() - lastSend >= resendMs) {
      lastSend = now();
      void p.resend().catch(() => undefined);
    }
  }
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
    refuseHighImpact(q, config.maxPriceImpactPct); // as the real executor does, so paper shows the same skips
    return fillFromQuote("buy", q, await decimalsOf(mint), null);
  }
  async sell(mint: string, tokens: number, _all = false, slippageBps = config.slippageBps): Promise<Fill> {
    const dec = await decimalsOf(mint);
    const q = await jupiterQuote(mint, SOL_MINT, BigInt(Math.floor(tokens * 10 ** dec)), slippageBps);
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

  private async execute(side: "buy" | "sell", mint: string, quote: JupQuote, onSigned?: OnSigned): Promise<Fill> {
    const conn = copyConnection();
    const wallet = this.keypair.publicKey;
    const viaJito = config.sendVia === "jito";
    const tip = viaJito ? config.jitoTipLamports : 0;
    const built = await jupiterSwapTx(quote, wallet.toBase58(), tip);
    const tx = VersionedTransaction.deserialize(Buffer.from(built.swapTransaction, "base64"));

    const problem = staticCheck(tx, wallet, config.priorityFeeMaxLamports, tip);
    if (problem) throw new Error(`refused to sign: ${problem}`);
    await simulateCheck(
      conn, tx, wallet,
      side === "buy"
        ? { side, mint, inLamports: BigInt(quote.inAmount), minTokensOut: BigInt(quote.otherAmountThreshold) }
        : { side, mint, minLamportsOut: BigInt(quote.otherAmountThreshold) },
      { overheadLamports: overheadLamports(config.priorityFeeMaxLamports, tip) },
    );

    tx.sign([this.keypair]);
    const raw = tx.serialize();
    // The signature is known before anything is sent. It goes on record first: from the send on, the swap may land whatever
    // this process sees (a dropped reply, a crash), and the signature is how it is found again.
    const signature = bs58.encode(tx.signatures[0]);
    const lastValid = built.lastValidBlockHeight;
    onSigned?.(signature, lastValid);
    // Through Jito first when set: it isn't seen in the public queue there. If Jito doesn't take it, the RPC does.
    const jito = viaJito && (await jitoSend(raw).then(() => true, () => false));
    if (!jito) {
      noteCopyRpc();
      try {
        await conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 3 });
      } catch (e) {
        // The node refused it outright: nothing was sent. Any other failure (a timeout, a dropped connection) may have got
        // through, so carry on: the re-sends below try again and the chain says what happened.
        if (e instanceof SendTransactionError) throw e;
      }
    }
    let resends = 0;
    // Until it lands or its blockhash expires, the same signed transaction is sent again every second: a single send that
    // a busy leader dropped left buys "expired: block height exceeded". Re-sending costs nothing; it can only land once.
    const landing = await awaitLanding(lastValid, {
      status: async (history) => {
        noteCopyRpc();
        const s = (await conn.getSignatureStatuses([signature], { searchTransactionHistory: history })).value[0];
        return s ? { err: s.err, confirmed: s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized" } : undefined;
      },
      blockHeight: () => {
        noteCopyRpc();
        return conn.getBlockHeight("confirmed");
      },
      resend: () => {
        // Jito allows about one send a second from this address: every other re-send goes there. After about ten seconds
        // without landing, the RPC takes the re-sends too (landing beats staying out of the public queue).
        if (jito && ++resends <= 10) return resends % 2 === 0 ? jitoSend(raw) : Promise.resolve();
        noteCopyRpc();
        return conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 });
      },
      sleep,
    });
    if (landing.status === "failed") throw new Error(`transaction failed on-chain: ${JSON.stringify(landing.err)} (${signature})`);
    if (landing.status === "expired") throw new Error(`expired: the transaction never landed (${signature})`);
    if (landing.status === "unknown") throw new UnsettledError(signature, lastValid, landing.why);

    // It landed. Record what really happened, not what the quote said. A failure from here on must not turn a real trade
    // into a "failed" one, so it is handed to the settle step instead.
    try {
      const landed = await fetchParsedOne(signature);
      const parsed = landed ? parseSwap(landed, wallet.toBase58(), { solUsdAt }) : null;
      const feeSol = landed ? tradeCostSol(landed, wallet.toBase58(), side, parsed && parsed.mint === mint ? parsed.solAmount : null) : undefined;
      if (parsed && parsed.mint === mint) return { signature, solAmount: parsed.solAmount, tokenAmount: parsed.tokenAmount, priceSol: parsed.priceSol, feeSol: feeSol ?? undefined };
      return { ...fillFromQuote(side, quote, await decimalsOf(mint), signature), feeSol: feeSol ?? undefined };
    } catch (e) {
      throw new UnsettledError(signature, lastValid, `it landed, but its amounts couldn't be read: ${(e as Error).message.slice(0, 120)}`);
    }
  }

  async buy(mint: string, sol: number, onSigned?: OnSigned): Promise<Fill> {
    const q = await jupiterQuote(SOL_MINT, mint, BigInt(Math.floor(sol * LAMPORTS_PER_SOL)), config.slippageBps);
    // A thin pool or a size too big for it: what a sandwich feeds on. Sells are never held back by this.
    refuseHighImpact(q, config.maxPriceImpactPct);
    return this.execute("buy", mint, q, onSigned);
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

  async sell(mint: string, tokens: number, all: boolean, slippageBps = config.slippageBps, onSigned?: OnSigned): Promise<Fill> {
    const held = await this.heldAtomic(mint);
    if (held === 0n) throw new NothingHeldError();
    const dec = await decimalsOf(mint);
    const wanted = BigInt(Math.floor(tokens * 10 ** dec));
    const amount = all || wanted >= held ? held : wanted;
    const q = await jupiterQuote(mint, SOL_MINT, amount, slippageBps);
    const fill = await this.execute("sell", mint, q, onSigned);
    if (amount !== held) return fill;
    // Sold everything: the token account is empty, so take its rent back and count it against this trade's costs.
    const back = await this.reclaimRent(mint).catch(() => 0);
    return back > 0 && fill.feeSol !== undefined ? { ...fill, feeSol: fill.feeSol - back } : fill;
  }
}
