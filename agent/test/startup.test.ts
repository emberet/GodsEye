/**
 * What the agent says at start (startup.ts): the public line carries the mode and three limits and nothing else; the
 * console report names every safety switch and limit by its .env name; a safety check that is off, real positions
 * left open under paper mode and a secrets file other users can read are each called out.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Keypair } from "@solana/web3.js";
import { HARD_MAX_COPY_TRADE_SOL, openDb, repoRoot } from "@godseye/shared";
import { type Config, readConfig } from "../src/config";
import { ceilingsNote, lockEnvFile, modeLine, openRealPositions, safetyOff, secretsFileNote, settingsReport, startupWarnings } from "../src/startup";

/** Paper mode with every safety check on (the test setup itself runs with the rug screen off). */
const safe: Config = {
  ...readConfig(),
  copyMode: "paper",
  rugCheckEnabled: true,
  rugBlockMintAuthority: true,
  holderCheckEnabled: true,
  copyBrainGates: true,
  lpMinLockedPct: 90,
  lpConcentratedPools: "block",
  rugAllowlist: [],
};
const real: Config = { ...safe, copyMode: "real" };
const ADDRESS = /[1-9A-HJ-NP-Za-km-z]{32,}/;

test("the public start line: the mode and three limits, nothing else", () => {
  const paper = modeLine(safe);
  assert.equal(paper.level, "info");
  assert.match(paper.message, /COPY_MODE=paper .* No real funds move\./);

  const live = modeLine({ ...real, riskGovernor: false, copyMaxTradeSol: 0.2, copyBudgetSol: 3, dailyLossLimitSol: 0.7 });
  assert.equal(live.level, "warn");
  assert.match(live.message, /COPY_MODE=real .*REAL SOL: up to 0\.2 SOL per trade, 3 SOL in total, stop for the day after 0\.7 SOL of losses/);
  const governed = modeLine({ ...real, riskGovernor: true });
  assert.equal(governed.level, "warn");
  assert.match(governed.message, /COPY_MODE=real .*REAL SOL, sized from what it holds: 5% a trade to start \(never over 10%\), stop for the day 20% down, pause itself 50% below its high/);

  // Research switches, thresholds, file names and addresses belong to the console, not the feed.
  for (const { message } of [paper, live, governed, modeLine({ ...real, quantSizing: "on", socialWarning: "shadow", rugAllowlist: [Keypair.generate().publicKey.toBase58()] })]) {
    assert.doesNotMatch(message, /social|quant|brain|rug|shadow|allowlist|\.env|wallet/i);
    assert.doesNotMatch(message, ADDRESS);
  }
});

test("the console report names every safety switch and limit by its .env name", () => {
  const report = settingsReport(safe, false).join("\n");
  const names = [
    "COPY_MODE", "BRAIN_MODE",
    "COPY_MIN_TRADE_SOL", "COPY_MAX_TRADE_SOL", "COPY_BUDGET_SOL", "COPY_MAX_POSITIONS", "WALLET_RESERVE_SOL",
    "COPY_DAILY_LOSS_LIMIT_SOL", "COPY_STOP_LOSS_PCT", "COPY_TAKE_PROFIT_PCT", "COPY_MAX_HOLD_HOURS",
    "MIN_LEADER_BUY_SOL", "COPY_MAX_DELAY_SECONDS", "COPY_BRAIN_GATES", "COPY_SLIPPAGE_BPS", "COPY_MAX_PRICE_IMPACT_PCT", "COPY_PUMPSWAP_MIGRATED_ONLY", "COPY_EXIT_MAX_SLIPPAGE_BPS", "PRIORITY_FEE_MAX_LAMPORTS", "COPY_SEND_VIA", "JITO_TIP_LAMPORTS",
    "COPY_MAX_LEADERS", "COPY_MAX_LEADER_SHARE", "COPY_MIN_COPYABLE_SHARE", "COPY_LOSS_DROP_SOL",
    "RUG_CHECK_ENABLED", "RUG_BLOCK_MINT_AUTHORITY", "RUG_MAX_RISK_SCORE", "RUG_REQUIRE_RUGCHECK", "RUG_MAX_TRANSFER_FEE_BPS", "LP_MIN_LOCKED_PCT", "LP_CONCENTRATED_POOLS", "RUG_ALLOWLIST",
    "HOLDER_CHECK_ENABLED", "BUNDLE_MAX_PCT", "CLUSTER_MAX_PCT", "TOP10_MAX_PCT", "INSIDER_MAX_PCT",
    "SHADOW_ENABLED", "QUANT_SIZING", "QUANT_SKILL_GATE", "SOCIAL_WARNING",
    "RISK_GOVERNOR", "RISK_START_TRADE_PCT", "RISK_MIN_TRADE_PCT", "RISK_MAX_TRADE_PCT", "RISK_DAILY_STOP_PCT", "RISK_DRAWDOWN_PAUSE_PCT", "RISK_MIN_TRADE_SOL", "RISK_MIN_EQUITY_SOL", "FUNDING_OUTFLOW_PAUSE_SOL",
  ];
  for (const name of names) assert.match(report, new RegExp(`(^|\\s)${name}=\\S`, "m"), name);
  assert.match(report, /COPY_MODE=paper/);
  assert.match(report, /RUG_CHECK_ENABLED=true/);
  assert.doesNotMatch(report, /PAUSED/);
  assert.match(settingsReport(safe, true)[0], /PAUSED: no new buys/);
});

test("the report shows the values in effect: the capped trade size, a count for the allowlist", () => {
  const old = process.env.COPY_MAX_TRADE_SOL;
  process.env.COPY_MAX_TRADE_SOL = "50";
  const capped = readConfig();
  if (old === undefined) delete process.env.COPY_MAX_TRADE_SOL;
  else process.env.COPY_MAX_TRADE_SOL = old;
  assert.match(settingsReport(capped, false).join("\n"), new RegExp(`COPY_MAX_TRADE_SOL=${HARD_MAX_COPY_TRADE_SOL}(\\s|$)`, "m"));

  const listed = settingsReport({ ...safe, rugAllowlist: [Keypair.generate().publicKey.toBase58(), Keypair.generate().publicKey.toBase58()] }, false).join("\n");
  assert.match(listed, /RUG_ALLOWLIST=2 coin\(s\)/);
  assert.doesNotMatch(listed, ADDRESS);
});

test("the report says whether the alert channel is filled in, never what it holds", () => {
  const empty = settingsReport({ ...safe, telegramBotToken: "", telegramChatId: "" }, false).join("\n");
  assert.match(empty, /TELEGRAM_BOT_TOKEN=empty\s+TELEGRAM_CHAT_ID=empty/);

  const secret = randomBytes(26).toString("base64url");
  const chat = String(100_000_000 + Math.floor(Math.random() * 800_000_000));
  const filled = settingsReport({ ...safe, telegramBotToken: `7654321:${secret}`, telegramChatId: chat }, false).join("\n");
  assert.match(filled, /TELEGRAM_BOT_TOKEN=set\s+TELEGRAM_CHAT_ID=set/);
  assert.ok(!filled.includes(secret) && !filled.includes(chat));
});

test("every check on: nothing to warn about, in either mode", () => {
  assert.deepEqual(safetyOff(safe), []);
  assert.deepEqual(startupWarnings(safe, 0), []);
  assert.deepEqual(startupWarnings(real, 0), []);
});

test("each safety check that is off is named; with real money the heading says so", () => {
  const cases: [Partial<Config>, RegExp][] = [
    [{ rugCheckEnabled: false }, /^RUG_CHECK_ENABLED is off/],
    [{ rugBlockMintAuthority: false }, /^RUG_BLOCK_MINT_AUTHORITY is off/],
    [{ lpMinLockedPct: 0 }, /^LP_MIN_LOCKED_PCT is 0/],
    [{ lpConcentratedPools: "warn" }, /^LP_CONCENTRATED_POOLS=warn/],
    [{ rugAllowlist: [Keypair.generate().publicKey.toBase58()] }, /^RUG_ALLOWLIST: 1 coin\(s\) skip the rug screen/],
    [{ holderCheckEnabled: false }, /^HOLDER_CHECK_ENABLED is off/],
    [{ copyBrainGates: false }, /^COPY_BRAIN_GATES is off/],
  ];
  for (const [change, line] of cases) {
    const off = safetyOff({ ...safe, ...change });
    assert.equal(off.length, 1, String(line));
    assert.match(off[0], line);
    assert.doesNotMatch(off[0], ADDRESS);
    assert.match(startupWarnings({ ...safe, ...change }, 0)[0], /Safety checks that are off:/);
    const withMoney = startupWarnings({ ...real, ...change }, 0);
    assert.match(withMoney[0], /REAL MONEY with safety checks off:/);
    assert.equal(withMoney.length, 2);
  }
  assert.equal(safetyOff({ ...safe, rugCheckEnabled: false, holderCheckEnabled: false, copyBrainGates: false }).length, 3);
});

test("paper mode with real positions still open is called out; real mode manages them", () => {
  const lines = startupWarnings(safe, 3);
  assert.match(lines[0], /COPY_MODE=paper, but 3 real position\(s\) are still open\. Paper mode does not watch or sell them/);
  assert.match(lines[1], /set COPY_MODE=real in \.env and restart/);
  assert.deepEqual(startupWarnings(real, 3), []);
});

test("open real positions are counted from the database", () => {
  const db = openDb(":memory:");
  assert.equal(openRealPositions(db), 0);
  const add = db.prepare("INSERT INTO positions (mint, leader, mode, status, token_amount, tokens_bought, cost_sol, entry_price_sol, opened_at) VALUES (?, 'LEADER', ?, ?, 1, 1, 0.1, 0.001, ?)");
  const now = new Date().toISOString();
  add.run("A", "real", "open", now);
  add.run("B", "real", "open", now);
  add.run("C", "real", "closed", now);
  add.run("D", "paper", "open", now);
  assert.equal(openRealPositions(db), 2);
  db.close();
});

test("a secrets file: nothing to say when it is locked, a fix or a command when it is not", () => {
  assert.equal(secretsFileNote(".env", "ok"), null);
  assert.equal(secretsFileNote(".env", "missing"), null);
  assert.match(secretsFileNote(".env", "tightened") ?? "", /\.env could be read by other users .* Fixed/);
  assert.match(secretsFileNote(".env", "open") ?? "", /\.env can be read by other users .* chmod 600 \.env$/);
});

test(".env ends up readable by its owner only", { skip: process.platform === "win32" }, () => {
  const file = path.join(repoRoot(), ".env");
  fs.chmodSync(file, 0o644);
  assert.equal(lockEnvFile(), "tightened");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(lockEnvFile(), "ok");
});

test("under the governor, the fixed limits written in .env are named as ceilings; otherwise nothing is said", () => {
  const none = { maxTrade: false, budget: false, dailyLoss: false };
  assert.equal(ceilingsNote({ ...real, riskGovernor: true, fixedInEnv: none }), null);
  assert.equal(ceilingsNote({ ...safe, riskGovernor: true, fixedInEnv: { ...none, maxTrade: true } }), null, "paper mode");
  assert.equal(ceilingsNote({ ...real, riskGovernor: false, fixedInEnv: { ...none, maxTrade: true } }), null, "governor off");
  const note = ceilingsNote({ ...real, riskGovernor: true, copyMaxTradeSol: 0.1, dailyLossLimitSol: 0.25, fixedInEnv: { maxTrade: true, budget: false, dailyLoss: true } });
  assert.match(note ?? "", /COPY_MAX_TRADE_SOL=0\.1\s+COPY_DAILY_LOSS_LIMIT_SOL=0\.25\. Take a line out of \.env/);
  assert.doesNotMatch(note ?? "", /COPY_BUDGET_SOL/);
});

test("under the governor, a fixed limit not in .env is reported as the governor's", () => {
  const none = { maxTrade: false, budget: false, dailyLoss: false };
  const governed = settingsReport({ ...real, riskGovernor: true, fixedInEnv: { ...none, budget: true }, copyBudgetSol: 3 }, false).join("\n");
  assert.match(governed, /COPY_MAX_TRADE_SOL=\(set by the governor\)/);
  assert.match(governed, /COPY_DAILY_LOSS_LIMIT_SOL=\(set by the governor\)/);
  assert.match(governed, /COPY_BUDGET_SOL=3(\s|$)/m);
  assert.match(settingsReport({ ...safe, riskGovernor: true, fixedInEnv: none }, false).join("\n"), /COPY_MAX_TRADE_SOL=0\.1|COPY_MAX_TRADE_SOL=\d/, "paper mode shows the fixed values");
});
