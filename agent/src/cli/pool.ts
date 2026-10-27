/**
 * `npm run pool -- <token mint>` — what a token's contract and its pools look like, straight from chain.
 *
 *   npm run pool -- <mint>          the mint's contract (program, authorities, extensions, transfer fee) and the pools a 0.1 SOL
 *                                   buy would go through (found with a Jupiter quote), with reserves, price and exit capacity
 *   npm run pool -- <mint> --size 0.5   quote a different size
 *   npm run pool -- --pool <address>    read one pool account directly
 *
 * Read-only: public RPC and Jupiter quote reads, nothing is written. Code: src/pools/, src/market/mint-profile.ts.
 */
import { SOL_MINT } from "@godseye/shared";
import { jupiterQuote } from "../market/jupiter";
import { feeInForce, profileMint } from "../market/mint-profile";
import { readMint } from "../market/rugcheck";
import { exitCapacity, readPools, type PoolView } from "../pools/state";
import { tradeTraits } from "../market/mint-profile";

const args = process.argv.slice(2);
const flag = (n: string): string | undefined => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const size = Number(flag("size") ?? 0.1);
const poolArg = flag("pool");
const mint = args.find((a, i) => !a.startsWith("--") && !["--size", "--pool"].includes(args[i - 1] ?? ""));
if (!mint && !poolArg) {
  console.log("Usage: npm run pool -- <token mint> [--size 0.1]   or   npm run pool -- --pool <pool address>");
  process.exit(0);
}

const sol = (n: number | null) => (n === null ? "—" : n >= 100 ? n.toFixed(0) : n >= 1 ? n.toFixed(2) : n.toPrecision(2));
function show(v: PoolView | { address: string; unreadable: string }, label?: string | null) {
  if ("unreadable" in v) return console.log(`  ${label ?? "pool"} ${v.address}\n    not read: ${v.unreadable}`);
  console.log(`  ${label ?? v.family}  ${v.address}  [${v.family}]${v.closed ? "  CLOSED (migrated, completed or disabled)" : ""}`);
  console.log(`    holds ${sol(v.quoteReserve)} ${v.quoteIsSol ? "SOL" : "of a non-SOL quote"}; prices against ${sol(v.quoteEffective)}; price ${v.price === null ? "—" : v.price.toExponential(3)} per token`);
  if (v.quoteIsSol) console.log(`    SOL that can be sold in before the price falls:  10% → ${sol(exitCapacity(v, 10))}   20% → ${sol(exitCapacity(v, 20))}   50% → ${sol(exitCapacity(v, 50))}`);
  for (const n of v.notes) console.log(`    note: ${n}`);
}

if (poolArg) {
  console.log("POOL");
  for (const v of await readPools([poolArg])) show(v);
} else if (mint) {
  const onchain = await readMint(mint).catch((e: Error) => {
    console.log(`Couldn't read the mint: ${e.message}`);
    return null;
  });
  if (onchain) {
    const p = profileMint(onchain);
    console.log(`TOKEN CONTRACT  ${mint}`);
    console.log(`  token program: ${p.program}${p.extensions.length ? `   extensions: ${p.extensions.join(", ")}` : ""}`);
    console.log(`  mint authority: ${p.mintAuthority ?? "none"}   freeze authority: ${p.freezeAuthority ?? "none"}`);
    if (p.transferFee) {
      const f = feeInForce(p.transferFee);
      console.log(`  transfer fee: ${(f.bps / 100).toFixed(2)}% on every transfer (cap ${f.maximumFee} raw units)   can change it: ${p.transferFee.configAuthority ?? "nobody"}`);
    }
    if (p.transferHook) console.log(`  transfer hook program: ${p.transferHook}`);
    if (p.permanentDelegate) console.log(`  permanent delegate: ${p.permanentDelegate}`);
    for (const t of tradeTraits(p)) console.log(`  ${t.severity === "block" ? "BLOCKS" : "warns"}: ${t.text}`);
  }
  console.log(`\nPOOLS a ${size} SOL buy goes through (Jupiter route)`);
  const q = await jupiterQuote(SOL_MINT, mint, BigInt(Math.floor(size * 1e9)), 300, 0).catch((e: Error) => {
    console.log(`  no route: ${e.message.slice(0, 120)}`);
    return null;
  });
  const hops = (q?.routePlan ?? []).map((h) => h.swapInfo).filter((h) => h.ammKey && h.outputMint === mint);
  if (q && !hops.length) console.log("  the route has no pool that outputs this token directly");
  if (hops.length) {
    const views = await readPools(hops.map((h) => h.ammKey as string));
    views.forEach((v, i) => show(v, hops[i].label));
    console.log(`\n  price impact Jupiter reports for ${size} SOL: ${(Number(q!.priceImpactPct) * 100).toFixed(3)}%`);
  }
}
