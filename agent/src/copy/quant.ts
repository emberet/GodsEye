/**
 * Optional quant sizing from the offline Python job (sizing_params / wallet_skill tables).
 *   QUANT_SIZING=off     (default) nothing changes
 *   QUANT_SIZING=shadow  logs what the quant size would have been next to the real size; real size unchanged
 *   QUANT_SIZING=on      size = min(current size, hard cap, configured cap, budget x weight x kelly_mult)
 *                        using a FRESH row only (valid_until in the future); otherwise the current size.
 * It can only reduce or keep a size, never increase it. Python never signs and is never called here.
 *   QUANT_SKILL_GATE=on  a 'luck' verdict sets the leader's weight to 0 (default off).
 */
import { HARD_MAX_COPY_TRADE_SOL, readSizingParams, readWalletSkill, type DB, type SizingParamsRow } from "@godseye/shared";

export type QuantSizingMode = "off" | "shadow" | "on";

export function quantSizingMode(env: NodeJS.ProcessEnv = process.env): QuantSizingMode {
  const v = env.QUANT_SIZING?.trim().toLowerCase();
  return v === "shadow" || v === "on" ? v : "off";
}

export const quantSkillGateOn = (env: NodeJS.ProcessEnv = process.env): boolean => env.QUANT_SKILL_GATE?.trim().toLowerCase() === "on";

export interface QuantSizeResult {
  /** Size from the quant multiplier, or null when no fresh usable row exists (fall back). */
  quantSize: number | null;
  /** The size to use: never above currentSize. */
  size: number;
  reason: string;
}

/** Pure clamp. currentSize is the existing formula's result; the result is always <= currentSize. */
export function quantClamp(
  currentSize: number,
  weight: number,
  cfg: { copyBudgetSol: number; copyMaxTradeSol: number },
  row: SizingParamsRow | null,
  nowSec: number,
): QuantSizeResult {
  if (!row) return { quantSize: null, size: currentSize, reason: "no sizing row" };
  if (!(row.valid_until > nowSec)) return { quantSize: null, size: currentSize, reason: "sizing row is stale" };
  const mult = row.kelly_mult;
  if (typeof mult !== "number" || !Number.isFinite(mult)) return { quantSize: null, size: currentSize, reason: "sizing row has no multiplier" };
  const m = Math.min(1, Math.max(0, mult));
  const w = Number.isFinite(weight) ? Math.max(0, weight) : 0;
  const quantSize = Math.max(0, Math.min(currentSize, HARD_MAX_COPY_TRADE_SOL, cfg.copyMaxTradeSol, cfg.copyBudgetSol * w * m));
  return { quantSize: Number(quantSize.toFixed(6)), size: Number(quantSize.toFixed(6)), reason: `kelly_mult ${m.toFixed(4)}` };
}

/** Applies the mode: returns the size to use and an optional log line for shadow/on. */
export function applyQuantSizing(
  db: DB,
  leader: string,
  currentSize: number,
  weight: number,
  cfg: { copyBudgetSol: number; copyMaxTradeSol: number },
  mode: QuantSizingMode = quantSizingMode(),
  nowSec = Math.floor(Date.now() / 1000),
): { size: number; log: string | null } {
  if (mode === "off") return { size: currentSize, log: null };
  let r: QuantSizeResult;
  try {
    r = quantClamp(currentSize, weight, cfg, readSizingParams(db, leader), nowSec);
  } catch {
    return { size: currentSize, log: null }; // quant data problems never block or change the normal path
  }
  const q = r.quantSize === null ? "n/a" : r.quantSize.toFixed(4);
  const log = `quant sizing (${mode}): real ${currentSize.toFixed(4)} SOL, quant ${q} SOL (${r.reason})`;
  return { size: mode === "on" ? Math.min(currentSize, r.size) : currentSize, log };
}

/** True if the skill gate is on and the job judged this leader's record to be luck. */
export function skillGateBlocks(db: DB, leader: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!quantSkillGateOn(env)) return false;
  try {
    return readWalletSkill(db, leader)?.verdict === "luck";
  } catch {
    return false;
  }
}
