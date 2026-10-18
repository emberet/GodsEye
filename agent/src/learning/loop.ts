/**
 * Runs the learning loop against the database: recompute every wallet's
 * copy weight (see weights.ts), record what changed and why, and return
 * the wallets GodsEye should now be copying.
 */
import { type DB, nowIso, setMeta, type Tier } from "@godseye/shared";
import { config } from "../config";
import { say, short } from "../log";
import { computeWeights, type WeightInput } from "./weights";

export function runLearning(db: DB): string[] {
  const since14 = new Date(Date.now() - 14 * 86_400_000).toISOString();
  const rows = db
    .prepare(
      `SELECT w.address, w.tier, w.is_fresh, w.copy_weight, s.pnl_7d_sol, s.pnl_30d_sol, s.closed_30d, s.win_rate_30d,
              COALESCE((SELECT SUM(pnl_sol) FROM positions p WHERE p.leader = w.address AND p.status='closed' AND p.closed_at >= ?), 0) copy_pnl,
              (SELECT COUNT(*) FROM positions p WHERE p.leader = w.address AND p.status='closed' AND p.closed_at >= ?) copy_closed
         FROM wallets w JOIN wallet_stats s ON s.wallet = w.address`,
    )
    .all(since14, since14) as {
    address: string; tier: Tier; is_fresh: number; copy_weight: number; pnl_7d_sol: number; pnl_30d_sol: number;
    closed_30d: number; win_rate_30d: number | null; copy_pnl: number; copy_closed: number;
  }[];

  const inputs: WeightInput[] = rows.map((r) => ({
    address: r.address, tier: r.tier, pnl7: r.pnl_7d_sol, pnl30: r.pnl_30d_sol, closed30: r.closed_30d, winRate30: r.win_rate_30d,
    isFresh: r.is_fresh === 1, copyPnl14: r.copy_pnl, copyClosed14: r.copy_closed, oldWeight: r.copy_weight,
  }));
  const result = computeWeights(inputs, { maxLeaders: config.maxLeaders, copyLossDropSol: config.copyLossDropSol });

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
  setMeta(db, "last_learning_at", ts);
  setMeta(db, "copy_budget_sol", config.copyBudgetSol);
  const leaders = [...result.entries()].filter(([, v]) => v.weight > 0).map(([a]) => a);
  say("learn", `Learning loop: ${leaders.length} wallets to copy (${promoted} added, ${dropped} dropped) out of ${rows.length} analyzed.`);
  return leaders;
}

export function currentLeaders(db: DB): string[] {
  return (db.prepare("SELECT address FROM wallets WHERE copy_weight > 0 ORDER BY copy_weight DESC").all() as { address: string }[]).map((r) => r.address);
}
