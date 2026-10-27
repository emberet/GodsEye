import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db";
import { commitProof, verifyProofChain, type ProofEntry } from "../src/proof";
import { filterWallets, getAllWalletRows, getLeaders, getLiveWallets, getSmartMoney, getSummary, getWalletDetail, getWalletGroups } from "../src/dashboard-data";

function seed() {
  const db = openDb(":memory:");
  const now = new Date().toISOString();
  const add = db.prepare("INSERT INTO wallets (address, first_seen_at, discovered_via, tier, kind, ai_score, copy_weight, is_fresh, funder, chain_created_at, last_analyzed_at) VALUES (?, ?, 'test', ?, ?, ?, ?, ?, ?, ?, ?)");
  add.run("AAA", now, "proven", "human", 20, 0.6, 0, null, null, now);
  add.run("BBB", now, "insider", "ai", 90, 0.4, 1, "FUND", now, now);
  add.run("CCC", now, "quitter", "ai", 80, 0, 1, "FUND", now, now);
  const stat = db.prepare("INSERT INTO wallet_stats (wallet, computed_at, swaps_total, swaps_7d, swaps_30d, pnl_7d_sol, pnl_30d_sol, pnl_all_sol, pnl_7d_usd, pnl_30d_usd, closed_7d, closed_30d, wins_30d) VALUES (?, ?, 10, 5, 10, ?, ?, ?, ?, ?, 2, 5, 3)");
  // Sorting and P&L use the USD columns (each trade valued when it settled).
  stat.run("AAA", now, 1, 5, 5, 100, 500);
  stat.run("BBB", now, 2, 9, 9, 200, 900);
  stat.run("CCC", now, -1, -2, -2, -100, -200);
  db.prepare("INSERT INTO wallet_evidence (wallet, kind, detail, mint, signature, ts) VALUES ('BBB', 'early_entry', 'Bought MOO early', 'M', '', ?)").run(now);
  db.prepare("INSERT INTO agent_meta (key, value, updated_at) VALUES ('wallet_pubkey', 'COW', ?)").run(now);
  return db;
}

test("wallet database: filter by tier / kind / fresh / search, sorted by 30d P&L", () => {
  const rows = getAllWalletRows(seed());
  assert.deepEqual(filterWallets(rows, {}).rows.map((r) => r.address), ["BBB", "AAA", "CCC"]);
  assert.deepEqual(filterWallets(rows, { tier: "insider" }).rows.map((r) => r.address), ["BBB"]);
  assert.deepEqual(filterWallets(rows, { kind: "ai", fresh: true }).rows.map((r) => r.address).sort(), ["BBB", "CCC"]);
  assert.equal(filterWallets(rows, { q: "fund" }).total, 2);
  assert.deepEqual(filterWallets(rows, { copied: true, sort: "weight" }).rows.map((r) => r.address), ["AAA", "BBB"]);
  assert.equal(filterWallets(rows, { limit: 1, offset: 1 }).rows[0].address, "AAA");
});

test("summary, wallet page, groups and leaders", () => {
  const db = seed();
  const s = getSummary(db);
  assert.equal(s.walletsTracked, 3);
  assert.equal(s.leaders, 2);
  assert.equal(s.tierCounts.insider, 1);
  assert.equal(s.kindCounts.ai, 2);
  const d = getWalletDetail(db, "BBB")!;
  assert.equal(d.wallet.group_size, 2);
  assert.equal(d.group[0].address, "CCC");
  assert.equal(d.evidence[0].signature, null);
  const g = getWalletGroups(db);
  assert.equal(g[0].funder, "FUND");
  assert.equal(g[0].size, 2);
  assert.equal(g[0].ai, 2);
  assert.equal(getLeaders(db).leaders[0].address, "AAA");
  assert.equal(getWalletDetail(db, "nope"), null);
});

test("proof ledger detects tampering", () => {
  const db = openDb(":memory:");
  commitProof(db, "copy_buy", { mint: "A" });
  commitProof(db, "copy_sell", { mint: "A" });
  const entries = db.prepare("SELECT * FROM proof_ledger ORDER BY id").all() as ProofEntry[];
  assert.equal(verifyProofChain(entries).ok, true);
  entries[0].payload = entries[0].payload.replace("copy_buy", "copy_sel");
  assert.equal(verifyProofChain(entries).ok, false);
});

test("public log lines hide IP addresses, keys in URLs and local paths", async () => {
  const { redactLog } = await import("../src/dashboard-data");
  assert.equal(
    redactLog("Live stream error: client IP 103.51.148.168 is not whitelisted"),
    "Live stream error: client IP [IP hidden] is not whitelisted",
  );
  assert.equal(redactLog("GET https://rpc.example?api_key=abc123&x=1"), "GET https://rpc.example?api_key=[hidden]&x=1");
  assert.equal(redactLog("failed at /Users/someone/GodsEye/agent"), "failed at ~/GodsEye/agent");
  assert.equal(redactLog("Bought 2.5 SOL of PUMP, +$1,234"), "Bought 2.5 SOL of PUMP, +$1,234");
});

test("public dashboard: bots and wallets copying lost on are left out of every list and count", () => {
  const db = openDb(":memory:");
  const now = new Date().toISOString();
  const add = (a: string, junk: string | null) => {
    db.prepare("INSERT INTO wallets (address, first_seen_at, discovered_via, tier, funder, junk_reason) VALUES (?, ?, 'test', 'proven', 'FUNDER', ?)").run(a, now, junk);
    db.prepare("INSERT INTO wallet_activity (address, first_seen_at, last_seen_at, swaps, buys, sells, volume_sol) VALUES (?, ?, ?, 1, 1, 0, 1)").run(a, now, now);
    db.prepare("INSERT INTO smart_wallets (address, source, active, reason, updated_at) VALUES (?, 'analyzed', 0, ?, ?)").run(a, junk ?? "no longer qualifies", now);
  };
  add("GOOD", null);
  add("GOOD2", null);
  add("BOT", "bot: median hold 8 s (under 15 s can't be copied)");
  add("LOSER", "copy replay: copying it 5 s late made a median −3.0% per copy (20 copies)");
  const shown = (rows: { address: string }[]) => rows.map((r) => r.address).sort();
  const good = ["GOOD", "GOOD2"];
  assert.deepEqual(shown(getAllWalletRows(db)), good);
  assert.equal(getSummary(db).walletsTracked, 2);
  assert.equal(getSummary(db).tierCounts.proven, 2);
  assert.deepEqual(shown(getLiveWallets(db)), good);
  assert.equal(getWalletGroups(db)[0].size, 2);
  assert.deepEqual(shown(getWalletGroups(db)[0].members), good);
  assert.deepEqual(shown(getSmartMoney(db).wallets), good);
});
