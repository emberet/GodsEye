import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "@godseye/shared";
import { stubFetch } from "./helpers";
import { config, copyRpcUrl, rpcUrl } from "../src/config";
import { fetchParsed, fetchParsedOne } from "../src/chain/history";
import { LeaderWatcher, within } from "../src/copy/watcher";
import type { CopyEngine } from "../src/copy/engine";

const LEADER = "So11111111111111111111111111111111111111112";

test("a call that never answers gives up with the fallback after the time limit", async () => {
  const t0 = Date.now();
  assert.deepEqual(await within(new Promise<string[]>(() => undefined), 50, []), []);
  assert.ok(Date.now() - t0 < 1_000);
  assert.equal(await within(Promise.reject(new Error("x")), 50, "fallback"), "fallback");
  assert.equal(await within(Promise.resolve("ok"), 50, "fallback"), "ok");
});

test("watcher sync never waits on a hung RPC: the learning loop carries on", async () => {
  const stub = stubFetch(() => new Promise<never>(() => undefined));
  try {
    const watcher = new LeaderWatcher(openDb(":memory:"), {} as CopyEngine, { logs: false, callMs: 50 });
    const t0 = Date.now();
    await watcher.sync([LEADER]);
    assert.ok(Date.now() - t0 < 2_000, `sync took ${Date.now() - t0} ms`);
    assert.deepEqual(watcher.watching, [LEADER], "still watched (by the poll and the stream)");
    await watcher.sync([]);
    assert.deepEqual(watcher.watching, []);
  } finally {
    stub.restore();
  }
});

test("copy-path reads use COPY_RPC_URL (else Helius), wallet history stays on the main RPC", async () => {
  assert.equal(copyRpcUrl(), rpcUrl(), "nothing set: the main RPC");
  config.heliusApiKey = "k";
  assert.match(copyRpcUrl(), /^https:\/\/mainnet\.helius-rpc\.com\//);
  config.copyRpcUrl = "http://copy-rpc.test/";
  const stub = stubFetch((_url, body) => {
    const reply = (b: { id: number }) => ({ jsonrpc: "2.0", id: b.id, result: { slot: 1 } });
    return Array.isArray(body) ? body.map(reply) : reply(body as { id: number });
  });
  try {
    await fetchParsedOne("sig1");
    assert.equal(new URL(stub.calls.at(-1)!.url).host, "copy-rpc.test", "a leader's transaction");
    await fetchParsed(["sig2", "sig3"]);
    assert.equal(new URL(stub.calls.at(-1)!.url).host, "127.0.0.1:9", "history reads");
  } finally {
    stub.restore();
    config.copyRpcUrl = "";
    config.heliusApiKey = "";
  }
});

test("wallets flagged as bots aren't tracked swap by swap, unless GodsEye copies them", async () => {
  const { NOT_A_BOT } = await import("../src/stream/stream");
  const db = openDb(":memory:");
  const add = db.prepare("INSERT INTO wallets (address, first_seen_at, discovered_via, junk_reason, copy_weight) VALUES (?, '2026-10-29', 'test', ?, ?)");
  add.run("OK", null, 0);
  add.run("LOSER", "copy replay: copying it 5 s late made a median -3%", 0);
  add.run("BOT", "bot: median hold 6 s (under 15 s can't be copied)", 0);
  add.run("COPIED_BOT", "bot: 30 transactions an hour (over 20)", 0.1);
  const rows = db.prepare(`SELECT address FROM wallets WHERE ${NOT_A_BOT} ORDER BY address`).all() as { address: string }[];
  assert.deepEqual(rows.map((r) => r.address), ["COPIED_BOT", "LOSER", "OK"]);
});

test("watcher poll never waits on a hung RPC: the leader poll job finishes", async () => {
  const stub = stubFetch(() => new Promise<never>(() => undefined));
  try {
    const watcher = new LeaderWatcher(openDb(":memory:"), {} as CopyEngine, { logs: false, callMs: 50 });
    await watcher.sync([LEADER]);
    const t0 = Date.now();
    await watcher.poll();
    assert.ok(Date.now() - t0 < 2_000, `poll took ${Date.now() - t0} ms`);
    assert.deepEqual(watcher.watching, [LEADER]);
  } finally {
    stub.restore();
  }
});
