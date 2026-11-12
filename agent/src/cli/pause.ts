/**
 * `npm run pause` / `npm run resume` — stop or restart new copy buys (sells and safety exits keep working).
 * Resuming after the agent paused itself at its drawdown limit also restarts its high from today's value (copy/risk.ts):
 * otherwise the next look would pause it again.
 */
import { getMeta, openDb, setMeta } from "@godseye/shared";
import { RESET_HIGH_KEY } from "../copy/risk";

const db = openDb();
const pause = process.argv[2] !== "resume";
const by = getMeta(db, "copy_paused_by");
setMeta(db, "copy_paused", pause ? "1" : "0");
setMeta(db, "copy_paused_by", pause ? "owner" : "");
if (!pause && by === "drawdown") setMeta(db, RESET_HIGH_KEY, "1");
console.log(pause
  ? "Copying PAUSED. GodsEye won't open new positions; it still follows leaders' sells and its own stop-losses. `npm run resume` to continue."
  : `Copying RESUMED (unless a file named data/PAUSE exists).${by === "drawdown" ? " It had paused itself at its drawdown limit: its high starts again from today's value." : by === "outflow" ? " It had paused itself because SOL left the wallet unexplained." : ""}`);
