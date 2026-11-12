/**
 * The rug screen: liquidity locks, transfer hooks, and failing closed when part of the look is missing (RugCheck
 * silent, no pool data, holders unread). Stubbed fetch and an in-memory database: nothing reaches the network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { openDb } from "@godseye/shared";
import { config } from "../src/config";
import { judgeRugRisk, lockedLiquidityPct, rugCheck, rugLook, type RugCheckSummary, type RugVerdict, type Screen, unfinished, UNFINISHED_TEXT } from "../src/market/rugcheck";
import { stubFetch } from "./helpers";

const clean = { mintAuthority: null, freezeAuthority: null, extensions: [] };
const opts = { blockMintAuthority: true, maxRiskScore: 75, allowlist: [] as string[], minLockedPct: 90 };
const pool = (marketType: string, lpLockedPct: number, usd: number) => ({ marketType, lp: { lpLockedPct, quoteUSD: usd / 2, baseUSD: usd / 2 } });
const report = (markets: RugCheckSummary["markets"]): RugCheckSummary => ({ score_normalised: 10, risks: [], markets });
const locked = report([pool("pump_fun_amm", 100, 1_000)]);
const someKey = () => Keypair.generate().publicKey.toBase58();

test("liquidity: pump.fun coins (curve or burned LP) pass", () => {
  const v = judgeRugRisk("MINT", clean, report([pool("pump_fun_amm", 100, 0.000001)]), opts);
  assert.equal(v.verdict, "pass");
  assert.equal(v.unchecked, undefined);
});

test("liquidity: a coin whose pools can be pulled is blocked", () => {
  const v = judgeRugRisk("MINT", clean, report([pool("raydium", 0, 50_000)]), opts);
  assert.equal(v.verdict, "blocked");
  assert.match(v.blocks.join(), /liquidity not locked: only 0% /);
});

test("liquidity: weighted by each pool's dollars, so a big unlocked pool outweighs a small locked one", () => {
  const rc = report([pool("pump_fun_amm", 100, 1_000), pool("meteoraDlmm", 0, 99_000)]);
  assert.equal(Math.round(lockedLiquidityPct(rc)!), 1);
  assert.equal(judgeRugRisk("MINT", clean, rc, opts).verdict, "blocked");
  const mostlyLocked = report([pool("raydium", 100, 95_000), pool("meteoraDlmm", 0, 5_000)]);
  assert.equal(lockedLiquidityPct(mostlyLocked), 95);
  assert.equal(judgeRugRisk("MINT", clean, mostlyLocked, opts).verdict, "pass");
});

test("liquidity: no pool data leaves the look unfinished; the rule can be turned off; trusted coins are exempt", () => {
  const unknown = judgeRugRisk("MINT", clean, report([]), opts);
  assert.equal(unknown.verdict, "pass");
  assert.ok(unknown.warnings.some((w) => /liquidity lock unknown/.test(w)));
  assert.equal(unknown.unchecked, "lock_unknown");
  assert.equal(judgeRugRisk("MINT", clean, report([]), { ...opts, minLockedPct: 0 }).unchecked, undefined);
  assert.equal(judgeRugRisk("MINT", clean, report([]), { ...opts, allowlist: ["MINT"] }).unchecked, undefined);
  assert.equal(lockedLiquidityPct(null), null);
  const unlocked = report([pool("orca", 0, 10_000)]);
  assert.equal(judgeRugRisk("MINT", clean, unlocked, { ...opts, minLockedPct: 0 }).verdict, "pass");
  assert.equal(judgeRugRisk("MINT", clean, unlocked, { ...opts, allowlist: ["MINT"] }).verdict, "pass");
});

test("transfer hook: blocked with a program or while one can still be set; an empty leftover passes; trusted coins are exempt", () => {
  const hook = (state: Record<string, unknown>) => ({ ...clean, extensions: [{ extension: "transferHook", state }] });
  const withProgram = judgeRugRisk("MINT", hook({ programId: someKey(), authority: null }), locked, opts);
  assert.equal(withProgram.verdict, "blocked");
  assert.match(withProgram.blocks.join(), /transfer hook runs custom code/);
  const authorityOnly = judgeRugRisk("MINT", hook({ programId: null, authority: someKey() }), locked, opts);
  assert.equal(authorityOnly.verdict, "blocked");
  assert.match(authorityOnly.blocks.join(), /can still be added/);
  assert.equal(judgeRugRisk("MINT", hook({ programId: null, authority: null }), locked, opts).verdict, "pass");
  assert.equal(judgeRugRisk("MINT", hook({ programId: someKey(), authority: null }), locked, { ...opts, allowlist: ["MINT"] }).verdict, "pass");
});

test("RugCheck silent: a clean coin is unfinished, a block on Solana's facts still stands; the setting and the allowlist lift it", () => {
  const silent = judgeRugRisk("MINT", clean, null, opts);
  assert.equal(silent.verdict, "pass");
  assert.equal(silent.unchecked, "rugcheck_down");
  assert.ok(silent.warnings.some((w) => /RugCheck unavailable/.test(w)));
  const frozen = judgeRugRisk("MINT", { ...clean, freezeAuthority: someKey() }, null, opts);
  assert.equal(frozen.verdict, "blocked");
  assert.equal(judgeRugRisk("MINT", clean, null, { ...opts, requireRugcheck: false }).unchecked, undefined);
  assert.equal(judgeRugRisk("MINT", clean, null, { ...opts, allowlist: ["MINT"] }).unchecked, undefined);
});

test("unfinished: what a look missed, in plain words; a block needs nothing more", () => {
  const pass: RugVerdict = { verdict: "pass", blocks: [], warnings: [], rugcheckScore: 10 };
  const screen = (over: Partial<Screen>): Screen => ({ onchain: clean, rc: null, holders: null, holdersStatus: "off", verdict: pass, chainMs: 0, rugcheckMs: 0, holdersMs: null, ...over });
  assert.equal(unfinished(screen({ onchain: null, verdict: null })), "chain_unreadable");
  assert.equal(unfinished(screen({ holdersStatus: "failed" })), "holders_failed");
  assert.equal(unfinished(screen({ holdersStatus: "timeout" })), "holders_timeout");
  assert.equal(unfinished(screen({ verdict: { ...pass, unchecked: "rugcheck_down" } })), "rugcheck_down");
  assert.equal(unfinished(screen({ verdict: { ...pass, unchecked: "lock_unknown" } })), "lock_unknown");
  assert.equal(unfinished(screen({ verdict: { ...pass, verdict: "blocked", blocks: ["x"], unchecked: "rugcheck_down" } })), null);
  assert.equal(unfinished(screen({})), null);
  for (const text of Object.values(UNFINISHED_TEXT)) assert.ok(text.length > 10 && !/[1-9A-HJ-NP-Za-km-z]{32,}/.test(text));
});

/** Answers the RPC's mint read with `onchain` and RugCheck's report URL with `rc` (a Response, an object, or a thrown error). */
function chain(onchain: Record<string, unknown>, rc: () => Response | object) {
  return stubFetch((url) => {
    if (url.startsWith("https://api.rugcheck.xyz/")) return rc();
    return { jsonrpc: "2.0", id: 1, result: { value: { owner: "TokenProgram", data: { parsed: { info: { mintAuthority: null, freezeAuthority: null, extensions: [], ...onchain } } } } } };
  });
}
const rows = (db: ReturnType<typeof openDb>, mint: string) => (db.prepare("SELECT COUNT(*) n FROM rug_checks WHERE mint = ?").get(mint) as { n: number }).n;

test("rugLook: RugCheck down, erroring or without a score gives no verdict and keeps nothing", async () => {
  const holders = config.holderCheckEnabled;
  config.holderCheckEnabled = false;
  const answers: (() => Response | object)[] = [
    () => new Response("down", { status: 500 }),
    () => {
      throw new Error("connection reset");
    },
    () => ({ risks: [], markets: [] }),
  ];
  try {
    for (const answer of answers) {
      const db = openDb(":memory:");
      const mint = someKey();
      const net = chain({}, answer);
      try {
        assert.deepEqual(await rugLook(db, mint, "MOO"), { verdict: null, why: "rugcheck_down" });
        assert.equal(await rugCheck(db, mint, "MOO"), null);
        assert.equal(rows(db, mint), 0, "an unfinished look is not kept");
      } finally {
        net.restore();
      }
    }
  } finally {
    config.holderCheckEnabled = holders;
  }
});

test("rugLook: a block found with RugCheck silent is kept; a full pass is cached and not asked again", async () => {
  const holders = config.holderCheckEnabled;
  config.holderCheckEnabled = false;
  try {
    const db = openDb(":memory:");
    const frozen = someKey();
    let net = chain({ freezeAuthority: someKey() }, () => new Response("down", { status: 503 }));
    try {
      const look = await rugLook(db, frozen, "ICE");
      assert.equal(look.verdict?.verdict, "blocked");
      assert.equal(look.why, null);
      assert.equal(rows(db, frozen), 1);
    } finally {
      net.restore();
    }

    const good = someKey();
    net = chain({}, () => locked);
    try {
      const look = await rugLook(db, good, "OK");
      assert.equal(look.verdict?.verdict, "pass");
      const asked = net.calls.length;
      assert.equal((await rugCheck(db, good, "OK"))?.verdict, "pass");
      assert.equal(net.calls.length, asked, "served from the cache");
    } finally {
      net.restore();
    }
  } finally {
    config.holderCheckEnabled = holders;
  }
});
