/**
 * `npm run archive` — the compressed swap archive (shared/src/archive.ts).
 *
 *   npm run archive                                      archived days and their size
 *   npm run archive -- restore 2026-10-01 2026-10-07     put those days back into data/restored.db (a separate
 *                                                        research database; the live one is never touched)
 *   --into path.db                                       restore into another file
 */
import { archivedDays, dataPath, openDb, restoreDays } from "@godseye/shared";

const args = process.argv.slice(2);
const dir = dataPath("archive");
const days = archivedDays(dir);
const mb = (b: number) => (b / 1e6).toFixed(1);

if (args[0] === "restore") {
  const [from, to = from] = args.slice(1).filter((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
  if (!from) throw new Error("restore needs a day (YYYY-MM-DD), or a first and last day");
  const i = args.indexOf("--into");
  const into = i >= 0 ? args[i + 1] : dataPath("restored.db");
  const pick = days.filter((d) => d.day >= from && d.day <= to).map((d) => d.day);
  if (!pick.length) throw new Error(`no archived days between ${from} and ${to}`);
  const db = openDb(into);
  const n = restoreDays(db, dir, pick);
  db.close();
  console.log(`Restored ${n.toLocaleString("en-US")} swaps from ${pick.length} day(s) into ${into}.`);
} else {
  const total = days.reduce((s, d) => s + d.bytes, 0);
  console.log(days.length ? `${days.length} archived days, ${mb(total)} MB compressed, in ${dir}` : `Nothing archived yet (${dir}).`);
  for (const d of days) console.log(`  ${d.day}  ${mb(d.bytes).padStart(8)} MB`);
}
