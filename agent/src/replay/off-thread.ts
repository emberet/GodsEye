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
const waiting = new Map<number, { resolve: (r: WalletReplay) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
/** A replay that hasn't answered in this long is failed (the caller's catch path), and the worker is recycled. */
const REPLAY_TIMEOUT_MS = Number(process.env.REPLAY_WORKER_TIMEOUT_MS ?? 120_000);

/**
 * The worker is referenced only while a request is pending, so the process (or test runner) can't exit with a
 * replay in flight and drop its result; when idle it is unref'd and never keeps the agent alive on its own.
 */
function syncRef(): void {
  if (!worker) return;
  if (waiting.size > 0) worker.ref();
  else worker.unref();
}

function settle(id: number): { resolve: (r: WalletReplay) => void; reject: (e: Error) => void } | undefined {
  const p = waiting.get(id);
  if (!p) return undefined;
  clearTimeout(p.timer);
  waiting.delete(id);
  syncRef();
  return p;
}

function failAll(e: Error, w?: Worker): void {
  if (w && worker !== w) return; // an already-replaced worker exiting must not fail the new one's requests
  for (const p of waiting.values()) {
    clearTimeout(p.timer);
    p.reject(e);
  }
  waiting.clear();
  worker = null;
}

/**
 * The worker is TypeScript, run through tsx. On Node 20, the loader hooks tsx installs with `--import` do not
 * reach worker threads, and the inherited `--import` flags are re-run in the worker without them, so a plain
 * `new Worker("replay-worker.ts")` died at startup with ERR_UNKNOWN_FILE_EXTENSION (Node 22+ happened to work).
 * The worker therefore starts from a tiny JS bootstrap that registers tsx itself and then imports the .ts entry,
 * with no inherited `--import` flags (the parent's env, e.g. GODSEYE_TEST, is still passed on).
 */
function spawnWorker(dbPath: string): Worker {
  const entry = new URL("./replay-worker.ts", import.meta.url).href;
  const boot = `import("tsx/esm/api").then((t) => { t.register(); return import(${JSON.stringify(entry)}); })` +
    `.catch((e) => { throw e; });`;
  const execArgv = process.execArgv.filter((a, i, all) => a !== "--import" && all[i - 1] !== "--import" && a !== "--require" && all[i - 1] !== "--require");
  return new Worker(boot, { eval: true, execArgv, workerData: { dbPath } });
}

function thread(dbPath: string): Worker {
  if (worker && workerDb === dbPath) return worker;
  void worker?.terminate();
  const w = spawnWorker(dbPath);
  w.on("message", (m: Reply) => {
    const p = settle(m.id);
    if (!p) return;
    if (m.result) p.resolve(m.result);
    else p.reject(new Error(m.error ?? "replay worker gave no result"));
  });
  w.on("error", (e) => failAll(e, w));
  w.on("exit", (code) => failAll(new Error(`replay worker exited (${code})`), w));
  w.unref(); // idle until a request is posted; see syncRef
  worker = w;
  workerDb = dbPath;
  return w;
}

/** replayWallet, off the main thread when the database is a file. Same arguments, same result. */
export function replayWalletOffThread(db: DB, wallet: string, delays: number[], base: Partial<ReplayParams> = {}, opts: Opts = {}): Promise<WalletReplay> {
  if (db.memory) return Promise.resolve(replayWallet(db, wallet, delays, base, opts));
  const id = ++nextId;
  return new Promise<WalletReplay>((resolve, reject) => {
    const w = thread(db.name);
    const timer = setTimeout(() => {
      const p = settle(id);
      if (!p) return;
      p.reject(new Error(`replay worker timed out after ${REPLAY_TIMEOUT_MS} ms`));
      if (worker === w) failAll(new Error("replay worker recycled after a timeout"), w);
      void w.terminate();
    }, REPLAY_TIMEOUT_MS);
    timer.unref();
    waiting.set(id, { resolve, reject, timer });
    syncRef();
    w.postMessage({ id, wallet, delays, base, opts });
  });
}
