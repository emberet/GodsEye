/**
 * Facts about tokens, cached in the token_info table:
 *   symbol + when its first pool was created (GeckoTerminal) → "how early was this buy?"
 *   creator (RugCheck)                                       → "did the creator fund this wallet?"
 *   decimals (Solana)                                        → reading swap amounts
 */
import { type DB, nowIso } from "@godseye/shared";
import { fetchJson } from "../http";
import { fetchTokenLaunch } from "./geckoterminal";
import { tokenDecimals } from "./decimals";

export interface TokenInfo {
  mint: string;
  symbol: string | null;
  decimals: number | null;
  pool_created_at: string | null;
  creator: string | null;
  checked_at: string;
}

/** Launch facts don't change, but a token GeckoTerminal didn't know yet is retried after this long. */
const RETRY_UNKNOWN_HOURS = 6;

export function cachedTokenInfo(db: DB, mint: string): TokenInfo | null {
  return (db.prepare("SELECT * FROM token_info WHERE mint = ?").get(mint) as TokenInfo | undefined) ?? null;
}

export async function tokenInfo(db: DB, mint: string, opts: { creator?: boolean } = {}): Promise<TokenInfo> {
  const cached = cachedTokenInfo(db, mint);
  const stale = !cached || (!cached.pool_created_at && Date.now() - Date.parse(cached.checked_at) > RETRY_UNKNOWN_HOURS * 3_600_000);
  let info: TokenInfo = cached ?? { mint, symbol: null, decimals: null, pool_created_at: null, creator: null, checked_at: nowIso() };
  if (stale) {
    const launch = await fetchTokenLaunch(mint).catch(() => ({ symbol: null, poolCreatedAt: null }));
    info = {
      ...info,
      symbol: launch.symbol ?? info.symbol,
      pool_created_at: launch.poolCreatedAt ?? info.pool_created_at,
      decimals: info.decimals ?? (await tokenDecimals(mint)) ?? null,
      checked_at: nowIso(),
    };
  }
  if (opts.creator && !info.creator) {
    const report = await fetchJson<{ creator?: string }>(`https://api.rugcheck.xyz/v1/tokens/${mint}/report`, { retries: 0, timeoutMs: 15_000 }).catch(() => null);
    if (report?.creator) info = { ...info, creator: report.creator };
  }
  db.prepare(
    `INSERT INTO token_info (mint, symbol, decimals, pool_created_at, creator, checked_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(mint) DO UPDATE SET symbol=excluded.symbol, decimals=excluded.decimals, pool_created_at=excluded.pool_created_at,
       creator=excluded.creator, checked_at=excluded.checked_at`,
  ).run(info.mint, info.symbol, info.decimals, info.pool_created_at, info.creator, info.checked_at);
  return info;
}

export function symbolOf(db: DB, mint: string): string {
  return cachedTokenInfo(db, mint)?.symbol ?? `${mint.slice(0, 4)}…`;
}
