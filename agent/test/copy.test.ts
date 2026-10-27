import { test } from "node:test";
import assert from "node:assert/strict";
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { openDb, SOL_MINT } from "@godseye/shared";
import type { ParsedSwap } from "../src/chain/parse";
import type { Executor, Fill } from "../src/copy/executor";
import { MINT, stubFetch } from "./helpers";

process.env.RUG_CHECK_ENABLED = "false";
process.env.COPY_BUDGET_SOL = "1";
process.env.COPY_MAX_TRADE_SOL = "0.1";
const { CopyEngine } = await import("../src/copy/engine");
const { associatedTokenAddress, staticCheck } = await import("../src/copy/verify");

const owner = Keypair.generate();
const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const JUP = new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");

function build(ixs: TransactionInstruction[], payer = owner.publicKey): VersionedTransaction {
  const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: "11111111111111111111111111111111", instructions: ixs }).compileToV0Message();
  return new VersionedTransaction(msg);
}
const wsolAta = associatedTokenAddress(owner.publicKey, new PublicKey(SOL_MINT), TOKEN);
const jupIx = new TransactionInstruction({ programId: JUP, keys: [{ pubkey: owner.publicKey, isSigner: true, isWritable: true }], data: Buffer.from([1]) });

test("verify: a normal Jupiter swap passes", () => {
  const tx = build([
    ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000 }),
    SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: wsolAta, lamports: 1e8 }),
    jupIx,
  ]);
  assert.equal(staticCheck(tx, owner.publicKey, 1_000_000), null);
});

test("verify: refuses SOL sent anywhere but GodsEye's own wrapped-SOL account", () => {
  const thief = Keypair.generate().publicKey;
  const tx = build([SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: thief, lamports: 1e9 }), jupIx]);
  assert.match(staticCheck(tx, owner.publicKey, 1_000_000)!, /sends SOL to/);
});

test("verify: refuses unknown programs, other fee payers and huge priority fees", () => {
  const evil = new TransactionInstruction({ programId: Keypair.generate().publicKey, keys: [], data: Buffer.alloc(0) });
  assert.match(staticCheck(build([evil, jupIx]), owner.publicKey, 1_000_000)!, /unexpected program/);
  assert.match(staticCheck(build([jupIx]), Keypair.generate().publicKey, 1_000_000)!, /not the fee payer/);
  const pricey = build([ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000_000 }), jupIx]);
  assert.match(staticCheck(pricey, owner.publicKey, 1_000_000)!, /priority fee/);
});

test("verify: refuses token transfers and closing accounts into someone else's wallet", () => {
  const acct = Keypair.generate().publicKey;
  const transfer = new TransactionInstruction({ programId: TOKEN, keys: [{ pubkey: acct, isSigner: false, isWritable: true }], data: Buffer.from([3, 0, 0, 0, 0, 0, 0, 0, 0]) });
  assert.match(staticCheck(build([transfer, jupIx]), owner.publicKey, 1_000_000)!, /token instruction 3/);
  const other = Keypair.generate().publicKey;
  const close = new TransactionInstruction({
    programId: TOKEN,
    keys: [{ pubkey: acct, isSigner: false, isWritable: true }, { pubkey: other, isSigner: false, isWritable: true }, { pubkey: owner.publicKey, isSigner: true, isWritable: false }],
    data: Buffer.from([9]),
  });
  assert.match(staticCheck(build([close, jupIx]), owner.publicKey, 1_000_000)!, /someone else/);
});

class FakeExecutor implements Executor {
  mode = "paper" as const;
  calls: string[] = [];
  async buy(_mint: string, sol: number): Promise<Fill> {
    this.calls.push(`buy ${sol}`);
    return { signature: null, solAmount: sol, tokenAmount: sol * 1000, priceSol: 0.001 };
  }
  async sell(_mint: string, tokens: number): Promise<Fill> {
    this.calls.push(`sell ${tokens}`);
    return { signature: null, solAmount: tokens * 0.002, tokenAmount: tokens, priceSol: 0.002 };
  }
}

function setup(weight = 0.5) {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO wallets (address, first_seen_at, discovered_via, copy_weight) VALUES ('LEADER', ?, 'test', ?)").run(new Date().toISOString(), weight);
  db.prepare("INSERT INTO token_info (mint, symbol, decimals, pool_created_at, checked_at) VALUES (?, 'MOO', 6, '2026-01-01T00:00:00Z', ?)").run(MINT, new Date().toISOString());
  const ex = new FakeExecutor();
  return { db, ex, engine: new CopyEngine(db, ex, null) };
}
const leaderSwap = (p: Partial<ParsedSwap>): ParsedSwap => ({
  wallet: "LEADER", signature: `sig${Math.random()}`, slot: 1, ts: new Date().toISOString(), mint: MINT, side: "buy",
  tokenAmount: 1000, tokenBalanceBefore: 0, solAmount: 1, priceSol: 0.001, venue: "jupiter", jitoTip: false, feeLamports: 5000, quote: "SOL", quoteAmount: 1, solUsd: null, usdAmount: null, ...p,
});

test("engine: copies a leader's buy sized by weight, then mirrors a partial and a full sell", async () => {
  const { db, ex, engine } = setup(0.5);
  await engine.onLeaderSwap(leaderSwap({}));
  assert.deepEqual(ex.calls, ["buy 0.1"]); // 1 SOL budget × 0.5 weight, capped at 0.1
  const pos = db.prepare("SELECT * FROM positions").get() as { token_amount: number; status: string };
  assert.equal(pos.token_amount, 100);

  await engine.onLeaderSwap(leaderSwap({ side: "sell", tokenAmount: 500, tokenBalanceBefore: 1000 })); // leader sold 50%
  assert.equal(ex.calls[1], "sell 50");
  await engine.onLeaderSwap(leaderSwap({ side: "sell", tokenAmount: 500, tokenBalanceBefore: 500 })); // leader sold the rest
  const closed = db.prepare("SELECT * FROM positions").get() as { status: string; pnl_sol: number };
  assert.equal(closed.status, "closed");
  assert.ok(Math.abs(closed.pnl_sol - 0.1) < 1e-9, `pnl ${closed.pnl_sol}`); // bought 0.1, sold 100 tokens at 0.002 = 0.2
  const proofs = (db.prepare("SELECT COUNT(*) n FROM proof_ledger").get() as { n: number }).n;
  assert.equal(proofs, 3);
});

test("engine: never copies unweighted wallets, dust, or late trades; respects pause", async () => {
  const { db, ex, engine } = setup(0);
  await engine.onLeaderSwap(leaderSwap({}));
  assert.equal(ex.calls.length, 0);

  db.prepare("UPDATE wallets SET copy_weight = 0.5").run();
  await engine.onLeaderSwap(leaderSwap({ solAmount: 0.01 }));
  assert.equal(ex.calls.length, 0, "dust");

  await engine.onLeaderSwap(leaderSwap({ ts: new Date(Date.now() - 10 * 60_000).toISOString() }));
  assert.equal(ex.calls.length, 0, "late");
  assert.match((db.prepare("SELECT reason FROM copy_trades").get() as { reason: string }).reason, /seen \d+s after/);

  db.prepare("INSERT INTO agent_meta (key, value, updated_at) VALUES ('copy_paused', '1', '')").run();
  await engine.onLeaderSwap(leaderSwap({}));
  assert.equal(ex.calls.length, 0, "paused");
});

test("engine: the same leader trade is never copied twice", async () => {
  const { ex, engine } = setup(0.5);
  const s = leaderSwap({});
  await Promise.all([engine.onLeaderSwap(s), engine.onLeaderSwap(s)]);
  assert.equal(ex.calls.length, 1);
});

test("engine: never copies non-memecoins (bridged majors etc.), and doesn't fill the copy log with them", async () => {
  const { db, ex, engine } = setup(0.5);
  db.prepare("UPDATE token_info SET symbol = 'ZEC' WHERE mint = ?").run(MINT);
  await engine.onLeaderSwap(leaderSwap({}));
  await engine.onLeaderSwap(leaderSwap({}));
  assert.equal(ex.calls.length, 0);
  assert.equal((db.prepare("SELECT COUNT(*) n FROM copy_trades").get() as { n: number }).n, 0);
  db.prepare("UPDATE token_info SET symbol = 'wNEAR' WHERE mint = ?").run(MINT);
  await engine.onLeaderSwap(leaderSwap({}));
  assert.equal(ex.calls.length, 0);
});

test("engine: an account-wide skip (paused / no SOL) is recorded once per 10 min, not once per leader buy", async () => {
  const { db, ex, engine } = setup(0.5);
  db.prepare("INSERT INTO agent_meta (key, value, updated_at) VALUES ('copy_paused', '1', '')").run();
  for (let i = 0; i < 25; i++) await engine.onLeaderSwap(leaderSwap({}));
  assert.equal(ex.calls.length, 0);
  const rows = db.prepare("SELECT reason FROM copy_trades").all() as { reason: string }[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].reason, "copying is paused");
  // per-trade reasons (like arriving too late) are still recorded for every trade
  db.prepare("DELETE FROM agent_meta WHERE key = 'copy_paused'").run();
  for (let i = 0; i < 3; i++) await engine.onLeaderSwap(leaderSwap({ ts: new Date(Date.now() - 10 * 60_000).toISOString() }));
  assert.equal((db.prepare("SELECT COUNT(*) n FROM copy_trades WHERE reason LIKE 'seen %'").get() as { n: number }).n, 3);
});

test("engine: a token whose name lookup hangs is still copied within a few seconds", async () => {
  const { db, ex, engine } = setup(0.5);
  const NEW = "NewToken11111111111111111111111111111111pump";
  const fake = stubFetch(() => new Promise<never>(() => undefined)); // every lookup hangs (a backed-up GeckoTerminal queue)
  try {
    const t0 = Date.now();
    await engine.onLeaderSwap(leaderSwap({ mint: NEW }));
    assert.deepEqual(ex.calls, ["buy 0.1"]);
    assert.ok(Date.now() - t0 < 5_000, `took ${Date.now() - t0} ms`);
    assert.equal((db.prepare("SELECT COUNT(*) n FROM positions WHERE mint = ?").get(NEW) as { n: number }).n, 1);
  } finally {
    fake.restore();
  }
});
