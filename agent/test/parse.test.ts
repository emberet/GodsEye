import { test } from "node:test";
import assert from "node:assert/strict";
import { SOL_MINT } from "@godseye/shared";
import { findFunder, findNewWalletsFunded, parseSwap, parseSwaps, TOKEN_ACCOUNT_RENT_LAMPORTS } from "../src/chain/parse";
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

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const at100 = { solUsdAt: () => 100 };
/** A swap where the wallet's only SOL change is the fee, and it pays/receives USDC. */
function usdcSwap(usdcBefore: number, usdcAfter: number, tokenBefore: number, tokenAfter: number, solDelta = -0.000005) {
  const tx = swapTx({ solDelta, tokenBefore, tokenAfter });
  tx.meta!.preTokenBalances!.push(tokenBal(3, USDC, WALLET, usdcBefore));
  tx.meta!.postTokenBalances!.push(tokenBal(3, USDC, WALLET, usdcAfter));
  return tx;
}

test("memecoin bought with USDC is valued in SOL at the time", () => {
  const s = parseSwap(usdcSwap(500, 300, 0, 1000), WALLET, at100)!;
  assert.equal(s.side, "buy");
  assert.equal(s.quote, "USDC");
  assert.equal(s.quoteAmount, 200);
  assert.equal(s.solUsd, 100);
  assert.ok(Math.abs(s.solAmount - 2) < 1e-9, `sol ${s.solAmount}`); // $200 at $100/SOL
});

test("memecoin sold for USDC is a sell valued in SOL", () => {
  const s = parseSwap(usdcSwap(0, 450, 1000, 0), WALLET, at100)!;
  assert.equal(s.side, "sell");
  assert.ok(Math.abs(s.solAmount - 4.5) < 1e-9);
});

test("paid partly in SOL and partly in USDC: both count", () => {
  const s = parseSwap(usdcSwap(100, 0, 0, 1000, -1.000005), WALLET, at100)!;
  assert.equal(s.quote, "SOL+USDC");
  assert.ok(Math.abs(s.solAmount - 2) < 1e-9); // 1 SOL + $100
});

test("USDC swaps are skipped when SOL's price at the time is unknown, never guessed", () => {
  assert.equal(parseSwap(usdcSwap(500, 300, 0, 1000), WALLET), null);
  assert.equal(parseSwap(usdcSwap(500, 300, 0, 1000), WALLET, { solUsdAt: () => null }), null);
});

test("pure SOL swaps don't need a price and report quote SOL", () => {
  const s = parseSwap(swapTx({ solDelta: -1.000005, tokenBefore: 0, tokenAfter: 10 }), WALLET)!;
  assert.equal(s.quote, "SOL");
  assert.equal(s.solUsd, null);
});

/** WALLET swaps 1000 A for 500 B; pool A's vault loses `outSol`, pool B's vault gains `inSol`. */
function memeToMemeTx(outSol: number, inSol: number) {
  const A = "TokenA11111111111111111111111111111111111111";
  const B = "TokenB11111111111111111111111111111111111111";
  const poolA = "PoolA111111111111111111111111111111111111111";
  const poolB = "PoolB111111111111111111111111111111111111111";
  const tx: ReturnType<typeof swapTx> = {
    slot: 9,
    blockTime: 1_760_000_000,
    meta: {
      err: null,
      fee: 5000,
      // wallet pays only the fee; vault A (WSOL account) −out, vault B +in
      preBalances: [10e9, 50e9, 50e9, 2039280, 2039280],
      postBalances: [10e9 - 5000, 50e9 - outSol * 1e9, 50e9 + inSol * 1e9, 2039280, 2039280],
      preTokenBalances: [tokenBal(3, A, WALLET, 1000), tokenBal(4, B, WALLET, 0)],
      postTokenBalances: [tokenBal(3, A, WALLET, 0), tokenBal(4, B, WALLET, 500)],
      innerInstructions: [],
    },
    transaction: {
      signatures: ["memeSig"],
      message: {
        accountKeys: [WALLET, poolA, poolB, "AtaA1111111111111111111111111111111111111111", "AtaB1111111111111111111111111111111111111111"].map((k) => ({ pubkey: k })),
        instructions: [{ programId: JUP }],
      },
    },
  };
  return { tx, A, B };
}

test("memecoin → memecoin through SOL: a sell and a buy, both valued at the SOL that moved", () => {
  const { tx, A, B } = memeToMemeTx(2, 1.99);
  const s = parseSwaps(tx, WALLET);
  assert.equal(s.length, 2);
  assert.deepEqual(s.map((x) => [x.side, x.mint]), [["sell", A], ["buy", B]]);
  assert.ok(s.every((x) => Math.abs(x.solAmount - 2) < 1e-9 && x.quote === "SOL (routed)"));
  assert.equal(s[0].tokenBalanceBefore, 1000);
  assert.equal(parseSwap(tx, WALLET)!.side, "sell");
});

test("memecoin → memecoin with no matching SOL hop is skipped, not guessed", () => {
  assert.deepEqual(parseSwaps(memeToMemeTx(2, 0.5).tx, WALLET), []); // amounts don't match
  assert.deepEqual(parseSwaps(memeToMemeTx(0, 0).tx, WALLET), []); // direct A/B pool, no SOL moved
});

test("non-memecoins (e.g. cbBTC) aren't counted, even when paid in USDC", () => {
  const tx = usdcSwap(0, 3800, 0.05, 0);
  for (const b of [...tx.meta!.preTokenBalances!, ...tx.meta!.postTokenBalances!]) if (b.mint === MINT) b.mint = "cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij";
  assert.deepEqual(parseSwaps(tx, WALLET, at100), []);
});
