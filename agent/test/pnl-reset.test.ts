import { test } from "node:test";
import assert from "node:assert/strict";
import { getMeta, openDb, setMeta } from "@godseye/shared";
import { resetPnl, startOfUtcDay, undoPnlReset } from "../src/publish/pnl-reset";

test("reset-pnl sets the cutoff and the starting capital; undo restores the earlier values", () => {
  const db = openDb(":memory:");
  setMeta(db, "starting_balance_sol", 1.111);
  setMeta(db, "starting_balance_usd", 111.26);
  setMeta(db, "wallet_balance_sol", 0);
  setMeta(db, "copy_budget_sol", 1);
  setMeta(db, "sol_usd_now", 150);
  assert.equal(startOfUtcDay(Date.parse("2026-11-11T17:30:00Z")), "2026-11-11T00:00:00.000Z");

  const r = resetPnl(db, "2026-11-11T00:00:00Z");
  assert.equal(r.before.pnl_since, null);
  assert.equal(getMeta(db, "pnl_since"), "2026-11-11T00:00:00.000Z");
  assert.equal(getMeta(db, "starting_balance_sol"), "1", "an empty wallet falls back to the copy budget");
  assert.equal(getMeta(db, "starting_balance_usd"), "150");

  // A second reset moves the cutoff but keeps the first one's saved values.
  setMeta(db, "wallet_balance_sol", 2);
  resetPnl(db, "2026-11-12T00:00:00Z");
  assert.equal(getMeta(db, "starting_balance_sol"), "2");

  assert.equal(undoPnlReset(db), true);
  assert.equal(getMeta(db, "pnl_since"), null);
  assert.equal(getMeta(db, "starting_balance_sol"), "1.111");
  assert.equal(getMeta(db, "starting_balance_usd"), "111.26");
  assert.equal(getMeta(db, "pnl_reset_prev"), null);
  assert.equal(undoPnlReset(db), false);
  assert.throws(() => resetPnl(db, "nope"));
});
