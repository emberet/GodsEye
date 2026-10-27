/** Reads the audit trail back: how decisions went, how the log-only gate would have judged them, and why a wallet or a trade went the way it did. */
import type { DB } from "@godseye/shared";
import { wilson } from "../shadow/labels";
import { loadRows, type Row } from "../shadow/report";
import { auditTablesExist } from "./schema";
import type { DecisionCheck } from "./decisions";
import type { GateResult } from "./gate";

interface DecisionRow {
  id: number;
  ts: string;
  leader: string;
  leader_signature: string;
  leader_ts: string;
  mint: string;
  symbol: string | null;
  mode: string;
  outcome: string;
  weight: number | null;
  leader_sol: number | null;
  leader_price_sol: number | null;
  lateness_sec: number | null;
  size_sol: number | null;
  checks: string;
  rug: string | null;
  wallet_eval_id: number | null;
  gate: string | null;
  gate_status: string;
  copy_trade_id: number | null;
}

type GateJson = GateResult | { skipped: string } | { error: string };
const parseGate = (g: string | null): GateJson | null => {
  try {
    return g ? (JSON.parse(g) as GateJson) : null;
  } catch {
    return null;
  }
};
const isResult = (g: GateJson | null): g is GateResult => !!g && "checks" in g;

const count = (xs: string[]): Record<string, number> => {
  const o: Record<string, number> = {};
  for (const x of xs) o[x] = (o[x] ?? 0) + 1;
  return o;
};
const kv = (o: Record<string, number>) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(" · ") || "—";
const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const f1 = (x: number | null, unit = "") => (x === null ? "—" : `${x.toFixed(1)}${unit}`);

export interface Tally {
  n: number;
  settled: number;
  collapse50: number;
  rugLike: number;
}

export interface AuditReport {
  since: string;
  decisions: number;
  byOutcome: Record<string, number>;
  failedChecks: Record<string, number>;
  gate: {
    byStatus: Record<string, number>;
    wouldBlock: number;
    wouldPass: number;
    incomplete: number;
    byReason: Record<string, number>;
    median: { impactPct: number | null; driftPct: number | null; roundTripLossPct: number | null; exitCapacitySol: number | null; ms: number | null; ageSec: number | null };
  };
  /** Gate verdicts against what those tokens did next, from the shadow log (empty when there is no settled outcome yet). */
  calibration: { group: string; tally: Tally }[];
  wallets: { byState: Record<string, number>; byGate: Record<string, number>; changes: number; evaluations: number };
}

const tally = (rows: Row[]): Tally => {
  const settled = rows.filter((r) => r.labels.hourSettled);
  return { n: rows.length, settled: settled.length, collapse50: settled.filter((r) => r.labels.collapse50).length, rugLike: settled.filter((r) => r.labels.rugLike).length };
};

export function buildAuditReport(db: DB, sinceMs: number): AuditReport {
  const since = new Date(sinceMs).toISOString();
  const empty: AuditReport = {
    since, decisions: 0, byOutcome: {}, failedChecks: {},
    gate: { byStatus: {}, wouldBlock: 0, wouldPass: 0, incomplete: 0, byReason: {}, median: { impactPct: null, driftPct: null, roundTripLossPct: null, exitCapacitySol: null, ms: null, ageSec: null } },
    calibration: [], wallets: { byState: {}, byGate: {}, changes: 0, evaluations: 0 },
  };
  if (!auditTablesExist(db)) return empty;
  const ds = db.prepare("SELECT * FROM copy_decisions WHERE ts >= ? ORDER BY id").all(since) as DecisionRow[];
  const failedChecks: string[] = [];
  const results: { d: DecisionRow; g: GateResult }[] = [];
  for (const d of ds) {
    for (const c of JSON.parse(d.checks) as DecisionCheck[]) if (c.result === "fail" || c.result === "error") failedChecks.push(c.check);
    const g = parseGate(d.gate);
    if (isResult(g)) results.push({ d, g });
  }
  const gs = results.map((r) => r.g);
  const out: AuditReport = {
    ...empty,
    decisions: ds.length,
    byOutcome: count(ds.map((d) => d.outcome)),
    failedChecks: count(failedChecks),
    gate: {
      byStatus: count(ds.map((d) => (d.gate_status === "skipped" ? `skipped (${(parseGate(d.gate) as { skipped?: string } | null)?.skipped ?? "not run"})` : d.gate_status))),
      wouldBlock: gs.filter((g) => g.wouldBlock).length,
      wouldPass: gs.filter((g) => !g.wouldBlock).length,
      incomplete: gs.filter((g) => g.status === "incomplete").length,
      byReason: count(gs.flatMap((g) => g.checks.filter((c) => c.result === "fail").map((c) => c.check))),
      median: {
        impactPct: median(gs.flatMap((g) => (g.priceImpactPct === null ? [] : [g.priceImpactPct]))),
        driftPct: median(gs.flatMap((g) => (g.driftPct === null ? [] : [g.driftPct]))),
        roundTripLossPct: median(gs.flatMap((g) => (g.roundTripLossPct === null ? [] : [g.roundTripLossPct]))),
        exitCapacitySol: median(gs.flatMap((g) => (g.exitCapacitySol == null ? [] : [g.exitCapacitySol]))),
        ms: median(gs.map((g) => g.ms)),
        ageSec: median(gs.flatMap((g) => (g.ageSec === null ? [] : [g.ageSec]))),
      },
    },
  };

  // Gate verdicts against outcomes, by token (the shadow log follows each token's first leader buy).
  try {
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'shadow_candidates'").get()) {
      const shadow = new Map(loadRows(db, since).map((r) => [r.c.mint, r]));
      const firstByMint = new Map<string, { d: DecisionRow; g: GateResult }>();
      for (const r of results) if (!firstByMint.has(r.d.mint)) firstByMint.set(r.d.mint, r);
      const joined = [...firstByMint.values()].flatMap((r) => (shadow.has(r.d.mint) ? [{ ...r, s: shadow.get(r.d.mint)! }] : []));
      const groups: [string, Row[]][] = [
        ["gate would block", joined.filter((j) => j.g.wouldBlock).map((j) => j.s)],
        ["gate would pass", joined.filter((j) => !j.g.wouldBlock).map((j) => j.s)],
      ];
      for (const name of ["buy_quote", "sell_quote", "price_impact", "entry_drift", "round_trip", "exit_capacity", "fees"]) {
        groups.push([`${name} failed`, joined.filter((j) => j.g.checks.some((c) => c.check === name && c.result === "fail")).map((j) => j.s)]);
        groups.push([`${name} passed`, joined.filter((j) => j.g.checks.some((c) => c.check === name && c.result === "pass")).map((j) => j.s)]);
      }
      out.calibration = groups.filter(([, rows]) => rows.length).map(([group, rows]) => ({ group, tally: tally(rows) }));
    }
  } catch {
    /* no shadow outcomes yet */
  }

  const evals = db.prepare("SELECT state, gate, changed FROM wallet_evaluations WHERE id IN (SELECT MAX(id) FROM wallet_evaluations GROUP BY wallet)").all() as { state: string; gate: string }[];
  const inRange = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(changed), 0) c FROM wallet_evaluations WHERE ts >= ?").get(since) as { n: number; c: number };
  out.wallets = { byState: count(evals.map((e) => e.state)), byGate: count(evals.map((e) => e.gate)), changes: inRange.c, evaluations: inRange.n };
  return out;
}

const share = (k: number, n: number) => {
  if (!n) return "—";
  const w = wilson(k, n)!;
  return `${Math.round((100 * k) / n)}% (${k}/${n}, ${Math.round(100 * w.lo)}–${Math.round(100 * w.hi)})`;
};

export function formatAuditReport(r: AuditReport): string {
  const out: string[] = [`AUDIT TRAIL since ${r.since.slice(0, 16).replace("T", " ")} UTC`];
  if (!r.decisions && !r.wallets.evaluations) return `${out[0]}\nNothing recorded yet: both logs fill while the agent runs (wallet evaluations after each learning run, decisions as leaders buy).`;
  out.push("", `COPY DECISIONS: ${r.decisions}`, `  outcomes:        ${kv(r.byOutcome)}`, `  checks that failed: ${kv(r.failedChecks)}`);
  const g = r.gate;
  out.push(
    "",
    "COPYABILITY GATE (log-only: it changed no decision)",
    `  runs:            ${kv(g.byStatus)}`,
    `  would have blocked ${g.wouldBlock} · passed ${g.wouldPass} (of which ${g.incomplete} had a quote missing)`,
    `  limits that failed: ${kv(g.byReason)}`,
    `  medians:         price impact ${f1(g.median.impactPct, "%")} · drift from the leader's price ${f1(g.median.driftPct, "%")} · buy-then-sell loss ${f1(g.median.roundTripLossPct, "%")} · sellable into the pool before a fall ${f1(g.median.exitCapacitySol, " SOL")} · quote time ${g.median.ms === null ? "—" : `${Math.round(g.median.ms)} ms`} · quoted ${f1(g.median.ageSec, " s")} after the leader`,
  );
  if (r.calibration.length) {
    out.push("", "GATE AGAINST WHAT THE TOKENS DID (shadow log, settled = first hour passed; interval is 95% Wilson)");
    out.push(["group".padEnd(24), "tokens".padStart(6), "settled".padStart(7), "fell ≥50% in 1 h".padStart(26), "rug-like".padStart(26)].join(" "));
    for (const c of r.calibration) out.push([c.group.padEnd(24), String(c.tally.n).padStart(6), String(c.tally.settled).padStart(7), share(c.tally.collapse50, c.tally.settled).padStart(26), share(c.tally.rugLike, c.tally.settled).padStart(26)].join(" "));
  } else out.push("", "GATE AGAINST WHAT THE TOKENS DID: nothing settled yet (needs the shadow log's one-hour marks).");
  out.push(
    "",
    `WALLETS (latest evaluation of each): ${kv(r.wallets.byState)}`,
    `  deciding rule:   ${kv(r.wallets.byGate)}`,
    `  in this period:  ${r.wallets.evaluations} evaluations written, ${r.wallets.changes} because something changed`,
    "",
    "state is provisional (taken from the weight rules only). Gate limits are first guesses, to be set from the table above. Leader-bought tokens are selected, so rates are not for all launches.",
  );
  return out.join("\n");
}

/** One wallet's evaluations, oldest first. */
export function explainWallet(db: DB, address: string, limit = 20): string {
  if (!auditTablesExist(db)) return "No audit trail yet.";
  const rows = db.prepare("SELECT * FROM wallet_evaluations WHERE wallet = ? ORDER BY id DESC LIMIT ?").all(address, limit) as Record<string, any>[];
  if (!rows.length) return `No evaluations recorded for ${address}.`;
  const out = [`${address}: ${rows.length} most recent evaluations (newest last)`];
  for (const r of [...rows].reverse()) {
    out.push("", `${r.ts.slice(0, 16).replace("T", " ")}  ${String(r.state).toUpperCase()}  rule: ${r.gate}  tier: ${r.tier}  weight: ${(r.weight * 100).toFixed(1)}%${r.changed ? "" : "  (daily record, unchanged)"}`);
    out.push(`  ${r.weight_reason ?? ""}`);
    for (const e of JSON.parse(r.evidence_for)) out.push(`  + ${e}`);
    for (const e of JSON.parse(r.evidence_against)) out.push(`  − ${e}`);
    const dq = r.data_quality ? JSON.parse(r.data_quality) : null;
    if (dq) out.push(`  history: ${dq.windowDays ?? "?"} days seen, ${dq.historyComplete === false ? "older history not read" : dq.historyComplete ? "complete" : "completeness unknown"}`);
    out.push(`  would change with: ${r.reassess}`);
  }
  return out.join("\n");
}

/** Decisions on a leader's signature or a token, newest first. */
export function explainDecision(db: DB, ref: string, limit = 5): string {
  if (!auditTablesExist(db)) return "No audit trail yet.";
  const rows = db.prepare("SELECT * FROM copy_decisions WHERE leader_signature = ? OR mint = ? ORDER BY id DESC LIMIT ?").all(ref, ref, limit) as DecisionRow[];
  if (!rows.length) return `No decision recorded for ${ref}.`;
  const out: string[] = [];
  for (const d of rows) {
    out.push(`${d.ts.slice(0, 19).replace("T", " ")}  ${d.symbol ?? d.mint.slice(0, 6)}  leader ${d.leader.slice(0, 6)}…  ${d.leader_sol?.toFixed(2) ?? "?"} SOL at ${d.leader_price_sol ?? "?"}  weight ${d.weight === null ? "?" : `${(d.weight * 100).toFixed(1)}%`}  ->  ${d.outcome.toUpperCase()} (${d.mode})`);
    for (const c of JSON.parse(d.checks) as DecisionCheck[]) out.push(`  ${c.result === "pass" ? "✓" : c.result === "fail" ? "✗" : c.result === "error" ? "!" : "·"} ${c.check}${c.detail ? `: ${c.detail}` : ""}`);
    const g = parseGate(d.gate);
    if (isResult(g)) {
      out.push(`  gate (log-only): ${g.wouldBlock ? "WOULD BLOCK" : "would pass"} at ${g.sizeSol} SOL, quoted ${g.ageSec === null ? "?" : `${g.ageSec.toFixed(0)} s`} after the leader via ${g.route ?? "?"}`);
      for (const c of g.checks) out.push(`    ${c.result === "pass" ? "✓" : c.result === "fail" ? "✗" : "·"} ${c.check}${c.value === null ? "" : ` ${c.value.toFixed(2)}`}${c.limit === null ? "" : ` (limit ${c.limit})`}${c.detail ? ` ${c.detail}` : ""}`);
    } else out.push(`  gate: ${d.gate_status}${g ? ` — ${JSON.stringify(g)}` : ""}`);
    out.push("");
  }
  return out.join("\n").trimEnd();
}
