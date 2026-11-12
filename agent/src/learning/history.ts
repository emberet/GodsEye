/**
 * FEATURE HISTORY — values kept elsewhere only as "the latest", appended to feature_history as they were when made, so the
 * brain can later learn from their past without reading the future (roadmap Phase 4 step 7):
 *   rug_check     each rug verdict saved (market/rugcheck.ts saveVerdict)
 *   organic       each organic verdict written (smart/organic.ts)
 *   wallet_skill  each new skill verdict of the offline quant job (wallet_skill.computed_at), picked up hourly
 *   cluster       once a day: the funder group of every wallet the agent copies or follows as smart money
 * `at` is when the value was made. Private research data, pulled by the Mac (brain/brain/export/pull.py); never on the site.
 */
import { type DB, getMeta, nowIso, setMeta } from "@godseye/shared";

export type HistoryKind = "rug_check" | "organic" | "wallet_skill" | "cluster";

export function recordHistory(db: DB, kind: HistoryKind, key: string, at: string, value: unknown): void {
  db.prepare("INSERT INTO feature_history (kind, key, at, value) VALUES (?, ?, ?, ?)").run(kind, key, at, JSON.stringify(value));
}

const SKILL_KEY = "history_wallet_skill_at";
const CLUSTER_KEY = "history_cluster_day";

/** The hourly pass: new skill verdicts, and the day's cluster snapshot once a day. Returns the rows added. */
export function snapshotHistory(db: DB, now = Date.now()): number {
  let added = 0;
  db.transaction(() => {
    const hasSkill = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'wallet_skill'").get();
    if (hasSkill) {
      const since = Number(getMeta(db, SKILL_KEY) ?? 0) || 0;
      const rows = db.prepare("SELECT * FROM wallet_skill WHERE computed_at > ? ORDER BY computed_at").all(since) as ({ wallet: string; computed_at: number } & Record<string, unknown>)[];
      for (const r of rows) recordHistory(db, "wallet_skill", r.wallet, new Date(r.computed_at * 1000).toISOString(), r);
      if (rows.length) setMeta(db, SKILL_KEY, rows[rows.length - 1].computed_at);
      added += rows.length;
    }
    const day = new Date(now).toISOString().slice(0, 10);
    if (getMeta(db, CLUSTER_KEY) !== day) {
      const rows = db
        .prepare(
          `SELECT w.address, w.funder, (SELECT COUNT(*) FROM wallets g WHERE g.funder = w.funder) group_size, w.copy_weight
           FROM wallets w WHERE w.funder IS NOT NULL AND (w.copy_weight > 0 OR w.address IN (SELECT address FROM smart_wallets))`,
        )
        .all() as { address: string; funder: string; group_size: number; copy_weight: number }[];
      const at = nowIso();
      for (const r of rows) recordHistory(db, "cluster", r.address, at, { funder: r.funder, group_size: r.group_size, copy_weight: r.copy_weight });
      setMeta(db, CLUSTER_KEY, day);
      added += rows.length;
    }
  })();
  return added;
}
