import type { TxLike, TokenBalanceLike } from "../src/chain/parse";
import type { SwapLite } from "../src/analysis/pnl";

export const WALLET = "Wa11et1111111111111111111111111111111111111";
export const MINT = "Mint111111111111111111111111111111111111111";
export const POOL = "Poo1111111111111111111111111111111111111111";
export const JUP = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
export const PUMP = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

const pk = (s: string) => ({ pubkey: { toString: () => s } });
const prog = (s: string) => ({ programId: { toString: () => s } });

export function tokenBal(accountIndex: number, mint: string, owner: string, amount: number, decimals = 6): TokenBalanceLike {
  return { accountIndex, mint, owner, uiTokenAmount: { amount: String(Math.round(amount * 10 ** decimals)), decimals } };
}

/** A transaction where WALLET (key 0) and a pool (key 1) swap SOL for MINT. */
export function swapTx(opts: {
  solDelta: number; // wallet's SOL change incl. fee, in SOL
  tokenBefore: number;
  tokenAfter: number;
  newTokenAccount?: boolean;
  programs?: string[];
  inner?: string[];
  fee?: number;
  err?: unknown;
  extraKeys?: { key: string; pre: number; post: number }[];
}): TxLike {
  const fee = opts.fee ?? 5000;
  const pre = [10e9, 100e9, 0];
  const post = [10e9 + Math.round(opts.solDelta * 1e9), 100e9 - Math.round(opts.solDelta * 1e9), 0];
  const keys = [pk(WALLET), pk(POOL), pk("TokAcct111111111111111111111111111111111111")];
  for (const k of opts.extraKeys ?? []) {
    keys.push(pk(k.key));
    pre.push(k.pre);
    post.push(k.post);
  }
  return {
    slot: 1,
    blockTime: 1_760_000_000,
    meta: {
      err: opts.err ?? null,
      fee,
      preBalances: pre,
      postBalances: post,
      preTokenBalances: opts.newTokenAccount ? [] : [tokenBal(2, MINT, WALLET, opts.tokenBefore)],
      postTokenBalances: [tokenBal(2, MINT, WALLET, opts.tokenAfter)],
      innerInstructions: opts.inner ? [{ instructions: opts.inner.map(prog) }] : [],
    },
    transaction: { signatures: ["sig1"], message: { accountKeys: keys, instructions: (opts.programs ?? [JUP]).map(prog) } },
  };
}

let n = 0;
export function swap(p: Partial<SwapLite> & Pick<SwapLite, "ts" | "side" | "sol_amount" | "token_amount">): SwapLite {
  n++;
  return {
    signature: `s${n}`,
    mint: MINT,
    price_sol: p.sol_amount / p.token_amount,
    venue: "jupiter",
    jito_tip: 0,
    token_age_sec: null,
    ...p,
  };
}

export const iso = (msAgo: number, now = Date.now()) => new Date(now - msAgo).toISOString();
export const H = 3_600_000;
export const D = 24 * H;
