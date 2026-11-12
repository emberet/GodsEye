import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, type DB } from "@godseye/shared";
import type { ParsedSwap } from "../src/chain/parse";
import type { Executor, Fill, OnSigned } from "../src/copy/executor";
import { chainTrade, FakeChain, fakeSignature, MINT, swapTx, WALLET } from "./helpers";

process.env.COPY_BUDGET_SOL = "1";
process.env.COPY_MAX_TRADE_SOL = "0.1";
process.env.COPY_MAX_POSITIONS = "3";
process.env.COPY_DAILY_LOSS_LIMIT_SOL = "0.5";
const { CopyEngine } = await import("../src/copy/engine");
const { UnsettledError } = await import("../src/copy/executor");
const { settleSigned, GIVE_UP_MS, SETTLE_MARGIN_BLOCKS } = await import("../src/copy/recovery");
const { tradeOf } = await import("../src/copy/settle-chain");

const now = () => new Date().toISOString();
const near = (a: number | null | undefined, b: number) => typeof a === "number" && Math.abs(a - b) < 1e-9;
let n = 0;
const mint = () => `Mint${String(++n).padStart(39, "1")}`;

/** A real-mode executor whose swaps are sent but never seen to land: what a dropped confirm check looks like. */
class UnsureExecutor implements Executor {
  mode: "real" | "paper" = "real";
  sent: string[] = [];
  private send(onSigned?: OnSigned): never {
    const signature = fakeSignature();
    onSigned?.(signature, 500);
    this.sent.push(signature);
    throw new UnsettledError(signature, 500, "the confirm check failed");
  }
  async buy(_mint: string, _sol: number, onSigned?: OnSigned): Promise<Fill> {
    return this.send(onSigned);
  }
  async sell(_mint: string, _tokens: number, _all: boolean, _slippageBps?: number, onSigned?: OnSigned): Promise<Fill> {
    return this.send(onSigned);
  }
}

function setup() {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO wallets (address, first_seen_at, discovered_via, copy_weight) VALUES ('LEADER', ?, 'test', 0.5)").run(now());
  const ex = new UnsureExecutor();
  return { db, ex, engine: new CopyEngine(db, ex, null), chain: new FakeChain() };
}

function token(db: DB, m = mint(), symbol = "MOO"): string {
  db.prepare("INSERT INTO token_info (mint, symbol, decimals, pool_created_at, checked_at) VALUES (?, ?, 6, '2026-01-01T00:00:00Z', ?)").run(m, symbol, now());
  return m;
}

const swap = (p: Partial<ParsedSwap>): ParsedSwap => ({
  wallet: "LEADER", signature: `sig${Math.random()}`, slot: 1, ts: now(), mint: "", side: "buy",
  tokenAmount: 1000, tokenBalanceBefore: 0, solAmount: 1, priceSol: 0.001, venue: "jupiter", jitoTip: false, feeLamports: 5000, quote: "SOL", quoteAmount: 1, solUsd: null, usdAmount: null, ...p,
});

/** A real position in `m`: 100 tokens for 0.1 SOL unless told otherwise. */
function position(db: DB, m: string, o: { tokens?: number; cost?: number; status?: "open" | "closed" } = {}): number {
  const tokens = o.tokens ?? 100;
  const r = db
    .prepare(
      `INSERT INTO positions (mint, symbol, leader, mode, status, token_amount, tokens_bought, cost_sol, entry_price_sol, opened_at)
       VALUES (?, 'X', 'LEADER', 'real', ?, ?, ?, ?, 0.001, ?)`,
    )
    .run(m, o.status ?? "open", tokens, tokens, o.cost ?? 0.1, now());
  return Number(r.lastInsertRowid);
}

/** A trade's row as the engine leaves it once the swap is signed and its outcome isn't known: pending, with its signature. */
function signedRow(
  db: DB,
  o: { mint: string; side?: "buy" | "sell"; height?: number | null; error?: string | null; positionId?: number; tokens?: number; reason?: string; createdAt?: string },
): { id: number; signature: string } {
  const signature = fakeSignature();
  const side = o.side ?? "buy";
  const r = db
    .prepare(
      `INSERT INTO copy_trades (leader, leader_signature, leader_ts, mint, symbol, side, mode, status, reason, weight, size_sol, token_amount, signature, last_valid_height, error, position_id, created_at)
       VALUES ('LEADER', ?, ?, ?, 'X', ?, 'real', 'pending', ?, 0.5, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      `lead${Math.random()}`, now(), o.mint, side, o.reason ?? (side === "buy" ? "leader bought 1.000 SOL" : "leader sold 100%"), side === "buy" ? 0.1 : null, o.tokens ?? null,
      signature, o.height === undefined ? 500 : o.height, o.error === undefined ? "outcome not known yet" : o.error, o.positionId ?? null, o.createdAt ?? now(),
    );
  return { id: Number(r.lastInsertRowid), signature };
}

interface TradeRow { id: number; status: string; signature: string | null; last_valid_height: number | null; error: string | null; position_id: number | null; size_sol: number | null; token_amount: number | null }
interface PosRow { id: number; status: string; mode: string; token_amount: number; cost_sol: number; proceeds_sol: number; fee_sol: number | null; pnl_sol: number | null; exit_reason: string | null }
const tradeRow = (db: DB, id: number) => db.prepare("SELECT * FROM copy_trades WHERE id=?").get(id) as TradeRow;
const positions = (db: DB, m: string) => db.prepare("SELECT * FROM positions WHERE mint=? ORDER BY id").all(m) as PosRow[];
const count = (db: DB, sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as { n: number }).n;

/** One settle pass. `held`: what the wallet holds of the coin (null: it can't be read). */
const settle = (db: DB, chain: FakeChain, o: { held?: number | null; now?: number; before?: string } = {}) =>
  settleSigned(db, chain, { before: o.before ?? new Date(Date.now() + 60_000).toISOString(), held: async () => o.held ?? null, now: o.now });
const NOTHING = { bought: 0, sold: 0, failed: 0, left: 0 };

test("a landed buy with a confirm error ends as a tracked position", async () => {
  const { db, ex, engine, chain } = setup();
  const m = token(db);
  await engine.onLeaderSwap(swap({ mint: m }));
  // Sent, outcome unknown: the row stays pending with its signature. Nothing is called failed.
  assert.equal(ex.sent.length, 1);
  const copy = db.prepare("SELECT * FROM copy_trades WHERE side='buy' AND mint=?").get(m) as TradeRow;
  assert.equal(copy.status, "pending");
  assert.equal(copy.signature, ex.sent[0]);
  assert.equal(copy.last_valid_height, 500);
  assert.match(copy.error ?? "", /outcome not known yet/);
  assert.equal(positions(db, m).length, 0);
  // A second signal for the coin sends nothing while the first buy is unsettled.
  await engine.onLeaderSwap(swap({ mint: m }));
  assert.equal(ex.sent.length, 1);

  // The chain says it landed: 48 tokens for 0.05 SOL.
  chain.landed(ex.sent[0], chainTrade("buy", ex.sent[0], 0.05, 48, 0.002));
  assert.deepEqual(await settle(db, chain), { ...NOTHING, bought: 1 });
  const [pos, ...more] = positions(db, m);
  assert.equal(more.length, 0);
  assert.equal(pos.status, "open");
  assert.equal(pos.mode, "real");
  assert.equal(pos.token_amount, 48);
  assert.equal(pos.cost_sol, 0.05);
  assert.equal(pos.fee_sol, 0.002);
  const settled = tradeRow(db, copy.id);
  assert.equal(settled.status, "filled");
  assert.equal(settled.position_id, pos.id);
  assert.equal(settled.size_sol, 0.05);
  assert.equal(settled.error, "settled from the chain");
  // Settling again changes nothing, and the coin is now held: no second buy.
  assert.deepEqual(await settle(db, chain), NOTHING);
  await engine.onLeaderSwap(swap({ mint: m }));
  assert.equal(ex.sent.length, 1);
  assert.equal(positions(db, m).length, 1);
});

test("a sell with a confirm error is not sent twice, and settles with the real proceeds", async () => {
  const { db, ex, engine, chain } = setup();
  const m = token(db);
  const posId = position(db, m);
  await engine.onLeaderSwap(swap({ mint: m, side: "sell", tokenAmount: 1000, tokenBalanceBefore: 1000 }));
  assert.equal(ex.sent.length, 1);
  const sell = db.prepare("SELECT * FROM copy_trades WHERE side='sell' AND position_id=?").get(posId) as TradeRow;
  assert.equal(sell.status, "pending");
  assert.equal(sell.signature, ex.sent[0]);
  assert.equal(sell.token_amount, 100);
  assert.equal(positions(db, m)[0].status, "open");
  // The leader sells again: nothing goes out, and that sell stays on record.
  await engine.onLeaderSwap(swap({ mint: m, side: "sell", tokenAmount: 1000, tokenBalanceBefore: 1000 }));
  assert.equal(ex.sent.length, 1);
  assert.equal(count(db, "SELECT COUNT(*) n FROM copy_trades WHERE side='sell' AND status='failed' AND error LIKE 'not sent:%'"), 1);

  chain.landed(ex.sent[0], chainTrade("sell", ex.sent[0], 0.15, 100, 0.001));
  assert.deepEqual(await settle(db, chain), { ...NOTHING, sold: 1 });
  const [pos] = positions(db, m);
  assert.equal(pos.status, "closed");
  assert.equal(pos.token_amount, 0);
  assert.equal(pos.proceeds_sol, 0.15);
  assert.ok(near(pos.pnl_sol, 0.05), `pnl ${pos.pnl_sol}`);
  assert.equal(pos.exit_reason, "leader sold 100%");
  assert.equal(tradeRow(db, sell.id).status, "filled");
});

test("a trade that failed on chain is marked failed, and nothing is opened", async () => {
  const { db, chain } = setup();
  const m = mint();
  const row = signedRow(db, { mint: m });
  chain.statuses.set(row.signature, { err: { InstructionError: [3, { Custom: 6001 }] }, confirmed: true });
  assert.deepEqual(await settle(db, chain), { ...NOTHING, failed: 1 });
  const after = tradeRow(db, row.id);
  assert.equal(after.status, "failed");
  assert.match(after.error ?? "", /^failed on chain: /);
  assert.equal(positions(db, m).length, 0);
});

test("an unseen transaction is called expired only once its last block is well past", async () => {
  const { db, chain } = setup();
  const row = signedRow(db, { mint: mint(), height: 500 });
  chain.height = 500 + SETTLE_MARGIN_BLOCKS; // it could still land
  assert.deepEqual(await settle(db, chain), { ...NOTHING, left: 1 });
  assert.equal(tradeRow(db, row.id).status, "pending");
  chain.height++;
  assert.deepEqual(await settle(db, chain), { ...NOTHING, failed: 1 });
  assert.equal(tradeRow(db, row.id).error, "expired: the transaction never landed");
});

test("a transaction a node first shows after its last block still counts as landed", async () => {
  const { db } = setup();
  const m = mint();
  const row = signedRow(db, { mint: m });
  // The first look finds nothing; by the time the block height is read, the node knows it.
  const chain = new (class extends FakeChain {
    private looks = 0;
    async status(signature: string) {
      return ++this.looks === 1 ? undefined : super.status(signature);
    }
  })();
  chain.height = 500 + SETTLE_MARGIN_BLOCKS + 1;
  chain.landed(row.signature, chainTrade("buy", row.signature, 0.1, 90));
  assert.deepEqual(await settle(db, chain), { ...NOTHING, bought: 1 });
  assert.equal(positions(db, m)[0].token_amount, 90);
});

test("an unconfirmed status or an unreadable chain settles nothing", async () => {
  const { db, chain } = setup();
  const row = signedRow(db, { mint: mint() });
  chain.statuses.set(row.signature, { err: null, confirmed: false }); // processed only: it can still be dropped
  assert.deepEqual(await settle(db, chain), { ...NOTHING, left: 1 });
  chain.statuses.set(row.signature, { err: "oops", confirmed: false }); // an error isn't final either until confirmed
  assert.deepEqual(await settle(db, chain), { ...NOTHING, left: 1 });
  chain.down.status = true;
  assert.deepEqual(await settle(db, chain), { ...NOTHING, left: 1 });
  assert.equal(tradeRow(db, row.id).status, "pending");
});

test("a row with no saved block height is given up on only after the wait", async () => {
  const { db, chain } = setup();
  const createdAt = now();
  const row = signedRow(db, { mint: mint(), height: null, createdAt });
  const t = Date.parse(createdAt);
  assert.deepEqual(await settle(db, chain, { now: t + GIVE_UP_MS }), { ...NOTHING, left: 1 });
  assert.ok(!chain.calls.includes("blockHeight"));
  assert.deepEqual(await settle(db, chain, { now: t + GIVE_UP_MS + 1 }), { ...NOTHING, failed: 1 });
  assert.equal(tradeRow(db, row.id).error, "expired: the transaction never landed");
});

test("a trade the engine is still waiting on is left alone", async () => {
  const { db, chain } = setup();
  const m = mint();
  const row = signedRow(db, { mint: m, error: null }); // signed, and the engine hasn't let go of it
  chain.landed(row.signature, chainTrade("buy", row.signature, 0.1, 90));
  assert.deepEqual(await settle(db, chain, { before: new Date(Date.now() - 60_000).toISOString() }), NOTHING);
  assert.equal(chain.calls.length, 0);
  // Older than the cut-off, its process is gone (a restart): settled like any other.
  assert.deepEqual(await settle(db, chain), { ...NOTHING, bought: 1 });
  assert.equal(positions(db, m).length, 1);
});

test("a partial sell settled from the chain leaves the rest of the position open", async () => {
  const { db, chain } = setup();
  const m = mint();
  const posId = position(db, m);
  const row = signedRow(db, { mint: m, side: "sell", positionId: posId, tokens: 50, reason: "leader sold 50%" });
  chain.landed(row.signature, chainTrade("sell", row.signature, 0.08, 50));
  assert.deepEqual(await settle(db, chain), { ...NOTHING, sold: 1 });
  const [pos] = positions(db, m);
  assert.equal(pos.status, "open");
  assert.equal(pos.token_amount, 50);
  assert.equal(pos.proceeds_sol, 0.08);
});

test("a landed trade whose amounts can't be read waits, then falls back to what the wallet holds", async () => {
  const { db, chain } = setup();
  const createdAt = now();
  const late = Date.parse(createdAt) + GIVE_UP_MS + 1;
  // A buy: left during the wait; after it, the wallet's own count opens the position at the planned cost.
  const m = mint();
  const buy = signedRow(db, { mint: m, createdAt });
  chain.landed(buy.signature, null);
  assert.deepEqual(await settle(db, chain, { held: 77 }), { ...NOTHING, left: 1 });
  assert.deepEqual(await settle(db, chain, { held: null, now: late }), { ...NOTHING, left: 1 }); // the wallet can't be read either
  assert.deepEqual(await settle(db, chain, { held: 77, now: late }), { ...NOTHING, bought: 1 });
  const [pos] = positions(db, m);
  assert.equal(pos.token_amount, 77);
  assert.equal(pos.cost_sol, 0.1);
  assert.equal(pos.fee_sol, null);
  assert.match(tradeRow(db, buy.id).error ?? "", /amounts unreadable/);

  // A buy the wallet holds nothing of: failed.
  const none = signedRow(db, { mint: mint(), createdAt });
  chain.statuses.set(none.signature, { err: null, confirmed: true });
  chain.down.trade = true; // the transaction can't be fetched at all
  assert.deepEqual(await settle(db, chain, { held: 0, now: late }), { ...NOTHING, failed: 1 });
  assert.match(tradeRow(db, none.id).error ?? "", /wallet holds none of it/);

  // A sell: its proceeds can't be guessed. It is failed and the position stays open for the missing-position check.
  const sm = mint();
  const sell = signedRow(db, { mint: sm, side: "sell", positionId: position(db, sm), tokens: 100, createdAt });
  chain.statuses.set(sell.signature, { err: null, confirmed: true });
  assert.deepEqual(await settle(db, chain, { now: late }), { ...NOTHING, failed: 1 });
  assert.equal(tradeRow(db, sell.id).error, "landed, but its amounts couldn't be read");
  assert.equal(positions(db, sm)[0].status, "open");
});

test("a landed sell with no open position to settle against is recorded, not booked", async () => {
  const { db, chain } = setup();
  // The position was closed some other way before its sell could be settled.
  const m = mint();
  const late = signedRow(db, { mint: m, side: "sell", positionId: position(db, m, { status: "closed" }), tokens: 100 });
  chain.landed(late.signature, chainTrade("sell", late.signature, 0.15, 100));
  // A sell row that names no position.
  const orphan = signedRow(db, { mint: mint(), side: "sell", tokens: 100 });
  chain.landed(orphan.signature, chainTrade("sell", orphan.signature, 0.15, 100));
  assert.deepEqual(await settle(db, chain), { ...NOTHING, failed: 1 });
  const row = tradeRow(db, late.id);
  assert.equal(row.status, "filled");
  assert.match(row.error ?? "", /already closed/);
  assert.equal(positions(db, m)[0].proceeds_sol, 0);
  assert.equal(tradeRow(db, orphan.id).error, "landed, but it has no position to settle against");
});

test("tradeOf: reads GodsEye's own trade out of a transaction", () => {
  const sig = fakeSignature();
  const buy = tradeOf(swapTx({ solDelta: -1.000005, tokenBefore: 0, tokenAfter: 5000 }), WALLET, MINT, sig);
  assert.equal(buy?.side, "buy");
  assert.equal(buy?.atMs, 1_760_000_000_000);
  assert.equal(buy?.fill.signature, sig);
  assert.equal(buy?.fill.tokenAmount, 5000);
  assert.ok(near(buy?.fill.solAmount, 1));
  assert.ok(near(buy?.fill.feeSol, 0.000005));

  const sell = tradeOf(swapTx({ solDelta: 0.5 - 0.000005, tokenBefore: 4000, tokenAfter: 1000 }), WALLET, MINT, sig);
  assert.equal(sell?.side, "sell");
  assert.equal(sell?.fill.tokenAmount, 3000);
  assert.ok(near(sell?.fill.solAmount, 0.5));
  assert.ok(near(sell?.fill.feeSol, 0.000005));

  // A dead coin sold for dust is still a sell (parse.ts drops it as noise).
  const dust = tradeOf(swapTx({ solDelta: 0.00002 - 0.000005, tokenBefore: 1000, tokenAfter: 0 }), WALLET, MINT, sig);
  assert.equal(dust?.side, "sell");
  assert.equal(dust?.fill.tokenAmount, 1000);
  assert.ok(near(dust?.fill.solAmount, 0.00002));
  assert.ok(near(dust?.fill.feeSol, 0.000005));

  // Not a trade: a failed transaction, another coin, tokens sent away with no DEX involved.
  assert.equal(tradeOf(swapTx({ solDelta: -1.000005, tokenBefore: 0, tokenAfter: 5000, err: { InstructionError: [3, { Custom: 6001 }] } }), WALLET, MINT, sig), null);
  assert.equal(tradeOf(swapTx({ solDelta: -1.000005, tokenBefore: 0, tokenAfter: 5000 }), WALLET, "Other11111111111111111111111111111111111111", sig), null);
  assert.equal(tradeOf(swapTx({ solDelta: -0.000005, tokenBefore: 1000, tokenAfter: 0, programs: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"] }), WALLET, MINT, sig), null);
});
