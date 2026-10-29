/**
 * ╔══════════════════════════════════════════╗
 * ║  GodsEye — the main agent loop            ║
 * ╚══════════════════════════════════════════╝
 * `npm run agent` starts everything (schedules in UTC, all set in .env):
 *   live          gRPC stream of every DEX swap (GRPC_URL): live wallet book,
 *                 promotion of profitable wallets, instant leader copies
 *   live          watch leaders' transactions and copy their swaps
 *   every 30 s    poll leaders (safety net for the live feed)    LEADER_POLL_SECONDS
 *   every minute  price positions, exit on stop/take/max hold    POSITION_CRON
 *   every 10 min  analyze wallets: P&L, tier, AI or human        ANALYZE_CRON
 *   every 15 min  learning loop: re-weight who to copy           LEARN_CRON
 *   every 30 min  discover new wallets in the busiest pools      DISCOVER_CRON
 */
import cron from "node-cron";
import { getMeta, nowIso, openDb, setMeta } from "@godseye/shared";
import { snapshotStoreConfigured } from "@godseye/shared/snapshot-store";
import { config } from "./config";
import { rpcUsage } from "./chain/rpc-budget";
import { attachLogDb, say } from "./log";
import { runDiscovery } from "./discovery/discover";
import { recomputeAllStats, runAnalysis } from "./analysis/analyze";
import { backfillClosedTradesStep } from "./analysis/closed-trades";
import { checkpointWal, pruneHistory } from "@godseye/shared";
import { copyCandidates, currentLeaders, runLearning } from "./learning/loop";
import { CopyEngine, isPaused } from "./copy/engine";
import { PaperExecutor, RealExecutor } from "./copy/executor";
import { LeaderWatcher } from "./copy/watcher";
import { loadOrCreateWallet, walletTokenBalance } from "./wallet/wallet";
import { reconcile, recoverPending } from "./copy/recovery";
import { publishSnapshot } from "./publish/snapshot";
import { LiveStream, streamConfigured } from "./stream/stream";
import { ShadowLogger } from "./shadow/log";
import { sampleDue } from "./shadow/sampler";
import { notBots, refreshCopyReplays } from "./smart/copy-check";
import { every } from "./schedule";
import { initSolPrices, refreshHourlySolPrices, refreshLiveSolPrice, solUsdAt } from "./market/solprice";

/** Bump when the P&L rules change so stored stats are recomputed once at startup. */
const STATS_VERSION = "bot-signs-1";

const db = openDb();
attachLogDb(db);

const { keypair, created } = loadOrCreateWallet(db);
const shadow = config.shadowEnabled ? new ShadowLogger(db) : null;
const engine = new CopyEngine(db, config.copyMode === "real" ? new RealExecutor(keypair) : new PaperExecutor(), keypair.publicKey, shadow);
// With the gRPC stream on, leaders' swaps arrive on it and the poll is the safety net: no websocket per leader.
const watcher = new LeaderWatcher(db, engine, { logs: !streamConfigured() });
const live = streamConfigured() ? new LiveStream(db, watcher) : null;

function heartbeat(status = "live"): void {
  setMeta(db, "heartbeat", nowIso());
  setMeta(db, "agent_status", status);
  setMeta(db, "copy_mode", config.copyMode);
  setMeta(db, "copy_paused_effective", isPaused(db) ? "1" : "0");
  setMeta(db, "max_positions", config.maxPositions);
  setMeta(db, "copy_budget_sol", config.copyBudgetSol);
  setMeta(db, "stream_enabled", live ? "1" : "0");
}

/** Runs a job unless the previous run of the same job is still going. */
const running = new Set<string>();
async function job(name: string, fn: () => Promise<void>, publish = true): Promise<void> {
  if (running.has(name)) return;
  running.add(name);
  try {
    await fn();
  } catch (e) {
    say("error", `${name} failed: ${(e as Error).message}`);
  } finally {
    running.delete(name);
  }
  if (publish) await publishSnapshot(db);
}

const discover = () =>
  job("discovery", async () => {
    await runDiscovery(db);
    live?.refreshTracked();
  });
const analyze = () => job("analysis", async () => void (await runAnalysis(db)));
const learn = () =>
  job("learning", async () => {
    const leaders = runLearning(db);
    await watcher.sync(leaders);
  });
const STARTED_AT = nowIso();
const heldTokens = (mint: string) => walletTokenBalance(keypair.publicKey, mint);
let lastReconcile = 0;
const positions = () =>
  job("positions", async () => {
    heartbeat();
    await refreshLiveSolPrice();
    setMeta(db, "sol_usd_now", solUsdAt(Date.now()) ?? "");
    // Trades left pending by an earlier run, or stuck for 10+ minutes in this one.
    const cutoff = new Date(Date.now() - 10 * 60_000).toISOString();
    await recoverPending(db, { before: cutoff < STARTED_AT ? STARTED_AT : cutoff, held: heldTokens });
    await engine.managePositions();
    if (config.copyMode === "real" && Date.now() - lastReconcile > 30 * 60_000) {
      lastReconcile = Date.now();
      await reconcile(db, heldTokens);
    }
  });
const poll = () => job("leader poll", () => watcher.poll(), false);
/** Price, liquidity and a sell quote for the tokens the shadow log is following (shadow/sampler.ts). */
const followShadow = () => job("shadow log", async () => void (await sampleDue(db)), false);

/** closed_trades backfill: 300 ms slices with 700 ms between them, so the event loop stays free for copies. */
function backfillInBackground(totals = { wallets: 0, trades: 0 }): void {
  try {
    const b = backfillClosedTradesStep(db, config.earlyBuySeconds, 300);
    totals.wallets += b.wallets;
    totals.trades += b.trades;
    if (!b.done) return void setTimeout(() => backfillInBackground(totals), 700).unref();
    if (totals.wallets) say("info", `Backfilled ${totals.trades.toLocaleString("en-US")} closed trades for ${totals.wallets.toLocaleString("en-US")} wallets.`);
  } catch (e) {
    say("error", `closed_trades backfill failed (retrying in a minute): ${(e as Error).message}`);
    setTimeout(() => backfillInBackground(totals), 60_000).unref();
  }
}

const BANNER = `
     .-""""-.
    /  .--.  \\       GodsEye
   |  ( () )  |      Sees every wallet. Copies the winners.
    \\  '--'  /       copy mode: ${config.copyMode.toUpperCase()}
     '-....-'
`;

async function main() {
  console.log(BANNER);
  heartbeat();
  say("info", `Waking up. Agent wallet ${keypair.publicKey.toBase58()}${created ? " (just created — back up data/wallet/!)" : ""}.`);
  if (config.copyMode === "real") {
    say("warn", `COPY_MODE=real — copy trades spend REAL SOL: up to ${config.copyMaxTradeSol} SOL per trade, ${config.copyBudgetSol} SOL in total, stop for the day after ${config.dailyLossLimitSol} SOL of losses. Pause any time with "npm run pause".`);
  } else say("info", "COPY_MODE=paper — copy trades are simulated with live Jupiter quotes. No real funds move.");
  if (!config.heliusApiKey && !config.solanaRpcUrl) say("warn", "TODO: add HELIUS_API_KEY (or SOLANA_RPC_URL) to .env. The public Solana RPC is slow, rate-limited and often refuses the history reads analysis needs.");
  if (!live) say("info", "TODO: set GRPC_URL + GRPC_TOKEN in .env (Shyft, Triton, Helius or QuickNode gRPC) to watch every DEX swap live. Sampling busy pools meanwhile.");
  if (snapshotStoreConfigured()) say("info", "Publishing dashboard data to Turso after every job (for the hosted website).");

  for (const [name, expr] of Object.entries({ DISCOVER_CRON: config.discoverCron, ANALYZE_CRON: config.analyzeCron, LEARN_CRON: config.learnCron, POSITION_CRON: config.positionCron, PRUNE_CRON: config.pruneCron })) {
    if (!cron.validate(expr)) throw new Error(`${name}="${expr}" in .env is not a valid schedule`);
  }
  every(config.positionCron, positions);
  if (shadow) every("* * * * *", followShadow);
  every(config.analyzeCron, analyze);
  every(config.learnCron, learn);
  every(config.discoverCron, discover);
  setInterval(poll, Math.max(5, config.pollSeconds) * 1000);
  every("7 */3 * * *", () => void refreshHourlySolPrices(db));
  // SOL's price history must be loaded before any USDC/USDT-priced swap can be valued.
  await initSolPrices(db);
  // After a P&L rule change, refresh every wallet's stats once from stored swaps — no network needed.
  // Once: history coverage used to start at the oldest signature listed, but Shyft only returns transactions
  // ~2-3 days old, so older ones gave no swaps. Start each wallet's coverage at its oldest stored swap instead.
  if (getMeta(db, "history_from_fix") !== "1") {
    const n = db
      .prepare(
        `UPDATE wallets SET history_from = (SELECT MIN(ts) FROM wallet_swaps s WHERE s.wallet = wallets.address)
          WHERE last_analyzed_at IS NOT NULL
            AND history_from < (SELECT MIN(ts) FROM wallet_swaps s WHERE s.wallet = wallets.address)`,
      )
      .run().changes;
    setMeta(db, "history_from_fix", "1");
    if (n) say("info", `Corrected how far back ${n.toLocaleString("en-US")} wallets' history really reaches (the RPC doesn't return transactions older than ~2-3 days).`);
  }
  // Once: materialise every stored round trip into closed_trades (kept up to date by analysis after that),
  // in the background: on a big database it takes an hour, and copying must not wait for it.
  backfillInBackground();

  if (getMeta(db, "stats_version") !== STATS_VERSION) {
    say("info", `Recomputed P&L (USD at settlement) for ${recomputeAllStats(db)} wallets.`);
    setMeta(db, "stats_version", STATS_VERSION);
  }
  // Once an hour: what reading wallet history actually cost in RPC requests.
  every("0 * * * *", () => {
    const u = rpcUsage(60);
    if (u.calls) say("info", `RPC for wallet history, last hour: ${u.calls.toLocaleString("en-US")} requests, ${u.avgPerSec.toFixed(1)}/sec on average, busiest minute ${u.peakPerSec.toFixed(1)}/sec (cap ${config.rpcMaxRps}/sec)${u.throttled ? `; the RPC rate-limited ${u.throttled.toLocaleString("en-US")} of them — lower RPC_MAX_RPS` : "; no rate limiting"}.`);
  });
  if (live) {
    // Smart money: who counts (every 5 min) and what their trades did next (every 5 min).
    live.smart.refresh();
    every("*/5 * * * *", () => void job("smart money", async () => {
      const n = live.smart.evaluate();
      live.smart.refresh();
      if (n) say("learn", `Smart money: measured ${n} price moves after smart trades and signals.`);
    }));
    // Copy gate: replay what copying each smart-money candidate would have earned, a slice at a time.
    const replays = () => job("copy replay", async () => {
      // Smart-money candidates and the wallets the weight rules would copy (both are gated on the replay).
      const wallets = [...new Set([...live.smart.candidates().keys(), ...copyCandidates(db)])];
      const n = await refreshCopyReplays(db, notBots(db, wallets), { budgetMs: 60_000 });
      if (n) live.smart.refresh();
    }, false);
    every("2-59/5 * * * *", () => void replays());
    void replays();
    live.start();
  }
  // Daily SQLite housekeeping: retention pruning of raw swaps and stale stream activity, then a WAL checkpoint.
  every(config.pruneCron, () => void job("housekeeping", async () => {
    const p = pruneHistory(db, { swapsDays: config.swapsRetentionDays, activityDays: config.activityRetentionDays });
    checkpointWal(db);
    if (p.swaps || p.activity) say("info", `Housekeeping: pruned ${p.swaps.toLocaleString("en-US")} swaps older than ${config.swapsRetentionDays} days and ${p.activity.toLocaleString("en-US")} stale live-activity rows.`);
  }, false));

  // Resume copying whoever the last learning run picked, then get the pipeline going.
  await watcher.sync(currentLeaders(db));
  say("learn", `Watching ${watcher.watching.length} leader wallet${watcher.watching.length === 1 ? "" : "s"} live.`);
  await positions();
  await discover();
  await analyze();
  await learn();
}

function shutdown() {
  say("info", "Stopped.");
  live?.stop();
  setMeta(db, "stream_status", "stopped");
  heartbeat("stopped");
  db.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await main();
