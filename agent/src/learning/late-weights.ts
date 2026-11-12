/**
 * LATE-COPIER WEIGHTS, in shadow (roadmap Phase 4 step 6). The weights (weights.ts) follow a leader's own profit; what
 * GodsEye can earn is what a late copy of it earns. Each learning run this records, next to every weight, the weight the
 * leader would get if judged by its mirror-ledger outcomes instead (brain/ledger.ts: a strict late copy of each of its
 * buys over 7 days): score = max(0, cp_lrshr_7d) × min(1, rows / 20), among the wallets every other rule lets through,
 * the top COPY_MAX_LEADERS sharing 1 with the same per-leader cap. Written to weight_shadow only: nothing trades on it
 * until a replay shows that blending it in pays (the Mac pulls the table).
 */
import { type DB, nowIso } from "@godseye/shared";
import { CP_SHRINK } from "../brain/ledger";
import { capShares, rawScore, type WeightInput, type WeightResult } from "./weights";

const FULL_ROWS = 20;
const WINDOW_MS = 7 * 86_400_000;

interface Cutoffs {
  maxLeaders: number;
  maxShare?: number;
  copyLossDropSol: number;
  minClosed: number;
  minWinRate: number;
  minCopyableShare?: number;
}

/** Late-copier weights for `inputs`, from the mirror ledger rows resolved in the 7 days before `now`. */
export function lateWeights(db: DB, inputs: WeightInput[], cfg: Cutoffs, now = Date.now()): Map<string, { weight: number; n: number; lrshr: number | null }> {
  const from = new Date(now - WINDOW_MS).toISOString();
  const to = new Date(now).toISOString();
  const hasLedger = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'mirror_ledger'").get(); // brain mode off: none
  const stats = new Map(
    (!hasLedger ? [] : db
      .prepare("SELECT leader, COUNT(*) n, SUM(lr) lr FROM mirror_ledger WHERE resolved_at >= ? AND resolved_at < ? AND lr IS NOT NULL GROUP BY leader")
      .all(from, to) as { leader: string; n: number; lr: number }[]).map((r) => [r.leader, r]),
  );
  const out = new Map<string, { weight: number; n: number; lrshr: number | null }>();
  const scored = new Map<string, WeightResult>();
  for (const w of inputs) {
    const s = stats.get(w.address);
    const n = s?.n ?? 0;
    const lrshr = s ? s.lr / (n + CP_SHRINK) : null;
    out.set(w.address, { weight: 0, n, lrshr });
    // Every rule but the profit ones (its own P&L is what this replaces): a positive stand-in lets the rest decide.
    const passes = rawScore({ ...w, pnl7: 1, pnl30: 1 }, cfg).weight > 0;
    const score = passes && lrshr !== null ? Math.max(0, lrshr) * Math.min(1, n / FULL_ROWS) : 0;
    if (score > 0) scored.set(w.address, { weight: score, reason: "" });
  }
  const top = [...scored.entries()].sort((a, b) => b[1].weight - a[1].weight).slice(0, cfg.maxLeaders);
  const total = top.reduce((t, [, v]) => t + v.weight, 0);
  const shares = new Map<string, WeightResult>(top.map(([a, v]) => [a, { weight: v.weight / total, reason: "" }]));
  if (cfg.maxShare) capShares(shares, cfg.maxShare);
  for (const [a, v] of shares) out.get(a)!.weight = v.weight;
  return out;
}

/** Writes this run's shadow row for every wallet with a weight or a late-copier weight. Returns the rows written. */
export function recordLateWeights(db: DB, inputs: WeightInput[], weights: Map<string, WeightResult>, cfg: Cutoffs, now = Date.now()): number {
  const late = lateWeights(db, inputs, cfg, now);
  const at = nowIso();
  const put = db.prepare("INSERT INTO weight_shadow (at, wallet, weight, late_weight, cp_n_7d, cp_lrshr_7d) VALUES (?, ?, ?, ?, ?, ?)");
  let n = 0;
  db.transaction(() => {
    for (const [wallet, l] of late) {
      const w = weights.get(wallet)?.weight ?? 0;
      if (!(w > 0) && !(l.weight > 0)) continue;
      put.run(at, wallet, Number(w.toFixed(4)), Number(l.weight.toFixed(4)), l.n, l.lrshr);
      n++;
    }
  })();
  return n;
}
