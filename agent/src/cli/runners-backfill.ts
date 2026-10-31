/**
 * `npm run runners:backfill` — read back from Solana the launches of pump.fun coins that ran while the live tape wasn't
 * watching (runners/backfill.ts), several coins at a time, then re-apply the runner definition. Run every 6 hours by
 * godseye-runners.timer, apart from the agent: set RPC_MAX_RPS for this process (the unit gives it its own share).
 *
 *   --days 15  --coins 300  --workers 6  --pages 20  --txs 600
 */
import { openDb } from "@godseye/shared";
import { initSolPrices } from "../market/solprice";
import { runBackfill } from "../runners/backfill";
import { defineRunners, describeDefinition } from "../runners/define";
import { replayDelaySec } from "../smart/copy-check";

const args = process.argv.slice(2);
const flag = (name: string, fallback: number): number => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};

const db = openDb();
await initSolPrices(db);
const started = Date.now();
const r = await runBackfill(db, {
  days: flag("days", 15), maxCoins: flag("coins", 300), workers: flag("workers", 6), maxPages: flag("pages", 20), readTxs: flag("txs", 600),
  delayMs: replayDelaySec(db) * 1000,
});
const def = defineRunners(db);
console.log(
  `Runner backfill: ${r.candidates} coins came close to running without buyers stored; read ${r.read} launches from Solana (${r.tooBusy} too busy to page back, ${r.failed} failed), ${r.stored} stored, in ${Math.round((Date.now() - started) / 1000)}s. Now ${describeDefinition(def)}.`,
);
db.close();
