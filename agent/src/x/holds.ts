/**
 * X CHATTER OVER A HOLD, in shadow (roadmap 5e): once a position closes, one count request (counts/all, about half a
 * cent) says how many posts named its coin while GodsEye held it, kept next to how the position ended. If chatter turns
 * out to predict outcomes, live polling of open positions is worth building; until then this is all it costs.
 * Paid from the research share of the X budget; a few positions a day at most (HOLD_COUNTS_PER_RUN a run). Nothing here
 * changes a trade. Private: counts only, never on the site.
 */
import { type DB, nowIso } from "@godseye/shared";
import { ensureRunnerTables } from "../runners/schema";
import { buildQuery } from "./calls";
import { countAll, type XStop, xConfigured } from "./client";

/** Positions counted per run (the job runs hourly). */
export const HOLD_COUNTS_PER_RUN = 10;
/** Only positions closed within this long are counted (older ones are left: their window is long gone from interest). */
const RECENT_MS = 7 * 86_400_000;
/** X refuses an end_time less than ~10 s ago. */
const END_MARGIN_MS = 30_000;

const TABLE = `
CREATE TABLE IF NOT EXISTS x_hold_counts (
  position_id INTEGER NOT NULL,
  mode TEXT NOT NULL,
  mint TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  closed_at TEXT NOT NULL,
  posts INTEGER NOT NULL,
  pnl_pct REAL,
  decider TEXT,
  counted_at TEXT NOT NULL,
  PRIMARY KEY (position_id)
);
`;

export function ensureHoldCountTable(db: DB): void {
  db.exec(TABLE);
}

/** Counts the posts over the hold of positions closed lately and not counted yet. Ends at once when X stops. */
export async function countHolds(db: DB, now = Date.now()): Promise<{ counted: number; stop?: XStop }> {
  if (!xConfigured()) return { counted: 0 };
  ensureRunnerTables(db);
  ensureHoldCountTable(db);
  const rows = db
    .prepare(
      `SELECT p.id, p.mode, p.mint, p.symbol, p.opened_at, p.closed_at, p.pnl_pct, p.decider FROM positions p
        WHERE p.status = 'closed' AND p.closed_at >= ? AND p.id NOT IN (SELECT position_id FROM x_hold_counts)
        ORDER BY p.closed_at DESC LIMIT ?`,
    )
    .all(new Date(now - RECENT_MS).toISOString(), HOLD_COUNTS_PER_RUN) as {
    id: number; mode: string; mint: string; symbol: string | null; opened_at: string; closed_at: string; pnl_pct: number | null; decider: string | null;
  }[];
  const put = db.prepare("INSERT OR IGNORE INTO x_hold_counts (position_id, mode, mint, opened_at, closed_at, posts, pnl_pct, decider, counted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  let counted = 0;
  for (const r of rows) {
    const to = new Date(Math.min(Date.parse(r.closed_at), now - END_MARGIN_MS)).toISOString();
    if (!(Date.parse(to) > Date.parse(r.opened_at))) continue;
    const c = await countAll(db, buildQuery(r.mint, r.symbol), r.opened_at, to, "research");
    if (c.capped) return { counted, stop: c.reason };
    put.run(r.id, r.mode, r.mint, r.opened_at, r.closed_at, c.count, r.pnl_pct, r.decider, nowIso());
    counted++;
  }
  return { counted };
}
