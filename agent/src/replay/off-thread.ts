/**
 * Copy replays on a worker thread. A replay reads every token's price tape (hundreds of thousands of rows for
 * a busy wallet) through better-sqlite3, which is synchronous: on the main thread it held the event loop for up
 * to 7 s at a time, and a leader's trade arriving meanwhile waited the whole time. The worker has its own
 * read-only connection; the main thread only writes the results. An in-memory database (tests) can't be shared
 * with a thread, so it is replayed inline.
 */
import { Worker } from "node:worker_threads";
import type { DB } from "@godseye/shared";
import type { ReplayParams } from "./model";
import { replayWallet, type WalletReplay } from "./run";

type Opts = { sinceMs?: number; untilMs?: number; endT?: number };
type Reply = { id: number; result?: WalletReplay; error?: string };

let worker: Worker | null = null;
let workerDb = "";
let nextId = 0;
const waiting = new Map<number, { resolve: (r: WalletReplay) => void; reject: (e: Error) => void }>();

function failAll(e: Error): void {
  for (const w of waiting.values()) w.reject(e);
  waiting.clear();
  worker = null;
}

function thread(dbPath: string): Worker {
  if (worker && workerDb === dbPath) return worker;
  void worker?.terminate();
  const w = new Worker(new URL("./replay-worker.ts", import.meta.url), { workerData: { dbPath } });
  w.on("message", (m: Reply) => {
    const p = waiting.get(m.id);
    if (!p) return;
    waiting.delete(m.id);
    if (m.result) p.resolve(m.result);
    else p.reject(new Error(m.error ?? "replay worker gave no result"));
  });
  w.on("error", (e) => failAll(e));
  w.on("exit", (code) => failAll(new Error(`replay worker exited (${code})`)));
  w.unref(); // never keeps the agent alive on its own
  worker = w;
  workerDb = dbPath;
  return w;
}

/** replayWallet, off the main thread when the database is a file. Same arguments, same result. */
export function replayWalletOffThread(db: DB, wallet: string, delays: number[], base: Partial<ReplayParams> = {}, opts: Opts = {}): Promise<WalletReplay> {
  if (db.memory) return Promise.resolve(replayWallet(db, wallet, delays, base, opts));
  const id = ++nextId;
  return new Promise<WalletReplay>((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    thread(db.name).postMessage({ id, wallet, delays, base, opts });
  });
}
