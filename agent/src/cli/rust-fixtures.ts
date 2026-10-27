/**
 * Fixtures and golden outputs for the Rust ingest service (rust/ingest). The golden files are what THIS (TypeScript)
 * parser produces; the Rust tests must reproduce them byte for byte, and agent/test/rust-golden.test.ts fails if the
 * TypeScript output drifts from them (so a parser change here forces a regenerate plus a matching Rust change).
 *
 *   npm run rust:fixtures -w agent -- golden                 regenerate synthetic fixtures and every golden file
 *   npm run rust:fixtures -w agent -- fetch [RPC_URL] [N]    capture N real transactions per DEX program (read-only RPC)
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import bs58 from "bs58";
import { SOL_MINT, USDC_MINT, USDT_MINT } from "@godseye/shared";
import { parseSwaps } from "../chain/parse";
import { JITO_TIP_ACCOUNTS, VENUE_LABELS } from "../chain/programs";
import { convertGrpcTx, type GrpcTxInfo } from "../stream/convert";
import { fixtureToGrpc, grpcToFixture, type FixtureTx } from "../stream/fixture";
import { computeStats, txPerHourFrom, type ClosedPosition, type Realized } from "../analysis/pnl";
import { botReason } from "../smart/copy-check";

export const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../rust/ingest/fixtures");
export const FIXTURE_SETS = ["tests", "synthetic", "real"] as const;

/** What the live stream produces for one update: every signer's swaps (stream.ts onUpdate), as JSON. */
export function tsOutput(fx: FixtureTx): string {
  const conv = convertGrpcTx(fixtureToGrpc(fx), fx.slot, fx.receivedAtMs);
  if (!conv) return "null";
  const price = fx.solUsd;
  return JSON.stringify(conv.signers.flatMap((s) => parseSwaps(conv.tx, s, { solUsdAt: () => price })));
}

export function readNdjson<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as T);
}

// ---------- deterministic synthetic transactions ----------

function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)],
    chance: (p: number) => next() < p,
    key: () => Uint8Array.from({ length: 32 }, () => Math.floor(next() * 256)),
  };
}

const PROGRAMS = Object.keys(VENUE_LABELS);
const PLUMB = ["11111111111111111111111111111111", "ComputeBudget111111111111111111111111111111", "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"];
const TIPS = [...JITO_TIP_ACCOUNTS];
const NON_MEME = ["JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn"];
const KINDS = ["buy", "sell", "buyNewAta", "sellCloseAta", "wsolBuy", "wsolSell", "usdcBuy", "usdtSell", "solPlusUsdc", "routed", "routedNoMatch",
  "airdrop", "failed", "vote", "nonMeme", "dust", "twoTokens", "tinySol", "secondSigner", "noUiAmount", "huge", "noMeta", "token2022Rent", "multiAccount"] as const;

function synth(seed: number): FixtureTx {
  const r = rng(seed);
  const kind = KINDS[seed % KINDS.length];
  const signers = kind === "secondSigner" ? 2 : r.chance(0.15) ? 2 : 1;
  const walletIdx = kind === "secondSigner" ? 1 : 0;
  const keys: Uint8Array[] = [];
  for (let i = 0; i < signers; i++) keys.push(r.key());
  const pool = keys.push(r.key()) - 1;
  const pool2 = keys.push(r.key()) - 1;
  const ata = keys.push(r.key()) - 1;
  const ata2 = keys.push(r.key()) - 1;
  const quoteAta = keys.push(r.key()) - 1;
  const tipIdx = r.chance(0.3) ? keys.push(bs58.decode(r.pick(TIPS))) - 1 : -1;
  const progs = [r.pick(PLUMB), ...(r.chance(0.2) ? [bs58.encode(r.key())] : []), r.pick(PROGRAMS), ...(r.chance(0.3) ? [r.pick(PROGRAMS)] : [])];
  const progIdx = progs.map((p) => keys.push(bs58.decode(p)) - 1);
  const owner = bs58.encode(keys[walletIdx]);
  const mint = kind === "nonMeme" ? r.pick(NON_MEME) : bs58.encode(r.key());
  const mint2 = bs58.encode(r.key());
  const n = keys.length;
  const pre = Array.from({ length: n }, () => (r.chance(0.2) ? 0 : r.int(1, 5000) * 1e6 + r.int(0, 999_999)));
  const post = [...pre];
  const fee = r.pick([5000, 5000, 10000, 105000, r.int(5000, 2_000_000)]);
  const dec = r.int(0, 9);
  const raw = (x: number) => String(Math.floor(x));
  const tb = (accountIndex: number, m: string, ownerKey: string, amount: string | null, decimals = dec) =>
    amount === null ? { accountIndex, mint: m, owner: ownerKey } : { accountIndex, mint: m, owner: ownerKey, uiTokenAmount: { amount, decimals } };
  const preT: ReturnType<typeof tb>[] = [];
  const postT: ReturnType<typeof tb>[] = [];
  const sol = r.pick([0.0001, 0.00049, 0.001, 0.05, 0.37, 1, 2.5, 13.3, 250]) * (0.5 + r.next());
  const lam = Math.round(sol * 1e9);
  const tokens = r.int(1, 1_000_000_000) * 10 ** r.int(0, 6);
  const before = r.chance(0.5) ? 0 : r.int(1, 1e9) * 10 ** r.int(0, 3);
  const w = walletIdx;
  pre[w] = Math.max(pre[w], 10e9 + r.int(0, 1e9));
  post[w] = pre[w] - (w === 0 ? fee : 0);
  const tip = tipIdx >= 0 ? r.int(1000, 5_000_000) : 0;
  if (tipIdx >= 0) {
    post[tipIdx] = pre[tipIdx] + tip;
    if (w === 0) post[w] -= tip;
  }
  const buySol = () => {
    post[w] -= lam;
    post[pool] = pre[pool] + lam;
  };
  const sellSol = () => {
    post[w] += lam;
    pre[pool] = Math.max(pre[pool], lam + 1e9);
    post[pool] = pre[pool] - lam;
  };
  const tok = (b: number, a: number, idx = ata, m = mint, d = dec) => {
    preT.push(tb(idx, m, owner, raw(b), d));
    postT.push(tb(idx, m, owner, raw(a), d));
  };
  switch (kind) {
    case "buy": case "tinySol": case "multiAccount": case "secondSigner": case "huge": {
      if (kind === "tinySol") {
        post[w] += lam - r.int(1000, 90_000);
      } else buySol();
      tok(before, before + tokens);
      if (kind === "multiAccount") tok(r.int(0, 1e6), r.int(0, 1e6) + tokens, ata2);
      if (kind === "huge") {
        pre[pool] = 2 ** 53 + r.int(1, 1e6) * 7;
        post[pool] = pre[pool] + lam;
      }
      break;
    }
    case "sell": tok(before + tokens, before); sellSol(); break;
    case "buyNewAta": case "token2022Rent": {
      buySol();
      const rent = kind === "token2022Rent" ? r.pick([2_074_080, 2_108_880, 2_157_600]) : 2_039_280;
      if (r.chance(0.7)) {
        pre[ata] = 0;
        post[ata] = rent;
      }
      post[w] -= rent;
      postT.push(tb(ata, mint, owner, raw(tokens)));
      break;
    }
    case "sellCloseAta": {
      sellSol();
      pre[ata] = r.pick([2_039_280, 2_074_080, 0]);
      post[ata] = 0;
      post[w] += pre[ata] || 0;
      preT.push(tb(ata, mint, owner, raw(tokens)));
      break;
    }
    case "wsolBuy": case "wsolSell": {
      const wb = r.int(0, 50) * 1e9 + r.int(0, 1e9);
      const buy = kind === "wsolBuy";
      tok(buy ? wb + lam : wb, buy ? wb : wb + lam, quoteAta, SOL_MINT, 9);
      if (buy) tok(before, before + tokens);
      else tok(before + tokens, before);
      break;
    }
    case "usdcBuy": case "usdtSell": case "solPlusUsdc": {
      const usd = r.int(1, 5000) * 10 ** 6 + r.int(0, 999_999);
      const m = kind === "usdtSell" ? USDT_MINT : USDC_MINT;
      const ub = r.int(0, 1e6) * 1e6;
      if (kind === "usdtSell") {
        tok(ub, ub + usd, quoteAta, m, 6);
        tok(before + tokens, before);
      } else {
        tok(ub + usd, ub, quoteAta, m, 6);
        tok(before, before + tokens);
        if (kind === "solPlusUsdc") buySol();
      }
      break;
    }
    case "routed": case "routedNoMatch": {
      tok(before + tokens, before);
      tok(r.int(0, 1e6), r.int(0, 1e6) + tokens * 3 + 1, ata2, mint2);
      const out = Math.max(lam, 1_000_000);
      pre[pool] = Math.max(pre[pool], out + 1e9);
      post[pool] = pre[pool] - out;
      post[pool2] = pre[pool2] + (kind === "routed" ? out - r.int(0, Math.floor(out * 0.05)) : Math.floor(out * 0.5));
      break;
    }
    case "twoTokens": tok(before, before + tokens); tok(before + 5, before + tokens * 2, ata2, mint2); buySol(); break;
    case "airdrop": tok(before, before + tokens); post[w] += lam; break;
    case "nonMeme": tok(before, before + tokens); buySol(); break;
    case "dust": tok(before, before); buySol(); break;
    case "noUiAmount": preT.push(tb(ata, mint, owner, null)); postT.push(tb(ata, mint, owner, raw(tokens))); buySol(); break;
    default: tok(before, before + tokens); buySol();
  }
  // Some token balances owned by other wallets (the pool's vaults).
  if (r.chance(0.5)) {
    const other = bs58.encode(r.key());
    preT.push(tb(pool2, mint, other, raw(r.int(1e6, 1e12))));
    postT.push(tb(pool2, mint, other, raw(r.int(1e6, 1e12))));
  }
  // Move some keys into address lookup tables (accounts are ordered static, then writable, then read-only).
  const nStatic = Math.max(signers + 1, n - r.int(0, 3));
  const loadedW = keys.slice(nStatic, nStatic + Math.max(0, Math.min(2, n - nStatic)));
  const loadedR = keys.slice(nStatic + loadedW.length);
  const info: GrpcTxInfo = {
    signature: Uint8Array.from({ length: 64 }, () => r.int(0, 255)),
    isVote: kind === "vote",
    transaction: {
      message: {
        header: r.chance(0.95) ? { numRequiredSignatures: signers } : undefined,
        accountKeys: keys.slice(0, nStatic),
        instructions: progIdx.slice(0, r.int(1, progIdx.length)).map((i) => ({ programIdIndex: i })).concat(r.chance(0.05) ? [{ programIdIndex: 250 }] : []),
      },
    },
    meta: kind === "noMeta" ? undefined : {
      err: kind === "failed" ? { err: Uint8Array.from([r.int(1, 9), 0, 0, 0]) } : r.chance(0.05) ? { err: new Uint8Array(0) } : undefined,
      fee: String(fee),
      preBalances: pre.map((x) => String(Math.max(0, Math.round(x)))),
      postBalances: post.map((x) => String(Math.max(0, Math.round(x)))),
      innerInstructions: r.chance(0.6) ? [{ instructions: progIdx.slice(r.int(0, progIdx.length - 1)).map((i) => ({ programIdIndex: i })) }] : [],
      preTokenBalances: preT,
      postTokenBalances: postT,
      loadedWritableAddresses: loadedW,
      loadedReadonlyAddresses: loadedR,
    },
  };
  const solUsd = r.pick([null, 0, 151.37, 98.125, 212.5]);
  return grpcToFixture(info, 300_000_000 + seed * 7, 1_760_000_000_000 + seed * 433_117, solUsd, `synthetic-${seed}-${kind}`);
}

// ---------- the scenarios of agent/test/parse.test.ts, as gRPC updates ----------

function fromTests(): FixtureTx[] {
  const WALLET = bs58.encode(Uint8Array.from({ length: 32 }, (_, i) => i + 1));
  const POOL = bs58.encode(Uint8Array.from({ length: 32 }, (_, i) => 200 - i));
  const ATA = bs58.encode(Uint8Array.from({ length: 32 }, (_, i) => 90 + i));
  const MINT = "Mint111111111111111111111111111111111111111";
  const JUP = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
  const PUMP = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
  const tip = "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5";
  const tb = (accountIndex: number, mint: string, amount: number, decimals = 6) => ({ accountIndex, mint, owner: WALLET, uiTokenAmount: { amount: String(Math.round(amount * 10 ** decimals)), decimals } });
  // Mirrors helpers.ts swapTx: WALLET (key 0) and a pool (key 1) swap SOL for MINT.
  const mk = (name: string, o: { solDelta: number; tokenBefore: number; tokenAfter: number; newTokenAccount?: boolean; programs?: string[]; inner?: string[]; err?: boolean; extra?: { key: string; pre: number; post: number }[]; wsol?: [number, number] }): FixtureTx => {
    const keys = [WALLET, POOL, ATA, ...(o.extra ?? []).map((e) => e.key)];
    const pre = [10e9, 100e9, 0, ...(o.extra ?? []).map((e) => e.pre)];
    const post = [10e9 + Math.round(o.solDelta * 1e9), 100e9 - Math.round(o.solDelta * 1e9), 0, ...(o.extra ?? []).map((e) => e.post)];
    const progs = [...new Set([...(o.programs ?? [JUP]), ...(o.inner ?? [])])];
    for (const p of progs) {
      keys.push(p);
      pre.push(1);
      post.push(1);
    }
    const preT = o.newTokenAccount ? [] : [tb(2, MINT, o.tokenBefore)];
    const postT = [tb(2, MINT, o.tokenAfter)];
    if (o.wsol) {
      keys.push(bs58.encode(Uint8Array.from({ length: 32 }, () => 3)));
      pre.push(2039280);
      post.push(2039280);
      preT.push(tb(keys.length - 1, SOL_MINT, o.wsol[0], 9));
      postT.push(tb(keys.length - 1, SOL_MINT, o.wsol[1], 9));
    }
    const ix = (p: string) => ({ programIdIndex: keys.indexOf(p) });
    return {
      name: `tests-${name}`, slot: 1, receivedAtMs: 1_760_000_000_000, solUsd: null,
      info: {
        signature: bs58.encode(Uint8Array.from({ length: 64 }, () => 7)), isVote: false,
        transaction: { message: { header: { numRequiredSignatures: 1 }, accountKeys: keys, instructions: (o.programs ?? [JUP]).map(ix) } },
        meta: {
          ...(o.err ? { err: { err: "0100" } } : {}),
          fee: "5000", preBalances: pre.map(String), postBalances: post.map(String),
          innerInstructions: o.inner ? [{ instructions: o.inner.map(ix) }] : [],
          preTokenBalances: preT, postTokenBalances: postT, loadedWritableAddresses: [], loadedReadonlyAddresses: [],
        },
      },
    };
  };
  const rent = 2_039_280 / 1e9;
  return [
    mk("buy", { solDelta: -1.000005, tokenBefore: 0, tokenAfter: 5000 }),
    mk("partial-sell", { solDelta: 0.5 - 0.000005, tokenBefore: 4000, tokenAfter: 1000 }),
    mk("rent-not-price", { solDelta: -(1 + rent + 0.000005), tokenBefore: 0, tokenAfter: 100, newTokenAccount: true }),
    mk("failed", { solDelta: -1, tokenBefore: 0, tokenAfter: 100, err: true }),
    mk("airdrop", { solDelta: 0.1, tokenBefore: 0, tokenAfter: 100 }),
    mk("wsol", { solDelta: -0.000005, tokenBefore: 0, tokenAfter: 100, wsol: [2, 0.5] }),
    mk("via-bot", { solDelta: -1, tokenBefore: 0, tokenAfter: 100, programs: ["BotRouter111111111111111111111111111111111"], inner: [PUMP] }),
    mk("direct-pump", { solDelta: -1, tokenBefore: 0, tokenAfter: 100, programs: [PUMP] }),
    mk("jito", { solDelta: -1.010005, tokenBefore: 0, tokenAfter: 100, extra: [{ key: tip, pre: 1e9, post: 1.01e9 }] }),
  ];
}

// ---------- bot signs ----------

export interface BotCase {
  closed: { openedAtMs: number; closedAtMs: number; openedSlot: number | null; closedSlot: number | null }[];
  nowMs: number;
  signaturesSeen: number;
  oldestSeenAtMs: number | null;
  cfg: { minHoldSec: number; maxTxPerHour: number; maxSameBlock: number };
}

export function botOutput(c: BotCase): string {
  const closed = c.closed.map((x) => ({
    mint: "M", openedAt: new Date(x.openedAtMs).toISOString(), closedAt: new Date(x.closedAtMs).toISOString(), costSol: 1, proceedsSol: 1, pnlSol: 0, pnlPct: 0,
    costUsd: null, proceedsUsd: null, pnlUsd: null, lastSellSignature: "s", lastSellPriceSol: 1, earlyEntry: false,
    ...(x.openedSlot === null ? {} : { openedSlot: x.openedSlot }), ...(x.closedSlot === null ? {} : { closedSlot: x.closedSlot }),
  })) as ClosedPosition[];
  const realized: Realized = { closed, events: [], open: new Map(), unmatchedSells: 0 };
  const st = computeStats([], realized, c.nowMs, 60);
  const tph = txPerHourFrom(c.signaturesSeen, c.oldestSeenAtMs === null ? null : new Date(c.oldestSeenAtMs).toISOString(), c.nowMs);
  const reason = botReason({ median_hold_sec: st.median_hold_sec, tx_per_hour: tph, same_block_round_trips: st.same_block_round_trips }, c.cfg);
  return JSON.stringify({ medianHoldSec: st.median_hold_sec, sameBlockRoundTrips: st.same_block_round_trips, txPerHour: tph, reason });
}

function botCases(count: number): BotCase[] {
  const out: BotCase[] = [];
  for (let s = 0; s < count; s++) {
    const r = rng(1_000_003 + s);
    const now = 1_790_000_000_000 + r.int(0, 1e9);
    const closed = Array.from({ length: r.int(0, 12) }, () => {
      const closedAt = now - r.int(0, 40) * 86_400_000 - r.int(0, 86_400_000);
      const hold = r.pick([0, 400, 3_000, 9_999, 14_500, 15_000, 61_000, 3_600_000, r.int(0, 2e8)]);
      const slot = r.int(1e8, 3e8);
      const same = r.chance(0.2);
      return { openedAtMs: closedAt - hold, closedAtMs: closedAt, openedSlot: r.chance(0.9) ? slot : null, closedSlot: r.chance(0.9) ? (same ? slot : slot + r.int(1, 500)) : null };
    });
    out.push({
      closed, nowMs: now, signaturesSeen: r.pick([0, 5, 19, 20, 21, 100, 1000, r.int(0, 5000)]),
      oldestSeenAtMs: r.chance(0.8) ? now - r.int(0, 30 * 3_600_000) : null,
      cfg: r.chance(0.7) ? { minHoldSec: 15, maxTxPerHour: 20, maxSameBlock: 0 } : { minHoldSec: r.int(1, 120), maxTxPerHour: r.int(1, 200), maxSameBlock: r.int(0, 3) },
    });
  }
  return out;
}

// ---------- real transactions (read-only RPC) ----------

async function rpc(url: string, method: string, params: unknown[]): Promise<unknown> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      continue;
    }
    const j = (await res.json()) as { result?: unknown; error?: { message: string } };
    if (j.error) throw new Error(j.error.message);
    return j.result;
  }
  throw new Error("rate limited");
}

interface RpcJsonTx {
  slot: number;
  blockTime: number | null;
  transaction: { signatures: string[]; message: { header: { numRequiredSignatures: number }; accountKeys: string[]; instructions: { programIdIndex: number }[] } };
  meta: {
    err: unknown; fee: number; preBalances: number[]; postBalances: number[];
    innerInstructions?: { instructions: { programIdIndex: number }[] }[];
    preTokenBalances?: { accountIndex: number; mint: string; owner?: string; uiTokenAmount: { amount: string; decimals: number } }[];
    postTokenBalances?: { accountIndex: number; mint: string; owner?: string; uiTokenAmount: { amount: string; decimals: number } }[];
    loadedAddresses?: { writable: string[]; readonly: string[] };
  } | null;
}

/** An RPC "json" transaction -> the gRPC update the stream would have delivered for it. */
function rpcToFixture(t: RpcJsonTx, sig: string): FixtureTx {
  const m = t.meta!;
  const tb = (b: NonNullable<RpcJsonTx["meta"]>["preTokenBalances"]) =>
    (b ?? []).map((x) => ({ accountIndex: x.accountIndex, mint: x.mint, owner: x.owner ?? "", uiTokenAmount: { amount: x.uiTokenAmount.amount, decimals: x.uiTokenAmount.decimals } }));
  return {
    name: `real-${sig.slice(0, 16)}`,
    slot: t.slot,
    receivedAtMs: (t.blockTime ?? 0) * 1000 + 437,
    solUsd: 187.25,
    info: {
      signature: sig,
      isVote: false,
      transaction: { message: { header: { numRequiredSignatures: t.transaction.message.header.numRequiredSignatures }, accountKeys: t.transaction.message.accountKeys, instructions: t.transaction.message.instructions.map((i) => ({ programIdIndex: i.programIdIndex })) } },
      meta: {
        ...(m.err ? { err: { err: Buffer.from(JSON.stringify(m.err)).toString("hex") } } : {}),
        fee: String(m.fee), preBalances: m.preBalances.map(String), postBalances: m.postBalances.map(String),
        innerInstructions: (m.innerInstructions ?? []).map((ii) => ({ instructions: ii.instructions.map((i) => ({ programIdIndex: i.programIdIndex })) })),
        preTokenBalances: tb(m.preTokenBalances), postTokenBalances: tb(m.postTokenBalances),
        loadedWritableAddresses: m.loadedAddresses?.writable ?? [], loadedReadonlyAddresses: m.loadedAddresses?.readonly ?? [],
      },
    },
  };
}

async function fetchReal(url: string, perProgram: number): Promise<void> {
  const programs = ["6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA", "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
    "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C", "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc", "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
    "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN"];
  const out: FixtureTx[] = [];
  for (const p of programs) {
    const sigs = (await rpc(url, "getSignaturesForAddress", [p, { limit: perProgram }])) as { signature: string }[];
    let n = 0;
    for (const s of sigs) {
      let t: RpcJsonTx | null = null;
      try {
        t = (await rpc(url, "getTransaction", [s.signature, { encoding: "json", maxSupportedTransactionVersion: 1, commitment: "confirmed" }])) as RpcJsonTx | null;
      } catch (e) {
        console.log(`skipped ${s.signature.slice(0, 12)}: ${(e as Error).message.slice(0, 80)}`);
      }
      if (t?.meta) {
        out.push(rpcToFixture(t, s.signature));
        n++;
      }
      await new Promise((r) => setTimeout(r, 120));
    }
    console.log(`${p}: ${n} transactions`);
  }
  writeFileSync(join(FIXTURE_DIR, "real.ndjson"), out.map((f) => JSON.stringify(f)).join("\n") + "\n");
  console.log(`wrote ${out.length} real transactions`);
}

function writeGolden(): void {
  const tests = fromTests();
  writeFileSync(join(FIXTURE_DIR, "tests.ndjson"), tests.map((f) => JSON.stringify(f)).join("\n") + "\n");
  const synthetic = Array.from({ length: 3000 }, (_, i) => synth(i));
  writeFileSync(join(FIXTURE_DIR, "synthetic.ndjson"), synthetic.map((f) => JSON.stringify(f)).join("\n") + "\n");
  for (const set of FIXTURE_SETS) {
    const fx = readNdjson<FixtureTx>(join(FIXTURE_DIR, `${set}.ndjson`));
    const golden = fx.map(tsOutput);
    writeFileSync(join(FIXTURE_DIR, `${set}.golden.ndjson`), golden.join("\n") + "\n");
    const swaps = golden.reduce((a, g) => a + (g === "null" ? 0 : (JSON.parse(g) as unknown[]).length), 0);
    console.log(`${set}: ${fx.length} transactions, ${swaps} swaps`);
  }
  const bots = botCases(500);
  writeFileSync(join(FIXTURE_DIR, "bot.ndjson"), bots.map((c) => JSON.stringify(c)).join("\n") + "\n");
  writeFileSync(join(FIXTURE_DIR, "bot.golden.ndjson"), bots.map(botOutput).join("\n") + "\n");
  console.log(`bot: ${bots.length} cases`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [cmd, a, b] = process.argv.slice(2);
  if (cmd === "fetch") await fetchReal(a || "https://api.mainnet-beta.solana.com", Number(b) || 40);
  else if (cmd === "golden") writeGolden();
  else console.log("usage: rust-fixtures golden | fetch [RPC_URL] [N]");
}
