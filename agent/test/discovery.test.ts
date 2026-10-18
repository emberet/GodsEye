import { test } from "node:test";
import assert from "node:assert/strict";
import { memecoinPoolKind } from "../src/discovery/discover";

const SOL = "So11111111111111111111111111111111111111112";
const p = (symbol: string, quoteSymbol: string, quoteMint = "x") => ({ symbol, quoteSymbol, quoteMint });

test("discovery reads memecoin/SOL and memecoin/memecoin pools only", () => {
  assert.equal(memecoinPoolKind(p("BONK", "SOL", SOL)), "sol");
  assert.equal(memecoinPoolKind(p("MOODENG", "WSOL")), "sol");
  assert.equal(memecoinPoolKind(p("FARTCOIN", "PNUT")), "meme");
  assert.equal(memecoinPoolKind(p("SOL", "USDC")), null);
  assert.equal(memecoinPoolKind(p("BONK", "USDC")), null);
  assert.equal(memecoinPoolKind(p("JitoSOL", "SOL", SOL)), null);
  assert.equal(memecoinPoolKind(p("cbBTC", "SOL", SOL)), null);
});
