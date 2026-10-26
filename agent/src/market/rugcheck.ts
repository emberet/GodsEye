/**
 * RUG CHECKS — run on every token before GodsEye copies a buy of it.
 *
 * Two sources:
 *  1. Solana itself (always): the token's own settings.
 *  2. RugCheck.xyz (free, no key): an overall risk score + extra signals.
 *     If RugCheck is unreachable, the on-chain checks still apply.
 *
 * HARD BLOCKS (the creator could take or trap your tokens):
 *   • freeze authority enabled        — can freeze any wallet holding it
 *   • permanent delegate              — can move tokens OUT of your wallet
 *   • pausable transfers              — can stop all selling
 *   • new accounts start frozen       — you may be unable to sell
 *   • mint authority enabled          — can print more and dump (allowlist trusted bridged coins)
 *   • RugCheck risk score ≥ RUG_MAX_RISK_SCORE, or flagged as rugged/honeypot
 *   • liquidity not locked: less than LP_MIN_LOCKED_PCT of the pools' liquidity (by USD) is locked or burned,
 *     so whoever added it can pull it (pump.fun curves and graduated pools count as locked)
 *   • bundled or clustered supply (see holders.ts): too much bought in the launch slots, top holders
 *     funded by one wallet or by the creator, top-10 holders holding too much, or a RugCheck insider network
 * WARNINGS (logged + shown, not blocking — common on legit big tokens):
 *   • top holders own a lot (often exchanges / pools)
 *   • transfer hook · mutable metadata
 *   • liquidity lock unknown (RugCheck has no pool data yet)
 * If Solana can't be read, the token is skipped this cycle (fail closed).
 */
import { type DB, nowIso, SOL_MINT } from "@godseye/shared";
import { config } from "../config";
import { fetchJson } from "../http";
import { rpcUrl } from "../config";
import { say } from "../log";
import { describeHolders, insiderPctFromReport, judgeHolders, measureHolders } from "./holders";

export interface OnchainMint {
  mintAuthority: string | null;
  freezeAuthority: string | null;
  extensions: { extension: string; state?: Record<string, unknown> }[];
}

export interface RugCheckSummary {
  score_normalised?: number;
  risks?: { name: string; level: string; description?: string }[];
  lpLockedPct?: number;
  /** Pools RugCheck found, with how much of each one's liquidity is locked or burned. */
  markets?: { marketType?: string; lp?: { lpLockedPct?: number; quoteUSD?: number; baseUSD?: number } | null }[] | null;
  /** From the full report: linked wallets RugCheck has mapped (its bubble map). */
  insiderNetworks?: { size?: number; type?: string; currentHolding?: number }[] | null;
  token?: { supply?: number; decimals?: number };
}

export interface RugVerdict {
  verdict: "pass" | "blocked";
  blocks: string[];
  warnings: string[];
  rugcheckScore: number | null;
}

/**
 * Share of the coin's pool liquidity that's locked or burned (%), weighted by each pool's USD liquidity;
 * a plain average when RugCheck has no USD values. null = no pool data.
 */
export function lockedLiquidityPct(rc: RugCheckSummary | null): number | null {
  const pools = (rc?.markets ?? []).filter((m) => m.lp && typeof m.lp.lpLockedPct === "number");
  if (!pools.length) return null;
  const weight = (m: (typeof pools)[number]) => Math.max(0, (m.lp!.quoteUSD ?? 0) + (m.lp!.baseUSD ?? 0));
  const total = pools.reduce((s, m) => s + weight(m), 0);
  const pct = (m: (typeof pools)[number]) => Math.min(100, Math.max(0, m.lp!.lpLockedPct as number));
  return total > 0 ? pools.reduce((s, m) => s + pct(m) * weight(m), 0) / total : pools.reduce((s, m) => s + pct(m), 0) / pools.length;
}

/** Pure decision logic (easy to test). */
export function judgeRugRisk(
  mint: string,
  onchain: OnchainMint,
  rc: RugCheckSummary | null,
  opts: { blockMintAuthority: boolean; maxRiskScore: number; allowlist: string[]; minLockedPct?: number },
): RugVerdict {
  const blocks: string[] = [];
  const warnings: string[] = [];
  const trusted = mint === SOL_MINT || opts.allowlist.includes(mint);

  if (onchain.freezeAuthority && !trusted) blocks.push("creator can freeze wallets (freeze authority)");
  if (onchain.mintAuthority && opts.blockMintAuthority && !trusted) blocks.push("creator can mint more tokens (mint authority)");
  for (const ext of onchain.extensions) {
    const st = ext.state ?? {};
    if (ext.extension === "permanentDelegate" && st.delegate) blocks.push("creator can take tokens from wallets (permanent delegate)");
    if (ext.extension === "pausableConfig" && st.authority) blocks.push("transfers can be paused");
    if (ext.extension === "defaultAccountState" && st.accountState === "frozen") blocks.push("new holders start frozen");
    if (ext.extension === "transferHook" && st.programId) warnings.push("has a transfer hook (custom code runs on every transfer)");
  }
  if (trusted && blocks.length) blocks.length = 0;

  const score = typeof rc?.score_normalised === "number" ? rc.score_normalised : null;
  if (rc) {
    if (score !== null && score >= opts.maxRiskScore && !trusted) blocks.push(`RugCheck risk score ${score}/100`);
    const minLocked = opts.minLockedPct ?? 0;
    const locked = lockedLiquidityPct(rc);
    if (minLocked > 0 && !trusted) {
      if (locked === null) warnings.push("liquidity lock unknown (RugCheck has no pool data yet)");
      else if (locked < minLocked) blocks.push(`liquidity not locked: only ${Math.round(locked)}% of the pool liquidity is locked or burned (needs ${minLocked}%)`);
    }
    for (const r of rc.risks ?? []) {
      const n = r.name.toLowerCase();
      if (/rugged|honeypot|scam/.test(n) && !trusted) blocks.push(`RugCheck: ${r.name}`);
      else if (!/mint authority|freeze authority|permanent control/.test(n)) warnings.push(`${r.name}${r.level === "danger" ? " (RugCheck: danger)" : ""}`);
    }
  } else {
    warnings.push("RugCheck unavailable — on-chain checks only");
  }
  return { verdict: blocks.length ? "blocked" : "pass", blocks: [...new Set(blocks)], warnings: [...new Set(warnings)], rugcheckScore: score };
}

async function readMint(mint: string): Promise<OnchainMint> {
  const res = await fetchJson<{ result?: { value?: { data?: { parsed?: { info?: Record<string, unknown> } } } }; error?: { message: string } }>(rpcUrl(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [mint, { encoding: "jsonParsed" }] }),
  });
  if (res.error) throw new Error(res.error.message);
  const info = res.result?.value?.data?.parsed?.info;
  if (!info) throw new Error("not a token mint");
  return {
    mintAuthority: (info.mintAuthority as string | null) ?? null,
    freezeAuthority: (info.freezeAuthority as string | null) ?? null,
    extensions: (info.extensions as OnchainMint["extensions"]) ?? [],
  };
}

async function readRugCheck(mint: string): Promise<RugCheckSummary | null> {
  try {
    return await fetchJson<RugCheckSummary>(`https://api.rugcheck.xyz/v1/tokens/${mint}/report`, { retries: 0, timeoutMs: 10_000 });
  } catch {
    return null;
  }
}

export interface RugCheckRow {
  mint: string;
  symbol: string;
  verdict: "pass" | "blocked";
  blocks: string;
  warnings: string;
  rugcheck_score: number | null;
  checked_at: string;
}

/** Checks a token (cached for RUG_CHECK_CACHE_HOURS). Returns null if Solana couldn't be read. */
export async function rugCheck(db: DB, mint: string, symbol: string): Promise<RugVerdict | null> {
  const cached = db.prepare("SELECT * FROM rug_checks WHERE mint = ?").get(mint) as RugCheckRow | undefined;
  if (cached && Date.now() - new Date(cached.checked_at).getTime() < config.rugCheckCacheHours * 3_600_000) {
    return { verdict: cached.verdict, blocks: JSON.parse(cached.blocks), warnings: JSON.parse(cached.warnings), rugcheckScore: cached.rugcheck_score };
  }
  let onchain: OnchainMint;
  try {
    onchain = await readMint(mint);
  } catch {
    return null; // fail closed: can't verify → don't trade it this cycle
  }
  const rc = await readRugCheck(mint);
  const v = judgeRugRisk(mint, onchain, rc, {
    blockMintAuthority: config.rugBlockMintAuthority, maxRiskScore: config.rugMaxRiskScore, allowlist: config.rugAllowlist, minLockedPct: config.lpMinLockedPct,
  });
  // Bundled or clustered supply. If the holders can't be read in time, don't trade it this cycle (fail closed).
  if (config.holderCheckEnabled && !config.rugAllowlist.includes(mint) && mint !== SOL_MINT) {
    const m = await Promise.race([
      measureHolders(mint, insiderPctFromReport(rc)).catch(() => null),
      new Promise<null>((r) => setTimeout(() => r(null), config.holderCheckTimeoutMs)),
    ]);
    if (!m) return null;
    const holderBlocks = judgeHolders(m, {
      bundleMaxPct: config.bundleMaxPct, clusterMaxPct: config.clusterMaxPct, top10MaxPct: config.top10MaxPct, insiderMaxPct: config.insiderMaxPct,
    });
    v.blocks.push(...holderBlocks);
    v.warnings.push(`Holders: ${describeHolders(m)}`);
    if (holderBlocks.length) v.verdict = "blocked";
  }
  db.prepare(
    `INSERT INTO rug_checks (mint, symbol, verdict, blocks, warnings, rugcheck_score, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(mint) DO UPDATE SET symbol=excluded.symbol, verdict=excluded.verdict, blocks=excluded.blocks, warnings=excluded.warnings,
       rugcheck_score=excluded.rugcheck_score, checked_at=excluded.checked_at`,
  ).run(mint, symbol, v.verdict, JSON.stringify(v.blocks), JSON.stringify(v.warnings), v.rugcheckScore, nowIso());
  if (v.verdict === "blocked" && cached?.verdict !== "blocked") say("warn", `Rug check: won't trade ${symbol} — ${v.blocks.join("; ")}.`);
  return v;
}

/** Keeps only tokens that pass the rug check. */
export async function rugScreen<T extends { mint: string; symbol: string }>(db: DB, tokens: T[]): Promise<T[]> {
  if (!config.rugCheckEnabled) return tokens;
  const out: T[] = [];
  for (const t of tokens) {
    const v = await rugCheck(db, t.mint, t.symbol);
    if (v?.verdict === "pass") out.push(t);
  }
  return out;
}
