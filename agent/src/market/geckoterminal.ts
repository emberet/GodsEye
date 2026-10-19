/**
 * GeckoTerminal — free, no API key. Gives us Solana's busiest pools, the
 * recent trades in each (who traded — that's how GodsEye finds wallets), and
 * when each token's first pool was created.
 * The free API rate-limits hard, so every call here is spaced out (~9/minute).
 */
import { fetchJson } from "../http";

const BASE = "https://api.geckoterminal.com/api/v2";
const MIN_GAP_MS = Number(process.env.GT_MIN_GAP_MS ?? 6_500); // GeckoTerminal answers 429 well before its documented 30/min
let last = 0;
let running = false;

/**
 * Who goes first when several parts of GodsEye want GeckoTerminal at once:
 *   high   — wallet analysis (token launch times, price candles): what the analysis run waits on
 *   normal — discovery, price fallbacks, SOL's hourly prices
 */
export type GtPriority = "high" | "normal";
const waiting: Record<GtPriority, (() => void)[]> = { high: [], normal: [] };

function pump(): void {
  if (running) return;
  const next = waiting.high.shift() ?? waiting.normal.shift();
  if (!next) return;
  running = true;
  const wait = Math.max(0, last + MIN_GAP_MS - Date.now());
  setTimeout(() => {
    last = Date.now();
    next();
  }, wait);
}

/** Calls waiting for GeckoTerminal right now, by priority. */
export function gtQueueLength(): { high: number; normal: number } {
  return { high: waiting.high.length, normal: waiting.normal.length };
}

/** All GeckoTerminal calls go through here, one at a time, ~9/minute; higher priority first. */
function gt<T>(path: string, priority: GtPriority = "normal"): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    waiting[priority].push(() => {
      fetchJson<T>(`${BASE}${path}`, { retries: 2 })
        .then(resolve, reject)
        .finally(() => {
          running = false;
          pump();
        });
    });
    pump();
  });
}

type Windowed = { m5?: string; m15?: string; m30?: string; h1?: string; h6?: string; h24?: string };

interface GtPool {
  id: string;
  attributes: {
    name: string;
    address: string;
    pool_created_at?: string | null;
    base_token_price_usd: string | null;
    fdv_usd: string | null;
    market_cap_usd: string | null;
    reserve_in_usd: string | null;
    price_change_percentage: Windowed;
    volume_usd: Windowed;
    transactions: Record<string, { buys: number; sells: number; buyers?: number; sellers?: number }>;
  };
  relationships: {
    base_token: { data: { id: string } };
    quote_token: { data: { id: string } };
    dex?: { data: { id: string } };
  };
}

export interface PoolInfo {
  mint: string;
  symbol: string;
  quoteMint: string;
  quoteSymbol: string;
  poolAddress: string;
  dex: string;
  priceUsd: number;
  change: { m5: number; m15: number; m30: number; h1: number; h6: number; h24: number };
  volume: { m5: number; m15: number; h1: number; h6: number; h24: number };
  liquidityUsd: number;
  fdvUsd: number;
  buyers24h: number;
  txM15: { buys: number; sells: number };
  /** Hours since this pool was created (Infinity if unknown). */
  poolAgeHours: number;
}

const num = (v: string | null | undefined): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

function toPoolInfo(p: GtPool): PoolInfo {
  const a = p.attributes;
  const [baseSym = "?", quoteSym = "?"] = a.name.split(" / ");
  return {
    mint: p.relationships.base_token.data.id.replace(/^solana_/, ""),
    symbol: baseSym.trim(),
    quoteMint: p.relationships.quote_token.data.id.replace(/^solana_/, ""),
    quoteSymbol: quoteSym.trim(),
    poolAddress: a.address,
    dex: p.relationships.dex?.data.id ?? "unknown",
    priceUsd: num(a.base_token_price_usd),
    change: {
      m5: num(a.price_change_percentage.m5),
      m15: num(a.price_change_percentage.m15),
      m30: num(a.price_change_percentage.m30),
      h1: num(a.price_change_percentage.h1),
      h6: num(a.price_change_percentage.h6),
      h24: num(a.price_change_percentage.h24),
    },
    volume: {
      m5: num(a.volume_usd.m5),
      m15: num(a.volume_usd.m15),
      h1: num(a.volume_usd.h1),
      h6: num(a.volume_usd.h6),
      h24: num(a.volume_usd.h24),
    },
    liquidityUsd: num(a.reserve_in_usd),
    fdvUsd: num(a.fdv_usd ?? a.market_cap_usd),
    buyers24h: a.transactions?.h24?.buyers ?? 0,
    txM15: { buys: a.transactions?.m15?.buys ?? 0, sells: a.transactions?.m15?.sells ?? 0 },
    poolAgeHours: a.pool_created_at ? (Date.now() - new Date(a.pool_created_at).getTime()) / 3_600_000 : Infinity,
  };
}

/** Solana pools sorted by 24h volume (20 per page). */
export async function fetchTopPools(pages = 3): Promise<PoolInfo[]> {
  const out: PoolInfo[] = [];
  for (let page = 1; page <= pages; page++) {
    const res = await gt<{ data: GtPool[] }>(`/networks/solana/pools?sort=h24_volume_usd_desc&page=${page}`);
    out.push(...res.data.map(toPoolInfo));
  }
  return out;
}

/** GeckoTerminal's "trending" Solana pools. */
export async function fetchTrendingPools(): Promise<PoolInfo[]> {
  const res = await gt<{ data: GtPool[] }>(`/networks/solana/trending_pools?page=1`);
  return res.data.map(toPoolInfo);
}

/** Pools for specific tokens (used to price open positions that left the top list). */
export async function fetchTokenPools(mints: string[]): Promise<Map<string, PoolInfo>> {
  const map = new Map<string, PoolInfo>();
  for (let i = 0; i < mints.length; i += 30) {
    const chunk = mints.slice(i, i + 30);
    const res = await gt<{ data: { id: string; attributes: { address: string; price_usd: string | null } }[] }>(
      `/networks/solana/tokens/multi/${chunk.join(",")}`,
    );
    for (const t of res.data) {
      const price = num(t.attributes.price_usd);
      if (price > 0) {
        map.set(t.attributes.address, {
          mint: t.attributes.address,
          symbol: "",
          quoteMint: "",
          quoteSymbol: "",
          poolAddress: "",
          dex: "",
          priceUsd: price,
          change: { m5: 0, m15: 0, m30: 0, h1: 0, h6: 0, h24: 0 },
          volume: { m5: 0, m15: 0, h1: 0, h6: 0, h24: 0 },
          liquidityUsd: 0,
          fdvUsd: 0,
          buyers24h: 0,
          txM15: { buys: 0, sells: 0 },
          poolAgeHours: Infinity,
        });
      }
    }
  }
  return map;
}

export interface PoolTrade {
  wallet: string;
  side: "buy" | "sell";
  volumeUsd: number;
  ts: string;
  txHash: string;
}

/** The latest trades in a pool (up to 300), at least `minUsd` each. */
export async function fetchPoolTrades(poolAddress: string, minUsd: number): Promise<PoolTrade[]> {
  const res = await gt<{ data: { attributes: { tx_from_address: string; kind: string; volume_in_usd: string; block_timestamp: string; tx_hash: string } }[] }>(
    `/networks/solana/pools/${poolAddress}/trades?trade_volume_in_usd_greater_than=${minUsd}`,
  );
  return res.data.map((t) => ({
    wallet: t.attributes.tx_from_address,
    side: t.attributes.kind === "sell" ? "sell" : "buy",
    volumeUsd: num(t.attributes.volume_in_usd),
    ts: t.attributes.block_timestamp,
    txHash: t.attributes.tx_hash,
  }));
}

/** When a token's first pool was created, its symbol, and its deepest pool (for price candles). */
export async function fetchTokenLaunch(mint: string, priority: GtPriority = "high"): Promise<{ symbol: string | null; poolCreatedAt: string | null; topPool: string | null }> {
  const res = await gt<{ data: GtPool[] }>(`/networks/solana/tokens/${mint}/pools?page=1`, priority);
  let earliest: string | null = null;
  let symbol: string | null = null;
  let topPool: string | null = null;
  let topLiquidity = -1;
  for (const p of res.data) {
    const info = toPoolInfo(p);
    if (info.mint === mint && !symbol) symbol = info.symbol;
    const created = p.attributes.pool_created_at;
    if (created && (!earliest || created < earliest)) earliest = created;
    if (info.liquidityUsd > topLiquidity) {
      topLiquidity = info.liquidityUsd;
      topPool = info.poolAddress;
    }
  }
  return { symbol, poolCreatedAt: earliest, topPool };
}

/** A price candle: start time (unix seconds), open, high, low, close (USD). */
export type Candle = [number, number, number, number, number];

/** 15-minute candles of a pool's base token ending before `beforeTimestamp`, oldest first. */
export async function fetchCandles15m(poolAddress: string, beforeTimestamp: number, limit: number): Promise<Candle[]> {
  const res = await gt<{ data: { attributes: { ohlcv_list: number[][] } } }>(
    `/networks/solana/pools/${poolAddress}/ohlcv/minute?aggregate=15&limit=${limit}&currency=usd&before_timestamp=${beforeTimestamp}`,
    "high",
  );
  return res.data.attributes.ohlcv_list.map((c) => [c[0], c[1], c[2], c[3], c[4]] as Candle).sort((a, b) => a[0] - b[0]);
}

/** Hourly USD closes for a pool's base token, newest first: [unix seconds, close][] (up to 1000 hours per call). */
export async function fetchHourlyCloses(poolAddress: string, beforeTimestamp?: number): Promise<[number, number][]> {
  const before = beforeTimestamp ? `&before_timestamp=${beforeTimestamp}` : "";
  const res = await gt<{ data: { attributes: { ohlcv_list: number[][] } } }>(
    `/networks/solana/pools/${poolAddress}/ohlcv/hour?aggregate=1&limit=1000&currency=usd${before}`,
  );
  return res.data.attributes.ohlcv_list.map((c) => [c[0], c[4]] as [number, number]);
}
