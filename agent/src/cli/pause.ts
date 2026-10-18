/** `npm run pause` / `npm run resume` — stop or restart new copy buys (sells and safety exits keep working). */
import { openDb, setMeta } from "@godseye/shared";

const db = openDb();
const pause = process.argv[2] !== "resume";
setMeta(db, "copy_paused", pause ? "1" : "0");
console.log(pause
  ? "Copying PAUSED. GodsEye won't open new positions; it still follows leaders' sells and its own stop-losses. `npm run resume` to continue."
  : "Copying RESUMED (unless a file named data/PAUSE exists).");
