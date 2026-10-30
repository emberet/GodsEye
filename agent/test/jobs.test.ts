import { test } from "node:test";
import assert from "node:assert/strict";
import { createJobRunner, withTimeout } from "../src/jobs";

const never = () => new Promise<void>(() => undefined);

test("withTimeout: rejects a call that never settles", async () => {
  await assert.rejects(withTimeout(never(), 20, "rpc"), /rpc timed out after 20 ms/);
});

test("withTimeout: passes through a value or error that arrives in time", async () => {
  assert.equal(await withTimeout(Promise.resolve(7), 50, "x"), 7);
  await assert.rejects(withTimeout(Promise.reject(new Error("boom")), 50, "x"), /boom/);
});

function setup() {
  let t = 0;
  const warns: string[] = [];
  const errors: string[] = [];
  const r = createJobRunner({ warn: (m) => warns.push(m), error: (m) => errors.push(m), now: () => t, warnEveryMs: 60_000 });
  return { r, warns, errors, advance: (ms: number) => void (t += ms) };
}

test("job runner: a skipped tick warns, rate-limited, and never runs a second copy", async () => {
  const { r, warns, advance } = setup();
  let calls = 0;
  void r.run("learning", () => { calls++; return never(); });
  assert.equal(await r.run("learning", async () => void calls++), false);
  assert.equal(await r.run("learning", async () => void calls++), false);
  assert.equal(calls, 1);
  assert.equal(warns.filter((w) => w.includes("tick skipped")).length, 1);
  advance(61_000);
  await r.run("learning", async () => void calls++);
  assert.equal(warns.filter((w) => w.includes("tick skipped")).length, 2);
  assert.equal(calls, 1);
});

test("job runner: a non-trading job past max runtime is abandoned and the schedule resumes", async () => {
  const { r, warns, advance } = setup();
  let release!: () => void;
  void r.run("learning", () => new Promise<void>((res) => (release = res)), { maxRuntimeMs: 1000, releaseAfterMaxRuntime: true });
  advance(2000);
  let second!: () => void;
  const ran = r.run("learning", () => new Promise<void>((res) => (second = res)), { maxRuntimeMs: 1000, releaseAfterMaxRuntime: true });
  assert.ok(warns.some((w) => w.includes("exceeded max runtime") && w.includes("abandoning")));
  // The old run finishing late must not clear the new run's slot.
  release();
  await new Promise((res) => setImmediate(res));
  assert.equal(r.isRunning("learning"), true);
  second();
  assert.equal(await ran, true);
  assert.equal(r.isRunning("learning"), false);
});

test("job runner: a trading job past max runtime only warns (rate-limited), never runs twice", async () => {
  const { r, warns, advance } = setup();
  let calls = 0;
  const opts = { maxRuntimeMs: 1000, releaseAfterMaxRuntime: false };
  void r.run("positions", () => { calls++; return never(); }, opts);
  advance(2000);
  assert.equal(await r.run("positions", async () => void calls++, opts), false);
  assert.equal(await r.run("positions", async () => void calls++, opts), false);
  assert.equal(calls, 1);
  assert.equal(warns.filter((w) => w.includes("exceeded max runtime")).length, 1);
});

test("job runner: an error is logged and the job can run again", async () => {
  const { r, errors } = setup();
  await r.run("learning", async () => { throw new Error("db locked"); });
  assert.deepEqual(errors, ["learning failed: db locked"]);
  assert.equal(await r.run("learning", async () => undefined), true);
});

test("job runner: names() lists the jobs holding a slot (event-loop and slow-SQL logs)", async () => {
  const { r, advance } = setup();
  let done!: () => void;
  const p = r.run("copy replay", () => new Promise<void>((res) => (done = res)));
  void r.run("positions", () => never(), { maxRuntimeMs: 1000, releaseAfterMaxRuntime: false });
  assert.deepEqual(r.names().sort(), ["copy replay", "positions"]);
  done();
  await p;
  assert.deepEqual(r.names(), ["positions"]);
  advance(5000);
  assert.deepEqual(r.names(), ["positions"], "a trading job keeps its slot past max runtime");
});
