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
import { alert, channelNote } from "./alerts";
import { runDiscovery } from "./discovery/discover";
import { recomputeAllStats, runAnalysis } from "./analysis/analyze";
import { backfillClosedTradesStep } from "./analysis/closed-trades";
import { archiveSwapsStep, checkpointWal, dataPath, pruneHistory } from "@godseye/shared";
import { copyCandidates, currentLeaders, runLearning } from "./learning/loop";
import { refreshCopyable } from "./learning/copyable";
import { CopyEngine, isPaused } from "./copy/engine";
import { PaperExecutor, RealExecutor } from "./copy/executor";
import { LeaderWatcher } from "./copy/watcher";
import { defineRunners, describeDefinition } from "./runners/define";
import { scoreCatchers } from "./runners/score";
import { xConfigured } from "./x/client";
import { checkXUsage } from "./x/usage";
import { BrainRuntime } from "./brain/runtime";
import { runSocialCollect } from "./social/collect";
import { labelWallets } from "./social/labels";
import { socialTablesExist } from "./social/schema";
import { runSocialScore } from "./social/score";
import { runXResearch } from "./x/calls";
import { loadOrCreateWallet, walletHoldings, walletTokenBalance } from "./wallet/wallet";
import { reconcile, recoverPending, settleMissing, settleSigned, sweepWallet } from "./copy/recovery";
import { walletChain } from "./copy/settle-chain";
import { publishSnapshot } from "./publish/snapshot";
import { LiveStream, streamConfigured } from "./stream/stream";
import { ShadowLogger } from "./shadow/log";
import { sampleDue } from "./shadow/sampler";
import { notBots, refreshCopyReplays } from "./smart/copy-check";
import { every } from "./schedule";
import { lockEnvFile, modeLine, openRealPositions, secretsFileNote, settingsReport, startupWarnings } from "./startup";
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
const runner = createJobRunner({
  warn: (m) => say("warn", m),
  error: (m) => say("error", m),
  stalled: (m) => void alert(db, "job_stalled", `A background job is stuck: ${m}`),
});
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
const chain = walletChain(keypair.publicKey);
let lastReconcile = 0;
let lastSweep = 0;
const positions = () =>
  job("positions", async () => {
    heartbeat();
    await refreshLiveSolPrice();
    setMeta(db, "sol_usd_now", solUsdAt(Date.now()) ?? "");
    // Trades left pending by an earlier run, or stuck for 10+ minutes in this one. Signed ones are settled from the
    // chain as soon as the engine lets them go.
    const cutoff = new Date(Date.now() - 10 * 60_000).toISOString();
    const before = cutoff < STARTED_AT ? STARTED_AT : cutoff;
    const settled = await settleSigned(db, chain, { before, held: heldTokens });
    const recovered = await recoverPending(db, { before, held: heldTokens });
    if (settled.bought + settled.sold + recovered.opened > 0) engine.positionsChanged();
    await engine.managePositions();
    // Every 5 minutes, after the exit checks so it never delays them: positions the wallet holds none of, and tokens
    // in the wallet that belong to no position. Both go by one reading of the wallet; with none, nothing is concluded.
    if (config.copyMode === "real" && Date.now() - lastSweep > 5 * 60_000) {
      lastSweep = Date.now();
      const holdings = await walletHoldings(keypair.publicKey).catch(() => null);
      if (holdings) {
        const missing = await settleMissing(db, chain, { held: async (mint) => holdings.get(mint) ?? 0 });
        const swept = await sweepWallet(db, chain, { holdings: async () => holdings });
        if (missing.sold + missing.closed + swept.opened + swept.reopened > 0) engine.positionsChanged();
      }
    }
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
  setMeta(db, "agent_started_at", STARTED_AT); // `npm run alert-check` gives the jobs their time after a start
  // The address stays out of the log; `npm run wallet` shows it to the owner.
  say("info", `Waking up.${created ? " A new wallet was just created — back up data/wallet/!" : ""}`);
  const mode = modeLine(config);
  say(mode.level, mode.message);
  // Console only (the owner's terminal, the server's journal), never the public feed: every limit and safety switch
  // in effect, what is switched off, and whether .env was open to other users.
  for (const line of [...settingsReport(config, isPaused(db)), ...startupWarnings(config, openRealPositions(db))]) console.log(line);
  console.log(`Owner alerts: ${channelNote(config)}`);
  const envNote = secretsFileNote(".env", lockEnvFile());
  if (envNote) console.warn(envNote);
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
    // Runner research (runners/): what counts as a runner, and who keeps catching them early. Shadow only: never copied.
    every("40 * * * *", () => void job("runner research", async () => {
      const def = defineRunners(db);
      const r = scoreCatchers(db);
      if (r.added) live.refreshTracked();
      say("learn", `Runner research: ${describeDefinition(def)}. ${r.wallets} wallets bought 2+ of them early, ${r.qualifying} beat the base rate (${(r.baseRate * 100).toFixed(2)}% of early buys are runners)${r.added ? `; ${r.added} added for shadow-only analysis` : ""}.`);
    }));
    // Who posts runners on X before they run (x/calls.ts): needs X_BEARER_TOKEN. Observation only.
    if (xConfigured()) every("50 * * * *", () => void job("x research", async () => {
      const line = await runXResearch(db);
      if (line) say("learn", line);
    }, false));
    // X's own count of the posts read, next to the agent's (x/usage.ts): the dollar budget rests on the agent's count.
    if (xConfigured()) every("5 3 * * *", () => void job("x usage", async () => void (await checkXUsage(db)), false));
    // The Brain (brain/): paper money only. Its paper accounts trade every streamed signal and pick up each model the Mac
    // pushes; nothing reaches the real engine, and the real pause doesn't stop them.
    if (config.brainMode !== "off") {
      const brain = new BrainRuntime(db);
      live.brain = brain;
      // Brain jobs log to the server console only (never say(): its inputs include the private social score).
      const quiet = (name: string, fn: () => Promise<void>) => () =>
        void job(name, () => fn().catch((e) => console.warn(`[brain] ${name} failed: ${(e as Error).message}`)), false);
      brain.start(); // the shadow-quote sampler: every second, under its own hard per-minute cap
      every("* * * * *", quiet("brain", () => brain.tick()));
      // The stream state's windows and creator lookups, the mirror ledger's deadlines and the ps / dd delayed jobs.
      every("* * * * *", quiet("brain ledgers", () => brain.tickLedgers()));
      every("25 4 * * *", quiet("brain prune", async () => brain.prune()));
      // The private social score (social/score.ts): hourly, from the model the Mac pushes; writes social_scores only when
      // that model passed its out-of-time test. The entry features read it (social_score / social_missing).
      every("10 * * * *", quiet("social score", async () => void (await runSocialScore(db))));
    }
    // The private social layer (social/): reads X for the analyzed wallets. Never shown anywhere, so nothing goes to say().
    if (xConfigured()) every("20 * * * *", () => void job("x2", async () => void (await runSocialCollect(db)), false));
    // Labels from the social layer (social/labels.ts): one private hint per wallet, never proof. Pure database work, so
    // it runs with X off too, and only once the collector has left something to label. Console only, never say().
    const labels = () =>
      void job("social labels", async () => {
        try {
          if (socialTablesExist(db)) labelWallets(db);
        } catch (e) {
          console.warn(`[social] labels failed: ${(e as Error).message}`);
        }
      }, false);
    every("30 * * * *", labels);
    labels();
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

let stopping = false;
async function shutdown() {
  // A second Ctrl-C (or signal) stops at once: anything still sent but unrecorded is settled from the chain at the next start.
  if (stopping) process.exit(1);
  stopping = true;
  live?.stop();
  say("info", "Stopping: no new trades; waiting for the ones under way.");
  const done = await engine.stop(60_000).catch(() => false);
  if (!done) say("warn", "Stopped with a trade still under way: it is settled from the chain at the next start.");
  say("info", "Stopped.");
  setMeta(db, "stream_status", "stopped");
  heartbeat("stopped");
  db.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

await main();
