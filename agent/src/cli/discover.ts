/** `npm run discover` — find new wallets once and exit. */
import { openDb } from "@godseye/shared";
import { attachLogDb } from "../log";
import { runDiscovery } from "../discovery/discover";

const db = openDb();
attachLogDb(db);
await runDiscovery(db);
db.close();
