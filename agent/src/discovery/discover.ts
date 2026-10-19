/**
 * DISCOVERY — finding wallets worth analyzing.
 *
 * Reads the latest trades in Solana's busiest and trending MEMECOIN pools
 * (GeckoTerminal, free) — memecoin/SOL pools and memecoin/memecoin pools —
 * and adds every wallet that keeps showing up with real size. Pools of
 * majors (SOL/USDC, staked SOL, wrapped BTC/ETH…) and stablecoin pools are
 * skipped: their traders are mostly arbitrage bots, not memecoin traders. New wallets — including brand-new ones created minutes ago —
 * go into the database as "not analyzed yet"; the analysis job takes it
 * from there (age, funder, P&L, tier, AI or human).
 *
 * Wallets also arrive from the copy watcher: when a tracked wallet sends
 * SOL to a wallet GodsEye has never seen, that wallet is added too
 * ("funded_by_tracked") — the classic move of a trader starting fresh.
 */
import { type DB, isNonMemecoinSymbol, nowIso, setMeta } from "@godseye/shared";
import { config } from "../config";
import { say } from "../log";
import { fetchPoolTrades, fetchTopPools, fetchTrendingPools, type PoolInfo } from "../market/geckoterminal";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const isMajor = (symbol: string) => isNonMemecoinSymbol(symbol);

/** "sol" for memecoin/SOL, "meme" for memecoin/memecoin, null for anything else. */
export function memecoinPoolKind(p: Pick<PoolInfo, "symbol" | "quoteSymbol" | "quoteMint">): "sol" | "meme" | null {
  if (isMajor(p.symbol)) return null;
  if (p.quoteMint === SOL_MINT || p.quoteSymbol.toUpperCase() === "SOL" || p.quoteSymbol.toUpperCase() === "WSOL") return "sol";
  return isMajor(p.quoteSymbol) ? null : "meme";
}

export function addWallet(db: DB, address: string, via: string, detail: string): boolean {
  if (config.ignoreWallets.includes(address)) return false;
  const info = db
    .prepare("INSERT OR IGNORE INTO wallets (address, first_seen_at, discovered_via, discovered_detail) VALUES (?, ?, ?, ?)")
    .run(address, nowIso(), via, detail);
  return info.changes > 0;
}

export async function runDiscovery(db: DB): Promise<{ added: number; seen: number }> {
  const [top, trending] = await Promise.all([fetchTopPools(3), fetchTrendingPools().catch(() => [])]);
  const all = [...new Map([...trending, ...top].map((p) => [p.poolAddress, p])).values()];
  const meme = all.filter((p) => memecoinPoolKind(p));
  // Mostly memecoin/SOL pools, plus a few memecoin/memecoin ones.
  const solPools = meme.filter((p) => memecoinPoolKind(p) === "sol");
  const memePools = meme.filter((p) => memecoinPoolKind(p) === "meme").slice(0, Math.max(2, Math.floor(config.discoverPools / 4)));
  const pools = [...memePools, ...solPools].slice(0, config.discoverPools);

  const tally = new Map<string, { trades: number; usd: number; pools: Set<string> }>();
  for (const pool of pools) {
    try {
      for (const t of await fetchPoolTrades(pool.poolAddress, config.discoverMinTradeUsd)) {
        const e = tally.get(t.wallet) ?? { trades: 0, usd: 0, pools: new Set<string>() };
        e.trades++;
        e.usd += t.volumeUsd;
        e.pools.add(pool.symbol);
        tally.set(t.wallet, e);
      }
    } catch (e) {
      say("warn", `Couldn't read trades for ${pool.symbol}: ${(e as Error).message.slice(0, 120)}`);
    }
  }

  const known = new Set((db.prepare("SELECT address FROM wallets").all() as { address: string }[]).map((r) => r.address));
  const candidates = [...tally.entries()]
    .filter(([a]) => !known.has(a))
    .sort((a, b) => b[1].trades * Math.log10(10 + b[1].usd) - a[1].trades * Math.log10(10 + a[1].usd));
  let added = 0;
  for (const [address, e] of candidates.slice(0, config.discoverMaxNewPerRun)) {
    const detail = `${e.trades} trades ($${Math.round(e.usd).toLocaleString("en-US")}) in ${[...e.pools].slice(0, 3).join(", ")}`;
    if (addWallet(db, address, "top_pool_trader", detail)) added++;
  }
  setMeta(db, "last_discovery_at", nowIso());
  say("wallet", `Discovery: read ${pools.length} memecoin pools (${pools.filter((p) => memecoinPoolKind(p) === "sol").length} vs SOL, ${pools.filter((p) => memecoinPoolKind(p) === "meme").length} vs other memecoins; skipped ${all.length - meme.length} major/stable pools), saw ${tally.size} active wallets, added ${added} new ones to analyze.`);
  return { added, seen: tally.size };
}
