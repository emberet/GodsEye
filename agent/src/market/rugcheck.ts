/**
 * RUG CHECKS — run on every token before GodsEye copies a buy of it.
 *
 * Two sources, and a buy needs an answer from both:
 *  1. Solana itself: the token's own settings.
 *  2. RugCheck.xyz (free, no key): an overall risk score, the coin's pools and how much of their liquidity is locked.
 *
 * HARD BLOCKS (the creator could take or trap your tokens):
 *   • freeze authority enabled        — can freeze any wallet holding it
 *   • permanent delegate              — can move tokens OUT of your wallet
 *   • pausable transfers              — can stop all selling
 *   • new accounts start frozen       — you may be unable to sell
 *   • mint authority enabled          — can print more and dump (allowlist trusted bridged coins)
 *   • transfer hook                   — a program of the creator's runs on every transfer and can refuse a sell;
 *                                       also blocked while someone still holds the right to set one
 *   • transfer fee of RUG_MAX_TRANSFER_FEE_BPS or more (Token-2022: taken from every buy and sell)
 *   • RugCheck risk score ≥ RUG_MAX_RISK_SCORE, or flagged as rugged/honeypot
 *   • liquidity not locked: less than LP_MIN_LOCKED_PCT of the pools' liquidity (by USD) is locked or burned,
 *     so whoever added it can pull it (pump.fun curves and graduated pools count as locked)
 *   • bundled or clustered supply (see holders.ts): too much bought in the launch slots, top holders
 *     funded by one wallet or by the creator, top-10 holders holding too much, or a RugCheck insider network
 * WARNINGS (logged + shown, not blocking — common on legit big tokens):
 *   • top holders own a lot (often exchanges / pools)
 *   • mutable metadata · any smaller transfer fee, or an authority that can still change it
 *
 * FAIL CLOSED. A buy needs a pass, and a pass counts only when everything it rests on was read:
 *   • Solana can't be read, or the holders can't be measured in time   → no buy this time
 *   • RugCheck gives no answer                                         → no buy this time
 *     (RUG_REQUIRE_RUGCHECK=false trades on the on-chain checks alone)
 *   • RugCheck has no pool data yet, so the liquidity lock is unknown  → no buy this time
 * Such a look is not kept: the next buy of that coin looks again. With RugCheck silent, a block found on Solana's
 * facts still stands and is kept.
 */
import { type DB, nowIso, SOL_MINT } from "@godseye/shared";
import { config } from "../config";
import { fetchJson } from "../http";
import { copyRpcUrl } from "../config";
import { say } from "../log";
import { describeHolders, type HolderMetrics, insiderPctFromReport, judgeHolders, measureHolders } from "./holders";
import { profileMint, tradeTraits } from "./mint-profile";

export interface OnchainMint {
  /** The token program that owns the mint (SPL Token or Token-2022). */
  tokenProgram?: string | null;
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

/** What a verdict could not check: RugCheck gave no answer, or it has no pool data yet to tell whether the liquidity is locked. */
export type Unchecked = "rugcheck_down" | "lock_unknown";

export interface RugVerdict {
  verdict: "pass" | "blocked";
  blocks: string[];
  warnings: string[];
  rugcheckScore: number | null;
  /** Set when part of the check could not be made. A block stands without it; a pass with this set is not acted on and not kept (see `unfinished`). */
  unchecked?: Unchecked;
}

/**
 * Share of the coin's pool liquidity that's locked or burned (%), weighted by each pool's USD liquidity;
 * a plain average when RugCheck has no USD values. null = no pool data.
 */
/**
 * Pools whose liquidity is not a fungible LP token but positions (Orca Whirlpools, Raydium CLMM, Meteora DLMM): "% locked" does
 * not describe them the way it does an AMM pool, because who owns the positions is the question, not how much LP is burned.
 */
export const isConcentratedMarket = (marketType: string | undefined): boolean => /clmm|whirlpool|orca|dlmm|concentrated/i.test(marketType ?? "");

export function lockedLiquidityPct(rc: RugCheckSummary | null, opts: { skipConcentrated?: boolean } = {}): number | null {
  const pools = (rc?.markets ?? []).filter((m) => m.lp && typeof m.lp.lpLockedPct === "number" && !(opts.skipConcentrated && isConcentratedMarket(m.marketType)));
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
  opts: {
    blockMintAuthority: boolean; maxRiskScore: number; allowlist: string[]; minLockedPct?: number; maxTransferFeeBps?: number; concentratedPools?: "block" | "warn";
    /** A pass needs RugCheck's answer (the default). false = with no answer, the on-chain checks alone decide. */
    requireRugcheck?: boolean;
  },
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
    // A hook program runs on every transfer and can refuse a sell. An authority with no program yet can still set one.
    if (ext.extension === "transferHook" && (st.programId || st.authority)) blocks.push(st.programId ? "a transfer hook runs custom code on every transfer (it can refuse a sell)" : "a transfer hook can still be added (hook authority)");
  }
  // What the contract does to a trade beyond the authorities above: a transfer fee (taken from every buy and sell) and the like.
  for (const t of tradeTraits(profileMint(onchain), { maxFeeBps: opts.maxTransferFeeBps ?? 100 })) (t.severity === "block" ? blocks : warnings).push(t.text);
  if (trusted && blocks.length) blocks.length = 0;

  const score = typeof rc?.score_normalised === "number" ? rc.score_normalised : null;
  let unchecked: Unchecked | undefined;
  if (rc) {
    if (score !== null && score >= opts.maxRiskScore && !trusted) blocks.push(`RugCheck risk score ${score}/100`);
    const minLocked = opts.minLockedPct ?? 0;
    // Default: every pool counts. With concentrated pools set to "warn" they are left out of the lock figure (it doesn't describe
    // positions) and, if they hold the liquidity, say so instead of blocking.
    const skip = opts.concentratedPools === "warn";
    const locked = lockedLiquidityPct(rc, { skipConcentrated: skip });
    const concentrated = (rc?.markets ?? []).filter((m) => m.lp && isConcentratedMarket(m.marketType));
    if (minLocked > 0 && !trusted) {
      if (locked === null && skip && concentrated.length) warnings.push("liquidity is in concentrated-liquidity positions, so no lock figure applies (who owns the positions isn't checked)");
      else if (locked === null) {
        // No pool to read a lock from: the rule can neither pass nor fail, so the look is not finished.
        warnings.push("liquidity lock unknown (RugCheck has no pool data yet)");
        unchecked = "lock_unknown";
      } else if (locked < minLocked) {
        const hint = concentrated.length && !skip ? "; part of it sits in concentrated-liquidity positions, where this figure doesn't describe ownership (LP_CONCENTRATED_POOLS=warn to leave those out)" : "";
        blocks.push(`liquidity not locked: only ${Math.round(locked)}% of the pool liquidity is locked or burned (needs ${minLocked}%)${hint}`);
      } else if (skip && concentrated.length) warnings.push("part of the liquidity is in concentrated-liquidity positions, not counted in the lock figure");
    }
    for (const r of rc.risks ?? []) {
      const n = r.name.toLowerCase();
      if (/rugged|honeypot|scam/.test(n) && !trusted) blocks.push(`RugCheck: ${r.name}`);
      else if (!/mint authority|freeze authority|permanent control/.test(n)) warnings.push(`${r.name}${r.level === "danger" ? " (RugCheck: danger)" : ""}`);
    }
  } else {
    warnings.push("RugCheck unavailable — on-chain checks only");
    // Its score, its flags and the liquidity lock are all missing.
    if (!trusted && (opts.requireRugcheck ?? true)) unchecked = "rugcheck_down";
  }
  return { verdict: blocks.length ? "blocked" : "pass", blocks: [...new Set(blocks)], warnings: [...new Set(warnings)], rugcheckScore: score, ...(unchecked ? { unchecked } : {}) };
}

export async function readMint(mint: string): Promise<OnchainMint> {
  const res = await fetchJson<{ result?: { value?: { owner?: string; data?: { parsed?: { info?: Record<string, unknown> } } } }; error?: { message: string } }>(copyRpcUrl(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [mint, { encoding: "jsonParsed" }] }),
  });
  if (res.error) throw new Error(res.error.message);
  const info = res.result?.value?.data?.parsed?.info;
  if (!info) throw new Error("not a token mint");
  return {
    tokenProgram: res.result?.value?.owner ?? null,
    mintAuthority: (info.mintAuthority as string | null) ?? null,
    freezeAuthority: (info.freezeAuthority as string | null) ?? null,
    extensions: (info.extensions as OnchainMint["extensions"]) ?? [],
  };
}

/** RugCheck's report, or null when it gave none. A report without its score counts as none: the score rule can't be applied to it. */
export async function readRugCheck(mint: string): Promise<RugCheckSummary | null> {
  try {
    const report = await fetchJson<RugCheckSummary | null>(`https://api.rugcheck.xyz/v1/tokens/${mint}/report`, { retries: 0, timeoutMs: 10_000 });
    return typeof report?.score_normalised === "number" ? report : null;
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

/** Everything one look at a token found: the raw inputs as well as the verdict (the shadow log keeps them all). */
export interface Screen {
  /** null = Solana couldn't be read. */
  onchain: OnchainMint | null;
  /** null = RugCheck gave no usable answer (or wasn't asked, because Solana couldn't be read). */
  rc: RugCheckSummary | null;
  holders: HolderMetrics | null;
  /** off = holder check disabled or the coin is trusted · failed / timeout = couldn't be measured (the live path then skips the buy). */
  holdersStatus: "ok" | "off" | "failed" | "timeout";
  /** Judged from whatever was read; null when Solana couldn't be read. */
  verdict: RugVerdict | null;
  chainMs: number;
  rugcheckMs: number;
  holdersMs: number | null;
}

async function runScreen(mint: string): Promise<Screen> {
  const t0 = Date.now();
  let onchain: OnchainMint;
  try {
    onchain = await readMint(mint);
  } catch {
    return { onchain: null, rc: null, holders: null, holdersStatus: "off", verdict: null, chainMs: Date.now() - t0, rugcheckMs: 0, holdersMs: null };
  }
  const chainMs = Date.now() - t0;
  const t1 = Date.now();
  const rc = await readRugCheck(mint);
  const rugcheckMs = Date.now() - t1;
  const verdict = judgeRugRisk(mint, onchain, rc, {
    blockMintAuthority: config.rugBlockMintAuthority, maxRiskScore: config.rugMaxRiskScore, allowlist: config.rugAllowlist, minLockedPct: config.lpMinLockedPct,
    maxTransferFeeBps: config.rugMaxTransferFeeBps, concentratedPools: config.lpConcentratedPools, requireRugcheck: config.rugRequireRugcheck,
  });
  // Bundled or clustered supply. If the holders can't be read in time, the live path doesn't trade it this cycle (fail closed).
  let holders: HolderMetrics | null = null;
  let holdersStatus: Screen["holdersStatus"] = "off";
  let holdersMs: number | null = null;
  if (config.holderCheckEnabled && !config.rugAllowlist.includes(mint) && mint !== SOL_MINT) {
    const t2 = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      measureHolders(mint, insiderPctFromReport(rc)).then(
        (m) => ({ m }),
        () => ({ m: null }),
      ),
      new Promise<{ m: null; timeout: true }>((r) => {
        timer = setTimeout(() => r({ m: null, timeout: true }), config.holderCheckTimeoutMs);
      }),
    ]);
    clearTimeout(timer);
    holdersMs = Date.now() - t2;
    if (outcome.m) {
      holders = outcome.m;
      holdersStatus = "ok";
      const holderBlocks = judgeHolders(holders, {
        bundleMaxPct: config.bundleMaxPct, clusterMaxPct: config.clusterMaxPct, top10MaxPct: config.top10MaxPct, insiderMaxPct: config.insiderMaxPct,
      });
      verdict.blocks.push(...holderBlocks);
      verdict.warnings.push(`Holders: ${describeHolders(holders)}`);
      if (holderBlocks.length) verdict.verdict = "blocked";
    } else holdersStatus = "timeout" in outcome ? "timeout" : "failed";
  }
  return { onchain, rc, holders, holdersStatus, verdict, chainMs, rugcheckMs, holdersMs };
}

/** Looks at a token fresh (no cache). Two callers asking about the same token at once share one look. */
const looking = new Map<string, Promise<Screen>>();
export function screenToken(mint: string): Promise<Screen> {
  let p = looking.get(mint);
  if (!p) {
    p = runScreen(mint).finally(() => looking.delete(mint));
    looking.set(mint, p);
  }
  return p;
}

/** What RugCheck's report said, in the few numbers worth keeping. */
export function rugcheckFacts(rc: RugCheckSummary | null): { ok: boolean; score: number | null; pools: number; lockedPct: number | null } {
  return {
    ok: rc !== null,
    score: typeof rc?.score_normalised === "number" ? rc.score_normalised : null,
    pools: (rc?.markets ?? []).filter((m) => m.lp).length,
    lockedPct: lockedLiquidityPct(rc),
  };
}

/** Stores a finished verdict as the token's cached rug check. */
export function saveVerdict(db: DB, mint: string, symbol: string, v: RugVerdict, announce = true): void {
  const before = db.prepare("SELECT verdict FROM rug_checks WHERE mint = ?").get(mint) as { verdict: string } | undefined;
  db.prepare(
    `INSERT INTO rug_checks (mint, symbol, verdict, blocks, warnings, rugcheck_score, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(mint) DO UPDATE SET symbol=excluded.symbol, verdict=excluded.verdict, blocks=excluded.blocks, warnings=excluded.warnings,
       rugcheck_score=excluded.rugcheck_score, checked_at=excluded.checked_at`,
  ).run(mint, symbol, v.verdict, JSON.stringify(v.blocks), JSON.stringify(v.warnings), v.rugcheckScore, nowIso());
  if (announce && v.verdict === "blocked" && before?.verdict !== "blocked") say("warn", `Rug check: won't trade ${symbol} — ${v.blocks.join("; ")}.`);
}

/** Why a look can't be acted on. */
export type Unfinished = "chain_unreadable" | "holders_failed" | "holders_timeout" | Unchecked;

/** Why this look can't be acted on, or null when it can (fail closed: an unfinished look is no buy, and it is not kept). */
export function unfinished(s: Screen): Unfinished | null {
  if (!s.verdict) return "chain_unreadable";
  if (s.holdersStatus === "failed") return "holders_failed";
  if (s.holdersStatus === "timeout") return "holders_timeout";
  // A block stands by itself; a pass needs everything it rests on.
  return s.verdict.verdict === "pass" ? (s.verdict.unchecked ?? null) : null;
}

/** The same, in plain words (no address). */
export const UNFINISHED_TEXT: Record<Unfinished, string> = {
  chain_unreadable: "couldn't read the token on Solana",
  holders_failed: "couldn't read the token's holders",
  holders_timeout: "reading the token's holders took too long",
  rugcheck_down: "RugCheck gave no answer",
  lock_unknown: "RugCheck has no pool data yet, so the liquidity lock is unknown",
};

/** One look's answer: a verdict to act on, or why there is none. */
export type RugLook = { verdict: RugVerdict; why: null } | { verdict: null; why: Unfinished };

/** Checks a token (cached for RUG_CHECK_CACHE_HOURS). A look that couldn't be finished gives no verdict and says why. */
export async function rugLook(db: DB, mint: string, symbol: string): Promise<RugLook> {
  const cached = db.prepare("SELECT * FROM rug_checks WHERE mint = ?").get(mint) as RugCheckRow | undefined;
  if (cached && Date.now() - new Date(cached.checked_at).getTime() < config.rugCheckCacheHours * 3_600_000) {
    return { verdict: { verdict: cached.verdict, blocks: JSON.parse(cached.blocks), warnings: JSON.parse(cached.warnings), rugcheckScore: cached.rugcheck_score }, why: null };
  }
  const s = await screenToken(mint);
  const why = unfinished(s);
  if (why) return { verdict: null, why };
  saveVerdict(db, mint, symbol, s.verdict!);
  return { verdict: s.verdict!, why: null };
}

/** The verdict alone: null when the look couldn't be finished. */
export async function rugCheck(db: DB, mint: string, symbol: string): Promise<RugVerdict | null> {
  return (await rugLook(db, mint, symbol)).verdict;
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
