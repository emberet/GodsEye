/**
 * `npm run reset-pnl` — the dashboard counts P&L from the start of today (UTC); old trades stay in the database and the
 * proof ledger, just off the site. `-- --at <ISO time>` picks another moment; `-- --undo` puts the old figures back.
 * Changes no copy decision (see ../publish/pnl-reset.ts).
 */
import { openDb } from "@godseye/shared";
import { resetPnl, undoPnlReset } from "../publish/pnl-reset";

const db = openDb();
const args = process.argv.slice(2);
if (args.includes("--undo")) {
  console.log(undoPnlReset(db) ? "Dashboard P&L reset undone: it counts every trade again." : "No dashboard P&L reset to undo.");
} else {
  const i = args.indexOf("--at");
  const { before, after } = resetPnl(db, i >= 0 ? args[i + 1] : undefined);
  console.log("before:", before);
  console.log("after: ", after);
  console.log(`The dashboard now counts P&L from ${after.pnl_since}. Nothing was deleted; \`npm run reset-pnl -- --undo\` reverts.`);
}
