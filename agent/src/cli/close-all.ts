/**
 * `npm run close-all` — sell every open position now, at the stop-loss's widening slippage, and take the token accounts'
 * rent back. Run it with the agent stopped (the two would both try to sell the same coins); pause copying first
 * (`npm run pause`) so the restarted agent doesn't buy again.
 */
import { openDb } from "@godseye/shared";
import { config } from "../config";
import { CopyEngine } from "../copy/engine";
import { PaperExecutor, RealExecutor } from "../copy/executor";
import { loadOrCreateWallet } from "../wallet/wallet";

const db = openDb();
const { keypair } = loadOrCreateWallet(db);
const real = config.copyMode === "real" ? new RealExecutor(keypair) : null;
const engine = new CopyEngine(db, real ?? new PaperExecutor(), keypair.publicKey, null, null);
const { closed, left } = await engine.closeAll("closed by owner");
const rent = real ? await real.reclaimRent().catch(() => 0) : 0;
console.log(`Closed ${closed} position(s)${left ? `, ${left} still open (sells failed, see above)` : ""}.${rent > 0 ? ` Took back ${rent.toFixed(4)} SOL of rent.` : ""}`);
db.close();
process.exit(left ? 1 : 0);
