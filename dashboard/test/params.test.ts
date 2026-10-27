import { test } from "node:test";
import assert from "node:assert/strict";
import { intParam } from "../lib/params";

test("intParam: missing, blank or non-numeric values use the fallback", () => {
  assert.equal(intParam(null, 50, 1, 100), 50);
  assert.equal(intParam("  ", 50, 1, 100), 50);
  assert.equal(intParam("abc", 50, 1, 100), 50);
  assert.equal(intParam("Infinity", 50, 1, 100), 50);
});

test("intParam: values are floored and clamped to [min, max]", () => {
  assert.equal(intParam("7.9", 50, 1, 100), 7);
  assert.equal(intParam("-5", 50, 1, 100), 1);
  assert.equal(intParam("1000", 50, 1, 100), 100);
});
