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
import { monitorEventLoopDelay } from "node:perf_hooks";
import cron from "node-cron";
import { getMeta, nowIso, openDb, setMeta } from "@godseye/shared";
import { snapshotStoreConfigured } from "@godseye/shared/snapshot-store";
import { config } from "./config";
import { rpcUsage } from "./chain/rpc-budget";
import { attachLogDb, say } from "./log";
import { runDiscovery } from "./discovery/discover";
import { recomputeAllStats, runAnalysis } from "./analysis/analyze";
import { backfillClosedTradesStep } from "./analysis/closed-trades";
import { archiveSwapsStep, checkpointWal, dataPath, pruneHistory } from "@godseye/shared";
import { copyCandidates, currentLeaders, runLearning } from "./learning/loop";
import { refreshCopyable } from "./learning/copyable";
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
import { createJobRunner, type JobOpts } from "./jobs";
import { initSolPrices, refreshHourlySolPrices, refreshLiveSolPrice, solUsdAt } from "./market/solprice";

/** Bump when the P&L rules change so stored stats are recomputed once at startup. */
const STATS_VERSION = "bot-signs-1";

const db = openDb();
logSlowSql(db);
attachLogDb(db);

const { keypair, created } = loadOrCreateWallet(db);
const shadow = config.shadowEnabled ? new ShadowLogger(db) : null;
const realExecutor = config.copyMode === "real" ? new RealExecutor(keypair) : null;
const engine = new CopyEngine(db, realExecutor ?? new PaperExecutor(), keypair.publicKey, shadow);
// Once at start: empty token accounts left by earlier sells still hold ~0.002 SOL of rent each. Take it back.
if (realExecutor)
  void realExecutor
    .reclaimRent()
    .then((sol) => sol > 0 && say("info", `Closed empty token accounts: ${sol.toFixed(4)} SOL of rent back in the wallet.`))
    .catch((e) => say("warn", `Couldn't close empty token accounts: ${(e as Error).message.slice(0, 160)}`));
// A websocket per leader on the copy RPC as well as the stream: if the stream is down (its provider refuses
// the token or the IP), leaders' trades still arrive within a second or two. Duplicates are dropped.
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

/**
 * Logs any SQLite statement that takes 500 ms or more (each one at most every 10 minutes): better-sqlite3 is
 * synchronous, so a slow statement holds up everything else, copies included.
 */
function logSlowSql(d: typeof db): void {
  const lastLogged = new Map<string, number>();
  const prepare = d.prepare.bind(d);
  d.prepare = ((sql: string) => {
    const st = prepare(sql);
    for (const m of ["run", "get", "all"] as const) {
      const call = (st[m] as (...a: unknown[]) => unknown).bind(st);
      (st as unknown as Record<string, unknown>)[m] = (...args: unknown[]) => {
        const t0 = performance.now();
        try {
          return call(...args);
        } finally {
          const ms = performance.now() - t0;
          if (ms >= 500 && Date.now() - (lastLogged.get(sql) ?? 0) > 600_000) {
            lastLogged.set(sql, Date.now());
            say("warn", `Slow SQL (${Math.round(ms)} ms, jobs running: ${[...running].join(", ") || "none"}): ${sql.replace(/\s+/g, " ").trim().slice(0, 220)}`);
          }
        }
      };
    }
    return st;
  }) as typeof d.prepare;
}

/** Runs a job unless the previous run of the same job is still going (agent/src/jobs.ts). */
const runner = createJobRunner({ warn: (m) => say("warn", m), error: (m) => say("error", m) });
/** Jobs that cannot trade: a hung run is abandoned after this long so the schedule resumes. */
const NON_TRADING: JobOpts = { maxRuntimeMs: 30 * 60_000, releaseAfterMaxRuntime: true };
/** Jobs that can trade: warn when a run is this long, never start a second copy. */
const TRADING: JobOpts = { maxRuntimeMs: 10 * 60_000, releaseAfterMaxRuntime: false };
/** Jobs holding a slot right now (read by the event-loop and slow-SQL logs). */
const running = { [Symbol.iterator]: () => runner.names()[Symbol.iterator]() };
async function job(name: string, fn: () => Promise<void>, publish = true, opts: JobOpts = NON_TRADING): Promise<void> {
  const ran = await runner.run(name, fn, opts);
  if (ran && publish) await publishSnapshot(db);
}

const discover = () =>
  job("discovery", async () => {
    await runDiscovery(db);
    live?.refreshTracked();
  });
const analyze = () => job("analysis", async () => void (await runAnalysis(db)));
const learn = () =>
  job("learning", async () => {
    await refreshCopyable(db, copyCandidates(db));
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
  }, true, TRADING);
const poll = () => job("leader poll", () => watcher.poll(), false, TRADING);
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
  // A stall of 2 s or more is logged with the jobs that were running: one of them held the loop (copies wait meanwhile).
  let tickAt = Date.now();
  setInterval(() => {
    const now = Date.now();
    const late = now - tickAt - 1000;
    if (late >= 2000) say("warn", `Event loop blocked for ${(late / 1000).toFixed(1)} s (jobs running: ${[...running].join(", ") || "none"}).`);
    tickAt = now;
  }, 1000).unref();
  // Every 5 min: how long work waited for the event loop (a leader's trade waits the same) and the agent's CPU.
  const loop = monitorEventLoopDelay({ resolution: 10 });
  loop.enable();
  let cpuAt = { t: Date.now(), u: process.cpuUsage() };
  every("*/5 * * * *", () => {
    const now = Date.now();
    const u = process.cpuUsage(cpuAt.u);
    const ms = (n: number) => Math.round(n / 1e5) / 10;
    const m = { p50: ms(loop.percentile(50)), p99: ms(loop.percentile(99)), max: ms(loop.max), cpuPct: Math.round(((u.user + u.system) / 1000 / (now - cpuAt.t)) * 100), parser: config.streamParser, at: nowIso() };
    setMeta(db, "event_loop", JSON.stringify(m));
    if (new Date(now).getUTCMinutes() < 5) say("info", `Event loop, last 5 min: work waited ${m.p50} ms typically, ${m.p99} ms at worst 1%, ${m.max} ms max; agent CPU ${m.cpuPct}% (stream parser: ${m.parser}).`);
    loop.reset();
    cpuAt = { t: now, u: process.cpuUsage() };
  });
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

  // Hourly: move raw swaps past the hot window into compressed daily files (shared/src/archive.ts), a small slice at a
  // time with pauses between, so copies never wait on it.
  if (config.swapsHotDays > 0) every(config.archiveCron, () => void job("archive", async () => {
    const started = Date.now();
    let rows = 0;
    for (;;) {
      const step = archiveSwapsStep(db, { dir: dataPath("archive"), hotDays: config.swapsHotDays, junkHotDays: config.swapsJunkHotDays, batch: 2000 });
      rows += step.rows;
      if (step.done || Date.now() - started > 20 * 60_000) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    checkpointWal(db);
    if (rows) say("info", `Archive: moved ${rows.toLocaleString("en-US")} swaps older than ${config.swapsHotDays} days (${config.swapsJunkHotDays} for junk wallets) into compressed daily files.`);
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
