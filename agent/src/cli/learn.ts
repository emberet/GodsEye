/** `npm run learn` — run the learning loop once and show who GodsEye would copy. */
import { openDb } from "@godseye/shared";
import { attachLogDb } from "../log";
import { copyCandidates, runLearning } from "../learning/loop";
import { refreshCopyable } from "../learning/copyable";
import { initSolPrices } from "../market/solprice";

const db = openDb();
attachLogDb(db);
await initSolPrices(db);
await refreshCopyable(db, copyCandidates(db));
runLearning(db);
const rows = db.prepare("SELECT address, copy_weight, weight_reason FROM wallets WHERE copy_weight > 0 ORDER BY copy_weight DESC").all() as { address: string; copy_weight: number; weight_reason: string }[];
for (const r of rows) console.log(`${(r.copy_weight * 100).toFixed(1).padStart(5)}%  ${r.address}  ${r.weight_reason}`);
db.close();
