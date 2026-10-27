/**
 * `npm run replay` — what would copying each leader have earned at GodsEye's real delay?
 *
 *   npm run replay                          the wallets GodsEye copies now
 *   npm run replay -- <address> [...]       specific wallets
 *   npm run replay -- --top 30              the 30 wallets with the best 30-day profit
 *   --delays 1,2,5,15,30,60,120             seconds from the leader's swap to our fill
 *   --size 0.05                             SOL per copy (default COPY_MAX_TRADE_SOL)
 *   --fee-bps 100  --tx-cost 0.0005         DEX fee each way (bps) and per-transaction cost (SOL)
 *   --days 14  --until-days 7               leader trades from the last 14 days, but not the last 7 (the tape and exits still run to the end of the data)
 *   --depth 50                              pool depth (SOL) to assume everywhere instead of estimating it per token
 *   --json                                  machine-readable output
 *
 * Read-only: nothing is written to the database. See replay/model.ts for what is and isn't modelled.
 */
import { openDbReadonly } from "@godseye/shared";
import { config } from "../config";
import { DEFAULT_PARAMS, type ReplayParams } from "../replay/model";
import { calibration, dataEnd, pool, replayWallet, summarizeWallet, type WalletReplay } from "../replay/run";
import { formatTable } from "../replay/summary";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const num = (name: string, fallback: number): number => {
  const v = flag(name);
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`--${name} needs a number, got "${v}"`);
  return n;
};
const valueFlags = new Set(["delays", "size", "fee-bps", "tx-cost", "days", "until-days", "depth", "top"]);
const positional = args.filter((a, i) => !a.startsWith("--") && !valueFlags.has((args[i - 1] ?? "").replace(/^--/, "")));

const delays = (flag("delays") ?? "1,2,5,15,30,60,120").split(",").map(Number);
if (delays.some((d) => !Number.isFinite(d) || d < 0)) throw new Error("--delays needs a comma-separated list of seconds");
const params: Partial<ReplayParams> = {
  sizeSol: num("size", config.copyMaxTradeSol),
  feeBps: num("fee-bps", DEFAULT_PARAMS.feeBps),
  txCostSol: num("tx-cost", DEFAULT_PARAMS.txCostSol),
  fixedDepthSol: flag("depth") === undefined ? null : num("depth", 0),
  minLeaderBuySol: config.minLeaderBuySol,
  stopLossPct: config.stopLossPct,
  takeProfitPct: config.takeProfitPct,
  maxHoldHours: config.maxHoldHours,
};

const db = openDbReadonly();
const endT = dataEnd(db);
const sinceMs = endT - num("days", 14) * 86_400_000;
const untilMs = flag("until-days") === undefined ? undefined : endT - num("until-days", 0) * 86_400_000;

let wallets = positional;
if (!wallets.length) {
  const top = flag("top");
  wallets = (
    top
      ? db.prepare("SELECT wallet FROM wallet_stats WHERE closed_30d >= 5 ORDER BY COALESCE(pnl_30d_usd, 0) DESC LIMIT ?").all(Number(top)).map((r) => (r as { wallet: string }).wallet)
      : db.prepare("SELECT address FROM wallets WHERE copy_weight > 0 ORDER BY copy_weight DESC").all().map((r) => (r as { address: string }).address)
  ) as string[];
}
if (!wallets.length) {
  console.log("No wallets to replay: none is being copied right now. Pass addresses, or --top 30.");
  process.exit(0);
}

const results: WalletReplay[] = [];
for (const w of wallets) {
  const r = replayWallet(db, w, delays, params, { sinceMs, untilMs, endT });
  results.push(r);
  if (!args.includes("--json")) {
    const tier = (db.prepare("SELECT tier FROM wallets WHERE address = ?").get(w) as { tier: string } | undefined)?.tier ?? "not in database";
    console.log(`\n${w}  (${tier})  ${r.ideal.length} positions${r.implausible ? ` (${r.implausible} left out: a return above 1,000×, a pricing error)` : ""}`);
    console.log(r.ideal.length ? formatTable(summarizeWallet(r)) : "  no copyable buys in this period");
  }
}
const pooled = pool(results, delays);
const cal = calibration(db);

if (args.includes("--json")) {
  console.log(JSON.stringify({ params: { ...DEFAULT_PARAMS, ...params }, endsAt: new Date(endT).toISOString(), pooled, wallets: results.map((r) => ({ wallet: r.wallet, implausible: r.implausible, summaries: summarizeWallet(r) })), calibration: cal }, null, 2));
} else {
  console.log(`\nALL ${wallets.length} WALLETS TOGETHER`);
  console.log(formatTable(pooled));
  console.log(
    `\nSize ${(params.sizeSol as number).toFixed(3)} SOL per copy · DEX fee ${params.feeBps} bps each way · ${params.txCostSol} SOL per transaction · leader trades ${new Date(sinceMs).toISOString().slice(0, 10)} to ${new Date(untilMs ?? endT).toISOString().slice(0, 10)} · pool depth ${params.fixedDepthSol === null ? "estimated per token" : `${params.fixedDepthSol} SOL everywhere`}.`,
  );
  console.log(
    cal.n
      ? `Real copies so far: ${cal.n} · median delay ${cal.medianLatencySec?.toFixed(1) ?? "—"}s · median entry ${cal.medianDriftPct?.toFixed(1) ?? "—"}% above the leader · median fee ${cal.medianFeeSol?.toFixed(5) ?? "—"} SOL. Set --delays, --fee-bps and --tx-cost from these.`
      : "No real copies yet, so the delay and costs above are assumptions, not measurements.",
  );
  console.log("leader ret = the same positions at the leader's own fills; copy cost = leader ret − mean ret (percentage points); drift = our entry price vs the leader's;");
  console.log("tape = share of entries where other wallets' swaps were stored nearby. Low tape means delay costs are understated. top1/top3 above 100% = the rest of the positions lost money.");
  console.log("Block times are whole seconds, so delays under about 2 s aren't resolved. Rug checks and GodsEye's limits are not replayed. Wallets picked for their profit in this same period look better than they will next: test on trades after the pick (--until-days).");
}
db.close();
