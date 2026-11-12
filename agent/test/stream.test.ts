import { test } from "node:test";
import assert from "node:assert/strict";
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";
import { type DB, getMeta, openDb, setMeta } from "@godseye/shared";
import { parseSwap, type ParsedSwap } from "../src/chain/parse";
import type { LeaderWatcher } from "../src/copy/watcher";
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

test("retryPlan: allowlist rejections retry at a steady pace, other errors back off", async () => {
  const { retryPlan } = await import("../src/stream/stream");
  const ip = retryPlan("failed to open subscribe stream: client IP 103.101.213.9 is not whitelisted", 32_000, 10_000);
  assert.deepEqual(ip, { ip: "103.101.213.9", delayMs: 10_000, nextBackoffMs: 1_000 });
  const tok = retryPlan("failed to open subscribe stream: token not found", 4_000, 10_000);
  assert.deepEqual(tok, { ip: null, delayMs: 4_000, nextBackoffMs: 8_000 });
  assert.equal(retryPlan("gRPC transport error", 60_000, 10_000).nextBackoffMs, 60_000);
});

test("IpHunt: logs the first rejection, then one summary per 10 minutes", async () => {
  const { IpHunt } = await import("../src/stream/stream");
  const h = new IpHunt();
  const t0 = 1_000_000;
  assert.match(h.note("1.1.1.1", t0) ?? "", /turned away IP 1\.1\.1\.1/);
  let logged = 0;
  for (let i = 1; i < 60; i++) if (h.note(i % 2 ? "2.2.2.2" : "1.1.1.1", t0 + i * 10_000)) logged++;
  assert.equal(logged, 0, "quiet inside the first 10 minutes");
  const summary = h.note("3.3.3.3", t0 + 600_000);
  assert.match(summary ?? "", /61 tries, 3 different IPs in 10 min/);
  assert.equal(h.reset(t0 + 660_000), "after 61 tries over 11 min");
  assert.equal(h.reset(t0 + 700_000), null);
  assert.match(h.note("4.4.4.4", t0 + 800_000) ?? "", /turned away/);
});

const MIN = 60_000;

test("Silence: down after ten quiet minutes, told once a minute, back with how long it lasted", async () => {
  const { Silence } = await import("../src/stream/stream");
  const t0 = Date.parse("2026-11-12T10:00:00.000Z");
  const s = new Silence(t0);
  assert.equal(s.note(0, "", t0 + 9 * MIN), null, "nine quiet minutes are not an outage");
  assert.equal(s.note(4, "", t0 + 9.5 * MIN), null, "data, and no outage before it: nothing to tell");
  assert.equal(s.note(0, "", t0 + 19 * MIN), null, "the ten minutes count from the last data");
  const began = new Date(t0 + 9.5 * MIN).toISOString();
  assert.deepEqual(s.note(0, "", t0 + 19.5 * MIN), { state: "down", since: began, forMs: 10 * MIN });
  assert.equal(s.note(0, began, t0 + 19.75 * MIN), null, "not again inside the minute");
  assert.deepEqual(s.note(0, began, t0 + 20.5 * MIN), { state: "down", since: began, forMs: 11 * MIN });
  assert.deepEqual(s.note(7, began, t0 + 25 * MIN), { state: "back", since: "", forMs: 15.5 * MIN });
  assert.equal(s.note(0, "", t0 + 30 * MIN), null, "a new silence gets its own ten minutes");
});

test("Silence: after a restart the stored start still counts", async () => {
  const { Silence } = await import("../src/stream/stream");
  const t0 = Date.parse("2026-11-12T10:00:00.000Z");
  const began = new Date(t0 - 3 * 24 * 60 * MIN).toISOString(); // quiet for three days when the agent came up
  const s = new Silence(t0);
  assert.equal(s.note(0, began, t0 + 5 * MIN), null, "a fresh start waits its ten minutes before it says anything");
  assert.deepEqual(s.note(0, began, t0 + 10 * MIN), { state: "down", since: began, forMs: 3 * 24 * 60 * MIN + 10 * MIN });
  assert.deepEqual(s.note(2, began, t0 + 11 * MIN), { state: "back", since: "", forMs: 3 * 24 * 60 * MIN + 11 * MIN });
  assert.equal(new Silence(t0).note(2, "not a time", t0 + MIN), null, "a stored value that is no time counts as none");
});

test("live stream: the owner hears when it goes quiet and when it is back; a stream that was stopped tells nothing", async () => {
  const { LiveStream } = await import("../src/stream/stream");
  const { ensureRunnerTables } = await import("../src/runners/schema");
  const { attachLogDb } = await import("../src/log");
  const watcher = { marketSwap: () => {}, isWatching: () => false, handleStreamed: async () => {} } as unknown as LeaderWatcher;
  const build = (): { db: DB; live: InstanceType<typeof LiveStream>; inner: { stats: { txs: number }; silence: { lastDataAt: number } } } => {
    const db = openDb(":memory:");
    ensureRunnerTables(db);
    const live = new LiveStream(db, watcher);
    return { db, live, inner: live as unknown as { stats: { txs: number }; silence: { lastDataAt: number } } };
  };
  const about = (db: DB, kind: string): string | undefined => (JSON.parse(getMeta(db, `alert_${kind}`) ?? "{}") as { about?: string }).about;
  const logged = (db: DB): string[] => (db.prepare("SELECT message FROM agent_log ORDER BY id").all() as { message: string }[]).map((r) => r.message);

  const { db, live, inner } = build();
  attachLogDb(db);
  try {
    live.flush();
    assert.equal(getMeta(db, "stream_silent_since"), null, "just started: no outage yet");
    assert.equal(getMeta(db, "alert_stream_down"), null);

    const quietFrom = Date.now() - 11 * MIN;
    inner.silence.lastDataAt = quietFrom;
    setMeta(db, "stream_status", "waiting_for_ip");
    live.flush();
    const since = getMeta(db, "stream_silent_since") ?? "";
    assert.equal(Date.parse(since), quietFrom, "the silence is stored from the last data on");
    assert.equal(about(db, "stream_down"), since);
    assert.deepEqual(logged(db), ["Owner alert (stream_down): The live stream has delivered nothing for 11 minutes (status: waiting_for_ip). No new swaps are seen while it lasts."]);

    inner.stats.txs = 3;
    live.flush();
    assert.equal(getMeta(db, "stream_silent_since"), "", "data clears the stored silence");
    assert.equal(about(db, "stream_back"), since);
    assert.equal(logged(db)[1], "Owner alert (stream_back): The live stream is delivering again after 11 minutes of silence.");
    assert.equal(logged(db).length, 2);

    const off = build();
    off.inner.silence.lastDataAt = Date.now() - 60 * MIN;
    off.live.stop();
    assert.equal(getMeta(off.db, "stream_silent_since"), null, "switched off is not down");
    assert.equal(getMeta(off.db, "alert_stream_down"), null);
    assert.equal(getMeta(off.db, "stream_status"), "stopped");
  } finally {
    attachLogDb(null as unknown as DB);
  }
});
