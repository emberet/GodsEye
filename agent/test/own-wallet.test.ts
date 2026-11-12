/**
 * The agent's own wallet stays out of sight. Discovery never adds it, the stream takes its trades as prices and
 * nothing more, no wallet list holds it, the stored log never names it, and what is published carries neither its
 * address nor its transactions (which would lead to it).
 * In-memory database, a stub for the watcher: nothing reaches the chain or the network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { type DB, commitProof, openDb, setMeta } from "@godseye/shared";
import {
  buildDashboardSnapshot,
  getAllWalletRows,
  getLeaders,
  getLiveWallets,
  getLogs,
  getRunners,
  getSmartMoney,
  getWalletDetail,
  getWalletGroups,
} from "@godseye/shared/dashboard-data";
import type { CopiesData, RunnersData, Summary, WalletDetail } from "@godseye/shared/dashboard-types";
import { publicSnapshot, walletKey } from "@godseye/shared/snapshot-store";
import type { ParsedSwap, TxLike } from "../src/chain/parse";
import type { LeaderWatcher } from "../src/copy/watcher";
import { MINT, fakeSignature } from "./helpers";

const { addWallet } = await import("../src/discovery/discover");
const { attachLogDb, say } = await import("../src/log");
const { ensureRunnerTables } = await import("../src/runners/schema");
const { PUMP_LAUNCH_PRICE_SOL } = await import("../src/runners/tape");
const { LiveStream } = await import("../src/stream/stream");

const address = (): string => Keypair.generate().publicKey.toBase58();
/** The agent's wallet in these tests: made up at run time and set in the database directly, never loaded or created. */
const OWN = address();
const T0 = "2026-11-01T00:00:00.000Z";

function fresh(): DB {
  const db = openDb(":memory:");
  ensureRunnerTables(db);
  setMeta(db, "wallet_pubkey", OWN);
  return db;
}

const count = (db: DB, sql: string, ...args: unknown[]): number => (db.prepare(sql).get(...args) as { n: number }).n;

/** A `wallets` row written straight to the table, as an older version could have for any address. */
function walletRow(db: DB, a: string, funder: string | null = null, weight = 0): void {
  db.prepare("INSERT INTO wallets (address, first_seen_at, discovered_via, funder, copy_weight) VALUES (?, ?, 'test', ?, ?)").run(a, T0, funder, weight);
}

function activityRow(db: DB, a: string): void {
  db.prepare("INSERT INTO wallet_activity (address, first_seen_at, last_seen_at, swaps, buys, sells, volume_sol) VALUES (?, ?, ?, 2, 1, 1, 0.2)").run(a, T0, T0);
}

function catcherRow(db: DB, a: string, label: string, handle: string | null = null): void {
  db.prepare(
    `INSERT INTO runner_catchers (wallet, hits, early_buys, hit_rate, hit_rate_lb, base_rate, days, label, x_handle, score, qualifies, first_added_at, updated_at)
     VALUES (?, 3, 5, 0.6, 0.3, 0.1, 4, ?, ?, 1, 1, ?, ?)`,
  ).run(a, label, handle, T0, T0);
}

/** A buy of a new coin at pump.fun's launch price: a swap the live book, the runner tape and the swap store all take in. */
const launchBuy = (wallet: string): ParsedSwap => ({
  wallet,
  signature: fakeSignature(),
  slot: 1,
  ts: new Date().toISOString(),
  mint: address(),
  side: "buy",
  tokenAmount: 1_000_000,
  tokenBalanceBefore: 0,
  solAmount: 1_000_000 * PUMP_LAUNCH_PRICE_SOL,
  priceSol: PUMP_LAUNCH_PRICE_SOL,
  quote: "SOL",
  quoteAmount: 1_000_000 * PUMP_LAUNCH_PRICE_SOL,
  solUsd: null,
  usdAmount: null,
  venue: "pumpfun",
  jitoTip: false,
  feeLamports: 5_000,
});

test("discovery never adds the agent's own wallet", () => {
  const db = fresh();
  const other = address();
  assert.equal(addWallet(db, OWN, "test", "seen trading"), false);
  assert.equal(addWallet(db, other, "test", "seen trading"), true);
  assert.equal(count(db, "SELECT COUNT(*) n FROM wallets WHERE address = ?", OWN), 0);
  assert.equal(count(db, "SELECT COUNT(*) n FROM wallets"), 1);
});

test("on the stream the agent's own trades are prices and nothing more", () => {
  const db = fresh();
  const tracked = address();
  // Rows an older version could have written for its own wallet: the stream must not build on them.
  walletRow(db, OWN);
  walletRow(db, tracked);
  activityRow(db, OWN);
  const priced: string[] = [];
  const watcher = { marketSwap: (s: ParsedSwap) => priced.push(s.wallet), isWatching: () => false, handleStreamed: async () => {} } as unknown as LeaderWatcher;
  const live = new LiveStream(db, watcher);
  const feed = live as unknown as { onSignerSwaps(signer: string, swaps: ParsedSwap[], tx: TxLike, now: number): void; pendingSwaps: ParsedSwap[] };

  live.refreshTracked();
  assert.equal(count(db, "SELECT COUNT(*) n FROM wallet_activity WHERE address = ?", OWN), 0, "the old activity row is dropped");

  feed.onSignerSwaps(OWN, [launchBuy(OWN)], {} as TxLike, Date.now());
  assert.deepEqual([live.book.size, live.tape.size, feed.pendingSwaps.length], [0, 0, 0], "not scored, not on the runner tape, not stored");
  assert.deepEqual(priced, [OWN], "its fill still counts as a market price");

  feed.onSignerSwaps(tracked, [launchBuy(tracked)], {} as TxLike, Date.now());
  assert.deepEqual([live.book.size, live.tape.size, feed.pendingSwaps.length], [1, 1, 1], "any other wallet's swap is taken in as usual");

  live.flush();
  for (const [table, column] of [["wallet_swaps", "wallet"], ["wallet_activity", "address"]]) {
    assert.equal(count(db, `SELECT COUNT(*) n FROM ${table} WHERE ${column} = ?`, OWN), 0, `${table} holds a row for the agent's wallet`);
    assert.equal(count(db, `SELECT COUNT(*) n FROM ${table} WHERE ${column} = ?`, tracked), 1, `${table} lost the other wallet's row`);
  }
});

test("no wallet list includes the agent's own wallet", () => {
  const db = fresh();
  const [leader, sibling, funder, child] = [address(), address(), address(), address()];
  walletRow(db, OWN, funder, 0.5);
  walletRow(db, leader, funder, 0.5);
  walletRow(db, sibling, funder);
  // Two wallets the agent funded: listed as a group they would point straight at it.
  walletRow(db, child, OWN);
  walletRow(db, address(), OWN);
  for (const a of [OWN, leader]) {
    activityRow(db, a);
    catcherRow(db, a, "organic");
    db.prepare("INSERT INTO smart_wallets (address, source, reason, updated_at) VALUES (?, 'test', 'seeded', ?)").run(a, T0);
    db.prepare("INSERT INTO weight_history (wallet, ts, old_weight, new_weight, reason) VALUES (?, ?, 0, 0.5, 'seeded')").run(a, T0);
  }

  const lists: Record<string, string[]> = {
    wallets: getAllWalletRows(db).map((w) => w.address),
    "live wallets": getLiveWallets(db, { limit: 100 }).map((w) => w.address),
    leaders: getLeaders(db).leaders.map((w) => w.address),
    "weight changes": getLeaders(db).changes.map((c) => c.wallet),
    "smart money": getSmartMoney(db).wallets.map((w) => w.address),
    "runner catchers": getRunners(db).catchers.map((c) => c.wallet),
  };
  for (const [name, rows] of Object.entries(lists)) {
    assert.ok(rows.includes(leader), `${name}: the wallet seeded next to it is missing`);
    assert.ok(!rows.includes(OWN), `${name} lists the agent's own wallet`);
  }

  const groups = getWalletGroups(db);
  assert.deepEqual(groups.map((g) => g.funder), [funder], "the group the agent funded is not listed");
  assert.deepEqual(groups[0].members.map((m) => m.address).sort(), [leader, sibling].sort(), "nor is it a member of its funder's group");
  assert.equal(groups[0].size, 2);

  assert.equal(getWalletDetail(db, OWN), null, "it has no wallet page");
  assert.deepEqual(getWalletDetail(db, leader)?.group.map((w) => w.address), [sibling]);
  assert.deepEqual(getWalletDetail(db, child)?.group, [], "a wallet it funded shows no group");
});

test("the stored log names neither the agent's wallet nor a transaction", () => {
  const db = fresh();
  const mine = fakeSignature();
  attachLogDb(db);
  try {
    say("error", `Sell failed: not confirmed (${mine})`);
    say("wallet", `Wallet ${OWN} holds 1 SOL`);
  } finally {
    attachLogDb(null as unknown as DB);
  }
  const stored = (db.prepare("SELECT message FROM agent_log ORDER BY id").all() as { message: string }[]).map((r) => r.message);
  assert.deepEqual(stored, ["Sell failed: not confirmed ([signature hidden])", "Wallet [agent wallet] holds 1 SOL"]);

  // A line an older version stored as it was: cleaned when read.
  db.prepare("INSERT INTO agent_log (ts, level, message) VALUES (?, 'wallet', ?)").run(T0, `Agent wallet: ${OWN} (${mine})`);
  const read = JSON.stringify(getLogs(db));
  assert.ok(!read.includes(OWN) && !read.includes(mine), "an old line still names them when read");
});

test("what is published carries neither the agent's address, its transactions nor an X account", () => {
  const db = fresh();
  const [leader, child] = [address(), address()];
  const [mine, theirs] = [fakeSignature(), fakeSignature()];
  const [handle, caller] = ["made_up_handle", "made_up_caller"];
  walletRow(db, leader, null, 0.5);
  walletRow(db, child, OWN);
  walletRow(db, address(), OWN);
  catcherRow(db, leader, "kol", handle);
  db.prepare(
    "INSERT INTO x_callers (author_id, username, calls, runner_calls, early_runner_calls, control_calls, hit_rate_lb, days, score, updated_at) VALUES ('1', ?, 4, 2, 1, 1, 0.2, 3, 1, ?)",
  ).run(caller, T0);

  // A filled copy and a failed one, each with the agent's own transaction on it, and texts that quote it.
  const buy = commitProof(db, "copy_buy", { leader, leader_signature: theirs, mint: MINT, symbol: "COW", size_sol: 0.1, weight: 0.5, mode: "real" });
  commitProof(db, "copy_sell", { position_id: 1, mint: MINT, symbol: "COW", tokens: 1, all: true, reason: `sold (found on chain) ${mine}`, mode: "real" });
  const trade = db.prepare(
    `INSERT INTO copy_trades (leader, leader_signature, leader_ts, mint, symbol, side, mode, status, weight, size_sol, signature, error, latency_ms, proof_id, created_at)
     VALUES (?, ?, ?, ?, 'COW', ?, 'real', ?, 0.5, 0.1, ?, ?, 900, ?, ?)`,
  );
  trade.run(leader, theirs, T0, MINT, "buy", "filled", mine, null, buy.id, T0);
  trade.run(leader, fakeSignature(), T0, MINT, "sell", "failed", mine, `Sell failed: not confirmed (${mine})`, null, T0);
  db.prepare(
    `INSERT INTO positions (mint, symbol, leader, mode, status, token_amount, tokens_bought, cost_sol, proceeds_sol, entry_price_sol, opened_at, closed_at, exit_reason, pnl_sol, pnl_pct)
     VALUES (?, 'COW', ?, 'real', 'closed', 0, 1, 0.1, 0.12, 0.1, ?, ?, ?, 0.02, 20)`,
  ).run(MINT, leader, T0, T0, `sold (found on chain) ${mine}`);
  db.prepare("INSERT INTO agent_log (ts, level, message) VALUES (?, 'wallet', ?)").run(T0, `Agent wallet: ${OWN}`);

  const raw = {
    ...buildDashboardSnapshot(db),
    [walletKey(leader)]: getWalletDetail(db, leader),
    [walletKey(child)]: getWalletDetail(db, child),
    [walletKey(OWN)]: { wallet: { address: OWN } },
  };
  // The data read from the database does hold all of it; the check below would prove nothing otherwise.
  const rawText = JSON.stringify(raw);
  for (const secret of [OWN, mine, handle, caller]) assert.ok(rawText.includes(secret));

  const pub = publicSnapshot(raw, OWN);
  const text = JSON.stringify(pub);
  const secrets = { "the agent's address": OWN, "the agent's transaction": mine, "an X handle": handle, "an X caller": caller };
  for (const [what, secret] of Object.entries(secrets)) assert.ok(!text.includes(secret), `${what} is in the public data`);
  assert.ok(text.includes(leader), "watched wallets stay public");

  const copies = pub.copies as CopiesData;
  assert.equal(copies.trades.length, 2);
  assert.ok(copies.trades.every((t) => !("signature" in t) && !("leader_signature" in t)), "a trade links to a transaction");
  assert.equal(copies.closed[0].exit_reason, "sold (found on chain) [signature hidden]");
  assert.equal((pub.summary as Summary).wallet.pubkey, null);
  const page = pub[walletKey(child)] as WalletDetail;
  assert.deepEqual([page.wallet.funder, page.wallet.group_size, page.group], [null, 1, []], "a wallet the agent funded reads like one with no known funder");
  const runners = pub.runners as RunnersData;
  assert.deepEqual([runners.catchers.length, runners.catchers[0].label, runners.callers], [1, null, []]);
});
