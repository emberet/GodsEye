/**
 * THE LIVE BOOK — every wallet seen swapping on the gRPC stream, in memory.
 *
 * For each wallet it keeps its last swaps (up to 60, without signatures, to keep memory down), so GodsEye can work out
 * a live realized P&L (in USD at settlement, and SOL) and a live AI / human score for wallets it has never
 * analyzed. Idle wallets are forgotten after a while; the busiest are kept if
 * memory gets tight. Running totals are written to the wallet_activity table
 * (see stream.ts), so the dashboard can list everyone, not just analyzed wallets.
 */
import type { ParsedSwap } from "../chain/parse";
import { classify } from "../analysis/classifier";
import { positionWon, realize, type SwapLite } from "../analysis/pnl";
import type { WalletKind } from "@godseye/shared";

/** 150,000 wallets × 200 swaps filled Node's 4 GB heap; 60 is plenty for live P&L and the bot/human score. */
const MAX_SWAPS_PER_WALLET = 60;

export interface LiveWallet {
  address: string;
  firstSeen: number;
  lastSeen: number;
  swaps: number;
  buys: number;
  sells: number;
  volumeSol: number;
  recent: SwapLite[];
  pnlSol: number;
  pnlUsd: number;
  closed: number;
  wins: number;
  kind: WalletKind;
  aiScore: number | null;
  promoted: boolean;
  dirty: boolean;
  /** Sells since P&L was last recomputed (P&L only changes on sells). */
  sellsSinceScore: number;
  /** Swap count when the bot/human score was last computed. */
  swapsAtClassify: number;
}

export class LiveBook {
  private wallets = new Map<string, LiveWallet>();

  constructor(private opts: { maxWallets: number; idleMs: number; earlyBuySeconds: number }) {}

  get size(): number {
    return this.wallets.size;
  }

  get(address: string): LiveWallet | undefined {
    return this.wallets.get(address);
  }

  record(s: ParsedSwap, now = Date.now()): LiveWallet {
    let w = this.wallets.get(s.wallet);
    if (!w) {
      w = { address: s.wallet, firstSeen: now, lastSeen: now, swaps: 0, buys: 0, sells: 0, volumeSol: 0, recent: [], pnlSol: 0, pnlUsd: 0, closed: 0, wins: 0, kind: "unknown", aiScore: null, promoted: false, dirty: true, sellsSinceScore: 0, swapsAtClassify: 0 };
      this.wallets.set(s.wallet, w);
    }
    w.lastSeen = now;
    w.swaps++;
    w.volumeSol += s.solAmount;
    if (s.side === "buy") w.buys++;
    else {
      w.sells++;
      w.sellsSinceScore++;
    }
    // No signature: live scoring never needs it, and it's the biggest field.
    w.recent.push({ signature: "", ts: s.ts, mint: s.mint, side: s.side, token_amount: s.tokenAmount, sol_amount: s.solAmount, usd_amount: s.usdAmount, price_sol: s.priceSol, venue: s.venue, jito_tip: s.jitoTip ? 1 : 0, token_age_sec: null });
    if (w.recent.length > MAX_SWAPS_PER_WALLET) w.recent.splice(0, w.recent.length - MAX_SWAPS_PER_WALLET);
    w.dirty = true;
    return w;
  }

  /** Recompute live P&L (wallets that sold since last time) and AI/human (wallets with new swaps). */
  rescore(): void {
    for (const w of this.wallets.values()) {
      const reclassify = w.recent.length >= 8 && w.swaps !== w.swapsAtClassify;
      if (w.sellsSinceScore === 0 && !reclassify) continue; // nothing new: leave it (and don't rewrite it)
      if (w.sellsSinceScore > 0) {
        const r = realize(w.recent, this.opts.earlyBuySeconds);
        w.pnlSol = r.events.reduce((s, e) => s + e.pnlSol, 0);
        w.pnlUsd = r.events.reduce((s, e) => s + (e.pnlUsd ?? 0), 0);
        w.closed = r.closed.length;
        w.wins = r.closed.filter(positionWon).length;
        w.sellsSinceScore = 0;
      }
      if (reclassify) {
        const c = classify(w.recent);
        w.kind = c.kind;
        w.aiScore = c.score;
        w.swapsAtClassify = w.swaps;
      }
      w.dirty = true;
    }
  }

  /** Wallets worth a full analysis: making real money (USD at settlement) across several closed trades. */
  promotable(minPnlUsd: number, minClosed: number): LiveWallet[] {
    return [...this.wallets.values()].filter((w) => !w.promoted && w.pnlUsd >= minPnlUsd && w.closed >= minClosed && w.wins / Math.max(1, w.closed) >= 0.5);
  }

  /** Wallets winning big right now (smart-money candidates from the stream alone). */
  smartCandidates(minPnlUsd: number, minClosed: number, minWinRate: number): LiveWallet[] {
    return [...this.wallets.values()].filter((w) => w.pnlUsd >= minPnlUsd && w.closed >= minClosed && w.wins / w.closed >= minWinRate);
  }

  /** Forget idle wallets; if still over the cap, drop the least active. */
  evict(now = Date.now()): number {
    let n = 0;
    for (const [a, w] of this.wallets) {
      if (now - w.lastSeen > this.opts.idleMs && !w.dirty) {
        this.wallets.delete(a);
        n++;
      }
    }
    return n + this.shrinkTo(this.opts.maxWallets);
  }

  /** Keep at most `max` wallets: drop the least active (already saved) ones. Never drops wallets queued for analysis. */
  shrinkTo(max: number): number {
    if (this.wallets.size <= max) return 0;
    const victims = [...this.wallets.values()].filter((w) => !w.dirty && !w.promoted).sort((a, b) => a.swaps - b.swaps || a.lastSeen - b.lastSeen);
    let n = 0;
    for (const w of victims.slice(0, this.wallets.size - max)) {
      this.wallets.delete(w.address);
      n++;
    }
    return n;
  }

  /** Wallets changed since the last flush (and marks them clean). */
  takeDirty(): LiveWallet[] {
    const out: LiveWallet[] = [];
    for (const w of this.wallets.values()) {
      if (w.dirty) {
        w.dirty = false;
        out.push(w);
      }
    }
    return out;
  }
}
