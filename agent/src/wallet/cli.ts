/** `npm run wallet` — shows (or creates) GodsEye's wallet address and balance. */
import { openDb, setMeta } from "@godseye/shared";
import { loadOrCreateWallet, walletBalanceSol, walletFile } from "./wallet";

const db = openDb();
// The owner asked for the wallet, so this command may make one in any mode (the agent itself never does in real mode).
const { keypair, created } = loadOrCreateWallet(db, false);
console.log(created ? "New GodsEye wallet created!" : "GodsEye wallet:");
console.log(`   Address (public, safe to share): ${keypair.publicKey.toBase58()}`);
console.log(`   Secret key file (NEVER share):   ${walletFile()}`);
try {
  const bal = await walletBalanceSol(keypair.publicKey);
  setMeta(db, "wallet_balance_sol", bal);
  console.log(`   On-chain balance: ${bal} SOL`);
} catch (e) {
  console.log(`   (Couldn't read balance: ${(e as Error).message})`);
}
