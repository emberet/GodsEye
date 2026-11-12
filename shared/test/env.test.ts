import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { envBool, envNum, envOneOf, ownerOnly, repoRoot } from "../src/env";

/** Runs `fn` with one setting in place, then puts the old value back. */
function withEnv<T>(name: string, value: string | undefined, fn: () => T): T {
  const old = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return fn();
  } finally {
    if (old === undefined) delete process.env[name];
    else process.env[name] = old;
  }
}

test("a yes/no switch: known words only; an unknown word refuses to start and never reads as off", () => {
  for (const yes of ["1", "true", "TRUE", "yes", "On", " true "]) assert.equal(withEnv("T_FLAG", yes, () => envBool("T_FLAG", false)), true, yes);
  for (const no of ["0", "false", "False", "no", "OFF"]) assert.equal(withEnv("T_FLAG", no, () => envBool("T_FLAG", true)), false, no);
  // Empty or missing: the default, whichever way it points.
  for (const empty of [undefined, "", "   "]) {
    assert.equal(withEnv("T_FLAG", empty, () => envBool("T_FLAG", true)), true);
    assert.equal(withEnv("T_FLAG", empty, () => envBool("T_FLAG", false)), false);
  }
  // The typos that used to switch a default-on safety check off.
  for (const typo of ["ture", "flase", "enabled", "y", "2", "true;"]) {
    assert.throws(() => withEnv("T_FLAG", typo, () => envBool("T_FLAG", true)), /T_FLAG=.* in \.env is not a yes or a no/, typo);
  }
});

test("a word from a list: any case, default when empty, anything else refuses to start", () => {
  const read = () => envOneOf("T_MODE", ["paper", "real"], "paper");
  assert.equal(withEnv("T_MODE", undefined, read), "paper");
  assert.equal(withEnv("T_MODE", "", read), "paper");
  assert.equal(withEnv("T_MODE", "paper", read), "paper");
  assert.equal(withEnv("T_MODE", "REAL", read), "real");
  assert.equal(withEnv("T_MODE", " Real ", read), "real");
  for (const typo of ["reall", "live", "true", "papr", "real money"]) {
    assert.throws(() => withEnv("T_MODE", typo, read), /T_MODE=.* in \.env is not one of: paper, real/, typo);
  }
});

test("a number: default when empty, anything that is not a number refuses to start", () => {
  assert.equal(withEnv("T_NUM", undefined, () => envNum("T_NUM", 7)), 7);
  assert.equal(withEnv("T_NUM", " ", () => envNum("T_NUM", 7)), 7);
  assert.equal(withEnv("T_NUM", "0", () => envNum("T_NUM", 7)), 0);
  assert.equal(withEnv("T_NUM", "0.25", () => envNum("T_NUM", 7)), 0.25);
  assert.equal(withEnv("T_NUM", "-3", () => envNum("T_NUM", 7)), -3);
  for (const typo of ["0.l", "O.5", "1,5", "ten", "5%", "Infinity"]) {
    assert.throws(() => withEnv("T_NUM", typo, () => envNum("T_NUM", 7)), /T_NUM=.* in \.env is not a number/, typo);
  }
});

test("an error shows at most the start of the value, never a long one whole", () => {
  const long = "x".repeat(80);
  assert.throws(
    () => withEnv("T_NUM", long, () => envNum("T_NUM", 1)),
    (e: Error) => !e.message.includes("x".repeat(13)) && e.message.includes(`${"x".repeat(12)}…`),
  );
});

test("a secrets file ends up readable by its owner only", { skip: process.platform === "win32" }, () => {
  const file = path.join(repoRoot(), "data", "owner-only.txt");
  assert.equal(ownerOnly(file), "missing");
  fs.writeFileSync(file, "x", { mode: 0o644 });
  fs.chmodSync(file, 0o644); // writeFileSync's mode is cut by the umask; chmod is exact
  assert.equal(ownerOnly(file), "tightened");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(ownerOnly(file), "ok");
  fs.chmodSync(file, 0o660);
  assert.equal(ownerOnly(file), "tightened");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});
