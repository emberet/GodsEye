/** Reads the shadow log back: how much was logged, how complete the follow-up is, and how each kind of token fared. */
import type { DB } from "@godseye/shared";
import { config } from "../config";
import { HORIZONS_SEC } from "./sampler";
import { labelOutcome, type Labels, type SamplePoint, wilson } from "./labels";

export interface CandidateRow {
  id: number;
  mint: string;
  symbol: string | null;
  seen_at: string;
  entry_price_usd: number | null;
  sim_size_sol: number | null;
  token_age_sec: number | null;
  copy_outcome: string | null;
  screen_status: string;
  screen_ms: number | null;
  chain_ms: number | null;
  rugcheck_ms: number | null;
  holders_ms: number | null;
  verdict: string | null;
  mint_authority: string | null;
  freeze_authority: string | null;
  rugcheck_ok: number | null;
  rugcheck_score: number | null;
  rugcheck_pools: number | null;
  lp_locked_pct: number | null;
  top10_pct: number | null;
  launch_bundle_pct: number | null;
  cluster_pct: number | null;
  cluster_size: number | null;
  cluster_from_creator: number | null;
  insider_pct: number | null;
}

interface SampleRow {
  candidate_id: number;
  horizon_sec: number;
  status: "ok" | "no_price" | "missed";
  price_usd: number | null;
  liquidity_usd: number | null;
  sell_quote_sol: number | null;
  sell_quote_error: string | null;
  rugcheck_ok: number | null;
  rugcheck_pools: number | null;
}

export interface Row {
  c: CandidateRow;
  samples: SampleRow[];
  labels: Labels;
}

export interface GroupStats {
  group: string;
  /** Candidates in the group, and how many have their first hour settled. */
  n: number;
  settled: number;
  collapse50: number;
  collapse90: number;
  rugLike: number;
  neverPriced: number;
}

export interface Report {
  since: string;
  total: number;
  byCopyOutcome: Record<string, number>;
  byScreenStatus: Record<string, number>;
  byVerdict: Record<string, number>;
  coverage: { horizonSec: number; ok: number; noPrice: number; missed: number; notYetDue: number }[];
  latencyMs: { screen: number | null; chain: number | null; rugcheck: number | null; holders: number | null; screenP90: number | null };
  /** Share of candidates for which RugCheck had a report: when screened, and again 1 and 5 minutes later. */
  rugcheckFilledIn: { atScreen: number | null; at60s: number | null; at300s: number | null; withPoolsAt300s: number | null };
  byVerdictOutcome: GroupStats[];
  byRule: { rule: string; over: GroupStats; under: GroupStats; unknown: GroupStats }[];
}

const countBy = (xs: Row[], key: (r: Row) => string): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const r of xs) out[key(r)] = (out[key(r)] ?? 0) + 1;
  return out;
};

function quantile(xs: number[], q: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}

function stats(group: string, rows: Row[]): GroupStats {
  const settled = rows.filter((r) => r.labels.hourSettled);
  return {
    group,
    n: rows.length,
    settled: settled.length,
    collapse50: settled.filter((r) => r.labels.collapse50).length,
    collapse90: settled.filter((r) => r.labels.collapse90).length,
    rugLike: settled.filter((r) => r.labels.rugLike).length,
    neverPriced: settled.filter((r) => r.labels.neverPriced).length,
  };
}

export function loadRows(db: DB, sinceIso: string): Row[] {
  const cands = db.prepare("SELECT * FROM shadow_candidates WHERE seen_at >= ? ORDER BY seen_at").all(sinceIso) as CandidateRow[];
  const samples = db.prepare("SELECT * FROM shadow_samples WHERE candidate_id IN (SELECT id FROM shadow_candidates WHERE seen_at >= ?)").all(sinceIso) as SampleRow[];
  const by = new Map<number, SampleRow[]>();
  for (const s of samples) (by.get(s.candidate_id) ?? by.set(s.candidate_id, []).get(s.candidate_id)!).push(s);
  return cands.map((c) => {
    const ss = by.get(c.id) ?? [];
    const points: SamplePoint[] = ss.map((s) => ({ horizonSec: s.horizon_sec, status: s.status, priceUsd: s.price_usd, liquidityUsd: s.liquidity_usd, sellQuoteSol: s.sell_quote_sol, sellQuoteError: s.sell_quote_error }));
    return { c, samples: ss, labels: labelOutcome(c.entry_price_usd, c.sim_size_sol, points) };
  });
}

/** The screen's cutoffs as they are now, each as "which side is this candidate on" (null = the input is missing). */
export function rules(): { rule: string; over: (c: CandidateRow) => boolean | null }[] {
  const num = (v: number | null, test: (x: number) => boolean) => (v === null ? null : test(v));
  return [
    { rule: `top-10 holders > ${config.top10MaxPct}%`, over: (c) => num(c.top10_pct, (x) => x > config.top10MaxPct) },
    { rule: `launch bundle > ${config.bundleMaxPct}%`, over: (c) => num(c.launch_bundle_pct, (x) => x > config.bundleMaxPct) },
    { rule: `linked holders > ${config.clusterMaxPct}%`, over: (c) => (c.cluster_size === null ? null : (c.cluster_size >= 2 || c.cluster_from_creator === 1) && (c.cluster_pct ?? 0) > config.clusterMaxPct) },
    { rule: `RugCheck insider network > ${config.insiderMaxPct}%`, over: (c) => num(c.insider_pct, (x) => x > config.insiderMaxPct) },
    { rule: `locked liquidity < ${config.lpMinLockedPct}%`, over: (c) => num(c.lp_locked_pct, (x) => x < config.lpMinLockedPct) },
    { rule: `RugCheck score ≥ ${config.rugMaxRiskScore}`, over: (c) => num(c.rugcheck_score, (x) => x >= config.rugMaxRiskScore) },
    { rule: "mint authority set", over: (c) => (c.screen_status === "chain_unreadable" || c.rugcheck_ok === null ? null : c.mint_authority !== null) },
    { rule: "freeze authority set", over: (c) => (c.screen_status === "chain_unreadable" || c.rugcheck_ok === null ? null : c.freeze_authority !== null) },
    { rule: "token younger than 5 min at the leader's buy", over: (c) => num(c.token_age_sec, (x) => x < 300) },
  ];
}

export function buildReport(db: DB, sinceMs = 0, now = Date.now()): Report {
  const since = new Date(sinceMs).toISOString();
  const rows = loadRows(db, since);
  const at = (r: Row, h: number) => r.samples.find((s) => s.horizon_sec === h);
  const frac = (num: number, den: number) => (den ? num / den : null);
  const withSample = (h: number) => rows.filter((r) => at(r, h) && at(r, h)!.status !== "missed" && at(r, h)!.rugcheck_ok !== null);
  const screened = rows.filter((r) => r.c.rugcheck_ok !== null);
  const at300 = withSample(300);
  const med = (xs: (number | null)[]) => quantile(xs.filter((x): x is number => x !== null), 0.5);
  return {
    since,
    total: rows.length,
    byCopyOutcome: countBy(rows, (r) => r.c.copy_outcome ?? "undecided"),
    byScreenStatus: countBy(rows, (r) => r.c.screen_status),
    byVerdict: countBy(rows, (r) => r.c.verdict ?? "none"),
    coverage: HORIZONS_SEC.map((h) => {
      const taken = rows.flatMap((r) => (at(r, h) ? [at(r, h)!] : []));
      return {
        horizonSec: h,
        ok: taken.filter((s) => s.status === "ok").length,
        noPrice: taken.filter((s) => s.status === "no_price").length,
        missed: taken.filter((s) => s.status === "missed").length,
        notYetDue: rows.filter((r) => !at(r, h) && now < Date.parse(r.c.seen_at) + h * 1000).length,
      };
    }),
    latencyMs: {
      screen: med(rows.map((r) => r.c.screen_ms)),
      chain: med(rows.map((r) => r.c.chain_ms)),
      rugcheck: med(rows.map((r) => r.c.rugcheck_ms)),
      holders: med(rows.map((r) => r.c.holders_ms)),
      screenP90: quantile(rows.flatMap((r) => (r.c.screen_ms === null ? [] : [r.c.screen_ms])), 0.9),
    },
    rugcheckFilledIn: {
      atScreen: frac(screened.filter((r) => r.c.rugcheck_ok === 1).length, screened.length),
      at60s: frac(withSample(60).filter((r) => at(r, 60)!.rugcheck_ok === 1).length, withSample(60).length),
      at300s: frac(at300.filter((r) => at(r, 300)!.rugcheck_ok === 1).length, at300.length),
      withPoolsAt300s: frac(at300.filter((r) => (at(r, 300)!.rugcheck_pools ?? 0) > 0).length, at300.length),
    },
    byVerdictOutcome: ["pass", "blocked", "none"].map((v) => stats(v === "none" ? "no verdict (screen incomplete)" : v, rows.filter((r) => (r.c.verdict ?? "none") === v))),
    byRule: rules().map(({ rule, over }) => ({
      rule,
      over: stats("over", rows.filter((r) => over(r.c) === true)),
      under: stats("under", rows.filter((r) => over(r.c) === false)),
      unknown: stats("unknown", rows.filter((r) => over(r.c) === null)),
    })),
  };
}

const horizonName = (s: number) => (s < 3600 ? `${s / 60} min` : `${s / 3600} h`);
const share = (k: number, n: number) => {
  if (!n) return "—";
  const w = wilson(k, n)!;
  return `${Math.round((100 * k) / n)}% (${k}/${n}, ${Math.round(100 * w.lo)}–${Math.round(100 * w.hi)})`;
};
const pctOrDash = (x: number | null) => (x === null ? "—" : `${Math.round(x * 100)}%`);
const ms = (x: number | null) => (x === null ? "—" : x >= 1000 ? `${(x / 1000).toFixed(1)} s` : `${Math.round(x)} ms`);
const kv = (o: Record<string, number>) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(" · ") || "—";

export function formatReport(r: Report): string {
  const out: string[] = [];
  out.push(`SHADOW LOG since ${r.since.slice(0, 16).replace("T", " ")} UTC — ${r.total} tokens logged`);
  if (!r.total) return `${out[0]}\nNothing logged yet: the log fills while the agent runs (SHADOW_ENABLED=true), one row per token a leader buys.`;
  out.push(`  what the copy engine did:  ${kv(r.byCopyOutcome)}`);
  out.push(`  rug screen:                ${kv(r.byScreenStatus)}`);
  out.push(`  verdicts:                  ${kv(r.byVerdict)}`);
  out.push(`  screen time (median):      ${ms(r.latencyMs.screen)} (p90 ${ms(r.latencyMs.screenP90)}) — Solana mint ${ms(r.latencyMs.chain)} · RugCheck ${ms(r.latencyMs.rugcheck)} · holders ${ms(r.latencyMs.holders)}`);
  out.push(`  RugCheck had a report:     when screened ${pctOrDash(r.rugcheckFilledIn.atScreen)} · +1 min ${pctOrDash(r.rugcheckFilledIn.at60s)} · +5 min ${pctOrDash(r.rugcheckFilledIn.at300s)} (with pool data ${pctOrDash(r.rugcheckFilledIn.withPoolsAt300s)})`);
  out.push("", "FOLLOW-UP COVERAGE (a token nobody quotes is recorded as 'no price', not dropped)");
  out.push(["after", "priced", "no price", "missed", "not due yet"].map((h, i) => (i ? h.padStart(11) : h.padEnd(8))).join(" "));
  for (const c of r.coverage) out.push([horizonName(c.horizonSec).padEnd(8), ...[c.ok, c.noPrice, c.missed, c.notYetDue].map((x) => String(x).padStart(11))].join(" "));

  const table = (title: string, rows: GroupStats[]) => {
    out.push("", title);
    out.push(["group".padEnd(34), "tokens".padStart(6), "settled".padStart(7), "fell ≥50% in 1 h".padStart(26), "fell ≥90% in 1 h".padStart(26), "rug-like".padStart(26), "never priced".padStart(26)].join(" "));
    for (const g of rows) out.push([g.group.padEnd(34), String(g.n).padStart(6), String(g.settled).padStart(7), ...[g.collapse50, g.collapse90, g.rugLike, g.neverPriced].map((k) => share(k, g.settled).padStart(26))].join(" "));
  };
  table("OUTCOME BY SCREEN VERDICT (settled = the 1-hour mark has passed; interval is 95%, Wilson)", r.byVerdictOutcome);
  out.push("", "OUTCOME BY EACH CUTOFF, as set now (over = the screen would have blocked on it)");
  for (const x of r.byRule) {
    if (x.over.n + x.under.n === 0) continue;
    out.push(`  ${x.rule}`);
    for (const g of [x.over, x.under, x.unknown]) if (g.n) out.push(`    ${g.group.padEnd(8)} ${String(g.n).padStart(4)} tokens · settled ${String(g.settled).padStart(4)} · fell ≥50% ${share(g.collapse50, g.settled).padEnd(22)} · rug-like ${share(g.rugLike, g.settled)}`);
  }
  out.push(
    "",
    "fell ≥50% / ≥90%: price, or what selling a copy-sized position would return, vs the leader's entry, within the first hour.",
    "rug-like: fell ≥90%, or a copy-sized sell would return <10% of its cost, or the sell route vanished, or pool liquidity fell ≥90%, or the token went unpriced after being priced.",
    "RugCheck 'had a report' counts a failed or rate-limited request as none. never priced = unknown, not survived and not rugged. Leader-bought tokens are selected, so rates are for tokens leaders buy, not for all launches. Cutoffs here are today's; each row also stores the cutoffs it was screened with.",
  );
  return out.join("\n");
}
