/**
 * Routine compression of old raw swaps.
 *
 * wallet_swaps is the biggest table by far (about 1 KB a row with its indexes, millions of rows a day). Swaps older than
 * the hot window move out of the database into gzip-compressed NDJSON, one file per UTC day of the swap
 * (<dir>/wallet_swaps/YYYY-MM-DD.ndjson.gz, every column of the row), and are deleted from the table. SQLite reuses the
 * freed pages, so the database file stops growing; the archive is roughly a tenth of the size.
 *
 * Nothing is lost: closed_trades keeps every round trip (it is never pruned), and `npm run archive -- restore` reads
 * archived days back into a separate database for research.
 *
 * Kept in the database:
 *   • every wallet's last hotDays (wallet stats and the quant job look back 30 days)
 *   • junk wallets' last junkHotDays (bots and copy-replay rejects: never copied, and re-read rarely)
 *   • every swap of a wallet GodsEye copies or holds an open position from (live P&L and exits read them)
 *
 * Each step writes and fsyncs the compressed rows before deleting them, so a crash in between can only leave a row in
 * both places (the restore skips duplicates), never in neither. Files grow by appending gzip members, which every gzip
 * reader treats as one stream.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import type { DB } from "./db";

export interface ArchiveOptions {
  dir: string;
  hotDays: number;
  junkHotDays: number;
  /** Rows per step. */
  batch?: number;
  now?: number;
}

export interface ArchiveStep {
  rows: number;
  /** Nothing more to archive right now. */
  done: boolean;
}

type Row = Record<string, unknown> & { id: number; ts: string };

const PROTECTED = `wallet NOT IN (SELECT address FROM wallets WHERE copy_weight > 0)
  AND wallet NOT IN (SELECT leader FROM positions WHERE status = 'open' AND leader IS NOT NULL)`;

export const archiveFile = (dir: string, day: string): string => path.join(dir, "wallet_swaps", `${day}.ndjson.gz`);

/** Compress and append rows (grouped by UTC day), fsync, then delete them from wallet_swaps. */
function moveOut(db: DB, dir: string, rows: Row[]): void {
  if (!rows.length) return;
  fs.mkdirSync(path.join(dir, "wallet_swaps"), { recursive: true });
  const byDay = new Map<string, string[]>();
  for (const r of rows) {
    const day = r.ts.slice(0, 10);
    (byDay.get(day) ?? byDay.set(day, []).get(day)!).push(JSON.stringify(r));
  }
  for (const [day, lines] of byDay) {
    const fd = fs.openSync(archiveFile(dir, day), "a");
    try {
      fs.writeSync(fd, zlib.gzipSync(`${lines.join("\n")}\n`, { level: 6 }));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }
  const del = db.prepare("DELETE FROM wallet_swaps WHERE id = ?");
  db.transaction(() => rows.forEach((r) => del.run(r.id)))();
}

/**
 * One slice of archiving: up to `batch` rows, oldest first. Past the hot window (everyone) first, then junk wallets'
 * rows past their shorter window. Call until `done`.
 */
export function archiveSwapsStep(db: DB, opts: ArchiveOptions): ArchiveStep {
  const now = opts.now ?? Date.now();
  const batch = opts.batch ?? 5000;
  const hotBefore = new Date(now - opts.hotDays * 86_400_000).toISOString();
  let rows = db.prepare(`SELECT * FROM wallet_swaps WHERE ts < ? AND ${PROTECTED} ORDER BY ts LIMIT ?`).all(hotBefore, batch) as Row[];
  if (!rows.length && opts.junkHotDays > 0 && opts.junkHotDays < opts.hotDays) {
    const junkBefore = new Date(now - opts.junkHotDays * 86_400_000).toISOString();
    // Per junk wallet, on (wallet, ts): scanning by ts alone would walk every normal wallet's rows in the window.
    const junk = db.prepare(
      `SELECT w.address FROM wallets w WHERE w.junk_reason IS NOT NULL AND w.copy_weight <= 0
         AND EXISTS (SELECT 1 FROM wallet_swaps s WHERE s.wallet = w.address AND s.ts < ?) LIMIT 50`,
    ).all(junkBefore) as { address: string }[];
    const take = db.prepare(`SELECT * FROM wallet_swaps WHERE wallet = ? AND ts < ? AND ${PROTECTED} ORDER BY ts LIMIT ?`);
    rows = [];
    for (const { address } of junk) {
      rows.push(...(take.all(address, junkBefore, batch - rows.length) as Row[]));
      if (rows.length >= batch) break;
    }
  }
  moveOut(db, opts.dir, rows);
  return { rows: rows.length, done: rows.length === 0 };
}

/** Archived days on disk, oldest first, with compressed size in bytes. */
export function archivedDays(dir: string): { day: string; bytes: number }[] {
  const d = path.join(dir, "wallet_swaps");
  if (!fs.existsSync(d)) return [];
  return fs
    .readdirSync(d)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.ndjson\.gz$/.test(f))
    .sort()
    .map((f) => ({ day: f.slice(0, 10), bytes: fs.statSync(path.join(d, f)).size }));
}

/** Every archived row of one day (duplicates from an interrupted step included; callers dedupe on signature, wallet, mint). */
export function readArchivedDay(dir: string, day: string): Row[] {
  const file = archiveFile(dir, day);
  if (!fs.existsSync(file)) return [];
  return zlib
    .gunzipSync(fs.readFileSync(file))
    .toString("utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Row);
}

/** Put archived days back into a wallet_swaps table (a research copy, usually): duplicates are skipped. Returns rows inserted. */
export function restoreDays(db: DB, dir: string, days: string[]): number {
  const cols = (db.prepare("PRAGMA table_info(wallet_swaps)").all() as { name: string }[]).map((c) => c.name).filter((c) => c !== "id");
  const insert = db.prepare(`INSERT OR IGNORE INTO wallet_swaps (${cols.join(", ")}) VALUES (${cols.map((c) => `@${c}`).join(", ")})`);
  let n = 0;
  for (const day of days) {
    const rows = readArchivedDay(dir, day);
    db.transaction(() => {
      for (const r of rows) n += insert.run(Object.fromEntries(cols.map((c) => [c, r[c] ?? null]))).changes;
    })();
  }
  return n;
}
