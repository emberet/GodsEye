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
 * WARNINGS (logged + shown, not blocking — common on legit big tokens):
 *   • top holders own a lot (often exchanges / pools) · LP not locked
 *   • transfer hook · mutable metadata
 * If Solana can't be read, the token is skipped this cycle (fail closed).
 */
import { type DB, nowIso, SOL_MINT } from "@godseye/shared";
import { config } from "../config";
import { fetchJson } from "../http";
import { rpcUrl } from "../config";
import { say } from "../log";

export interface OnchainMint {
  mintAuthority: string | null;
  freezeAuthority: string | null;
  extensions: { extension: string; state?: Record<string, unknown> }[];
}

export interface RugCheckSummary {
  score_normalised?: number;
  risks?: { name: string; level: string; description?: string }[];
  lpLockedPct?: number;
}

export interface RugVerdict {
  verdict: "pass" | "blocked";
  blocks: string[];
  warnings: string[];
  rugcheckScore: number | null;
}

/** Pure decision logic (easy to test). */
export function judgeRugRisk(
  mint: string,
  onchain: OnchainMint,
  rc: RugCheckSummary | null,
  opts: { blockMintAuthority: boolean; maxRiskScore: number; allowlist: string[] },
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
    return await fetchJson<RugCheckSummary>(`https://api.rugcheck.xyz/v1/tokens/${mint}/report/summary`, { retries: 0, timeoutMs: 10_000 });
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
  const v = judgeRugRisk(mint, onchain, await readRugCheck(mint), {
    blockMintAuthority: config.rugBlockMintAuthority, maxRiskScore: config.rugMaxRiskScore, allowlist: config.rugAllowlist,
  });
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
