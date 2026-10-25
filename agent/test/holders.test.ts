import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import type { TxLike } from "../src/chain/parse";
import { insiderPctFromReport, judgeHolders, poolBuys, type HolderMetrics } from "../src/market/holders";

const MINT = "Mint111111111111111111111111111111111111111";
const wallet = () => Keypair.generate().publicKey.toBase58(); // on-curve: a person or bot
const pool = PublicKey.findProgramAddressSync([Buffer.from("bonding-curve")], new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"))[0].toBase58(); // off-curve
const bal = (accountIndex: number, owner: string, tokens: number) => ({ accountIndex, mint: MINT, owner, uiTokenAmount: { amount: String(tokens * 1e6), decimals: 6 } });
const tx = (pre: ReturnType<typeof bal>[], post: ReturnType<typeof bal>[]): TxLike =>
  ({ slot: 1, meta: { err: null, fee: 5000, preBalances: [], postBalances: [], preTokenBalances: pre, postTokenBalances: post }, transaction: { signatures: ["s"], message: { accountKeys: [], instructions: [] } } }) as unknown as TxLike;

test("bundle measure: tokens minted to the deployer don't count, buys out of a pool do", () => {
  const deployer = wallet();
  // creation: the whole supply minted to the deployer, no pool paid anything
  assert.equal(poolBuys(tx([], [bal(1, deployer, 1_000_000_000)]), MINT).size, 0);
  // two wallets buy 100M and 35M out of the curve in one bundle
  const a = wallet(), b = wallet();
  const bought = poolBuys(tx([bal(1, pool, 800_000_000)], [bal(1, pool, 665_000_000), bal(2, a, 100_000_000), bal(3, b, 35_000_000)]), MINT);
  assert.equal(Math.round(bought.get(a)!), 100_000_000);
  assert.equal(Math.round(bought.get(b)!), 35_000_000);
});

const base: HolderMetrics = { launchBundlePct: 5, launchBuyers: 2, clusterPct: 4, clusterSize: 2, clusterFromCreator: false, top10Pct: 30, insiderPct: null };
const limits = { bundleMaxPct: 25, clusterMaxPct: 15, top10MaxPct: 50, insiderMaxPct: 20 };

test("holder check: a healthy spread passes; bundles, clusters, concentration and insider networks block", () => {
  assert.deepEqual(judgeHolders(base, limits), []);
  assert.match(judgeHolders({ ...base, launchBundlePct: 40, launchBuyers: 6 }, limits)[0], /bundled launch: 40% .* by 6 wallets/);
  assert.match(judgeHolders({ ...base, clusterPct: 22, clusterSize: 4 }, limits)[0], /4 top holders with one funder hold 22%/);
  assert.match(judgeHolders({ ...base, clusterPct: 18, clusterSize: 1, clusterFromCreator: true }, limits)[0], /funded by the coin's creator hold 18%/);
  assert.match(judgeHolders({ ...base, top10Pct: 70 }, limits)[0], /top 10 holders hold 70%/);
  assert.match(judgeHolders({ ...base, insiderPct: 35 }, limits)[0], /insider network holds 35%/);
  // a single wallet with its own funder is not a cluster; an unmeasurable launch isn't a block
  assert.deepEqual(judgeHolders({ ...base, clusterPct: 30, clusterSize: 1 }, limits), []);
  assert.deepEqual(judgeHolders({ ...base, launchBundlePct: null }, limits), []);
});

test("RugCheck insider networks become a share of supply", () => {
  assert.equal(insiderPctFromReport({ insiderNetworks: [{ currentHolding: 150 }, { currentHolding: 50 }], token: { supply: 1000 } }), 20);
  assert.equal(insiderPctFromReport({ insiderNetworks: [], token: { supply: 1000 } }), null);
  assert.equal(insiderPctFromReport(null), null);
});
