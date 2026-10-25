/**
 * BUNDLES AND CLUSTERS — is this coin's supply really spread out, or held by one group?
 * Run with the rug check before every copy buy, straight from Solana (RugCheck's view of a coin that is
 * minutes old is often empty, and it describes the coin now, not at launch):
 *
 *   • launch bundle: share of supply BOUGHT from a pool or bonding curve in the coin's first two slots
 *     (the creation slot and the next): the creator's buy plus anyone bundled with it. Tokens minted to
 *     the deployer at creation don't count — that's supply, not a buy.
 *   • linked holders (the "bubble map"): top-10 holders funded by the same wallet, or by the coin's
 *     creator, and how much they hold together.
 *   • concentration: what the top-10 holders hold, leaving out pools and curves (program accounts).
 *   • RugCheck insider networks, when RugCheck has mapped the coin: linked wallets' current holding.
 */
import { PublicKey } from "@solana/web3.js";
import { rpcUrl } from "../config";
import { findFunder, type TokenBalanceLike, type TxLike } from "../chain/parse";

export interface HolderMetrics {
  /** % of supply bought from a pool/curve in the first two slots; null if the coin is too busy to reach its start. */
  launchBundlePct: number | null;
  launchBuyers: number;
  /** Biggest group of ≥2 top-10 holders sharing a funder (or funded by the creator): % of supply and size. */
  clusterPct: number;
  clusterSize: number;
  /** The cluster is holders funded by the coin's creator (counts even for one holder). */
  clusterFromCreator: boolean;
  /** Top-10 holders' share of supply, pools and curves left out. */
  top10Pct: number;
  /** RugCheck's mapped insider networks: % of supply they hold now (null if RugCheck has none). */
  insiderPct: number | null;
}

export interface HolderLimits {
  bundleMaxPct: number;
  clusterMaxPct: number;
  top10MaxPct: number;
  insiderMaxPct: number;
}

/** Pure: why this coin is too concentrated to buy (empty = fine). */
export function judgeHolders(m: HolderMetrics, lim: HolderLimits): string[] {
  const out: string[] = [];
  const pct = (n: number) => `${Math.round(n)}%`;
  if (m.launchBundlePct !== null && m.launchBundlePct > lim.bundleMaxPct) out.push(`bundled launch: ${pct(m.launchBundlePct)} of supply bought in the first two slots by ${m.launchBuyers} wallet${m.launchBuyers === 1 ? "" : "s"}`);
  if ((m.clusterSize >= 2 || m.clusterFromCreator) && m.clusterPct > lim.clusterMaxPct) {
    out.push(
      m.clusterFromCreator
        ? `clustered holders: ${m.clusterSize} top holder${m.clusterSize === 1 ? "" : "s"} funded by the coin's creator hold ${pct(m.clusterPct)}`
        : `clustered holders: ${m.clusterSize} top holders with one funder hold ${pct(m.clusterPct)}`,
    );
  }
  if (m.top10Pct > lim.top10MaxPct) out.push(`top 10 holders hold ${pct(m.top10Pct)}`);
  if (m.insiderPct !== null && m.insiderPct > lim.insiderMaxPct) out.push(`RugCheck insider network holds ${pct(m.insiderPct)}`);
  return out;
}

/** One-line summary for the rug-check panel. */
export const describeHolders = (m: HolderMetrics) =>
  [
    m.launchBundlePct === null ? "launch bundle: too busy to measure" : `launch bundle ${Math.round(m.launchBundlePct)}%`,
    m.clusterSize >= 2 || m.clusterFromCreator ? `${m.clusterSize} linked top holder${m.clusterSize === 1 ? "" : "s"} ${Math.round(m.clusterPct)}%` : "no linked top holders",
    `top 10 hold ${Math.round(m.top10Pct)}%`,
    ...(m.insiderPct !== null ? [`insider network ${Math.round(m.insiderPct)}%`] : []),
  ].join(" · ");

/** One RPC call, retried once: a node can briefly lag behind a coin created seconds ago. */
async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(rpcUrl(), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(6_000) });
      const json = (await res.json()) as { result?: T; error?: { message: string } };
      if (json.error) throw new Error(`${method}: ${json.error.message}`);
      return json.result as T;
    } catch (e) {
      if (attempt >= 1) throw e;
      await new Promise((r) => setTimeout(r, 400));
    }
  }
}
const getTx = (sig: string) => rpc<TxLike | null>("getTransaction", [sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 1, commitment: "confirmed" }]).catch(() => null);
/** Wallets are on-curve keys; pools, curves and vaults are program accounts (off-curve). */
const isWallet = (a: string) => {
  try {
    return PublicKey.isOnCurve(new PublicKey(a).toBytes());
  } catch {
    return false;
  }
};

type Bal = TokenBalanceLike;

/** Pure: tokens bought from pools/curves in one transaction, by buyer (minting to the deployer is ignored). */
export function poolBuys(tx: TxLike, mint: string): Map<string, number> {
  const pre = (tx.meta?.preTokenBalances ?? []).filter((b) => b.mint === mint);
  const post = (tx.meta?.postTokenBalances ?? []).filter((b) => b.mint === mint);
  const amt = (b?: Bal) => (b ? Number(b.uiTokenAmount.amount) / 10 ** b.uiTokenAmount.decimals : 0);
  let fromPools = 0;
  const gains = new Map<string, number>();
  for (const b of new Set([...pre, ...post].map((x) => x.accountIndex))) {
    const before = pre.find((x) => x.accountIndex === b);
    const after = post.find((x) => x.accountIndex === b);
    const owner = (after ?? before)?.owner;
    if (!owner) continue;
    const d = amt(after) - amt(before);
    if (!isWallet(owner)) {
      if (d < 0) fromPools += -d; // a pool or curve paid out tokens
    } else if (d > 0) gains.set(owner, (gains.get(owner) ?? 0) + d);
  }
  // Only what pools paid out counts as bought (the rest is minting or transfers).
  const total = [...gains.values()].reduce((s, v) => s + v, 0);
  if (!total || !fromPools) return new Map();
  const scale = Math.min(1, fromPools / total);
  return new Map([...gains.entries()].map(([o, v]) => [o, v * scale]));
}

/** Measures a coin's holders from Solana. Throws if Solana can't be read. */
export async function measureHolders(mint: string, insiderPct: number | null): Promise<HolderMetrics> {
  // Supply from the mint account itself (works for both token programs, including Token-2022 coins).
  const [mintRes, largest] = await Promise.all([
    rpc<{ value: { data?: { parsed?: { info?: { supply?: string; decimals?: number } } } } | null }>("getAccountInfo", [mint, { encoding: "jsonParsed" }]),
    rpc<{ value: { address: string; uiAmount: number | null }[] }>("getTokenLargestAccounts", [mint]),
  ]);
  const info = mintRes.value?.data?.parsed?.info;
  const supply = info?.supply ? Number(info.supply) / 10 ** (info.decimals ?? 0) : 0;
  if (!supply) throw new Error("token has no supply");
  const accounts = await rpc<{ value: ({ data?: { parsed?: { info?: { owner?: string } } } } | null)[] }>("getMultipleAccounts", [largest.value.map((l) => l.address), { encoding: "jsonParsed" }]);
  const byOwner = new Map<string, number>();
  largest.value.forEach((l, i) => {
    const owner = accounts.value[i]?.data?.parsed?.info?.owner;
    if (owner && isWallet(owner)) byOwner.set(owner, (byOwner.get(owner) ?? 0) + Number(l.uiAmount ?? 0));
  });
  const top = [...byOwner.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  const top10Pct = (top.reduce((s, [, v]) => s + v, 0) / supply) * 100;

  // Launch: the mint's first two slots (only reachable for coins with up to ~2,000 transactions).
  const launch = (async () => {
    const sigs: { signature: string; slot: number; err: unknown }[] = [];
    let before: string | undefined;
    for (let page = 0; page < 2; page++) {
      const batch = await rpc<{ signature: string; slot: number; err: unknown }[]>("getSignaturesForAddress", [mint, { limit: 1000, before }]);
      sigs.push(...batch);
      if (batch.length < 1000) {
        const firstSlot = sigs.at(-1)?.slot;
        if (firstSlot === undefined) return { pct: null, buyers: 0, creator: null as string | null };
        const early = sigs.filter((s) => s.slot <= firstSlot + 1 && !s.err).slice(-40);
        const txs = await Promise.all(early.map((s) => getTx(s.signature)));
        const bought = new Map<string, number>();
        for (const tx of txs) if (tx) for (const [o, v] of poolBuys(tx, mint)) bought.set(o, (bought.get(o) ?? 0) + v);
        const oldest = txs[txs.length - 1] ?? txs.find(Boolean);
        const creator = oldest?.transaction.message.accountKeys[0]?.pubkey.toString() ?? null;
        return { pct: ([...bought.values()].reduce((s, v) => s + v, 0) / supply) * 100, buyers: bought.size, creator };
      }
      before = batch.at(-1)?.signature;
    }
    return { pct: null, buyers: 0, creator: null as string | null };
  })();

  // Who funded each top holder (fresh wallets have short histories: one page reaches their first transaction).
  const funders = Promise.all(
    top.map(async ([owner]) => {
      const sigs = await rpc<{ signature: string }[]>("getSignaturesForAddress", [owner, { limit: 1000 }]).catch(() => []);
      if (!sigs.length || sigs.length >= 1000) return null;
      const first = await getTx(sigs[sigs.length - 1].signature);
      return first ? findFunder(first, owner) : null;
    }),
  );

  const [l, f] = await Promise.all([launch, funders]);
  const groups = new Map<string, { pct: number; n: number }>();
  top.forEach(([, amount], i) => {
    const key = f[i] && l.creator && f[i] === l.creator ? `creator:${f[i]}` : f[i];
    if (!key) return;
    const g = groups.get(key) ?? { pct: 0, n: 0 };
    g.pct += (amount / supply) * 100;
    g.n++;
    groups.set(key, g);
  });
  // A creator-funded holder counts even alone; other funders need two or more holders to be a cluster.
  let cluster = { pct: 0, n: 0, creator: false };
  for (const [key, g] of groups) {
    const creator = key.startsWith("creator:");
    if ((g.n >= 2 || creator) && g.pct > cluster.pct) cluster = { ...g, creator };
  }
  return { launchBundlePct: l.pct, launchBuyers: l.buyers, clusterPct: cluster.pct, clusterSize: cluster.n, clusterFromCreator: cluster.creator, top10Pct, insiderPct };
}

/** RugCheck's insider networks (from its full report) as % of supply, or null if it has none. */
export function insiderPctFromReport(report: { insiderNetworks?: { currentHolding?: number }[] | null; token?: { supply?: number; decimals?: number } } | null): number | null {
  const nets = report?.insiderNetworks ?? [];
  const supply = report?.token?.supply;
  if (!nets.length || !supply) return null;
  const held = nets.reduce((s, n) => s + (n.currentHolding ?? 0), 0);
  return (held / supply) * 100;
}
