/**
 * The funding ledger (funding/ledger.ts): which of the wallet's transactions are deposits and withdrawals, where a scan
 * starts and stops, and that SOL leaving unexplained pauses new buys. Made-up transactions and a fake history source.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { getMeta, openDb, type DB } from "@godseye/shared";
import type { TxLike } from "../src/chain/parse";
import { swapTx, WALLET } from "./helpers";

const { classifyFlow, DUST_SOL, expectWithdrawal, scanFlows } = await import("../src/funding/ledger");
type FlowSource = import("../src/funding/ledger").FlowSource;
const { attachLogDb } = await import("../src/log");

const OTHER = "0ther1111111111111111111111111111111111111";
const SYSTEM = "11111111111111111111111111111111";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const pk = (s: string) => ({ pubkey: { toString: () => s } });
const prog = (s: string) => ({ programId: { toString: () => s } });

/** A transaction moving `sol` into (+) or out of (−) WALLET. `payer`: who signed and paid the fee. */
function transfer(sol: number, payer: "wallet" | "other", opts: { programs?: string[]; err?: unknown } = {}): TxLike {
  const fee = 5000;
  const lamports = Math.round(sol * 1e9);
  const keys = payer === "wallet" ? [pk(WALLET), pk(OTHER)] : [pk(OTHER), pk(WALLET)];
  const w = payer === "wallet" ? 0 : 1;
  const pre = [50e9, 50e9];
  const post = [...pre];
  post[w] += lamports - (payer === "wallet" ? fee : 0);
  post[1 - w] -= lamports + (payer === "other" ? fee : 0);
  return {
    slot: 1,
    blockTime: 1_763_600_000,
    meta: { err: opts.err ?? null, fee, preBalances: pre, postBalances: post, preTokenBalances: [], postTokenBalances: [], innerInstructions: [] },
    transaction: { signatures: ["s"], message: { accountKeys: keys, instructions: (opts.programs ?? [SYSTEM]).map(prog) } },
  };
}

test("classify: SOL in is a deposit, SOL out a withdrawal; dust, rent reclaims and empty moves are left out; a swap it didn't make is a swap", () => {
  assert.deepEqual(classifyFlow(transfer(2, "other"), WALLET), { kind: "deposit", sol: 2 });
  const out = classifyFlow(transfer(-1.5, "wallet"), WALLET)!;
  assert.equal(out.kind, "withdrawal");
  assert.ok(Math.abs(out.sol + 1.500005) < 1e-9, "the fee the wallet paid is part of what left");
  assert.equal(classifyFlow(transfer(DUST_SOL / 10, "other"), WALLET), null, "spam dust");
  assert.equal(classifyFlow(transfer(0, "wallet", { err: { InstructionError: [0, "x"] } }), WALLET), null, "a failed transaction's fee");
  assert.equal(classifyFlow(transfer(0.00408, "wallet", { programs: [TOKEN] }), WALLET), null, "closing empty token accounts for their rent");
  assert.equal(classifyFlow(transfer(2, "other"), "NotInIt11111111111111111111111111111111111"), null);
  assert.equal(classifyFlow(swapTx({ solDelta: -0.5, tokenBefore: 0, tokenAfter: 1000 }), WALLET)?.kind, "swap");
});

/** A fake wallet history: signatures newest first, with the transactions behind them. */
class FakeSource implements FlowSource {
  list: { signature: string; slot: number; err: unknown; tx: TxLike | null }[] = [];
  reads = 0;
  add(signature: string, slot: number, tx: TxLike | null, err: unknown = null) {
    this.list.unshift({ signature, slot, err, tx });
  }
  async signatures({ until, before, limit }: { until: string | null; before?: string; limit: number }) {
    let l = this.list;
    if (until) l = l.slice(0, Math.max(0, l.findIndex((s) => s.signature === until)));
    if (before) l = l.slice(l.findIndex((s) => s.signature === before) + 1);
    return l.slice(0, limit).map(({ signature, slot, err }) => ({ signature, slot, err }));
  }
  async tx(signature: string) {
    this.reads++;
    return this.list.find((s) => s.signature === signature)?.tx ?? null;
  }
}
const flows = (db: DB) => db.prepare("SELECT signature, kind, sol, units, expected FROM wallet_flows ORDER BY slot").all() as { signature: string; kind: string; sol: number; units: number | null; expected: number }[];
const opts = { outflowPauseSol: 0.02 };

test("scan: the first pass only marks where to start; then deposits are recorded, its own trades skipped, oldest first", async () => {
  const db = openDb(":memory:");
  const src = new FakeSource();
  src.add("old-deposit", 5, transfer(3, "other"));
  assert.deepEqual(await scanFlows(db, src, WALLET, 100, opts), { recorded: 0, done: true });
  assert.equal(flows(db).length, 0, "what the wallet held at the start is the starting point, not a deposit");

  db.prepare("INSERT INTO copy_trades (leader, leader_signature, leader_ts, mint, side, mode, status, signature, created_at) VALUES ('L', 'ls', ?, 'M', 'buy', 'real', 'filled', 'own-buy', ?)").run(new Date().toISOString(), new Date().toISOString());
  src.add("own-buy", 10, swapTx({ solDelta: -0.2, tokenBefore: 0, tokenAfter: 1000 }));
  src.add("dep-1", 11, transfer(1, "other"));
  src.add("dep-2", 12, transfer(0.5, "other"));
  const r = await scanFlows(db, src, WALLET, 100, opts);
  assert.deepEqual(r, { recorded: 2, done: true });
  assert.deepEqual(flows(db).map((f) => [f.signature, f.kind, f.sol, f.units]), [["dep-1", "deposit", 1, null], ["dep-2", "deposit", 0.5, null]]);
  assert.equal(src.reads, 2, "its own trade is known by its signature, without reading it");
  assert.deepEqual(await scanFlows(db, src, WALLET, 100, opts), { recorded: 0, done: true }, "nothing new");
});

test("scan: stops at the balance's slot and at a transaction it can't read yet, and picks up there next time", async () => {
  const db = openDb(":memory:");
  const src = new FakeSource();
  await scanFlows(db, src, WALLET, 0, opts); // an empty wallet: everything from here is new
  src.add("a", 10, transfer(1, "other"));
  src.add("b", 20, null); // not readable yet
  src.add("c", 30, transfer(2, "other"));
  assert.deepEqual(await scanFlows(db, src, WALLET, 100, opts), { recorded: 1, done: false });
  src.list.find((s) => s.signature === "b")!.tx = transfer(0.25, "other");
  assert.deepEqual(await scanFlows(db, src, WALLET, 25, opts), { recorded: 1, done: false }, "c is past the balance's slot");
  assert.deepEqual(await scanFlows(db, src, WALLET, 30, opts), { recorded: 1, done: true });
  assert.deepEqual(flows(db).map((f) => f.signature), ["a", "b", "c"]);
});

test("scan: SOL leaving unexplained above the line pauses new buys and tells the owner; small or announced withdrawals don't", async () => {
  const db = openDb(":memory:");
  attachLogDb(db);
  const src = new FakeSource();
  try {
    await scanFlows(db, src, WALLET, 0, opts);
    src.add("sigSmall9", 1, transfer(-0.01, "wallet"));
    await scanFlows(db, src, WALLET, 10, opts);
    assert.equal(getMeta(db, "copy_paused"), null, "under the line");

    expectWithdrawal(db, 1);
    src.add("sigAnnounced9", 2, transfer(-0.8, "wallet"));
    await scanFlows(db, src, WALLET, 10, opts);
    assert.equal(getMeta(db, "copy_paused"), null, "sigAnnounced9");
    assert.equal(flows(db).find((f) => f.signature === "sigAnnounced9")!.expected, 1);

    src.add("sigDrain9", 3, transfer(-0.5, "wallet")); // only ~0.2 of the announcement is left
    await scanFlows(db, src, WALLET, 10, opts);
    assert.equal(getMeta(db, "copy_paused"), "1");
    assert.equal(getMeta(db, "copy_paused_by"), "outflow");
    await new Promise((r) => setImmediate(r)); // the alert is written once its (absent) channel has been looked at
  } finally {
    attachLogDb(null as unknown as DB);
  }
  const said = (db.prepare("SELECT message FROM agent_log ORDER BY id").all() as { message: string }[]).map((r) => r.message);
  assert.ok(said.some((m) => /Owner alert \(unknown_outflow\): 0\.5000 SOL left the agent's wallet and no trade explains it/.test(m)), said.join("\n"));
  for (const m of said) {
    assert.doesNotMatch(m, /sig(Small|Announced|Drain)9/, "no signature in what it says");
    assert.ok(!m.includes(WALLET) && !m.includes(OTHER), "no address in what it says");
  }
});

test("scan: an announcement runs out with time", async () => {
  const db = openDb(":memory:");
  const src = new FakeSource();
  await scanFlows(db, src, WALLET, 0, opts);
  expectWithdrawal(db, 1, 1, Date.now() - 2 * 3_600_000); // announced for an hour, two hours ago
  src.add("late", 1, transfer(-0.5, "wallet"));
  await scanFlows(db, src, WALLET, 10, opts);
  assert.equal(getMeta(db, "copy_paused"), "1");
});
