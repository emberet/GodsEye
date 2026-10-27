/**
 * `npm run shadow` — what the shadow log has recorded, and how the tokens it followed fared.
 *
 *   npm run shadow                 the last 7 days
 *   npm run shadow -- --days 30
 *   npm run shadow -- --json       machine-readable
 *
 * Read-only. The log itself is written by the running agent (src/shadow/); this only reads it.
 */
import { openDbReadonly } from "@godseye/shared";
import { buildReport, formatReport } from "../shadow/report";

const args = process.argv.slice(2);
const i = args.indexOf("--days");
const days = i >= 0 ? Number(args[i + 1]) : 7;
if (!Number.isFinite(days) || days <= 0) throw new Error("--days needs a positive number");

const db = openDbReadonly();
if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'shadow_candidates'").get()) {
  console.log("No shadow log yet: start the agent (npm run agent) once and it creates the tables, then fills them as leaders buy.");
  process.exit(0);
}
const report = buildReport(db, Date.now() - days * 86_400_000);
console.log(args.includes("--json") ? JSON.stringify(report, null, 2) : formatReport(report));
db.close();
