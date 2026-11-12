/**
 * Tables of the PRIVATE social layer (social/): X accounts tied to wallets, their posts, and the social score the brain
 * reads. Created here, not in the shared schema, and never read by anything that publishes (dashboard data, the
 * snapshot, the public API, the agent_log feed). Only the owner's `npm run social` and the brain read them; the copy
 * engine reads the labels for one thing, to write down a "would have skipped" row (social/labels.ts), never to change a trade.
 *
 * POINT IN TIME: the social model learns from past copy decisions, so a feature may only use what was known then.
 *   - social_accounts holds only the latest profile; social_account_snapshots keeps every profile read (filter on fetched_at);
 *   - social_posts' likes … impressions are as read at fetched_at and never updated (filter on ts and fetched_at, or
 *     use fetched_at − ts as the age they were measured at);
 *   - social_wallet_accounts.first_seen_at is when the link became known (kept on every later update).
 */
import type { DB } from "@godseye/shared";

const SQL = `
CREATE TABLE IF NOT EXISTS social_accounts (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  name TEXT,
  followers INTEGER,
  following INTEGER,
  tweets INTEGER,
  listed INTEGER,
  created_at TEXT,
  description TEXT,
  verified INTEGER,
  -- When the profile was last read (lookups and mention searches) and, apart, when its posts were last read.
  fetched_at TEXT NOT NULL,
  timeline_at TEXT
);

-- Every profile read, append-only: followers etc. as they were at fetched_at.
CREATE TABLE IF NOT EXISTS social_account_snapshots (
  account_id TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  followers INTEGER,
  following INTEGER,
  tweets INTEGER,
  listed INTEGER,
  verified INTEGER,
  PRIMARY KEY (account_id, fetched_at)
);

-- Posts by linked accounts and posts mentioning a wallet; mints and wallets are the addresses found in the text (JSON arrays).
-- Engagement is as read at fetched_at, never updated.
CREATE TABLE IF NOT EXISTS social_posts (
  id INTEGER PRIMARY KEY,
  post_id TEXT NOT NULL UNIQUE,
  author_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  text TEXT NOT NULL,
  likes INTEGER, reposts INTEGER, replies INTEGER, quotes INTEGER, impressions INTEGER,
  mints TEXT NOT NULL DEFAULT '[]',
  wallets TEXT NOT NULL DEFAULT '[]',
  fetched_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_social_posts_author ON social_posts(author_id, ts);

-- A wallet tied to an account: how = bio · tweet · timing (from the runner research's x_wallet_links) or mention (the
-- account posted the address); n = how many times; first_seen_at = when the link became known (never moved later).
CREATE TABLE IF NOT EXISTS social_wallet_accounts (
  wallet TEXT NOT NULL,
  author_id TEXT NOT NULL,
  how TEXT NOT NULL,
  n INTEGER NOT NULL,
  first_seen_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (wallet, author_id)
);
CREATE INDEX IF NOT EXISTS idx_social_wallet_accounts_author ON social_wallet_accounts(author_id);

-- The social model's score per wallet (written hourly by the server, read by the brain's entry features).
CREATE TABLE IF NOT EXISTS social_scores (
  wallet TEXT PRIMARY KEY,
  score REAL,
  n_posts INTEGER,
  model_version TEXT,
  updated_at TEXT
);

-- When the collector last looked a wallet up on X (each is revisited about weekly).
CREATE TABLE IF NOT EXISTS social_visits (
  wallet TEXT PRIMARY KEY,
  visited_at TEXT NOT NULL,
  mentions INTEGER NOT NULL DEFAULT 0
);

-- A wallet whose mention count or search failed: left out of the queue until retry_at, later after each failure in a
-- row. The row goes when a visit is recorded. (social_visits is not touched: its time is where the next search starts.)
CREATE TABLE IF NOT EXISTS social_retries (
  wallet TEXT PRIMARY KEY,
  retry_at TEXT NOT NULL,
  failures INTEGER NOT NULL DEFAULT 1
);

-- A LABEL, NOT PROOF (social/labels.ts). What X says about a wallet, boiled down to one word:
--   claimed = an account's own bio carries the address (that account's word; nobody has checked it);
--   named   = an account posted the address (named BY that account, never owned by it).
-- A label is a hint. It proves neither who owns the wallet nor that the wallet is any good, and it is never used as
-- evidence FOR a wallet: it raises no copy weight, passes no gate, and enters neither wallet_evidence nor the proof ledger.
-- accounts = how many accounts are behind it now; since = when the first of them became known (never moved later).
CREATE TABLE IF NOT EXISTS social_wallet_labels (
  wallet TEXT PRIMARY KEY,
  label TEXT NOT NULL CHECK (label IN ('claimed','named')),
  accounts INTEGER NOT NULL,
  since TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- SOCIAL_WARNING=shadow: every copyable leader buy by a labelled wallet, written down as "the warning would have skipped
-- this". Observation only: no row here changes a trade. The outcome is in copy_decisions (same leader_signature and mint).
CREATE TABLE IF NOT EXISTS social_warnings (
  leader_signature TEXT NOT NULL,
  mint TEXT NOT NULL,
  wallet TEXT NOT NULL,
  -- when the leader bought, and when GodsEye saw it
  ts TEXT NOT NULL,
  seen_at TEXT NOT NULL,
  -- the label as it stood at that moment
  label TEXT NOT NULL,
  accounts INTEGER NOT NULL,
  mode TEXT NOT NULL,
  PRIMARY KEY (leader_signature, mint)
);
CREATE INDEX IF NOT EXISTS idx_social_warnings_wallet ON social_warnings(wallet, ts);
`;

const ensured = new WeakSet<DB>();
/** Creates the social tables (idempotent). */
export function ensureSocialTables(db: DB): void {
  if (ensured.has(db)) return;
  db.exec(SQL);
  // Columns added after the first version of these tables.
  const has = (table: string, col: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === col);
  if (!has("social_accounts", "timeline_at")) db.exec("ALTER TABLE social_accounts ADD COLUMN timeline_at TEXT");
  if (!has("social_wallet_accounts", "first_seen_at")) {
    db.exec("ALTER TABLE social_wallet_accounts ADD COLUMN first_seen_at TEXT NOT NULL DEFAULT ''");
    db.exec("UPDATE social_wallet_accounts SET first_seen_at = updated_at WHERE first_seen_at = ''");
  }
  ensured.add(db);
}

/** True once the collector has run on this database (read-only callers check before querying). */
export function socialTablesExist(db: DB): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='social_accounts'").get();
}
