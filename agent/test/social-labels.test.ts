/**
 * Labels from the social layer (social/labels.ts): a hint, never proof. What gives a label and what doesn't, that a
 * label is never evidence for a wallet, that the shadow warning only writes its own private log while the copy goes on
 * unchanged, and that none of it reaches the dashboard snapshot, a public feed, the wallet page or the log feed.
 * In-memory database, fake executor: nothing reaches X or the chain.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { type DB, openDb } from "@godseye/shared";
import { buildDashboardSnapshot, getWalletDetail } from "@godseye/shared/dashboard-data";
import { publicView, type PublicFeed } from "@godseye/shared/public-view";
import type { ParsedSwap } from "../src/chain/parse";
import type { Executor, Fill } from "../src/copy/executor";
import { MINT } from "./helpers";

process.env.RUG_CHECK_ENABLED = "false";
process.env.COPY_BUDGET_SOL = "1";
process.env.COPY_MAX_TRADE_SOL = "0.1";
delete process.env.SOCIAL_WARNING;
const { CopyEngine } = await import("../src/copy/engine");
const { labelWallets, noteSocialWarning, socialLabelAt, socialWarningMode } = await import("../src/social/labels");
const { ensureSocialTables } = await import("../src/social/schema");

const LEADER = Keypair.generate().publicKey.toBase58();
const T0 = "2026-11-01T00:00:00.000Z";

function fresh(): DB {
  const db = openDb(":memory:");
  ensureSocialTables(db);
  return db;
}
const link = (db: DB, wallet: string, author: string, how: string, firstSeen = T0) =>
  db.prepare("INSERT INTO social_wallet_accounts (wallet, author_id, how, n, first_seen_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)").run(wallet, author, how, firstSeen, firstSeen);
const labelOf = (db: DB, wallet: string) =>
  db.prepare("SELECT label, accounts, since FROM social_wallet_labels WHERE wallet = ?").get(wallet) as { label: string; accounts: number; since: string } | undefined;
const socialTables = (db: DB) => (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'social%' ORDER BY name").all() as { name: string }[]).map((t) => t.name);
const warnings = (db: DB) =>
  socialTables(db).includes("social_warnings") ? db.prepare("SELECT leader_signature, mint, wallet, ts, seen_at, label, accounts, mode FROM social_warnings ORDER BY seen_at, leader_signature").all() : [];
const buyOf = (wallet: string, signature: string, ts = "2026-11-05T11:59:58.000Z") => ({ wallet, signature, mint: MINT, ts });

test("labels: a bio gives 'claimed', a post of the address gives 'named', timing alone gives nothing", () => {
  const db = fresh();
  link(db, "W_BIO", "a1", "bio");
  link(db, "W_TWEET", "a2", "tweet");
  link(db, "W_MENTION", "a3", "mention");
  link(db, "W_TIMING", "a4", "timing");
  link(db, "W_BOTH", "a5", "bio", "2026-11-03T00:00:00.000Z");
  link(db, "W_BOTH", "a6", "mention", "2026-11-02T00:00:00.000Z");
  link(db, "W_BOTH", "a7", "timing", "2026-10-01T00:00:00.000Z"); // timing counts for nothing: not an account, not a date

  assert.deepEqual(labelWallets(db), { claimed: 2, named: 2, changed: 4 });
  assert.deepEqual(labelOf(db, "W_BIO"), { label: "claimed", accounts: 1, since: T0 });
  assert.deepEqual(labelOf(db, "W_TWEET"), { label: "named", accounts: 1, since: T0 });
  assert.deepEqual(labelOf(db, "W_MENTION"), { label: "named", accounts: 1, since: T0 });
  assert.equal(labelOf(db, "W_TIMING"), undefined);
  assert.deepEqual(labelOf(db, "W_BOTH"), { label: "claimed", accounts: 2, since: "2026-11-02T00:00:00.000Z" });

  // Nothing new: a second run changes nothing.
  assert.deepEqual(labelWallets(db), { claimed: 2, named: 2, changed: 0 });
});

test("labels: named by many accounts is still only 'named'", () => {
  const db = fresh();
  for (let i = 0; i < 40; i++) link(db, "W", `a${i}`, i % 2 ? "mention" : "tweet");
  labelWallets(db);
  assert.deepEqual(labelOf(db, "W"), { label: "named", accounts: 40, since: T0 });
});

test("labels: 'since' keeps the earliest time, and a label is never lowered or removed", () => {
  const db = fresh();
  link(db, "W", "a1", "mention");
  labelWallets(db);
  assert.equal(socialLabelAt(db, "W", "2026-10-31T23:59:59.999Z"), null, "no label yet at that time");
  assert.deepEqual(socialLabelAt(db, "W", T0), { label: "named", accounts: 1, since: T0 });
  assert.equal(socialLabelAt(db, "NOBODY"), null);

  // The research re-files the link as a bio link and moves its first_seen_at forward (collect.ts syncLinks).
  db.prepare("UPDATE social_wallet_accounts SET how = 'bio', first_seen_at = '2026-11-09T00:00:00.000Z' WHERE wallet = 'W'").run();
  assert.equal(labelWallets(db).changed, 1);
  assert.deepEqual(labelOf(db, "W"), { label: "claimed", accounts: 1, since: T0 });

  // An earlier link turns up: since moves back, never forward.
  link(db, "W", "a2", "mention", "2026-10-20T00:00:00.000Z");
  labelWallets(db);
  assert.deepEqual(labelOf(db, "W"), { label: "claimed", accounts: 2, since: "2026-10-20T00:00:00.000Z" });

  // The bio link goes: still claimed. Every link goes: the label stays as it was.
  db.prepare("DELETE FROM social_wallet_accounts WHERE author_id = 'a1'").run();
  labelWallets(db);
  assert.deepEqual(labelOf(db, "W"), { label: "claimed", accounts: 1, since: "2026-10-20T00:00:00.000Z" });
  db.prepare("DELETE FROM social_wallet_accounts").run();
  assert.deepEqual(labelWallets(db), { claimed: 1, named: 0, changed: 0 });
  assert.deepEqual(labelOf(db, "W"), { label: "claimed", accounts: 1, since: "2026-10-20T00:00:00.000Z" });
});

test("SOCIAL_WARNING: off unless it says shadow, and there is no live mode", () => {
  const mode = (v?: string) => socialWarningMode({ SOCIAL_WARNING: v } as NodeJS.ProcessEnv);
  assert.equal(mode(undefined), "off");
  assert.equal(mode(""), "off");
  assert.equal(mode("off"), "off");
  assert.equal(mode("shadow"), "shadow");
  assert.equal(mode(" Shadow "), "shadow");
  for (const v of ["on", "live", "true", "1", "yes", "block", "shadow-on"]) assert.equal(mode(v), "off", v);
  assert.equal(socialWarningMode(), "off", "unset in the environment");
});

test("warning off: reads nothing, writes nothing, creates no table", () => {
  const db = openDb(":memory:");
  assert.equal(noteSocialWarning(db, buyOf("W", "sigA"), Date.now(), "off"), false);
  assert.equal(noteSocialWarning(db, buyOf("W", "sigA"), Date.now()), false, "the default mode is off");
  assert.deepEqual(socialTables(db), []);
});

test("warning in shadow: one private row per copyable buy by a labelled wallet, and only then", () => {
  const db = fresh();
  link(db, "W_NAMED", "a1", "mention");
  link(db, "W_LATER", "a2", "bio", "2026-11-10T00:00:00.000Z");
  labelWallets(db);
  const seenAt = Date.parse("2026-11-05T12:00:00.000Z");
  const buy = buyOf("W_NAMED", "sigA");

  assert.equal(noteSocialWarning(db, buy, seenAt, "shadow"), true);
  assert.equal(noteSocialWarning(db, buy, seenAt, "shadow"), false, "the same buy is logged once");
  assert.equal(noteSocialWarning(db, buyOf("W_PLAIN", "sigB"), seenAt, "shadow"), false, "no label, no row");
  assert.equal(noteSocialWarning(db, buyOf("W_LATER", "sigC"), seenAt, "shadow"), false, "labelled only after this buy was seen");
  assert.equal(noteSocialWarning(db, buyOf("W_LATER", "sigD", "2026-11-10T23:59:59.000Z"), Date.parse("2026-11-11T00:00:00.000Z"), "shadow"), true);

  assert.deepEqual(warnings(db), [
    { leader_signature: "sigA", mint: MINT, wallet: "W_NAMED", ts: "2026-11-05T11:59:58.000Z", seen_at: "2026-11-05T12:00:00.000Z", label: "named", accounts: 1, mode: "shadow" },
    { leader_signature: "sigD", mint: MINT, wallet: "W_LATER", ts: "2026-11-10T23:59:59.000Z", seen_at: "2026-11-11T00:00:00.000Z", label: "claimed", accounts: 1, mode: "shadow" },
  ]);
});

test("warning: a database problem is swallowed, never thrown at the copy", () => {
  const boom = () => {
    throw new Error("disk I/O error");
  };
  assert.equal(noteSocialWarning({ prepare: boom, exec: boom } as unknown as DB, buyOf("W", "sigA"), Date.now(), "shadow"), false);
  assert.equal(noteSocialWarning(fresh(), buyOf("W", "sigA"), Number.NaN, "shadow"), false, "a time that is no time");
});

class FakeExecutor implements Executor {
  mode = "paper" as const;
  calls: string[] = [];
  async buy(_mint: string, sol: number): Promise<Fill> {
    this.calls.push(`buy ${sol}`);
    return { signature: null, solAmount: sol, tokenAmount: sol * 1000, priceSol: 0.001 };
  }
  async sell(_mint: string, tokens: number): Promise<Fill> {
    this.calls.push(`sell ${tokens}`);
    return { signature: null, solAmount: tokens * 0.002, tokenAmount: tokens, priceSol: 0.002 };
  }
}

function setup(weight = 0.5) {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO wallets (address, first_seen_at, discovered_via, copy_weight) VALUES (?, ?, 'test', ?)").run(LEADER, new Date().toISOString(), weight);
  db.prepare("INSERT INTO token_info (mint, symbol, decimals, pool_created_at, checked_at) VALUES (?, 'MOO', 6, '2026-01-01T00:00:00Z', ?)").run(MINT, new Date().toISOString());
  const ex = new FakeExecutor();
  return { db, ex, engine: new CopyEngine(db, ex, null) };
}
const leaderSwap = (p: Partial<ParsedSwap>): ParsedSwap => ({
  wallet: LEADER, signature: "leader-buy-1", slot: 1, ts: new Date().toISOString(), mint: MINT, side: "buy",
  tokenAmount: 1000, tokenBalanceBefore: 0, solAmount: 1, priceSol: 0.001, venue: "jupiter", jitoTip: false, feeLamports: 5000, quote: "SOL", quoteAmount: 1, solUsd: null, usdAmount: null, ...p,
});

/** One leader buy through the real engine with SOCIAL_WARNING set to `mode` (unset when undefined). */
async function copyOnce(mode: string | undefined, how: string | null, prepare: (db: DB) => void = () => {}) {
  const { db, ex, engine } = setup();
  if (how) {
    ensureSocialTables(db);
    link(db, LEADER, "a1", how);
    labelWallets(db);
  }
  prepare(db);
  if (mode === undefined) delete process.env.SOCIAL_WARNING;
  else process.env.SOCIAL_WARNING = mode;
  try {
    await engine.onLeaderSwap(leaderSwap({}));
  } finally {
    delete process.env.SOCIAL_WARNING;
  }
  return {
    db,
    calls: ex.calls,
    trades: db.prepare("SELECT leader, leader_signature, mint, symbol, side, mode, status, reason, weight, size_sol, token_amount, price_sol, signature, error FROM copy_trades ORDER BY id").all(),
    positions: db.prepare("SELECT mint, symbol, leader, mode, status, token_amount, tokens_bought, cost_sol, entry_price_sol, exit_reason FROM positions ORDER BY id").all(),
    feed: db.prepare("SELECT level, message FROM agent_log ORDER BY id").all() as { level: string; message: string }[],
    leader: db.prepare("SELECT copy_weight, shadow_only FROM wallets WHERE address = ?").get(LEADER),
    warnings: warnings(db),
  };
}

test("engine: in shadow a labelled leader is copied exactly as before, and the buy gets one private row", async () => {
  const off = await copyOnce(undefined, "mention");
  const shadow = await copyOnce("shadow", "mention");

  assert.deepEqual(off.calls, ["buy 0.1"]);
  assert.equal(off.trades.length, 1);
  assert.equal(off.positions.length, 1);
  assert.deepEqual(off.warnings, []);

  assert.deepEqual(shadow.calls, off.calls);
  assert.deepEqual(shadow.trades, off.trades);
  assert.deepEqual(shadow.positions, off.positions);
  assert.deepEqual(shadow.leader, { copy_weight: 0.5, shadow_only: 0 });
  assert.deepEqual(
    shadow.feed.map((f) => f.level),
    off.feed.map((f) => f.level),
  );
  for (const { message } of shadow.feed) assert.doesNotMatch(message, /social|label|named|claimed|warning/i);

  assert.equal(shadow.warnings.length, 1);
  const { ts: _ts, seen_at: _seen, ...row } = shadow.warnings[0] as Record<string, unknown>;
  assert.deepEqual(row, { leader_signature: "leader-buy-1", mint: MINT, wallet: LEADER, label: "named", accounts: 1, mode: "shadow" });
});

test("engine: no setting lets the warning block a trade, off leaves no trace, and a broken social layer can't stop a copy", async () => {
  for (const mode of ["on", "live", "true", "1", "block"]) {
    const r = await copyOnce(mode, "bio");
    assert.deepEqual(r.calls, ["buy 0.1"], mode);
    assert.deepEqual(r.warnings, [], mode);
  }

  const plain = await copyOnce(undefined, null);
  assert.deepEqual(plain.calls, ["buy 0.1"]);
  assert.deepEqual(socialTables(plain.db), [], "off creates no social table");

  const unlabelled = await copyOnce("shadow", null);
  assert.deepEqual(unlabelled.calls, ["buy 0.1"]);
  assert.deepEqual(unlabelled.warnings, []);

  // The label table is gone (ensureSocialTables has already run for this connection, so it is not remade).
  const broken = await copyOnce("shadow", "bio", (db) => db.exec("DROP TABLE social_wallet_labels"));
  assert.deepEqual(broken.calls, ["buy 0.1"]);
  assert.equal(broken.positions.length, 1);
  assert.deepEqual(broken.warnings, []);
});

test("a label is never evidence for a wallet: labelling and the warning touch nothing outside their own two tables", () => {
  const { db } = setup();
  ensureSocialTables(db);
  link(db, LEADER, "a1", "bio");
  const state = () => ({
    wallet: db.prepare("SELECT * FROM wallets WHERE address = ?").get(LEADER),
    rows: Object.fromEntries(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite%' AND name NOT IN ('social_wallet_labels', 'social_warnings') ORDER BY name").all() as { name: string }[]).map(
        ({ name }) => [name, (db.prepare(`SELECT COUNT(*) n FROM "${name}"`).get() as { n: number }).n],
      ),
    ),
  });
  const before = state();

  assert.deepEqual(labelWallets(db), { claimed: 1, named: 0, changed: 1 });
  assert.equal(noteSocialWarning(db, buyOf(LEADER, "sigZ"), Date.now(), "shadow"), true);
  assert.deepEqual(state(), before);
});

function keys(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) for (const x of v) keys(x, out);
  else if (v && typeof v === "object")
    for (const [k, x] of Object.entries(v)) {
      out.push(k);
      keys(x, out);
    }
  return out;
}

test("HIDDEN: labels and the warning log reach no snapshot, public feed, wallet page or log feed", async () => {
  // Values no other part of the data could produce by accident.
  const SINCE = "2019-03-07T11:22:33.444Z";
  const UPDATED = "2019-04-08T10:20:30.404Z";
  const ACCOUNTS = 79193311;
  const r = await copyOnce("shadow", null, (db) => {
    ensureSocialTables(db);
    link(db, LEADER, "zz_hidden_author_q7", "bio", SINCE);
    db.prepare("INSERT INTO social_wallet_labels (wallet, label, accounts, since, updated_at) VALUES (?, 'claimed', ?, ?, ?)").run(LEADER, ACCOUNTS, SINCE, UPDATED);
  });
  const { db } = r;
  assert.deepEqual(r.calls, ["buy 0.1"]);
  assert.equal(r.warnings.length, 1, "there is a warning row to hide");
  assert.equal((r.warnings[0] as { accounts: number }).accounts, ACCOUNTS);

  const snap = buildDashboardSnapshot(db);
  const feedOf: Record<string, PublicFeed> = { live: "stream" };
  const pub: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(snap)) pub[k] = publicView(feedOf[k] ?? (k as PublicFeed), v);
  const detail = getWalletDetail(db, LEADER);
  const views = { snapshot: snap, public: pub, walletPage: detail, publicWalletPage: publicView("wallet", detail), logFeed: r.feed, copyTrades: db.prepare("SELECT * FROM copy_trades").all() };
  assert.ok(JSON.stringify(snap).includes(LEADER), "the leader itself is on the site, so its pages are worth checking");
  for (const [name, body] of Object.entries(views)) {
    const json = JSON.stringify(body);
    for (const secret of [SINCE, UPDATED, String(ACCOUNTS), '"claimed"', "zz_hidden_author_q7"]) assert.ok(!json.includes(secret), `${name} leaks ${secret}`);
    assert.doesNotMatch(json, /would have skipped|social_w/i, `${name} mentions the warning`);
    assert.deepEqual(
      keys(body).filter((k) => k.toLowerCase().startsWith("social")),
      [],
      `${name} has social keys`,
    );
  }
});
