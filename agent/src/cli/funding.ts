/**
 * `npm run funding` — the funding ledger and the risk governor's state, for the owner's console (never the feed).
 * `npm run funding -- expect <SOL> [hours]` — announces a withdrawal of up to that much in the next hours (default 24),
 * so taking SOL out doesn't pause the agent as an unexplained outflow.
 */
import { openDb } from "@godseye/shared";
import { readRiskState } from "../copy/risk";
import { expectWithdrawal, fundingTotals } from "../funding/ledger";

const db = openDb();
const [cmd, amount, hours] = process.argv.slice(2);
if (cmd === "expect") {
  const sol = Number(amount);
  const h = hours === undefined ? 24 : Number(hours);
  if (!(sol > 0) || !(h > 0)) {
    console.error("Usage: npm run funding -- expect <SOL> [hours]");
    process.exit(1);
  }
  expectWithdrawal(db, sol, h);
  console.log(`Announced: up to ${sol} SOL may leave the agent's wallet in the next ${h} h without pausing it.`);
} else {
  const t = fundingTotals(db);
  const s = readRiskState(db);
  console.log(`Funding ledger: ${t.count} flow(s) · deposits ${t.deposits.toFixed(4)} SOL · withdrawals ${t.withdrawals.toFixed(4)} SOL · swaps it didn't make ${t.swaps}${t.unpriced ? ` · ${t.unpriced} not priced yet` : ""}`);
  if (!s) console.log("Risk governor: no look yet (it starts with the first positions run in real mode).");
  else
    console.log(
      [
        `Risk governor (last look ${s.at}):`,
        `  units ${s.units.toFixed(4)} · value per unit ${s.nav.toFixed(4)} · high ${s.high.toFixed(4)} (${((s.nav / s.high - 1) * 100).toFixed(1)}%) · today ${((s.nav / s.dayStart - 1) * 100).toFixed(1)}%${s.stoppedDay === s.day ? " · DAY'S STOP" : ""}`,
        `  to trade with ${s.equity.toFixed(4)} SOL · a trade gets ${(s.f * 100).toFixed(1)}% · counting closed trades since ${s.since}`,
      ].join("\n"),
    );
}
