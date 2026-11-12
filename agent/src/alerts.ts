/**
 * Owner alerts: a short Telegram message when something needs the owner.
 *
 *   • At most one message per kind per hour. While the same trouble lasts a kind reminds less often than that
 *     (REMIND_MS); new trouble of the same kind waits out the hour and no more.
 *   • No alert carries an address, a transaction, a link, an X handle or a key: the text is cleaned on its way
 *     out, whatever the caller wrote.
 *   • With no channel set (TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env) an alert is a line in the log.
 *   • It never throws and gives Telegram ten seconds at most. Callers on the trade path do not wait for it.
 *
 * What went out last is kept in the database, so a restart does not repeat an alert.
 */
import { type DB, getMeta, setMeta } from "@godseye/shared";
import { hideOwnWallet } from "@godseye/shared/public-view";
import { config } from "./config";
import { say } from "./log";
import { openRealPositions } from "./startup";

export type AlertKind =
  | "x_credits" // X refuses paid reads: out of credits, or over its usage cap
  | "unknown_outflow" // SOL left the wallet and no trade explains it
  | "self_pause" // the agent paused itself at its drawdown limit
  | "daily_stop" // the day's loss limit stopped new buys
  | "job_stalled" // a scheduled job ran past its time, or has left no trace for too long
  | "stream_down" // the live stream delivers nothing
  | "stream_back"
  | "agent_down" // the agent stopped reporting in (seen by `npm run alert-check`)
  | "test";

export type Outcome = "sent" | "logged" | "waiting" | "failed";

const HOUR = 3_600_000;
/** How long a kind stays quiet while the same trouble lasts. Never under an hour. */
const REMIND_MS: Record<AlertKind, number> = {
  x_credits: 24 * HOUR,
  unknown_outflow: HOUR,
  self_pause: 24 * HOUR,
  daily_stop: 24 * HOUR,
  job_stalled: HOUR,
  stream_down: 24 * HOUR,
  stream_back: HOUR,
  agent_down: HOUR,
  test: HOUR,
};
/** A send that failed is tried again after this long; a second alert of the kind waits as long while one is on its way. */
const RETRY_MS = 5 * 60_000;
const SEND_TIMEOUT_MS = 10_000;

/** What is remembered per kind (agent_meta, key `alert_<kind>`). */
interface Last {
  /** When the last message went out (or into the log). */
  at?: string;
  /** Which trouble it was about. */
  about?: string;
  /** No new attempt before this time. */
  tryAfter?: string;
}

const key = (kind: AlertKind): string => `alert_${kind}`;
function read(db: DB, kind: AlertKind): Last {
  try {
    const v: unknown = JSON.parse(getMeta(db, key(kind)) ?? "{}");
    return v && typeof v === "object" ? (v as Last) : {};
  } catch {
    return {};
  }
}

/** The hour between any two messages of a kind, or the kind's longer pause before it repeats itself about the same trouble. */
function mustWait(kind: AlertKind, last: Last, about: string, now: number): boolean {
  if (Date.parse(last.tryAfter ?? "") > now) return true;
  const at = Date.parse(last.at ?? "");
  if (!Number.isFinite(at)) return false;
  return now - at < HOUR || (last.about === about && now - at < REMIND_MS[kind]);
}

const B58 = "[1-9A-HJ-NP-Za-km-z]";
/** A web address: it may hold a key, or lead to a wallet. */
const LINK = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;
const BOT_TOKEN_SHAPED = /\b\d{5,}:[\w-]{20,}/g;
/** Anything this long with no space in it is an address, a transaction or a key: no plain word is. */
const LONG_RUN = /[\w+\/~-][\w+\/.~-]{22,}[\w+\/~-]/g;
const ADDRESS = new RegExp(`^${B58}{32,44}$`);
const SIGNATURE = new RegExp(`^${B58}{64,}$`);
/** An address cut short, as the log writes one: four characters, an ellipsis, four more. */
const SHORT_ADDRESS = new RegExp(`(?<![A-Za-z0-9])${B58}{4}(?:…|\\.{3})${B58}{4}(?![A-Za-z0-9])`, "g");
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
/** An X handle, or a Telegram name. */
const HANDLE = /@\w+/g;
const MAX_IN = 2000;
const MAX_OUT = 600;

/** The keys and addresses the agent was given, longest first. One that reached an alert is cut out by its value, whatever it looks like. */
const givenKeys = (): string[] =>
  [
    config.telegramBotToken, config.telegramChatId, config.xBearerToken, config.grpcToken, config.grpcUrl, config.heliusApiKey, config.shyftApiKey,
    config.birdeyeApiKey, config.jupiterApiKey, config.solanaRpcUrl, config.solanaWsUrl, config.copyRpcUrl, config.copyWsUrl, config.historyTxRpcUrl,
  ]
    .filter((k) => k.length >= 6)
    .sort((a, b) => b.length - a.length);

/** Alert text with everything private taken out. */
export function clean(text: string, own: string | null, keys: string[] = givenKeys()): string {
  // Long text is cut at a space: half an address is still part of one.
  let s = text.length > MAX_IN ? text.slice(0, MAX_IN).replace(/\S*$/, "") : text;
  for (const k of keys) s = s.split(k).join("[key hidden]");
  s = hideOwnWallet(s.replace(LINK, "[link hidden]"), own).replace(BOT_TOKEN_SHAPED, "[key hidden]");
  // A long run goes as a whole: hiding only the part that looks like an address would leave the rest of a key in view.
  s = s.replace(LONG_RUN, (run) => (SIGNATURE.test(run) ? "[signature hidden]" : ADDRESS.test(run) ? "[address hidden]" : "[key hidden]"));
  s = s.replace(SHORT_ADDRESS, "[address hidden]").replace(EMAIL, "[name hidden]").replace(HANDLE, "[name hidden]");
  return s.replace(/\s+/g, " ").trim().slice(0, MAX_OUT);
}

export interface Channel {
  botToken: string;
  chatId: string;
}
export type ChannelSettings = Pick<typeof config, "telegramBotToken" | "telegramChatId">;
/** A bot token as @BotFather gives it: the bot's number, a colon, the secret part. It goes into a web address, so nothing else is let through. */
const BOT_TOKEN = /^\d+:[\w-]{30,}$/;
const CHAT_ID = /^(-?\d+|@\w+)$/;

/** The Telegram chat alerts go to; null when it is not set, or not usable as written. */
export function channelFrom(c: ChannelSettings): Channel | null {
  return BOT_TOKEN.test(c.telegramBotToken) && CHAT_ID.test(c.telegramChatId) ? { botToken: c.telegramBotToken, chatId: c.telegramChatId } : null;
}

/** Where alerts go, for the start-up report. Never the token or the chat. */
export function channelNote(c: ChannelSettings): string {
  if (channelFrom(c)) return "Telegram";
  if (!c.telegramBotToken && !c.telegramChatId) return "log only (set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID to get them on Telegram)";
  return "log only (TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is missing or not in its usual form)";
}

export type Written = "ok" | "empty" | "odd";
const written = (value: string, usual: RegExp): Written => (!value ? "empty" : usual.test(value) ? "ok" : "odd");
/** How each of the two settings stands as written in .env, for `npm run alert-test`. Never what it holds. */
export const channelState = (c: ChannelSettings): { token: Written; chat: Written } => ({
  token: written(c.telegramBotToken, BOT_TOKEN),
  chat: written(c.telegramChatId, CHAT_ID),
});

const REFUSED: Record<number, string> = {
  400: "Telegram refused the message: check TELEGRAM_CHAT_ID",
  401: "Telegram refused the bot token",
  403: "the bot may not write to that chat: open the chat with the bot and press Start",
  404: "Telegram does not know that bot token",
  409: "another program is already reading this bot's messages",
  429: "Telegram asked to slow down",
};

/**
 * One call to Telegram's bot API. Gives the answer's `result`, or a short reason in our own words: Telegram's answer
 * and the address called are never quoted, because the address holds the token.
 */
async function telegram(botToken: string, method: "sendMessage" | "getUpdates", body: object): Promise<{ result: unknown } | string> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    const answer = (await res.json().catch(() => null)) as { result?: unknown } | null;
    return res.ok ? { result: answer?.result } : (REFUSED[res.status] ?? `Telegram answered ${res.status}`);
  } catch (e) {
    return (e as Error | null)?.name === "TimeoutError" ? "Telegram did not answer in time" : "Telegram could not be reached";
  }
}

export interface Chat {
  id: string;
  /** private, group, supergroup or channel */
  type: string;
}
const CHAT_TYPES = ["private", "group", "supergroup", "channel"];

/**
 * The chats that wrote to the bot in the last day: how the owner finds the chat ID for .env (`npm run alert-test`).
 * It only reads; nothing is marked as seen. A string is the reason it could not be asked.
 */
export async function recentChats(botToken: string): Promise<Chat[] | string> {
  if (!BOT_TOKEN.test(botToken)) return "TELEGRAM_BOT_TOKEN is not in its usual form (a number, a colon, then about 35 letters and digits)";
  const answer = await telegram(botToken, "getUpdates", { limit: 100, timeout: 0 });
  if (typeof answer === "string") return answer;
  const chats = new Map<string, Chat>();
  for (const update of Array.isArray(answer.result) ? answer.result : []) {
    // An update holds one of message, edited_message, channel_post, my_chat_member…: each names its chat.
    for (const part of Object.values((update ?? {}) as Record<string, unknown>)) {
      const chat = (part as { chat?: { id?: unknown; type?: unknown } } | null)?.chat;
      if (typeof chat?.id !== "number") continue;
      chats.set(String(chat.id), { id: String(chat.id), type: CHAT_TYPES.find((t) => t === chat.type) ?? "chat" });
    }
  }
  return [...chats.values()];
}

/** A stretch of time in the words an alert uses: "12 minutes", "5 hours", "3 days". */
export function howLong(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 120) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} hours` : `${Math.round(hours / 24)} days`;
}

/**
 * One alert through `channel` (null = the log only). `about` names the trouble (a day, the time it began), which
 * tells a reminder from a new case; `force` skips the waiting, for the owner's own test message.
 */
export async function sendAlert(db: DB, channel: Channel | null, kind: AlertKind, text: string, opts: { about?: string; force?: boolean } = {}): Promise<Outcome> {
  try {
    const now = Date.now();
    const about = clean(opts.about ?? "", null).slice(0, 80);
    const last = read(db, kind);
    if (!opts.force && mustWait(kind, last, about, now)) return "waiting";
    const message = clean(text, getMeta(db, "wallet_pubkey"));
    const done = (): void => setMeta(db, key(kind), JSON.stringify({ at: new Date(now).toISOString(), about } satisfies Last));
    if (!channel) {
      done();
      say("warn", `Owner alert (${kind}): ${message}`);
      return "logged";
    }
    // Written before the call goes out: a second alert of this kind waits meanwhile, and so does the next try after a failure.
    setMeta(db, key(kind), JSON.stringify({ ...last, tryAfter: new Date(now + RETRY_MS).toISOString() } satisfies Last));
    const answer = await telegram(channel.botToken, "sendMessage", { chat_id: channel.chatId, text: `GodsEye: ${message}` });
    if (typeof answer !== "string") {
      done();
      say("warn", `Owner alert sent (${kind}): ${message}`);
      return "sent";
    }
    say("warn", `Owner alert not delivered (${answer}); next try in ${RETRY_MS / 60_000} minutes at the earliest. It said: ${message}`);
    return "failed";
  } catch {
    return "failed"; // an alert must never break the work that raised it
  }
}

const ownerChannel = channelFrom(config);

/** Tells the owner. Safe to call often and without waiting: `void alert(…)`. */
export const alert = (db: DB, kind: AlertKind, text: string, about = ""): Promise<Outcome> => sendAlert(db, ownerChannel, kind, text, { about });

/** What a look from outside found wrong. */
export interface Finding {
  kind: AlertKind;
  text: string;
  /** Which trouble it is: see sendAlert. */
  about: string;
}

/** The agent writes a heartbeat every minute, and its longest stalls stay under one. This late, it is down or stuck. */
const DOWN_AFTER_MS = 10 * 60_000;
/** Jobs that leave a trace when a run finishes, and how old it may get. As shipped they run every 15 and every 30 minutes. */
const TRACED_JOBS = [
  { name: "learning", trace: "last_learning_at", lateMs: 2 * HOUR, cost: "the choice of wallets to copy is that old" },
  { name: "discovery", trace: "last_discovery_at", lateMs: 3 * HOUR, cost: "no new wallets are being found" },
];

/**
 * What the agent can't tell the owner itself: that it is down, or that a job never gets to the end of a run. Read from
 * the database by `npm run alert-check`, which runs on a timer of its own. It only reads; telling is the caller's part.
 */
export function outsideCheck(db: DB, now = Date.now()): Finding[] {
  const status = db.prepare("SELECT value, updated_at FROM agent_meta WHERE key = 'agent_status'").get() as { value: string; updated_at: string } | undefined;
  if (!status) return []; // the agent has never run on this database
  const open = openRealPositions(db);

  if (status.value !== "live") {
    // Stopped on purpose, which is the owner's business: unless real positions were left open, with nothing watching them.
    const stoppedFor = now - Date.parse(status.updated_at);
    if (open === 0 || !(stoppedFor >= DOWN_AFTER_MS)) return [];
    const text = `The agent was stopped ${howLong(stoppedFor)} ago with ${open} real position${open === 1 ? "" : "s"} open. Nothing watches ${open === 1 ? "it" : "them"} until the agent runs again.`;
    return [{ kind: "agent_down", text, about: `stopped ${status.updated_at}` }];
  }

  const beat = getMeta(db, "heartbeat") ?? "";
  const quietFor = now - Date.parse(beat);
  if (!Number.isFinite(quietFor)) return []; // no heartbeat to go by
  if (quietFor >= DOWN_AFTER_MS) {
    const unwatched = open === 0 ? "" : open === 1 ? " Its open real position is not watched meanwhile." : ` Its ${open} open real positions are not watched meanwhile.`;
    return [{ kind: "agent_down", text: `The agent has not reported in for ${howLong(quietFor)}: it may have crashed or be stuck.${unwatched}`, about: `silent since ${beat}` }];
  }

  // It is alive. A job counts from its last finished run or from the agent's start, whichever is later: after a long
  // stop the first runs are still on their way.
  const started = Date.parse(getMeta(db, "agent_started_at") ?? "");
  const late = TRACED_JOBS.flatMap((job) => {
    const finished = Date.parse(getMeta(db, job.trace) ?? "");
    if (!Number.isFinite(finished)) return []; // it has never finished one: nothing to measure from
    return now - Math.max(finished, Number.isFinite(started) ? started : 0) >= job.lateMs ? [{ ...job, forMs: now - finished }] : [];
  });
  if (late.length === 0) return [];
  const text = `The agent is running, but ${late.map((job) => `${job.name} has not finished a run for ${howLong(job.forMs)} (${job.cost})`).join(" and ")}.`;
  return [{ kind: "job_stalled", text, about: late.map((job) => job.name).join(", ") }];
}
