/**
 * The creator-rewards switch (creator/rewards.ts): the owner's 30/70 split, the job's own check before signing, what a
 * claim records, and that the agent never copies its own coin. A fake pump.fun and a fake sender: nothing is signed
 * or sent, and every key is made up on the spot.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { getMeta, openDb, setMeta, type DB } from "@godseye/shared";
import type { ParsedSwap } from "../src/chain/parse";
import type { Executor, Fill } from "../src/copy/executor";

const { config } = await import("../src/config");
const { MINT_KEY, planCollect, PUMP_PROGRAM, rewardsCheck, runRewards, splitOf } = await import("../src/creator/rewards");
type PumpClient = import("../src/creator/rewards").PumpClient;
type RewardsSender = import("../src/creator/rewards").RewardsSender;
const { riskLook, readRiskState, SET_ASIDE_KEY } = await import("../src/copy/risk");
const { classifyFlow } = await import("../src/funding/ledger");
const { CopyEngine } = await import("../src/copy/engine");
const { attachLogDb } = await import("../src/log");

const agent = Keypair.generate().publicKey;
const owner = Keypair.generate().publicKey;
const coin = Keypair.generate().publicKey;
const pumpIx = new TransactionInstruction({ programId: new PublicKey(PUMP_PROGRAM), keys: [{ pubkey: agent, isSigner: true, isWritable: true }], data: Buffer.from([1]) });
const build = (ixs: TransactionInstruction[], payer = agent) =>
  new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: "11111111111111111111111111111111", instructions: ixs }).compileToV0Message());
const LAMPORTS = 1_000_000_000n;

test("split: the owner's 30/70 matches only when both shares are right", () => {
  const a = agent.toBase58(), o = owner.toBase58();
  assert.equal(splitOf([{ address: a, shareBps: 3000 }, { address: o, shareBps: 7000 }], a, o, 0.3).matches, true);
  assert.deepEqual(splitOf([{ address: a, shareBps: 5000 }, { address: o, shareBps: 5000 }], a, o, 0.3), { agentBps: 5000, payoutBps: 5000, matches: false });
  assert.equal(splitOf([{ address: o, shareBps: 10_000 }], a, o, 0.3).matches, false, "the agent left out");
  assert.equal(splitOf([{ address: a, shareBps: 3000 }, { address: Keypair.generate().publicKey.toBase58(), shareBps: 7000 }], a, null, 0.3).matches, true, "no payout wallet set: only the agent's share is checked");
});

test("a claim's split: 30% kept, 70% paid on, or set aside until there is a payout wallet (then paid with it)", () => {
  assert.deepEqual(planCollect(LAMPORTS, 0.3, true, 0n), { pay: 700_000_000n, keep: 300_000_000n, setAside: 0n });
  assert.deepEqual(planCollect(LAMPORTS, 0.3, false, 0n), { pay: 0n, keep: 300_000_000n, setAside: 700_000_000n });
  assert.deepEqual(planCollect(LAMPORTS, 0.3, true, 500_000_000n), { pay: 1_200_000_000n, keep: 300_000_000n, setAside: -500_000_000n });
});

test("the job's own check: pump.fun and plumbing only, the agent the only signer, SOL only to the payout wallet and never above the owner's share", () => {
  const pay = (to: PublicKey, sol: bigint) => SystemProgram.transfer({ fromPubkey: agent, toPubkey: to, lamports: sol });
  assert.equal(rewardsCheck(build([ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }), pumpIx, pay(owner, 700n)]), agent, owner, 700n), null);
  assert.match(rewardsCheck(build([pumpIx, pay(owner, 701n)]), agent, owner, 700n)!, /more than the owner's/);
  assert.match(rewardsCheck(build([pumpIx, pay(owner, 400n), pay(owner, 400n)]), agent, owner, 700n)!, /more than the owner's/, "two transfers add up");
  assert.match(rewardsCheck(build([pumpIx, pay(Keypair.generate().publicKey, 1n)]), agent, owner, 700n)!, /somewhere other than the payout wallet/);
  assert.match(rewardsCheck(build([pumpIx, pay(owner, 1n)]), agent, null, 0n)!, /somewhere other than the payout wallet/, "a distribute sends nothing");
  const evil = new TransactionInstruction({ programId: Keypair.generate().publicKey, keys: [], data: Buffer.alloc(0) });
  assert.match(rewardsCheck(build([pumpIx, evil]), agent, owner, 700n)!, /program other than pump\.fun's/);
  assert.match(rewardsCheck(build([pumpIx], Keypair.generate().publicKey), agent, owner, 700n)!, /not the fee payer/);
  const cosign = new TransactionInstruction({ programId: new PublicKey(PUMP_PROGRAM), keys: [{ pubkey: Keypair.generate().publicKey, isSigner: true, isWritable: false }], data: Buffer.from([1]) });
  assert.match(rewardsCheck(build([pumpIx, cosign]), agent, owner, 700n)!, /needs 2 signatures/);
  const assign = new TransactionInstruction({ programId: SystemProgram.programId, keys: [{ pubkey: agent, isSigner: true, isWritable: true }], data: Buffer.from([1, 0, 0, 0, ...new Array(32).fill(0)]) });
  assert.match(rewardsCheck(build([pumpIx, assign]), agent, owner, 700n)!, /other than a transfer/);
});

// ---------------------------------------------------------------- the job, with a fake pump.fun and a fake sender

class FakePump implements PumpClient {
  vault = 0n;
  sharing: Awaited<ReturnType<PumpClient["sharingConfig"]>> = null;
  waiting = { lamports: 0n, can: false };
  asked: string[] = [];
  async creatorVaultLamports() {
    this.asked.push("vault");
    return this.vault;
  }
  async sharingConfig() {
    this.asked.push("sharing");
    return this.sharing;
  }
  async distributable() {
    return this.waiting;
  }
  async distributeInstructions() {
    return [pumpIx];
  }
  async collectInstructions() {
    return [pumpIx];
  }
}
class FakeSender implements RewardsSender {
  runs: { ixs: TransactionInstruction[]; minGain: bigint; dry: boolean; refused: string | null }[] = [];
  async run(ixs: TransactionInstruction[], check: (tx: VersionedTransaction) => string | null, minGain: bigint, dry: boolean) {
    const refused = check(build(ixs));
    this.runs.push({ ixs, minGain, dry, refused });
    if (refused) throw new Error(refused);
    return dry ? null : { signature: `sig${this.runs.length}`, slot: 50 };
  }
}
function setup(c: Partial<typeof config> = {}) {
  const db = openDb(":memory:");
  const client = new FakePump();
  const sender = new FakeSender();
  const cfg = { ...config, creatorRewards: "on" as const, creatorPayoutWallet: owner.toBase58(), creatorMint: "", creatorTradingShare: 0.3, creatorMinClaimSol: 0.05, ...c };
  return { db, client, sender, cfg, run: () => runRewards(db, cfg, { wallet: agent, client, sender }) };
}
const flows = (db: DB) => db.prepare("SELECT signature, kind, sol, units, expected FROM wallet_flows ORDER BY id").all() as { signature: string; kind: string; sol: number; units: number | null; expected: number }[];
const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);

test("off does nothing; with no coin and nothing to claim it does nothing either (it arms itself)", async () => {
  const off = setup({ creatorRewards: "off" });
  assert.equal(await off.run(), "off");
  assert.deepEqual(off.client.asked, []);
  const none = setup();
  assert.equal(await none.run(), "nothing");
  assert.equal(none.sender.runs.length, 0);
});

test("no split on pump.fun: the agent claims as creator, sends 70% on in the same transaction, and records both sides", async () => {
  const { db, client, sender, run } = setup();
  client.vault = LAMPORTS;
  assert.equal(await run(), "claimed");
  const [r] = sender.runs;
  assert.equal(r.refused, null);
  assert.equal(r.dry, false);
  const transfer = r.ixs.find((ix) => ix.programId.equals(SystemProgram.programId))!;
  assert.ok(transfer.keys[1].pubkey.equals(owner));
  assert.equal(Buffer.from(transfer.data).readBigUInt64LE(4), 700_000_000n);
  assert.ok(r.minGain > 250_000_000n && r.minGain < 300_000_000n, "the simulation must show the agent's 30% arriving");
  assert.deepEqual(flows(db).map((f) => [f.signature, f.kind, f.sol, f.units, f.expected]), [["sig1", "creator_claim", 0.3, null, 1], ["sig1#payout", "payout", -0.7, 0, 1]]);
  assert.equal(Number(getMeta(db, SET_ASIDE_KEY)), 0);
  assert.equal((db.prepare("SELECT COUNT(*) n FROM proof_ledger WHERE kind = 'creator_claim'").get() as { n: number }).n, 1);
});

test("no payout wallet: the owner's 70% is set aside, never traded, and paid with the next claim once a wallet is set", async () => {
  const first = setup({ creatorPayoutWallet: "" });
  first.client.vault = LAMPORTS;
  assert.equal(await first.run(), "claimed");
  assert.equal(first.sender.runs[0].ixs.some((ix) => ix.programId.equals(SystemProgram.programId)), false, "nothing is sent anywhere");
  near(Number(getMeta(first.db, SET_ASIDE_KEY)), 0.7);
  assert.deepEqual(flows(first.db).map((f) => [f.kind, f.sol]), [["creator_claim", 0.3]]);
  // Later, with a payout wallet: this claim's 70% and the 0.7 held back go out together.
  const later = runRewards(first.db, { ...first.cfg, creatorPayoutWallet: owner.toBase58() }, { wallet: agent, client: first.client, sender: first.sender });
  assert.equal(await later, "claimed");
  const transfer = first.sender.runs[1].ixs.find((ix) => ix.programId.equals(SystemProgram.programId))!;
  assert.equal(Buffer.from(transfer.data).readBigUInt64LE(4), 1_400_000_000n);
  near(Number(getMeta(first.db, SET_ASIDE_KEY)), 0);
});

test("the risk governor: a claim buys units for the agent's share only; the owner's share never counts as its value", () => {
  const db = openDb(":memory:");
  riskLook(db, config, 10, 1);
  // 1 SOL claimed, nothing paid on yet: the wallet shows 11, 0.7 of it set aside, the 0.3 kept buys units.
  db.prepare("INSERT INTO wallet_flows (signature, slot, ts, kind, sol, units, expected, created_at) VALUES ('c', 2, ?, 'creator_claim', 0.3, NULL, 1, ?)").run(new Date().toISOString(), new Date().toISOString());
  setMeta(db, SET_ASIDE_KEY, 0.7);
  riskLook(db, config, 11, 2);
  const s = readRiskState(db)!;
  near(s.nav, 1);
  near(s.units, 10.3);
  near(s.equity, 10.3 - config.walletReserveSol);
});

test("dry: works it out and simulates it, records nothing", async () => {
  const { db, client, sender, run } = setup({ creatorRewards: "dry" });
  client.vault = LAMPORTS;
  attachLogDb(db);
  try {
    assert.equal(await run(), "dry");
  } finally {
    attachLogDb(null as unknown as DB);
  }
  assert.equal(sender.runs[0].dry, true);
  assert.deepEqual(flows(db), []);
  assert.equal(getMeta(db, SET_ASIDE_KEY), null);
  const said = (db.prepare("SELECT message FROM agent_log").all() as { message: string }[]).map((r) => r.message).join("\n");
  assert.match(said, /Creator rewards \(dry\): would claim 1\.0000 SOL: 0\.3000 SOL to trade with, 0\.7000 SOL to the payout wallet/);
});

test("pump.fun's split set: it pays out through it, warns once a day when the split isn't the owner's, says no address", async () => {
  const { db, client, sender, run } = setup({ creatorMint: coin.toBase58() });
  client.sharing = { shareholders: [{ address: agent.toBase58(), shareBps: 3000 }, { address: owner.toBase58(), shareBps: 7000 }], editable: false };
  client.waiting = { lamports: 2n * LAMPORTS, can: true };
  attachLogDb(db);
  try {
    assert.equal(await run(), "distributed");
    assert.equal(sender.runs[0].refused, null);
    assert.ok(sender.runs[0].minGain < 0n, "a distribute may cost the agent its fee");
    client.sharing = { shareholders: [{ address: agent.toBase58(), shareBps: 1000 }, { address: owner.toBase58(), shareBps: 9000 }], editable: false };
    await run();
    await run();
    client.waiting = { lamports: 1000n, can: true };
    assert.equal(await run(), "nothing", "too little to pay out");
  } finally {
    attachLogDb(null as unknown as DB);
  }
  assert.equal(client.asked.includes("vault"), false, "with a split set the agent doesn't collect as creator");
  const said = (db.prepare("SELECT message FROM agent_log").all() as { message: string }[]).map((r) => r.message);
  assert.equal(said.filter((m) => /not the owner's 30\/70/.test(m)).length, 1, said.join("\n"));
  assert.ok(said.some((m) => /paid out through pump\.fun's split: 2\.0000 SOL, 0\.6000 SOL of it to the agent/.test(m)));
  for (const m of said) for (const k of [agent, owner, coin]) assert.ok(!m.includes(k.toBase58()), "no address in what it says");
  assert.deepEqual(flows(db), [], "the agent's share is recorded by the funding ledger when it lands");
});

test("refusals: the payout wallet can't be the agent's own; a check that fails sends nothing and records nothing", async () => {
  const self = setup({ creatorPayoutWallet: agent.toBase58() });
  self.client.vault = LAMPORTS;
  await assert.rejects(self.run(), /PAYOUT_WALLET is the agent's own/);
  const bad = setup();
  bad.client.vault = LAMPORTS;
  bad.client.collectInstructions = async () => [new TransactionInstruction({ programId: Keypair.generate().publicKey, keys: [], data: Buffer.alloc(0) })];
  await assert.rejects(bad.run(), /program other than pump\.fun's/);
  assert.deepEqual(flows(bad.db), []);
});

test("the funding ledger: SOL from pump.fun that no swap explains is the agent's share of its creator rewards", () => {
  const w = agent.toBase58();
  const tx = {
    slot: 1, blockTime: 1_763_600_000,
    meta: { err: null, fee: 5000, preBalances: [5e9, 9e9], postBalances: [5e9 + 6e8 - 5000, 9e9 - 6e8], preTokenBalances: [], postTokenBalances: [], innerInstructions: [] },
    transaction: { signatures: ["s"], message: { accountKeys: [w, Keypair.generate().publicKey.toBase58()].map((k) => ({ pubkey: { toString: () => k } })), instructions: [{ programId: { toString: () => PUMP_PROGRAM } }] } },
  };
  assert.equal(classifyFlow(tx, w)?.kind, "creator_claim");
});

class PaperFake implements Executor {
  mode = "paper" as const;
  calls: string[] = [];
  async buy(_m: string, s: number): Promise<Fill> {
    this.calls.push("buy");
    return { signature: null, solAmount: s, tokenAmount: s * 1000, priceSol: 0.001 };
  }
  async sell(_m: string, t: number): Promise<Fill> {
    return { signature: null, solAmount: t * 0.001, tokenAmount: t, priceSol: 0.001 };
  }
}

test("the engine never copies a buy of the agent's own coin", async () => {
  const db = openDb(":memory:");
  const own = coin.toBase58();
  db.prepare("INSERT INTO wallets (address, first_seen_at, discovered_via, copy_weight) VALUES ('LEADER', ?, 'test', 0.5)").run(new Date().toISOString());
  db.prepare("INSERT INTO token_info (mint, symbol, decimals, pool_created_at, checked_at) VALUES (?, 'OWN', 6, '2026-01-01T00:00:00Z', ?)").run(own, new Date().toISOString());
  setMeta(db, MINT_KEY, own);
  const ex = new PaperFake();
  const swap: ParsedSwap = {
    wallet: "LEADER", signature: `sig${Math.random()}`, slot: 1, ts: new Date().toISOString(), mint: own, side: "buy", tokenAmount: 1000, tokenBalanceBefore: 0,
    solAmount: 1, priceSol: 0.001, venue: "pumpfun", jitoTip: false, feeLamports: 5000, quote: "SOL", quoteAmount: 1, solUsd: null, usdAmount: null,
  };
  await new CopyEngine(db, ex, null, null).onLeaderSwap(swap);
  assert.deepEqual(ex.calls, []);
  assert.equal((db.prepare("SELECT outcome FROM copy_decisions").get() as { outcome: string } | undefined)?.outcome, "ignored:own_coin");
});
