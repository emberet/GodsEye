/**
 * `npm run brain:warm [-- <days>]` — fills the Brain's leader ledgers from the swaps already stored (brain/warm.ts), so
 * its leader-history inputs aren't empty when the live stream comes back. Default the last 7 days (the features read 7).
 * Refuses while the live ledger is writing (rows newer than an hour) unless `--force`. Restart the agent afterwards: its
 * ledger reads the new rows at start. Console only.
 */
import { openDb } from "@godseye/shared";
import { warmLedgers } from "../brain/warm";
import { ensureBrainTables } from "../brain/schema";

const args = process.argv.slice(2);
const days = Number(args.find((a) => /^\d+(\.\d+)?$/.test(a)) ?? 7);
const force = args.includes("--force");
const db = openDb();
ensureBrainTables(db);
const newest = (db.prepare("SELECT MAX(created_at) t FROM mirror_ledger").get() as { t: string | null }).t;
if (!force && newest && Date.now() - Date.parse(newest) < 3_600_000) {
  console.error("The live ledger wrote rows within the hour: the stream is feeding it. Nothing to warm (--force to replay anyway).");
  process.exit(1);
}
const toMs = Date.now();
const fromMs = toMs - days * 86_400_000;
const t0 = Date.now();
let shown = 0;
const r = await warmLedgers(db, {
  fromMs,
  toMs,
  progress: (done, at) => {
    if (done - shown < 200_000) return;
    shown = done;
    console.log(`  ${done.toLocaleString("en-US")} swaps replayed, up to ${new Date(at).toISOString().slice(0, 16)}`);
  },
});
console.log(`Warm start: ${r.swaps.toLocaleString("en-US")} stored swaps of the last ${days} days replayed in ${Math.round((Date.now() - t0) / 1000)} s; ${r.mirrorRows.toLocaleString("en-US")} new mirror-ledger rows. Restart the agent so its ledger reads them.`);
