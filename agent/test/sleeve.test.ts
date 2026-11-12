/**
 * The Brain sleeve (brain/sleeve.ts) and the engine's side of it: which signals it takes, how its buys are sized and
 * recorded, how it follows its paper twin's sells, its exits, its share, and what a restart keeps. Paper executor,
 * in-memory database, made-up wallets: nothing signs or sends anything.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, setMeta, type DB } from "@godseye/shared";
import type { ParsedSwap } from "../src/chain/parse";
import type { Executor, Fill } from "../src/copy/executor";

process.env.COPY_BUDGET_SOL = "1";
process.env.COPY_MAX_TRADE_SOL = "0.1";
process.env.COPY_MAX_POSITIONS = "0";
const { CopyEngine } = await import("../src/copy/engine");
const { BrainSleeve, MIN_CLOSED, signalHash } = await import("../src/brain/sleeve");
const { ensureBrainTables } = await import("../src/brain/schema");
const { recoverPending } = await import("../src/copy/recovery");
const { attachLogDb } = await import("../src/log");
type LeaderBuy = import("../src/brain/paper").LeaderBuy;

class FakeExecutor implements Executor {
  mode = "paper" as const;
  calls: string[] = [];
  async buy(_m: string, sol: number): Promise<Fill> {
    this.calls.push(`buy ${sol}`);
    return { signature: null, solAmount: sol, tokenAmount: sol * 1000, priceSol: 0.001 };
  }
  async sell(_m: string, tokens: number): Promise<Fill> {
    this.calls.push(`sell ${tokens}`);
    return { signature: null, solAmount: tokens * 0.001, tokenAmount: tokens, priceSol: 0.001 };
  }
}

let n = 0;
const mint = () => `Mint${String(++n).padStart(39, "1")}`;
/** A signature the sleeve takes (or not, with want = false) at a 50% share. */
function sig(want: boolean): string {
  for (let i = 0; ; i++) {
    const s = `sig-${n}-${i}-${want}`;
    if (signalHash(s) < 0.5 === want) return s;
  }
}

function setup(o: { licensed?: boolean; decider?: "auto" | "rules" | "split" | "brain"; now?: () => number } = {}) {
  const db = openDb(":memory:");
  ensureBrainTables(db);
  db.prepare("INSERT INTO wallets (address, first_seen_at, discovered_via, copy_weight) VALUES ('LEADER', ?, 'test', 0.5)").run(new Date().toISOString());
  const ex = new FakeExecutor();
  const engine = new CopyEngine(db, ex, null, null);
  let licensed = o.licensed ?? true;
  const sleeve = new BrainSleeve(db, engine, { licensed: () => (licensed ? { version: "v-real" } : null), decider: o.decider ?? "auto", maxDelaySeconds: 20, now: o.now });
  engine.sleeve = sleeve;
  return { db, ex, engine, sleeve, license: (on: boolean) => (licensed = on) };
}
function token(db: DB, m = mint()): string {
  db.prepare("INSERT INTO token_info (mint, symbol, decimals, pool_created_at, checked_at) VALUES (?, 'MOO', 6, '2026-01-01T00:00:00Z', ?)").run(m, new Date().toISOString());
  return m;
}
const leaderSwap = (m: string, signature: string, p: Partial<ParsedSwap> = {}): ParsedSwap => ({
  wallet: "LEADER", signature, slot: 1, ts: new Date().toISOString(), mint: m, side: "buy", tokenAmount: 1000, tokenBalanceBefore: 0,
  solAmount: 1, priceSol: 0.001, venue: "jupiter", jitoTip: false, feeLamports: 5000, quote: "SOL", quoteAmount: 1, solUsd: null, usdAmount: null, ...p,
});
const buy = (m: string, signature: string, t = Date.now()): LeaderBuy => ({ leader: "LEADER", mint: m, symbol: "MOO", solAmount: 1, priceSol: 0.001, signature, t, venue: "jupiter", tokenAmount: 1000, tokenBalanceBefore: 0 });
const paperTwin = (db: DB, m: string, status = "open") =>
  Number(db.prepare(`INSERT INTO brain_paper_positions (account, leader, mint, symbol, opened_at, status, stake_frac, cost_sol, fee_sol, rent_sol, tokens, tokens_left, entry_price_sol)
                     VALUES ('brain', 'LEADER', ?, 'MOO', ?, ?, 0.5, 0.05, 0, 0, 50, 50, 0.001)`).run(m, new Date().toISOString(), status).lastInsertRowid);

test("the split: a hash of the signature, half each at the start; nothing without a licence or with REAL_DECIDER=rules; all with brain", () => {
  const { sleeve, license } = setup();
  const sigs = Array.from({ length: 2000 }, (_, i) => `s${i}`);
  const taken = sigs.filter((s) => sleeve.takes(s)).length;
  assert.ok(taken > 900 && taken < 1100, `${taken}`);
  assert.equal(sigs.filter((s) => sleeve.takes(s)).length, taken, "the same signal always goes the same way");
  license(false);
  assert.equal(sigs.some((s) => sleeve.takes(s)), false);
  assert.equal(setup({ decider: "rules" }).sleeve.takes(sig(true)), false);
  const all = setup({ decider: "brain" }).sleeve;
  assert.ok(sigs.every((s) => all.takes(s)));
});

test("the rules leave the sleeve's signals alone and copy the others", async () => {
  const { db, ex, engine } = setup();
  const [a, b] = [token(db), token(db)];
  await engine.onLeaderSwap(leaderSwap(a, sig(true)));
  assert.deepEqual(ex.calls, [], "the sleeve's signal");
  assert.equal((db.prepare("SELECT outcome FROM copy_decisions").get() as { outcome: string }).outcome, "ignored:brain_sleeve");
  await engine.onLeaderSwap(leaderSwap(b, sig(false)));
  assert.deepEqual(ex.calls, ["buy 0.1"], "1 SOL budget × 0.5 weight, capped at 0.1");
});

test("a Brain buy: staked at its twin's fraction of the trade size, recorded as the Brain's, linked to its twin, sold as its twin sells", async () => {
  const { db, ex, sleeve } = setup();
  const m = token(db);
  const s = sig(true);
  sleeve.entry(buy(m, s), 0.8, "v-real");
  await sleeve.drain();
  assert.deepEqual(ex.calls, ["buy 0.08"], "0.8 of the 0.1 SOL trade size");
  const ct = db.prepare("SELECT decider, reason, size_sol FROM copy_trades").get() as { decider: string; reason: string; size_sol: number };
  assert.equal(ct.decider, "brain");
  assert.match(ct.reason, /Brain sleeve: stake 80% of a trade \(model v-real\)/);
  const pos = db.prepare("SELECT id, decider, brain_paper_id FROM positions").get() as { id: number; decider: string; brain_paper_id: number | null };
  assert.equal(pos.decider, "brain");
  // The twin fills after its copy delay and links then.
  const twin = paperTwin(db, m);
  sleeve.opened(twin, s);
  assert.equal((db.prepare("SELECT brain_paper_id FROM positions WHERE id = ?").get(pos.id) as { brain_paper_id: number }).brain_paper_id, twin);
  // A leader's sell leaves it alone; its twin's sells move it.
  const { engine } = { engine: (sleeve as unknown as { engine: InstanceType<typeof CopyEngine> }).engine };
  await engine.onLeaderSwap(leaderSwap(m, `sell-${n}`, { side: "sell", tokenAmount: 1000, tokenBalanceBefore: 1000 }));
  assert.deepEqual(ex.calls, ["buy 0.08"], "a leader's sell is not a Brain sell");
  sleeve.sold(twin, 0.5, false, "exit network: sell_half");
  await sleeve.drain();
  assert.deepEqual(ex.calls, ["buy 0.08", "sell 40"]);
  sleeve.sold(twin, 1, true, "exit network: sell_all");
  await sleeve.drain();
  assert.deepEqual(ex.calls, ["buy 0.08", "sell 40", "sell 40"]);
  const closed = db.prepare("SELECT status, exit_reason FROM positions WHERE id = ?").get(pos.id) as { status: string; exit_reason: string };
  assert.equal(closed.status, "closed");
  assert.match(closed.exit_reason, /^Brain sleeve: exit network: sell_all/);
});

test("a twin that opens before the real buy lands is linked when it lands", async () => {
  const { db, sleeve } = setup();
  const m = token(db);
  const s = sig(true);
  const twin = paperTwin(db, m);
  sleeve.opened(twin, s); // nothing to link yet
  sleeve.entry(buy(m, s), 1, null);
  await sleeve.drain();
  assert.equal((db.prepare("SELECT brain_paper_id FROM positions").get() as { brain_paper_id: number }).brain_paper_id, twin);
});

test("no trade: a signal the rules own, a slow decision, a wallet the rules don't copy, or no licence", async () => {
  const { db, ex, sleeve, license } = setup();
  sleeve.entry(buy(token(db), sig(false)), 1, null);
  sleeve.entry(buy(token(db), sig(true), Date.now() - 25_000), 1, null);
  sleeve.entry({ ...buy(token(db), sig(true)), leader: "STRANGER" }, 1, null);
  license(false);
  sleeve.entry(buy(token(db), sig(true)), 1, null);
  await sleeve.drain();
  assert.deepEqual(ex.calls, []);
});

test("exits: hard stops only while its twin is open; the rules' exits once the Brain is quiet", async () => {
  const { db, sleeve, license } = setup();
  const m = token(db);
  const s = sig(true);
  sleeve.entry(buy(m, s), 1, null);
  await sleeve.drain();
  const pos = () => db.prepare("SELECT * FROM positions").get() as import("../src/copy/fills").PositionRow;
  assert.equal(sleeve.follows(pos()), true, "not linked yet, but young: still the Brain's");
  const twin = paperTwin(db, m);
  sleeve.opened(twin, s);
  assert.equal(sleeve.follows(pos()), true);
  db.prepare("UPDATE brain_paper_positions SET status = 'closed' WHERE id = ?").run(twin);
  assert.equal(sleeve.follows(pos()), false, "its twin closed: the rules' exits");
  db.prepare("UPDATE brain_paper_positions SET status = 'open' WHERE id = ?").run(twin);
  license(false);
  assert.equal(sleeve.follows(pos()), false, "the licence ended");
});

test("a restart recovers a pending Brain buy with its decider", async () => {
  const db = openDb(":memory:");
  const t = new Date(Date.now() - 3_600_000).toISOString();
  db.prepare(`INSERT INTO copy_trades (leader, leader_signature, leader_ts, mint, symbol, side, mode, status, size_sol, created_at, decider)
              VALUES ('LEADER', 'ls', ?, 'MINTX', 'X', 'buy', 'real', 'pending', 0.05, ?, 'brain')`).run(t, t);
  const r = await recoverPending(db, { before: new Date().toISOString(), held: async () => 50 });
  assert.equal(r.opened, 1);
  assert.equal((db.prepare("SELECT decider FROM positions").get() as { decider: string }).decider, "brain");
});

test("the share moves 10 points towards the side that made more per SOL, within 20–80%, after enough trades on both; it says when it turns on and off", () => {
  const { db, sleeve, license } = setup();
  attachLogDb(db);
  try {
    sleeve.step();
    const close = (decider: string, pnl: number, k: number) => {
      for (let i = 0; i < k; i++)
        db.prepare(`INSERT INTO positions (mint, leader, mode, status, token_amount, tokens_bought, cost_sol, entry_price_sol, opened_at, closed_at, pnl_sol, decider)
                    VALUES (?, 'LEADER', 'paper', 'closed', 0, 1, 0.1, 0.001, ?, ?, ?, ?)`).run(mint(), new Date().toISOString(), new Date(Date.now() + 1000).toISOString(), pnl, decider);
    };
    close("brain", 0.01, MIN_CLOSED);
    close("rules", -0.01, MIN_CLOSED - 1);
    sleeve.step();
    assert.equal(sleeve.share(), 0.5, "the rules have too few closed trades");
    close("rules", -0.01, 1);
    sleeve.step();
    assert.equal(sleeve.share(), 0.6);
    for (let i = 0; i < 5; i++) {
      close("brain", 0.01, MIN_CLOSED);
      close("rules", -0.01, MIN_CLOSED);
      sleeve.step();
    }
    assert.equal(sleeve.share(), 0.8, "never above 80%");
    license(false);
    sleeve.step();
  } finally {
    attachLogDb(null as unknown as DB);
  }
  const said = (db.prepare("SELECT message FROM agent_log ORDER BY id").all() as { message: string }[]).map((r) => r.message);
  assert.ok(said.some((m) => /^Brain sleeve on: model v-real passed the real-money check\. It decides 50% of real copies/.test(m)), said.join("\n"));
  assert.ok(said.some((m) => /^Brain sleeve share 50% → 60%/.test(m)));
  assert.ok(said.some((m) => /^Brain sleeve off/.test(m)));
  setMeta(db, "brain_sleeve", "{broken");
  assert.equal(sleeve.share(), 0.5, "a broken state row starts over");
});
