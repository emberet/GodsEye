/**
 * Publishes the dashboard's data to Turso so the website can run on Vercel
 * (Vercel can't see this computer's database file). Skipped entirely unless
 * TURSO_DATABASE_URL is set. Never stops GodsEye if Turso is unreachable.
 * Wallet pages are published only when GodsEye re-analyzed that wallet.
 */
import { type DB } from "@godseye/shared";
import { buildDashboardSnapshot, getWalletDetail } from "@godseye/shared/dashboard-data";
import { snapshotStoreConfigured, walletKey, writeSnapshot } from "@godseye/shared/snapshot-store";
import { dirtyWallets } from "../analysis/analyze";
import { say } from "../log";

let lastPublish = 0;
let lastWarn = 0;

export async function publishSnapshot(db: DB, opts: { force?: boolean } = {}): Promise<boolean> {
  if (!snapshotStoreConfigured()) return false;
  if (!opts.force && Date.now() - lastPublish < 60_000) return false;
  const pages = [...dirtyWallets];
  try {
    const data = buildDashboardSnapshot(db);
    for (const a of pages) {
      const detail = getWalletDetail(db, a);
      if (detail) data[walletKey(a)] = detail;
    }
    await writeSnapshot(data);
    for (const a of pages) dirtyWallets.delete(a);
    lastPublish = Date.now();
    return true;
  } catch (e) {
    if (Date.now() - lastWarn > 3_600_000) {
      lastWarn = Date.now();
      say("warn", `Couldn't publish dashboard data to Turso (${(e as Error).message.slice(0, 140)}). The website will show older data until this works.`);
    }
    return false;
  }
}
