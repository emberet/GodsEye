/**
 * Network failure and retry behaviour (stubbed fetch, no real RPC), and the pre-signing simulation check
 * (a mocked Connection). Retry waits are set to zero so these run instantly.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey, TransactionMessage, VersionedTransaction, type Connection } from "@solana/web3.js";
import { retryTiming } from "../src/backoff";
import { fetchParsed, fetchParsedOne } from "../src/chain/history";
import { fetchJson, HttpError } from "../src/http";
import { rpcUsage } from "../src/chain/rpc-budget";
import { simulateCheck } from "../src/copy/verify";
import { stubFetch } from "./helpers";

retryTiming.scale = 0;
const TX = { slot: 1, blockTime: 1, transaction: { message: { accountKeys: [] } }, meta: { err: null, fee: 5000, preBalances: [], postBalances: [] } };
const rpcReply = (body: unknown, make: (id: number) => object): object =>
  Array.isArray(body) ? body.map((b: { id: number }) => make(b.id)) : make((body as { id: number }).id);

test("RPC: rate-limited (429) requests are retried, and the throttling is counted", async () => {
  let n = 0;
  const net = stubFetch((_url, body) => (++n <= 2 ? new Response("slow down", { status: 429 }) : rpcReply(body, (id) => ({ jsonrpc: "2.0", id, result: TX }))));
  try {
    const before = rpcUsage(60).throttled;
    const [tx] = await fetchParsed(["sigA"]);
    assert.deepEqual(tx, TX);
    assert.equal(net.calls.length, 3);
    assert.ok(rpcUsage(60).throttled >= before + 2);
  } finally {
    net.restore();
  }
});

test("RPC: entries refused inside a batch are retried on their own; the rest are kept", async () => {
  let round = 0;
  const net = stubFetch((_url, body) => {
    round++;
    return rpcReply(body, (id) => (round === 1 && id === 1 ? { jsonrpc: "2.0", id, error: { message: "rate limit exceeded" } } : { jsonrpc: "2.0", id, result: { ...TX, slot: id + round * 10 } }));
  });
  try {
    const txs = await fetchParsed(["a", "b", "c"]);
    assert.equal(txs.filter(Boolean).length, 3);
    assert.equal((txs[0] as { slot: number }).slot, 10, "first-round result kept");
    assert.equal((txs[1] as { slot: number }).slot, 20, "the refused one came from the retry");
  } finally {
    net.restore();
  }
});

test("RPC: a transaction that never becomes readable gives null after a few tries, not an exception", async () => {
  const net = stubFetch((_url, body) => rpcReply(body, (id) => ({ jsonrpc: "2.0", id, result: null })));
  try {
    assert.equal(await fetchParsedOne("missing"), null);
    assert.equal(net.calls.length, 4);
  } finally {
    net.restore();
  }
});

test("RPC: a server error (500) and a network failure don't crash the reader", async () => {
  const down = stubFetch(() => new Response("oops", { status: 500 }));
  try {
    assert.equal(await fetchParsedOne("x"), null);
  } finally {
    down.restore();
  }
  const offline = stubFetch(() => Promise.reject(new TypeError("fetch failed")));
  try {
    assert.equal(await fetchParsedOne("x"), null);
  } finally {
    offline.restore();
  }
});

test("HTTP: server errors and 429s are retried; other client errors fail at once", async () => {
  let n = 0;
  const flaky = stubFetch(() => (++n === 1 ? new Response("down", { status: 503 }) : { ok: true }));
  try {
    assert.deepEqual(await fetchJson("https://api.example.com/x", { retries: 2 }), { ok: true });
    assert.equal(flaky.calls.length, 2);
  } finally {
    flaky.restore();
  }
  const missing = stubFetch(() => new Response("nope", { status: 404 }));
  try {
    await assert.rejects(fetchJson("https://api.example.com/y", { retries: 3 }), (e: unknown) => e instanceof HttpError && e.status === 404);
    assert.equal(missing.calls.length, 1);
  } finally {
    missing.restore();
  }
  const limited = stubFetch(() => new Response("later", { status: 429 }));
  try {
    await assert.rejects(fetchJson("https://api.example.com/z", { retries: 2 }));
    assert.equal(limited.calls.length, 3);
  } finally {
    limited.restore();
  }
});

// ---- Simulation check before signing ----
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const wallet = Keypair.generate().publicKey;
const MINT = Keypair.generate().publicKey;
const tx = new VersionedTransaction(new TransactionMessage({ payerKey: wallet, recentBlockhash: "11111111111111111111111111111111", instructions: [] }).compileToV0Message());
const tokenData = (amount: bigint) => {
  const b = Buffer.alloc(165);
  b.writeBigUInt64LE(amount, 64);
  return b.toString("base64");
};
function conn(sim: { err?: unknown; postLamports: number; postTokens?: bigint }, preLamports = 10e9): Connection {
  return {
    getAccountInfo: async (k: PublicKey) => (k.equals(MINT) ? { owner: TOKEN_PROGRAM, data: Buffer.alloc(82) } : null),
    getBalance: async () => preLamports,
    simulateTransaction: async () => ({
      value: { err: sim.err ?? null, accounts: [{ lamports: sim.postLamports }, sim.postTokens === undefined ? null : { data: [tokenData(sim.postTokens), "base64"] }] },
    }),
  } as unknown as Connection;
}
const buyPlan = { side: "buy" as const, mint: MINT.toBase58(), inLamports: 100_000_000n, minTokensOut: 1_000n };

test("simulate: a buy that spends what was planned and gets the tokens passes", async () => {
  await simulateCheck(conn({ postLamports: 10e9 - 100_000_000 - 10_000, postTokens: 5_000n }), tx, wallet, buyPlan);
});

test("simulate: refuses a buy that would spend more than planned, or return fewer tokens than quoted", async () => {
  await assert.rejects(simulateCheck(conn({ postLamports: 10e9 - 500_000_000, postTokens: 5_000n }), tx, wallet, buyPlan), /would spend/);
  await assert.rejects(simulateCheck(conn({ postLamports: 10e9 - 100_000_000, postTokens: 10n }), tx, wallet, buyPlan), /would receive 10 tokens/);
});

test("simulate: refuses a failing simulation, and a sell that returns too little SOL", async () => {
  await assert.rejects(simulateCheck(conn({ err: { InstructionError: [0, "Custom"] }, postLamports: 0 }), tx, wallet, buyPlan), /simulation failed/);
  await assert.rejects(simulateCheck(conn({ postLamports: 10e9 + 1_000 }), tx, wallet, { side: "sell", minLamportsOut: 50_000_000n }), /would receive/);
  await simulateCheck(conn({ postLamports: 10e9 + 60_000_000 }), tx, wallet, { side: "sell", minLamportsOut: 50_000_000n });
});
