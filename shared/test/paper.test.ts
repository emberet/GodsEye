import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, setMeta, type DB } from "../src/db";
import { buildDashboardSnapshot, downsampleSeries, getPaper } from "../src/dashboard-data";
import { publicView } from "../src/public-view";
import { SNAPSHOT_KEYS } from "../src/snapshot-store";

// The paper tables as agent/src/brain/paper.ts creates them (the columns getPaper reads, plus the rest of the spec).
function paperTables(db: DB) {
  db.exec(`
    CREATE TABLE brain_paper_accounts (account TEXT PRIMARY KEY, bankroll_sol REAL, cash_sol REAL, started_at TEXT, day TEXT, day_loss_sol REAL);
    CREATE TABLE brain_paper_positions (
      id INTEGER PRIMARY KEY, account TEXT, leader TEXT, mint TEXT, symbol TEXT, opened_at TEXT, closed_at TEXT, status TEXT,
      stake_frac REAL, cost_sol REAL, fee_sol REAL, rent_sol REAL, tokens REAL, tokens_left REAL, entry_price_sol REAL,
      last_price_sol REAL, last_price_ts TEXT, peak_pct REAL, half_sold INTEGER, proceeds_sol REAL, pnl_sol REAL, pnl_pct REAL,
      exit_reason TEXT, model_version TEXT, explore INTEGER, exit_rule TEXT, social_score REAL);
    CREATE TABLE brain_paper_equity (account TEXT, ts TEXT, equity_sol REAL);
    CREATE TABLE brain_models (version TEXT PRIMARY KEY, loaded_at TEXT, manifest TEXT, status TEXT, error TEXT);
  `);
}

const at = (min: number) => new Date(Date.UTC(2026, 10, 7, 0, min)).toISOString();

function seed() {
  const db = openDb(":memory:");
  paperTables(db);
  setMeta(db, "wallet_pubkey", "COWOWNWALLET");
  db.prepare("INSERT INTO token_info (mint, symbol, checked_at) VALUES ('M2', 'TWO', ?)").run(at(0));
  const acct = db.prepare("INSERT INTO brain_paper_accounts (account, bankroll_sol, cash_sol, started_at, day, day_loss_sol) VALUES (?, ?, ?, ?, '2026-11-07', 0)");
  acct.run("brain", 10, 10, at(0));
  acct.run("baseline", 10, 10, at(0));
  acct.run("explore", 2, 2, at(0));
  const pos = db.prepare(
    `INSERT INTO brain_paper_positions (account, leader, mint, symbol, opened_at, closed_at, status, cost_sol, fee_sol, rent_sol, pnl_sol, pnl_pct, exit_reason, social_score)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0.001, 0.002, ?, ?, ?, 0.9)`,
  );
  // Brain: +1, −2, +0.5 closed (equity 10 → 11 → 9 → 9.5), one still open. No equity marks: the curve comes from closes.
  pos.run("brain", "LEADERA", "M1", "ONE", at(1), at(10), "closed", 1, 1, 100, "model_sell_all");
  pos.run("brain", "LEADERB", "M2", null, at(2), at(20), "closed", 1, -2, -66, "stop_loss");
  pos.run("brain", "COWOWNWALLET", "M3", "THREE", at(3), at(30), "closed", 1, 0.5, 50, "max_hold");
  pos.run("brain", "LEADERA", "M4", "FOUR", at(4), null, "open", 1, null, null, null);
  // Baseline: one losing close, plus 600 equity marks ending at 10.8.
  pos.run("baseline", "LEADERA", "M1", "ONE", at(1), at(15), "closed", 0.5, -0.2, -40, "stop_loss");
  const mark = db.prepare("INSERT INTO brain_paper_equity (account, ts, equity_sol) VALUES ('baseline', ?, ?)");
  for (let i = 0; i < 600; i++) mark.run(at(i), i === 300 ? 8 : i === 200 ? 12 : i === 599 ? 10.8 : 10);
  const model = db.prepare("INSERT INTO brain_models (version, loaded_at, manifest, status, error) VALUES (?, ?, ?, ?, ?)");
  const manifest = {
    version: "v1",
    created_at: "2026-11-07T12:00:00Z",
    entry: { features: ["leader_n_prior", "social_score"] },
    metrics: {
      validation: { pnl_sol: 1.5, win_rate: 0.55, social_lift: 0.2, note: "text", by_week: { w1: 0.1, social_w: 3 }, feature_count: 40 },
      stress: { worst_drawdown_pct: -12 },
      baseline: { pnl_sol: 0.4 },
    },
  };
  model.run("v1", at(5), JSON.stringify(manifest), "active", null);
  model.run("v2", at(9), "{}", "failed", "could not load /secret/path");
  return db;
}

test("paper: an empty database gives the empty shape", () => {
  const db = openDb(":memory:");
  const p = getPaper(db);
  assert.deepEqual(p.accounts, []);
  assert.deepEqual(p.equity, { brain: [], baseline: [], explore: [] });
  assert.deepEqual(p.trades, []);
  assert.equal(p.model, null);
  assert.equal(p.live.streaming, false);
  // Tables created but nothing traded yet: same shape, accounts at their bankroll.
  paperTables(db);
  assert.deepEqual(getPaper(db).accounts, []);
});

test("paper: P&L, win rate, drawdown and equity series per account", () => {
  const p = getPaper(seed());
  assert.deepEqual(p.accounts.map((a) => a.account), ["brain", "baseline", "explore"]);
  const [brain, baseline, explore] = p.accounts;

  assert.equal(brain.startingSol, 10);
  assert.ok(Math.abs(brain.equitySol - 9.5) < 1e-9);
  assert.ok(Math.abs(brain.pnlSol + 0.5) < 1e-9);
  assert.ok(Math.abs((brain.returnPct ?? 0) + 5) < 1e-9);
  assert.ok(Math.abs((brain.winRate ?? 0) - 200 / 3) < 1e-9);
  assert.ok(Math.abs(brain.maxDrawdownPct - ((9 - 11) / 11) * 100) < 1e-9);
  assert.equal(brain.closedTrades, 3);
  assert.equal(brain.openTrades, 1);
  assert.deepEqual(p.equity.brain.map((e) => e.equity), [10, 11, 9, 9.5]);
  assert.equal(p.equity.brain[0].ts, at(0));

  // Marked equity wins over closes; drawdown from the 12 high to the 8 low, over the full series before downsampling.
  assert.ok(Math.abs(baseline.equitySol - 10.8) < 1e-9);
  assert.ok(Math.abs(baseline.pnlSol - 0.8) < 1e-9);
  assert.equal(baseline.winRate, 0);
  assert.ok(Math.abs(baseline.maxDrawdownPct - ((8 - 12) / 12) * 100) < 1e-9);
  assert.equal(p.equity.baseline.length, 500);
  assert.equal(p.equity.baseline[0].ts, at(0));
  assert.equal(p.equity.baseline.at(-1)?.equity, 10.8);

  assert.equal(explore.closedTrades, 0);
  assert.equal(explore.winRate, null);
  assert.equal(explore.pnlSol, 0);
  assert.equal(explore.maxDrawdownPct, 0);
  assert.deepEqual(p.equity.explore, [{ ts: at(0), equity: 2 }]);
});

test("paper: recent trades newest first, symbol from token_info, stake is cost, never the agent's own wallet", () => {
  const p = getPaper(seed());
  assert.deepEqual(p.trades.map((t) => t.mint), ["M3", "M2", "M1", "M1"]);
  assert.equal(p.trades[1].symbol, "TWO");
  assert.equal(p.trades[0].leader, null);
  assert.equal(p.trades[1].leader, "LEADERB");
  assert.equal(p.trades[0].stake_sol, 1);
  assert.equal(p.trades[0].exit_reason, "max_hold");
  assert.ok(!JSON.stringify(p).includes("COWOWNWALLET"));
});

test("paper: the model shows when it was made and whether it may trade real money, no scores or inputs", () => {
  const db = seed();
  const p = getPaper(db);
  assert.equal(p.model?.version, "v1");
  assert.equal(p.model?.createdAt, "2026-11-07T12:00:00Z");
  assert.equal(p.model?.realMoney, false);
  assert.deepEqual(Object.keys(p.model ?? {}).sort(), ["createdAt", "loadedAt", "realMoney", "version"]);
  const json = JSON.stringify(p);
  assert.ok(!/social/i.test(json));
  assert.ok(!json.includes("leader_n_prior"));
  assert.ok(!json.includes("pnl_sol\":1.5"));
  assert.ok(!json.includes("/secret/path"));
  // A manifest that passed the real-money check.
  db.prepare("UPDATE brain_models SET manifest = ? WHERE version = 'v1'").run(JSON.stringify({ created_at: "2026-11-07T12:00:00Z", real_test: true, brain_enabled: true }));
  assert.equal(getPaper(db).model?.realMoney, true);
});

test("paper: live only while the stream delivers", () => {
  const db = seed();
  assert.equal(getPaper(db).live.streaming, false);
  const now = new Date().toISOString();
  setMeta(db, "heartbeat", now);
  setMeta(db, "agent_status", "live");
  setMeta(db, "stream_status", "connected");
  setMeta(db, "stream_last_at", now);
  assert.equal(getPaper(db).live.streaming, true);
  assert.equal(getPaper(db, Date.now() + 5 * 60_000).live.streaming, false);
});

test("paper: published in the snapshot, and publicView passes it through with nothing social", () => {
  assert.ok((SNAPSHOT_KEYS as readonly string[]).includes("paper"));
  const db = seed();
  const snap = buildDashboardSnapshot(db);
  assert.deepEqual(snap.paper, getPaper(db));
  const body = { ...getPaper(db), social: { score: 1 }, trades: [{ account: "brain", mint: "M", socialScore: 0.9, pnl_sol: 1 }] };
  const out = publicView("paper", body);
  assert.deepEqual(out.accounts, body.accounts);
  assert.deepEqual(out.equity, body.equity);
  assert.deepEqual(out.model, body.model);
  assert.deepEqual(out.trades, [{ account: "brain", mint: "M", pnl_sol: 1 }]);
  assert.ok(!/social/i.test(JSON.stringify(out)));
});

test("downsampleSeries keeps at most max points, first and last included", () => {
  const xs = Array.from({ length: 1001 }, (_, i) => i);
  const d = downsampleSeries(xs, 500);
  assert.equal(d.length, 500);
  assert.equal(d[0], 0);
  assert.equal(d.at(-1), 1000);
  assert.deepEqual(downsampleSeries([1, 2, 3], 500), [1, 2, 3]);
});
