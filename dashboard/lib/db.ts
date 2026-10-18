import "server-only";
import { openDb, type DB } from "@godseye/shared/db";

// One connection per server process (survives hot reloads in dev).
const g = globalThis as unknown as { __godseyeDb?: DB };
export function db(): DB {
  if (!g.__godseyeDb) g.__godseyeDb = openDb();
  return g.__godseyeDb;
}
