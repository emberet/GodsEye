/**
 * Reading a wallet's past from Solana with plain RPC calls (works with
 * Helius, any paid RPC, or — slowly — the public one).
 */
import { PublicKey, type ConfirmedSignatureInfo } from "@solana/web3.js";
import { rpcUrl } from "../config";
import { connection } from "../rpc";
import { findFunder, parseSwaps, type ParsedSwap, type TxLike } from "./parse";
import { solUsdAt } from "../market/solprice";
import { noteThrottled, takeRpc } from "./rpc-budget";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Newest transaction format GodsEye reads. Solana now has version-1
 * transactions, which the RPC refuses to return unless asked; web3.js 1.x
 * can't parse them, so transactions are fetched with raw JSON-RPC
 * ("jsonParsed" already has everything parse.ts needs).
 */
const MAX_TX_VERSION = 1;

type RpcReply = { id: number; result?: TxLike | null; error?: { message: string } };

async function rpcCall(signatures: string[], metered: boolean): Promise<RpcReply[]> {
  const body = signatures.map((sig, id) => ({
    jsonrpc: "2.0", id, method: "getTransaction",
    params: [sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: MAX_TX_VERSION, commitment: "confirmed" }],
  }));
  for (let attempt = 0; ; attempt++) {
    if (metered) await takeRpc(body.length);
    const res = await fetch(rpcUrl(), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body.length === 1 ? body[0] : body), signal: AbortSignal.timeout(30_000) });
    if (res.status === 429) noteThrottled();
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
async function rpcBatch(signatures: string[], metered = false): Promise<(TxLike | null)[]> {
  const out: (TxLike | null)[] = new Array(signatures.length).fill(null);
  let pending = signatures.map((_, i) => i);
  let lastError = "";
  for (let attempt = 0; pending.length && attempt < 5; attempt++) {
    if (attempt) await sleep(1500 * 2 ** (attempt - 1));
    const replies = await rpcCall(pending.map((i) => signatures[i]), metered);
    const failed: number[] = [];
    for (const r of replies) {
      if (r.error) {
        if (/rate|limit|429|too many/i.test(r.error.message)) noteThrottled();
        failed.push(pending[r.id]);
        lastError = r.error.message;
      } else out[pending[r.id]] = r.result ?? null;
    }
    pending = failed;
  }
  if (pending.length === signatures.length) throw new Error(lastError || "RPC refused every request");
  return out;
}

/** Newest-first signatures, stopping at `until` (exclusive) or after `limit`. Not metered: used by the copy watcher. */
export async function fetchSignatures(wallet: string, opts: { until?: string | null; limit: number; before?: string }): Promise<ConfirmedSignatureInfo[]> {
  return (await pageSignatures(wallet, { ...opts, metered: false })).sigs;
}

/**
 * Newest-first signatures, stopping at `until`, after `limit`, or once older than `sinceMs`.
 * `exhausted`: paging ran out (the wallet has nothing older); `reachedTime`: stopped at `sinceMs`.
 */
async function pageSignatures(
  wallet: string,
  opts: { until?: string | null; limit: number; before?: string; sinceMs?: number; metered: boolean },
): Promise<{ sigs: ConfirmedSignatureInfo[]; exhausted: boolean; reachedTime: boolean }> {
  const out: ConfirmedSignatureInfo[] = [];
  let before = opts.before;
  while (out.length < opts.limit) {
    const want = Math.min(1000, opts.limit - out.length);
    if (opts.metered) await takeRpc(1);
    const page = await connection().getSignaturesForAddress(new PublicKey(wallet), { before, until: opts.until ?? undefined, limit: want });
    const inTime = opts.sinceMs === undefined ? page : page.filter((s) => !s.blockTime || s.blockTime * 1000 >= opts.sinceMs!);
    out.push(...inTime);
    if (inTime.length < page.length) return { sigs: out, exhausted: false, reachedTime: true };
    if (page.length < want) return { sigs: out, exhausted: true, reachedTime: false };
    before = page[page.length - 1].signature;
  }
  return { sigs: out, exhausted: false, reachedTime: false };
}

/**
 * When was this token launched, as far as Solana can tell cheaply? Walks the mint's signatures back from
 * `before` (a buy of it), up to `pages` × 1000. `exact`: the mint's first transaction was reached, so `at`
 * is the launch; otherwise `at` is the oldest transaction seen, so the buy came at least that long after
 * launch. Metered like other history reads.
 */
export async function mintLaunchBefore(
  mint: string,
  before: string,
  beforeTs: string,
  pages = 3,
): Promise<{ at: string; exact: boolean; creator: string | null }> {
  const p = await pageSignatures(mint, { before, limit: pages * 1000, metered: true });
  const oldest = p.sigs.at(-1);
  const at = oldest?.blockTime ? new Date(oldest.blockTime * 1000).toISOString() : beforeTs; // nothing older: the buy launched it
  // The mint's first transaction created it: whoever paid for it is the creator (one more RPC call, no RugCheck).
  let creator: string | null = null;
  if (p.exhausted && oldest) {
    const tx = await rpcBatch([oldest.signature], true).then((r) => r[0]).catch(() => null);
    creator = tx?.transaction.message.accountKeys[0]?.pubkey.toString() ?? null;
  }
  return { at, exact: p.exhausted, creator };
}

/** Batches of 20 kept in flight at once: Shyft takes ~5 s per batch of parsed transactions, so one at a time is far below RPC_MAX_RPS (the budget still sets the pace). */
const BATCHES_IN_FLIGHT = 12;

/** Fetch parsed transactions in small batches (falls back to one at a time if the RPC refuses batches). Metered. */
export async function fetchParsed(signatures: string[]): Promise<(TxLike | null)[]> {
  const chunks: string[][] = [];
  for (let i = 0; i < signatures.length; i += 20) chunks.push(signatures.slice(i, i + 20));
  const results: (TxLike | null)[][] = new Array(chunks.length);
  let next = 0;
  const worker = async () => {
    while (next < chunks.length) {
      const i = next++;
      const chunk = chunks[i];
      try {
        results[i] = await rpcBatch(chunk, true);
      } catch {
        const one: (TxLike | null)[] = [];
        for (const sig of chunk) {
          one.push(await rpcBatch([sig], true).then((r) => r[0]).catch(() => null));
          await sleep(150);
        }
        results[i] = one;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(BATCHES_IN_FLIGHT, chunks.length) }, worker));
  return results.flat();
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
  /** Time of the oldest transaction whose swaps were read: the start of what this wallet's stats can cover. */
  historyFrom: string | null;
  /** Signature of that oldest transaction (where reading further back would continue). */
  oldestSignature: string | null;
  /** Transactions read this time. */
  read: number;
  /** True if nothing more needs reading back: the wallet's first transaction or the day target was reached,
   * or the RPC no longer has the older transactions (Shyft only keeps ~2-3 days). */
  historyDone: boolean;
  /** Transactions listed but not returned by the RPC (too old for it to keep): their swaps are missing. */
  unavailable: number;
}

/**
 * The RPC can list signatures further back than it can return transactions (Shyft keeps ~2-3 days).
 * Coverage starts at the oldest transaction actually read, not the oldest signature listed; when nearly all
 * listed transactions come back empty, the RPC has run out of history and reading further back is pointless.
 * `sigs` and `txs` are aligned, newest first.
 */
export function readCoverage<S>(sigs: S[], txs: (unknown | null)[]): { oldestRead: S | null; unavailable: number; rpcRanOut: boolean } {
  let oldestRead: S | null = null;
  let unavailable = 0;
  sigs.forEach((s, i) => {
    if (txs[i]) oldestRead = s;
    else unavailable++;
  });
  return { oldestRead, unavailable, rpcRanOut: sigs.length >= 20 && unavailable / sigs.length > 0.9 };
}

/**
 * Reads new swaps since `sinceSignature` (or the last `limit` transactions on first look).
 * On first look it also tries to find the wallet's first transaction (age + who funded it).
 */
export async function readWalletHistory(
  wallet: string,
  opts: { sinceSignature: string | null; limit: number; findOrigin: boolean; sinceMs?: number; before?: string },
): Promise<WalletHistory> {
  const page = await pageSignatures(wallet, { until: opts.sinceSignature, limit: opts.limit, before: opts.before, sinceMs: opts.sinceMs, metered: true });
  const sigs = page.sigs;
  const ok = sigs.filter((s) => !s.err);
  const txs = await fetchParsed(ok.map((s) => s.signature));
  const { oldestRead, unavailable, rpcRanOut } = readCoverage(ok, txs);
  const swaps: ParsedSwap[] = [];
  txs.forEach((tx) => {
    if (!tx) return;
    swaps.push(...parseSwaps(tx, wallet, { solUsdAt }));
  });

  let reachedOrigin = false;
  let oldest = sigs.at(-1) ?? null;
  let seen = sigs.length;
  let funder: string | null = null;
  if (opts.findOrigin) {
    if (page.exhausted) {
      reachedOrigin = true;
    } else if (oldest) {
      // Page further back (signatures only — cheap) looking for the first transaction.
      const older = await pageSignatures(wallet, { limit: 3000, before: oldest.signature, metered: true }).then((p) => p.sigs).catch(() => []);
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
    historyFrom: t(oldestRead),
    oldestSignature: sigs.at(-1)?.signature ?? null,
    read: sigs.length,
    // Complete only when the wallet's start or the day target was reached; stopping at the cap leaves room to deepen.
    historyDone: page.exhausted || page.reachedTime || rpcRanOut,
    unavailable,
  };
}
