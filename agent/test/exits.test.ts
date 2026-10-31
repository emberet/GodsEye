/**
 * Learned exits (learning/exits.ts), the sell-quote check before a stop-loss or take-profit, and the open-trade limit set
 * by the budget. In-memory database, stubbed price API, fake executor: nothing is signed or sent.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, setMeta, SOL_MINT } from "@godseye/shared";
import type { Executor, Fill } from "../src/copy/executor";
import type { RuleScore } from "../src/replay/sweep";
import { stubFetch } from "./helpers";

process.env.COPY_STOP_LOSS_PCT = "35";
process.env.COPY_TAKE_PROFIT_PCT = "300";
process.env.COPY_MAX_POSITIONS = "0";
process.env.COPY_BUDGET_SOL = "0.35";
process.env.COPY_MAX_TRADE_SOL = "0.1";
const { chooseExits, currentExits, EXIT_PARAMS_KEY, ladderRule, plainRule, ruleName, storeExits } = await import("../src/learning/exits");
type ExitRule = import("../src/learning/exits").ExitRule;
const { CopyEngine, exitSlippageBps, sellRetryMs } = await import("../src/copy/engine");

const score = (name: string, a: number, b: number, n = 500, sol = 1): RuleScore => ({
  name, n: 2 * n, wins: n, medianPct: (a + b) / 2, meanPct: (a + b) / 2, trimmedMeanPct: (a + b) / 2, pnlSol: 2 * sol, firstHalfSol: sol, secondHalfSol: sol,
  firstHalfTrimmedPct: a, secondHalfTrimmedPct: b, firstHalfN: n, secondHalfN: n,
});
const inUse = plainRule(35, 300);
const c = (rule: ExitRule, a: number, b: number, n = 500, sol = 1) => ({ rule, score: score(ruleName(rule), a, b, n, sol) });

test("exit tuner: switches only to a rule that is better on its worse half, in both halves, inside the bands", () => {
  const pick = chooseExits([c(inUse, 1.2, 0.9), c(plainRule(50, 60), 3.0, 2.4), c(plainRule(25, 30), 5, -1)], inUse);
  assert.deepEqual([pick.stopLossPct, pick.takeProfitPct, pick.changed], [50, 60, true], "sl25 tp30 wins one half and loses the other");
  assert.equal(chooseExits([c(inUse, 1.2, 0.9), c(plainRule(50, 60), 1.3, 1.1)], inUse).changed, false, "+0.2 pp is noise");
  assert.equal(chooseExits([c(inUse, 1, 1), c(plainRule(50, 60), 4, 4, 100)], inUse).changed, false, "too few copies");
  assert.equal(chooseExits([c(inUse, 1, 1), c(plainRule(50, 60), 4, 4, 500, -0.1)], inUse).changed, false, "lost SOL in a half");
  assert.equal(chooseExits([c(inUse, 1, 1), c(plainRule(1000, 60), 9, 9)], inUse).changed, false, "outside the stop-loss band");
});

test("exit tuner: between rules within 0.1 pp, the one that lets winners run further wins", () => {
  const pick = chooseExits([c(inUse, 1, 1), c(plainRule(50, 45), 2.5, 2.3), c(ladderRule(50, 45, 30), 2.45, 2.25)], inUse);
  assert.equal(ruleName(pick), "sl50 half@45 trail30 no-ceiling");
  assert.equal(ruleName(chooseExits([c(inUse, 1, 1), c(plainRule(50, 45), 2.5, 2.3), c(ladderRule(50, 45, 30), 2.3, 2.0)], inUse)), "sl50 tp45", "a ladder clearly worse doesn't win");
  const held = plainRule(50, 45);
  assert.equal(ruleName(chooseExits([c(held, 2.30, 2.25), c(plainRule(50, 100), 2.31, 2.26)], held)), "sl50 tp100", "as good with more upside: switch without the margin");
  assert.equal(chooseExits([c(plainRule(50, 100), 2.31, 2.26), c(held, 2.32, 2.27)], plainRule(50, 100)).changed, false, "and never back down for a hair");
});

test("learned exits are used while fresh, clamped to the bands, and fall back to the config after 2 days", () => {
  const db = openDb(":memory:");
  const cfg = { stopLossPct: 35, takeProfitPct: 300 };
  assert.equal(currentExits(db, cfg).source, "config");
  storeExits(db, { ...ladderRule(50, 45, 30), reason: "test" });
  assert.deepEqual(currentExits(db, cfg), { ...ladderRule(50, 45, 30), source: "learned", reason: "test" });
  assert.equal(currentExits(db, cfg, Date.now() + 3 * 86_400_000).source, "config", "stale");
  setMeta(db, EXIT_PARAMS_KEY, JSON.stringify({ stopLossPct: 90, takeProfitPct: 5, at: new Date().toISOString() }));
  assert.deepEqual([currentExits(db, cfg).stopLossPct, currentExits(db, cfg).takeProfitPct, currentExits(db, cfg).partialTpPct], [60, 30, 0], "stop-loss band and the +30% floor hold");
});

class FakeExecutor implements Executor {
  mode = "paper" as const;
  sells: string[] = [];
  /** Slippage asked for by each sell attempt, failed ones too. */
  slips: (number | undefined)[] = [];
  /** Errors the next sell attempts throw, in order. */
  failures: string[] = [];
  quote: number | null = null;
  async buy(mint: string, sol: number): Promise<Fill> {
    return { signature: null, solAmount: sol, tokenAmount: sol * 1000, priceSol: 0.001 };
  }
  async sell(mint: string, tokens: number, _all?: boolean, slippageBps?: number): Promise<Fill> {
    this.slips.push(slippageBps);
    const fail = this.failures.shift();
    if (fail) throw new Error(fail);
    this.sells.push(mint);
    return { signature: null, solAmount: tokens * 0.0005, tokenAmount: tokens, priceSol: 0.0005 };
  }
  async quoteSellSol(): Promise<number | null> {
    return this.quote;
  }
}

const MINT = "Exit1111111111111111111111111111111111111";
function openPosition(db: ReturnType<typeof openDb>) {
  db.prepare(
    "INSERT INTO positions (mint, symbol, leader, mode, status, token_amount, tokens_bought, cost_sol, entry_price_sol, opened_at) VALUES (?, 'EXIT', 'L', 'paper', 'open', 100, 100, 0.1, 0.001, ?)",
  ).run(MINT, new Date().toISOString());
}
/** The price API says the coin is at half its entry (−50%). */
const halfPrice = () => stubFetch((url) => (url.includes("/price/") ? { [SOL_MINT]: { usdPrice: 200, decimals: 9 }, [MINT]: { usdPrice: 0.1, decimals: 6 } } : undefined));

test("a stop-loss the sell quote doesn't confirm is held; a confirmed one sells at the learned stop", async () => {
  const db = openDb(":memory:");
  storeExits(db, { ...plainRule(45, 60), reason: "test" });
  openPosition(db);
  const ex = new FakeExecutor();
  const engine = new CopyEngine(db, ex, null, null, null);
  const net = halfPrice();
  try {
    ex.quote = 0.12; // a sell would really get +20%: the feed is wrong
    await engine.managePositions();
    assert.deepEqual(ex.sells, []);
    ex.quote = 0.05; // −50%: real
    await engine.managePositions();
    assert.deepEqual(ex.sells, [MINT]);
    const row = db.prepare("SELECT exit_reason FROM positions").get() as { exit_reason: string };
    assert.match(row.exit_reason, /^stop-loss at -50(\.0+)?% \(sell quote\)$/);
  } finally {
    net.restore();
  }
});

test("with no learned exits and no quote, the configured stop (35%) applies on the feed's price", async () => {
  const db = openDb(":memory:");
  openPosition(db);
  const ex = new FakeExecutor();
  ex.quote = null;
  const net = halfPrice();
  try {
    await new CopyEngine(db, ex, null, null, null).managePositions();
    assert.deepEqual(ex.sells, [MINT]);
  } finally {
    net.restore();
  }
});

test("COPY_MAX_POSITIONS=0: no count limit; the copy budget decides how many trades are open", async () => {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO wallets (address, first_seen_at, discovered_via, copy_weight) VALUES ('L', '2026-01-01', 't', 0.5)").run();
  const ex = new FakeExecutor();
  const engine = new CopyEngine(db, ex, null, null, null);
  const net = stubFetch(() => ({}));
  try {
    for (let i = 0; i < 6; i++) {
      const m = `Cap${String(i).padStart(40, "1")}`;
      db.prepare("INSERT INTO token_info (mint, symbol, decimals, pool_created_at, checked_at) VALUES (?, 'CAP', 6, '2026-01-01T00:00:00Z', ?)").run(m, new Date().toISOString());
      // A cached rug-check pass: the real check reads holders over RPC, and a test must not depend on the network.
      db.prepare("INSERT INTO rug_checks (mint, symbol, verdict, blocks, warnings, rugcheck_score, checked_at) VALUES (?, 'CAP', 'pass', '[]', '[]', NULL, ?)").run(m, new Date().toISOString());
      await engine.onLeaderSwap({
        wallet: "L", signature: `s${i}`, slot: i, ts: new Date().toISOString(), mint: m, side: "buy", tokenAmount: 1000, tokenBalanceBefore: 0, solAmount: 1, priceSol: 0.001,
        venue: "pumpswap", jitoTip: false, feeLamports: 5000, quote: "SOL", quoteAmount: 1, solUsd: null, usdAmount: null,
      });
    }
  } finally {
    net.restore();
  }
  const open = db.prepare("SELECT COUNT(*) n, SUM(cost_sol) c FROM positions WHERE status = 'open'").get() as { n: number; c: number };
  assert.equal(open.n, 4, "0.1 + 0.1 + 0.1 + 0.05: the 0.35 SOL budget, not a count, stopped it");
  assert.ok(Math.abs(open.c - 0.35) < 1e-9);
});

test("rent reclaim: CloseAccount is instruction 9 with the account, the owner as rent receiver and the owner signing", async () => {
  const { PublicKey } = await import("@solana/web3.js");
  const { closeAccountIx } = await import("../src/copy/executor");
  const [acct, owner, prog] = [new PublicKey("So11111111111111111111111111111111111111112"), new PublicKey("52Nhb9CQwDJetd18TmBbxMDtApfxp1j7sYjKokJnpzMQ"), new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb")];
  const ix = closeAccountIx(acct, owner, prog);
  assert.deepEqual([...ix.data], [9]);
  assert.ok(ix.programId.equals(prog), "Token-2022 accounts close through Token-2022");
  assert.deepEqual(ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]), [[acct.toBase58(), false, true], [owner.toBase58(), false, true], [owner.toBase58(), true, false]]);
});

test("ladder: half sells at the target, the rest rides, then the trailing stop sells it after a fall from its best", async () => {
  const db = openDb(":memory:");
  storeExits(db, { ...ladderRule(50, 45, 30), reason: "test" });
  openPosition(db);
  const ex = new FakeExecutor();
  let usd = 0.32; // entry 0.001 SOL × $200 = $0.20 a token; $0.32 = +60%
  const net = stubFetch((url) => (url.includes("/price/") ? { [SOL_MINT]: { usdPrice: 200, decimals: 9 }, [MINT]: { usdPrice: usd, decimals: 6 } } : undefined));
  const engine = new CopyEngine(db, ex, null, null, null);
  const row = () => db.prepare("SELECT status, token_amount, partial_done, peak_pct, exit_reason FROM positions").get() as { status: string; token_amount: number; partial_done: number; peak_pct: number; exit_reason: string | null };
  try {
    await engine.managePositions();
    assert.equal(ex.sells.length, 1);
    assert.deepEqual([row().status, Math.round(row().token_amount), row().partial_done], ["open", 50, 1], "half sold at +60%, half still riding");
    usd = 0.6; // +200%: no ceiling, keeps riding
    await engine.managePositions();
    assert.equal(ex.sells.length, 1);
    assert.equal(Math.round(row().peak_pct), 200);
    usd = 0.4; // +100%: 33% below the best (+200%), past the 30% trail
    await engine.managePositions();
    assert.equal(ex.sells.length, 2);
    assert.equal(row().status, "closed");
    assert.match(row().exit_reason ?? "", /^trailing stop \(30% below its best, \+200%\) at \+100/);
  } finally {
    net.restore();
  }
});

/** A swap of MINT by someone else, at `priceSol` (entry is 0.001). */
const marketSwap = (priceSol: number, mint = MINT) => ({
  wallet: "Other", signature: `m${Math.random()}`, slot: 1, ts: new Date().toISOString(), mint, side: "sell" as const, tokenAmount: 10, tokenBalanceBefore: 10,
  solAmount: 10 * priceSol, priceSol, venue: "pumpswap", jitoTip: false, feeLamports: 5000, quote: "SOL", quoteAmount: 10 * priceSol, solUsd: null, usdAmount: null,
});
/** Lets the stream check again at once (as if its 2 s pause and any retry wait had passed). */
const timePasses = (engine: InstanceType<typeof CopyEngine>) => {
  const e = engine as unknown as { nextStreamCheck: Map<string, number>; sellFailures: Map<number, { until: number }> };
  e.nextStreamCheck.clear();
  for (const f of e.sellFailures.values()) f.until = 0;
};

test("live stream: a swap below the stop sells at once; a coin GodsEye doesn't hold is ignored; one check per coin every 2 s", async () => {
  const db = openDb(":memory:");
  storeExits(db, { ...plainRule(45, 60), reason: "test" });
  openPosition(db);
  const ex = new FakeExecutor();
  const engine = new CopyEngine(db, ex, null, null, null);
  assert.equal(engine.onMarketSwap(marketSwap(0.0001, "Other111111111111111111111111111111111111")), undefined, "not held: nothing to do");
  await engine.onMarketSwap(marketSwap(0.0009)); // −10%: no exit
  assert.deepEqual(ex.sells, []);
  assert.equal(engine.onMarketSwap(marketSwap(0.0004)), undefined, "within 2 s of the last check of this coin");
  timePasses(engine);
  await engine.onMarketSwap(marketSwap(0.0004)); // −60%
  assert.deepEqual(ex.sells, [MINT]);
  const row = db.prepare("SELECT status, exit_reason FROM positions").get() as { status: string; exit_reason: string };
  assert.equal(row.status, "closed");
  assert.match(row.exit_reason, /^stop-loss at -60(\.0+)?% \(stream\)$/);
  timePasses(engine);
  assert.equal(engine.onMarketSwap(marketSwap(0.0004)), undefined, "closed: the coin is no longer watched");
});

test("a stop-loss that fails on slippage is retried after 15 s at 10%, then 25%; a rate limit doesn't widen it", async () => {
  const db = openDb(":memory:");
  storeExits(db, { ...plainRule(45, 60), reason: "test" });
  openPosition(db);
  const ex = new FakeExecutor();
  ex.failures = [
    'transaction failed on-chain: {"InstructionError":[3,{"Custom":6001}]}',
    "429 Too Many Requests from lite-api.jup.ag",
    'transaction failed on-chain: {"InstructionError":[3,{"Custom":6001}]}',
  ];
  const engine = new CopyEngine(db, ex, null, null, null);
  await engine.onMarketSwap(marketSwap(0.0004));
  timePasses(engine);
  await engine.onMarketSwap(marketSwap(0.0004));
  timePasses(engine);
  await engine.onMarketSwap(marketSwap(0.0004));
  timePasses(engine);
  await engine.onMarketSwap(marketSwap(0.0004));
  assert.deepEqual(ex.slips, [300, 1000, 1000, 2500]);
  assert.deepEqual(ex.sells, [MINT]);
  assert.deepEqual([sellRetryMs(1), sellRetryMs(2), sellRetryMs(3), sellRetryMs(10)], [15_000, 30_000, 60_000, 300_000]);
  assert.deepEqual([exitSlippageBps(0), exitSlippageBps(1), exitSlippageBps(2), exitSlippageBps(9)], [300, 1000, 2500, 2500]);
});

test("a failed sell isn't retried before its wait is over, and a take-profit keeps the normal 3% slippage", async () => {
  const db = openDb(":memory:");
  storeExits(db, { ...plainRule(45, 60), reason: "test" });
  openPosition(db);
  const ex = new FakeExecutor();
  ex.failures = ['transaction failed on-chain: {"InstructionError":[3,{"Custom":6001}]}'];
  const engine = new CopyEngine(db, ex, null, null, null);
  await engine.onMarketSwap(marketSwap(0.002)); // +100%: take-profit
  (engine as unknown as { nextStreamCheck: Map<string, number> }).nextStreamCheck.clear();
  assert.equal(await engine.onMarketSwap(marketSwap(0.002)), undefined);
  assert.deepEqual(ex.slips, [300], "still inside the 15 s wait");
  timePasses(engine);
  await engine.onMarketSwap(marketSwap(0.002));
  assert.deepEqual(ex.slips, [300, 300]);
  assert.match((db.prepare("SELECT exit_reason FROM positions").get() as { exit_reason: string }).exit_reason, /^take-profit/);
});

test("close-all sells every open position, retrying a slippage failure at 10%", async () => {
  const db = openDb(":memory:");
  openPosition(db);
  const ex = new FakeExecutor();
  ex.failures = ['transaction failed on-chain: {"InstructionError":[3,{"Custom":6001}]}'];
  const engine = new CopyEngine(db, ex, null, null, null);
  assert.deepEqual(await engine.closeAll("closed by owner", 3, 0), { closed: 1, left: 0 });
  assert.deepEqual(ex.slips, [300, 1000]);
  const row = db.prepare("SELECT status, exit_reason FROM positions").get() as { status: string; exit_reason: string };
  assert.deepEqual(row, { status: "closed", exit_reason: "closed by owner" });
});
