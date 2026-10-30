/**
 * `npm run strategy` — which exit and sizing rules would have made copying pay?
 *
 * Replays the learning loop's ranked candidates (wallets that pass every gate) under many exit rule sets, on the
 * same price tapes, counting only buys of coins the rug screen would let through (learning/copyable.ts): what the
 * copy engine could actually have bought. The first and second halves of the window are scored apart, so a rule
 * that only wins in one half shows it.
 *
 *   npm run strategy                     ranked candidates, 14 days
 *   --days 14  --wallets 150  --json
 *
 * Read-only. See replay/model.ts for what the replay does and doesn't model.
 */
import { openDbReadonly } from "@godseye/shared";
import { config } from "../config";
import { DEFAULT_PARAMS, type Episode, MAX_PLAUSIBLE_RETURN_PCT, median, type ReplayParams, simulateMint } from "../replay/model";
import { loadBooks, rankedCandidates, runRule, scoreRule } from "../replay/sweep";
import { replayDelaySec } from "../smart/copy-check";

const args = process.argv.slice(2);
const flag = (name: string, fallback: number): number => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};
const days = flag("days", 14);

const db = openDbReadonly();
const delay = replayDelaySec(db);
const wallets = rankedCandidates(db, flag("wallets", 150));
const data = loadBooks(db, wallets, days);
const { books, since, endT, mid, loadSec } = data;

const base: ReplayParams = {
  ...DEFAULT_PARAMS, delaySec: delay, sizeSol: config.copyMaxTradeSol, minLeaderBuySol: config.minLeaderBuySol,
  stopLossPct: config.stopLossPct, takeProfitPct: config.takeProfitPct, maxHoldHours: config.maxHoldHours,
};
const sets: { name: string; p: Partial<ReplayParams> }[] = [{ name: "current", p: {} }];
for (const sl of [15, 25, 35, 50, 1000]) for (const tp of [30, 60, 100, 300]) sets.push({ name: `sl${sl} tp${tp}`, p: { stopLossPct: sl, takeProfitPct: tp } });
for (const sl of [25, 35, 50]) for (const [arm, trail] of [[20, 15], [30, 20], [50, 25], [100, 30]]) {
  sets.push({ name: `sl${sl} trail${trail}@${arm}`, p: { stopLossPct: sl, takeProfitPct: 1000, trailArmPct: arm, trailStopPct: trail } });
  sets.push({ name: `sl${sl} half@${arm} trail${trail}@${arm}`, p: { stopLossPct: sl, takeProfitPct: 1000, trailArmPct: arm, trailStopPct: trail, partialTpPct: arm, partialTpFraction: 0.5 } });
}
for (const s of [...sets]) if (s.name === "current" || s.name.startsWith("sl35 trail20@30")) {
  sets.push({ name: `${s.name} cool30`, p: { ...s.p, reentryCooldownMin: 30 } });
  sets.push({ name: `${s.name} check15s`, p: { ...s.p, checkEverySec: 15 } });
}
for (const h of [1, 4, 12]) sets.push({ name: `current hold${h}h`, p: { maxHoldHours: h } });

const score = (name: string, eps: Episode[]) => scoreRule(name, eps, mid);
const runSet = (p: ReplayParams): Episode[] => runRule(data, p);

const rows = sets.map((s) => score(s.name, runSet({ ...base, ...s.p })));

// Sizing: does the leader's conviction (buy size vs its usual) say anything about the copy's return? (current exits)
const cur = books.flatMap((b) => simulateMint(b.tape, b.mint, b.swaps, endT, base).filter((e) => e.entryT >= since && e.retPct <= MAX_PLAUSIBLE_RETURN_PCT).map((e) => ({ e, c: b.conviction.get(e.entrySignature) ?? 1 })));
const buckets = [[0, 0.5], [0.5, 1], [1, 2], [2, 4], [4, Infinity]].map(([lo, hi]) => {
  const xs = cur.filter((x) => x.c >= lo && x.c < hi).map((x) => x.e);
  return { conviction: `${lo}–${hi === Infinity ? "∞" : hi}× usual`, ...score("", xs) };
});

// Learning power: does what copying a wallet earned in the first half predict the second half? (best rule set's exits)
const best = sets.find((s) => s.name === rows.slice().sort((a, b) => b.trimmedMeanPct - a.trimmedMeanPct)[0].name)!;
const bestP = { ...base, ...best.p };
const perWallet = new Map<string, { a: number[]; b: number[] }>();
for (const bk of books) {
  const w = perWallet.get(bk.wallet) ?? perWallet.set(bk.wallet, { a: [], b: [] }).get(bk.wallet)!;
  for (const e of simulateMint(bk.tape, bk.mint, bk.swaps, endT, bestP)) if (e.entryT >= since && e.retPct <= MAX_PLAUSIBLE_RETURN_PCT) (e.entryT < mid ? w.a : w.b).push(e.retPct);
}
const pairs = [...perWallet.entries()].filter(([, v]) => v.a.length >= 5 && v.b.length >= 5).map(([wallet, v]) => ({ wallet, a: median(v.a)!, b: median(v.b)!, nb: v.b.length, meanB: v.b.reduce((s, x) => s + x, 0) / v.b.length }));
const rank = (xs: number[]) => { const o = xs.map((x, i) => [x, i]).sort((p, q) => p[0] - q[0]); const r = new Array(xs.length); o.forEach(([, i], k) => (r[i] = k)); return r as number[]; };
const spearman = (xs: number[], ys: number[]) => {
  const [rx, ry] = [rank(xs), rank(ys)]; const n = xs.length; const mx = (n - 1) / 2;
  const cov = rx.reduce((s, r, i) => s + (r - mx) * (ry[i] - mx), 0); const v = rx.reduce((s, r) => s + (r - mx) ** 2, 0);
  return n > 2 ? cov / v : null;
};
const sortedA = pairs.slice().sort((p, q) => q.a - p.a);
const third = Math.max(1, Math.floor(sortedA.length / 3));
const tierB = (xs: typeof pairs) => ({ wallets: xs.length, medianOfMediansB: median(xs.map((x) => x.b)), tradesB: xs.reduce((s, x) => s + x.nb, 0) });
const learning = {
  rule: best.name, walletsWithBothHalves: pairs.length, spearmanFirstVsSecond: spearman(pairs.map((p) => p.a), pairs.map((p) => p.b)),
  topThirdByFirstHalf: tierB(sortedA.slice(0, third)), middleThird: tierB(sortedA.slice(third, 2 * third)), bottomThird: tierB(sortedA.slice(2 * third)),
};
// More leaders: do wallets further down the ranking (by 7-day profit, as the learning loop ranks) still copy well?
const order = new Map(wallets.map((w, i) => [w, i]));
const byRank = [[0, 10], [10, 20], [20, 40], [40, 80], [80, 1000]].map(([lo, hi]) => {
  const eps = books.filter((b) => (order.get(b.wallet) ?? 0) >= lo && (order.get(b.wallet) ?? 0) < hi).flatMap((b) => simulateMint(b.tape, b.mint, b.swaps, endT, bestP).filter((e) => e.entryT >= since && e.retPct <= MAX_PLAUSIBLE_RETURN_PCT));
  return { ranks: `${lo + 1}–${hi}`, ...score("", eps) };
});

const out = { learning, byRank, days, delaySec: delay, wallets: wallets.length, coins: books.length, loadSec, rows: rows.sort((a, b) => b.trimmedMeanPct - a.trimmedMeanPct), conviction: buckets };
if (args.includes("--json")) console.log(JSON.stringify(out, null, 1));
else {
  console.log(`${out.wallets} wallets, ${out.coins} wallet-coin books, delay ${delay}s, ${days} days (loaded in ${loadSec.toFixed(0)}s)`);
  const f = (x: number | null, d = 1) => (x === null ? "—" : x.toFixed(d));
  console.log("rule set".padEnd(34), "n", "win%", "median%", "mean%", "trim%", "SOL", "1st½", "2nd½");
  for (const r of out.rows) console.log(r.name.padEnd(34), r.n, f((100 * r.wins) / (r.n || 1), 0), f(r.medianPct), f(r.meanPct), f(r.trimmedMeanPct), f(r.pnlSol, 2), f(r.firstHalfSol, 2), f(r.secondHalfSol, 2));
  console.log("\nconviction (current exits)");
  for (const b of buckets) console.log(b.conviction.padEnd(16), b.n, f((100 * b.wins) / (b.n || 1), 0), f(b.medianPct), f(b.trimmedMeanPct), f(b.pnlSol, 2));
  console.log("\nlearning", JSON.stringify(learning));
  for (const b of byRank) console.log(`ranks ${b.ranks}`.padEnd(16), b.n, f((100 * b.wins) / (b.n || 1), 0), f(b.medianPct), f(b.trimmedMeanPct), f(b.pnlSol, 2));
}
db.close();
