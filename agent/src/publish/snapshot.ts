/**
 * Publishes the dashboard's data to Turso so the website can run on Vercel
 * (Vercel can't see this computer's database file). Skipped entirely unless
 * TURSO_DATABASE_URL is set. Never stops GodsEye if Turso is unreachable.
 * Wallet pages are published only when GodsEye re-analyzed that wallet.
 * Only the public view of the data is sent (see shared/src/public-view.ts).
 */
import { type DB } from "@godseye/shared";
import { buildDashboardSnapshot, getWalletDetail, ownWallet } from "@godseye/shared/dashboard-data";
import { snapshotStoreConfigured, walletKey, writeSnapshot } from "@godseye/shared/snapshot-store";
import { dirtyWallets } from "../analysis/analyze";
import { say } from "../log";

let lastPublish = 0;
let lastWarn = 0;
/** Pages an older version published with the agent's own transactions in them are sent again once, in public form. */
let republished = false;

/** Wallets whose page lists copies the agent made of them. */
const copiedLeaders = (db: DB): string[] =>
  (db.prepare("SELECT DISTINCT leader FROM copy_trades WHERE signature IS NOT NULL").all() as { leader: string }[]).map((r) => r.leader);

export async function publishSnapshot(db: DB, opts: { force?: boolean } = {}): Promise<boolean> {
  if (!snapshotStoreConfigured()) return false;
  if (!opts.force && Date.now() - lastPublish < 60_000) return false;
  const pages = [...dirtyWallets];
  try {
    const data = buildDashboardSnapshot(db);
    for (const a of new Set(republished ? pages : [...pages, ...copiedLeaders(db)])) {
      const detail = getWalletDetail(db, a);
      if (detail) data[walletKey(a)] = detail;
    }
    await writeSnapshot(data, ownWallet(db));
    republished = true;
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
