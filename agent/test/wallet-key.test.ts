/**
 * The wallet key file (wallet/wallet.ts): with real money a missing key refuses to start and no new wallet appears; a
 * new key is saved for its owner only; a key that exists is never written over. Throwaway files in the test folder
 * only: the agent's own wallet can't be loaded from a test at all.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { dataPath } from "@godseye/shared";
import { loadOrCreateWallet, readOrCreateKeypair } from "../src/wallet/wallet";

let n = 0;
const freshPath = () => dataPath("wallet-test", `key-${process.pid}-${++n}.json`);

test("real money: a missing key file refuses to start, and no wallet is made", () => {
  const file = freshPath();
  assert.throws(() => readOrCreateKeypair(file, false), /No wallet key at .*COPY_MODE=real never makes a new wallet/);
  assert.equal(fs.existsSync(file), false);
});

test("a new key is saved for its owner only and reads back as the same wallet", () => {
  const file = freshPath();
  const made = readOrCreateKeypair(file, true);
  assert.equal(made.created, true);
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const again = readOrCreateKeypair(file, false);
  assert.equal(again.created, false);
  assert.equal(again.keypair.publicKey.toBase58(), made.keypair.publicKey.toBase58());
});

test("a key file that exists is never written over", () => {
  const file = freshPath();
  const first = readOrCreateKeypair(file, true);
  const saved = fs.readFileSync(file, "utf8");
  const second = readOrCreateKeypair(file, true);
  assert.equal(second.created, false);
  assert.equal(second.keypair.publicKey.toBase58(), first.keypair.publicKey.toBase58());
  assert.equal(fs.readFileSync(file, "utf8"), saved);
});

test("a test can never load or create the agent's own wallet, in either mode", () => {
  assert.throws(() => loadOrCreateWallet(), /Tests must never load or create the agent wallet/);
  assert.throws(() => loadOrCreateWallet(undefined, false), /Tests must never load or create the agent wallet/);
  assert.throws(() => loadOrCreateWallet(undefined, true), /Tests must never load or create the agent wallet/);
});
