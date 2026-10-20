import { test } from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config";
import { rpcUsage, takeRpc } from "../src/chain/rpc-budget";

test("history RPC is spread out at RPC_MAX_RPS and counted", async () => {
  (config as { rpcMaxRps: number }).rpcMaxRps = 100;
  const t0 = Date.now();
  await takeRpc(50); // first batch goes at once and books 0.5 s
  await takeRpc(50); // second waits for that 0.5 s
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= 450 && elapsed < 1500, `took ${elapsed} ms`);
  assert.equal(rpcUsage(60).calls, 100);
});

test("rate-limited RPC answers are counted for the hourly report", async () => {
  const { noteThrottled } = await import("../src/chain/rpc-budget");
  const before = rpcUsage(60).throttled;
  noteThrottled();
  noteThrottled();
  assert.equal(rpcUsage(60).throttled - before, 2);
});

test("the running total never shrinks, so long runs measure correctly", async () => {
  const { rpcCallsSoFar } = await import("../src/chain/rpc-budget");
  const a = rpcCallsSoFar();
  await takeRpc(3);
  assert.equal(rpcCallsSoFar() - a, 3);
});
