/**
 * `npm run backfill:closed`  rebuild closed_trades from every stored swap (safe to rerun: upserts only).
 * The agent does this once on its own at startup; this is for a manual refresh.
 */
import { openDb } from "@godseye/shared";
import { config } from "../config";
import { backfillClosedTrades } from "../analysis/closed-trades";

const db = openDb();
const t = Date.now();
const r = backfillClosedTrades(db, config.earlyBuySeconds, { force: true });
console.log(`closed_trades: ${r.trades.toLocaleString("en-US")} round trips for ${r.wallets.toLocaleString("en-US")} wallets in ${((Date.now() - t) / 1000).toFixed(1)}s.`);
db.close();
