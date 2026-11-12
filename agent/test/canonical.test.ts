/**
 * PumpSwap pools opened by pump.fun's own migration versus pools anyone else opened (pools/canonical.ts), and the buy
 * route check built on it. Made-up keys and a stubbed RPC: nothing reaches the network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import { isCanonicalPumpPool, migrationAuthority, strangePumpPools } from "../src/pools/canonical";
import { POOL_PROGRAMS } from "../src/pools/state";
import { stubFetch } from "./helpers";

const key = () => Keypair.generate().publicKey.toBase58();
/** A PumpSwap pool account: its creator at byte 11 and its coin at byte 43 (301 bytes, as on chain). */
function poolData(creator: string, coin: string): Buffer {
  const d = Buffer.alloc(301);
  new PublicKey(creator).toBuffer().copy(d, 11);
  new PublicKey(coin).toBuffer().copy(d, 43);
  return d;
}
const leg = (label: string, ammKey: string) => ({ swapInfo: { label, ammKey } });

test("a pool opened by pump.fun's migration is told apart from one opened by anyone else", () => {
  const coin = key();
  assert.equal(isCanonicalPumpPool(poolData(migrationAuthority(coin), coin)), true);
  assert.equal(isCanonicalPumpPool(poolData(key(), coin)), false, "someone else's pool");
  assert.equal(isCanonicalPumpPool(poolData(migrationAuthority(key()), coin)), false, "the authority of another coin");
  assert.equal(isCanonicalPumpPool(Buffer.alloc(40)), false);
});

test("route check: counts the PumpSwap pools the migration didn't open; asks nothing when the route has none; throws when it can't read them", async () => {
  const coin = key();
  const good = key(), bad = key();
  const accounts: Record<string, { owner: string; data: [string, string] } | null> = {
    [good]: { owner: POOL_PROGRAMS.PUMP_AMM, data: [poolData(migrationAuthority(coin), coin).toString("base64"), "base64"] },
    [bad]: { owner: POOL_PROGRAMS.PUMP_AMM, data: [poolData(key(), coin).toString("base64"), "base64"] },
  };
  const net = stubFetch((_url, body) => {
    const pools = (body as { params: [string[]] }).params[0];
    return { jsonrpc: "2.0", id: 1, result: { value: pools.map((p) => accounts[p] ?? null) } };
  });
  try {
    assert.equal(await strangePumpPools([leg("Pump.fun Amm", good)]), 0);
    assert.equal(await strangePumpPools([leg("Meteora DLMM", key()), leg("Pump.fun Amm", bad)]), 1);
    assert.equal(await strangePumpPools([leg("Pump.fun Amm", key())]), 1, "an account that isn't there is not a migrated pool");
    const asked = net.calls.length;
    assert.equal(await strangePumpPools([leg("Pump.fun", key()), leg("Raydium CPMM", key())]), 0);
    assert.equal(net.calls.length, asked, "no PumpSwap pool on the route: nothing read");
  } finally {
    net.restore();
  }
  const down = stubFetch(() => new Response("no", { status: 503 }));
  try {
    await assert.rejects(strangePumpPools([leg("Pump.fun Amm", good)]));
  } finally {
    down.restore();
  }
});
