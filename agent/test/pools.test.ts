/**
 * Pool and contract intelligence: what a mint's contract does to a trade, pool accounts decoded into reserves and exit
 * capacity, the gate's on-chain exit check, the token-account rent read from the transaction, and the lock rule for
 * concentrated-liquidity pools. Synthetic data and stubbed RPC: nothing here touches the network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import { SOL_MINT } from "@godseye/shared";
import { feeChangePending, feeInForce, profileMint, receivedAfterFee, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, tradeTraits, transferFeeOn, type ParsedMint } from "../src/market/mint-profile";
import { isConcentratedMarket, judgeRugRisk, lockedLiquidityPct, type OnchainMint, type RugCheckSummary } from "../src/market/rugcheck";
import { decodePoolAccount, exitCapacity, POOL_PROGRAMS, readPools, viewPool, type PoolView, type VaultBalance } from "../src/pools/state";
import { judgeGate, limitsFrom, CopyabilityGate, type GateDeps, type GatePool } from "../src/audit/gate";
import { auditSettings } from "../src/audit/settings";
import { parseSwap, TOKEN_ACCOUNT_RENT_LAMPORTS } from "../src/chain/parse";
import { LABEL_ONLY_VENUES, VENUE_RANK, VENUES } from "../src/chain/programs";
import { MINT, swapTx, WALLET } from "./helpers";

// ---- mint contracts ----

/** A transferFeeConfig extension exactly as `getAccountInfo` with `jsonParsed` returns it (a real Token-2022 coin, 1% fee). */
const feeExt = (older: number, newer: number, newerEpoch = 1066, authority: string | null = "WLHv2UAZm6z4KyaaELi5pjdbJh6RESMva1Rnn8pJVVh") => ({
  extension: "transferFeeConfig",
  state: {
    newerTransferFee: { epoch: newerEpoch, maximumFee: 1_000_000_000_000_000, transferFeeBasisPoints: newer },
    olderTransferFee: { epoch: 1066, maximumFee: 1_000_000_000_000_000, transferFeeBasisPoints: older },
    transferFeeConfigAuthority: authority,
    withdrawWithheldAuthority: "5KXDF6QnqhBj72hDtJNkkpFaQVUfbFXNybMsp3DiK6tD",
    withheldAmount: 3459590834986,
  },
});
const mint = (over: Partial<ParsedMint> = {}): ParsedMint => ({ tokenProgram: TOKEN_2022_PROGRAM, mintAuthority: null, freezeAuthority: null, extensions: [], ...over });

test("a Token-2022 mint's extensions are read the way RPC returns them", () => {
  const p = profileMint(
    mint({
      extensions: [
        { extension: "metadataPointer", state: { authority: null, metadataAddress: "7gF5uE" } },
        { extension: "tokenMetadata", state: { updateAuthority: null, name: "Aura", symbol: "AURA" } },
        feeExt(100, 100),
        { extension: "transferHook", state: { programId: "HookProgram1111111111111111111111111111111" } },
        { extension: "permanentDelegate", state: { delegate: "Delegate111111111111111111111111111111111" } },
        { extension: "pausableConfig", state: { authority: "Pauser" } },
        { extension: "defaultAccountState", state: { accountState: "frozen" } },
        { extension: "mintCloseAuthority", state: { closeAuthority: "Closer" } },
        { extension: "nonTransferable" },
      ],
    }),
  );
  assert.equal(p.program, "token-2022");
  assert.equal(p.transferFee!.newer.bps, 100);
  assert.equal(p.transferFee!.configAuthority, "WLHv2UAZm6z4KyaaELi5pjdbJh6RESMva1Rnn8pJVVh");
  assert.equal(p.transferHook, "HookProgram1111111111111111111111111111111");
  assert.equal(p.permanentDelegate, "Delegate111111111111111111111111111111111");
  assert.equal(p.pausable, true);
  assert.equal(p.defaultFrozen, true);
  assert.equal(p.closeAuthority, "Closer");
  assert.equal(p.nonTransferable, true);
  assert.equal(p.metadataUpdateAuthority, null, "the metadata can't be changed");
  assert.equal(profileMint(mint({ extensions: [] })).metadataUpdateAuthority, undefined, "no metadata extension at all");
  assert.equal(profileMint({ tokenProgram: TOKEN_PROGRAM, mintAuthority: "M", freezeAuthority: null, extensions: [] }).program, "spl");
  assert.equal(profileMint({ mintAuthority: null, freezeAuthority: null, extensions: [] }).program, "unknown");
});

test("the transfer fee is taken from the amount received: min(ceil(amount × bps / 10,000), maximum fee)", () => {
  const f = { epoch: 1, bps: 100, maximumFee: 50 };
  assert.equal(transferFeeOn(1_000, f), 10);
  assert.equal(transferFeeOn(1_001, f), 11, "rounded up, not down");
  assert.equal(transferFeeOn(1_000_000, f), 50, "capped at the maximum fee");
  assert.equal(transferFeeOn(0, f), 0);
  assert.equal(transferFeeOn(1_000, { ...f, bps: 0 }), 0);
  assert.equal(receivedAfterFee(1_000, f), 990);
});

test("a fee change set today applies from its epoch, and until the epoch is known the dearer fee is assumed", () => {
  const c = profileMint(mint({ extensions: [feeExt(100, 5000, 1070)] })).transferFee!;
  assert.equal(feeInForce(c, 1068).bps, 100, "before the new fee's epoch");
  assert.equal(feeInForce(c, 1070).bps, 5000, "from it");
  assert.equal(feeInForce(c).bps, 5000, "epoch unknown: the safe reading for a buyer");
  assert.equal(feeChangePending(c, 1068), true);
  assert.equal(feeChangePending(c, 1070), false);
  assert.equal(feeChangePending(profileMint(mint({ extensions: [feeExt(100, 100)] })).transferFee!), false);
});

test("trade traits: a heavy fee blocks, a small one warns, and an authority that can raise it is flagged", () => {
  const traits = (e: ReturnType<typeof feeExt>, maxFeeBps = 1000) => tradeTraits(profileMint(mint({ extensions: [e] })), { maxFeeBps });
  const small = traits(feeExt(100, 100));
  assert.deepEqual(small.map((t) => t.severity), ["warn", "warn"]);
  assert.match(small[0].text, /1% transfer fee on every buy and sell/);
  assert.match(small[1].text, /someone can still change the transfer fee/);
  const heavy = traits(feeExt(2500, 2500, 1066, null));
  assert.deepEqual(heavy.map((t) => t.severity), ["block"]);
  assert.match(heavy[0].text, /25% transfer fee/);
  assert.equal(traits(feeExt(1000, 1000, 1066, null)).some((t) => t.severity === "block"), true, "the limit is 'at or above'");
  assert.equal(traits(feeExt(999, 999, 1066, null)).some((t) => t.severity === "block"), false);
  assert.equal(traits(feeExt(999, 999, 1066, null), 500).some((t) => t.severity === "block"), true, "and it is configurable");
  assert.deepEqual(tradeTraits(profileMint(mint())), []);
  assert.equal(tradeTraits(profileMint(mint({ extensions: [{ extension: "nonTransferable" }] })))[0].severity, "block");
});

const clean: OnchainMint = { mintAuthority: null, freezeAuthority: null, extensions: [] };
const rcOpts = { blockMintAuthority: true, maxRiskScore: 75, allowlist: [] as string[], minLockedPct: 90 };

test("the rug screen blocks a heavy transfer fee and warns about a light one, and a trusted coin is exempt", () => {
  const heavy: OnchainMint = { ...clean, tokenProgram: TOKEN_2022_PROGRAM, extensions: [feeExt(3000, 3000, 1066, null)] };
  const v = judgeRugRisk("COIN", heavy, null, rcOpts);
  assert.equal(v.verdict, "blocked");
  assert.match(v.blocks.join(), /30% transfer fee is taken on every buy and sell/);
  const light: OnchainMint = { ...clean, extensions: [feeExt(100, 100, 1066, null)] };
  const w = judgeRugRisk("COIN", light, null, rcOpts);
  assert.equal(w.verdict, "pass");
  assert.ok(w.warnings.some((x) => /1% transfer fee/.test(x)));
  assert.equal(judgeRugRisk("COIN", heavy, null, { ...rcOpts, allowlist: ["COIN"] }).verdict, "pass");
  assert.equal(judgeRugRisk("COIN", heavy, null, { ...rcOpts, maxTransferFeeBps: 5000 }).verdict, "pass", "the limit is a setting");
});

const pool = (marketType: string, lpLockedPct: number, usd: number) => ({ marketType, lp: { lpLockedPct, quoteUSD: usd / 2, baseUSD: usd / 2 } });
const report = (markets: RugCheckSummary["markets"]): RugCheckSummary => ({ score_normalised: 10, risks: [], markets });

test("concentrated-liquidity pools: counted like any pool by default, with the reason spelled out; left out of the lock figure on request", () => {
  assert.equal(isConcentratedMarket("orca"), true);
  assert.equal(isConcentratedMarket("raydium_clmm"), true);
  assert.equal(isConcentratedMarket("meteoraDlmm"), true);
  assert.equal(isConcentratedMarket("pump_fun_amm"), false);
  assert.equal(isConcentratedMarket(undefined), false);

  // A deep token whose liquidity is Orca/DLMM positions: RugCheck reports ~0% "locked".
  const rc = report([pool("orca", 0, 90_000), pool("meteoraDlmm", 0, 10_000)]);
  const dflt = judgeRugRisk("COIN", clean, rc, rcOpts);
  assert.equal(dflt.verdict, "blocked", "the default is unchanged");
  assert.match(dflt.blocks.join(), /concentrated-liquidity positions/);
  assert.match(dflt.blocks.join(), /LP_CONCENTRATED_POOLS=warn/);

  const warn = judgeRugRisk("COIN", clean, rc, { ...rcOpts, concentratedPools: "warn" });
  assert.equal(warn.verdict, "pass");
  assert.ok(warn.warnings.some((x) => /concentrated-liquidity positions, so no lock figure applies/.test(x)));

  // Mixed: an unlocked AMM pool still blocks in warn mode; a locked one plus positions passes with a note.
  const unlockedAmm = report([pool("raydium", 0, 50_000), pool("orca", 0, 50_000)]);
  assert.equal(judgeRugRisk("COIN", clean, unlockedAmm, { ...rcOpts, concentratedPools: "warn" }).verdict, "blocked");
  const lockedPlusPositions = report([pool("pump_fun_amm", 100, 10_000), pool("orca", 0, 90_000)]);
  const ok = judgeRugRisk("COIN", clean, lockedPlusPositions, { ...rcOpts, concentratedPools: "warn" });
  assert.equal(ok.verdict, "pass");
  assert.ok(ok.warnings.some((x) => /not counted in the lock figure/.test(x)));
  assert.equal(lockedLiquidityPct(lockedPlusPositions, { skipConcentrated: true }), 100);
  assert.equal(lockedLiquidityPct(lockedPlusPositions), 10);
});

// ---- pool accounts ----

const key = (n: number) => new PublicKey(Buffer.alloc(32, n)).toBase58();
const SOL_BYTES = new PublicKey(SOL_MINT).toBytes();
function buf(size: number, fill: (b: Buffer) => void): Buffer {
  const b = Buffer.alloc(size);
  fill(b);
  return b;
}
const putKey = (b: Buffer, o: number, k: string | Uint8Array) => Buffer.from(typeof k === "string" ? new PublicKey(k).toBytes() : k).copy(b, o);
const putU64 = (b: Buffer, o: number, v: bigint | number) => b.writeBigUInt64LE(BigInt(v), o);
const putU128 = (b: Buffer, o: number, v: bigint) => {
  b.writeBigUInt64LE(v & 0xffffffffffffffffn, o);
  b.writeBigUInt64LE(v >> 64n, o + 8);
};
const vault = (amount: number | bigint, decimals: number, mintAddr: string): VaultBalance => ({ amount: BigInt(amount), decimals, mint: mintAddr });

test("pump.fun bonding curve: reserves from the account, price from the virtual reserves, SOL-paired unless a quote mint is named", () => {
  const data = buf(166, (b) => {
    putU64(b, 8, 1_000_000_000_000_000n); // virtual token reserves
    putU64(b, 16, 30_000_000_000n); // virtual SOL reserves (30 SOL)
    putU64(b, 24, 800_000_000_000_000n); // real token reserves
    putU64(b, 32, 5_000_000_000n); // real SOL reserves (5 SOL)
    putU64(b, 40, 1_000_000_000_000_000n);
    b[48] = 0;
    putKey(b, 49, key(7));
  });
  const d = decodePoolAccount(POOL_PROGRAMS.PUMP_CURVE, "CURVE", data)!;
  assert.equal(d.family, "pump-curve");
  assert.equal(d.quoteMint, SOL_MINT);
  assert.equal(d.closed, false);
  const v = viewPool(d, new Map());
  assert.equal(v.quoteReserve, 5);
  assert.equal(v.quoteEffective, 30, "real + virtual = the reserve prices are formed against");
  assert.ok(Math.abs(v.price! - 30 / 1_000_000_000) < 1e-15, "30 SOL over 1e9 tokens");
  // Selling until the price is down 20%: 30 × (1 − √0.8) = 3.17 SOL, which the 5 real SOL cover.
  assert.ok(Math.abs(exitCapacity(v, 20)! - 30 * (1 - Math.sqrt(0.8))) < 1e-9);
  // A bigger fall would need more SOL than the curve holds: proceeds are capped by the real reserve.
  assert.equal(exitCapacity(v, 60), 5);

  const done = Buffer.from(data);
  done[48] = 1;
  assert.equal(exitCapacity(viewPool(decodePoolAccount(POOL_PROGRAMS.PUMP_CURVE, "CURVE", done)!, new Map()), 20), 0, "a graduated curve takes nothing");

  const usdc = Buffer.from(data);
  const usdcMint = key(9);
  putKey(usdc, 83, usdcMint);
  const u = viewPool(decodePoolAccount(POOL_PROGRAMS.PUMP_CURVE, "CURVE", usdc)!, new Map());
  assert.equal(u.quoteIsSol, false);
  assert.equal(exitCapacity(u, 20), null, "a curve paired with something else isn't SOL");
  assert.equal(decodePoolAccount(POOL_PROGRAMS.PUMP_CURVE, "CURVE", Buffer.alloc(20)), null, "too short to be a curve");
});

test("PumpSwap: vault balances plus the signed virtual reserve; a pool that lists SOL first is turned round", () => {
  const tok = key(11);
  const make = (baseMint: Uint8Array | string, quoteMint: Uint8Array | string, virtual: bigint) =>
    buf(300, (b) => {
      putKey(b, 43, baseMint);
      putKey(b, 75, quoteMint);
      putKey(b, 107, key(21));
      putKey(b, 139, key(31));
      putKey(b, 171, key(32));
      putU64(b, 203, 1_000_000);
      const lo = virtual < 0n ? virtual + (1n << 128n) : virtual;
      putU128(b, 245, lo);
    });
  const vaults = new Map([
    [key(31), vault(500_000_000_000, 6, tok)],
    [key(32), vault(40_000_000_000, 9, SOL_MINT)],
  ]);
  const normal = viewPool(decodePoolAccount(POOL_PROGRAMS.PUMP_AMM, "POOL", make(tok, SOL_BYTES, 0n))!, vaults);
  assert.equal(normal.quoteIsSol, true);
  assert.equal(normal.baseMint, tok);
  assert.equal(normal.quoteReserve, 40);
  assert.equal(normal.baseReserve, 500_000);
  assert.ok(Math.abs(normal.price! - 40 / 500_000) < 1e-12);

  const negative = viewPool(decodePoolAccount(POOL_PROGRAMS.PUMP_AMM, "POOL", make(tok, SOL_BYTES, -5_000_000_000n))!, vaults);
  assert.equal(negative.quoteReserve, 40);
  assert.equal(negative.quoteEffective, 35, "fees parked in the vault are not part of the price");
  assert.ok(exitCapacity(negative, 20)! < exitCapacity(normal, 20)!);

  // SOL listed as the base: vaults and mints are swapped so SOL is the quote, and the virtual reserve no longer applies.
  const flipped = decodePoolAccount(POOL_PROGRAMS.PUMP_AMM, "POOL", make(SOL_BYTES, tok, 123n))!;
  assert.equal(flipped.swapped, true);
  assert.equal(flipped.virtualQuoteRaw, 0n);
  const fv = viewPool(flipped, new Map([[key(31), vault(40_000_000_000, 9, SOL_MINT)], [key(32), vault(500_000_000_000, 6, tok)]]));
  assert.equal(fv.quoteIsSol, true);
  assert.equal(fv.quoteReserve, 40);
  assert.equal(fv.baseMint, tok);
  assert.equal(fv.baseDecimals, 6);
});

test("Raydium AMM v4 and CPMM: vault balances less what is owed to the protocol; SOL-first pools are turned round", () => {
  const tok = key(12);
  const v4 = buf(752, (b) => {
    putU64(b, 192, 1_000_000n); // base need-take pnl
    putU64(b, 200, 2_000_000_000n); // quote need-take pnl (2 SOL)
    putKey(b, 336, key(41));
    putKey(b, 368, key(42));
    putKey(b, 400, tok);
    putKey(b, 432, SOL_BYTES);
    putKey(b, 464, key(43));
  });
  const d = decodePoolAccount(POOL_PROGRAMS.RAYDIUM_AMM_V4, "AMM", v4)!;
  const v = viewPool(d, new Map([[key(41), vault(10_000_000_000, 6, tok)], [key(42), vault(100_000_000_000, 9, SOL_MINT)]]));
  assert.equal(v.quoteReserve, 98, "100 SOL in the vault, 2 owed to the protocol");
  assert.equal(v.baseReserve, 10_000 - 1);

  const cp = buf(637, (b) => {
    putKey(b, 72, key(51));
    putKey(b, 104, key(52));
    putKey(b, 136, key(53));
    putKey(b, 168, SOL_BYTES); // token 0 is wrapped SOL
    putKey(b, 200, tok);
    putU64(b, 333, 777);
    b[329] = 0;
  });
  const dc = decodePoolAccount(POOL_PROGRAMS.RAYDIUM_CPMM, "CP", cp)!;
  assert.equal(dc.swapped, true);
  const vc = viewPool(dc, new Map([[key(51), vault(20_000_000_000, 9, SOL_MINT)], [key(52), vault(80_000_000_000, 6, tok)]]));
  assert.equal(vc.quoteIsSol, true);
  assert.equal(vc.quoteReserve, 20);
  assert.equal(vc.baseMint, tok);
  const off = Buffer.from(cp);
  off[329] = 0b100;
  assert.equal(decodePoolAccount(POOL_PROGRAMS.RAYDIUM_CPMM, "CP", off)!.closed, true, "status bit 2 = swapping disabled");
});

test("Raydium LaunchLab: the fee sitting in the quote vault is not liquidity; a migrated pool takes nothing", () => {
  const tok = key(13);
  const ll = (status: number) =>
    buf(400, (b) => {
      b[17] = status;
      putU64(b, 37, 1_073_000_000_000_000n); // virtual base
      putU64(b, 45, 30_000_000_000n); // virtual quote
      putU64(b, 53, 200_000_000_000_000n); // real base sold
      putU64(b, 61, 10_000_000_000n); // real quote (10 SOL)
      putU64(b, 77, 1_000_000_000n); // quote protocol fee (1 SOL)
      putKey(b, 205, tok);
      putKey(b, 237, SOL_BYTES);
      putKey(b, 269, key(61));
      putKey(b, 301, key(62));
    });
  const vaults = new Map([[key(61), vault(500_000_000_000_000, 6, tok)], [key(62), vault(11_000_000_000, 9, SOL_MINT)]]);
  const v = viewPool(decodePoolAccount(POOL_PROGRAMS.LAUNCHLAB, "LL", ll(0))!, vaults);
  assert.equal(v.quoteReserve, 10, "11 SOL in the vault less the 1 SOL protocol fee");
  assert.equal(v.quoteEffective, 40, "virtual 30 + real 10");
  assert.ok(Math.abs(v.price! - 40 / (873_000_000)) < 1e-12);
  assert.equal(exitCapacity(viewPool(decodePoolAccount(POOL_PROGRAMS.LAUNCHLAB, "LL", ll(2))!, vaults), 20), 0);
});

test("Meteora DAMM v2: virtual reserves from liquidity and price (both Q64.64), locked share, SOL as token A turns the pool round", () => {
  const tok = key(14);
  const Q = 1n << 64n;
  // Full range, liquidity L = 100 SOL·√(price): choose real L = 1e9 (units), sqrt price 0.5 (token B per A, raw).
  const make = (a: Uint8Array | string, b2: Uint8Array | string) =>
    buf(1112, (b) => {
      putKey(b, 168, a);
      putKey(b, 200, b2);
      putKey(b, 232, key(71));
      putKey(b, 264, key(72));
      putU128(b, 360, 1_000_000_000n * Q); // liquidity
      putU128(b, 424, 1n); // sqrt min price (~0)
      putU128(b, 440, 1n << 120n); // sqrt max price (huge)
      putU128(b, 456, Q / 2n); // sqrt price 0.5
      putU128(b, 552, 1_000_000_000n * Q); // permanent lock: all of it
      b[481] = 0;
    });
  // Token A = memecoin, token B = SOL: B per A = 0.25 raw. Virtual A = L/√P = 2e9, virtual B = L·√P = 5e8 raw.
  const d = decodePoolAccount(POOL_PROGRAMS.DAMM_V2, "D2", make(tok, SOL_BYTES))!;
  assert.equal(d.swapped, false);
  const vaults = new Map([[key(71), vault(2_000_000_000, 6, tok)], [key(72), vault(500_000_000, 9, SOL_MINT)]]);
  const v = viewPool(d, vaults);
  assert.equal(v.quoteIsSol, true);
  assert.ok(Math.abs(v.quoteEffective! - 0.5) < 1e-6, `effective SOL ${v.quoteEffective}`);
  assert.ok(v.notes.some((n) => /100% of the liquidity is permanently locked/.test(n)));
  // SOL as token A: roles swap, the same pool read from the other side.
  const flipped = decodePoolAccount(POOL_PROGRAMS.DAMM_V2, "D2", make(SOL_BYTES, tok))!;
  assert.equal(flipped.swapped, true);
  const fv = viewPool(flipped, new Map([[key(71), vault(500_000_000, 9, SOL_MINT)], [key(72), vault(2_000_000_000, 6, tok)]]));
  assert.equal(fv.quoteIsSol, true);
  assert.equal(fv.baseMint, tok);
  assert.ok(fv.quoteEffective! > 0);
  const disabled = make(tok, SOL_BYTES);
  disabled[481] = 1;
  assert.equal(exitCapacity(viewPool(decodePoolAccount(POOL_PROGRAMS.DAMM_V2, "D2", disabled)!, vaults), 20), 0);
});

test("Meteora Dynamic Bonding Curve: price from its own sqrt price, mints from the vaults, capacity capped by the SOL it holds", () => {
  const tok = key(15);
  const Q = 1n << 64n;
  const data = buf(424, (b) => {
    putKey(b, 72, key(81));
    putKey(b, 104, key(82));
    putKey(b, 136, tok);
    putKey(b, 168, key(83));
    putKey(b, 200, key(84));
    putU64(b, 232, 700_000_000_000n);
    putU64(b, 240, 4_000_000_000n); // 4 SOL
    putU128(b, 280, (Q * 3n) / 100_000n); // sqrt price 3e-5 → price 9e-10 raw SOL per raw token
    b[305] = 0;
    b[308] = 0;
  });
  const d = decodePoolAccount(POOL_PROGRAMS.DBC, "DBC", data)!;
  assert.equal(d.quoteMint, null, "the pool account doesn't name its quote; the vault does");
  const v = viewPool(d, new Map([[key(83), vault(700_000_000_000, 6, tok)], [key(84), vault(4_000_000_000, 9, SOL_MINT)]]));
  assert.equal(v.quoteIsSol, true);
  assert.equal(v.quoteReserve, 4);
  assert.ok(Math.abs(v.price! - (9e-10 * 1e6) / 1e9) < 1e-18, `price ${v.price}`);
  assert.ok(v.notes.some((n) => /approximate/.test(n)));
  assert.ok(exitCapacity(v, 99)! <= 4);
  const migrated = Buffer.from(data);
  migrated[305] = 1;
  assert.equal(exitCapacity(viewPool(decodePoolAccount(POOL_PROGRAMS.DBC, "DBC", migrated)!, new Map([[key(83), vault(700_000_000_000, 6, tok)], [key(84), vault(4_000_000_000, 9, SOL_MINT)]])), 20), 0);
});

test("exit capacity: the constant-product formula, and nothing for pools it can't price in SOL", () => {
  const v = (q: number, eff: number, closed = false, sol = true): PoolView => ({
    address: "A", family: "pump-amm", baseMint: "T", quoteMint: sol ? SOL_MINT : "USDC", quoteIsSol: sol, baseDecimals: 6, baseReserve: 1, quoteReserve: q, quoteEffective: eff, price: 1, closed, lpSupply: null, notes: [], extra: {},
  });
  assert.ok(Math.abs(exitCapacity(v(100, 100), 20)! - 100 * (1 - Math.sqrt(0.8))) < 1e-12);
  assert.ok(Math.abs(exitCapacity(v(100, 100), 20)! - 10.557) < 1e-3, "the worked figure: a 100 SOL pool takes about 10.6 SOL before a 20% fall");
  assert.ok(exitCapacity(v(100, 100), 10)! < exitCapacity(v(100, 100), 20)!, "more fall, more capacity");
  assert.equal(exitCapacity(v(1, 100), 50), 1, "never more than the pool really holds");
  assert.equal(exitCapacity(v(0, 0), 20), 0);
  assert.equal(exitCapacity(v(100, 100, true), 20), 0);
  assert.equal(exitCapacity(v(100, 100, false, false), 20), null);
  assert.equal(exitCapacity({ ...v(100, 100), quoteEffective: null }, 20), null);
});

test("reading pools: two calls however many pools, and what can't be read is said so rather than returned as empty", async () => {
  const tok = key(16);
  const pumpAmm = buf(300, (b) => {
    putKey(b, 43, tok);
    putKey(b, 75, SOL_BYTES);
    putKey(b, 139, key(91));
    putKey(b, 171, key(92));
  });
  const calls: string[] = [];
  const rpc = async (method: string, params: unknown[]) => {
    calls.push(`${method} ${JSON.stringify((params[1] as { encoding: string }).encoding)}`);
    if ((params[1] as { encoding: string }).encoding === "base64")
      return { value: [{ owner: POOL_PROGRAMS.PUMP_AMM, data: [pumpAmm.toString("base64"), "base64"] }, { owner: "WhirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc", data: ["AAAA", "base64"] }, null] };
    const vals = (params[0] as string[]).map((a) => ({ data: { parsed: { info: { mint: a === key(91) ? tok : SOL_MINT, tokenAmount: { amount: a === key(91) ? "1000000000" : "9000000000", decimals: a === key(91) ? 6 : 9 } } } } }));
    return { value: vals };
  };
  const out = await readPools(["GOOD", "ORCA", "GONE", "GOOD"], rpc);
  assert.equal(out.length, 3, "duplicates collapse");
  assert.deepEqual(calls, ['getMultipleAccounts "base64"', 'getMultipleAccounts "jsonParsed"']);
  assert.equal((out[0] as PoolView).quoteReserve, 9);
  assert.match((out[1] as { unreadable: string }).unreadable, /isn't one this reads/);
  assert.equal((out[2] as { unreadable: string }).unreadable, "account not found");
  assert.deepEqual(await readPools([], rpc), []);
});

// ---- the gate reads the pools ----

const gp = (cap: number | null, o: Partial<GatePool> = {}): GatePool => ({ label: "Pump.fun Amm", address: "P", family: "pump-amm", quoteReserveSol: cap === null ? null : cap * 4, exitCapacitySol: cap, closed: false, ...o });
const quoteOf = (inSol: number, out: number, impact = "0.004") => ({ inAmount: String(Math.round(inSol * 1e9)), outAmount: String(Math.round(out * 1e6)), priceImpactPct: impact });
const gin = (pools?: GatePool[]) => ({ sizeSol: 0.1, leaderPriceSol: 0.001, ageSec: 3, ms: 100, decimals: 6, buy: quoteOf(0.1, 100), sell: { inAmount: "0", outAmount: String(0.095e9) }, feeSol: 0.001, pools });

test("gate: a pool that can take the position back passes; one that can't would block, with the figures", () => {
  const limits = limitsFrom({ gateMaxImpactPct: 3, gateMaxDriftPct: 15, gateMaxRoundTripLossPct: 15, gateMaxFeePct: 5, gateMinExitMultiple: 3, gateExitDropPct: 20 });
  const deep = judgeGate(gin([gp(5)]), limits);
  assert.equal(deep.wouldBlock, false);
  assert.equal(deep.exitCapacitySol, 5);
  assert.equal(deep.checks.find((c) => c.check === "exit_capacity")!.result, "pass");
  assert.match(deep.checks.find((c) => c.check === "exit_capacity")!.detail!, /5\.000 SOL can be sold in before the price falls 20%/);

  const drained = judgeGate(gin([gp(0.05)]), limits); // 0.05 SOL against a 0.1 SOL position
  assert.equal(drained.wouldBlock, true);
  assert.match(drained.wouldBlockReasons.join(), /can take only 0\.5× the position back before a 20% fall \(needs 3×\)/);

  const parallel = judgeGate(gin([gp(0.2), gp(0.2)]), limits);
  assert.equal(parallel.exitCapacitySol, 0.4, "pools the route splits across add up");
  assert.equal(parallel.checks.find((c) => c.check === "exit_capacity")!.result, "pass");
});

test("gate: venues whose depth can't be read, or no pool read at all, add no verdict (the other checks stand)", () => {
  const limits = limitsFrom();
  const unreadable = judgeGate(gin([gp(null, { label: "Whirlpool", family: null, note: "program isn't one this reads" })]), limits);
  assert.equal(unreadable.checks.find((c) => c.check === "exit_capacity")!.result, "na");
  assert.equal(unreadable.wouldBlock, false);
  assert.equal(unreadable.exitCapacitySol, null);
  const notRead = judgeGate(gin(undefined), limits);
  assert.equal(notRead.checks.find((c) => c.check === "exit_capacity")!.detail, "pools not read");
  assert.deepEqual(notRead.pools, []);
});

test("gate: reads the pools that hold the token on the quoted route, never the intermediate hops, and survives a failed read", async () => {
  const tokenMint = "TOKEN";
  const route = [
    { swapInfo: { label: "Raydium CP", ammKey: "HOP1", inputMint: SOL_MINT, outputMint: "USDC" } },
    { swapInfo: { label: "Pump.fun Amm", ammKey: "HOP2", inputMint: "USDC", outputMint: tokenMint } },
  ];
  const asked: string[][] = [];
  const mk = (pools: GateDeps["pools"]): GateDeps => ({
    decimals: async () => 6,
    quote: async (i) => (i === SOL_MINT ? { ...quoteOf(0.1, 100), routePlan: route } : { inAmount: "0", outAmount: String(0.095e9) }),
    pools,
  });
  const view: PoolView = { address: "HOP2", family: "pump-amm", baseMint: tokenMint, quoteMint: SOL_MINT, quoteIsSol: true, baseDecimals: 6, baseReserve: 1e6, quoteReserve: 50, quoteEffective: 50, price: 5e-5, closed: false, lpSupply: null, notes: [], extra: {} };
  const s = { ...auditSettings, gateEnabled: true, gateConcurrency: 1, gateMaxQueue: 1, gateMinSpacingMs: 0, gateTimeoutMs: 500 };
  const ok = await new CopyabilityGate(mk(async (a) => (asked.push(a), [view])), s).run({ mint: tokenMint, sizeSol: 0.1, leaderPriceSol: 0.001, leaderTs: new Date().toISOString() });
  assert.deepEqual(asked, [["HOP2"]], "only the pool that outputs the token");
  const r = ok as import("../src/audit/gate").GateResult;
  assert.equal(r.pools.length, 1);
  assert.equal(r.pools[0].label, "Pump.fun Amm");
  assert.ok(r.exitCapacitySol! > 5, "a 50 SOL pool");

  const failed = (await new CopyabilityGate(mk(async () => { throw new Error("rpc down"); }), s).run({ mint: tokenMint, sizeSol: 0.1, leaderPriceSol: 0.001, leaderTs: new Date().toISOString() })) as import("../src/audit/gate").GateResult;
  assert.equal(failed.exitCapacitySol, null);
  assert.match(failed.pools[0].note!, /pool read failed: rpc down/);
  assert.equal(failed.checks.find((c) => c.check === "exit_capacity")!.result, "na");

  const without = (await new CopyabilityGate({ ...mk(undefined), pools: undefined }, s).run({ mint: tokenMint, sizeSol: 0.1, leaderPriceSol: 0.001, leaderTs: new Date().toISOString() })) as import("../src/audit/gate").GateResult;
  assert.deepEqual(without.pools, []);
});

// ---- the parser ----

test("token-account rent is read from the transaction: a 170-byte Token-2022 account is not priced like a 165-byte one", () => {
  const realRent = 1_513_840; // what a PumpSwap buy that opened a Token-2022 account actually paid
  const tx = swapTx({ solDelta: -(0.05 + realRent / 1e9 + 0.000005), tokenBefore: 0, tokenAfter: 100, newTokenAccount: true });
  tx.meta!.postBalances[2] = realRent; // the new token account holds its rent
  const s = parseSwap(tx, WALLET)!;
  assert.ok(Math.abs(s.solAmount - 0.05) < 1e-9, `cost ${s.solAmount} (the old constant would have made it ${0.05 + (realRent - TOKEN_ACCOUNT_RENT_LAMPORTS) / 1e9})`);
  // Closing an account refunds what it held.
  const sell = swapTx({ solDelta: 0.05 + realRent / 1e9 - 0.000005, tokenBefore: 100, tokenAfter: 0 });
  sell.meta!.postTokenBalances = [];
  sell.meta!.preBalances[2] = realRent;
  const t = parseSwap(sell, WALLET)!;
  assert.equal(t.side, "sell");
  assert.ok(Math.abs(t.solAmount - 0.05) < 1e-9, `proceeds ${t.solAmount}`);
  // Without balances for the account (synthetic data) the constant is the fallback, as before.
  const fallback = parseSwap(swapTx({ solDelta: -(1 + TOKEN_ACCOUNT_RENT_LAMPORTS / 1e9 + 0.000005), tokenBefore: 0, tokenAfter: 100, newTokenAccount: true }), WALLET)!;
  assert.ok(Math.abs(fallback.solAmount - 1) < 1e-9);
  void MINT;
});

// ---- program labels ----

test("more venues are named, and every label is one the venue ranking can return; none of them widens the live stream", () => {
  assert.equal(LABEL_ONLY_VENUES["LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj"], "raydium launchlab");
  assert.equal(LABEL_ONLY_VENUES["PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY"], "phoenix");
  assert.equal(LABEL_ONLY_VENUES["9H6tua7jkLhdm3w8BvgpTn5LZNU7g4ZynDmCiNN3q6Rp"], "prop amm");
  for (const label of Object.values(LABEL_ONLY_VENUES)) assert.ok(VENUE_RANK.includes(label), `${label} is missing from VENUE_RANK, so a transaction would never be given it`);
  for (const id of Object.keys(LABEL_ONLY_VENUES)) assert.equal(VENUES[id], undefined, `${id} would be subscribed to`);
  assert.equal(Object.keys(VENUES).length, 9, "the stream still listens to the same nine programs");
});
