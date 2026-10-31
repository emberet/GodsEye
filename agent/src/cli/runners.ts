/**
 * `npm run runners` — the runner research so far (runners/, x/): what counts as a runner, who keeps catching them early,
 * and who posts them on X first. Read-only.
 *
 *   --top 20      rows per table
 *   --replay      also replay copying the qualifying catchers GodsEye has analyzed (current exit rule, real delay and cost)
 */
import { openDbReadonly } from "@godseye/shared";
import { config } from "../config";
import { currentExits, ruleName } from "../learning/exits";
import { DEFAULT_PARAMS } from "../replay/model";
import { loadBooks, runRule, scoreRule } from "../replay/sweep";
import { currentDefinition, describeDefinition } from "../runners/define";
import { runnerTablesExist } from "../runners/schema";
import { replayDelaySec } from "../smart/copy-check";

const args = process.argv.slice(2);
const top = (() => {
  const i = args.indexOf("--top");
  return i >= 0 ? Number(args[i + 1]) : 20;
})();
const db = openDbReadonly();
if (!runnerTablesExist(db)) {
  console.log("No runner research yet: the live tape starts filling once the agent runs with the stream.");
  process.exit(0);
}
const def = currentDefinition(db);
const coins = db.prepare("SELECT COUNT(*) n, SUM(source = 'stream') s, SUM(source = 'backfill') b, MIN(first_seen) since FROM runner_tokens").get() as { n: number; s: number; b: number; since: string };
console.log(def ? `Definition: ${describeDefinition(def)} (as of ${def.at}).` : "Definition: not computed yet (the agent does it hourly).");
console.log(`Coins kept: ${coins.n} (${coins.s ?? 0} watched from launch, ${coins.b ?? 0} read back from Solana) since ${coins.since ?? "—"}.\n`);

const fmt = (v: number | null, d = 1) => (v === null || v === undefined ? "—" : v.toFixed(d));
const runners = db
  .prepare("SELECT mint, symbol, first_seen, multiple, peak_mcap_usd, minutes_above_5x, buyers, source FROM runner_tokens WHERE is_runner = 1 ORDER BY first_seen DESC LIMIT ?")
  .all(top) as { mint: string; symbol: string | null; first_seen: string; multiple: number; peak_mcap_usd: number | null; minutes_above_5x: number; buyers: number; source: string }[];
console.log("RECENT RUNNERS");
for (const r of runners)
  console.log(`  ${r.first_seen.slice(0, 16)}  ${(r.symbol ?? r.mint.slice(0, 6)).padEnd(12)} ${fmt(r.multiple, 0).padStart(6)}x  peak $${Math.round(r.peak_mcap_usd ?? 0).toLocaleString("en-US").padStart(11)}  ${String(r.minutes_above_5x).padStart(4)} min at 5x  ${r.buyers} buyers  (${r.source})  ${r.mint}`);

const catchers = db
  .prepare("SELECT * FROM runner_catchers ORDER BY qualifies DESC, score DESC LIMIT ?")
  .all(top) as { wallet: string; hits: number; early_buys: number; hit_rate: number; hit_rate_lb: number; base_rate: number; days: number; median_entry_x: number | null; median_x_to_peak: number | null; capture: number | null; copyable_share: number | null; label: string; x_handle: string | null; score: number; qualifies: number }[];
console.log(`\nRUNNER-CATCHERS (hit rate = runners bought early ÷ launches bought early; base rate ${fmt((catchers[0]?.base_rate ?? 0) * 100, 2)}%)`);
for (const c of catchers)
  console.log(
    `  ${c.qualifies ? "✔" : " "} ${c.wallet}  ${c.label.padEnd(8)} ${String(c.hits).padStart(3)} hits / ${String(c.early_buys || "?").padStart(5)} early buys  rate ${fmt(c.hit_rate * 100)}% (≥${fmt(c.hit_rate_lb * 100)}%)  ${c.days} days  entry ${fmt(c.median_entry_x)}x  peak/entry ${fmt(c.median_x_to_peak, 0)}x  sold at ${fmt(c.capture)}x  copyable ${c.copyable_share === null ? "—" : `${Math.round(c.copyable_share * 100)}%`}${c.x_handle ? `  @${c.x_handle}` : ""}`,
  );

const hasX = !!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'x_callers'").get();
const callers = hasX
  ? (db.prepare("SELECT * FROM x_callers ORDER BY score DESC LIMIT ?").all(top) as { username: string | null; followers: number | null; calls: number; runner_calls: number; early_runner_calls: number; control_calls: number; hit_rate_lb: number; median_lead_min: number | null; days: number; linked_wallets: string | null }[])
  : [];
console.log(`\nX CALLERS${config.xBearerToken ? "" : " (X_BEARER_TOKEN not set: no searches yet)"}`);
for (const c of callers)
  console.log(
    `  @${(c.username ?? "?").padEnd(18)} ${String(c.followers ?? "?").padStart(8)} followers  ${c.early_runner_calls}/${c.runner_calls} runners early, ${c.control_calls} non-runners  rate ≥${fmt(c.hit_rate_lb * 100)}%  lead ${fmt(c.median_lead_min, 0)} min  ${c.days} days${c.linked_wallets ? `  wallets ${c.linked_wallets}` : ""}`,
  );

if (args.includes("--replay")) {
  const wallets = (db.prepare("SELECT c.wallet FROM runner_catchers c JOIN wallets w ON w.address = c.wallet WHERE c.qualifies = 1 AND w.last_analyzed_at IS NOT NULL").all() as { wallet: string }[]).map((r) => r.wallet);
  if (!wallets.length) console.log("\nREPLAY: no qualifying catcher analyzed yet.");
  else {
    const rule = currentExits(db, { stopLossPct: config.stopLossPct, takeProfitPct: config.takeProfitPct });
    const data = loadBooks(db, wallets, 14);
    const s = scoreRule(ruleName(rule), runRule(data, {
      ...DEFAULT_PARAMS, delaySec: replayDelaySec(db), sizeSol: config.copyMaxTradeSol, minLeaderBuySol: config.minLeaderBuySol, maxHoldHours: config.maxHoldHours,
      stopLossPct: rule.stopLossPct, takeProfitPct: rule.takeProfitPct, partialTpPct: rule.partialTpPct, partialTpFraction: rule.partialFraction, trailStopPct: rule.trailStopPct, trailArmPct: rule.trailArmPct,
    }), data.mid);
    console.log(`\nREPLAY of copying ${wallets.length} qualifying catchers, 14 days, ${ruleName(rule)}: ${s.n} copies, ${s.wins} wins, median ${fmt(s.medianPct)}%, trimmed mean ${fmt(s.trimmedMeanPct)}%, ${fmt(s.pnlSol, 3)} SOL (halves ${fmt(s.firstHalfSol, 3)} / ${fmt(s.secondHalfSol, 3)}).`);
  }
}
db.close();
