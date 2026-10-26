import "server-only";
import { openDbReadonly, type DB } from "@godseye/shared/db";

// One read-only connection per server process (survives hot reloads in dev). The website never writes:
// the agent owns the database, its schema and its migrations.
const g = globalThis as unknown as { __godseyeDb?: DB };
export function db(): DB {
  if (!g.__godseyeDb) g.__godseyeDb = openDbReadonly();
  return g.__godseyeDb;
}
