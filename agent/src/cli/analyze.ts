/**
 * `npm run analyze`            — analyze the next batch of wallets and exit
 * `npm run analyze -- <addr>`  — add a wallet (if new) and analyze it now
 */
import { PublicKey } from "@solana/web3.js";
import { openDb } from "@godseye/shared";
import { getWalletDetail } from "@godseye/shared/dashboard-data";
import { attachLogDb } from "../log";
import { analyzeWallet, runAnalysis } from "../analysis/analyze";
import { addWallet } from "../discovery/discover";
import { initSolPrices } from "../market/solprice";

const db = openDb();
attachLogDb(db);
await initSolPrices(db);
const addr = process.argv[2];
if (addr) {
  try {
    new PublicKey(addr);
  } catch {
    console.error(`"${addr}" is not a Solana address.`);
    process.exit(1);
  }
  addWallet(db, addr, "manual", "added with npm run analyze");
  await analyzeWallet(db, addr);
  const d = getWalletDetail(db, addr)!;
  console.log(`\n${addr}`);
  console.log(`  tier: ${d.wallet.tier} — ${d.wallet.tier_reason}`);
  console.log(`  kind: ${d.wallet.kind} (score ${d.wallet.ai_score ?? "—"})`);
  for (const r of d.kindReasons) console.log(`     ${r.points >= 0 ? "+" : ""}${r.points}  ${r.reason}`);
  if (d.stats) console.log(`  swaps ${d.stats.swaps_total} · 7d ${d.stats.pnl_7d_sol.toFixed(3)} SOL · 30d ${d.stats.pnl_30d_sol.toFixed(3)} SOL · closed 30d ${d.stats.closed_30d} · wins ${d.stats.win_rate_30d === null ? "—" : Math.round(d.stats.win_rate_30d * 100) + "%"}`);
  console.log(`  created ${d.wallet.chain_created_at ?? "?"}${d.wallet.age_is_lower_bound ? " (or earlier)" : ""} · fresh ${d.wallet.is_fresh ? "yes" : "no"} · funder ${d.wallet.funder ?? "?"}`);
  for (const e of d.evidence) console.log(`  evidence: ${e.detail}`);
} else {
  await runAnalysis(db);
}
db.close();
