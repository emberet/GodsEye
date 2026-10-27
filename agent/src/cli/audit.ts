/**
 * `npm run audit` — the decision audit trail.
 *
 *   npm run audit                      how the last 7 days of copy decisions went, what the log-only copyability gate would have decided, and how wallets stand
 *   npm run audit -- --days 30
 *   npm run audit -- wallet <address>  why a wallet is (or was) in its state, evaluation by evaluation
 *   npm run audit -- why <signature|mint>   every check that ran on a leader's buy of that token, and the gate's verdict
 *   npm run audit -- --json
 *
 * Read-only. The agent writes the trail (src/audit/); this only reads it.
 */
import { openDbReadonly } from "@godseye/shared";
import { auditTablesExist } from "../audit/schema";
import { buildAuditReport, explainDecision, explainWallet, formatAuditReport } from "../audit/report";

const args = process.argv.slice(2);
const flagValue = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const days = Number(flagValue("days") ?? 7);
if (!Number.isFinite(days) || days <= 0) throw new Error("--days needs a positive number");
const positional = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--days");

const db = openDbReadonly();
if (!auditTablesExist(db)) {
  console.log("No audit trail yet: start the agent (npm run agent) once and it creates the tables, then fills them as it learns and as leaders buy.");
  process.exit(0);
}
if (positional[0] === "wallet" && positional[1]) console.log(explainWallet(db, positional[1]));
else if (positional[0] === "why" && positional[1]) console.log(explainDecision(db, positional[1]));
else {
  const report = buildAuditReport(db, Date.now() - days * 86_400_000);
  console.log(args.includes("--json") ? JSON.stringify(report, null, 2) : formatAuditReport(report));
}
db.close();
