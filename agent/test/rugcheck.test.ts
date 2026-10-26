import { test } from "node:test";
import assert from "node:assert/strict";
import { judgeRugRisk, lockedLiquidityPct, type RugCheckSummary } from "../src/market/rugcheck";

const clean = { mintAuthority: null, freezeAuthority: null, extensions: [] };
const opts = { blockMintAuthority: true, maxRiskScore: 75, allowlist: [] as string[], minLockedPct: 90 };
const pool = (marketType: string, lpLockedPct: number, usd: number) => ({ marketType, lp: { lpLockedPct, quoteUSD: usd / 2, baseUSD: usd / 2 } });
const report = (markets: RugCheckSummary["markets"]): RugCheckSummary => ({ score_normalised: 10, risks: [], markets });

test("liquidity: pump.fun coins (curve or burned LP) pass", () => {
  const v = judgeRugRisk("MINT", clean, report([pool("pump_fun_amm", 100, 0.000001)]), opts);
  assert.equal(v.verdict, "pass");
});

test("liquidity: a coin whose pools can be pulled is blocked", () => {
  const v = judgeRugRisk("MINT", clean, report([pool("raydium", 0, 50_000)]), opts);
  assert.equal(v.verdict, "blocked");
  assert.match(v.blocks.join(), /liquidity not locked: only 0% /);
});

test("liquidity: weighted by each pool's dollars, so a big unlocked pool outweighs a small locked one", () => {
  const rc = report([pool("pump_fun_amm", 100, 1_000), pool("meteoraDlmm", 0, 99_000)]);
  assert.equal(Math.round(lockedLiquidityPct(rc)!), 1);
  assert.equal(judgeRugRisk("MINT", clean, rc, opts).verdict, "blocked");
  const mostlyLocked = report([pool("raydium", 100, 95_000), pool("meteoraDlmm", 0, 5_000)]);
  assert.equal(lockedLiquidityPct(mostlyLocked), 95);
  assert.equal(judgeRugRisk("MINT", clean, mostlyLocked, opts).verdict, "pass");
});

test("liquidity: no pool data is a warning, not a block; the rule can be turned off; trusted coins are exempt", () => {
  const unknown = judgeRugRisk("MINT", clean, report([]), opts);
  assert.equal(unknown.verdict, "pass");
  assert.ok(unknown.warnings.some((w) => /liquidity lock unknown/.test(w)));
  assert.equal(lockedLiquidityPct(null), null);
  const unlocked = report([pool("orca", 0, 10_000)]);
  assert.equal(judgeRugRisk("MINT", clean, unlocked, { ...opts, minLockedPct: 0 }).verdict, "pass");
  assert.equal(judgeRugRisk("MINT", clean, unlocked, { ...opts, allowlist: ["MINT"] }).verdict, "pass");
});
