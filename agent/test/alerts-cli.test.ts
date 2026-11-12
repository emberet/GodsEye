/**
 * `npm run alert-test` and `npm run alert-check`: the set-up help says what is missing and never shows the token;
 * the look from outside makes no database, and writes to one only when there is something to tell.
 * Telegram is a stub here; the bot token and the chats are made up as the tests run.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { type DB, dbFilePath, getMeta, openDb, setMeta } from "@godseye/shared";
import type { Finding } from "../src/alerts";
import { stubFetch } from "./helpers";

const { alertCheck, alertTest, look, tell } = await import("../src/cli/alerts");
const { attachLogDb } = await import("../src/log");

const MIN = 60_000;
/** Where the agent's database would be in this test's own folder, with nothing there. */
function noDatabase(): string {
  const file = dbFilePath();
  for (const tail of ["", "-wal", "-shm"]) fs.rmSync(file + tail, { force: true });
  return file;
}
const SECRET = randomBytes(26).toString("base64url");
const TOKEN = `${1_000_000_000 + Math.floor(Math.random() * 8_000_000_000)}:${SECRET}`;
const CHAT = String(100_000_000 + Math.floor(Math.random() * 800_000_000));
/** Telegram's answer to a message it took. */
const taken = { ok: true, result: { message_id: 1 } };

interface Ran {
  ok: boolean;
  /** What the command printed itself. */
  lines: string[];
  /** That, and every line the log printed meanwhile. */
  all: string;
}
/** `npm run alert-test` with .env filled in that way. */
async function run(telegramBotToken: string, telegramChatId: string): Promise<Ran> {
  const lines: string[] = [];
  const logged: string[] = [];
  const print = console.log;
  console.log = (...line: unknown[]) => void logged.push(line.join(" "));
  try {
    const ok = await alertTest({ telegramBotToken, telegramChatId }, (line) => void lines.push(line));
    return { ok, lines, all: [...logged, ...lines].join("\n") };
  } finally {
    console.log = print;
  }
}

test("alert-test: with no bot set it says alerts are log lines only, and how to get them on Telegram", async () => {
  const net = stubFetch(() => undefined);
  try {
    for (const chat of ["", CHAT]) {
      const { ok, lines } = await run("", chat);
      assert.equal(ok, true);
      assert.equal(lines[0], "No Telegram bot is set, so owner alerts are lines in the log only.");
      assert.equal(lines[1], "To get them on Telegram:");
      assert.equal(lines.length, 6, "the four steps follow");
    }
    assert.equal(net.calls.length, 0);
  } finally {
    net.restore();
  }
});

test("alert-test: a setting that is not in its usual form is named, never shown and never sent", async () => {
  const net = stubFetch(() => undefined);
  try {
    const oddToken = await run(`${TOKEN}/getMe?x=`, CHAT);
    assert.equal(oddToken.ok, true);
    assert.match(oddToken.lines[0]!, /^TELEGRAM_BOT_TOKEN is not in its usual form/);
    assert.equal(oddToken.lines.length, 2);

    const oddChat = await run(TOKEN, "made up");
    assert.equal(oddChat.ok, true);
    assert.match(oddChat.lines[0]!, /^TELEGRAM_CHAT_ID is not in its usual form/);
    assert.equal(oddChat.lines.length, 2);

    for (const { all } of [oddToken, oddChat]) assert.ok(!all.includes(SECRET) && !all.includes("made up"));
    assert.equal(net.calls.length, 0);
  } finally {
    net.restore();
  }
});

test("alert-test: with the bot set and no chat it lists the chats that wrote to the bot, and sends nothing", async () => {
  const group = -1_000_000_000_000 - Math.floor(Math.random() * 1_000_000);
  const mine = { update_id: 1, message: { chat: { id: Number(CHAT), type: "private" }, text: "/start" } };
  let answer: () => Response | object = () => ({ ok: true, result: [] });
  const net = stubFetch(() => answer());
  try {
    const nobody = await run(TOKEN, "");
    assert.equal(nobody.ok, true);
    assert.equal(nobody.lines[0], "Nobody has written to the bot in the last day.");
    assert.equal(nobody.lines.length, 2);
    assert.equal(new URL(net.calls[0]!.url).pathname, `/bot${TOKEN}/getUpdates`);

    answer = () => ({ ok: true, result: [mine] });
    const one = await run(TOKEN, "");
    assert.equal(one.ok, true);
    assert.deepEqual(one.lines.slice(1), [
      `  ${CHAT}   a private chat`,
      "Put the ID of your own chat in .env as TELEGRAM_CHAT_ID, then run `npm run alert-test` again.",
    ]);

    answer = () => ({ ok: true, result: [mine, { update_id: 2, my_chat_member: { chat: { id: group, type: "supergroup" } } }] });
    const two = await run(TOKEN, "");
    assert.equal(two.lines[2], `  ${group}   a group`);
    assert.match(two.lines.at(-1)!, /^With several listed/);

    answer = () => new Response(JSON.stringify({ ok: false, description: `quoting ${TOKEN}` }), { status: 401 });
    const refused = await run(TOKEN, "");
    assert.equal(refused.ok, true, "nothing was sent, so nothing failed to arrive");
    assert.deepEqual(refused.lines, ["Could not ask Telegram who wrote to the bot: Telegram refused the bot token."]);

    assert.ok(net.calls.every((c) => new URL(c.url).pathname === `/bot${TOKEN}/getUpdates`), "finding the chat sends no message");
    for (const { all } of [nobody, one, two, refused]) assert.ok(!all.includes(SECRET));
  } finally {
    net.restore();
  }
});

test("alert-test: with both set a test message goes out, each time it is asked for", async () => {
  let answer: () => Response | object = () => taken;
  const net = stubFetch(() => answer());
  try {
    const first = await run(TOKEN, CHAT);
    const second = await run(TOKEN, CHAT);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true, "a test is not held back by the hour rule");
    assert.equal(net.calls.length, 2);
    assert.equal(new URL(net.calls[0]!.url).pathname, `/bot${TOKEN}/sendMessage`);
    assert.deepEqual(net.calls[0]!.body, { chat_id: CHAT, text: "GodsEye: Test message. Owner alerts are working." });
    assert.match(first.lines[0]!, /^Sent\./);

    answer = () => new Response("{}", { status: 403 });
    const refused = await run(TOKEN, CHAT);
    assert.equal(refused.ok, false, "the command fails when the message did not get through");
    assert.match(refused.lines[0]!, /^Not delivered: the reason is in the line above\./);
    assert.match(refused.all, /the bot may not write to that chat: open the chat with the bot and press Start/);

    for (const { all } of [first, second, refused]) assert.ok(!all.includes(SECRET));
  } finally {
    net.restore();
  }
});

test("alert-check: what the log does not say is said on the terminal", async () => {
  const db = openDb(":memory:");
  const finding: Finding = { kind: "agent_down", text: "The agent has not reported in for 3 hours: it may have crashed or be stuck.", about: "silent since a made-up time" };
  const lines: string[] = [];
  const logged: string[] = [];
  const tellIt = (): Promise<boolean> => tell(db, [finding], (line) => void lines.push(line));
  const print = console.log;
  console.log = (...line: unknown[]) => void logged.push(line.join(" "));
  try {
    assert.equal(await tellIt(), true);
    assert.deepEqual(lines, [], "the log printed it");
    assert.equal(logged.length, 1);
    assert.ok(logged[0]!.endsWith(`Owner alert (agent_down): ${finding.text}`));

    assert.equal(await tellIt(), true, "the owner was told the first time");
    assert.deepEqual(lines, [`Told before, not repeated yet: ${finding.text}`]);

    db.close();
    assert.equal(await tellIt(), false);
    assert.equal(lines[1], `Could not tell the owner; a later run tries again: ${finding.text}`);
    assert.equal(logged.length, 1, "only the first run reached the log");
  } finally {
    console.log = print;
  }
});

test("alert-check: the whole run says what it found, and fails only when it could not do its work", async () => {
  const file = noDatabase();
  const lines: string[] = [];
  const logged: string[] = [];
  const check = (now: number): Promise<boolean> => alertCheck(file, (line) => void lines.push(line), now);
  const print = console.log;
  console.log = (...line: unknown[]) => void logged.push(line.join(" "));
  try {
    const now = Date.now();
    assert.equal(await check(now), true);
    assert.deepEqual(lines, ["Nothing to check: the agent has not run here yet (no database)."]);
    assert.equal(fs.existsSync(file), false, "a check must not make the database");

    const agent = openDb(file);
    setMeta(agent, "agent_status", "live");
    setMeta(agent, "heartbeat", new Date(now).toISOString());
    agent.close();
    assert.equal(await check(now + MIN), true);
    assert.equal(lines[1], "Nothing to report.");

    assert.equal(await check(now + 12 * MIN), true);
    assert.equal(lines.length, 2, "the log printed what was found");
    assert.equal(logged.length, 1);
    assert.match(logged[0]!, /Owner alert \(agent_down\): The agent has not reported in for 12 minutes: /);

    assert.equal(await check(now + 13 * MIN), true, "told before, so nothing was left undone");
    assert.match(lines[2]!, /^Told before, not repeated yet: The agent has not reported in for 13 minutes: /);
    assert.equal(logged.length, 1);

    noDatabase();
    fs.writeFileSync(file, Buffer.alloc(4096, "x"));
    assert.equal(await check(now), false, "a database that can't be read is a failed run");
    assert.match(lines[3]!, /^Could not read the agent's database \(.+\), so nothing was checked\. A later run tries again\.$/);
    assert.equal(lines.length, 4);
  } finally {
    attachLogDb(null as unknown as DB);
    console.log = print;
    noDatabase();
  }
});

test("alert-check: looking makes no database and writes to none; telling does", async () => {
  const file = noDatabase();
  assert.equal(look(file), null);
  assert.equal(fs.existsSync(file), false, "a look must not make the database");

  const now = Date.now();
  const agent = openDb(file);
  setMeta(agent, "agent_status", "live");
  setMeta(agent, "heartbeat", new Date(now - 40_000).toISOString());
  agent.close();

  assert.deepEqual(look(file, now), []);
  const found = look(file, now + 12 * MIN) ?? [];
  assert.deepEqual(found.map((f) => f.kind), ["agent_down"]);

  const db = openDb(file);
  const count = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;
  const print = console.log;
  console.log = () => {};
  attachLogDb(db);
  try {
    assert.equal(count("SELECT COUNT(*) n FROM agent_meta WHERE key LIKE 'alert%'"), 0, "looking tells nobody");
    assert.equal(count("SELECT COUNT(*) n FROM agent_log"), 0);

    await tell(db, found, () => {});
    assert.ok(getMeta(db, "alert_agent_down"));
    assert.equal(count("SELECT COUNT(*) n FROM agent_log"), 1);
  } finally {
    attachLogDb(null as unknown as DB);
    console.log = print;
    db.close();
  }
});
