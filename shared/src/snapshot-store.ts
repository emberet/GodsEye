/**
 * PUBLISHED DASHBOARD DATA (for hosting the website on Vercel).
 *
 * Vercel can't see GodsEye's local database file, so GodsEye publishes a
 * ready-made copy of every dashboard feed to a free Turso database, and the
 * website reads those copies:
 *     GodsEye ──writes──▶ Turso (table dashboard_snapshot) ◀──reads── Vercel site
 * The website only needs a READ-ONLY Turso token.
 * Only the public view of each feed is sent (public-view.ts): what Turso holds is never more than the site may show.
 *
 * Keys: one per feed ("summary", "wallets", …) plus one per wallet page
 * ("wallet:<address>"), written whenever GodsEye re-analyzes that wallet.
 *
 * Settings (both in .env for GodsEye, and in Vercel → Project → Environment Variables):
 *   TURSO_DATABASE_URL  e.g. libsql://godseye-yourname.turso.io
 *   TURSO_AUTH_TOKEN    full-access token for GodsEye, read-only token for Vercel
 */
import { createClient, type Client } from "@libsql/client";
import { publicView, type PublicFeed } from "./public-view";

export const SNAPSHOT_KEYS = ["summary", "wallets", "groups", "leaders", "copies", "performance", "proof", "logs", "rugchecks", "live", "smart", "runners", "paper"] as const;
export type FeedKey = (typeof SNAPSHOT_KEYS)[number];
export type SnapshotKey = FeedKey | `wallet:${string}`;

export const walletKey = (address: string): SnapshotKey => `wallet:${address}`;

export function snapshotStoreConfigured(): boolean {
  return !!process.env.TURSO_DATABASE_URL?.trim();
}

let client: Client | null = null;
function store(): Client {
  if (!client) {
    client = createClient({
      url: process.env.TURSO_DATABASE_URL!.trim(),
      authToken: process.env.TURSO_AUTH_TOKEN?.trim() || undefined,
    });
  }
  return client;
}

const CREATE = `CREATE TABLE IF NOT EXISTS dashboard_snapshot (key TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at TEXT NOT NULL)`;
const UPSERT = "INSERT INTO dashboard_snapshot (key, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at";

const isFeedKey = (key: string): key is FeedKey => (SNAPSHOT_KEYS as readonly string[]).includes(key);
const feedOf = (key: FeedKey): PublicFeed => (key === "live" ? "stream" : key);

/**
 * What may leave this machine: each feed and wallet page reduced to its public view. A key that is not a known feed
 * is dropped, and so is the page of the agent's own wallet (`ownWallet`).
 */
export function publicSnapshot(data: Record<string, unknown>, ownWallet: string | null = null): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (key.startsWith("wallet:")) {
      if (!ownWallet || key !== walletKey(ownWallet)) out[key] = publicView("wallet", value, ownWallet);
    } else if (isFeedKey(key)) {
      out[key] = publicView(feedOf(key), value, ownWallet);
    }
  }
  return out;
}

/** GodsEye: publish many keys in one go, each as its public view. A page of the agent's own wallet left by an older version is removed. */
export async function writeSnapshot(data: Record<string, unknown>, ownWallet: string | null = null): Promise<void> {
  const now = new Date().toISOString();
  const entries = Object.entries(publicSnapshot(data, ownWallet));
  const cleanup = ownWallet ? [{ sql: "DELETE FROM dashboard_snapshot WHERE key = ?", args: [walletKey(ownWallet)] }] : [];
  // Turso batches are best kept modest; wallet pages can be numerous.
  for (let i = 0; i < Math.max(1, entries.length); i += 200) {
    await store().batch(
      [CREATE, ...(i === 0 ? cleanup : []), ...entries.slice(i, i + 200).map(([key, value]) => ({ sql: UPSERT, args: [key, JSON.stringify(value), now] }))],
      "write",
    );
  }
}

/** Website: read one key. Returns null if GodsEye hasn't published it yet. */
export async function readSnapshot<T>(key: SnapshotKey): Promise<{ data: T; updatedAt: string } | null> {
  try {
    const res = await store().execute({ sql: "SELECT json, updated_at FROM dashboard_snapshot WHERE key = ?", args: [key] });
    const row = res.rows[0];
    if (!row) return null;
    return { data: JSON.parse(String(row.json)) as T, updatedAt: String(row.updated_at) };
  } catch (e) {
    // Table not created yet = nothing published yet.
    if (/no such table/i.test(String((e as Error).message))) return null;
    throw e;
  }
}
