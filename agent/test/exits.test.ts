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
const { CopyEngine } = await import("../src/copy/engine");

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
  quote: number | null = null;
  async buy(mint: string, sol: number): Promise<Fill> {
    return { signature: null, solAmount: sol, tokenAmount: sol * 1000, priceSol: 0.001 };
  }
  async sell(mint: string, tokens: number): Promise<Fill> {
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
