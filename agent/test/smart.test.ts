import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "@godseye/shared";
import type { ParsedSwap } from "../src/chain/parse";
import { detectSignal, leadStats, returnPct, SmartMoney } from "../src/smart/smart-money";

const cfg = { wallets: 3, windowMinutes: 60, minUsd: 500 };
const T = Date.parse("2026-10-19T00:00:00Z");
const ev = (min: number, wallet: string, side: "buy" | "sell", usd: number) => ({ ts: T + min * 60_000, wallet, side, usd });

test("signal: 3 smart wallets buying the same token within an hour", () => {
  const s = detectSignal([ev(0, "a", "buy", 200), ev(10, "b", "buy", 300), ev(20, "c", "buy", 400)], T + 25 * 60_000, cfg)!;
  assert.equal(s.kind, "accumulate");
  assert.deepEqual(s.wallets.sort(), ["a", "b", "c"]);
  assert.equal(s.usd, 900);
});

test("signal: not enough wallets, too little money, or spread over too long → nothing", () => {
  assert.equal(detectSignal([ev(0, "a", "buy", 900), ev(1, "a", "buy", 900), ev(2, "b", "buy", 900)], T + 3 * 60_000, cfg), null);
  assert.equal(detectSignal([ev(0, "a", "buy", 100), ev(1, "b", "buy", 100), ev(2, "c", "buy", 100)], T + 3 * 60_000, cfg), null);
  assert.equal(detectSignal([ev(0, "a", "buy", 400), ev(30, "b", "buy", 400), ev(90, "c", "buy", 400)], T + 91 * 60_000, cfg), null);
});

test("signal: a wallet that bought and sold nets out; three dumping is an exit", () => {
  const s = detectSignal([ev(0, "a", "sell", 300), ev(5, "b", "sell", 300), ev(9, "c", "sell", 300)], T + 10 * 60_000, cfg)!;
  assert.equal(s.kind, "exit");
  assert.equal(detectSignal([ev(0, "a", "buy", 300), ev(1, "a", "sell", 300), ev(2, "b", "buy", 300), ev(3, "c", "buy", 300)], T + 4 * 60_000, cfg), null);
});

test("lead stats and returns", () => {
  assert.deepEqual(leadStats([10, -5, 30, 20]), { n: 4, hitRate: 0.75, median: 15 });
  assert.equal(returnPct(2, 3), 50);
  assert.equal(returnPct(null, 3), null);
});

const swap = (wallet: string, side: "buy" | "sell", usd: number, priceUsd: number, i: number): ParsedSwap => ({
  wallet, signature: `sig${i}`, slot: i, ts: new Date(T + i * 60_000).toISOString(), mint: "MEME", side,
  tokenAmount: usd / priceUsd, tokenBalanceBefore: 0, solAmount: usd / 100, priceSol: priceUsd / 100, quote: "SOL", quoteAmount: usd / 100,
  solUsd: 100, usdAmount: usd, venue: "pumpswap", jitoTip: false, feeLamports: 5000,
});

test("end to end: smart wallets converge → signal → price measured 1h later → learning", () => {
  const db = openDb(":memory:");
  const now = new Date().toISOString();
  for (const w of ["A", "B", "C", "D"]) {
    db.prepare("INSERT INTO wallets (address, first_seen_at, discovered_via, tier) VALUES (?, ?, 'test', 'proven')").run(w, now);
    db.prepare("INSERT INTO wallet_stats (wallet, computed_at, swaps_total, swaps_7d, swaps_30d, pnl_7d_sol, pnl_30d_sol, pnl_all_sol, pnl_30d_usd, closed_7d, closed_30d, wins_30d, win_rate_30d) VALUES (?, ?, 40, 10, 40, 1, 5, 5, 500, 5, 20, 12, 0.6)").run(w, now);
  }
  const sm = new SmartMoney(db, null);
  assert.equal(sm.refresh().active, 4);

  // Three smart wallets buy MEME at $1 within minutes
  sm.onSwap(swap("A", "buy", 300, 1, 0), T);
  sm.onSwap(swap("B", "buy", 300, 1, 1), T + 60_000);
  sm.onSwap(swap("C", "buy", 300, 1, 2), T + 120_000);
  sm.flush(T + 120_000);
  const sig = db.prepare("SELECT * FROM smart_signals").get() as { kind: string; wallet_count: number; usd: number };
  assert.equal(sig.kind, "accumulate");
  assert.equal(sig.wallet_count, 3);
  assert.equal((db.prepare("SELECT COUNT(*) n FROM smart_flows").get() as { n: number }).n, 3);

  // An hour later someone trades it at $1.50 → +50%
  sm.onSwap(swap("someone", "buy", 50, 1.5, 70), T + 70 * 60_000);
  assert.ok(sm.evaluate(T + 70 * 60_000) >= 1);
  const measured = db.prepare("SELECT ret_1h FROM smart_signals").get() as { ret_1h: number };
  assert.ok(Math.abs(measured.ret_1h - 50) < 1e-9, `ret ${measured.ret_1h}`);
});

test("learning: a wallet whose buys keep dropping stops counting as smart money", () => {
  const db = openDb(":memory:");
  const now = new Date().toISOString();
  db.prepare("INSERT INTO wallets (address, first_seen_at, discovered_via, tier) VALUES ('TOPS', ?, 'test', 'proven')").run(now);
  db.prepare("INSERT INTO wallet_stats (wallet, computed_at, swaps_total, swaps_7d, swaps_30d, pnl_7d_sol, pnl_30d_sol, pnl_all_sol, pnl_30d_usd, closed_7d, closed_30d, wins_30d, win_rate_30d) VALUES ('TOPS', ?, 40, 10, 40, 1, 5, 5, 500, 5, 20, 12, 0.6)").run(now);
  for (let i = 0; i < 12; i++) {
    db.prepare("INSERT INTO smart_flows (signature, ts, wallet, mint, side, usd, price_usd, ret_6h, checked) VALUES (?, ?, 'TOPS', ?, 'buy', 100, 1, -40, 7)").run(`s${i}`, now, `M${i}`);
  }
  const sm = new SmartMoney(db, null);
  assert.equal(sm.refresh().active, 0);
  const row = db.prepare("SELECT active, reason, lead_n, lead_median_6h FROM smart_wallets").get() as { active: number; reason: string; lead_n: number; lead_median_6h: number };
  assert.equal(row.active, 0);
  assert.equal(row.lead_n, 12);
  assert.match(row.reason, /follows, doesn't lead/);
});

test("non-memecoins never count as smart money: skipped when known, purged once named", () => {
  const db = openDb(":memory:");
  const now = new Date().toISOString();
  for (const w of ["A", "B", "C"]) {
    db.prepare("INSERT INTO wallets (address, first_seen_at, discovered_via, tier) VALUES (?, ?, 'test', 'proven')").run(w, now);
    db.prepare("INSERT INTO wallet_stats (wallet, computed_at, swaps_total, swaps_7d, swaps_30d, pnl_7d_sol, pnl_30d_sol, pnl_all_sol, pnl_30d_usd, closed_7d, closed_30d, wins_30d, win_rate_30d) VALUES (?, ?, 40, 10, 40, 1, 5, 5, 500, 5, 20, 12, 0.6)").run(w, now);
  }
  const named = (mint: string, symbol: string) => db.prepare("INSERT INTO token_info (mint, symbol, checked_at) VALUES (?, ?, ?)").run(mint, symbol, now);
  const sm = new SmartMoney(db, null);
  sm.refresh();
  const on = (wallet: string, mint: string, i: number) => sm.onSwap({ ...swap(wallet, "buy", 300, 1, i), mint }, T + i * 60_000);

  // Already known as a tokenized stock → never recorded, no signal
  named("AVGO", "AVGOx");
  on("A", "AVGO", 0);
  on("B", "AVGO", 1);
  on("C", "AVGO", 2);
  // Not named yet when bought, turns out to be wrapped Monero
  on("A", "WXMR", 3);
  on("B", "WXMR", 4);
  on("C", "WXMR", 5);
  // A real memecoin
  on("A", "MEME", 6);
  sm.flush(T + 6 * 60_000);
  const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  assert.equal(count("SELECT COUNT(*) n FROM smart_flows WHERE mint = 'AVGO'"), 0);
  assert.equal(count("SELECT COUNT(*) n FROM smart_flows WHERE mint = 'WXMR'"), 3);
  assert.equal(count("SELECT COUNT(*) n FROM smart_signals WHERE mint = 'WXMR'"), 1);

  named("WXMR", "wXMR");
  sm.refresh();
  assert.equal(count("SELECT COUNT(*) n FROM smart_flows WHERE mint = 'WXMR'"), 0);
  assert.equal(count("SELECT COUNT(*) n FROM smart_signals"), 0);
  assert.equal(count("SELECT COUNT(*) n FROM smart_flows WHERE mint = 'MEME'"), 1);
});
