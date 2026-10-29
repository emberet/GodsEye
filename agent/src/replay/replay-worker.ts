/** Worker thread for off-thread.ts: replays wallets on its own read-only connection. */
import { parentPort, workerData } from "node:worker_threads";
import { openDbReadonly } from "@godseye/shared";
import { replayWallet } from "./run";

const db = openDbReadonly((workerData as { dbPath: string }).dbPath);
parentPort!.on("message", (r: { id: number; wallet: string; delays: number[]; base: object; opts: object }) => {
  try {
    parentPort!.postMessage({ id: r.id, result: replayWallet(db, r.wallet, r.delays, r.base, r.opts) });
  } catch (e) {
    parentPort!.postMessage({ id: r.id, error: (e as Error).message });
  }
});
