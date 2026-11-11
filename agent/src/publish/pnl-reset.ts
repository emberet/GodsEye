/**
 * The dashboard's P&L cutoff (agent_meta pnl_since, read by shared/src/dashboard-data.ts): the site counts closed trades
 * and copies from that moment on. Nothing is deleted: positions, copy_trades and the proof ledger keep everything, and
 * the agent's own decisions (daily loss limit, leader drops, learning) still read the full history.
 * The starting capital the performance page grows from is reset too: the wallet balance, or the copy budget when the
 * wallet reads empty. The values replaced are kept in pnl_reset_prev, so `undoPnlReset` puts them back.
 */
import { type DB, getMeta, setMeta } from "@godseye/shared";

const KEYS = ["pnl_since", "starting_balance_sol", "starting_balance_usd"] as const;
type Kept = Record<(typeof KEYS)[number], string | null>;

const positive = (v: string | null): number | null => (v !== null && Number(v) > 0 ? Number(v) : null);
const keep = (db: DB): Kept => Object.fromEntries(KEYS.map((k) => [k, getMeta(db, k)])) as Kept;
const put = (db: DB, k: string, v: string | number | null) =>
  v === null ? db.prepare("DELETE FROM agent_meta WHERE key = ?").run(k) : setMeta(db, k, v);

/** Start of the current UTC day. */
export const startOfUtcDay = (now = Date.now()): string => `${new Date(now).toISOString().slice(0, 10)}T00:00:00.000Z`;

/** Sets the cutoff (default: the start of today, UTC) and the new starting capital. Returns what was there and what is now. */
export function resetPnl(db: DB, at: string = startOfUtcDay()): { before: Kept; after: Kept } {
  const t = Date.parse(at);
  if (!Number.isFinite(t)) throw new Error(`not a date: ${at}`);
  const before = keep(db);
  const startSol = positive(getMeta(db, "wallet_balance_sol")) ?? positive(getMeta(db, "copy_budget_sol")) ?? 0;
  const solUsd = positive(getMeta(db, "sol_usd_now"));
  // A reset on top of a reset keeps the first one's values, so undo always returns to the state before any reset.
  if (getMeta(db, "pnl_reset_prev") === null) setMeta(db, "pnl_reset_prev", JSON.stringify(before));
  put(db, "pnl_since", new Date(t).toISOString());
  put(db, "starting_balance_sol", startSol);
  put(db, "starting_balance_usd", solUsd ? startSol * solUsd : null);
  return { before, after: keep(db) };
}

/** Restores the values the first reset replaced and removes the cutoff. False if there was nothing to undo. */
export function undoPnlReset(db: DB): boolean {
  const raw = getMeta(db, "pnl_reset_prev");
  if (raw === null) return false;
  const prev = JSON.parse(raw) as Kept;
  for (const k of KEYS) put(db, k, prev[k] ?? null);
  put(db, "pnl_reset_prev", null);
  return true;
}
