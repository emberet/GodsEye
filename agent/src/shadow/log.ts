/**
 * SHADOW LOG — measure rugs before risking SOL.
 *
 * Every first copyable leader buy of a token (a memecoin, from a leader with weight, at least MIN_LEADER_BUY_SOL) is
 * written to shadow_candidates the moment the copy engine sees it — whether or not GodsEye then copies it. Each is
 *   1. rug-screened right away with the real screen (market/rugcheck.ts), keeping the raw inputs (authorities, Token-2022
 *      extensions, RugCheck score and lock, top-10 / bundle / cluster / insider shares) next to the verdict and the cutoffs
 *      in force, so cutoffs can be re-tuned later without re-reading the chain;
 *   2. followed by sampler.ts, which records price, liquidity and a Jupiter sell quote 1 min … 24 h later.
 * It needs no SOL and changes no copy decision: it runs beside the engine, never in front of it, and every failure is
 * swallowed. A finished screen also fills the rug-check cache, so the live path reuses it instead of reading the chain again.
 * Read it with `npm run shadow`.
 */
import { type DB, nowIso } from "@godseye/shared";
import { config } from "../config";
import type { ParsedSwap } from "../chain/parse";
import { copySize } from "../learning/weights";
import { rugcheckFacts, saveVerdict, screenToken, type Screen } from "../market/rugcheck";
import { solUsdAt } from "../market/solprice";
import { cachedTokenInfo } from "../market/tokens";

export type ScreenStatus = "pending" | "done" | "chain_unreadable" | "holders_failed" | "holders_timeout" | "queue_full" | "error";

/** The cutoffs the screen is using right now (kept with each verdict, because they get re-tuned). */
export function currentLimits(): Record<string, number | boolean> {
  return {
    bundleMaxPct: config.bundleMaxPct,
    clusterMaxPct: config.clusterMaxPct,
    top10MaxPct: config.top10MaxPct,
    insiderMaxPct: config.insiderMaxPct,
    lpMinLockedPct: config.lpMinLockedPct,
    rugMaxRiskScore: config.rugMaxRiskScore,
    blockMintAuthority: config.rugBlockMintAuthority,
    holderCheckEnabled: config.holderCheckEnabled,
  };
}

export function screenStatusOf(s: Screen): ScreenStatus {
  if (!s.verdict) return "chain_unreadable";
  if (s.holdersStatus === "failed") return "holders_failed";
  if (s.holdersStatus === "timeout") return "holders_timeout";
  return "done";
}

export class ShadowLogger {
  private active = 0;
  private waiting: (() => void)[] = [];
  private pending = new Set<Promise<void>>();

  /** `screen` is replaceable so tests never touch the network. */
  constructor(
    private db: DB,
    private screen: (mint: string) => Promise<Screen> = screenToken,
  ) {}

  /**
   * Logs the first copyable leader buy of a token and starts its screen. Returns the candidate id, or null if this
   * token is already logged. Never throws and never waits for the screen.
   */
  observe(swap: ParsedSwap, seenAt: number, weight: number, symbol: string): number | null {
    try {
      const info = cachedTokenInfo(this.db, swap.mint);
      const launched = info?.pool_created_at ? Date.parse(info.pool_created_at) : NaN;
      const tokenAge = Number.isFinite(launched) ? Math.max(0, (Date.parse(swap.ts) - launched) / 1000) : null;
      const solUsd = swap.solUsd ?? solUsdAt(Date.now());
      const row = this.db
        .prepare(
          `INSERT OR IGNORE INTO shadow_candidates
             (mint, symbol, leader, leader_signature, leader_ts, leader_weight, seen_at, leader_sol, entry_price_sol, entry_price_usd, sim_size_sol, token_age_sec, venue, limits)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          swap.mint, symbol, swap.wallet, swap.signature, swap.ts, weight, new Date(seenAt).toISOString(), swap.solAmount, swap.priceSol,
          solUsd ? swap.priceSol * solUsd : null, copySize(weight, config) || config.copyMinTradeSol, tokenAge, swap.venue, JSON.stringify(currentLimits()),
        );
      if (row.changes === 0) return null;
      const id = Number(row.lastInsertRowid);
      this.start(id, swap.mint, symbol);
      return id;
    } catch (e) {
      console.warn(`Shadow log: couldn't record ${swap.mint}: ${(e as Error).message}`);
      return null;
    }
  }

  /** What the copy engine did with the leader trade that made this candidate (only the first decision is kept). */
  setOutcome(swap: ParsedSwap, outcome: string): void {
    try {
      this.db.prepare("UPDATE shadow_candidates SET copy_outcome = ? WHERE mint = ? AND leader_signature = ?").run(outcome, swap.mint, swap.signature);
    } catch {
      /* observation only */
    }
  }

  /** Resolves when every screen started so far has finished. */
  async idle(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  private start(id: number, mint: string, symbol: string): void {
    if (this.active >= config.shadowMaxScreens && this.waiting.length >= config.shadowMaxQueue) {
      this.db.prepare("UPDATE shadow_candidates SET screen_status = 'queue_full' WHERE id = ?").run(id);
      return;
    }
    const p = this.slot().then(async (release) => {
      try {
        await this.run(id, mint, symbol);
      } finally {
        release();
      }
    });
    const tracked = p.finally(() => this.pending.delete(tracked));
    this.pending.add(tracked);
  }

  private slot(): Promise<() => void> {
    const release = () => {
      this.active--;
      this.waiting.shift()?.();
    };
    if (this.active < config.shadowMaxScreens) {
      this.active++;
      return Promise.resolve(release);
    }
    return new Promise((resolve) =>
      this.waiting.push(() => {
        this.active++;
        resolve(release);
      }),
    );
  }

  private async run(id: number, mint: string, symbol: string): Promise<void> {
    const t0 = Date.now();
    try {
      const s = await this.screen(mint);
      const status = screenStatusOf(s);
      const rc = rugcheckFacts(s.rc);
      const h = s.holders;
      this.db
        .prepare(
          `UPDATE shadow_candidates SET screen_status = ?, screened_at = ?, screen_ms = ?, chain_ms = ?, rugcheck_ms = ?, holders_ms = ?,
             verdict = ?, blocks = ?, warnings = ?, mint_authority = ?, freeze_authority = ?, extensions = ?,
             rugcheck_ok = ?, rugcheck_score = ?, rugcheck_pools = ?, lp_locked_pct = ?,
             top10_pct = ?, launch_bundle_pct = ?, launch_buyers = ?, cluster_pct = ?, cluster_size = ?, cluster_from_creator = ?, insider_pct = ?
           WHERE id = ?`,
        )
        .run(
          status, nowIso(), Date.now() - t0, s.chainMs, s.rugcheckMs, s.holdersMs,
          // A verdict only counts when the whole screen finished, as on the live path.
          status === "done" ? s.verdict!.verdict : null,
          s.verdict ? JSON.stringify(s.verdict.blocks) : null,
          s.verdict ? JSON.stringify(s.verdict.warnings) : null,
          s.onchain?.mintAuthority ?? null, s.onchain?.freezeAuthority ?? null, s.onchain ? JSON.stringify(s.onchain.extensions) : null,
          s.onchain ? (rc.ok ? 1 : 0) : null, rc.score, s.onchain ? rc.pools : null, rc.lockedPct,
          h?.top10Pct ?? null, h?.launchBundlePct ?? null, h?.launchBuyers ?? null, h?.clusterPct ?? null, h?.clusterSize ?? null,
          h ? (h.clusterFromCreator ? 1 : 0) : null, h?.insiderPct ?? null,
          id,
        );
      if (status === "done") saveVerdict(this.db, mint, symbol, s.verdict!, false);
    } catch (e) {
      try {
        this.db.prepare("UPDATE shadow_candidates SET screen_status = 'error', screened_at = ?, screen_ms = ? WHERE id = ?").run(nowIso(), Date.now() - t0, id);
      } catch {
        /* observation only */
      }
      console.warn(`Shadow log: screen of ${mint} failed: ${(e as Error).message}`);
    }
  }
}
