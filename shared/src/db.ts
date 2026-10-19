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
  wallets: { tx_per_hour: "REAL", history_from: "TEXT", history_oldest_sig: "TEXT", history_tx_read: "INTEGER NOT NULL DEFAULT 0", history_done: "INTEGER NOT NULL DEFAULT 0" },
  wallet_swaps: { quote: "TEXT NOT NULL DEFAULT 'SOL'", quote_amount: "REAL", sol_usd: "REAL", usd_amount: "REAL" },
  token_info: { pool_address: "TEXT", launch_checked_at: "TEXT" },
  wallet_stats: { pnl_7d_usd: "REAL", pnl_30d_usd: "REAL", pnl_all_usd: "REAL", avg_buy_usd: "REAL" },
  positions: { cost_usd: "REAL", proceeds_usd: "REAL NOT NULL DEFAULT 0", pnl_usd: "REAL", leader_win_rate: "REAL" },
  wallet_activity: { live_pnl_usd: "REAL NOT NULL DEFAULT 0" },
  smart_flows: { wallet_win_rate: "REAL" },
};

/** Run once, right after a column first appears. */
const AFTER_ADDING: Record<string, string> = {
  // USDC/USDT-priced swaps used to be skipped: re-read every wallet's recent history once to pick them up.
  "wallet_swaps.quote": "UPDATE wallets SET last_signature = NULL",
  // The old "sold before crash" rule compared with today's price and flagged normal memecoin decay:
  // drop its evidence and re-check every wallet it tagged with the stricter candle-based rule.
  // Value every stored swap in USD at the time it settled (dollar amount for USDC/USDT, SOL × that hour's price for SOL).
  "wallet_swaps.usd_amount": `UPDATE wallet_swaps SET
      sol_usd = COALESCE(sol_usd, (SELECT usd FROM sol_price_hourly WHERE hour = (CAST(strftime('%s', wallet_swaps.ts) AS INTEGER) / 3600) * 3600)),
      usd_amount = CASE WHEN quote IN ('USDC', 'USDT') THEN quote_amount
        ELSE sol_amount * COALESCE(sol_usd, (SELECT usd FROM sol_price_hourly WHERE hour = (CAST(strftime('%s', wallet_swaps.ts) AS INTEGER) / 3600) * 3600)) END`,
  // Stats only cover the transactions GodsEye read (the latest HISTORY_TX_LIMIT on first look, then everything newer),
  // which is often a day or two, not 30 days. Record where each wallet's history starts, and stop the reasons claiming 30 days.
  "wallets.history_from": `UPDATE wallets SET history_from = (SELECT MIN(ts) FROM wallet_swaps s WHERE s.wallet = wallets.address) WHERE last_analyzed_at IS NOT NULL;
    UPDATE wallets SET tier_reason = REPLACE(REPLACE(REPLACE(tier_reason, ' closed trades in 30 days', ' closed trades seen so far'), 'of the 30-day profit', 'of its profit'), ' over 30 days', ' so far') WHERE tier_reason IS NOT NULL;
    UPDATE wallets SET weight_reason = REPLACE(weight_reason, ' closed trades in 30 days', ' closed trades seen so far') WHERE weight_reason IS NOT NULL`,
  // Wallets studied before history was read by days had at most 300 transactions read: deepen them from there.
  "wallets.history_done": "UPDATE wallets SET history_tx_read = 300 WHERE last_analyzed_at IS NOT NULL",
  // Every token row so far came from a GeckoTerminal launch lookup (names now come from Shyft separately).
  "token_info.launch_checked_at": "UPDATE token_info SET launch_checked_at = checked_at",
  "token_info.pool_address":
    "DELETE FROM wallet_evidence WHERE kind = 'sold_before_crash'; UPDATE wallets SET last_analyzed_at = '2000-01-01T00:00:00.000Z' WHERE tier = 'insider'",
};

function migrate(db: DB): void {
  for (const [table, cols] of Object.entries(ADDED_COLUMNS)) {
    const have = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
    for (const [col, def] of Object.entries(cols)) {
      if (have.has(col)) continue;
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
      const after = AFTER_ADDING[`${table}.${col}`];
      if (after) db.exec(after);
    }
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
