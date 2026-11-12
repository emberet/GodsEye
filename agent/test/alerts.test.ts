/**
 * Owner alerts: at most one per kind per hour, nothing private in the text, and the log alone when no channel is
 * set. Telegram is a stub here; the bot token, the chat and every address are made up as the tests run.
 * Last, the look from outside: it finds an agent that went silent, or a job that never finishes a run.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Keypair } from "@solana/web3.js";
import { type DB, getMeta, openDb, setMeta } from "@godseye/shared";
import type { AlertKind, Channel, Finding } from "../src/alerts";
import { fakeSignature, stubFetch } from "./helpers";

const { alert, channelFrom, channelNote, channelState, clean, howLong, outsideCheck, recentChats, sendAlert } = await import("../src/alerts");
const { attachLogDb, short } = await import("../src/log");

const MIN = 60_000;
const HOUR = 60 * MIN;
const address = (): string => Keypair.generate().publicKey.toBase58();
const SECRET = randomBytes(26).toString("base64url");
const TOKEN = `${1_000_000_000 + Math.floor(Math.random() * 8_000_000_000)}:${SECRET}`;
const CHAT = String(100_000_000 + Math.floor(Math.random() * 800_000_000));
const channel: Channel = { botToken: TOKEN, chatId: CHAT };
/** Telegram's answer to a message it took. */
const taken = { ok: true, result: { message_id: 1 } };

interface Remembered {
  at?: string;
  about?: string;
  tryAfter?: string;
}
const remembered = (db: DB, kind: AlertKind): Remembered => JSON.parse(getMeta(db, `alert_${kind}`) ?? "{}") as Remembered;
/** Moves what is remembered about a kind into the past, as if that long had gone by. */
function later(db: DB, kind: AlertKind, ms: number): void {
  const r = remembered(db, kind);
  const back = (t?: string): string | undefined => (t ? new Date(Date.parse(t) - ms).toISOString() : undefined);
  setMeta(db, `alert_${kind}`, JSON.stringify({ ...r, at: back(r.at), tryAfter: back(r.tryAfter) }));
}

/** Runs `work` with the log attached to `db` and gives back every line it said: the stored ones and the terminal's. */
async function said(db: DB, work: () => Promise<void>): Promise<string> {
  const printed: string[] = [];
  const print = console.log;
  console.log = (...line: unknown[]) => void printed.push(line.join(" "));
  attachLogDb(db);
  try {
    await work();
  } finally {
    attachLogDb(null as unknown as DB);
    console.log = print;
  }
  const stored = (db.prepare("SELECT message FROM agent_log ORDER BY id").all() as { message: string }[]).map((r) => r.message);
  return [...stored, ...printed].join("\n");
}

test("a repeat within the hour is not sent", async () => {
  const db = openDb(":memory:");
  const net = stubFetch(() => taken);
  try {
    assert.equal(await sendAlert(db, channel, "daily_stop", "Daily loss limit reached.", { about: "day one" }), "sent");
    assert.equal(await sendAlert(db, channel, "daily_stop", "Daily loss limit reached.", { about: "day one" }), "waiting");
    assert.equal(await sendAlert(db, channel, "daily_stop", "Daily loss limit reached.", { about: "day two" }), "waiting", "new trouble waits out the hour too");
    later(db, "daily_stop", 59 * MIN);
    assert.equal(await sendAlert(db, channel, "daily_stop", "Daily loss limit reached.", { about: "day two" }), "waiting");
    assert.equal(net.calls.length, 1);

    // Each kind has its own hour.
    assert.equal(await sendAlert(db, channel, "job_stalled", "A background job is stuck."), "sent");
    assert.equal(net.calls.length, 2);
  } finally {
    net.restore();
  }
});

test("after the hour new trouble is sent; the same trouble reminds only after its longer pause", async () => {
  const db = openDb(":memory:");
  const net = stubFetch(() => taken);
  const down = (about: string) => sendAlert(db, channel, "stream_down", "The live stream has delivered nothing.", { about });
  try {
    assert.equal(await down("outage one"), "sent");
    later(db, "stream_down", 61 * MIN);
    assert.equal(await down("outage one"), "waiting", "the same outage reminds once a day");
    assert.equal(await down("outage two"), "sent");
    later(db, "stream_down", 23 * HOUR);
    assert.equal(await down("outage two"), "waiting");
    later(db, "stream_down", 2 * HOUR);
    assert.equal(await down("outage two"), "sent", "the daily reminder");
    assert.equal(net.calls.length, 3);
  } finally {
    net.restore();
  }
});

test("the owner's own test message does not wait", async () => {
  const db = openDb(":memory:");
  const net = stubFetch(() => taken);
  try {
    assert.equal(await sendAlert(db, channel, "test", "This is a test.", { force: true }), "sent");
    assert.equal(await sendAlert(db, channel, "test", "This is a test.", { force: true }), "sent");
    assert.equal(await sendAlert(db, channel, "test", "This is a test."), "waiting");
    assert.equal(net.calls.length, 2);
  } finally {
    net.restore();
  }
});

test("the message goes to the bot's chat on Telegram and nowhere else", async () => {
  const db = openDb(":memory:");
  const net = stubFetch(() => taken);
  try {
    assert.equal(await sendAlert(db, channel, "self_pause", "The agent paused itself."), "sent");
    assert.equal(net.calls.length, 1);
    const url = new URL(net.calls[0]!.url);
    assert.equal(url.protocol, "https:");
    assert.equal(url.host, "api.telegram.org");
    assert.equal(url.pathname, `/bot${TOKEN}/sendMessage`);
    assert.equal(url.search, "");
    assert.deepEqual(net.calls[0]!.body, { chat_id: CHAT, text: "GodsEye: The agent paused itself." });
  } finally {
    net.restore();
  }
});

test("a message Telegram did not take is tried again after five minutes, not sooner", async () => {
  const db = openDb(":memory:");
  let answer: () => Response | object | undefined = () => new Response("{}", { status: 500 });
  const net = stubFetch(() => answer());
  const paused = () => sendAlert(db, channel, "self_pause", "The agent paused itself.");
  try {
    const lines = await said(db, async () => {
      assert.equal(await paused(), "failed");
      assert.equal(await paused(), "waiting");
      assert.equal(net.calls.length, 1);
      assert.equal(remembered(db, "self_pause").at, undefined, "nothing counts as sent");

      later(db, "self_pause", 6 * MIN);
      answer = () => undefined; // the stub throws, and its error quotes the address it was called at
      assert.equal(await paused(), "failed");

      later(db, "self_pause", 6 * MIN);
      answer = () => {
        throw new DOMException("timed out", "TimeoutError");
      };
      assert.equal(await paused(), "failed");

      later(db, "self_pause", 6 * MIN);
      answer = () => new Response("{}", { status: 403 });
      assert.equal(await paused(), "failed");

      later(db, "self_pause", 6 * MIN);
      answer = () => taken;
      assert.equal(await paused(), "sent");
      assert.equal(await paused(), "waiting");
    });
    assert.equal(net.calls.length, 5);
    assert.match(lines, /not delivered \(Telegram answered 500\)/);
    assert.match(lines, /not delivered \(Telegram could not be reached\)/);
    assert.match(lines, /not delivered \(Telegram did not answer in time\)/);
    assert.match(lines, /not delivered \(the bot may not write to that chat/);
    assert.match(lines, /Owner alert sent \(self_pause\): The agent paused itself\./);
    for (const secret of [TOKEN, SECRET, CHAT, "api.telegram.org", "unexpected fetch"]) {
      assert.ok(!lines.includes(secret), "a failure names neither the bot, the chat nor the address called");
    }
  } finally {
    net.restore();
  }
});

test("no alert carries an address, a transaction, a link, a name or a key", async () => {
  const db = openDb(":memory:");
  const [own, other, tx, apiKey] = [address(), address(), fakeSignature(), randomBytes(24).toString("hex")];
  setMeta(db, "wallet_pubkey", own);
  const text =
    `Daily loss limit reached (-0.1234 SOL today). Wallet ${own} (${short(own)}, ${own.slice(0, 4)}...${own.slice(-4)}) sent to ${other} in ${tx}; ` +
    `see https://example.invalid/tx/${tx}?api-key=${apiKey} or example.invalid/account/${other}, key ${apiKey}, bot ${TOKEN}, ` +
    `named by @made_up_handle (someone@example.invalid).`;
  const safe =
    "Daily loss limit reached (-0.1234 SOL today). Wallet [agent wallet] ([address hidden], [address hidden]) sent to [address hidden] in [signature hidden]; " +
    "see [link hidden] or [key hidden], key [key hidden], bot [key hidden], named by [name hidden] ([name hidden]).";
  const secrets = [own, other, tx, apiKey, TOKEN, SECRET, short(own), "example.invalid", "made_up_handle", "someone"];

  const net = stubFetch(() => taken);
  try {
    const lines = await said(db, async () => {
      assert.equal(await sendAlert(db, channel, "unknown_outflow", text, { about: `${other} ${tx}` }), "sent");
      assert.equal(await sendAlert(db, null, "daily_stop", text), "logged");
    });
    assert.deepEqual(net.calls.map((c) => c.body), [{ chat_id: CHAT, text: `GodsEye: ${safe}` }]);
    assert.ok(lines.includes(`Owner alert sent (unknown_outflow): ${safe}`));
    assert.ok(lines.includes(`Owner alert (daily_stop): ${safe}`));
    const kept = `${lines}\n${JSON.stringify(net.calls.map((c) => c.body))}\n${getMeta(db, "alert_unknown_outflow")}\n${getMeta(db, "alert_daily_stop")}`;
    for (const secret of secrets) assert.ok(!kept.includes(secret), "something private got through");
  } finally {
    net.restore();
  }
});

test("cleaning: a given key goes by its value, long text is cut at a space, plain words stay", () => {
  assert.equal(clean("Refused with pw-1234abcd today.", null, ["pw-1234abcd"]), "Refused with [key hidden] today.");

  const wallet = address();
  const long = clean(`${"word ".repeat(398)}${wallet}`, null, []);
  assert.ok(long.length <= 600 && !long.includes(wallet.slice(0, 6)), "the half of an address that fitted was let through");

  for (const plain of [
    "Daily loss limit reached in paper mode (-0.1234 SOL today). No new buys until tomorrow (UTC); sells and exits keep running.",
    "The live stream has delivered nothing for 12 minutes (status: waiting_for_ip). No new swaps are seen while it lasts.",
    "A background job is stuck: learning run exceeded max runtime (1800 s > 900 s); abandoning it and starting a new run.",
    "The live stream is delivering again after 3 hours of silence (since 2026-11-12T10:20:30.000Z).",
  ]) {
    assert.equal(clean(plain, null, []), plain);
  }
});

test("with no channel an alert is a line in the log and asks nobody", async () => {
  const db = openDb(":memory:");
  const net = stubFetch(() => undefined);
  try {
    const lines = await said(db, async () => {
      assert.equal(await sendAlert(db, null, "stream_down", "The live stream has delivered nothing.", { about: "outage one" }), "logged");
      assert.equal(await sendAlert(db, null, "stream_down", "The live stream has delivered nothing.", { about: "outage one" }), "waiting");
      // The agent's own channel is the one in .env, which tests leave empty.
      assert.equal(await alert(db, "x_credits", "X refuses paid reads."), "logged");
      assert.equal(await alert(db, "x_credits", "X refuses paid reads."), "waiting");
    });
    assert.equal(net.calls.length, 0);
    assert.equal(lines.split("Owner alert (stream_down): The live stream has delivered nothing.").length - 1, 2, "once stored, once on the terminal");
    assert.ok(lines.includes("Owner alert (x_credits): X refuses paid reads."));
    assert.equal(remembered(db, "stream_down").about, "outage one");
  } finally {
    net.restore();
  }
});

test("a token or a chat that is not in its usual form counts as not set", () => {
  assert.equal(channelFrom({ telegramBotToken: "", telegramChatId: "" }), null);
  assert.equal(channelFrom({ telegramBotToken: TOKEN, telegramChatId: "" }), null);
  assert.equal(channelFrom({ telegramBotToken: "", telegramChatId: CHAT }), null);
  // The token becomes part of a web address: nothing that could change where the call goes is let through.
  for (const bad of [`${TOKEN}/x`, `${TOKEN}?a=b`, `${TOKEN}#x`, `bot${TOKEN}`, TOKEN.replace(":", ""), `${TOKEN}\n`, "12345:too-short"]) {
    assert.equal(channelFrom({ telegramBotToken: bad, telegramChatId: CHAT }), null);
  }
  for (const bad of ["12 34", "made up", `${CHAT}/x`, "@"]) assert.equal(channelFrom({ telegramBotToken: TOKEN, telegramChatId: bad }), null);
  for (const good of [CHAT, `-100${CHAT}`, "@made_up_channel"]) {
    assert.deepEqual(channelFrom({ telegramBotToken: TOKEN, telegramChatId: good }), { botToken: TOKEN, chatId: good });
  }

  assert.equal(channelNote({ telegramBotToken: TOKEN, telegramChatId: CHAT }), "Telegram");
  assert.match(channelNote({ telegramBotToken: "", telegramChatId: "" }), /^log only \(set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID/);
  const half = channelNote({ telegramBotToken: TOKEN, telegramChatId: "" });
  assert.match(half, /^log only \(/);
  assert.ok(!half.includes(TOKEN) && !half.includes(SECRET));

  // What `npm run alert-test` goes by: how each setting stands, never what it holds.
  assert.deepEqual(channelState({ telegramBotToken: "", telegramChatId: "" }), { token: "empty", chat: "empty" });
  assert.deepEqual(channelState({ telegramBotToken: TOKEN, telegramChatId: "" }), { token: "ok", chat: "empty" });
  assert.deepEqual(channelState({ telegramBotToken: `${TOKEN}/x`, telegramChatId: "made up" }), { token: "odd", chat: "odd" });
  assert.deepEqual(channelState({ telegramBotToken: TOKEN, telegramChatId: CHAT }), { token: "ok", chat: "ok" });
});

test("an alert never breaks the work that raised it", async () => {
  const db = openDb(":memory:");
  db.close();
  assert.equal(await sendAlert(db, null, "job_stalled", "A background job is stuck."), "failed");
  assert.equal(await sendAlert(db, channel, "job_stalled", "A background job is stuck."), "failed");
  assert.equal(await alert(db, "job_stalled", "A background job is stuck."), "failed");
});

test("finding the chat ID: each chat that wrote to the bot once, and nothing changed on the bot", async () => {
  const [mine, group, feed] = [Number(CHAT), -(1_000 + Math.floor(Math.random() * 9_000)), -1_000_000_000_000 - Math.floor(Math.random() * 1_000_000)];
  const updates = [
    { update_id: 1, message: { chat: { id: mine, type: "private" }, text: "/start" } },
    { update_id: 2, edited_message: { chat: { id: mine, type: "private" } } },
    { update_id: 3, my_chat_member: { chat: { id: group, type: "group" } } },
    { update_id: 4, channel_post: { chat: { id: feed, type: "channel" } } },
    { update_id: 5, message: { chat: { id: "not a number", type: "private" } } },
    { update_id: 6 },
    null,
  ];
  let answer: () => Response | object | undefined = () => ({ ok: true, result: updates });
  const net = stubFetch(() => answer());
  try {
    assert.deepEqual(await recentChats(TOKEN), [
      { id: String(mine), type: "private" },
      { id: String(group), type: "group" },
      { id: String(feed), type: "channel" },
    ]);
    assert.equal(new URL(net.calls[0]!.url).pathname, `/bot${TOKEN}/getUpdates`);
    assert.deepEqual(net.calls[0]!.body, { limit: 100, timeout: 0 }, "no offset: nothing is marked as read");

    answer = () => ({ ok: true, result: [] });
    assert.deepEqual(await recentChats(TOKEN), []);

    for (const [status, words] of [[401, /refused the bot token/], [409, /already reading/], [502, /answered 502/]] as const) {
      answer = () => new Response(JSON.stringify({ ok: false, description: `quoting ${TOKEN}` }), { status });
      const reason = await recentChats(TOKEN);
      assert.ok(typeof reason === "string" && words.test(reason) && !reason.includes(SECRET));
    }

    const before = net.calls.length;
    const refused = await recentChats(`${TOKEN}/getMe?x=`);
    assert.ok(typeof refused === "string" && !refused.includes(SECRET));
    assert.equal(net.calls.length, before, "a token in an odd form is never sent anywhere");
  } finally {
    net.restore();
  }
});

test("how long, in the words an alert uses", () => {
  assert.equal(howLong(0), "0 minutes");
  assert.equal(howLong(MIN), "1 minute");
  assert.equal(howLong(5 * MIN + 20_000), "5 minutes");
  assert.equal(howLong(119 * MIN), "119 minutes");
  assert.equal(howLong(2 * HOUR), "2 hours");
  assert.equal(howLong(47 * HOUR), "47 hours");
  assert.equal(howLong(48 * HOUR), "2 days");
  assert.equal(howLong(15 * 24 * HOUR), "15 days");
});

/** A time that long before `now`, as the agent writes it. */
const ago = (now: number, ms: number): string => new Date(now - ms).toISOString();
/** A database the agent is running on: live, and reporting in. */
function running(now: number): DB {
  const db = openDb(":memory:");
  setMeta(db, "agent_status", "live");
  setMeta(db, "heartbeat", ago(now, 40_000));
  return db;
}
function openPosition(db: DB, mode: "real" | "paper"): void {
  db.prepare(
    `INSERT INTO positions (mint, leader, mode, status, token_amount, tokens_bought, cost_sol, entry_price_sol, opened_at)
     VALUES (?, ?, ?, 'open', 1000, 1000, 0.1, 0.0001, ?)`,
  ).run(address(), address(), mode, new Date().toISOString());
}
/** What the look from outside finds, after a check that each finding would reach the owner as written. */
function found(db: DB, now: number): Finding[] {
  const findings = outsideCheck(db, now);
  for (const f of findings) {
    assert.equal(clean(f.text, null), f.text, "the cleaning would change this text on its way out");
    assert.equal(clean(f.about, null).slice(0, 80), f.about);
  }
  return findings;
}

test("from outside: an agent that stopped reporting in", () => {
  const now = Date.now();
  const db = openDb(":memory:");
  assert.deepEqual(found(db, now), [], "the agent has never run on this database");
  setMeta(db, "agent_status", "live");
  assert.deepEqual(found(db, now), [], "no heartbeat to go by");
  setMeta(db, "heartbeat", ago(now, 9 * MIN));
  assert.deepEqual(found(db, now), [], "nine minutes of silence is not yet an alert");

  const beat = ago(now, 12 * MIN);
  setMeta(db, "heartbeat", beat);
  const down = "The agent has not reported in for 12 minutes: it may have crashed or be stuck.";
  assert.deepEqual(found(db, now), [{ kind: "agent_down", text: down, about: `silent since ${beat}` }]);

  // Its jobs are late too by then: that is the same trouble, not a second message.
  setMeta(db, "last_learning_at", ago(now, 9 * HOUR));
  setMeta(db, "last_discovery_at", ago(now, 9 * HOUR));
  assert.deepEqual(found(db, now).map((f) => f.kind), ["agent_down"]);

  openPosition(db, "paper");
  assert.equal(found(db, now)[0]!.text, down, "paper positions lose nothing while it is down");
  openPosition(db, "real");
  assert.equal(found(db, now)[0]!.text, `${down} Its open real position is not watched meanwhile.`);
  openPosition(db, "real");
  openPosition(db, "real");
  assert.equal(found(db, now)[0]!.text, `${down} Its 3 open real positions are not watched meanwhile.`);
});

test("from outside: a stop is the owner's business, unless real positions were left open", () => {
  const db = openDb(":memory:");
  setMeta(db, "heartbeat", ago(Date.now(), 5 * HOUR));
  setMeta(db, "agent_status", "stopped");
  const { updated_at: stopped } = db.prepare("SELECT updated_at FROM agent_meta WHERE key = 'agent_status'").get() as { updated_at: string };
  const after = (ms: number): Finding[] => found(db, Date.parse(stopped) + ms);

  assert.deepEqual(after(30 * MIN), []);
  openPosition(db, "paper");
  assert.deepEqual(after(30 * MIN), []);

  openPosition(db, "real");
  assert.deepEqual(after(5 * MIN), [], "a restart takes a moment");
  assert.deepEqual(after(30 * MIN), [
    { kind: "agent_down", text: "The agent was stopped 30 minutes ago with 1 real position open. Nothing watches it until the agent runs again.", about: `stopped ${stopped}` },
  ]);
  openPosition(db, "real");
  assert.equal(after(3 * HOUR)[0]!.text, "The agent was stopped 3 hours ago with 2 real positions open. Nothing watches them until the agent runs again.");
});

test("from outside: a live agent whose job never finishes a run", () => {
  const now = Date.now();
  const db = running(now);
  const ran = (learning: number, discovery: number): void => {
    setMeta(db, "last_learning_at", ago(now, learning));
    setMeta(db, "last_discovery_at", ago(now, discovery));
  };
  assert.deepEqual(found(db, now), [], "a job that has never finished a run gives nothing to measure from");
  ran(20 * MIN, 50 * MIN);
  assert.deepEqual(found(db, now), []);
  ran(119 * MIN, 179 * MIN);
  assert.deepEqual(found(db, now), [], "a few slow or failed runs are not yet a stuck job");

  ran(2 * HOUR + MIN, 50 * MIN);
  assert.deepEqual(found(db, now), [
    { kind: "job_stalled", text: "The agent is running, but learning has not finished a run for 2 hours (the choice of wallets to copy is that old).", about: "learning" },
  ]);
  ran(20 * MIN, 4 * HOUR);
  assert.deepEqual(found(db, now), [
    { kind: "job_stalled", text: "The agent is running, but discovery has not finished a run for 4 hours (no new wallets are being found).", about: "discovery" },
  ]);
  ran(5 * HOUR, 4 * HOUR);
  assert.deepEqual(found(db, now), [
    {
      kind: "job_stalled",
      text:
        "The agent is running, but learning has not finished a run for 5 hours (the choice of wallets to copy is that old) " +
        "and discovery has not finished a run for 4 hours (no new wallets are being found).",
      about: "learning, discovery",
    },
  ]);
});

test("from outside: after a start the jobs get their time", () => {
  const now = Date.now();
  const db = running(now);
  setMeta(db, "last_learning_at", ago(now, 7 * HOUR)); // the agent was off for most of that
  const late = [
    { kind: "job_stalled", text: "The agent is running, but learning has not finished a run for 7 hours (the choice of wallets to copy is that old).", about: "learning" },
  ];

  setMeta(db, "agent_started_at", ago(now, 90 * MIN));
  assert.deepEqual(found(db, now), []);
  setMeta(db, "agent_started_at", ago(now, 2 * HOUR + 5 * MIN));
  assert.deepEqual(found(db, now), late, "two hours after its start, learning should have finished a run");

  // No start time to go by (an older agent wrote none): the last finished run alone decides.
  setMeta(db, "agent_started_at", "");
  assert.deepEqual(found(db, now), late);
  db.prepare("DELETE FROM agent_meta WHERE key = 'agent_started_at'").run();
  assert.deepEqual(found(db, now), late);
});

test("from outside: what is found is told like any other alert, once", async () => {
  const now = Date.now();
  const db = running(now);
  setMeta(db, "wallet_pubkey", address());
  setMeta(db, "heartbeat", ago(now, 3 * HOUR));
  openPosition(db, "real");
  const [finding] = found(db, now);
  assert.ok(finding);

  const net = stubFetch(() => undefined);
  try {
    const lines = await said(db, async () => {
      assert.equal(await alert(db, finding.kind, finding.text, finding.about), "logged");
      assert.equal(await alert(db, finding.kind, finding.text, finding.about), "waiting");
    });
    assert.ok(lines.includes("Owner alert (agent_down): The agent has not reported in for 3 hours: it may have crashed or be stuck. Its open real position is not watched meanwhile."));
    assert.equal(remembered(db, "agent_down").about, finding.about, "the time it went silent tells this outage from the next");
    assert.equal(net.calls.length, 0);
  } finally {
    net.restore();
  }
});
