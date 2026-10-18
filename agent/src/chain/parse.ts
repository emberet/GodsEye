/**
 * Turns a Solana transaction into "wallet X bought/sold token Y for Z SOL".
 *
 * Works from balance changes (before vs after), not from any one DEX's
 * instruction format, so it understands Jupiter, pump.fun, Raydium, trading
 * bots and custom programs alike. Only SOL-priced swaps count (SOL or wrapped
 * SOL on one side, exactly one other token on the other); token-to-token
 * swaps and SOL ↔ USDC/USDT swaps are skipped so every P&L figure is in SOL.
 */
import { SOL_MINT, USDC_MINT, USDT_MINT } from "@godseye/shared";
import { JITO_TIP_ACCOUNTS, PLUMBING, VENUES, VENUE_RANK } from "./programs";

/** Rent locked in a new token account (refunded when it's closed). Not part of the trade. */
export const TOKEN_ACCOUNT_RENT_LAMPORTS = 2_039_280;
const DUST_TOKENS = 1e-9;
const STABLECOINS = new Set([USDC_MINT, USDT_MINT]);
const MIN_SOL = 0.0001;

/** The parts of an RPC "jsonParsed" transaction GodsEye reads (raw JSON: keys and program IDs are strings). */
export interface TxLike {
  slot: number;
  blockTime?: number | null;
  meta: {
    err: unknown;
    fee: number;
    preBalances: number[];
    postBalances: number[];
    preTokenBalances?: TokenBalanceLike[] | null;
    postTokenBalances?: TokenBalanceLike[] | null;
    innerInstructions?: { instructions: { programId: { toString(): string } }[] }[] | null;
  } | null;
  transaction: {
    signatures: string[];
    message: {
      accountKeys: { pubkey: { toString(): string } }[];
      instructions: { programId: { toString(): string } }[];
    };
  };
}

export interface TokenBalanceLike {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string; decimals: number };
}

export interface ParsedSwap {
  wallet: string;
  signature: string;
  slot: number;
  ts: string;
  mint: string;
  side: "buy" | "sell";
  tokenAmount: number;
  tokenBalanceBefore: number;
  solAmount: number;
  priceSol: number;
  venue: string | null;
  jitoTip: boolean;
  feeLamports: number;
}

const amountOf = (b: TokenBalanceLike): number => Number(b.uiTokenAmount.amount) / 10 ** b.uiTokenAmount.decimals;

/** Which venue a transaction used. "(via bot)" = a known DEX reached through an unknown program (trading bot / router). */
export function detectVenue(tx: TxLike): string | null {
  const pick = (ids: string[]) => {
    const labels = ids.map((id) => VENUES[id]).filter(Boolean);
    return VENUE_RANK.find((v) => labels.includes(v)) ?? null;
  };
  const top = tx.transaction.message.instructions.map((i) => i.programId.toString());
  const direct = pick(top);
  if (direct) return direct;
  const inner = (tx.meta?.innerInstructions ?? []).flatMap((ii) => ii.instructions.map((i) => i.programId.toString()));
  const routed = pick(inner);
  if (!routed) return null;
  const unknownTop = top.some((id) => !PLUMBING.has(id) && !VENUES[id]);
  return unknownTop ? `${routed} (via bot)` : routed;
}

/** The swap `wallet` made in this transaction, or null if it wasn't a simple SOL-priced swap. */
export function parseSwap(tx: TxLike, wallet: string): ParsedSwap | null {
  const meta = tx.meta;
  if (!meta || meta.err) return null;
  const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey.toString());
  const idx = keys.indexOf(wallet);
  if (idx < 0) return null;

  // SOL change, ignoring the network fee (paid by the fee payer, key 0).
  let lamports = meta.postBalances[idx] - meta.preBalances[idx] + (idx === 0 ? meta.fee : 0);

  // Jito tips are a cost of getting in fast, not part of the price.
  let tipLamports = 0;
  keys.forEach((k, i) => {
    if (JITO_TIP_ACCOUNTS.has(k)) tipLamports += Math.max(0, meta.postBalances[i] - meta.preBalances[i]);
  });
  if (idx === 0) lamports += tipLamports;

  // Token changes for accounts this wallet owns.
  const pre = (meta.preTokenBalances ?? []).filter((b) => b.owner === wallet);
  const post = (meta.postTokenBalances ?? []).filter((b) => b.owner === wallet);
  const deltas = new Map<string, { before: number; after: number }>();
  for (const b of pre) {
    const d = deltas.get(b.mint) ?? { before: 0, after: 0 };
    d.before += amountOf(b);
    deltas.set(b.mint, d);
  }
  for (const b of post) {
    const d = deltas.get(b.mint) ?? { before: 0, after: 0 };
    d.after += amountOf(b);
    deltas.set(b.mint, d);
  }
  // Token accounts opened (rent paid) or closed (rent refunded) in this transaction.
  const preIdx = new Set(pre.map((b) => b.accountIndex));
  const postIdx = new Set(post.map((b) => b.accountIndex));
  const opened = post.filter((b) => !preIdx.has(b.accountIndex) && b.mint !== SOL_MINT).length;
  const closed = pre.filter((b) => !postIdx.has(b.accountIndex) && b.mint !== SOL_MINT).length;
  lamports += (opened - closed) * TOKEN_ACCOUNT_RENT_LAMPORTS;

  // Wrapped SOL counts as SOL.
  const wsol = deltas.get(SOL_MINT);
  if (wsol) {
    lamports += Math.round((wsol.after - wsol.before) * 1e9);
    deltas.delete(SOL_MINT);
  }

  const moved = [...deltas.entries()].filter(([, d]) => Math.abs(d.after - d.before) > DUST_TOKENS);
  if (moved.length !== 1) return null;
  if (STABLECOINS.has(moved[0][0])) return null; // SOL ↔ dollars is not a token trade
  const [mint, d] = moved[0];
  const tokenDelta = d.after - d.before;
  const sol = lamports / 1e9;
  let side: "buy" | "sell";
  if (tokenDelta > 0 && sol < 0) side = "buy";
  else if (tokenDelta < 0 && sol > 0) side = "sell";
  else return null;
  const solAmount = Math.abs(sol);
  const tokenAmount = Math.abs(tokenDelta);
  if (solAmount < MIN_SOL) return null;

  return {
    wallet,
    signature: tx.transaction.signatures[0],
    slot: tx.slot,
    ts: new Date((tx.blockTime ?? Date.now() / 1000) * 1000).toISOString(),
    mint,
    side,
    tokenAmount,
    tokenBalanceBefore: d.before,
    solAmount,
    priceSol: solAmount / tokenAmount,
    venue: detectVenue(tx),
    jitoTip: tipLamports > 0,
    feeLamports: meta.fee,
  };
}

/**
 * Who first sent SOL to a wallet, from its very first transaction.
 * The account whose SOL went down the most while the wallet's went up.
 */
export function findFunder(tx: TxLike, wallet: string): string | null {
  const meta = tx.meta;
  if (!meta) return null;
  const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey.toString());
  const idx = keys.indexOf(wallet);
  if (idx < 0 || meta.postBalances[idx] <= meta.preBalances[idx]) return null;
  let best: string | null = null;
  let bestDrop = 0;
  keys.forEach((k, i) => {
    if (i === idx) return;
    const drop = meta.preBalances[i] - meta.postBalances[i] - (i === 0 ? meta.fee : 0);
    if (drop > bestDrop) {
      bestDrop = drop;
      best = k;
    }
  });
  return best;
}

/**
 * Brand-new wallets this wallet funded in this transaction: accounts that had
 * 0 SOL before and received at least `minSol` while this wallet paid.
 * (How GodsEye notices a tracked trader moving to a fresh wallet.)
 */
export function findNewWalletsFunded(tx: TxLike, wallet: string, minSol: number): { address: string; sol: number }[] {
  const meta = tx.meta;
  if (!meta || meta.err) return [];
  const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey.toString());
  const idx = keys.indexOf(wallet);
  if (idx < 0 || meta.postBalances[idx] >= meta.preBalances[idx]) return [];
  const tokenAccounts = new Set([...(meta.preTokenBalances ?? []), ...(meta.postTokenBalances ?? [])].map((b) => b.accountIndex));
  const programs = new Set([
    ...tx.transaction.message.instructions.map((i) => i.programId.toString()),
    ...(meta.innerInstructions ?? []).flatMap((ii) => ii.instructions.map((i) => i.programId.toString())),
  ]);
  const out: { address: string; sol: number }[] = [];
  keys.forEach((k, i) => {
    if (i === idx || tokenAccounts.has(i) || programs.has(k) || JITO_TIP_ACCOUNTS.has(k)) return;
    const gained = (meta.postBalances[i] - meta.preBalances[i]) / 1e9;
    if (meta.preBalances[i] === 0 && gained >= minSol) out.push({ address: k, sol: gained });
  });
  return out;
}
