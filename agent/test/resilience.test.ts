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
import { overheadLamports, simulateCheck } from "../src/copy/verify";
import { stubFetch } from "./helpers";
import { config } from "../src/config";

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

test("RPC: with HISTORY_TX_RPC_URL, transactions come from it first; what it refuses or lacks comes from SOLANA_RPC_URL", async () => {
  const before = config.historyTxRpcUrl;
  config.historyTxRpcUrl = "https://tx.example/";
  const net = stubFetch((url, body) =>
    String(url).startsWith("https://tx.example/")
      ? rpcReply(body, (id) => (id === 1 ? { jsonrpc: "2.0", id, error: { message: "ERPC request failed" } } : { jsonrpc: "2.0", id, result: id === 3 ? null : { ...TX, slot: id } }))
      : rpcReply(body, (id) => ({ jsonrpc: "2.0", id, result: { ...TX, slot: 100 + id } })),
  );
  try {
    const txs = (await fetchParsed(["a", "b", "c", "d"])) as { slot: number }[];
    assert.deepEqual(txs.map((t) => t.slot), [0, 100, 2, 101], "b (refused) and d (missing) came from the main RPC, in order");
    assert.equal(net.calls.length, 2);
    assert.ok(!String(net.calls[1].url).startsWith("https://tx.example/"));
    assert.equal((net.calls[1].body as unknown[]).length, 2, "only the two it lacked");
  } finally {
    net.restore();
    config.historyTxRpcUrl = before;
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
/** Another token the wallet holds: its balance before, and after the simulated swap (null = the account is gone). */
type Held = { account: PublicKey; mint: string; pre: bigint; post: bigint | null };
function conn(sim: { err?: unknown; postLamports: number; postTokens?: bigint }, preLamports = 10e9, held: Held[] | "fail" = []): Connection {
  return {
    getAccountInfo: async (k: PublicKey) => (k.equals(MINT) ? { owner: TOKEN_PROGRAM, data: Buffer.alloc(82) } : null),
    getBalance: async () => preLamports,
    getParsedTokenAccountsByOwner: async (_owner: PublicKey, f: { programId: PublicKey }) => {
      if (held === "fail") throw new Error("rpc down");
      const mine = f.programId.equals(TOKEN_PROGRAM) ? held : [];
      return { value: mine.map((h) => ({ pubkey: h.account, account: { data: { parsed: { info: { mint: h.mint, tokenAmount: { amount: String(h.pre) } } } } } })) };
    },
    simulateTransaction: async (_tx: unknown, o: { accounts: { addresses: string[] } }) => ({
      value: {
        err: sim.err ?? null,
        accounts: o.accounts.addresses.map((a, i) => {
          if (i === 0) return { lamports: sim.postLamports };
          const h = held === "fail" ? undefined : held.find((x) => x.account.toBase58() === a);
          if (h) return h.post === null ? null : { data: [tokenData(h.post), "base64"] };
          return sim.postTokens === undefined ? null : { data: [tokenData(sim.postTokens), "base64"] };
        }),
      },
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
  await assert.rejects(simulateCheck(conn({ postLamports: 10e9 + 1_000 }), tx, wallet, { side: "sell", mint: MINT.toBase58(), minLamportsOut: 50_000_000n }), /would receive/);
  await simulateCheck(conn({ postLamports: 10e9 + 60_000_000 }), tx, wallet, { side: "sell", mint: MINT.toBase58(), minLamportsOut: 50_000_000n });
});

test("simulate: the SOL slack is rent and fees at their caps, not a flat 0.01 SOL", async () => {
  const room = overheadLamports(1_000_000);
  assert.ok(room < 5_000_000, `${room}`);
  await simulateCheck(conn({ postLamports: 10e9 - 100_000_000 - 3_000_000, postTokens: 5_000n }), tx, wallet, buyPlan);
  await assert.rejects(simulateCheck(conn({ postLamports: 10e9 - 100_000_000 - 8_000_000, postTokens: 5_000n }), tx, wallet, buyPlan), /would spend/);
  // A tip is part of the room only when one is allowed.
  await simulateCheck(conn({ postLamports: 10e9 - 100_000_000 - 4_300_000, postTokens: 5_000n }), tx, wallet, buyPlan, { overheadLamports: overheadLamports(1_000_000, 200_000) });
});

test("simulate: every other token the wallet holds is watched; a swap that takes any of them, or an unreadable wallet, is refused", async () => {
  const other = { account: Keypair.generate().publicKey, mint: Keypair.generate().publicKey.toBase58(), pre: 700n };
  const ok = { postLamports: 10e9 - 100_000_000, postTokens: 5_000n };
  await simulateCheck(conn(ok, 10e9, [{ ...other, post: 700n }]), tx, wallet, buyPlan);
  await assert.rejects(simulateCheck(conn(ok, 10e9, [{ ...other, post: 100n }]), tx, wallet, buyPlan), /another of the wallet's holdings/);
  await assert.rejects(simulateCheck(conn(ok, 10e9, [{ ...other, post: null }]), tx, wallet, buyPlan), /another of the wallet's holdings/);
  await assert.rejects(simulateCheck(conn(ok, 10e9, "fail"), tx, wallet, buyPlan), /couldn't read the wallet's other tokens/);
  // The coin being sold is the one that goes down: it isn't counted against the sell.
  const sold = { account: Keypair.generate().publicKey, mint: MINT.toBase58(), pre: 5_000n, post: 0n };
  await simulateCheck(conn({ postLamports: 10e9 + 60_000_000 }, 10e9, [sold]), tx, wallet, { side: "sell", mint: MINT.toBase58(), minLamportsOut: 50_000_000n });
});
