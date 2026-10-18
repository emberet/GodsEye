/** `npm run publish-dashboard` — push the dashboard data to Turso once (for checking your setup). */
import { openDb } from "@godseye/shared";
import { snapshotStoreConfigured } from "@godseye/shared/snapshot-store";
import "../config";
import { publishSnapshot } from "./snapshot";

if (!snapshotStoreConfigured()) {
  console.log("TURSO_DATABASE_URL isn't set in .env — nothing to publish to. See README → 'Host the website on Vercel'.");
  process.exit(1);
}
const ok = await publishSnapshot(openDb(), { force: true });
console.log(ok ? "Dashboard data published to Turso. Your Vercel site will show it within ~15 seconds." : "❌ Publishing failed (see the message above).");
process.exit(ok ? 0 : 1);
