/**
 * `npm run alert-test`: sets up and tries the owner's Telegram alerts. It says what is missing, finds the chat ID,
 * then sends a test message. It never shows the bot token, and nothing it prints goes into the agent's log.
 *
 * `npm run alert-check`: a look at the agent from outside, for a timer of its own. It tells the owner when the agent
 * has stopped reporting in or a job never finishes a run. With nothing wrong it only reads the database.
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { type DB, dbFilePath, openDb, openDbReadonly } from "@godseye/shared";
import { type ChannelSettings, type Finding, alert, channelFrom, channelState, outsideCheck, recentChats, sendAlert } from "../alerts";
import { config } from "../config";
import { attachLogDb } from "../log";

type Print = (line: string) => void;

const SETUP = [
  "To get them on Telegram:",
  "  1. On Telegram, talk to @BotFather and send /newbot: it gives you the bot's token.",
  "  2. Open a chat with your new bot and press Start (a bot can't write to you first).",
  "  3. Put the token in .env as TELEGRAM_BOT_TOKEN and run `npm run alert-test`: it shows the chat ID.",
  "  4. Put the chat ID in .env as TELEGRAM_CHAT_ID and run `npm run alert-test` again: a test message arrives.",
];
const CHAT_WORDS: Record<string, string> = { private: "a private chat", group: "a group", supergroup: "a group", channel: "a channel" };

/** `npm run alert-test`. False only when a message was tried and did not get through. */
export async function alertTest(settings: ChannelSettings, print: Print = console.log): Promise<boolean> {
  const { token, chat } = channelState(settings);
  if (token === "empty") {
    print("No Telegram bot is set, so owner alerts are lines in the log only.");
    for (const line of SETUP) print(line);
    return true;
  }
  if (token === "odd") {
    print("TELEGRAM_BOT_TOKEN is not in its usual form (a number, a colon, then about 35 letters and digits).");
    print("Copy it again from @BotFather, with nothing before or after it, then run `npm run alert-test` again.");
    return true;
  }
  if (chat === "odd") {
    print("TELEGRAM_CHAT_ID is not in its usual form: a number (negative for a group), or @name for a public channel.");
    print("Empty it and run `npm run alert-test`: it shows the chat ID to put there.");
    return true;
  }
  if (chat === "empty") {
    const chats = await recentChats(settings.telegramBotToken);
    if (typeof chats === "string") {
      print(`Could not ask Telegram who wrote to the bot: ${chats}.`);
    } else if (chats.length === 0) {
      print("Nobody has written to the bot in the last day.");
      print("Open the chat with your bot on Telegram and press Start (or send it any message), then run `npm run alert-test` again.");
    } else {
      print("The bot token is set; TELEGRAM_CHAT_ID is not. Chats that wrote to the bot in the last day:");
      for (const c of chats) print(`  ${c.id}   ${CHAT_WORDS[c.type] ?? "a chat"}`);
      print("Put the ID of your own chat in .env as TELEGRAM_CHAT_ID, then run `npm run alert-test` again.");
      if (chats.length > 1) print("With several listed, the test message shows which is yours: it arrives only in the chat whose ID you set.");
    }
    return true;
  }

  // A database of its own, in memory: the test never touches the agent's.
  const outcome = await sendAlert(openDb(":memory:"), channelFrom(settings), "test", "Test message. Owner alerts are working.", { force: true });
  if (outcome === "sent") {
    print("Sent. Look for it on Telegram: a message that starts with \"GodsEye:\".");
    return true;
  }
  print("Not delivered: the reason is in the line above. Fix it and run `npm run alert-test` again (no need to wait).");
  return false;
}

/** `npm run alert-check`, first half: a look that only reads. Null when the agent has never run here; no database is made. */
export function look(file: string, now = Date.now()): Finding[] | null {
  if (!fs.existsSync(file)) return null;
  const db = openDbReadonly(file);
  try {
    return outsideCheck(db, now);
  } finally {
    db.close();
  }
}

const NOT_TOLD = "Could not tell the owner; a later run tries again:";

/** `npm run alert-check`, second half: tells the owner each finding, and says on the terminal what the log does not. False when one could not be told. */
export async function tell(db: DB, findings: Finding[], print: Print = console.log): Promise<boolean> {
  let told = true;
  for (const f of findings) {
    // A message that went out, or into the log, is printed by the log itself.
    const outcome = await alert(db, f.kind, f.text, f.about);
    if (outcome === "waiting") print(`Told before, not repeated yet: ${f.text}`);
    if (outcome === "failed") {
      print(`${NOT_TOLD} ${f.text}`);
      told = false;
    }
  }
  return told;
}

/** `npm run alert-check`. False when the run could not do its work, so that the timer shows it as failed. */
export async function alertCheck(file: string, print: Print = console.log, now = Date.now()): Promise<boolean> {
  let findings: Finding[] | null;
  try {
    findings = look(file, now);
  } catch (e) {
    print(`Could not read the agent's database (${e instanceof Error ? e.message : "unknown error"}), so nothing was checked. A later run tries again.`);
    return false;
  }
  if (findings === null) print("Nothing to check: the agent has not run here yet (no database).");
  else if (findings.length === 0) print("Nothing to report.");
  if (!findings || findings.length === 0) return true;

  // The database is opened for writing when there is something to tell, and not before.
  let db: DB;
  try {
    db = openDb(file);
  } catch {
    for (const f of findings) print(`${NOT_TOLD} ${f.text}`);
    return false;
  }
  attachLogDb(db);
  try {
    return await tell(db, findings, print);
  } finally {
    db.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const command = process.argv[2];
  if (command === "test") {
    if (!(await alertTest(config))) process.exitCode = 1;
  } else if (command === "check") {
    if (!(await alertCheck(dbFilePath()))) process.exitCode = 1;
  } else {
    console.log("usage: npm run alert-test | npm run alert-check");
    process.exitCode = 1;
  }
}
