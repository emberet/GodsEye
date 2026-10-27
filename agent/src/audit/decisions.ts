/**
 * COPY DECISIONS — for every leader buy GodsEye considered, what was checked, in order, and what came of it.
 *
 * The copy engine (copy/engine.ts) opens a trace when a leader's buy is big enough to be a candidate, adds each check it
 * runs and the rug verdict it consults, and closes it with the outcome: bought, failed, skipped (with the check that
 * stopped it) or ignored (e.g. a position in that token is already open). One row per leader trade in copy_decisions,
 * including the ones copy_trades throttles or never records. The copyability gate (gate.ts) runs beside it for the same
 * candidate, whatever the wallet balance, and its result is attached to the row when the quotes return.
 *
 * Observation only: nothing here changes what the engine does, and every failure is swallowed.
 */
import type { DB } from "@godseye/shared";
import { config } from "../config";
import type { ParsedSwap } from "../chain/parse";
import { copySize } from "../learning/weights";
import { latestEvaluationId } from "./evaluations";
import { CopyabilityGate, type GateRun } from "./gate";
import { ensureAuditTables } from "./schema";
import { auditSettings } from "./settings";

export interface DecisionCheck {
  check: string;
  result: "pass" | "fail" | "error" | "na";
  detail?: string;
}

interface Trace {
  swap: ParsedSwap;
  seenAt: number;
  weight: number;
  symbol: string | null;
  checks: DecisionCheck[];
  rug: unknown;
  gate: GateRun | { error: string } | null;
  gateStatus: "skipped" | "pending" | "done" | "error";
  rowId: number | null;
}

const key = (swap: ParsedSwap) => `${swap.signature}:${swap.mint}`;

export class DecisionAudit {
  private traces = new Map<string, Trace>();

  constructor(
    private db: DB,
    private gate: CopyabilityGate | null = null,
    private mode: () => string = () => config.copyMode,
  ) {
    ensureAuditTables(db);
  }

  /** A leader buy big enough to be a candidate. */
  begin(swap: ParsedSwap, seenAt: number, weight: number): void {
    this.traces.set(key(swap), { swap, seenAt, weight, symbol: null, checks: [], rug: null, gate: null, gateStatus: "skipped", rowId: null });
  }

  /** Not a candidate after all (e.g. not a memecoin): nothing is recorded. */
  discard(swap: ParsedSwap): void {
    this.traces.delete(key(swap));
  }

  check(swap: ParsedSwap, check: string, result: DecisionCheck["result"], detail?: string): void {
    this.traces.get(key(swap))?.checks.push({ check, result, ...(detail ? { detail } : {}) });
  }

  /** A buy of a real memecoin: note it and start the copyability gate at the size GodsEye would use. */
  candidate(swap: ParsedSwap, symbol: string): void {
    const t = this.traces.get(key(swap));
    if (!t) return;
    t.symbol = symbol;
    t.checks.push({ check: "memecoin", result: "pass" });
    if (!this.gate) return;
    t.gateStatus = "pending";
    const sizeSol = copySize(t.weight, config) || config.copyMinTradeSol;
    this.gate
      .run({ mint: swap.mint, sizeSol, leaderPriceSol: swap.priceSol, leaderTs: swap.ts })
      .then(
        (r) => {
          t.gate = r;
          t.gateStatus = "skipped" in r ? "skipped" : "done";
        },
        (e: Error) => {
          t.gate = { error: String(e.message).slice(0, 200) };
          t.gateStatus = "error";
        },
      )
      .then(() => this.attachGate(t));
  }

  /** The rug screen's answer (null = it couldn't be read). */
  rug(swap: ParsedSwap, v: { verdict: string; blocks: string[]; warnings: string[] } | null): void {
    const t = this.traces.get(key(swap));
    if (!t) return;
    t.rug = v;
    const result = !v ? "fail" : v.verdict === "blocked" ? "fail" : "pass";
    t.checks.push({ check: "rug_screen", result, detail: !v ? "couldn't verify the token on Solana" : v.blocks.join("; ") || undefined });
  }

  /** A check failed and the engine skipped the buy. */
  skipped(swap: ParsedSwap, skipKey: string, reason: string): void {
    const name = skipKey.split(":")[0];
    // The rug screen already added its own failing check.
    const t = this.traces.get(key(swap));
    if (t && !((name === "rug" || name === "unverified") && t.checks.some((c) => c.check === "rug_screen"))) t.checks.push({ check: name, result: "fail", detail: reason });
    this.finish(swap, `skipped:${name}`);
  }

  /** Closes the trace with its outcome and writes the row. The first call wins; later ones do nothing. */
  finish(swap: ParsedSwap, outcome: string, extra: { sizeSol?: number | null } = {}): void {
    const k = key(swap);
    const t = this.traces.get(k);
    if (!t) return;
    this.traces.delete(k);
    try {
      const copyTrade = this.db.prepare("SELECT id FROM copy_trades WHERE leader_signature = ? AND mint = ?").get(swap.signature, swap.mint) as { id: number } | undefined;
      const row = this.db
        .prepare(
          `INSERT OR IGNORE INTO copy_decisions
             (ts, leader, leader_signature, leader_ts, mint, symbol, mode, outcome, weight, leader_sol, leader_price_sol, lateness_sec, size_sol, checks, rug, wallet_eval_id, gate, gate_status, copy_trade_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          new Date().toISOString(), swap.wallet, swap.signature, swap.ts, swap.mint, t.symbol, this.mode(), outcome, t.weight, swap.solAmount, swap.priceSol,
          (t.seenAt - Date.parse(swap.ts)) / 1000, extra.sizeSol ?? null, JSON.stringify(t.checks), t.rug ? JSON.stringify(t.rug) : null,
          latestEvaluationId(this.db, swap.wallet), t.gate ? JSON.stringify(t.gate) : null, t.gateStatus, copyTrade?.id ?? null,
        );
      t.rowId = row.changes ? Number(row.lastInsertRowid) : null; // a gate result still on its way finds the row through t
    } catch (e) {
      console.warn(`Audit: couldn't record the decision on ${swap.mint}: ${(e as Error).message}`);
    }
  }

  /** Called when the engine is done with a leader buy: anything still open gets a row, so none is lost. */
  close(swap: ParsedSwap): void {
    this.finish(swap, "skipped:undecided");
  }

  private attachGate(t: Trace): void {
    if (t.rowId === null) return; // not written yet: finish() will include the result
    try {
      this.db.prepare("UPDATE copy_decisions SET gate = ?, gate_status = ? WHERE id = ?").run(t.gate ? JSON.stringify(t.gate) : null, t.gateStatus, t.rowId);
    } catch (e) {
      console.warn(`Audit: couldn't attach the gate result: ${(e as Error).message}`);
    }
  }
}

/** The audit as the engine uses it: on unless AUDIT_ENABLED=false, with the gate unless GATE_LOG_ENABLED=false. */
export function createDecisionAudit(db: DB): DecisionAudit | null {
  if (!auditSettings.auditEnabled) return null;
  return new DecisionAudit(db, auditSettings.gateEnabled ? new CopyabilityGate() : null);
}
