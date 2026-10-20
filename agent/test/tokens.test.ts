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

test("launch times keep the earliest known: Solana's first mint transaction beats a later pool", async () => {
  const { recordLaunch, cachedTokenInfo } = await import("../src/market/tokens");
  const db = openDb(":memory:");
  recordLaunch(db, "M2", "2026-10-18T10:00:00.000Z");
  recordLaunch(db, "M2", "2026-10-18T12:00:00.000Z"); // later: ignored
  assert.equal(cachedTokenInfo(db, "M2")!.pool_created_at, "2026-10-18T10:00:00.000Z");
  recordLaunch(db, "M2", "2026-10-18T09:00:00.000Z"); // earlier: wins
  assert.equal(cachedTokenInfo(db, "M2")!.pool_created_at, "2026-10-18T09:00:00.000Z");
  // GeckoTerminal's pool (2026-10-18T00:00Z in the fake network) is earlier still, so it would win; a later pool would not.
  (config as { shyftApiKey: string | undefined }).shyftApiKey = "test-key";
  fakeNetwork();
  recordLaunch(db, "M3", "2026-10-17T00:00:00.000Z");
  const t = await tokenInfo(db, "M3", { pool: true });
  assert.equal(t.pool_created_at, "2026-10-17T00:00:00.000Z");
  assert.equal(t.pool_address, "POOL");
  globalThis.fetch = realFetch;
});

test("RugCheck is asked once per token, even when it doesn't know the creator", async () => {
  (config as { shyftApiKey: string | undefined }).shyftApiKey = "test-key";
  fakeNetwork(); // RugCheck answers {data: []}: no creator
  const db = openDb(":memory:");
  const first = await tokenInfo(db, "M4", { creator: true });
  assert.equal(first.creator, "");
  const asked = calls.filter((u) => u.includes("rugcheck")).length;
  assert.equal(asked, 1);
  await tokenInfo(db, "M4", { creator: true });
  assert.equal(calls.filter((u) => u.includes("rugcheck")).length, 1);
  globalThis.fetch = realFetch;
});

test("a creator read from the mint's first transaction fills a gap but never overwrites one", async () => {
  const { recordLaunch, cachedTokenInfo } = await import("../src/market/tokens");
  const db = openDb(":memory:");
  recordLaunch(db, "M5", "2026-10-18T10:00:00.000Z", "CreatorA");
  assert.equal(cachedTokenInfo(db, "M5")!.creator, "CreatorA");
  recordLaunch(db, "M5", "2026-10-18T10:00:00.000Z", "CreatorB");
  assert.equal(cachedTokenInfo(db, "M5")!.creator, "CreatorA");
  db.prepare("UPDATE token_info SET creator = '' WHERE mint = 'M5'").run(); // RugCheck didn't know
  recordLaunch(db, "M5", "2026-10-18T10:00:00.000Z", "CreatorC");
  assert.equal(cachedTokenInfo(db, "M5")!.creator, "CreatorC");
});
