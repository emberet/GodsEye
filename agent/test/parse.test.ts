import { test } from "node:test";
import assert from "node:assert/strict";
import { SOL_MINT } from "@godseye/shared";
import { findFunder, findNewWalletsFunded, parseSwap, TOKEN_ACCOUNT_RENT_LAMPORTS } from "../src/chain/parse";
import { JUP, MINT, PUMP, swapTx, tokenBal, WALLET } from "./helpers";

test("a buy: SOL out, tokens in, fee excluded", () => {
  const s = parseSwap(swapTx({ solDelta: -1.000005, tokenBefore: 0, tokenAfter: 5000 }), WALLET)!;
  assert.equal(s.side, "buy");
  assert.equal(s.mint, MINT);
  assert.equal(s.tokenAmount, 5000);
  assert.ok(Math.abs(s.solAmount - 1) < 1e-9, `sol ${s.solAmount}`);
  assert.equal(s.venue, "jupiter");
});

test("a sell reports the balance before, so partial sells can be copied", () => {
  const s = parseSwap(swapTx({ solDelta: 0.5 - 0.000005, tokenBefore: 4000, tokenAfter: 1000 }), WALLET)!;
  assert.equal(s.side, "sell");
  assert.equal(s.tokenAmount, 3000);
  assert.equal(s.tokenBalanceBefore, 4000);
  assert.ok(Math.abs(s.solAmount - 0.5) < 1e-9);
});

test("token-account rent isn't counted as part of the price", () => {
  const rent = TOKEN_ACCOUNT_RENT_LAMPORTS / 1e9;
  const s = parseSwap(swapTx({ solDelta: -(1 + rent + 0.000005), tokenBefore: 0, tokenAfter: 100, newTokenAccount: true }), WALLET)!;
  assert.ok(Math.abs(s.solAmount - 1) < 1e-9, `sol ${s.solAmount}`);
});

test("failed transactions and non-swaps are ignored", () => {
  assert.equal(parseSwap(swapTx({ solDelta: -1, tokenBefore: 0, tokenAfter: 100, err: { InstructionError: [0, "x"] } }), WALLET), null);
  // tokens in and SOL in = an airdrop / transfer, not a buy
  assert.equal(parseSwap(swapTx({ solDelta: 0.1, tokenBefore: 0, tokenAfter: 100 }), WALLET), null);
  // a wallet that isn't in the transaction
  assert.equal(parseSwap(swapTx({ solDelta: -1, tokenBefore: 0, tokenAfter: 100 }), "Someone1111111111111111111111111111111111111"), null);
});

test("wrapped SOL counts as SOL", () => {
  const tx = swapTx({ solDelta: -0.000005, tokenBefore: 0, tokenAfter: 100 });
  tx.meta!.preTokenBalances!.push(tokenBal(3, SOL_MINT, WALLET, 2, 9));
  tx.meta!.postTokenBalances!.push(tokenBal(3, SOL_MINT, WALLET, 0.5, 9));
  const s = parseSwap(tx, WALLET)!;
  assert.equal(s.side, "buy");
  assert.ok(Math.abs(s.solAmount - 1.5) < 1e-9);
});

test("venue: a DEX reached through an unknown program is labelled as via a bot", () => {
  const s = parseSwap(swapTx({ solDelta: -1, tokenBefore: 0, tokenAfter: 100, programs: ["BotRouter111111111111111111111111111111111"], inner: [PUMP] }), WALLET)!;
  assert.equal(s.venue, "pumpfun (via bot)");
  const d = parseSwap(swapTx({ solDelta: -1, tokenBefore: 0, tokenAfter: 100, programs: [PUMP] }), WALLET)!;
  assert.equal(d.venue, "pumpfun");
});

test("Jito tips are flagged and not counted as price", () => {
  const tip = "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5";
  const s = parseSwap(swapTx({ solDelta: -1.010005, tokenBefore: 0, tokenAfter: 100, extraKeys: [{ key: tip, pre: 1e9, post: 1.01e9 }] }), WALLET)!;
  assert.equal(s.jitoTip, true);
  assert.ok(Math.abs(s.solAmount - 1) < 1e-6, `sol ${s.solAmount}`);
});

test("findFunder: who sent a new wallet its first SOL", () => {
  const funder = "Funder11111111111111111111111111111111111111";
  const tx = swapTx({ solDelta: 0, tokenBefore: 0, tokenAfter: 0, programs: [JUP] });
  tx.transaction.message.accountKeys = [{ pubkey: { toString: () => funder } }, { pubkey: { toString: () => WALLET } }];
  tx.meta = { ...tx.meta!, preBalances: [10e9, 0], postBalances: [8e9 - 5000, 2e9], preTokenBalances: [], postTokenBalances: [] };
  assert.equal(findFunder(tx, WALLET), funder);
});

test("findNewWalletsFunded: spots SOL sent to a never-used wallet", () => {
  const fresh = "Fresh111111111111111111111111111111111111111";
  const tx = swapTx({ solDelta: 0, tokenBefore: 0, tokenAfter: 0 });
  tx.transaction.message.accountKeys = [{ pubkey: { toString: () => WALLET } }, { pubkey: { toString: () => fresh } }];
  tx.transaction.message.instructions = [{ programId: { toString: () => "11111111111111111111111111111111" } }];
  tx.meta = { ...tx.meta!, preBalances: [10e9, 0], postBalances: [7e9 - 5000, 3e9], preTokenBalances: [], postTokenBalances: [] };
  assert.deepEqual(findNewWalletsFunded(tx, WALLET, 0.5), [{ address: fresh, sol: 3 }]);
  assert.deepEqual(findNewWalletsFunded(tx, WALLET, 5), []);
});

test("SOL ↔ USDC swaps are not token trades", () => {
  const tx = swapTx({ solDelta: -1, tokenBefore: 0, tokenAfter: 0 });
  const usdc = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  tx.meta!.preTokenBalances = [tokenBal(2, usdc, WALLET, 10)];
  tx.meta!.postTokenBalances = [tokenBal(2, usdc, WALLET, 160)];
  assert.equal(parseSwap(tx, WALLET), null);
});
