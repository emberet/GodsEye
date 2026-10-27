import { test } from "node:test";
import assert from "node:assert/strict";
import cron from "node-cron";
import { CRON_OPTS, every, oncePerMinute } from "../src/schedule";

/** Busy-wait: hold the event loop the way a long synchronous SQLite job does. */
const block = (ms: number) => {
  const end = Date.now() + ms;
  while (Date.now() < end);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Runs of an every-second job over ~4.5 s, with the loop held for 2.5 s in the middle. */
async function runsWhileBlocked(opts: object): Promise<number> {
  let runs = 0;
  const task = cron.schedule("* * * * * *", () => void runs++, opts);
  await sleep(1200);
  block(2500);
  await sleep(1200);
  task.stop();
  return runs;
}

test("cron: a run whose second passes while the event loop is busy still happens", async () => {
  const dropped = await runsWhileBlocked({ timezone: "UTC" });
  const kept = await runsWhileBlocked(CRON_OPTS);
  assert.ok(kept >= dropped + 2, `with recovery ${kept} runs, without ${dropped}`);
});

test("cron: a recovered duplicate in the same minute runs once; the next minute runs again", () => {
  let t = Date.parse("2026-10-27T03:45:00.100Z");
  let runs = 0;
  const run = oncePerMinute(() => void runs++, () => t);
  run();
  t += 2_000; // node-cron re-fires 03:45 after a busy second
  run();
  assert.equal(runs, 1);
  t = Date.parse("2026-10-27T04:00:00.050Z");
  run();
  assert.equal(runs, 2);
});

test("cron: schedules with a seconds field are refused (the once-a-minute guard would swallow them)", () => {
  assert.throws(() => every("*/10 * * * * *", () => undefined), /per minute at most/);
});
