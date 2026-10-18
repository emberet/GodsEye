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
import { nowIso, openDb, setMeta } from "@godseye/shared";
import { snapshotStoreConfigured } from "@godseye/shared/snapshot-store";
import { config } from "./config";
import { attachLogDb, say } from "./log";
import { runDiscovery } from "./discovery/discover";
import { runAnalysis } from "./analysis/analyze";
import { currentLeaders, runLearning } from "./learning/loop";
import { CopyEngine, isPaused } from "./copy/engine";
import { PaperExecutor, RealExecutor } from "./copy/executor";
import { LeaderWatcher } from "./copy/watcher";
import { loadOrCreateWallet } from "./wallet/wallet";
import { publishSnapshot } from "./publish/snapshot";
import { LiveStream, streamConfigured } from "./stream/stream";
import { initSolPrices, refreshHourlySolPrices, refreshLiveSolPrice } from "./market/solprice";

const db = openDb();
attachLogDb(db);

const { keypair, created } = loadOrCreateWallet(db);
const engine = new CopyEngine(db, config.copyMode === "real" ? new RealExecutor(keypair) : new PaperExecutor(), keypair.publicKey);
const watcher = new LeaderWatcher(db, engine);
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
const positions = () =>
  job("positions", async () => {
    heartbeat();
    await refreshLiveSolPrice();
    await engine.managePositions();
  });
const poll = () => job("leader poll", () => watcher.poll(), false);

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

  for (const [name, expr] of Object.entries({ DISCOVER_CRON: config.discoverCron, ANALYZE_CRON: config.analyzeCron, LEARN_CRON: config.learnCron, POSITION_CRON: config.positionCron })) {
    if (!cron.validate(expr)) throw new Error(`${name}="${expr}" in .env is not a valid schedule`);
  }
  const opts = { timezone: "UTC" };
  cron.schedule(config.positionCron, positions, opts);
  cron.schedule(config.analyzeCron, analyze, opts);
  cron.schedule(config.learnCron, learn, opts);
  cron.schedule(config.discoverCron, discover, opts);
  setInterval(poll, Math.max(5, config.pollSeconds) * 1000);
  cron.schedule("7 */3 * * *", () => void refreshHourlySolPrices(db), opts);
  // SOL's price history must be loaded before any USDC/USDT-priced swap can be valued.
  await initSolPrices(db);
  if (live) {
    live.start();
    cron.schedule("17 3 * * *", () => live.prune(), opts);
  }

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
  heartbeat("stopped");
  db.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await main();
