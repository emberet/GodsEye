/**
 * Reading a wallet's past from Solana with plain RPC calls (works with
 * Helius, any paid RPC, or — slowly — the public one).
 */
import { PublicKey, type ConfirmedSignatureInfo } from "@solana/web3.js";
import { rpcUrl } from "../config";
import { connection } from "../rpc";
import { findFunder, parseSwap, type ParsedSwap, type TxLike } from "./parse";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Newest transaction format GodsEye reads. Solana now has version-1
 * transactions, which the RPC refuses to return unless asked; web3.js 1.x
 * can't parse them, so transactions are fetched with raw JSON-RPC
 * ("jsonParsed" already has everything parse.ts needs).
 */
const MAX_TX_VERSION = 1;

type RpcReply = { id: number; result?: TxLike | null; error?: { message: string } };

async function rpcCall(signatures: string[]): Promise<RpcReply[]> {
  const body = signatures.map((sig, id) => ({
    jsonrpc: "2.0", id, method: "getTransaction",
    params: [sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: MAX_TX_VERSION, commitment: "confirmed" }],
  }));
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(rpcUrl(), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body.length === 1 ? body[0] : body), signal: AbortSignal.timeout(30_000) });
    if (res.status === 429 && attempt < 4) {
      await sleep(1500 * 2 ** attempt); // rate-limited: back off and try again
      continue;
    }
    if (!res.ok) throw new Error(`RPC ${res.status}`);
    const json = (await res.json()) as RpcReply | RpcReply[];
    return Array.isArray(json) ? json : [json];
  }
}

/** getTransaction for several signatures in one request; entries refused (e.g. per-method rate limits) are retried with backoff. */
async function rpcBatch(signatures: string[]): Promise<(TxLike | null)[]> {
  const out: (TxLike | null)[] = new Array(signatures.length).fill(null);
  let pending = signatures.map((_, i) => i);
  let lastError = "";
  for (let attempt = 0; pending.length && attempt < 5; attempt++) {
    if (attempt) await sleep(1500 * 2 ** (attempt - 1));
    const replies = await rpcCall(pending.map((i) => signatures[i]));
    const failed: number[] = [];
    for (const r of replies) {
      if (r.error) {
        failed.push(pending[r.id]);
        lastError = r.error.message;
      } else out[pending[r.id]] = r.result ?? null;
    }
    pending = failed;
  }
  if (pending.length === signatures.length) throw new Error(lastError || "RPC refused every request");
  return out;
}

/** Newest-first signatures, stopping at `until` (exclusive) or after `limit`. */
export async function fetchSignatures(wallet: string, opts: { until?: string | null; limit: number; before?: string }): Promise<ConfirmedSignatureInfo[]> {
  const out: ConfirmedSignatureInfo[] = [];
  let before = opts.before;
  while (out.length < opts.limit) {
    const want = Math.min(1000, opts.limit - out.length);
    const page = await connection().getSignaturesForAddress(new PublicKey(wallet), { before, until: opts.until ?? undefined, limit: want });
    out.push(...page);
    if (page.length < want) break;
    before = page[page.length - 1].signature;
  }
  return out;
}

/** Fetch parsed transactions in small batches (falls back to one at a time if the RPC refuses batches). */
export async function fetchParsed(signatures: string[]): Promise<(TxLike | null)[]> {
  const out: (TxLike | null)[] = [];
  for (let i = 0; i < signatures.length; i += 20) {
    const chunk = signatures.slice(i, i + 20);
    try {
      out.push(...(await rpcBatch(chunk)));
    } catch {
      for (const sig of chunk) {
        out.push(await rpcBatch([sig]).then((r) => r[0]).catch(() => null));
        await sleep(150);
      }
    }
  }
  return out;
}

export async function fetchParsedOne(signature: string): Promise<TxLike | null> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const tx = await rpcBatch([signature]).then((r) => r[0]).catch(() => null);
    if (tx) return tx;
    await sleep(400 * (attempt + 1)); // fresh transactions can take a moment to be readable
  }
  return null;
}

export interface WalletHistory {
  swaps: ParsedSwap[];
  newestSignature: string | null;
  /** Oldest transaction time GodsEye saw. */
  oldestSeenAt: string | null;
  /** True if GodsEye reached the wallet's very first transaction. */
  reachedOrigin: boolean;
  funder: string | null;
  activityAt: string | null;
  /** How many signatures GodsEye read (swaps or not) between oldestSeenAt and now. */
  signaturesSeen: number;
}

/**
 * Reads new swaps since `sinceSignature` (or the last `limit` transactions on first look).
 * On first look it also tries to find the wallet's first transaction (age + who funded it).
 */
export async function readWalletHistory(wallet: string, opts: { sinceSignature: string | null; limit: number; findOrigin: boolean }): Promise<WalletHistory> {
  const sigs = await fetchSignatures(wallet, { until: opts.sinceSignature, limit: opts.limit });
  const ok = sigs.filter((s) => !s.err);
  const txs = await fetchParsed(ok.map((s) => s.signature));
  const swaps: ParsedSwap[] = [];
  txs.forEach((tx) => {
    if (!tx) return;
    const s = parseSwap(tx, wallet);
    if (s) swaps.push(s);
  });

  let reachedOrigin = false;
  let oldest = sigs.at(-1) ?? null;
  let seen = sigs.length;
  let funder: string | null = null;
  if (opts.findOrigin) {
    if (sigs.length < opts.limit) {
      reachedOrigin = true;
    } else if (oldest) {
      // Page further back (signatures only — cheap) looking for the first transaction.
      const older = await fetchSignatures(wallet, { limit: 3000, before: oldest.signature }).catch(() => []);
      if (older.length) oldest = older.at(-1)!;
      seen += older.length;
      reachedOrigin = older.length < 3000;
    }
    if (reachedOrigin && oldest) {
      const first = await fetchParsedOne(oldest.signature);
      if (first) funder = findFunder(first, wallet);
    }
  }
  const t = (s: ConfirmedSignatureInfo | null | undefined) => (s?.blockTime ? new Date(s.blockTime * 1000).toISOString() : null);
  return {
    swaps,
    newestSignature: sigs[0]?.signature ?? opts.sinceSignature,
    oldestSeenAt: t(oldest),
    reachedOrigin,
    funder,
    activityAt: t(sigs[0]),
    signaturesSeen: seen,
  };
}
