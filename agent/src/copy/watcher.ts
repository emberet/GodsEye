/**
 * Watches the wallets GodsEye copies, live.
 *   • with GRPC_URL set, leaders' swaps arrive on the gRPC stream (stream.ts)
 *   • a websocket subscription per leader (Solana "logsSubscribe", on the copy RPC)
 *     fires the moment a leader's transaction confirms (and catches non-swap moves)
 *   • a poll every LEADER_POLL_SECONDS catches anything the websocket missed
 * Each new transaction is read once: swaps go to the copy engine; SOL sent to
 * a brand-new wallet adds that wallet to the database (possible rotation).
 */
import { PublicKey } from "@solana/web3.js";
import type { DB } from "@godseye/shared";
import { copyConnection } from "../rpc";
import { say, short } from "../log";
import { fetchParsedOne, fetchSignatures } from "../chain/history";
import { findNewWalletsFunded, parseSwaps, type TxLike } from "../chain/parse";
import { solUsdAt } from "../market/solprice";
import { addWallet } from "../discovery/discover";
import type { CopyEngine } from "./engine";
import { withTimeout } from "../jobs";

/** Bound on each RPC call made while polling leaders or reading one transaction (a hung call used to stall jobs). */
export const WATCHER_RPC_TIMEOUT_MS = 20_000;

/** SOL sent to a never-used wallet that makes GodsEye start tracking it. */
const ROTATION_MIN_SOL = 0.5;
/** Longest a sync waits on one RPC or websocket call: a dead websocket must never hold up the learning loop. */
const SYNC_CALL_MS = 10_000;

/** `p`, or `fallback` once `ms` pass without an answer. */
export function within<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<T>((r) => (timer = setTimeout(() => r(fallback), ms)));
  return Promise.race([p.catch(() => fallback), late]).finally(() => clearTimeout(timer));
}

export class LeaderWatcher {
  private subs = new Map<string, number>();
  private cursors = new Map<string, string | null>();
  private seen = new Set<string>();

  constructor(
    private db: DB,
    private engine: CopyEngine,
    /** Subscribe to each leader's logs over the copy RPC's websocket (off in tests). */
    private opts: { logs: boolean; callMs?: number } = { logs: true },
  ) {}

  get watching(): string[] {
    return [...this.cursors.keys()];
  }

  isWatching(address: string): boolean {
    return this.cursors.has(address);
  }

  /** A leader's transaction that arrived on the live gRPC stream (already read, so no RPC call). */
  async handleStreamed(leader: string, tx: TxLike, seenAt: number): Promise<void> {
    await this.handle(leader, tx.transaction.signatures[0], seenAt, tx);
  }

  /** Start watching new leaders, stop watching dropped ones. */
  async sync(leaders: string[]): Promise<void> {
    const want = new Set(leaders);
    for (const [addr, id] of this.subs) {
      if (!want.has(addr)) {
        await withTimeout(copyConnection().removeOnLogsListener(id), this.opts.callMs ?? SYNC_CALL_MS, `unsubscribe ${short(addr)}`).catch((e: Error) =>
          say("warn", `Live feed unsubscribe for ${short(addr)} failed (${e.message}); dropping it anyway.`),
        );
        this.subs.delete(addr);
        this.cursors.delete(addr);
      }
    }
    for (const addr of [...this.cursors.keys()]) if (!want.has(addr)) this.cursors.delete(addr);
    for (const addr of want) {
      if (this.cursors.has(addr)) continue;
      // Start from "now": GodsEye copies new trades only, never old ones.
      const newest = await within(fetchSignatures(addr, { limit: 1 }), this.opts.callMs ?? SYNC_CALL_MS, []);
      this.cursors.set(addr, newest[0]?.signature ?? null);
      if (!this.opts.logs) continue;
      try {
        const id = copyConnection().onLogs(new PublicKey(addr), (logs) => {
          if (!logs.err) void this.handle(addr, logs.signature, Date.now());
        }, "confirmed");
        this.subs.set(addr, id);
      } catch (e) {
        say("warn", `Live feed for ${short(addr)} unavailable (${(e as Error).message}); relying on polling.`);
      }
    }
  }

  /** Safety net: read each leader's newest transactions since the last one handled. */
  async poll(): Promise<void> {
    for (const [addr, cursor] of this.cursors) {
      try {
        const sigs = await withTimeout(fetchSignatures(addr, { until: cursor, limit: 50 }), this.opts.callMs ?? WATCHER_RPC_TIMEOUT_MS, `signatures for ${short(addr)}`);
        if (!sigs.length) continue;
        this.cursors.set(addr, sigs[0].signature);
        if (!cursor) continue; // first successful read: just set the starting point
        for (const s of [...sigs].reverse()) if (!s.err) await this.handle(addr, s.signature, Date.now());
      } catch {
        /* next poll */
      }
    }
  }

  private async handle(leader: string, signature: string, seenAt: number, streamed?: TxLike): Promise<void> {
    const key = `${leader}:${signature}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    if (this.seen.size > 20_000) this.seen = new Set([...this.seen].slice(-10_000));
    const tx = streamed ?? (await within(fetchParsedOne(signature), this.opts.callMs ?? WATCHER_RPC_TIMEOUT_MS, null));
    if (!tx) return;
    // A memecoin ↔ memecoin swap gives a sell then a buy: GodsEye mirrors both (selling first frees budget).
    const swaps = parseSwaps(tx, leader, { solUsdAt });
    if (swaps.length) {
      for (const swap of swaps) await this.engine.onLeaderSwap(swap, seenAt).catch((e: Error) => say("error", `Copy engine error: ${e.message}`));
      return;
    }
    for (const w of findNewWalletsFunded(tx, leader, ROTATION_MIN_SOL)) {
      if (addWallet(this.db, w.address, "funded_by_tracked", `received ${w.sol.toFixed(2)} SOL from tracked wallet ${leader}`)) {
        say("wallet", `${short(leader)} just funded a brand-new wallet ${short(w.address)} with ${w.sol.toFixed(2)} SOL — tracking it.`);
      }
    }
  }
}
