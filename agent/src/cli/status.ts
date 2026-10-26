/** `npm run status` — a quick health check of GodsEye from the database. */
import { getMeta, openDb } from "@godseye/shared";
import { getSummary } from "@godseye/shared/dashboard-data";

const db = openDb();
const s = getSummary(db);
const wr = s.winRate;
console.log(`GodsEye is ${s.live ? "LIVE 🟢" : "OFFLINE 🔴"} (last heartbeat ${s.heartbeat ?? "never"}) · copy mode ${(s.copyMode ?? "unknown").toUpperCase()}${s.paused ? " · PAUSED" : ""}`);
console.log(`   Wallet: ${s.wallet.pubkey ?? "not created yet (run npm run wallet)"}${s.wallet.balanceSol !== null ? ` · ${s.wallet.balanceSol.toFixed(4)} SOL` : ""}`);
console.log(`   Copy results: ${s.closedPositions} closed · win rate ${wr === null ? "—" : (wr * 100).toFixed(1) + "%"} · realized ${s.realizedPnlSol.toFixed(4)} SOL · open ${s.openPositions}/${s.maxPositions} (${s.unrealizedPnlSol.toFixed(4)} SOL unrealized)`);
console.log(`   Wallet database: ${s.walletsTracked} wallets · copying ${s.leaders} · fresh in last 24h ${s.freshWallets24h}`);
console.log(`   Tiers: ${Object.entries(s.tierCounts).map(([t, n]) => `${t.replace("_", " ")} ${n}`).join(" · ")}`);
console.log(`   AI/bot ${s.kindCounts.ai} · human ${s.kindCounts.human} · undecided ${s.kindCounts.unknown}`);
const leaders = db.prepare("SELECT address, copy_weight, weight_reason FROM wallets WHERE copy_weight > 0 ORDER BY copy_weight DESC LIMIT 10").all() as { address: string; copy_weight: number; weight_reason: string }[];
for (const l of leaders) console.log(`     ${(l.copy_weight * 100).toFixed(0).padStart(3)}%  ${l.address}  ${l.weight_reason}`);
console.log(`   Last discovery ${getMeta(db, "last_discovery_at") ?? "never"} · last learning ${getMeta(db, "last_learning_at") ?? "never"}`);
