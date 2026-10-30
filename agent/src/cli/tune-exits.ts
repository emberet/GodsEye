/**
 * `npm run tune-exits` — let the agent pick its own exit rule (learning/exits.ts).
 *
 * Replays the ranked candidates' last 14 days under every candidate rule (stop-loss / take-profit pairs, ladders with a
 * trailing stop, with or without a ceiling), at GodsEye's real delay and real per-transaction cost, and stores the rule to use. Run every 6 hours by godseye-exits.timer, apart from
 * the agent (it loads every candidate's price tapes: about 1–2 GB for a minute).
 *
 *   --dry-run     print the decision, store nothing
 *   --table       every rule's score, best first
 */
import { openDb, openDbReadonly } from "@godseye/shared";
import { config } from "../config";
import { candidateRules, chooseExits, currentExits, type ExitRule, ruleName, storeExits } from "../learning/exits";
import { DEFAULT_PARAMS, type ReplayParams } from "../replay/model";
import { calibration } from "../replay/run";
import { loadBooks, rankedCandidates, runRule, scoreRule } from "../replay/sweep";
import { replayDelaySec } from "../smart/copy-check";

const dry = process.argv.includes("--dry-run");
const ro = openDbReadonly();
const inUse = currentExits(ro, { stopLossPct: config.stopLossPct, takeProfitPct: config.takeProfitPct });
const cal = calibration(ro);
// A real buy's cost includes the token account's rent; split the round trip's cost over its two transactions.
const txCostSol = Math.max(DEFAULT_PARAMS.txCostSol, cal.n >= 5 && cal.medianFeeSol !== null ? cal.medianFeeSol / 2 : 0);
const data = loadBooks(ro, rankedCandidates(ro, 150), 14);
const base: ReplayParams = { ...DEFAULT_PARAMS, delaySec: replayDelaySec(ro), txCostSol, sizeSol: config.copyMaxTradeSol, minLeaderBuySol: config.minLeaderBuySol, maxHoldHours: config.maxHoldHours };
const rules = new Map<string, ExitRule>([...candidateRules(), inUse].map((r) => [ruleName(r), r]));
const scored = [...rules.values()].map((rule) => ({
  rule,
  score: scoreRule(ruleName(rule), runRule(data, {
    ...base, stopLossPct: rule.stopLossPct, takeProfitPct: rule.takeProfitPct,
    partialTpPct: rule.partialTpPct, partialTpFraction: rule.partialFraction, trailStopPct: rule.trailStopPct, trailArmPct: rule.trailArmPct,
  }), data.mid),
}));
ro.close();

const pick = chooseExits(scored, inUse);
const line = `${data.wallets.length} wallets, ${data.books.length} wallet-coin books (loaded in ${data.loadSec.toFixed(0)}s), delay ${base.delaySec}s, cost ${txCostSol.toFixed(4)} SOL a transaction. In use: ${ruleName(inUse)} (${inUse.source}). ${pick.changed ? "Switching to" : "Keeping"} ${ruleName(pick)} — ${pick.reason}.`;
console.log(line);
if (process.argv.includes("--table"))
  for (const s of scored.map((c) => c.score).sort((a, b) => Math.min(b.firstHalfTrimmedPct, b.secondHalfTrimmedPct) - Math.min(a.firstHalfTrimmedPct, a.secondHalfTrimmedPct)))
    console.log(s.name.padEnd(30), s.n, `${s.firstHalfTrimmedPct.toFixed(2)}% / ${s.secondHalfTrimmedPct.toFixed(2)}%`, `${s.firstHalfSol.toFixed(2)} / ${s.secondHalfSol.toFixed(2)} SOL`);
if (!dry) {
  const db = openDb();
  // Stored every run (the same rule too): a choice the job hasn't renewed in 2 days stops counting.
  storeExits(db, pick);
  db.close();
}
