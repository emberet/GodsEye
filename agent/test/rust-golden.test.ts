// Ties the TypeScript parser to the shared fixtures the Rust port is tested against (rust/ingest/fixtures):
// if parse.ts or convert.ts changes behaviour, the goldens must be regenerated (npm run rust:fixtures -- golden)
// and the Rust crate must follow, or CI fails on one side.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { createServer } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import type { FixtureTx } from "../src/stream/fixture";
import { FIXTURE_DIR, FIXTURE_SETS, botOutput, readNdjson, tsOutput, type BotCase } from "../src/cli/rust-fixtures";
import { CompareStats, RustIngestClient, applyPrice, comparable, eventSwaps, type IngestEvent } from "../src/stream/rust-client";

const lines = (name: string) => readNdjson<unknown>(join(FIXTURE_DIR, name)).map((x) => JSON.stringify(x));

for (const set of FIXTURE_SETS) {
  test(`TS parser output equals the ${set} goldens`, () => {
    const fx = readNdjson<FixtureTx>(join(FIXTURE_DIR, `${set}.ndjson`));
    const golden = lines(`${set}.golden.ndjson`);
    assert.ok(fx.length > 0);
    assert.equal(fx.length, golden.length);
    fx.forEach((f, i) => assert.equal(tsOutput(f), golden[i], `${set} line ${i + 1}`));
  });
}

test("bot signs equal the goldens", () => {
  const cases = readNdjson<BotCase>(join(FIXTURE_DIR, "bot.ndjson"));
  const golden = lines("bot.golden.ndjson");
  assert.equal(cases.length, golden.length);
  cases.forEach((c, i) => assert.equal(botOutput(c), golden[i], `bot case ${i + 1}`));
});

// Events written by the Rust service (fixtures/<set>.events.ndjson, checked on the Rust side to be current) go through
// the rust-mode path (price applied in Node, or TS re-parse when needsPrice) and must equal what the TS stream produces.
for (const set of ["tests", "real"]) {
  test(`rust-mode events reproduce the TS results (${set})`, () => {
    const fx = readNdjson<FixtureTx>(join(FIXTURE_DIR, `${set}.ndjson`));
    const golden = readNdjson<unknown>(join(FIXTURE_DIR, `${set}.golden.ndjson`));
    const events = readNdjson<IngestEvent>(join(FIXTURE_DIR, `${set}.events.ndjson`));
    // One event per converted transaction, in fixture order (signatures can repeat in the hand-written set).
    let next = 0;
    let checked = 0;
    fx.forEach((f, i) => {
      if (golden[i] === null) return;
      const e = events[next++];
      assert.equal(e?.signature, f.info.signature, `event for ${set} line ${i + 1}`);
      const price = f.solUsd;
      const got = eventSwaps(e, { solUsdAt: () => price }).flatMap((x) => x.swaps);
      assert.equal(JSON.stringify(got), JSON.stringify(golden[i]), `${set} line ${i + 1}`);
      checked++;
    });
    assert.equal(next, events.length);
    assert.ok(checked > 0);
  });
}

test("applyPrice matches the parser's arithmetic", () => {
  const s = { solAmount: 0.3, ts: "2026-10-27T00:00:00.000Z", solUsd: null, usdAmount: null } as never;
  assert.deepEqual(applyPrice([s], () => 187.25).map((x) => [x.solUsd, x.usdAmount]), [[187.25, 0.3 * 187.25]]);
  assert.deepEqual(applyPrice([s], () => null).map((x) => [x.solUsd, x.usdAmount]), [[null, null]]);
  assert.deepEqual(applyPrice([s]).map((x) => [x.solUsd, x.usdAmount]), [[null, null]]);
});

test("compare stats: matches, differences, one-sided and needsPrice", () => {
  const c = new CompareStats(1000, 2);
  c.add("ts", "a", "[1]", 0);
  c.add("rust", "a", "[1]", 1);
  c.add("rust", "b", "[2]", 0);
  c.add("ts", "b", "[3]", 2);
  c.add("ts", "c", "[]", 0);
  c.add("rust", "d", null, 0);
  c.add("ts", "d", "[9]", 0);
  c.add("rust", "e", "[]", 0);
  c.expire(5000);
  assert.deepEqual([c.matched, c.same, c.differ, c.tsOnly, c.rustOnly, c.skippedNeedsPrice], [2, 1, 1, 1, 1, 1]);
  const r = c.report()!;
  assert.match(r, /2 matched, 1 identical, 1 different, 1 TS-only, 1 Rust-only, 1 needsPrice skipped/);
  assert.match(r, /b\n {2}ts: {3}\[3\]\n {2}rust: \[2\]/);
  assert.equal(c.report(), null);
});

test("comparable ignores ts and price fields only", () => {
  const a = { wallet: "w", ts: "x", solUsd: 1, usdAmount: 2, solAmount: 3 } as never;
  const b = { wallet: "w", ts: "y", solUsd: null, usdAmount: null, solAmount: 3 } as never;
  assert.equal(comparable([a]), comparable([b]));
  assert.notEqual(comparable([a]), comparable([{ ...(b as object), solAmount: 4 } as never]));
});

test("socket client reads NDJSON events, split across chunks, and skips bad lines", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "ge-")), "s.sock");
  const ev = readNdjson<IngestEvent>(join(FIXTURE_DIR, "tests.events.ndjson")).slice(0, 3);
  const text = ev.map((e) => JSON.stringify(e)).join("\n") + "\nnot json\n" + JSON.stringify({ ...ev[0], v: 99 }) + "\n";
  const server = createServer((s) => {
    s.write(text.slice(0, 50));
    setTimeout(() => s.end(text.slice(50)), 20);
  });
  await new Promise<void>((r) => server.listen(path, r));
  const got: string[] = [];
  const client = new RustIngestClient(path, (e) => got.push(e.signature));
  client.start();
  for (let i = 0; i < 100 && got.length < 3; i++) await new Promise((r) => setTimeout(r, 10));
  client.stop();
  server.close();
  assert.deepEqual(got, ev.map((e) => e.signature));
  assert.equal(client.badLines, 2);
});
