import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, setMeta } from "../src/db";
import { getSummary } from "../src/dashboard-data";
import { publicView } from "../src/public-view";

const OWN = "OwnWa11etAddressForTestsOnly1111111111111111";
const NOW = Date.now();
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const DAY = 86_400_000;

function seed() {
  const db = openDb(":memory:");
  setMeta(db, "copy_mode", "real");
  setMeta(db, "wallet_pubkey", OWN);
  const pos = db.prepare(
    `INSERT INTO positions (mint, leader, mode, status, token_amount, tokens_bought, cost_sol, entry_price_sol, opened_at, closed_at, pnl_sol, pnl_usd, decider)
     VALUES (?, 'LEADER', 'real', ?, 1, 1, 0.1, 0.1, ?, ?, ?, ?, ?)`,
  );
  pos.run("R1", "closed", iso(3 * DAY), iso(2 * DAY), 0.02, 4, "rules");
  pos.run("R2", "closed", iso(3 * DAY), iso(2 * DAY), -0.05, -10, "rules");
  pos.run("B1", "closed", iso(2 * DAY), iso(DAY), 0.03, 6, "brain");
  pos.run("B2", "open", iso(DAY), null, null, null, "brain");
  pos.run("OLD", "closed", iso(20 * DAY), iso(19 * DAY), -0.1, -20, "rules");
  const w = db.prepare("INSERT INTO weight_history (wallet, ts, old_weight, new_weight, reason) VALUES (?, ?, ?, ?, 'test')");
  w.run("A", iso(DAY), 0, 0.2);
  w.run("B", iso(DAY), 0.3, 0);
  w.run("C", iso(DAY), 0.1, 0.2);
  w.run("D", iso(DAY), 0.3, 0.1);
  w.run("E", iso(10 * DAY), 0, 0.5); // older than a week
  w.run(OWN, iso(DAY), 0, 0.5); // never the agent's own wallet
  db.prepare("INSERT INTO param_history (key, ts, old_value, new_value, reason) VALUES ('k', ?, 1, 2, 'test')").run(iso(DAY));
  return db;
}

test("summary: real results by who decided, over the P&L period", () => {
  const db = seed();
  setMeta(db, "pnl_since", iso(10 * DAY));
  const s = getSummary(db);
  const [rules, brain] = s.real!.deciders;
  assert.equal(rules.decider, "rules");
  assert.equal(rules.closed, 2);
  assert.equal(rules.won, 1);
  assert.ok(Math.abs(rules.pnlSol + 0.03) < 1e-9);
  assert.equal(rules.pnlUsd, -6);
  assert.equal(brain.closed, 1);
  assert.equal(brain.open, 1);
  assert.equal(brain.pnlUsd, 6);
  // All-time sits next to the "since" figures.
  assert.equal(s.closedPositions, 3);
  assert.equal(s.allTime?.closedPositions, 4);
  assert.equal(s.allTime?.realizedPnlUsd, -20);
  setMeta(db, "pnl_since", "");
  assert.equal(getSummary(db).allTime, null);
});

test("summary: the Brain sleeve reads on, waiting or off", () => {
  const db = seed();
  assert.deepEqual(getSummary(db).real?.sleeve, { state: "waiting", sharePct: null });
  setMeta(db, "brain_sleeve", JSON.stringify({ share: 0.6, since: iso(0), model: "v9" }));
  assert.deepEqual(getSummary(db).real?.sleeve, { state: "on", sharePct: 60 });
  setMeta(db, "real_decider", "brain");
  assert.deepEqual(getSummary(db).real?.sleeve, { state: "on", sharePct: 100 });
  setMeta(db, "real_decider", "rules");
  assert.deepEqual(getSummary(db).real?.sleeve, { state: "off", sharePct: null });
  setMeta(db, "copy_mode", "paper");
  assert.equal(getSummary(db).real, null);
});

test("summary: the week's changes", () => {
  const w = getSummary(seed()).week;
  assert.deepEqual(
    { started: w.started, stopped: w.stopped, raised: w.raised, lowered: w.lowered, ruleChanges: w.ruleChanges, closedCopies: w.closedCopies },
    { started: 1, stopped: 1, raised: 1, lowered: 1, ruleChanges: 1, closedCopies: 3 },
  );
  assert.equal(w.modelVersion, null);
});

test("summary: funding totals stay apart from profit, and say nothing about where money went", () => {
  const db = seed();
  assert.equal(getSummary(db).funding, null);
  const f = db.prepare("INSERT INTO wallet_flows (signature, slot, ts, kind, sol, expected, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)");
  f.run("sig1", 1, iso(DAY), "deposit", 2, iso(DAY));
  f.run("sig2", 2, iso(DAY), "withdrawal", -0.5, iso(DAY));
  f.run("sig3", 3, iso(DAY), "creator_claim", 1, iso(DAY));
  f.run("sig4", 4, iso(DAY), "payout", -0.7, iso(DAY));
  f.run("sig5", 5, iso(DAY), "swap", 3, iso(DAY));
  const s = getSummary(db);
  assert.deepEqual(s.funding, { depositsSol: 2, withdrawalsSol: 0.5, rewardsInSol: 1, payoutsSol: 0.7 });
  const pub = JSON.stringify(publicView("summary", s, OWN));
  assert.ok(!pub.includes(OWN));
  assert.ok(!pub.includes("sig1"));
  assert.match(pub, /"funding":\{"depositsSol":2/);
  assert.match(pub, /"sleeve":\{"state":"waiting"/);
});
