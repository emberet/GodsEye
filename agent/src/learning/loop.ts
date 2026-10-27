/**
 * Runs the learning loop against the database: recompute every wallet's
 * copy weight (see weights.ts), record what changed and why, and return
 * the wallets GodsEye should now be copying.
 */
import { type DB, nowIso, setMeta, type Tier } from "@godseye/shared";
import { config } from "../config";
import { say, short } from "../log";
import { computeWeights, rawScore, type WeightInput } from "./weights";
import { solUsdAt } from "../market/solprice";
import { adaptThresholds } from "./adaptive";
import { recordEvaluations } from "../audit/evaluations";
import { FOLLOW_MIN_WIN_RATE, getParam } from "./adaptive";
import { botCfg, botReason, botSigns, copyReason, replayCfg, storedReplays } from "../smart/copy-check";

/** Every analyzed wallet as the weight rules see it, with the bot and copy gates applied unless `gates` is false. */
function weightInputs(db: DB, gates = true) {
  const solNow = solUsdAt(Date.now()) ?? 0;
  const since14 = new Date(Date.now() - 14 * 86_400_000).toISOString();
  const rows = db
    .prepare(
      `SELECT w.address, w.tier, w.is_fresh, w.copy_weight, s.pnl_7d_sol, s.pnl_30d_sol, s.pnl_7d_usd, s.pnl_30d_usd, s.closed_30d, s.win_rate_30d,
              COALESCE((SELECT SUM(pnl_sol) FROM positions p WHERE p.leader = w.address AND p.status='closed' AND p.mode = ? AND p.closed_at >= ?), 0) copy_pnl,
              (SELECT COUNT(*) FROM positions p WHERE p.leader = w.address AND p.status='closed' AND p.mode = ? AND p.closed_at >= ?) copy_closed,
              sw.lead_n, sw.lead_median_6h
         FROM wallets w JOIN wallet_stats s ON s.wallet = w.address LEFT JOIN smart_wallets sw ON sw.address = w.address`,
    )
    .all(config.copyMode, since14, config.copyMode, since14) as {
    address: string; tier: Tier; is_fresh: number; copy_weight: number; pnl_7d_sol: number; pnl_30d_sol: number; pnl_7d_usd: number | null; pnl_30d_usd: number | null;
    closed_30d: number; win_rate_30d: number | null; copy_pnl: number; copy_closed: number; lead_n: number | null; lead_median_6h: number | null;
  }[];

  const inputs: WeightInput[] = rows.map((r) => ({
    // USD at settlement; a wallet with no USD-valued trades falls back to SOL × today's price.
    address: r.address, tier: r.tier, pnl7: r.pnl_7d_usd ?? r.pnl_7d_sol * solNow, pnl30: r.pnl_30d_usd ?? r.pnl_30d_sol * solNow, closed30: r.closed_30d, winRate30: r.win_rate_30d,
    isFresh: r.is_fresh === 1, copyPnl14: r.copy_pnl, copyClosed14: r.copy_closed, oldWeight: r.copy_weight,
    leadN: r.lead_n ?? 0, leadMedian6h: r.lead_median_6h,
  }));
  if (gates) {
    const signs = botSigns(db, inputs.map((w) => w.address));
    const replays = storedReplays(db);
    const [bCfg, rCfg] = [botCfg(), replayCfg()];
    for (const w of inputs) {
      w.botGate = botReason(signs.get(w.address) ?? { median_hold_sec: null, tx_per_hour: null, same_block_round_trips: null }, bCfg);
      w.copyGate = w.botGate ? null : copyReason(replays.get(w.address) ?? null, rCfg);
    }
  }
  return { rows, inputs };
}

/** Wallets the weight rules would copy if they passed the copy gate: the ones worth a copy replay. */
export function copyCandidates(db: DB): string[] {
  const { inputs } = weightInputs(db, false);
  const cfg = { copyLossDropSol: config.copyLossDropSol, minClosed: config.minClosedForProven, minWinRate: getParam(db, FOLLOW_MIN_WIN_RATE, config.followWinRateStart) };
  return inputs.filter((w) => rawScore(w, cfg).weight > 0).map((w) => w.address);
}

export function runLearning(db: DB): string[] {
  // First learn the follow bar from outcomes, then weigh wallets against it.
  const minWinRate = adaptThresholds(db);
  const { rows, inputs } = weightInputs(db);
  const cutoffs = { maxLeaders: config.maxLeaders, copyLossDropSol: config.copyLossDropSol, minClosed: config.minClosedForProven, minWinRate };
  const result = computeWeights(inputs, cutoffs);

  const update = db.prepare("UPDATE wallets SET copy_weight = ?, weight_reason = ? WHERE address = ?");
  const history = db.prepare("INSERT INTO weight_history (wallet, ts, old_weight, new_weight, reason) VALUES (?, ?, ?, ?, ?)");
  const ts = nowIso();
  let promoted = 0;
  let dropped = 0;
  db.transaction(() => {
    for (const r of rows) {
      const next = result.get(r.address)!;
      const w = Number(next.weight.toFixed(4));
      update.run(w, next.reason, r.address);
      if (Math.abs(w - r.copy_weight) >= 0.01 || (w === 0) !== (r.copy_weight === 0)) {
        history.run(r.address, ts, r.copy_weight, w, next.reason);
        if (r.copy_weight === 0 && w > 0) {
          promoted++;
          say("learn", `Now copying ${short(r.address)} at ${(w * 100).toFixed(0)}% weight: ${next.reason}.`);
        } else if (r.copy_weight > 0 && w === 0) {
          dropped++;
          say("learn", `Stopped copying ${short(r.address)}: ${next.reason}.`);
        }
      }
    }
  })();
  // Why each wallet is where it is, for every one that changed (audit/evaluations.ts). Observation only.
  recordEvaluations(db, { inputs, results: result, cfg: cutoffs, mode: config.copyMode });
  setMeta(db, "last_learning_at", ts);
  setMeta(db, "copy_budget_sol", config.copyBudgetSol);
  const leaders = [...result.entries()].filter(([, v]) => v.weight > 0).map(([a]) => a);
  say("learn", `Learning loop: ${leaders.length} wallets to copy (${promoted} added, ${dropped} dropped) out of ${rows.length} analyzed.`);
  return leaders;
}

export function currentLeaders(db: DB): string[] {
  return (db.prepare("SELECT address FROM wallets WHERE copy_weight > 0 ORDER BY copy_weight DESC").all() as { address: string }[]).map((r) => r.address);
}
