import { test } from "node:test";
import assert from "node:assert/strict";
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";
import { parseSwap, type ParsedSwap } from "../src/chain/parse";
import { convertGrpcTx, type GrpcTxInfo } from "../src/stream/convert";
import { LiveBook } from "../src/stream/live-book";

const k = () => Keypair.generate().publicKey.toBytes();
const trader = k();
const pool = k();
const ata = k();
const loaded = k(); // a lookup-table address
const JUP = bs58.decode("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
const MINT = "Mint111111111111111111111111111111111111111";
const owner = bs58.encode(trader);

function grpcSwap(): GrpcTxInfo {
  return {
    signature: new Uint8Array(64).fill(7),
    isVote: false,
    transaction: { message: { header: { numRequiredSignatures: 1 }, accountKeys: [trader, pool, ata, JUP], instructions: [{ programIdIndex: 3 }] } },
    meta: {
      fee: "5000",
      preBalances: ["10000000000", "100000000000", "0", "1", "0"],
      postBalances: ["8999995000", "101000000000", "0", "1", "0"],
      innerInstructions: [],
      preTokenBalances: [{ accountIndex: 2, mint: MINT, owner, uiTokenAmount: { amount: "0", decimals: 6 } }],
      postTokenBalances: [{ accountIndex: 2, mint: MINT, owner, uiTokenAmount: { amount: "5000000000", decimals: 6 } }],
      loadedWritableAddresses: [loaded],
      loadedReadonlyAddresses: [],
    },
  };
}

test("gRPC transactions parse exactly like RPC ones (lookup-table keys appended in order)", () => {
  const c = convertGrpcTx(grpcSwap(), 123, Date.parse("2026-10-19T00:00:00Z"))!;
  assert.deepEqual(c.signers, [owner]);
  assert.equal(c.tx.transaction.message.accountKeys.length, 5);
  assert.equal(String(c.tx.transaction.message.accountKeys[4].pubkey), bs58.encode(loaded));
  const s = parseSwap(c.tx, owner)!;
  assert.equal(s.side, "buy");
  assert.equal(s.tokenAmount, 5000);
  assert.ok(Math.abs(s.solAmount - 1) < 1e-9);
  assert.equal(s.venue, "jupiter");
  assert.equal(s.signature, bs58.encode(new Uint8Array(64).fill(7)));
  assert.equal(s.slot, 123);
});

test("gRPC: votes and failed transactions are skipped", () => {
  assert.equal(convertGrpcTx({ ...grpcSwap(), isVote: true }, 1, Date.now()), null);
  const failed = grpcSwap();
  failed.meta!.err = { err: new Uint8Array([1, 2]) };
  assert.equal(parseSwap(convertGrpcTx(failed, 1, Date.now())!.tx, owner), null);
});

const sw = (wallet: string, side: "buy" | "sell", sol: number, mint: string, i: number): ParsedSwap => ({
  wallet, signature: `s${i}`, slot: i, ts: new Date(Date.parse("2026-10-19T00:00:00Z") + i * 60_000).toISOString(), mint, side,
  tokenAmount: 100, tokenBalanceBefore: side === "sell" ? 100 : 0, solAmount: sol, priceSol: sol / 100, venue: "pumpfun", jitoTip: false, feeLamports: 5000, quote: "SOL", quoteAmount: sol, solUsd: null, usdAmount: sol * 100,
});

test("live book: live P&L, promotion of winners, eviction of idle wallets", () => {
  const book = new LiveBook({ maxWallets: 10, idleMs: 60_000, earlyBuySeconds: 600 });
  let i = 0;
  for (let n = 0; n < 4; n++) {
    book.record(sw("WIN", "buy", 1, `M${n}`, i++));
    book.record(sw("WIN", "sell", 1.5, `M${n}`, i++));
    book.record(sw("LOSE", "buy", 1, `M${n}`, i++));
    book.record(sw("LOSE", "sell", 0.5, `M${n}`, i++));
  }
  book.rescore();
  assert.ok(Math.abs(book.get("WIN")!.pnlSol - 2) < 1e-9);
  assert.equal(book.get("WIN")!.closed, 4);
  assert.deepEqual(book.promotable(1, 3).map((w) => w.address), ["WIN"]);
  assert.equal(book.takeDirty().length, 2);
  assert.equal(book.evict(Date.now() + 120_000), 2);
  assert.equal(book.size, 0);
});
