import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "@godseye/shared";

process.env.GT_MIN_GAP_MS = "20";
const { config } = await import("../src/config");
const { tokenInfo } = await import("../src/market/tokens");
const { fetchTokenLaunch, fetchTopPools } = await import("../src/market/geckoterminal");

const calls: string[] = [];
const realFetch = globalThis.fetch;
function fakeNetwork() {
  calls.length = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
    if (url.includes("api.shyft.to")) return json({ success: true, result: { symbol: "MEOW", name: "Meow", decimals: 6 } });
    if (url.includes("/tokens/") && url.includes("/pools")) {
      return json({ data: [{ id: "p", attributes: { name: "MEOW / SOL", address: "POOL", pool_created_at: "2026-10-18T00:00:00Z", reserve_in_usd: "1000", base_token_price_usd: "1", fdv_usd: "1", market_cap_usd: null, price_change_percentage: {}, volume_usd: {}, transactions: {} }, relationships: { base_token: { data: { id: "solana_MINT" } }, quote_token: { data: { id: "solana_So11111111111111111111111111111111111111112" } } } }] });
    }
    return json({ data: [] });
  }) as typeof fetch;
}

test("token names come from Shyft; GeckoTerminal only when analysis asks for the launch time", async () => {
  (config as { shyftApiKey: string | undefined }).shyftApiKey = "test-key";
  fakeNetwork();
  const db = openDb(":memory:");
  const named = await tokenInfo(db, "MINT");
  assert.equal(named.symbol, "MEOW");
  assert.equal(named.decimals, 6);
  assert.equal(named.launch_checked_at, null);
  assert.ok(calls.every((u) => u.includes("api.shyft.to")), calls.join("\n"));

  const launched = await tokenInfo(db, "MINT", { launch: true });
  assert.equal(launched.pool_created_at, "2026-10-18T00:00:00Z");
  assert.equal(launched.pool_address, "POOL");
  const before = calls.length;
  await tokenInfo(db, "MINT", { launch: true }); // known now: no new calls
  assert.equal(calls.length, before);
  globalThis.fetch = realFetch;
});

test("GeckoTerminal: analysis lookups go ahead of background calls", async () => {
  fakeNetwork();
  const done: string[] = [];
  const bg = [fetchTopPools(1).then(() => done.push("top1")), fetchTopPools(1).then(() => done.push("top2"))];
  const hi = fetchTokenLaunch("MINT", "high").then(() => done.push("launch"));
  await Promise.all([...bg, hi]);
  // The first background call was already running; the launch lookup beats the second one.
  assert.deepEqual(done, ["top1", "launch", "top2"]);
  globalThis.fetch = realFetch;
});
