/**
 * POOL STATE — read a liquidity pool's reserves straight from chain, and say how much can be sold into it.
 *
 * Until now GodsEye only knew liquidity second-hand (Jupiter, GeckoTerminal, RugCheck) or back-solved it from the swaps of
 * tracked wallets. A pool is just accounts on chain: a pool account (which names the mints and vaults) and token vaults (which
 * hold the reserves). This decodes the pool accounts of the venues memecoins live on, reads their vaults, and computes
 *   • the reserves, the price, and the SOL a seller would actually get out;
 *   • EXIT CAPACITY: the SOL that can be sold in before the price falls X%. For a constant-product pool with quote reserve Q
 *     (virtual, where the venue has one), selling until the price is down X leaves the quote at Q·√(1−X), so
 *     capacity(X) = Q · (1 − √(1−X)); proceeds can never exceed the REAL quote the pool holds.
 *
 * Decoded: pump.fun bonding curve, PumpSwap, Raydium AMM v4, CPMM and LaunchLab, Meteora DAMM v2 and the Dynamic Bonding Curve.
 * Not decoded (their depth needs tick arrays or bins, or isn't on chain at all): Orca Whirlpools, Raydium CLMM, Meteora DLMM,
 * proprietary AMMs. They come back as "unreadable" so the caller knows it is not looking at a number.
 * Byte offsets are from the programs' IDLs; each decoder was checked against live accounts on 2026-10-27 (what was compared and
 * the results: research_notes/Pool and contract intelligence/offset_verification.md).
 * Layout reference: research_notes/Pool and contract intelligence/pool_types_and_state.md.
 */
import { PublicKey } from "@solana/web3.js";
import { LAMPORTS_PER_SOL, SOL_MINT } from "@godseye/shared";
import { rpcUrl } from "../config";
import { fetchJson } from "../http";

export const POOL_PROGRAMS = {
  PUMP_CURVE: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
  PUMP_AMM: "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
  RAYDIUM_AMM_V4: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
  RAYDIUM_CPMM: "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C",
  DAMM_V2: "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG",
  DBC: "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN",
  LAUNCHLAB: "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj",
} as const;

export type PoolFamily = "pump-curve" | "pump-amm" | "raydium-amm-v4" | "raydium-cpmm" | "damm-v2" | "dbc" | "launchlab";

const FAMILY: Record<string, PoolFamily> = {
  [POOL_PROGRAMS.PUMP_CURVE]: "pump-curve",
  [POOL_PROGRAMS.PUMP_AMM]: "pump-amm",
  [POOL_PROGRAMS.RAYDIUM_AMM_V4]: "raydium-amm-v4",
  [POOL_PROGRAMS.RAYDIUM_CPMM]: "raydium-cpmm",
  [POOL_PROGRAMS.DAMM_V2]: "damm-v2",
  [POOL_PROGRAMS.DBC]: "dbc",
  [POOL_PROGRAMS.LAUNCHLAB]: "launchlab",
};

const pk = (d: Buffer, o: number): string => new PublicKey(d.subarray(o, o + 32)).toBase58();
const u64 = (d: Buffer, o: number): bigint => d.readBigUInt64LE(o);
const u128 = (d: Buffer, o: number): bigint => d.readBigUInt64LE(o) + (d.readBigUInt64LE(o + 8) << 64n);
const i128 = (d: Buffer, o: number): bigint => {
  const v = u128(d, o);
  return v >= 1n << 127n ? v - (1n << 128n) : v;
};
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const Q64 = 2 ** 64;
const q64 = (v: bigint): number => Number(v) / Q64;

/** What a pool account says, before the vaults are read. Amounts are raw units; `null` where the pool account doesn't hold them. */
export interface DecodedPool {
  family: PoolFamily;
  address: string;
  baseMint: string | null;
  quoteMint: string | null;
  baseVault: string | null;
  quoteVault: string | null;
  lpMint: string | null;
  /** Reserves kept in the pool account itself (curves), raw units. */
  baseReserveRaw: bigint | null;
  quoteReserveRaw: bigint | null;
  /** Reserves added to the real ones when pricing (may be negative on PumpSwap), raw quote units. */
  virtualQuoteRaw: bigint;
  /** The base reserve prices are formed against, where it differs from the real one (bonding curves), raw units. */
  virtualBaseRaw: bigint | null;
  /** The pool names SOL first, so base and quote were swapped to put SOL on the quote side. */
  swapped: boolean;
  /** Raw amounts owed to the protocol or creator that sit in the vaults but are not tradable. */
  baseOwedRaw: bigint;
  quoteOwedRaw: bigint;
  lpSupplyRaw: bigint | null;
  /** The venue says the pool can't trade (completed, migrated, disabled). */
  closed: boolean;
  /** Concentrated pools: liquidity and the price range, for virtual reserves. */
  clmm?: { liquidity: bigint; sqrtPrice: number; sqrtMin: number; sqrtMax: number };
  /** Raw quote per raw base at the current price, where the pool states its price directly (the Dynamic Bonding Curve). */
  priceRaw?: number;
  /** Liquidity locked for good, DAMM v2 (a share of `clmm.liquidity`). */
  lockedLiquidity?: bigint;
  /** Anything else worth keeping, by name. */
  extra: Record<string, unknown>;
}

const base = (family: PoolFamily, address: string): DecodedPool => ({
  family, address, baseMint: null, quoteMint: null, baseVault: null, quoteVault: null, lpMint: null, baseReserveRaw: null, quoteReserveRaw: null,
  virtualQuoteRaw: 0n, virtualBaseRaw: null, swapped: false, baseOwedRaw: 0n, quoteOwedRaw: 0n, lpSupplyRaw: null, closed: false, extra: {},
});

/** Put SOL on the quote side when a pool lists it first (DAMM v2 token A, Raydium coin/pc, CPMM token 0). */
function orient(d: DecodedPool): DecodedPool {
  if (d.baseMint === SOL_MINT && d.quoteMint !== SOL_MINT) {
    [d.baseMint, d.quoteMint] = [d.quoteMint, d.baseMint];
    [d.baseVault, d.quoteVault] = [d.quoteVault, d.baseVault];
    [d.baseOwedRaw, d.quoteOwedRaw] = [d.quoteOwedRaw, d.baseOwedRaw];
    d.swapped = true;
  }
  return d;
}

/** Decode one pool account by the program that owns it. null = not a pool this module reads, or the data is too short. */
export function decodePoolAccount(owner: string, address: string, data: Buffer): DecodedPool | null {
  const family = FAMILY[owner];
  if (!family) return null;
  const need = { "pump-curve": 49, "pump-amm": 245 + 16, "raydium-amm-v4": 496, "raydium-cpmm": 333 + 8, "damm-v2": 560, dbc: 312, launchlab: 333 }[family];
  if (data.length < need) return null;
  const p = base(family, address);
  switch (family) {
    case "pump-curve": {
      // The curve account doesn't name its mint (it is the account's PDA seed); reserves live in the account, SOL as lamports.
      p.baseReserveRaw = u64(data, 24); // real token reserves
      p.quoteReserveRaw = u64(data, 32); // real SOL reserves (lamports)
      p.virtualQuoteRaw = u64(data, 16) - u64(data, 32); // virtual minus real, so real + virtual = the pricing reserve
      p.virtualBaseRaw = u64(data, 8);
      // A curve paired with something other than SOL names its quote mint at offset 83 (all zeros means SOL).
      const quote = data.length >= 115 ? pk(data, 83) : SYSTEM_PROGRAM;
      p.quoteMint = quote === SYSTEM_PROGRAM ? SOL_MINT : quote;
      p.closed = data[48] === 1; // complete: graduated, no longer trades here
      p.extra = { virtualTokenReserves: u64(data, 8), virtualSolReserves: u64(data, 16), tokenTotalSupply: u64(data, 40), creator: pk(data, 49) };
      return p;
    }
    case "pump-amm": {
      p.baseMint = pk(data, 43);
      p.quoteMint = pk(data, 75);
      p.lpMint = pk(data, 107);
      p.baseVault = pk(data, 139);
      p.quoteVault = pk(data, 171);
      p.lpSupplyRaw = u64(data, 203);
      p.virtualQuoteRaw = i128(data, 245); // signed: negative while fees are parked in the vault
      p.extra = { creator: pk(data, 11), coinCreator: pk(data, 211) };
      // Some pools list SOL as the base: put it on the quote side (the virtual reserve belongs to the old quote, so it no longer applies).
      if (orient(p).swapped) p.virtualQuoteRaw = 0n;
      return p;
    }
    case "raydium-amm-v4": {
      p.baseVault = pk(data, 336);
      p.quoteVault = pk(data, 368);
      p.baseMint = pk(data, 400);
      p.quoteMint = pk(data, 432);
      p.lpMint = pk(data, 464);
      p.baseOwedRaw = u64(data, 192); // base_need_take_pnl
      p.quoteOwedRaw = u64(data, 200); // quote_need_take_pnl
      p.extra = { status: Number(u64(data, 0)), swapFeeNumerator: Number(u64(data, 176)), swapFeeDenominator: Number(u64(data, 184)), market: pk(data, 528) };
      return orient(p);
    }
    case "raydium-cpmm": {
      p.baseVault = pk(data, 72);
      p.quoteVault = pk(data, 104);
      p.lpMint = pk(data, 136);
      p.baseMint = pk(data, 168);
      p.quoteMint = pk(data, 200);
      p.lpSupplyRaw = u64(data, 333);
      p.closed = (data[329] & 0b100) !== 0; // status bit 2 = swap disabled
      p.extra = { status: data[329] };
      return orient(p);
    }
    case "damm-v2": {
      p.baseMint = pk(data, 168);
      p.quoteMint = pk(data, 200);
      p.baseVault = pk(data, 232);
      p.quoteVault = pk(data, 264);
      p.clmm = { liquidity: u128(data, 360), sqrtPrice: q64(u128(data, 456)), sqrtMin: q64(u128(data, 424)), sqrtMax: q64(u128(data, 440)) };
      p.lockedLiquidity = u128(data, 552);
      p.closed = data[481] === 1; // pool_status: 1 = disabled
      p.extra = { collectFeeMode: data[484], creator: data.length >= 680 ? pk(data, 648) : null };
      return orient(p);
    }
    case "launchlab": {
      // Raydium LaunchLab: prices against (virtual + real) quote and (virtual - real) base.
      p.baseMint = pk(data, 205);
      p.quoteMint = pk(data, 237);
      p.baseVault = pk(data, 269);
      p.quoteVault = pk(data, 301);
      const virtualBase = u64(data, 37), virtualQuote = u64(data, 45), realBase = u64(data, 53), realQuote = u64(data, 61);
      p.virtualQuoteRaw = virtualQuote;
      p.virtualBaseRaw = virtualBase - realBase;
      // The quote vault also holds the protocol, platform and migration fees owed, which are not part of the pool.
      p.quoteOwedRaw = u64(data, 77) + u64(data, 85) + u64(data, 93);
      p.closed = data[17] !== 0; // status 0 = funding (curve open); 1 = migrated; 2 = initialized for AMM
      p.extra = { status: data[17], migrateType: data[20], totalQuoteFundRaising: u64(data, 69), realQuote, platformConfig: pk(data, 173) };
      return p;
    }
    case "dbc": {
      p.baseMint = pk(data, 136);
      p.baseVault = pk(data, 168);
      p.quoteVault = pk(data, 200);
      p.baseReserveRaw = u64(data, 232);
      p.quoteReserveRaw = u64(data, 240);
      p.closed = data[305] === 1; // is_migrated
      p.priceRaw = q64(u128(data, 280)) ** 2;
      p.extra = { config: pk(data, 72), creator: pk(data, 104), migrationProgress: data[308] };
      return p;
    }
  }
}

/** A pool with its reserves, in human units. */
export interface PoolView {
  address: string;
  family: PoolFamily;
  baseMint: string | null;
  quoteMint: string | null;
  /** The quote token is SOL (or wrapped SOL), so the numbers below are SOL. */
  quoteIsSol: boolean;
  baseDecimals: number | null;
  baseReserve: number | null;
  /** What the pool really holds of the quote, SOL if quoteIsSol. */
  quoteReserve: number | null;
  /** The quote reserve prices are formed against (real + virtual); the number that sets price impact. */
  quoteEffective: number | null;
  /** Quote per base token. */
  price: number | null;
  closed: boolean;
  lpSupply: number | null;
  /** Venue-specific: how the pool is structured (curve not constant product, locked liquidity share…). */
  notes: string[];
  extra: Record<string, unknown>;
}

/** A raw SPL token account amount by address (what the vault reads return). */
export interface VaultBalance {
  amount: bigint;
  decimals: number;
  mint: string;
}

const quoteScale = (mint: string | null, vaultDecimals: number | null): number => (mint === SOL_MINT ? LAMPORTS_PER_SOL : 10 ** (vaultDecimals ?? 9));

/** Combine a decoded pool with its vault balances. Pure. */
export function viewPool(d: DecodedPool, vaults: Map<string, VaultBalance>): PoolView {
  const bv = d.baseVault ? vaults.get(d.baseVault) : undefined;
  const qv = d.quoteVault ? vaults.get(d.quoteVault) : undefined;
  // Pools that don't name their mints in the pool account (the bonding curve) get them from the vaults.
  if (!d.baseMint && bv) d.baseMint = bv.mint;
  if (!d.quoteMint && qv) d.quoteMint = qv.mint;
  const baseDecimals = bv?.decimals ?? null;
  const quoteIsSol = d.quoteMint === SOL_MINT;
  const notes: string[] = [];
  const qScale = quoteScale(d.quoteMint, qv?.decimals ?? null);
  const bScale = baseDecimals === null ? null : 10 ** baseDecimals;

  let baseRaw: bigint | null = d.baseReserveRaw;
  let quoteRaw: bigint | null = d.quoteReserveRaw;
  if (bv) baseRaw = bv.amount - d.baseOwedRaw;
  if (qv) quoteRaw = qv.amount - d.quoteOwedRaw;
  if (d.family === "dbc") notes.push("bonding-curve pricing is piecewise: capacity is approximate and never more than the SOL held");
  if (d.family === "pump-curve") notes.push("the base mint isn't in the curve account; decimals are assumed 6 unless a vault says otherwise");

  let effRaw: bigint | null = quoteRaw === null ? null : quoteRaw + d.virtualQuoteRaw;
  let baseEff: bigint | null = d.virtualBaseRaw ?? baseRaw;
  if (d.clmm && d.clmm.liquidity > 0n) {
    // Concentrated liquidity in range: (x + L/√max)(y + L·√min) = L². The virtual reserves at the current price are L/√P and L·√P.
    const L = Number(d.clmm.liquidity) / Q64; // liquidity is stored as Q64.64, like the prices
    const yv = L * d.clmm.sqrtPrice; // virtual token B (prices are B per A)
    const xv = L / d.clmm.sqrtPrice; // virtual token A
    const locked = d.lockedLiquidity ? Number(d.lockedLiquidity) / Number(d.clmm.liquidity) : 0;
    if (locked > 0) notes.push(`${(locked * 100).toFixed(0)}% of the liquidity is permanently locked`);
    // Token A is the base unless the pool was swapped to put SOL on the quote side.
    effRaw = BigInt(Math.floor(d.swapped ? xv : yv));
    baseEff = BigInt(Math.floor(d.swapped ? yv : xv));
  }
  const toNum = (raw: bigint | null, scale: number | null): number | null => (raw === null || scale === null ? null : Number(raw) / scale);
  if (d.priceRaw !== undefined && baseDecimals !== null) {
    // The pool states its price: raw quote per raw base. Its curve isn't constant product, so the SOL held is all the depth claimed.
    effRaw = quoteRaw;
  }
  const quoteReserve = toNum(quoteRaw, qScale);
  const quoteEffective = toNum(effRaw, qScale);
  const baseReserve = toNum(baseRaw, bScale ?? (d.family === "pump-curve" ? 1e6 : null));
  const baseEffNum = toNum(baseEff, bScale ?? (d.family === "pump-curve" ? 1e6 : null));
  return {
    address: d.address,
    family: d.family,
    baseMint: d.baseMint,
    quoteMint: d.quoteMint,
    quoteIsSol,
    baseDecimals: baseDecimals ?? (d.family === "pump-curve" ? 6 : null),
    baseReserve,
    quoteReserve,
    quoteEffective,
    price: d.priceRaw !== undefined && baseDecimals !== null ? (d.priceRaw * 10 ** baseDecimals) / qScale : quoteEffective !== null && baseEffNum ? quoteEffective / baseEffNum : null,
    closed: d.closed,
    lpSupply: d.lpSupplyRaw === null ? null : Number(d.lpSupplyRaw) / 10 ** (baseDecimals ?? 9),
    notes,
    extra: d.extra,
  };
}

/**
 * SOL that can be sold into the pool before the price has fallen `dropPct` percent. Null when the pool isn't priced in SOL or its
 * reserves aren't known. A closed pool takes nothing.
 */
export function exitCapacity(v: PoolView, dropPct: number): number | null {
  if (!v.quoteIsSol || v.quoteEffective === null || v.quoteReserve === null) return null;
  if (v.closed) return 0;
  const x = Math.min(0.999, Math.max(0, dropPct / 100));
  if (v.quoteEffective <= 0) return 0;
  const byCurve = v.quoteEffective * (1 - Math.sqrt(1 - x));
  return Math.max(0, Math.min(byCurve, v.quoteReserve));
}

export interface RpcLike {
  (method: string, params: unknown[]): Promise<unknown>;
}

export const liveRpc: RpcLike = async (method, params) => {
  const res = await fetchJson<{ result?: unknown; error?: { message: string } }>(rpcUrl(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    retries: 0,
    timeoutMs: 6_000,
  });
  if (res.error) throw new Error(`${method}: ${res.error.message}`);
  return res.result;
};

interface AccountValue {
  owner: string;
  data: [string, string];
}

/**
 * Read pool accounts and their vaults: two RPC calls however many pools. Pools this module can't decode are returned
 * as { unreadable } so a caller never mistakes "not read" for "empty".
 */
export async function readPools(addresses: string[], rpc: RpcLike = liveRpc): Promise<(PoolView | { address: string; unreadable: string })[]> {
  const unique = [...new Set(addresses)];
  if (!unique.length) return [];
  const accounts = ((await rpc("getMultipleAccounts", [unique, { encoding: "base64" }])) as { value: (AccountValue | null)[] }).value;
  const decoded = new Map<string, DecodedPool>();
  const out: (PoolView | { address: string; unreadable: string })[] = [];
  const reason = new Map<string, string>();
  unique.forEach((addr, i) => {
    const acc = accounts[i];
    if (!acc) return void reason.set(addr, "account not found");
    const d = decodePoolAccount(acc.owner, addr, Buffer.from(acc.data[0], "base64"));
    if (!d) return void reason.set(addr, `program ${acc.owner.slice(0, 6)}… isn't one this reads`);
    decoded.set(addr, d);
  });
  const vaultAddrs = [...new Set([...decoded.values()].flatMap((d) => [d.baseVault, d.quoteVault]).filter((x): x is string => !!x))];
  const vaults = new Map<string, VaultBalance>();
  if (vaultAddrs.length) {
    const vs = ((await rpc("getMultipleAccounts", [vaultAddrs, { encoding: "jsonParsed" }])) as { value: ({ data?: { parsed?: { info?: { mint?: string; tokenAmount?: { amount: string; decimals: number } } } } } | null)[] }).value;
    vaultAddrs.forEach((a, i) => {
      const info = vs[i]?.data?.parsed?.info;
      if (info?.tokenAmount && info.mint) vaults.set(a, { amount: BigInt(info.tokenAmount.amount), decimals: info.tokenAmount.decimals, mint: info.mint });
    });
  }
  for (const addr of unique) {
    const d = decoded.get(addr);
    if (!d) out.push({ address: addr, unreadable: reason.get(addr) ?? "unknown" });
    else {
      out.push(viewPool(d, vaults));
    }
  }
  return out;
}
