import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, SOL_MINT, type DB } from "@godseye/shared";
import { closeMissing } from "../src/copy/fills";
import { GIVE_UP_MS, settleMissing, sweepWallet } from "../src/copy/recovery";
import { chainTrade, FakeChain, fakeSignature } from "./helpers";

const MIN = 60_000;
const T0 = Date.now();
const now = () => new Date().toISOString();
const near = (a: number | null | undefined, b: number) => typeof a === "number" && Math.abs(a - b) < 1e-9;
let n = 0;
const mint = () => `Mint${String(++n).padStart(39, "1")}`;

const setup = () => ({ db: openDb(":memory:"), chain: new FakeChain() });

/** A real position in `m`: 100 tokens bought for 0.1 SOL, open unless told otherwise. */
function position(db: DB, m: string, status: "open" | "closed" = "open"): number {
  const r = db
    .prepare(
      `INSERT INTO positions (mint, symbol, leader, mode, status, token_amount, tokens_bought, cost_sol, entry_price_sol, opened_at)
       VALUES (?, 'X', 'LEADER', 'real', ?, 100, 100, 0.1, 0.001, ?)`,
    )
    .run(m, status, now());
  return Number(r.lastInsertRowid);
}

/** A real trade of GodsEye's own, as an earlier pass or an earlier version left it. */
function trade(
  db: DB,
  o: { mint: string; side: "buy" | "sell"; status: "pending" | "filled" | "failed"; signature?: string; error?: string; positionId?: number; tokens?: number; reason?: string },
): number {
  const r = db
    .prepare(
      `INSERT INTO copy_trades (leader, leader_signature, leader_ts, mint, symbol, side, mode, status, reason, weight, size_sol, token_amount, signature, error, position_id, created_at)
       VALUES ('LEADER', ?, ?, ?, 'X', ?, 'real', ?, ?, 0.5, ?, ?, ?, ?, ?, ?)`,
    )
    .run(`lead${++n}`, now(), o.mint, o.side, o.status, o.reason ?? null, o.side === "buy" ? 0.1 : null, o.tokens ?? null, o.signature ?? null, o.error ?? null, o.positionId ?? null, now());
  return Number(r.lastInsertRowid);
}

interface PosRow { id: number; status: string; token_amount: number; cost_sol: number; proceeds_sol: number; pnl_sol: number | null; exit_reason: string | null; closed_at: string | null }
interface TradeRow { id: number; side: string; status: string; leader_signature: string; signature: string | null; error: string | null; position_id: number | null; token_amount: number | null }
const pos = (db: DB, id: number) => db.prepare("SELECT * FROM positions WHERE id=?").get(id) as PosRow;
const tradeRow = (db: DB, id: number) => db.prepare("SELECT * FROM copy_trades WHERE id=?").get(id) as TradeRow;
const count = (db: DB, sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as { n: number }).n;
const reads = (chain: FakeChain) => chain.calls.filter((c) => c.startsWith("trade "));

/** One missing-position check at `at`. `held`: what the wallet holds of every coin (null: it can't be read). */
const check = (db: DB, chain: FakeChain, at: number, held: number | null = 0) => settleMissing(db, chain, { held: async () => held, now: at });
const NONE = { sold: 0, closed: 0 };

/** One wallet sweep. `holdings`: every token in the wallet (null: it can't be read). */
const sweep = (db: DB, chain: FakeChain, holdings: Record<string, number> | null, at?: number) =>
  sweepWallet(db, chain, { holdings: async () => (holdings ? new Map(Object.entries(holdings)) : null), now: at });
const ZERO = { opened: 0, reopened: 0, strays: 0 };

test("missing: a sell marked failed that had landed closes the position with its real proceeds", async () => {
  const { db, chain } = setup();
  const m = mint();
  const id = position(db, m);
  const sig = fakeSignature();
  const sell = trade(db, { mint: m, side: "sell", status: "failed", signature: sig, error: "expired: the transaction never landed", positionId: id, tokens: 100, reason: "stop-loss -20%" });
  chain.history.set(m, [{ signature: sig, atMs: Date.now() }]);
  chain.landed(sig, chainTrade("sell", sig, 0.07, 100, 0.001));
  assert.deepEqual(await check(db, chain, T0), { sold: 1, closed: 0 });
  const p = pos(db, id);
  assert.equal(p.status, "closed");
  assert.equal(p.token_amount, 0);
  assert.equal(p.proceeds_sol, 0.07);
  assert.ok(near(p.pnl_sol, -0.03));
  assert.equal(p.exit_reason, "stop-loss -20%");
  const row = tradeRow(db, sell);
  assert.equal(row.status, "filled");
  assert.match(row.error ?? "", /it had landed/);
  assert.deepEqual(await check(db, chain, T0 + MIN), NONE);
});

test("missing: sells nobody recorded are recorded oldest first, with their real proceeds", async () => {
  const { db, chain } = setup();
  const m = mint();
  const id = position(db, m);
  const t = Date.now();
  const [a, b] = [fakeSignature(), fakeSignature()];
  chain.history.set(m, [{ signature: b, atMs: t + 2000 }, { signature: a, atMs: t + 1000 }]); // newest first, as the chain lists them
  chain.trades.set(a, chainTrade("sell", a, 0.1, 60, undefined, t + 1000));
  chain.trades.set(b, chainTrade("sell", b, 0.05, 40, undefined, t + 2000));
  assert.deepEqual(await check(db, chain, T0), { sold: 2, closed: 0 });
  const p = pos(db, id);
  assert.equal(p.status, "closed");
  assert.ok(near(p.proceeds_sol, 0.15));
  assert.ok(near(p.pnl_sol, 0.05));
  assert.equal(p.exit_reason, "sold (found on chain)");
  const rows = db.prepare("SELECT * FROM copy_trades WHERE position_id=? ORDER BY id").all(id) as TradeRow[];
  assert.deepEqual(rows.map((r) => r.signature), [a, b]);
  assert.deepEqual(rows.map((r) => r.token_amount), [60, 40]);
  for (const r of rows) {
    assert.equal(r.side, "sell");
    assert.equal(r.status, "filled");
    assert.equal(r.error, "never recorded: found on chain");
    assert.ok(r.leader_signature.startsWith(`exit:${id}:`));
  }
});

test("missing: with no sell on chain, a position is closed only after three checks over ten minutes", async () => {
  const { db, chain } = setup();
  const id = position(db, mint());
  for (const at of [T0, T0 + 4 * MIN, T0 + 9 * MIN]) assert.deepEqual(await check(db, chain, at), NONE);
  assert.equal(pos(db, id).status, "open"); // three checks, but not ten minutes
  assert.deepEqual(await check(db, chain, T0 + 10 * MIN), { sold: 0, closed: 1 });
  const p = pos(db, id);
  assert.equal(p.status, "closed");
  assert.equal(p.exit_reason, "missing: wallet holds none");
  assert.equal(p.proceeds_sol, 0);
  assert.ok(near(p.pnl_sol, -0.1));

  // Ten minutes, but only two checks.
  const other = setup();
  const slow = position(other.db, mint());
  for (const at of [T0, T0 + 20 * MIN]) assert.deepEqual(await check(other.db, other.chain, at), NONE);
  assert.equal(pos(other.db, slow).status, "open");
  assert.deepEqual(await check(other.db, other.chain, T0 + 21 * MIN), { sold: 0, closed: 1 });
});

test("missing: a wallet or a history that can't be read never counts towards closing", async () => {
  const { db, chain } = setup();
  const id = position(db, mint());
  assert.deepEqual(await check(db, chain, T0, null), NONE);
  assert.equal(chain.calls.length, 0);
  chain.down.history = true;
  for (const at of [T0, T0 + 5 * MIN, T0 + 10 * MIN]) assert.deepEqual(await check(db, chain, at), NONE);
  chain.down.history = false;
  // Only readable checks count: two more leave it open, the third closes it.
  for (const at of [T0 + 11 * MIN, T0 + 12 * MIN]) assert.deepEqual(await check(db, chain, at), NONE);
  assert.equal(pos(db, id).status, "open");
  assert.deepEqual(await check(db, chain, T0 + 13 * MIN), { sold: 0, closed: 1 });
});

test("missing: tokens seen in the wallet again start the count over", async () => {
  const { db, chain } = setup();
  const id = position(db, mint());
  for (const at of [T0, T0 + 5 * MIN]) assert.deepEqual(await check(db, chain, at), NONE);
  assert.deepEqual(await check(db, chain, T0 + 6 * MIN, 100), NONE); // a lagging node had shown none
  for (const at of [T0 + 11 * MIN, T0 + 12 * MIN, T0 + 13 * MIN]) assert.deepEqual(await check(db, chain, at), NONE);
  assert.equal(pos(db, id).status, "open");
  assert.deepEqual(await check(db, chain, T0 + 21 * MIN), { sold: 0, closed: 1 });
});

test("missing: a position with a sell still pending is left to the settle step", async () => {
  const { db, chain } = setup();
  const m = mint();
  const id = position(db, m);
  trade(db, { mint: m, side: "sell", status: "pending", signature: fakeSignature(), positionId: id, tokens: 100 });
  for (const at of [T0, T0 + 5 * MIN, T0 + 10 * MIN, T0 + 15 * MIN]) assert.deepEqual(await check(db, chain, at), NONE);
  assert.equal(pos(db, id).status, "open");
  assert.equal(chain.calls.length, 0);
});

test("missing: a transaction that can't be read yet holds the close back", async () => {
  const { db, chain } = setup();
  const m = mint();
  const id = position(db, m);
  const sig = fakeSignature();
  chain.history.set(m, [{ signature: sig, atMs: null }]);
  chain.down.trade = true;
  for (const at of [T0, T0 + 5 * MIN, T0 + 10 * MIN, T0 + 15 * MIN]) assert.deepEqual(await check(db, chain, at), NONE);
  assert.equal(pos(db, id).status, "open"); // it may be the sell: nothing is closed on a guess
  chain.down.trade = false;
  chain.trades.set(sig, chainTrade("sell", sig, 0.2, 100));
  assert.deepEqual(await check(db, chain, T0 + 16 * MIN), { sold: 1, closed: 0 });
  assert.equal(pos(db, id).proceeds_sol, 0.2);

  // One that never becomes readable is passed over after the wait; the position is then closed with what is on record.
  const other = setup();
  const m2 = mint();
  const stuck = position(other.db, m2);
  other.chain.history.set(m2, [{ signature: fakeSignature(), atMs: null }]);
  other.chain.down.trade = true;
  assert.deepEqual(await check(other.db, other.chain, T0), NONE);
  const late = T0 + GIVE_UP_MS + 1;
  for (const at of [late, late + MIN]) assert.deepEqual(await check(other.db, other.chain, at), NONE);
  assert.deepEqual(await check(other.db, other.chain, late + 2 * MIN), { sold: 0, closed: 1 });
  assert.equal(pos(other.db, stuck).exit_reason, "missing: wallet holds none");
});

test("missing: only the position's own unrecorded sells are looked at", async () => {
  const { db, chain } = setup();
  const m = mint();
  const earlier = position(db, m, "closed");
  const id = position(db, m);
  const t = Date.now();
  const [old, buy, other, noise] = [fakeSignature(), fakeSignature(), fakeSignature(), fakeSignature()];
  // A sell from before this position was opened.
  chain.trades.set(old, chainTrade("sell", old, 0.3, 100, undefined, t - MIN));
  // Its own buy, recorded.
  trade(db, { mint: m, side: "buy", status: "filled", signature: buy, positionId: id });
  // A failed sell of the earlier position in the same coin.
  trade(db, { mint: m, side: "sell", status: "failed", signature: other, positionId: earlier, tokens: 100 });
  chain.trades.set(other, chainTrade("sell", other, 0.3, 100));
  // Tokens sent in by someone: no trade at all.
  chain.trades.set(noise, null);
  chain.history.set(m, [{ signature: noise, atMs: t }, { signature: other, atMs: null }, { signature: buy, atMs: t }, { signature: old, atMs: t - MIN }]);
  assert.deepEqual(await check(db, chain, T0), NONE);
  assert.deepEqual(reads(chain), [`trade ${noise}`]);
  assert.deepEqual(await check(db, chain, T0 + MIN), NONE);
  assert.equal(reads(chain).length, 1); // remembered: not read a second time
  assert.equal(pos(db, id).status, "open");
  assert.equal(pos(db, id).proceeds_sol, 0);
});

test("sweep: a buy recorded as failed that had landed gets its position", async () => {
  const { db, chain } = setup();
  const [m1, m2] = [mint(), mint()];
  const [s1, s2] = [fakeSignature(), fakeSignature()];
  // One with its signature saved, and one from a version that left it only in the error text.
  const b1 = trade(db, { mint: m1, side: "buy", status: "failed", signature: s1, error: "expired: the transaction never landed" });
  const b2 = trade(db, { mint: m2, side: "buy", status: "failed", error: `Signature ${s2} has expired: block height exceeded.` });
  chain.landed(s1, chainTrade("buy", s1, 0.05, 48, 0.002));
  chain.landed(s2, chainTrade("buy", s2, 0.1, 90));
  const held = { [m1]: 48, [m2]: 90 };
  assert.deepEqual(await sweep(db, chain, held), { ...ZERO, opened: 2 });
  for (const [m, b, tokens, cost] of [[m1, b1, 48, 0.05], [m2, b2, 90, 0.1]] as const) {
    const p = db.prepare("SELECT * FROM positions WHERE mint=?").all(m) as PosRow[];
    assert.equal(p.length, 1);
    assert.equal(p[0].status, "open");
    assert.equal(p[0].token_amount, tokens);
    assert.equal(p[0].cost_sol, cost);
    const row = tradeRow(db, b);
    assert.equal(row.status, "filled");
    assert.equal(row.position_id, p[0].id);
    assert.match(row.error ?? "", /it had landed/);
  }
  assert.equal(tradeRow(db, b2).signature, s2);
  assert.deepEqual(await sweep(db, chain, held), ZERO);
  assert.equal(count(db, "SELECT COUNT(*) n FROM positions"), 2);
});

test("sweep: a failed buy that never landed opens nothing, and the chain is asked only twice", async () => {
  const { db, chain } = setup();
  const m = mint();
  const [failed, unseen] = [fakeSignature(), fakeSignature()];
  trade(db, { mint: m, side: "buy", status: "failed", error: "Jupiter 500: Missing token program" }); // never sent
  trade(db, { mint: m, side: "buy", status: "failed", signature: failed, error: "failed on chain" });
  chain.statuses.set(failed, { err: { InstructionError: [5, { Custom: 6001 }] }, confirmed: true });
  trade(db, { mint: m, side: "buy", status: "failed", signature: unseen, error: "expired: the transaction never landed" });
  assert.deepEqual(await sweep(db, chain, { [m]: 500 }), ZERO);
  assert.deepEqual(await sweep(db, chain, { [m]: 500 }), { ...ZERO, strays: 1 });
  const asked = chain.calls.length;
  assert.equal(asked, 4); // two signatures, two passes
  assert.deepEqual(await sweep(db, chain, { [m]: 500 }), { ...ZERO, strays: 1 });
  assert.equal(chain.calls.length, asked);
  assert.equal(reads(chain).length, 0);
  // A changed amount is news: looked at again.
  assert.deepEqual(await sweep(db, chain, { [m]: 600 }), ZERO);
  assert.ok(chain.calls.length > asked);
  assert.equal(count(db, "SELECT COUNT(*) n FROM positions"), 0);
});

test("sweep: tokens that belong to no position are left alone, and counted from the second pass", async () => {
  const { db, chain } = setup();
  const held = { [mint()]: 5, [SOL_MINT]: 3, [mint()]: 0 };
  assert.deepEqual(await sweep(db, chain, held), ZERO);
  assert.deepEqual(await sweep(db, chain, held), { ...ZERO, strays: 1 });
  assert.deepEqual(await sweep(db, chain, held), { ...ZERO, strays: 1 });
  assert.equal(count(db, "SELECT COUNT(*) n FROM positions"), 0);
  assert.equal(count(db, "SELECT COUNT(*) n FROM copy_trades"), 0);
  assert.deepEqual(await sweep(db, chain, {}), ZERO); // gone from the wallet: forgotten
});

test("sweep: a position closed as missing is opened again when its tokens turn up within a day", async () => {
  const { db, chain } = setup();
  const m = mint();
  const id = position(db, m);
  assert.ok(closeMissing(db, id));
  assert.equal(pos(db, id).status, "closed");
  assert.deepEqual(await sweep(db, chain, { [m]: 150 }), { ...ZERO, reopened: 1 });
  const p = pos(db, id);
  assert.equal(p.status, "open");
  assert.equal(p.token_amount, 100); // never more than it bought
  assert.equal(p.exit_reason, null);
  assert.equal(p.closed_at, null);
  assert.equal(p.pnl_sol, null);

  // Closed for any other reason, or as missing more than a day ago: the tokens are strays.
  const [m2, m3] = [mint(), mint()];
  const sold = position(db, m2);
  db.prepare("UPDATE positions SET status='closed', token_amount=0, closed_at=?, exit_reason='stop-loss -20%' WHERE id=?").run(now(), sold);
  const old = position(db, m3);
  assert.ok(closeMissing(db, old));
  const later = Date.now() + 25 * 60 * MIN;
  assert.deepEqual(await sweep(db, chain, { [m2]: 100, [m3]: 100 }, later), ZERO);
  assert.deepEqual(await sweep(db, chain, { [m2]: 100, [m3]: 100 }, later), { ...ZERO, strays: 2 });
  assert.equal(pos(db, sold).status, "closed");
  assert.equal(pos(db, old).status, "closed");
});

test("sweep: a coin with an open position or a trade on its way is accounted for", async () => {
  const { db, chain } = setup();
  const [a, b] = [mint(), mint()];
  position(db, a);
  trade(db, { mint: b, side: "buy", status: "pending" });
  for (let i = 0; i < 3; i++) assert.deepEqual(await sweep(db, chain, { [a]: 100, [b]: 40 }), ZERO);
  assert.equal(chain.calls.length, 0);
});

test("sweep: a wallet that can't be read concludes nothing, and a chain that can't be read is asked again", async () => {
  const { db, chain } = setup();
  const m = mint();
  const sig = fakeSignature();
  const buy = trade(db, { mint: m, side: "buy", status: "failed", signature: sig, error: "expired: the transaction never landed" });
  assert.deepEqual(await sweep(db, chain, null), ZERO);
  assert.deepEqual(await sweepWallet(db, chain, { holdings: async () => Promise.reject(new Error("rpc down")) }), ZERO);
  chain.down.status = true;
  assert.deepEqual(await sweep(db, chain, { [m]: 48 }), ZERO);
  assert.deepEqual(await sweep(db, chain, { [m]: 48 }), { ...ZERO, strays: 1 });
  assert.deepEqual(await sweep(db, chain, { [m]: 48 }), { ...ZERO, strays: 1 });
  chain.down.status = false;
  chain.landed(sig, chainTrade("buy", sig, 0.05, 48));
  assert.deepEqual(await sweep(db, chain, { [m]: 48 }), { ...ZERO, opened: 1 });
  assert.equal(tradeRow(db, buy).status, "filled");
  assert.equal(count(db, "SELECT COUNT(*) n FROM positions WHERE mint=? AND status='open' AND mode='real'", m), 1);
});
