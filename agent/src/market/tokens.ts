/**
 * Facts about tokens, cached in the token_info table:
 *   symbol + decimals (Shyft, fast)              → names, the memecoin filter, reading swap amounts
 *   when its first pool was created (GeckoTerminal) → "how early was this buy?" (asked for by analysis only)
 *   creator (RugCheck)                           → "did the creator fund this wallet?"
 */
import { type DB, nowIso } from "@godseye/shared";
import { fetchJson } from "../http";
import { fetchTokenLaunch } from "./geckoterminal";
import { tokenDecimals } from "./decimals";
import { fetchShyftToken } from "./shyft";

export interface TokenInfo {
  mint: string;
  symbol: string | null;
  decimals: number | null;
  pool_created_at: string | null;
  creator: string | null;
  /** The token's deepest pool (used for price candles). */
  pool_address: string | null;
  checked_at: string;
  /** When GeckoTerminal was last asked for the launch time and pool (null: never). */
  launch_checked_at: string | null;
}

/** Launch facts don't change, but a token GeckoTerminal didn't know yet is retried after this long. */
const RETRY_UNKNOWN_HOURS = 6;

export function cachedTokenInfo(db: DB, mint: string): TokenInfo | null {
  return (db.prepare("SELECT * FROM token_info WHERE mint = ?").get(mint) as TokenInfo | undefined) ?? null;
}

const earliest = (a: string | null, b: string | null) => (a && b ? (a < b ? a : b) : (a ?? b));

/**
 * Record a launch time read from Solana (the mint's first transaction), and its creator (who paid for that
 * transaction) when known. Keeps the earliest known launch;
 * doesn't count as asking GeckoTerminal, which is still asked for the pool when price candles are needed.
 */
export function recordLaunch(db: DB, mint: string, at: string, creator: string | null = null): void {
  db.prepare(
    `INSERT INTO token_info (mint, pool_created_at, creator, checked_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(mint) DO UPDATE SET
       pool_created_at = CASE
         WHEN token_info.pool_created_at IS NULL OR excluded.pool_created_at < token_info.pool_created_at THEN excluded.pool_created_at
         ELSE token_info.pool_created_at END,
       creator = CASE WHEN COALESCE(token_info.creator, '') = '' THEN excluded.creator ELSE token_info.creator END`,
  ).run(mint, at, creator, nowIso());
}

/** Should GeckoTerminal be asked for this token's launch time (never asked, or unknown and asked a while ago)? */
export function launchDue(info: TokenInfo | null, now = Date.now()): boolean {
  if (!info?.launch_checked_at) return true;
  return !info.pool_created_at && now - Date.parse(info.launch_checked_at) > RETRY_UNKNOWN_HOURS * 3_600_000;
}

/**
 * A token's facts, filling in what's missing. Names come from Shyft (fast); GeckoTerminal's queue is
 * only joined when `launch` or `pool` is asked for (wallet analysis), or when Shyft can't name the token.
 */
export async function tokenInfo(db: DB, mint: string, opts: { creator?: boolean; pool?: boolean; launch?: boolean } = {}): Promise<TokenInfo> {
  let info: TokenInfo = cachedTokenInfo(db, mint) ?? {
    mint, symbol: null, decimals: null, pool_created_at: null, creator: null, pool_address: null, checked_at: nowIso(), launch_checked_at: null,
  };
  if (!info.symbol || info.decimals === null) {
    const t = await fetchShyftToken(mint).catch(() => null);
    if (t) info = { ...info, symbol: info.symbol ?? t.symbol, decimals: info.decimals ?? t.decimals };
  }
  const due = launchDue(info);
  const askLaunch = due && (opts.launch || (opts.pool && !info.pool_address) || !info.symbol);
  if (askLaunch) {
    const launch = await fetchTokenLaunch(mint, opts.launch || opts.pool ? "high" : "normal").catch(() => null);
    if (launch) {
      info = {
        ...info,
        symbol: info.symbol ?? launch.symbol,
        // Keep the earlier launch: Solana's first mint transaction can predate GeckoTerminal's pool.
        pool_created_at: earliest(info.pool_created_at, launch.poolCreatedAt),
        pool_address: launch.topPool ?? info.pool_address,
        launch_checked_at: nowIso(),
      };
    }
  }
  if (info.decimals === null) info = { ...info, decimals: (await tokenDecimals(mint).catch(() => null)) ?? null };
  // Creator from RugCheck, asked once per token: "" means RugCheck answered but doesn't know (don't ask again).
  if (opts.creator && info.creator === null) {
    const report = await fetchJson<{ creator?: string }>(`https://api.rugcheck.xyz/v1/tokens/${mint}/report`, { retries: 0, timeoutMs: 8_000 }).catch(() => null);
    if (report) info = { ...info, creator: report.creator || "" };
  }
  info = { ...info, checked_at: nowIso() };
  db.prepare(
    `INSERT INTO token_info (mint, symbol, decimals, pool_created_at, creator, pool_address, checked_at, launch_checked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(mint) DO UPDATE SET symbol=excluded.symbol, decimals=excluded.decimals, pool_created_at=excluded.pool_created_at,
       creator=excluded.creator, pool_address=excluded.pool_address, checked_at=excluded.checked_at, launch_checked_at=excluded.launch_checked_at`,
  ).run(info.mint, info.symbol, info.decimals, info.pool_created_at, info.creator, info.pool_address, info.checked_at, info.launch_checked_at);
  return info;
}

export function symbolOf(db: DB, mint: string): string {
  return cachedTokenInfo(db, mint)?.symbol ?? `${mint.slice(0, 4)}…`;
}
