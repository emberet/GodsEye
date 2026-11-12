/**
 * RECOVERY — copy trades whose result was never recorded, and positions that no longer match the wallet.
 *
 * A trade is recorded as `pending` before it's sent, and its signature goes on the row once it's signed. The result
 * can then go missing two ways: the engine couldn't tell whether the swap landed (it leaves the row pending, with
 * why), or GodsEye stopped before recording it. Until it's settled a pending buy keeps holding its share of the
 * budget and a pending sell keeps every other sell of its position waiting, so each one is settled in bounded time.
 *
 * `settleSigned`: pending trades with a signature. The chain says what happened:
 *   • landed            → the fill is read from the transaction and recorded (fills.ts)
 *   • failed on chain   → marked failed
 *   • never landed      → marked failed, once the last block it could land in is well past
 *   • can't tell yet    → left for the next pass
 *
 * `recoverPending`: pending trades with no signature (interrupted before signing, or sent by a version that didn't
 * save it):
 *   • buy, wallet holds the token  → the swap landed: open the position from what the wallet holds
 *                                     (cost = the planned size; fees not recorded)
 *   • buy, wallet holds none       → nothing was bought: mark it failed
 *   • sell                          → mark it failed; the position stays open and the next exit retries
 *   • can't read the wallet         → leave it for the next pass
 * Paper trades never touched the chain: interrupted ones are simply failed.
 *
 * `settleMissing`: open positions the wallet holds none of. The token account's history is searched for sells that
 * landed without being recorded, and each is recorded with its real proceeds. When there are none, on several checks
 * over ten minutes, the position is closed with what is on record. A read that fails concludes nothing.
 *
 * `sweepWallet`: tokens in the wallet with no open position. It acts on chain evidence only:
 *   • a buy marked failed that the chain shows landed    → its position is opened from the transaction
 *   • a position closed as missing whose tokens are there → opened again
 *   • anything else (an airdrop, dust)                    → left alone, reported once
 *
 * `reconcile` only reports: open positions whose recorded amount differs from what the wallet holds.
 */
import { type DB, nowIso, SOL_MINT } from "@godseye/shared";
import { say, short } from "../log";
import type { Fill } from "./executor";
import { applySellFill, closeMissing, openPositionFromFill } from "./fills";

interface PendingRow {
  id: number;
  leader: string;
  mint: string;
  symbol: string | null;
  side: "buy" | "sell";
  mode: "real" | "paper";
  size_sol: number | null;
}

interface SignedRow extends PendingRow {
  leader_signature: string;
  leader_ts: string;
  reason: string | null;
  token_amount: number | null;
  signature: string;
  last_valid_height: number | null;
  position_id: number | null;
  created_at: string;
}

/** Tokens of `mint` the agent wallet holds (UI units), or null if it couldn't be read. */
export type HeldTokens = (mint: string) => Promise<number | null>;

/** What the agent's wallet traded in one landed transaction. */
export interface ChainTrade {
  side: "buy" | "sell";
  fill: Fill;
  /** Block time, ms. */
  atMs: number;
}

/** The chain reads the settle steps need. The real one is built from the agent's wallet; tests pass a fake. */
export interface SettleChain {
  /** A transaction's status, history searched; undefined = no node knows it. Throws when it can't be read. */
  status(signature: string): Promise<{ err: unknown; confirmed: boolean } | undefined>;
  blockHeight(): Promise<number>;
  /** What the wallet traded of `mint` in a landed transaction; null = no trade of it there. Throws when it can't be read. */
  trade(signature: string, mint: string): Promise<ChainTrade | null>;
  /** Signatures that touched the wallet's token account(s) for `mint`, newest first, failed ones left out. Throws when it can't be read. */
  tokenHistory(mint: string, limit: number): Promise<{ signature: string; atMs: number | null }[]>;
}

/** Blocks past a transaction's last valid height before "never landed" is believed (about 30 s: RPC nodes lag one another). */
export const SETTLE_MARGIN_BLOCKS = 150;
/** A landed trade whose transaction can't be read for this long is closed out the best way left. */
export const GIVE_UP_MS = 30 * 60_000;
const SETTLED_NOTE = "settled from the chain";

interface AdoptTexts {
  open: string;
  none: string;
  note: string;
  said: string;
}
const RESTART: AdoptTexts = {
  open: "interrupted by a restart; a position in this token is already open",
  none: "interrupted by a restart; nothing was bought",
  note: "recovered after a restart: amounts from the wallet, cost = planned size",
  said: "interrupted by a restart",
};
const UNREAD: AdoptTexts = {
  open: "landed, but its amounts couldn't be read; a position in this token is already open",
  none: "landed, but its amounts couldn't be read and the wallet holds none of it",
  note: "landed, amounts unreadable: amounts from the wallet, cost = planned size",
  said: "that landed but couldn't be read",
};

/** A real buy whose fill can't be read: its position is opened from what the wallet holds (cost = the planned size). */
async function adoptHeld(db: DB, r: PendingRow, held: HeldTokens, t: AdoptTexts): Promise<"opened" | "failed" | "left"> {
  const fail = (why: string): "failed" => {
    db.prepare("UPDATE copy_trades SET status='failed', error=? WHERE id=? AND status='pending'").run(why, r.id);
    return "failed";
  };
  const isOpen = () => db.prepare("SELECT 1 FROM positions WHERE status='open' AND mint=? AND mode='real'").get(r.mint) !== undefined;
  if (isOpen()) return fail(t.open);
  const amount = await held(r.mint).catch(() => null);
  if (amount === null) return "left";
  if (amount <= 0) return fail(t.none);
  const cost = r.size_sol ?? 0;
  const price = cost > 0 ? cost / amount : 0;
  const now = nowIso();
  const opened = db.transaction((): boolean => {
    if (!db.prepare("SELECT 1 FROM copy_trades WHERE id=? AND status='pending'").get(r.id) || isOpen()) return false;
    const pos = db
      .prepare(
        `INSERT INTO positions (mint, symbol, leader, mode, status, token_amount, tokens_bought, cost_sol, cost_usd, fee_sol, entry_price_sol, last_price_sol, last_price_ts, opened_at, decider)
         VALUES (?, ?, ?, 'real', 'open', ?, ?, ?, NULL, NULL, ?, ?, ?, ?, COALESCE((SELECT decider FROM copy_trades WHERE id = ?), 'rules'))`,
      )
      .run(r.mint, r.symbol, r.leader, amount, amount, cost, price, price, now, now, r.id);
    db.prepare("UPDATE copy_trades SET status='filled', token_amount=?, price_sol=?, position_id=?, filled_at=?, error=? WHERE id=?").run(amount, price, Number(pos.lastInsertRowid), now, t.note, r.id);
    return true;
  })();
  if (!opened) return "left";
  say("trade", `Recovered a buy of ${r.symbol ?? short(r.mint)} ${t.said}: the wallet holds ${amount.toPrecision(4)}, position opened.`);
  return "opened";
}

const errText = (err: unknown): string => {
  try {
    return JSON.stringify(err).slice(0, 200);
  } catch {
    return String(err).slice(0, 200);
  }
};

/** Leader's trade → our fill, ms. Null for the agent's own exits: they follow no leader's trade. */
const latencyOf = (leaderSignature: string, leaderTs: string, atMs: number): number | null => {
  const lag = leaderSignature.startsWith("exit:") ? NaN : atMs - Date.parse(leaderTs);
  return Number.isFinite(lag) ? Math.max(0, lag) : null;
};

type Outcome = "landed" | "expired" | "wait" | { failed: string };

/** What the chain says about a signed trade. Only a confirmed status is believed, either way (as in the executor). */
async function outcomeOf(chain: SettleChain, r: Pick<SignedRow, "signature" | "last_valid_height" | "created_at">, now: number): Promise<Outcome> {
  const read = (s: { err: unknown; confirmed: boolean } | undefined): Outcome | null =>
    !s ? null : !s.confirmed ? "wait" : s.err ? { failed: `failed on chain: ${errText(s.err)}` } : "landed";
  try {
    const first = read(await chain.status(r.signature));
    if (first) return first;
    // No node knows it. It can still land until its last valid block is past.
    if (r.last_valid_height === null) return now - Date.parse(r.created_at) > GIVE_UP_MS ? "expired" : "wait";
    if ((await chain.blockHeight()) <= r.last_valid_height + SETTLE_MARGIN_BLOCKS) return "wait";
    return read(await chain.status(r.signature)) ?? "expired"; // looked again after the height: it can't land any more
  } catch {
    return "wait";
  }
}

export async function settleSigned(db: DB, chain: SettleChain, opts: { before: string; held: HeldTokens; now?: number }): Promise<{ bought: number; sold: number; failed: number; left: number }> {
  const now = opts.now ?? Date.now();
  // With an error on its row the engine has let the trade go. Without one it is still waiting on it, unless the row is old.
  const rows = db
    .prepare(
      `SELECT id, leader, leader_signature, leader_ts, mint, symbol, side, mode, reason, size_sol, token_amount, signature, last_valid_height, position_id, created_at
       FROM copy_trades WHERE status='pending' AND signature IS NOT NULL AND (error IS NOT NULL OR created_at < ?) ORDER BY id`,
    )
    .all(opts.before) as SignedRow[];
  const out = { bought: 0, sold: 0, failed: 0, left: 0 };
  const fail = (r: SignedRow, why: string) => {
    db.prepare("UPDATE copy_trades SET status='failed', error=? WHERE id=? AND status='pending'").run(why, r.id);
    out.failed++;
  };
  for (const r of rows) {
    const name = r.symbol ?? short(r.mint);
    const outcome = await outcomeOf(chain, r, now);
    if (outcome === "wait") {
      out.left++;
      continue;
    }
    if (outcome !== "landed") {
      fail(r, outcome === "expired" ? "expired: the transaction never landed" : outcome.failed);
      say("info", `Settled a ${r.side} of ${name} from the chain: it ${outcome === "expired" ? "never landed" : "failed on chain"}.`);
      continue;
    }
    const trade = await chain.trade(r.signature, r.mint).catch(() => null);
    if (!trade || trade.side !== r.side) {
      // It landed, but what it did can't be read (yet).
      if (now - Date.parse(r.created_at) <= GIVE_UP_MS) {
        out.left++;
      } else if (r.side === "sell" || r.mode !== "real") {
        fail(r, "landed, but its amounts couldn't be read"); // a sell: exits resume, and the wallet shows what is left
      } else {
        const adopted = await adoptHeld(db, r, opts.held, UNREAD);
        if (adopted === "opened") out.bought++;
        else if (adopted === "failed") out.failed++;
        else out.left++;
      }
      continue;
    }
    const latencyMs = latencyOf(r.leader_signature, r.leader_ts, trade.atMs);
    if (r.side === "buy") {
      const id = openPositionFromFill(db, { copyId: r.id, fill: trade.fill, latencyMs, atMs: trade.atMs, note: SETTLED_NOTE, mint: r.mint, symbol: r.symbol, leader: r.leader, mode: r.mode });
      if (id === null) continue;
      out.bought++;
      say("trade", `Settled a buy of ${name} from the chain: it had landed (${trade.fill.solAmount.toFixed(4)} SOL), position opened.`);
      continue;
    }
    if (r.position_id === null) {
      fail(r, "landed, but it has no position to settle against");
      continue;
    }
    const pos = db.prepare("SELECT token_amount FROM positions WHERE id=? AND status='open'").get(r.position_id) as { token_amount: number } | undefined;
    // The engine plans an "all" sell with the position's whole amount.
    const all = pos ? (r.token_amount ?? 0) >= pos.token_amount * 0.999 : true;
    const result = applySellFill(db, r.position_id, { copyId: r.id, fill: trade.fill, latencyMs, atMs: trade.atMs, note: SETTLED_NOTE, all, reason: r.reason ?? "sold" });
    if (result !== "stale") out.sold++;
  }
  if (out.bought || out.sold || out.failed) say("info", `Settle: ${out.bought} buy(s) and ${out.sold} sell(s) recorded from the chain, ${out.failed} marked failed.`);
  return out;
}

export async function recoverPending(db: DB, opts: { before: string; held: HeldTokens }): Promise<{ opened: number; failed: number; left: number }> {
  const rows = db
    .prepare("SELECT id, leader, mint, symbol, side, mode, size_sol FROM copy_trades WHERE status='pending' AND signature IS NULL AND created_at < ? ORDER BY id")
    .all(opts.before) as PendingRow[];
  const out = { opened: 0, failed: 0, left: 0 };
  for (const r of rows) {
    if (r.side === "sell" || r.mode === "paper") {
      const why = r.side === "sell" ? "interrupted by a restart; the position stays open and will be sold again" : "interrupted by a restart (paper)";
      db.prepare("UPDATE copy_trades SET status='failed', error=? WHERE id=? AND status='pending'").run(why, r.id);
      out.failed++;
      continue;
    }
    const adopted = await adoptHeld(db, r, opts.held, RESTART);
    if (adopted === "opened") out.opened++;
    else if (adopted === "failed") out.failed++;
    else out.left++;
  }
  if (out.failed || out.opened) say("info", `Recovery: ${out.opened} interrupted buy(s) opened as positions, ${out.failed} interrupted trade(s) marked failed.`);
  return out;
}

/** Checks that found no sell, and the time they must span, before a position the wallet holds none of is closed as missing. */
const MISSING_CHECKS = 3;
const MISSING_MS = 10 * 60_000;
/** Token-account signatures searched for a sell that was never recorded. */
const HISTORY_LIMIT = 30;
/** Block time against this machine's clock. */
const CLOCK_SLACK_MS = 10_000;
/** A position closed as missing is opened again only when its tokens turn up within this long. */
const REOPEN_MS = 24 * 3600_000;
/** Failed buys of one coin looked at per check. */
const FAILED_BUYS = 5;
/** A token with no position is checked against the chain this many times (status nodes lag one another)... */
const STRAY_CHECKS = 2;
/** ...over at most this many passes, when the chain can't be read. */
const STRAY_TRIES = 8;
const FOUND_REASON = "sold (found on chain)";
const LANDED_NOTE = `recorded as failed, but it had landed: ${SETTLED_NOTE}`;
let foundSeq = 0;

/** What the wallet checks remember between passes: per database, and not kept across a restart. */
interface Memory {
  /** By position: when the wallet was first seen holding none, the checks since that found no sell, and transactions already seen to be no sell of it. */
  missing: Map<number, { since: number; checks: number; skip: Set<string> }>;
  /** By mint, for tokens that belong to no position: the amount, the passes that saw it and the chain checks done on it. */
  strays: Map<string, { amount: number; passes: number; checks: number }>;
  /** How many strays the last report counted. */
  reported: number;
}
const memories = new WeakMap<DB, Memory>();
function memoryOf(db: DB): Memory {
  let m = memories.get(db);
  if (!m) memories.set(db, (m = { missing: new Map(), strays: new Map(), reported: 0 }));
  return m;
}

interface OpenRow {
  id: number;
  mint: string;
  symbol: string | null;
  leader: string;
  opened_at: string;
}

interface FoundRow {
  id: number;
  side: "buy" | "sell";
  status: string;
  reason: string | null;
  leader_signature: string;
  leader_ts: string;
  token_amount: number | null;
  position_id: number | null;
}

/** Records a sell found on chain: on the failed trade that sent it, or on a new trade when nothing recorded it at all (sold by hand). */
function recordFoundSell(db: DB, p: OpenRow, row: FoundRow | undefined, trade: ChainTrade): "closed" | "reduced" | "stale" {
  return db.transaction((): "closed" | "reduced" | "stale" => {
    const pos = db.prepare("SELECT token_amount FROM positions WHERE id=? AND status='open'").get(p.id) as { token_amount: number } | undefined;
    if (!pos) return "stale";
    const found = { fill: trade.fill, atMs: trade.atMs };
    if (row) {
      // The engine plans an "all" sell with the position's whole amount.
      const all = (row.token_amount ?? 0) >= pos.token_amount * 0.999;
      return applySellFill(db, p.id, { ...found, copyId: row.id, latencyMs: latencyOf(row.leader_signature, row.leader_ts, trade.atMs), note: LANDED_NOTE, all, reason: row.reason ?? FOUND_REASON, revive: true });
    }
    const copyId = db
      .prepare(
        `INSERT INTO copy_trades (leader, leader_signature, leader_ts, mint, symbol, side, mode, status, reason, token_amount, signature, position_id, created_at)
         VALUES (?, ?, ?, ?, ?, 'sell', 'real', 'pending', ?, ?, ?, ?, ?)`,
      )
      .run(p.leader, `exit:${p.id}:${Date.now()}:${++foundSeq}:${FOUND_REASON}`, new Date(trade.atMs).toISOString(), p.mint, p.symbol, FOUND_REASON, trade.fill.tokenAmount, trade.fill.signature, p.id, nowIso()).lastInsertRowid;
    return applySellFill(db, p.id, { ...found, copyId: Number(copyId), latencyMs: null, note: "never recorded: found on chain", all: false, reason: FOUND_REASON });
  })();
}

export async function settleMissing(db: DB, chain: SettleChain, opts: { held: HeldTokens; now?: number }): Promise<{ sold: number; closed: number }> {
  const now = opts.now ?? Date.now();
  const missing = memoryOf(db).missing;
  const open = db.prepare("SELECT id, mint, symbol, leader, opened_at FROM positions WHERE status='open' AND mode='real' ORDER BY id").all() as OpenRow[];
  const stillOpen = (id: number) => db.prepare("SELECT 1 FROM positions WHERE id=? AND status='open'").get(id) !== undefined;
  const out = { sold: 0, closed: 0 };
  for (const p of open) {
    const amount = await opts.held(p.mint).catch(() => null);
    if (amount === null) continue; // unreadable: nothing is concluded, nothing forgotten
    if (amount > 0) {
      missing.delete(p.id);
      continue;
    }
    // A sell of it that is still pending gets its result from settleSigned (or is failed by recoverPending) first.
    if (db.prepare("SELECT 1 FROM copy_trades WHERE position_id=? AND side='sell' AND status='pending'").get(p.id)) continue;
    let seen = missing.get(p.id);
    if (!seen) missing.set(p.id, (seen = { since: now, checks: 0, skip: new Set() }));
    const { skip } = seen;
    const patient = now - seen.since <= GIVE_UP_MS;
    const history = await chain.tokenHistory(p.mint, HISTORY_LIMIT).catch(() => null);
    if (!history) continue; // an unreadable history concludes nothing
    const from = Date.parse(p.opened_at) - CLOCK_SLACK_MS;
    let unread = false;
    // Oldest first: sells are recorded in the order they happened.
    for (const h of history.filter((h) => (h.atMs === null || h.atMs >= from) && !skip.has(h.signature)).reverse()) {
      const row = db.prepare("SELECT id, side, status, reason, leader_signature, leader_ts, token_amount, position_id FROM copy_trades WHERE signature=?").get(h.signature) as FoundRow | undefined;
      // Recorded already, still being settled, or not this position's: only its own sell marked failed is looked at again.
      if (row && !(row.side === "sell" && row.status === "failed" && row.position_id === p.id)) continue;
      let trade: ChainTrade | null;
      try {
        trade = await chain.trade(h.signature, p.mint);
      } catch {
        if (!patient) continue;
        unread = true; // a later sell is never recorded ahead of this one
        break;
      }
      if (trade?.side !== "sell") {
        skip.add(h.signature);
        continue;
      }
      const result = recordFoundSell(db, p, row, trade);
      if (result !== "stale") out.sold++;
      if (result !== "reduced") break;
    }
    if (!stillOpen(p.id)) {
      missing.delete(p.id);
      continue;
    }
    if (unread) continue;
    seen.checks++;
    if (seen.checks >= MISSING_CHECKS && now - seen.since >= MISSING_MS && closeMissing(db, p.id)) {
      out.closed++;
      missing.delete(p.id);
    }
  }
  for (const id of [...missing.keys()]) if (!open.some((p) => p.id === id)) missing.delete(id);
  if (out.sold || out.closed) say("info", `Position check: ${out.sold} unrecorded sell(s) recorded from the chain, ${out.closed} position(s) closed as missing.`);
  return out;
}

interface FailedBuy {
  id: number;
  leader: string;
  leader_signature: string;
  leader_ts: string;
  symbol: string | null;
  signature: string | null;
  error: string | null;
}

/** web3.js's expiry error names the transaction. Versions that didn't save a trade's signature left it only there. */
const EXPIRED_SIGNATURE = /^Signature ([1-9A-HJ-NP-Za-km-z]{64,88}) has expired/;

/** Buys of `mint` recorded as failed that the chain shows landed, oldest first. Throws when the chain can't be read. */
async function landedBuys(db: DB, chain: SettleChain, mint: string): Promise<{ row: FailedBuy; trade: ChainTrade }[]> {
  const rows = db
    .prepare("SELECT id, leader, leader_signature, leader_ts, symbol, signature, error FROM copy_trades WHERE mint=? AND side='buy' AND mode='real' AND status='failed' ORDER BY id DESC LIMIT ?")
    .all(mint, FAILED_BUYS) as FailedBuy[];
  const landed: { row: FailedBuy; trade: ChainTrade }[] = [];
  for (const row of rows.reverse()) {
    const signature = row.signature ?? row.error?.match(EXPIRED_SIGNATURE)?.[1];
    if (!signature) continue; // it failed before it was sent
    const s = await chain.status(signature);
    if (!s?.confirmed || s.err) continue;
    const trade = await chain.trade(signature, mint);
    if (trade?.side === "buy") landed.push({ row, trade });
  }
  return landed;
}

/** A wallet that can't be read concludes nothing. `strays` counts tokens seen on two passes that belong to no position. */
export async function sweepWallet(db: DB, chain: SettleChain, opts: { holdings: () => Promise<Map<string, number> | null>; now?: number }): Promise<{ opened: number; reopened: number; strays: number }> {
  const now = opts.now ?? Date.now();
  const memory = memoryOf(db);
  const out = { opened: 0, reopened: 0, strays: 0 };
  const holdings = await opts.holdings().catch(() => null);
  if (!holdings) return out;
  // A coin with an open position or a trade on its way is accounted for.
  const busy = (mint: string) =>
    db.prepare("SELECT 1 FROM positions WHERE status='open' AND mode='real' AND mint=?").get(mint) !== undefined ||
    db.prepare("SELECT 1 FROM copy_trades WHERE status='pending' AND mode='real' AND mint=?").get(mint) !== undefined;
  const strays = new Set<string>();
  for (const [mint, amount] of holdings) {
    if (!(amount > 0) || mint === SOL_MINT || busy(mint)) continue;
    const before = memory.strays.get(mint);
    const seen = before && before.amount === amount ? before : { amount, passes: 0, checks: 0 };
    if (seen.checks < STRAY_CHECKS && seen.passes < STRAY_TRIES) {
      const landed = await landedBuys(db, chain, mint).catch(() => null);
      if (landed) seen.checks++;
      if (landed?.length) {
        let opened = 0;
        for (const { row, trade } of landed) {
          const fill = { copyId: row.id, fill: trade.fill, latencyMs: latencyOf(row.leader_signature, row.leader_ts, trade.atMs), atMs: trade.atMs, note: LANDED_NOTE, revive: true };
          if (openPositionFromFill(db, { ...fill, mint, symbol: row.symbol, leader: row.leader, mode: "real" }) !== null) opened++;
        }
        out.opened += opened;
        if (opened) say("trade", `Wallet check: a buy of ${landed[0].row.symbol ?? short(mint)} recorded as failed had landed; its position is open now.`);
        continue;
      }
      const last = db.prepare("SELECT id, symbol, status, exit_reason, closed_at, tokens_bought FROM positions WHERE mint=? AND mode='real' ORDER BY id DESC LIMIT 1").get(mint) as
        | { id: number; symbol: string | null; status: string; exit_reason: string | null; closed_at: string | null; tokens_bought: number }
        | undefined;
      if (landed && last?.status === "closed" && last.exit_reason?.startsWith("missing") && last.closed_at && now - Date.parse(last.closed_at) <= REOPEN_MS) {
        const reopened = db.transaction((): boolean => {
          if (busy(mint)) return false;
          const again = db.prepare("UPDATE positions SET status='open', token_amount=?, closed_at=NULL, exit_reason=NULL, pnl_sol=NULL, pnl_usd=NULL, pnl_pct=NULL WHERE id=? AND status='closed'");
          return again.run(Math.min(amount, last.tokens_bought), last.id).changes > 0;
        })();
        if (reopened) {
          out.reopened++;
          say("warn", `Wallet check: ${last.symbol ?? short(mint)} was closed as missing, but the wallet holds it again; its position is open again.`);
          continue;
        }
      }
    }
    strays.add(mint);
    memory.strays.set(mint, { ...seen, passes: seen.passes + 1 });
  }
  for (const mint of [...memory.strays.keys()]) if (!strays.has(mint)) memory.strays.delete(mint);
  out.strays = [...memory.strays.values()].filter((s) => s.passes >= 2).length;
  if (out.strays !== memory.reported) {
    memory.reported = out.strays;
    if (out.strays > 0) say("info", `Wallet check: ${out.strays} token(s) in the wallet belong to no open position. Left alone.`);
  }
  return out;
}

/** Open real positions whose recorded token amount is off by more than `tolerance` from the wallet. Reports only. */
export async function reconcile(db: DB, held: HeldTokens, tolerance = 0.05): Promise<{ mint: string; recorded: number; held: number }[]> {
  const open = db.prepare("SELECT mint, symbol, token_amount FROM positions WHERE status='open' AND mode='real'").all() as { mint: string; symbol: string | null; token_amount: number }[];
  const off: { mint: string; recorded: number; held: number }[] = [];
  for (const p of open) {
    const h = await held(p.mint).catch(() => null);
    if (h === null) continue;
    const diff = Math.abs(h - p.token_amount) / Math.max(p.token_amount, 1e-12);
    if (diff > tolerance) {
      off.push({ mint: p.mint, recorded: p.token_amount, held: h });
      say("warn", `Position check: ${p.symbol ?? short(p.mint)} is recorded as ${p.token_amount.toPrecision(4)} tokens but the wallet holds ${h.toPrecision(4)}.`);
    }
  }
  return off;
}
