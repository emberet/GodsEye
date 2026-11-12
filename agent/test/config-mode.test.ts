/**
 * The switches in .env fail safe (config.ts): real money is never a default, only the word "real" turns it on, and a
 * word or number that can't be read refuses to start, naming the setting, instead of quietly meaning something else.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { HARD_MAX_COPY_TRADE_SOL } from "@godseye/shared";
import { readConfig } from "../src/config";

/** Reads the settings with these variables in place (undefined = not set), then puts the old values back. */
function configWith(vars: Record<string, string | undefined>): ReturnType<typeof readConfig> {
  const old = Object.fromEntries(Object.keys(vars).map((name) => [name, process.env[name]]));
  const put = (name: string, value: string | undefined) => (value === undefined ? delete process.env[name] : (process.env[name] = value));
  for (const [name, value] of Object.entries(vars)) put(name, value);
  try {
    return readConfig();
  } finally {
    for (const [name, value] of Object.entries(old)) put(name, value);
  }
}

const refuses = (vars: Record<string, string>, message: RegExp) => assert.throws(() => configWith(vars), message, JSON.stringify(vars));

test("real money is never a default: no COPY_MODE means paper", () => {
  for (const empty of [undefined, "", "   "]) assert.equal(configWith({ COPY_MODE: empty }).copyMode, "paper");
});

test("only the word real turns real money on", () => {
  for (const real of ["real", "REAL", " Real "]) assert.equal(configWith({ COPY_MODE: real }).copyMode, "real", real);
  for (const paper of ["paper", "PAPER"]) assert.equal(configWith({ COPY_MODE: paper }).copyMode, "paper", paper);
});

test("a typo in COPY_MODE refuses to start and names the setting", () => {
  for (const typo of ["reall", "rea1", "live", "true", "1", "on", "papr", "real money"]) refuses({ COPY_MODE: typo }, /COPY_MODE=.* in \.env is not one of: paper, real/);
});

test("an empty .env: paper mode, every safety check on, every research switch off", () => {
  const names = ["COPY_MODE", "RUG_CHECK_ENABLED", "RUG_BLOCK_MINT_AUTHORITY", "HOLDER_CHECK_ENABLED", "COPY_BRAIN_GATES", "LP_CONCENTRATED_POOLS", "QUANT_SIZING", "QUANT_SKILL_GATE", "SOCIAL_WARNING"];
  const c = configWith(Object.fromEntries(names.map((name) => [name, undefined])));
  assert.equal(c.copyMode, "paper");
  assert.deepEqual([c.rugCheckEnabled, c.rugBlockMintAuthority, c.holderCheckEnabled, c.copyBrainGates], [true, true, true, true]);
  assert.equal(c.lpConcentratedPools, "block");
  assert.deepEqual([c.quantSizing, c.quantSkillGate, c.socialWarning], ["off", "off", "off"]);
});

test("a typo in a safety switch refuses to start; it used to switch the check off", () => {
  for (const name of ["RUG_CHECK_ENABLED", "RUG_BLOCK_MINT_AUTHORITY", "HOLDER_CHECK_ENABLED", "COPY_BRAIN_GATES", "SHADOW_ENABLED"]) {
    for (const typo of ["ture", "enabled", "yess"]) refuses({ [name]: typo }, new RegExp(`${name}=.* in \\.env is not a yes or a no`));
  }
  // Switching one off still works, in plain words.
  assert.equal(configWith({ HOLDER_CHECK_ENABLED: "false" }).holderCheckEnabled, false);
  assert.equal(configWith({ HOLDER_CHECK_ENABLED: "off" }).holderCheckEnabled, false);
  assert.equal(configWith({ RUG_CHECK_ENABLED: "TRUE" }).rugCheckEnabled, true);
  refuses({ LP_CONCENTRATED_POOLS: "allow" }, /LP_CONCENTRATED_POOLS=.* is not one of: block, warn/);
  assert.equal(configWith({ LP_CONCENTRATED_POOLS: "Warn" }).lpConcentratedPools, "warn");
});

test("the switches the engine reads for itself are checked at start too", () => {
  // At decision time an unknown word quietly means "off" (so nothing throws in the middle of a trade). At start it stops.
  refuses({ QUANT_SIZING: "max" }, /QUANT_SIZING=.* is not one of: off, shadow, on/);
  refuses({ QUANT_SKILL_GATE: "yes" }, /QUANT_SKILL_GATE=.* is not one of: off, on/);
  // There is no live mode for the warning: "on" must not read as if there were.
  for (const word of ["on", "live", "true", "block"]) refuses({ SOCIAL_WARNING: word }, /SOCIAL_WARNING=.* is not one of: off, shadow/);
  const c = configWith({ QUANT_SIZING: "Shadow", QUANT_SKILL_GATE: "ON", SOCIAL_WARNING: " shadow " });
  assert.deepEqual([c.quantSizing, c.quantSkillGate, c.socialWarning], ["shadow", "on", "shadow"]);
  refuses({ BRAIN_MODE: "real" }, /BRAIN_MODE=.* is not one of: off, paper/);
  refuses({ STREAM_PARSER: "go" }, /STREAM_PARSER=.* is not one of: ts, rust, compare/);
});

test("a limit that is not a number refuses to start; the hard cap on trade size still holds", () => {
  refuses({ COPY_MAX_TRADE_SOL: "0.l" }, /COPY_MAX_TRADE_SOL=.* in \.env is not a number/);
  refuses({ COPY_DAILY_LOSS_LIMIT_SOL: "half" }, /COPY_DAILY_LOSS_LIMIT_SOL=.* is not a number/);
  refuses({ COPY_STOP_LOSS_PCT: "35%" }, /COPY_STOP_LOSS_PCT=.* is not a number/);
  assert.equal(configWith({ COPY_MAX_TRADE_SOL: "0.25" }).copyMaxTradeSol, 0.25);
  assert.equal(configWith({ COPY_MAX_TRADE_SOL: "50" }).copyMaxTradeSol, HARD_MAX_COPY_TRADE_SOL);
});
