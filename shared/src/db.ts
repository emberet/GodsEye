/** Opens the shared SQLite database (data/godseye.db by default). */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { repoRoot } from "./env";
import { SCHEMA_SQL } from "./schema";

export type DB = Database.Database;

export function dbFilePath(): string {
  const custom = process.env.GODSEYE_DB_PATH?.trim();
  if (custom) return path.resolve(repoRoot(), custom);
  const file = path.join(repoRoot(), "data", "godseye.db");
  // Databases from before the GodsEye rename are picked up as they are.
  const legacy = path.join(repoRoot(), "data", "copycow.db");
  return !fs.existsSync(file) && fs.existsSync(legacy) ? legacy : file;
}

export function openDb(file = dbFilePath()): DB {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL"); // lets the dashboard read while the agent writes
  db.pragma("busy_timeout = 5000");
  db.exec(SCHEMA_SQL);
  migrate(db);
  return db;
}

/** Columns added after a table was first created (CREATE TABLE IF NOT EXISTS won't add them). */
const ADDED_COLUMNS: Record<string, Record<string, string>> = {
  wallets: { tx_per_hour: "REAL" },
};

function migrate(db: DB): void {
  for (const [table, cols] of Object.entries(ADDED_COLUMNS)) {
    const have = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
    for (const [col, def] of Object.entries(cols)) if (!have.has(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
  }
}

export const nowIso = (): string => new Date().toISOString();

export function getMeta(db: DB, key: string): string | null {
  const row = db.prepare("SELECT value FROM agent_meta WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setMeta(db: DB, key: string, value: string | number): void {
  db.prepare(
    `INSERT INTO agent_meta (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, String(value), nowIso());
}
