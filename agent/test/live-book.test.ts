import { test } from "node:test";
import assert from "node:assert/strict";
import { LiveBook } from "../src/stream/live-book";
import type { ParsedSwap } from "../src/chain/parse";

const swap = (wallet: string, i: number, side: "buy" | "sell" = "buy"): ParsedSwap => ({
  wallet, signature: `sig-${wallet}-${i}`, slot: i, ts: new Date(Date.parse("2026-10-20T00:00:00Z") + i * 1000).toISOString(), mint: "M", side,
  tokenAmount: 100, tokenBalanceBefore: 0, solAmount: 1, priceSol: 0.01, quote: "SOL", quoteAmount: 1, solUsd: 150, usdAmount: 150, venue: "pumpswap", jitoTip: false, feeLamports: 5000,
});

test("live book: unchanged wallets aren't rescored or rewritten; trades are capped and carry no signature", () => {
  const book = new LiveBook({ maxWallets: 1000, idleMs: 3_600_000, earlyBuySeconds: 600 });
  book.record(swap("quiet", 1));
  book.rescore();
  assert.equal(book.takeDirty().length, 1); // new swap: saved once
  book.rescore();
  assert.equal(book.takeDirty().length, 0); // nothing new: not rewritten every flush
  for (let i = 0; i < 100; i++) book.record(swap("busy", i, i % 2 ? "sell" : "buy"));
  const w = book.get("busy")!;
  assert.equal(w.recent.length, 60);
  assert.ok(w.recent.every((s) => s.signature === ""));
});

test("live book: shrinking drops the least active but never wallets queued for analysis", () => {
  const book = new LiveBook({ maxWallets: 1000, idleMs: 3_600_000, earlyBuySeconds: 600 });
  for (let i = 0; i < 10; i++) book.record(swap(`w${i}`, i));
  book.get("w0")!.promoted = true; // least active, but queued
  for (let i = 0; i < 5; i++) book.record(swap("w9", 100 + i));
  book.takeDirty();
  assert.equal(book.shrinkTo(3), 7);
  assert.ok(book.get("w0"), "promoted wallet kept");
  assert.ok(book.get("w9"), "most active kept");
});
