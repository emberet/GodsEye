/**
 * THE BRAIN'S EXPERIENCE — every paper decision and its outcome, for the Mac trainer (brain/spec/CONTRACT.md, "Transitions").
 *
 * One row per decision step in brain_transitions, append-only:
 *   • entry: each leader buy a paper account decided on (Brain, Explore; Baseline's taken copies too), action = the stake fraction
 *   • exit:  each exit evaluation of an open Brain/Explore position, action = the index of hold / sell_half / sell_all
 * The only updates are fills of what wasn't known yet: the position an entry opened, and on its close the reward (net SOL P&L
 * after every fee and rent) on the entry row and on the position's last exit row, which also gets done = 1.
 * Entries that open nothing (a skip, or a stake the limits refused) are final at once: reward 0, done 1.
 */
import type { DB } from "@godseye/shared";
import { ensureBrainTables } from "./schema";

export type Account = "brain" | "explore" | "baseline";

/** The exit network's actions, in the order of its q output. */
export const EXIT_ACTIONS = ["hold", "sell_half", "sell_all"] as const;
export type ExitAction = (typeof EXIT_ACTIONS)[number];

export interface TransitionRow {
  ts: string;
  account: Account;
  kind: "entry" | "exit";
  positionId?: number | null;
  leader?: string | null;
  mint?: string | null;
  modelVersion?: string | null;
  features: number[];
  action: number;
  q?: number[] | null;
  info?: Record<string, unknown> | null;
  /** Set when the outcome is already known (a skip: 0). */
  reward?: number | null;
  done?: boolean;
}

/** Append one decision step; returns its id. */
export function recordTransition(db: DB, r: TransitionRow): number {
  ensureBrainTables(db);
  const res = db
    .prepare(
      `INSERT INTO brain_transitions (ts, account, kind, position_id, leader, mint, model_version, features, action, q, reward, done, info)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      r.ts, r.account, r.kind, r.positionId ?? null, r.leader ?? null, r.mint ?? null, r.modelVersion ?? null,
      JSON.stringify(r.features.map((x) => (Number.isFinite(x) ? x : 0))), r.action, r.q ? JSON.stringify(r.q) : null,
      r.reward ?? null, r.done ? 1 : 0, r.info ? JSON.stringify(r.info) : null,
    );
  return Number(res.lastInsertRowid);
}

/** An entry that opened a position: tie it to the position (its reward comes on the close). */
export function linkEntry(db: DB, transitionId: number, positionId: number): void {
  db.prepare("UPDATE brain_transitions SET position_id = ? WHERE id = ? AND kind = 'entry' AND position_id IS NULL").run(positionId, transitionId);
}

/** An entry that opened nothing after all (limits, no buy route, rug check): final, with no reward. */
export function closeEntryUnfilled(db: DB, transitionId: number, why: string): void {
  const row = db.prepare("SELECT info FROM brain_transitions WHERE id = ?").get(transitionId) as { info: string | null } | undefined;
  if (!row) return;
  const info = { ...(row.info ? (JSON.parse(row.info) as Record<string, unknown>) : {}), blocked: why };
  db.prepare("UPDATE brain_transitions SET reward = 0, done = 1, info = ? WHERE id = ? AND reward IS NULL").run(JSON.stringify(info), transitionId);
}

/**
 * A position closed with net P&L `pnlSol`: the entry row gets it as its reward, and the last exit row (the step that ended
 * the trade) gets it too with done = 1. Earlier exit rows keep reward null (the trainer shapes per-step rewards itself).
 */
export function finishPosition(db: DB, positionId: number, pnlSol: number): void {
  db.prepare("UPDATE brain_transitions SET reward = ?, done = 1 WHERE position_id = ? AND kind = 'entry'").run(pnlSol, positionId);
  const last = db.prepare("SELECT MAX(id) id FROM brain_transitions WHERE position_id = ? AND kind = 'exit'").get(positionId) as { id: number | null };
  if (last.id !== null) db.prepare("UPDATE brain_transitions SET reward = ?, done = 1 WHERE id = ?").run(pnlSol, last.id);
}
