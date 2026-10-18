/**
 * Everything the public dashboard shows, computed from GodsEye's database.
 * Used two ways:
 *   • locally: the dashboard's API routes call these directly
 *   • hosted (Vercel): GodsEye runs these and publishes the results to Turso
 *     (see agent/src/publish/snapshot.ts); the website reads those copies.
 */
import { type DB, getMeta } from "./db";
import { HEARTBEAT_STALE_MINUTES, TIERS, WALLET_KINDS, type Tier, type WalletKind } from "./constants";
import { equityCurve, maxDrawdown, monthlyReturns, rollingWinRate, winRate } from "./stats";
import { verifyProofChain, type ProofEntry } from "./proof";
import type {
  LiveQuery, LiveWalletRow, CopiesData, CopyTrade, Evidence, KindReason, Leader, LeadersData, LogRow, Performance, Position, ProofData, RugCheckEntry,
  Summary, SwapRow, WalletDetail, WalletGroup, WalletList, WalletQuery, WalletRow, WalletStats, WeightChange,
} from "./dashboard-types";

const num = (v: string | null, d: number) => (v === null || v === "" || !Number.isFinite(Number(v)) ? d : Number(v));

/** A funder that has paid for this many tracked wallets is probably an exchange, not a person. */
export const LIKELY_EXCHANGE_GROUP_SIZE = 25;

const WALLET_ROW_SQL = `
  SELECT w.address, w.tier, w.tier_reason, w.tier_changed_at, w.kind, w.ai_score, w.copy_weight, w.is_fresh, w.funder,
         w.discovered_via, w.first_seen_at, w.chain_created_at, w.age_is_lower_bound, w.last_activity_at, w.last_analyzed_at,
         s.pnl_7d_sol, s.pnl_30d_sol, s.win_rate_30d, s.closed_30d, s.swaps_30d,
         CASE WHEN w.funder IS NULL THEN 1 ELSE (SELECT COUNT(*) FROM wallets w2 WHERE w2.funder = w.funder) END AS group_size
    FROM wallets w LEFT JOIN wallet_stats s ON s.wallet = w.address`;

export function isLive(heartbeat: string | null, agentStatus: string | null, now = Date.now()): boolean {
  return !!heartbeat && agentStatus === "live" && now - new Date(heartbeat).getTime() < HEARTBEAT_STALE_MINUTES * 60_000;
}

function withUnrealized(p: Position): Position {
  if (p.status !== "open") return p;
  const mark = p.last_price_sol ?? p.entry_price_sol;
  const value = p.token_amount * mark;
  // Cost of the tokens still held = cost × share of tokens left.
  const heldCost = p.tokens_bought > 0 ? p.cost_sol * (p.token_amount / p.tokens_bought) : p.cost_sol;
  const unrealized = value - heldCost;
  return { ...p, unrealized_sol: unrealized, unrealized_pct: heldCost > 0 ? (unrealized / heldCost) * 100 : 0 };
}

export function getSummary(d: DB): Summary {
  const hb = getMeta(d, "heartbeat");
  const status = getMeta(d, "agent_status");
  const closed = d.prepare("SELECT pnl_sol, closed_at FROM positions WHERE status='closed'").all() as { pnl_sol: number; closed_at: string }[];
  const open = (d.prepare("SELECT * FROM positions WHERE status='open'").all() as Position[]).map(withUnrealized);
  const today = new Date().toISOString().slice(0, 10);
  const tierCounts = Object.fromEntries(TIERS.map((t) => [t, 0])) as Record<Tier, number>;
  for (const r of d.prepare("SELECT tier, COUNT(*) n FROM wallets GROUP BY tier").all() as { tier: Tier; n: number }[]) tierCounts[r.tier] = r.n;
  const kindCounts = Object.fromEntries(WALLET_KINDS.map((k) => [k, 0])) as Record<WalletKind, number>;
  for (const r of d.prepare("SELECT kind, COUNT(*) n FROM wallets GROUP BY kind").all() as { kind: WalletKind; n: number }[]) kindCounts[r.kind] = r.n;
  const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
  return {
    live: isLive(hb, status),
    heartbeat: hb,
    agentStatus: status,
    copyMode: getMeta(d, "copy_mode") === "paper" ? "paper" : "real",
    paused: getMeta(d, "copy_paused_effective") === "1" || getMeta(d, "copy_paused") === "1",
    wallet: {
      pubkey: getMeta(d, "wallet_pubkey"),
      balanceSol: getMeta(d, "wallet_balance_sol") === null ? null : Number(getMeta(d, "wallet_balance_sol")),
      checkedAt: getMeta(d, "wallet_balance_checked_at"),
    },
    closedPositions: closed.length,
    wins: closed.filter((t) => t.pnl_sol > 0).length,
    losses: closed.filter((t) => t.pnl_sol <= 0).length,
    winRate: winRate(closed),
    realizedPnlSol: closed.reduce((s, t) => s + t.pnl_sol, 0),
    todayPnlSol: closed.filter((t) => t.closed_at.startsWith(today)).reduce((s, t) => s + t.pnl_sol, 0),
    unrealizedPnlSol: open.reduce((s, p) => s + (p.unrealized_sol ?? 0), 0),
    openPositions: open.length,
    maxPositions: num(getMeta(d, "max_positions"), 5),
    copiesToday: (d.prepare("SELECT COUNT(*) n FROM copy_trades WHERE status='filled' AND created_at >= ?").get(`${today}T00:00:00.000Z`) as { n: number }).n,
    walletsTracked: (d.prepare("SELECT COUNT(*) n FROM wallets").get() as { n: number }).n,
    leaders: (d.prepare("SELECT COUNT(*) n FROM wallets WHERE copy_weight > 0").get() as { n: number }).n,
    freshWallets24h: (d.prepare("SELECT COUNT(*) n FROM wallets WHERE is_fresh = 1 AND first_seen_at >= ?").get(dayAgo) as { n: number }).n,
    tierCounts,
    kindCounts,
    lastLearningAt: getMeta(d, "last_learning_at"),
    lastDiscoveryAt: getMeta(d, "last_discovery_at"),
    stream: {
      enabled: getMeta(d, "stream_enabled") === "1",
      status: getMeta(d, "stream_status"),
      lastAt: getMeta(d, "stream_last_at"),
      txPerSec: getMeta(d, "stream_tx_per_sec") === null ? null : Number(getMeta(d, "stream_tx_per_sec")),
      swapsPerSec: getMeta(d, "stream_swaps_per_sec") === null ? null : Number(getMeta(d, "stream_swaps_per_sec")),
      walletsInMemory: getMeta(d, "stream_wallets_in_memory") === null ? null : Number(getMeta(d, "stream_wallets_in_memory")),
      walletsSeen24h: (d.prepare("SELECT COUNT(*) n FROM wallet_activity WHERE last_seen_at >= ?").get(dayAgo) as { n: number }).n,
      walletsSeenTotal: (d.prepare("SELECT COUNT(*) n FROM wallet_activity").get() as { n: number }).n,
    },
  };
}

/** Same filter/sort as getLiveWallets, on a published copy (hosted website). */
export function filterLiveWallets(rows: LiveWalletRow[], q: LiveQuery = {}): LiveWalletRow[] {
  const key: Record<NonNullable<LiveQuery["sort"]>, (r: LiveWalletRow) => number> = {
    pnl: (r) => r.live_pnl_sol, swaps: (r) => r.swaps, volume: (r) => r.volume_sol, recent: (r) => Date.parse(r.last_seen_at),
  };
  const k = key[q.sort ?? "pnl"];
  return rows
    .filter((r) => !q.kind || q.kind === "all" || r.live_kind === q.kind)
    .sort((a, b) => k(b) - k(a))
    .slice(0, Math.min(2000, Math.max(1, q.limit ?? 200)));
}

const LIVE_SORT = { pnl: "a.live_pnl_sol DESC", swaps: "a.swaps DESC", volume: "a.volume_sol DESC", recent: "a.last_seen_at DESC" } as const;

/** Wallets seen on the live stream, with their tier if GodsEye has analyzed them. */
export function getLiveWallets(d: DB, q: LiveQuery = {}): LiveWalletRow[] {
  const kind = q.kind && q.kind !== "all" ? q.kind : null;
  return d
    .prepare(
      `SELECT a.*, w.tier FROM wallet_activity a LEFT JOIN wallets w ON w.address = a.address
        WHERE (? IS NULL OR a.live_kind = ?) ORDER BY ${LIVE_SORT[q.sort ?? "pnl"]} LIMIT ?`,
    )
    .all(kind, kind, Math.min(2000, Math.max(1, q.limit ?? 200))) as LiveWalletRow[];
}

/** Every wallet row (newest analysis first), capped so a published copy stays small. */
export function getAllWalletRows(d: DB, cap = 20_000): WalletRow[] {
  return d.prepare(`${WALLET_ROW_SQL} ORDER BY w.last_analyzed_at IS NULL, w.last_analyzed_at DESC LIMIT ?`).all(cap) as WalletRow[];
}

/** Search / filter / sort / page the wallet database. Pure, so the hosted site can run it on a published copy. */
export function filterWallets(rows: WalletRow[], q: WalletQuery): WalletList {
  const needle = q.q?.trim().toLowerCase();
  let out = rows.filter(
    (r) =>
      (!needle || r.address.toLowerCase().includes(needle) || (r.funder ?? "").toLowerCase().includes(needle)) &&
      (!q.tier || q.tier === "all" || r.tier === q.tier) &&
      (!q.kind || q.kind === "all" || r.kind === q.kind) &&
      (!q.fresh || r.is_fresh === 1) &&
      (!q.copied || r.copy_weight > 0),
  );
  const key: Record<NonNullable<WalletQuery["sort"]>, (r: WalletRow) => number> = {
    pnl_30d: (r) => r.pnl_30d_sol ?? -Infinity,
    pnl_7d: (r) => r.pnl_7d_sol ?? -Infinity,
    weight: (r) => r.copy_weight,
    ai_score: (r) => r.ai_score ?? -Infinity,
    last_activity: (r) => (r.last_activity_at ? Date.parse(r.last_activity_at) : -Infinity),
    first_seen: (r) => Date.parse(r.first_seen_at),
  };
  const k = key[q.sort ?? "pnl_30d"];
  out = [...out].sort((a, b) => k(b) - k(a));
  const offset = Math.max(0, q.offset ?? 0);
  const limit = Math.min(500, Math.max(1, q.limit ?? 100));
  return { rows: out.slice(offset, offset + limit), total: out.length };
}

export function listWallets(d: DB, q: WalletQuery): WalletList {
  return filterWallets(getAllWalletRows(d), q);
}

export function getWalletDetail(d: DB, address: string): WalletDetail | null {
  const wallet = d.prepare(`${WALLET_ROW_SQL} WHERE w.address = ?`).get(address) as WalletRow | undefined;
  if (!wallet) return null;
  const raw = d.prepare("SELECT kind_reasons FROM wallets WHERE address = ?").get(address) as { kind_reasons: string };
  const stats = (d.prepare("SELECT * FROM wallet_stats WHERE wallet = ?").get(address) as WalletStats | undefined) ?? null;
  const evidence = d.prepare("SELECT id, kind, detail, NULLIF(mint, '') mint, NULLIF(signature, '') signature, ts FROM wallet_evidence WHERE wallet = ? ORDER BY ts DESC LIMIT 100").all(address) as Evidence[];
  const swaps = d
    .prepare(`SELECT s.id, s.signature, s.ts, s.mint, t.symbol, s.side, s.token_amount, s.sol_amount, s.price_sol, s.venue, s.token_age_sec
                FROM wallet_swaps s LEFT JOIN token_info t ON t.mint = s.mint WHERE s.wallet = ? ORDER BY s.ts DESC LIMIT 100`)
    .all(address) as SwapRow[];
  const weightHistory = d.prepare("SELECT * FROM weight_history WHERE wallet = ? ORDER BY ts DESC LIMIT 50").all(address) as WeightChange[];
  const group = wallet.funder
    ? (d.prepare(`${WALLET_ROW_SQL} WHERE w.funder = ? AND w.address != ? ORDER BY w.chain_created_at DESC LIMIT 50`).all(wallet.funder, address) as WalletRow[])
    : [];
  const copies = d.prepare("SELECT * FROM copy_trades WHERE leader = ? ORDER BY created_at DESC LIMIT 50").all(address) as CopyTrade[];
  const cp = d.prepare("SELECT COALESCE(SUM(pnl_sol),0) s, COUNT(*) n FROM positions WHERE leader = ? AND status='closed'").get(address) as { s: number; n: number };
  return {
    wallet,
    stats,
    evidence,
    kindReasons: JSON.parse(raw.kind_reasons) as KindReason[],
    swaps,
    weightHistory,
    group,
    copies,
    copyPnlSol: cp.s,
    copyClosed: cp.n,
  };
}

/** Wallets grouped by who funded them — how GodsEye spots one person running many fresh wallets. */
export function getWalletGroups(d: DB, limit = 100): WalletGroup[] {
  const groups = d
    .prepare(
      `SELECT w.funder, COUNT(*) size,
              SUM(w.kind='ai') ai, SUM(w.kind='human') human, SUM(w.kind='unknown') unknown, SUM(w.is_fresh) fresh,
              MAX(w.chain_created_at) newest_at, f.tier funder_tier
         FROM wallets w LEFT JOIN wallets f ON f.address = w.funder
        WHERE w.funder IS NOT NULL
        GROUP BY w.funder
       HAVING COUNT(*) >= 2 OR SUM(w.is_fresh) >= 1
        ORDER BY newest_at DESC LIMIT ?`,
    )
    .all(limit) as Omit<WalletGroup, "members" | "likely_exchange">[];
  const members = d.prepare(
    `SELECT w.address, w.tier, w.kind, w.ai_score, w.is_fresh, w.chain_created_at, s.pnl_30d_sol
       FROM wallets w LEFT JOIN wallet_stats s ON s.wallet = w.address WHERE w.funder = ? ORDER BY w.chain_created_at DESC LIMIT 30`,
  );
  return groups.map((g) => ({ ...g, likely_exchange: g.size >= LIKELY_EXCHANGE_GROUP_SIZE, members: members.all(g.funder) as WalletGroup["members"] }));
}

export function getLeaders(d: DB): LeadersData {
  const leaders = d
    .prepare(
      `SELECT w.address, w.tier, w.kind, w.copy_weight, w.weight_reason, w.last_activity_at,
              s.pnl_7d_sol, s.pnl_30d_sol, s.win_rate_30d, s.closed_30d,
              COALESCE((SELECT SUM(pnl_sol) FROM positions p WHERE p.leader = w.address AND p.status='closed'),0) copy_pnl_sol,
              (SELECT COUNT(*) FROM positions p WHERE p.leader = w.address AND p.status='closed') copy_closed
         FROM wallets w LEFT JOIN wallet_stats s ON s.wallet = w.address
        WHERE w.copy_weight > 0 OR w.address IN (SELECT DISTINCT leader FROM positions)
        ORDER BY w.copy_weight DESC, copy_pnl_sol DESC LIMIT 100`,
    )
    .all() as Leader[];
  const changes = d.prepare("SELECT * FROM weight_history ORDER BY ts DESC LIMIT 100").all() as WeightChange[];
  return { leaders, changes, budgetSol: num(getMeta(d, "copy_budget_sol"), 0) };
}

export function getCopies(d: DB): CopiesData {
  const open = (d.prepare("SELECT * FROM positions WHERE status='open' ORDER BY opened_at DESC").all() as Position[]).map(withUnrealized);
  const closed = d.prepare("SELECT * FROM positions WHERE status='closed' ORDER BY closed_at DESC LIMIT 500").all() as Position[];
  const trades = d
    .prepare(`SELECT c.*, p.hash AS proof_hash FROM copy_trades c LEFT JOIN proof_ledger p ON p.id = c.proof_id ORDER BY c.created_at DESC LIMIT 300`)
    .all() as CopyTrade[];
  return { open, closed, trades };
}

export function getPerformance(d: DB): Performance {
  const start = num(getMeta(d, "starting_balance_sol"), num(getMeta(d, "copy_budget_sol"), 0));
  const trades = (d.prepare("SELECT closed_at AS exit_ts, pnl_sol, pnl_pct FROM positions WHERE status='closed' ORDER BY closed_at").all() as {
    exit_ts: string; pnl_sol: number; pnl_pct: number;
  }[]);
  const equity = equityCurve(trades, start);
  const wins = trades.filter((t) => t.pnl_sol > 0);
  const losses = trades.filter((t) => t.pnl_sol <= 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl_sol, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl_sol, 0));
  return {
    startingCapitalSol: start,
    equity: [{ ts: trades[0]?.exit_ts ?? new Date().toISOString(), equity: start, cumPnl: 0, drawdownPct: 0 }, ...equity],
    rollingWinRate: rollingWinRate(trades, 30),
    monthly: monthlyReturns(trades, start),
    drawdown: maxDrawdown(equity, start),
    currentDrawdownPct: equity.at(-1)?.drawdownPct ?? 0,
    avgWinPct: wins.length ? wins.reduce((s, t) => s + t.pnl_pct, 0) / wins.length : null,
    avgLossPct: losses.length ? losses.reduce((s, t) => s + t.pnl_pct, 0) / losses.length : null,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
  };
}

export function getProof(d: DB, limit = 50, offset = 0): ProofData {
  const all = d.prepare("SELECT * FROM proof_ledger ORDER BY id").all() as ProofEntry[];
  const entries = d.prepare("SELECT * FROM proof_ledger ORDER BY id DESC LIMIT ? OFFSET ?").all(limit, offset) as ProofEntry[];
  return { entries, total: all.length, chain: verifyProofChain(all) };
}

export function getLogs(d: DB, limit = 40): LogRow[] {
  return d.prepare("SELECT * FROM agent_log ORDER BY id DESC LIMIT ?").all(limit) as LogRow[];
}

/** Latest rug check of every token GodsEye considered (blocked first). */
export function getRugChecks(d: DB): RugCheckEntry[] {
  const rows = d.prepare("SELECT * FROM rug_checks ORDER BY verdict = 'pass', checked_at DESC LIMIT 60").all() as (Omit<RugCheckEntry, "blocks" | "warnings"> & { blocks: string; warnings: string })[];
  return rows.map((r) => ({ ...r, blocks: JSON.parse(r.blocks) as string[], warnings: JSON.parse(r.warnings) as string[] }));
}

/** How many proof-ledger entries a published copy keeps (newest first). */
export const SNAPSHOT_PROOF_ENTRIES = 500;
/** How many wallet rows a published copy keeps. */
export const SNAPSHOT_WALLET_ROWS = 5_000;

/** Every dashboard data feed except per-wallet pages, ready to publish. */
export function buildDashboardSnapshot(d: DB): Record<string, unknown> {
  return {
    summary: getSummary(d),
    wallets: getAllWalletRows(d, SNAPSHOT_WALLET_ROWS),
    groups: getWalletGroups(d),
    leaders: getLeaders(d),
    copies: getCopies(d),
    performance: getPerformance(d),
    proof: getProof(d, SNAPSHOT_PROOF_ENTRIES, 0),
    logs: getLogs(d, 40),
    rugchecks: getRugChecks(d),
    live: getLiveWallets(d, { sort: "pnl", limit: 2000 }),
  };
}
