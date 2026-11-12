/**
 * Posts over a hold, in shadow (x/holds.ts): one count per closed position, stored next to how it ended; a stop from
 * X ends the run. Made-up coins, a stubbed X, an in-memory database.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "@godseye/shared";
import { stubFetch } from "./helpers";

process.env.X_BEARER_TOKEN = "test-token";
process.env.X_MONTHLY_USD = "600";
const { countHolds } = await import("../src/x/holds");

test("hold counts: each recently closed position once, over its own hold, with how it ended", async () => {
  const db = openDb(":memory:");
  const now = Date.now();
  const at = (h: number) => new Date(now - h * 3_600_000).toISOString();
  const pos = db.prepare(
    `INSERT INTO positions (mint, symbol, leader, mode, status, token_amount, tokens_bought, cost_sol, entry_price_sol, opened_at, closed_at, pnl_sol, pnl_pct, decider)
     VALUES (?, 'MOO', 'L', 'real', 'closed', 0, 1, 0.1, 0.001, ?, ?, 0.01, ?, ?)`,
  );
  pos.run("MintA", at(5), at(4), 10, "rules");
  pos.run("MintB", at(3), at(2), -20, "brain");
  pos.run("MintOld", at(24 * 9), at(24 * 8), 5, "rules"); // closed over a week ago: left alone
  const asked: string[] = [];
  const net = stubFetch((url) => {
    const u = new URL(url);
    if (u.pathname !== "/2/tweets/counts/all") return undefined;
    asked.push(`${u.searchParams.get("query")} ${u.searchParams.get("start_time")}`);
    return { meta: { total_tweet_count: u.searchParams.get("query")!.includes("MintA") ? 12 : 0 } };
  });
  try {
    assert.deepEqual(await countHolds(db, now), { counted: 2 });
    assert.deepEqual(await countHolds(db, now), { counted: 0 }, "never twice");
  } finally {
    net.restore();
  }
  assert.equal(asked.length, 2);
  assert.ok(asked.some((q) => q.includes("MintA") && q.endsWith(at(5))), "from the position's own open");
  const rows = db.prepare("SELECT mint, posts, pnl_pct, decider FROM x_hold_counts ORDER BY mint").all();
  assert.deepEqual(rows, [{ mint: "MintA", posts: 12, pnl_pct: 10, decider: "rules" }, { mint: "MintB", posts: 0, pnl_pct: -20, decider: "brain" }]);
});

test("hold counts: X refusing reads ends the run with nothing stored", async () => {
  const db = openDb(":memory:");
  const now = Date.now();
  db.prepare(`INSERT INTO positions (mint, leader, mode, status, token_amount, tokens_bought, cost_sol, entry_price_sol, opened_at, closed_at, pnl_sol)
              VALUES ('MintC', 'L', 'real', 'closed', 0, 1, 0.1, 0.001, ?, ?, 0)`).run(new Date(now - 7_200_000).toISOString(), new Date(now - 3_600_000).toISOString());
  const net = stubFetch(() => new Response(JSON.stringify({ title: "CreditsDepleted" }), { status: 402 }));
  const print = console.log;
  console.log = () => undefined;
  try {
    const r = await countHolds(db, now);
    assert.equal(r.counted, 0);
    assert.ok(r.stop, "stopped");
  } finally {
    console.log = print;
    net.restore();
  }
  assert.equal((db.prepare("SELECT COUNT(*) n FROM x_hold_counts").get() as { n: number }).n, 0);
});
