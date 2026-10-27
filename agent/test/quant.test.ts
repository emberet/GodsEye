import { test } from "node:test";
import assert from "node:assert/strict";
import { HARD_MAX_COPY_TRADE_SOL, openDb, QUANT_SCHEMA_SQL, type SizingParamsRow } from "@godseye/shared";
import { applyQuantSizing, quantClamp, quantSizingMode, skillGateBlocks } from "../src/copy/quant";
import { copySize } from "../src/learning/weights";

const cfg = { copyBudgetSol: 1, copyMinTradeSol: 0.01, copyMaxTradeSol: 0.1 };
const NOW = 1_800_000_000;
const row = (p: Partial<SizingParamsRow> = {}): SizingParamsRow => ({
  leader: "L", computed_at: NOW - 60, valid_until: NOW + 3600, n: 50, edge: 0.05, vol: 0.3, kelly_full: 0.5, kelly_mult: 0.125, max_drawdown: 0.2, risk_of_ruin: 0.01, ...p,
});

test("QUANT_SIZING defaults to off and only accepts off|shadow|on", () => {
  assert.equal(quantSizingMode({}), "off");
  assert.equal(quantSizingMode({ QUANT_SIZING: "ON" }), "on");
  assert.equal(quantSizingMode({ QUANT_SIZING: "shadow" }), "shadow");
  assert.equal(quantSizingMode({ QUANT_SIZING: "max" }), "off");
});

test("a fresh row reduces the size to budget x weight x multiplier", () => {
  const base = copySize(0.5, cfg); // 0.1 (capped)
  const r = quantClamp(base, 0.5, cfg, row({ kelly_mult: 0.1 }), NOW);
  assert.equal(r.size, 0.05);
});

test("the clamp never increases the size, whatever the row says", () => {
  for (const kelly_mult of [0, 0.01, 0.25, 1, 5, Number.POSITIVE_INFINITY, -1]) {
    for (const weight of [0, 0.01, 0.2, 1, 10]) {
      const base = copySize(Math.min(weight, 1), cfg);
      const r = quantClamp(base, weight, cfg, row({ kelly_mult }), NOW);
      assert.ok(r.size <= base + 1e-12, `kelly_mult ${kelly_mult} weight ${weight}`);
      assert.ok(r.size <= cfg.copyMaxTradeSol && r.size <= HARD_MAX_COPY_TRADE_SOL && r.size >= 0);
    }
  }
});

test("stale or missing rows fall back to the current formula", () => {
  assert.deepEqual(quantClamp(0.1, 0.5, cfg, row({ valid_until: NOW - 1 }), NOW).size, 0.1);
  assert.equal(quantClamp(0.1, 0.5, cfg, row({ valid_until: NOW - 1 }), NOW).quantSize, null);
  assert.equal(quantClamp(0.1, 0.5, cfg, null, NOW).size, 0.1);
});

test("shadow logs but keeps the real size; on applies; off ignores; missing tables are fine", () => {
  const db = openDb(":memory:");
  assert.equal(applyQuantSizing(db, "L", 0.1, 0.5, cfg, "on", NOW).size, 0.1); // no table yet
  db.exec(QUANT_SCHEMA_SQL);
  const r = row({ kelly_mult: 0.1 });
  db.prepare("INSERT INTO sizing_params VALUES (@leader,@computed_at,@valid_until,@n,@edge,@vol,@kelly_full,@kelly_mult,@max_drawdown,@risk_of_ruin)").run(r);
  const off = applyQuantSizing(db, "L", 0.1, 0.5, cfg, "off", NOW);
  assert.deepEqual(off, { size: 0.1, log: null });
  const sh = applyQuantSizing(db, "L", 0.1, 0.5, cfg, "shadow", NOW);
  assert.equal(sh.size, 0.1);
  assert.match(sh.log ?? "", /quant 0\.0500 SOL/);
  assert.equal(applyQuantSizing(db, "L", 0.1, 0.5, cfg, "on", NOW).size, 0.05);
  assert.equal(applyQuantSizing(db, "L", 0.1, 0.5, cfg, "on", NOW + 7200).size, 0.1); // stale
});

test("the skill gate only acts when QUANT_SKILL_GATE=on", () => {
  const db = openDb(":memory:");
  db.exec(QUANT_SCHEMA_SQL);
  db.prepare("INSERT INTO wallet_skill (wallet, computed_at, n_trades, verdict) VALUES ('L', 1, 40, 'luck'), ('S', 1, 40, 'skill')").run();
  assert.equal(skillGateBlocks(db, "L", {}), false);
  assert.equal(skillGateBlocks(db, "L", { QUANT_SKILL_GATE: "on" }), true);
  assert.equal(skillGateBlocks(db, "S", { QUANT_SKILL_GATE: "on" }), false);
  assert.equal(skillGateBlocks(db, "nobody", { QUANT_SKILL_GATE: "on" }), false);
});
