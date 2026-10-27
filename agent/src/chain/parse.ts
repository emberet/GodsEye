/**
 * Turns a Solana transaction into "wallet X bought/sold token Y for Z SOL".
 *
 * Works from balance changes (before vs after), not from any one DEX's
 * instruction format, so it understands Jupiter, pump.fun, Raydium, trading
 * bots and custom programs alike.
 *
 * A swap counts when exactly one token (the memecoin) moved and the wallet
 * paid or received SOL, wrapped SOL, USDC or USDT for it. A memecoin ↔
 * memecoin swap also counts when its route settled through SOL (the SOL
 * leaving one pool ≈ the SOL entering the other): it's recorded as a sell
 * of one token and a buy of the other, both worth that SOL. Dollar amounts are
 * converted to SOL at SOL's price when the swap happened (market/solprice.ts),
 * so every P&L figure is in SOL. Skipped: non-memecoins (wrapped BTC/ETH,
 * staked SOL, big DeFi tokens — see NON_MEMECOIN_MINTS), token ↔ token swaps that didn't go
 * through SOL, plain SOL ↔ USDC/USDT conversions, and dollar-priced swaps
 * whose SOL price is unknown.
 */
import { NON_MEMECOIN_MINTS, SOL_MINT, USDC_MINT, USDT_MINT } from "@godseye/shared";
import { JITO_TIP_ACCOUNTS, PLUMBING, VENUE_LABELS, VENUE_RANK } from "./programs";

/** Rent locked in a new token account (refunded when it's closed). Not part of the trade. */
export const TOKEN_ACCOUNT_RENT_LAMPORTS = 2_039_280;
const DUST_TOKENS = 1e-9;
const STABLECOINS: Record<string, "USDC" | "USDT"> = { [USDC_MINT]: "USDC", [USDT_MINT]: "USDT" };
const MIN_SOL = 0.0001;
/** SOL left over after fees, tips and rent below this is noise, not part of the price. */
const SOL_NOISE = 0.0005;
/** Dollar moves below this are noise. */
const USD_NOISE = 0.01;

export interface ParseOptions {
  /** SOL's USD price at a moment (ms). Needed for USDC/USDT-priced swaps; without it they're skipped. */
  solUsdAt?: (tsMs: number) => number | null;
}

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
  /** Always in SOL (dollar-priced swaps converted at the time). */
  solAmount: number;
  priceSol: number;
  /** What was paid / received: "SOL", "USDC", "USDT", or a mix like "SOL+USDC". */
  quote: string;
  /** Amount in the quote's own unit (SOL or USD); for a mix, the SOL value. */
  quoteAmount: number;
  /** SOL's USD price at the time (null if unknown). */
  solUsd: number | null;
  /**
   * What the swap was worth in USD when it settled: the dollar amount itself for
   * USDC/USDT, SOL × SOL's price at the time for SOL. Null if SOL's price is unknown.
   */
  usdAmount: number | null;
  venue: string | null;
  jitoTip: boolean;
  feeLamports: number;
}

const amountOf = (b: TokenBalanceLike): number => Number(b.uiTokenAmount.amount) / 10 ** b.uiTokenAmount.decimals;

/** Which venue a transaction used. "(via bot)" = a known DEX reached through an unknown program (trading bot / router). */
export function detectVenue(tx: TxLike): string | null {
  const pick = (ids: string[]) => {
    const labels = ids.map((id) => VENUE_LABELS[id]).filter(Boolean);
    return VENUE_RANK.find((v) => labels.includes(v)) ?? null;
  };
  const top = tx.transaction.message.instructions.map((i) => i.programId.toString());
  const direct = pick(top);
  if (direct) return direct;
  const inner = (tx.meta?.innerInstructions ?? []).flatMap((ii) => ii.instructions.map((i) => i.programId.toString()));
  const routed = pick(inner);
  if (!routed) return null;
  const unknownTop = top.some((id) => !PLUMBING.has(id) && !VENUE_LABELS[id]);
  return unknownTop ? `${routed} (via bot)` : routed;
}

/** The first swap `wallet` made in this transaction, or null (see parseSwaps). */
export function parseSwap(tx: TxLike, wallet: string, opts: ParseOptions = {}): ParsedSwap | null {
  return parseSwaps(tx, wallet, opts)[0] ?? null;
}

/** Smallest SOL hop between pools that counts (below this it's rent or fees). */
const MIN_ROUTED_LAMPORTS = 1_000_000;
/** The SOL out of one pool and into the next must agree this closely. */
const ROUTE_MATCH = 0.9;

/**
 * SOL that moved between pools inside a token ↔ token swap: the biggest
 * drop and the biggest rise among accounts that aren't the wallet's.
 * Wrapped SOL is lamports held by its token account, so native balances
 * already include it. Returns null if there's no clear SOL hop.
 */
export function routedSolLamports(tx: TxLike, wallet: string): number | null {
  const meta = tx.meta!;
  const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey.toString());
  const walletAccounts = new Set(
    [...(meta.preTokenBalances ?? []), ...(meta.postTokenBalances ?? [])].filter((b) => b.owner === wallet).map((b) => b.accountIndex),
  );
  let out = 0;
  let into = 0;
  keys.forEach((k, i) => {
    if (k === wallet || walletAccounts.has(i) || JITO_TIP_ACCOUNTS.has(k)) return;
    const d = meta.postBalances[i] - meta.preBalances[i] + (i === 0 ? meta.fee : 0);
    if (d <= -MIN_ROUTED_LAMPORTS) out = Math.max(out, -d);
    if (d >= MIN_ROUTED_LAMPORTS) into = Math.max(into, d);
  });
  if (!out || !into || Math.min(out, into) / Math.max(out, into) < ROUTE_MATCH) return null;
  return out;
}

/**
 * What a trade cost on top of its price: the wallet's whole SOL change minus the swap's SOL amount — the
 * network fee, priority fee, Jito tips and token-account rent. `solAmount` is the parsed swap's SOL side
 * (null if unknown: then only the network fee and tips are counted). Never negative.
 */
export function tradeCostSol(tx: TxLike, wallet: string, side: "buy" | "sell", solAmount: number | null): number | null {
  const meta = tx.meta;
  if (!meta) return null;
  const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey.toString());
  const idx = keys.indexOf(wallet);
  if (idx < 0) return null;
  if (solAmount === null) {
    let tips = 0;
    keys.forEach((k, i) => {
      if (JITO_TIP_ACCOUNTS.has(k)) tips += Math.max(0, meta.postBalances[i] - meta.preBalances[i]);
    });
    return idx === 0 ? (meta.fee + tips) / 1e9 : 0;
  }
  const change = (meta.postBalances[idx] - meta.preBalances[idx]) / 1e9; // what the wallet's SOL really did
  const cost = side === "buy" ? -change - solAmount : solAmount - change;
  return Math.max(0, cost);
}

/**
 * The swaps `wallet` made in this transaction: one for a memecoin bought or
 * sold against SOL / USDC / USDT, two for a memecoin ↔ memecoin swap that
 * settled through SOL, none otherwise.
 */
export function parseSwaps(tx: TxLike, wallet: string, opts: ParseOptions = {}): ParsedSwap[] {
  const meta = tx.meta;
  if (!meta || meta.err) return [];
  const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey.toString());
  const idx = keys.indexOf(wallet);
  if (idx < 0) return [];

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

  // Dollars paid / received count as quote, like SOL.
  let usd = 0;
  const stables = new Set<string>();
  for (const [mint, label] of Object.entries(STABLECOINS)) {
    const d = deltas.get(mint);
    if (!d) continue;
    deltas.delete(mint);
    const change = d.after - d.before;
    if (Math.abs(change) >= USD_NOISE) {
      usd += change;
      stables.add(label);
    }
  }

  const moved = [...deltas.entries()].filter(([, d]) => Math.abs(d.after - d.before) > DUST_TOKENS);
  if (moved.some(([m]) => NON_MEMECOIN_MINTS.has(m))) return []; // not a memecoin trade
  const tsMs = (tx.blockTime ?? Date.now() / 1000) * 1000;
  const common = {
    wallet, signature: tx.transaction.signatures[0], slot: tx.slot, ts: new Date(tsMs).toISOString(),
    venue: detectVenue(tx), jitoTip: tipLamports > 0, feeLamports: meta.fee,
  };

  const priceNow = opts.solUsdAt?.(tsMs) ?? null;

  // Memecoin ↔ memecoin, settled through SOL.
  if (moved.length === 2 && !stables.size && Math.abs(lamports / 1e9) < SOL_NOISE) {
    const [a, b] = moved.map(([m, d]) => ({ mint: m, d, change: d.after - d.before }));
    if (Math.sign(a.change) === Math.sign(b.change)) return [];
    const routed = routedSolLamports(tx, wallet);
    if (!routed) return [];
    const sol = routed / 1e9;
    const usdValue = priceNow ? sol * priceNow : null;
    return [a, b]
      .sort((x, y) => x.change - y.change) // the sell first
      .map((t) => ({
        ...common,
        mint: t.mint,
        side: t.change < 0 ? ("sell" as const) : ("buy" as const),
        tokenAmount: Math.abs(t.change),
        tokenBalanceBefore: t.d.before,
        solAmount: sol,
        priceSol: sol / Math.abs(t.change),
        quote: "SOL (routed)",
        quoteAmount: sol,
        solUsd: priceNow,
        usdAmount: usdValue,
      }));
  }

  if (moved.length !== 1) return []; // no token (e.g. SOL ↔ USDC), or several
  const [mint, d] = moved[0];
  const tokenDelta = d.after - d.before;
  let sol = lamports / 1e9;
  const usesSol = Math.abs(sol) >= SOL_NOISE;
  if (!usesSol && stables.size) sol = 0;

  const solUsd = priceNow;
  let value = sol; // signed, in SOL: negative = paid
  if (stables.size) {
    if (!solUsd) return []; // can't value it in SOL without the price at the time
    value += usd / solUsd;
  }
  let side: "buy" | "sell";
  if (tokenDelta > 0 && value < 0) side = "buy";
  else if (tokenDelta < 0 && value > 0) side = "sell";
  else return [];
  const solAmount = Math.abs(value);
  const tokenAmount = Math.abs(tokenDelta);
  if (solAmount < MIN_SOL) return [];
  const labels = [...(usesSol || !stables.size ? ["SOL"] : []), ...stables];
  const quote = labels.join("+");
  const quoteAmount = labels.length === 1 && stables.size ? Math.abs(usd) : solAmount;
  // USD at settlement: exact for dollar-only payments, SOL × price otherwise.
  const usdAmount = stables.size && !usesSol ? Math.abs(usd) : solUsd ? solAmount * solUsd : null;

  return [{ ...common, mint, side, tokenAmount, tokenBalanceBefore: d.before, solAmount, priceSol: solAmount / tokenAmount, quote, quoteAmount, solUsd, usdAmount }];
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
