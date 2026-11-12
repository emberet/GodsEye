/**
 * What the agent says about its own settings when it starts.
 *   - modeLine goes to the public feed: the mode and the three limits it has always shown, nothing more.
 *   - Everything else is for the console only (the owner's terminal, the server's journal): every safety switch and
 *     limit as it is in effect, and the warnings. Thresholds, file names and research switches stay off the feed.
 */
import path from "node:path";
import { type DB, type OwnerOnly, ownerOnly, repoRoot } from "@godseye/shared";
import type { Config } from "./config";

/** The start line about money on the public feed. */
export function modeLine(c: Config): { level: "info" | "warn"; message: string } {
  if (c.copyMode !== "real") return { level: "info", message: "COPY_MODE=paper — copy trades are simulated with live Jupiter quotes. No real funds move." };
  if (c.riskGovernor)
    return {
      level: "warn",
      message: `COPY_MODE=real — copy trades spend REAL SOL, sized from what it holds: ${c.riskStartTradePct}% a trade to start (never over ${c.riskMaxTradePct}%), stop for the day ${c.riskDailyStopPct}% down, pause itself ${c.riskDrawdownPausePct}% below its high. Pause any time with "npm run pause".`,
    };
  return {
    level: "warn",
    message: `COPY_MODE=real — copy trades spend REAL SOL: up to ${c.copyMaxTradeSol} SOL per trade, ${c.copyBudgetSol} SOL in total, stop for the day after ${c.dailyLossLimitSol} SOL of losses. Pause any time with "npm run pause".`,
  };
}

/**
 * Every safety switch and limit in effect, under its .env name, so a line can be checked against .env.
 * These are the values the agent runs with: defaults filled in, the hard cap on trade size applied.
 */
export function settingsReport(c: Config, paused: boolean): string[] {
  const row = (title: string, pairs: Record<string, string | number | boolean>) =>
    `  ${title.padEnd(12)}${Object.entries(pairs).map(([name, value]) => `${name}=${value}`).join("  ")}`;
  // Under the risk governor a fixed limit that isn't in .env isn't used: the governor sets it.
  const governed = c.copyMode === "real" && c.riskGovernor;
  const fixed = (inEnv: boolean, value: number) => (governed && !inEnv ? "(set by the governor)" : value);
  return [
    `Settings in effect${paused ? " (PAUSED: no new buys)" : ""}:`,
    row("mode", { COPY_MODE: c.copyMode, BRAIN_MODE: c.brainMode }),
    row("size", {
      COPY_MIN_TRADE_SOL: c.copyMinTradeSol,
      COPY_MAX_TRADE_SOL: fixed(c.fixedInEnv.maxTrade, c.copyMaxTradeSol),
      COPY_BUDGET_SOL: fixed(c.fixedInEnv.budget, c.copyBudgetSol),
      COPY_MAX_POSITIONS: c.maxPositions,
      WALLET_RESERVE_SOL: c.walletReserveSol,
    }),
    row("risk", {
      RISK_GOVERNOR: c.riskGovernor,
      RISK_START_TRADE_PCT: c.riskStartTradePct,
      RISK_MIN_TRADE_PCT: c.riskMinTradePct,
      RISK_MAX_TRADE_PCT: c.riskMaxTradePct,
      RISK_DAILY_STOP_PCT: c.riskDailyStopPct,
      RISK_DRAWDOWN_PAUSE_PCT: c.riskDrawdownPausePct,
      RISK_MIN_TRADE_SOL: c.riskMinTradeSol,
      RISK_MIN_EQUITY_SOL: c.riskMinEquitySol,
      FUNDING_OUTFLOW_PAUSE_SOL: c.fundingOutflowPauseSol,
    }),
    row("stops", {
      COPY_DAILY_LOSS_LIMIT_SOL: fixed(c.fixedInEnv.dailyLoss, c.dailyLossLimitSol),
      COPY_STOP_LOSS_PCT: c.stopLossPct,
      COPY_TAKE_PROFIT_PCT: c.takeProfitPct,
      COPY_MAX_HOLD_HOURS: c.maxHoldHours,
    }),
    row("entry", {
      MIN_LEADER_BUY_SOL: c.minLeaderBuySol,
      COPY_MAX_DELAY_SECONDS: c.maxCopyDelaySeconds,
      COPY_BRAIN_GATES: c.copyBrainGates,
      COPY_SLIPPAGE_BPS: c.slippageBps,
      COPY_MAX_PRICE_IMPACT_PCT: c.maxPriceImpactPct,
      COPY_PUMPSWAP_MIGRATED_ONLY: c.pumpswapMigratedOnly,
      COPY_EXIT_MAX_SLIPPAGE_BPS: c.exitMaxSlippageBps,
      PRIORITY_FEE_MAX_LAMPORTS: c.priorityFeeMaxLamports,
      COPY_SEND_VIA: c.sendVia,
      JITO_TIP_LAMPORTS: c.jitoTipLamports,
    }),
    row("leaders", {
      COPY_MAX_LEADERS: c.maxLeaders,
      COPY_MAX_LEADER_SHARE: c.maxLeaderShare,
      COPY_MIN_COPYABLE_SHARE: c.minCopyableShare,
      COPY_LOSS_DROP_SOL: c.copyLossDropSol,
    }),
    row("rug screen", {
      RUG_CHECK_ENABLED: c.rugCheckEnabled,
      RUG_BLOCK_MINT_AUTHORITY: c.rugBlockMintAuthority,
      RUG_MAX_RISK_SCORE: c.rugMaxRiskScore,
      RUG_REQUIRE_RUGCHECK: c.rugRequireRugcheck,
      RUG_MAX_TRANSFER_FEE_BPS: c.rugMaxTransferFeeBps,
      LP_MIN_LOCKED_PCT: c.lpMinLockedPct,
      LP_CONCENTRATED_POOLS: c.lpConcentratedPools,
      RUG_ALLOWLIST: `${c.rugAllowlist.length} coin(s)`,
    }),
    row("holders", {
      HOLDER_CHECK_ENABLED: c.holderCheckEnabled,
      BUNDLE_MAX_PCT: c.bundleMaxPct,
      CLUSTER_MAX_PCT: c.clusterMaxPct,
      TOP10_MAX_PCT: c.top10MaxPct,
      INSIDER_MAX_PCT: c.insiderMaxPct,
    }),
    // The payout wallet: whether it is filled in, never what it holds.
    row("creator", { CREATOR_REWARDS: c.creatorRewards, CREATOR_TRADING_SHARE: c.creatorTradingShare, CREATOR_PAYOUT_WALLET: c.creatorPayoutWallet ? "set" : "empty", CREATOR_MINT: c.creatorMint ? "set" : "empty", CREATOR_MIN_CLAIM_SOL: c.creatorMinClaimSol }),
    row("brain", { BRAIN_MODE: c.brainMode, REAL_DECIDER: c.realDecider, BRAIN_SLEEVE_MAX_DELAY_SECONDS: c.brainSleeveMaxDelaySeconds }),
    row("research", { SHADOW_ENABLED: c.shadowEnabled, QUANT_SIZING: c.quantSizing, QUANT_SKILL_GATE: c.quantSkillGate, SOCIAL_WARNING: c.socialWarning }),
    // Whether each is filled in, never what it holds.
    row("alerts", { TELEGRAM_BOT_TOKEN: c.telegramBotToken ? "set" : "empty", TELEGRAM_CHAT_ID: c.telegramChatId ? "set" : "empty" }),
  ];
}

/** The safety checks that are switched off, one line each (none when all are on). */
export function safetyOff(c: Config): string[] {
  const off: string[] = [];
  if (!c.rugCheckEnabled) off.push("RUG_CHECK_ENABLED is off: coins are bought without the rug screen.");
  if (!c.rugBlockMintAuthority) off.push("RUG_BLOCK_MINT_AUTHORITY is off: coins whose maker can still mint more are allowed.");
  if (c.lpMinLockedPct <= 0) off.push("LP_MIN_LOCKED_PCT is 0: coins are bought whether or not their liquidity is locked.");
  if (c.lpConcentratedPools === "warn") off.push("LP_CONCENTRATED_POOLS=warn: concentrated-liquidity pools are left out of the locked-liquidity figure.");
  if (c.rugAllowlist.length) off.push(`RUG_ALLOWLIST: ${c.rugAllowlist.length} coin(s) skip the rug screen.`);
  if (!c.holderCheckEnabled) off.push("HOLDER_CHECK_ENABLED is off: bundled and clustered supply is not checked before a buy.");
  if (!c.copyBrainGates) off.push("COPY_BRAIN_GATES is off: the Brain's hard gates are not part of the copy screen.");
  return off;
}

/** Under the governor: the fixed limits written in .env, which cap what it decides (one line, or none). */
export function ceilingsNote(c: Config): string | null {
  if (c.copyMode !== "real" || !c.riskGovernor) return null;
  const set = [
    c.fixedInEnv.maxTrade && `COPY_MAX_TRADE_SOL=${c.copyMaxTradeSol}`,
    c.fixedInEnv.budget && `COPY_BUDGET_SOL=${c.copyBudgetSol}`,
    c.fixedInEnv.dailyLoss && `COPY_DAILY_LOSS_LIMIT_SOL=${c.dailyLossLimitSol}`,
  ].filter(Boolean);
  return set.length ? `ℹ️  Ceilings on top of the risk governor (from .env): ${set.join("  ")}. Take a line out of .env to let the wallet decide.` : null;
}

/** Open positions that were bought with real SOL. */
export function openRealPositions(db: DB): number {
  return (db.prepare("SELECT COUNT(*) n FROM positions WHERE status = 'open' AND mode = 'real'").get() as { n: number }).n;
}

/**
 * What the owner should see before anything else: a safety check that is off, and real positions left open under
 * paper mode (the engine only works on positions of its own mode, so nothing would watch or sell them).
 */
export function startupWarnings(c: Config, openReal: number): string[] {
  const out: string[] = [];
  const off = safetyOff(c);
  if (off.length) out.push(`⚠️  ${c.copyMode === "real" ? "REAL MONEY with safety checks off" : "Safety checks that are off"}:`, ...off.map((line) => `     ${line}`));
  if (c.copyMode !== "real" && openReal > 0) {
    out.push(
      `⚠️  COPY_MODE=paper, but ${openReal} real position(s) are still open. Paper mode does not watch or sell them: no stop-loss, no exit.`,
      `     To have them managed again, set COPY_MODE=real in .env and restart ("npm run pause" keeps new buys off).`,
    );
  }
  return out;
}

/** What to say about a secrets file's permissions; null when there is nothing to say. */
export function secretsFileNote(name: string, lock: OwnerOnly): string | null {
  if (lock === "tightened") return `🔒 ${name} could be read by other users on this machine. Fixed: only its owner can read it now.`;
  if (lock === "open") return `⚠️  ${name} can be read by other users on this machine, and that can't be changed from here. As the file's owner, run: chmod 600 ${name}`;
  return null;
}

/** Makes .env (it holds the API keys) readable by its owner only. */
export const lockEnvFile = (): OwnerOnly => ownerOnly(path.join(repoRoot(), ".env"));
