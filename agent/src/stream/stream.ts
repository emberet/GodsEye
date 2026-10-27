/**
 * LIVE STREAM — every DEX swap on Solana, as it confirms, over gRPC.
 *
 * Works with any Yellowstone-protocol gRPC (Shyft, Triton, Helius, QuickNode):
 * set GRPC_URL and GRPC_TOKEN in .env. Each transaction that touches a DEX
 * program is parsed by the same balance-change parser used for history, then:
 *   • a leader's swap  → straight to the copy engine (no polling delay)
 *   • a tracked wallet → stored in wallet_swaps, so its stats stay current
 *   • every wallet     → the live book: live P&L (USD at settlement) and AI/human score; wallets
 *                        making real money get promoted to full analysis
 *   • smart money      → recorded, with signals when several smart wallets move together (smart/)
 * Reconnects on its own: with backoff, or every STREAM_IP_RETRY_MS while the provider rejects this IP.
 * STREAM_PARSER=rust takes the parsed stream from the Rust ingest service instead (rust-client.ts); compare keeps
 * this TypeScript path and only logs how the Rust results differ. Default "ts": unchanged.
 */
import { getHeapStatistics } from "node:v8";
import Client, { CommitmentLevel, type SubscribeRequest, type SubscribeUpdate } from "@triton-one/yellowstone-grpc";
import { type DB, nowIso, setMeta } from "@godseye/shared";
import { config } from "../config";
import { say, short } from "../log";
import { parseSwaps, type ParsedSwap } from "../chain/parse";
import { solUsdAt } from "../market/solprice";
import { VENUES } from "../chain/programs";
import { insertSwaps } from "../analysis/analyze";
import { addWallet } from "../discovery/discover";
import type { LeaderWatcher } from "../copy/watcher";
import { convertGrpcTx, type GrpcTxInfo } from "./convert";
import { LiveBook } from "./live-book";
import { SmartMoney } from "../smart/smart-money";
import { CompareStats, RustIngestClient, comparable, eventSwaps, type IngestEvent } from "./rust-client";
import type { TxLike } from "../chain/parse";

const PING_MS = 10_000;
const FLUSH_MS = 15_000;

/** The gRPC client hides the server's reason in `cause` (e.g. "client IP … is not whitelisted"). */
function describe(e: unknown): string {
  const err = e as Error & { cause?: unknown };
  const cause = err.cause ? String(err.cause) : "";
  const reason = cause.match(/message: "([^"]+)"/)?.[1] ?? cause;
  const text = reason ? `${err.message}: ${reason}` : err.message;
  return (config.grpcToken ? text.split(config.grpcToken).join("***") : text).slice(0, 240);
}

const IP_REJECTED = /client IP (\S+) is not whitelisted/;
const HUNT_SUMMARY_MS = 10 * 60_000;

/** Pure: how long to wait after a failed connect. An allowlist rejection is retried at a steady pace (the
 *  IP changes every minute or so and one of the allowlisted ones comes up again); anything else backs off. */
export function retryPlan(message: string, backoffMs: number, ipRetryMs: number): { ip: string | null; delayMs: number; nextBackoffMs: number } {
  const ip = message.match(IP_REJECTED)?.[1] ?? null;
  if (ip) return { ip, delayMs: ipRetryMs, nextBackoffMs: 1_000 };
  return { ip: null, delayMs: backoffMs, nextBackoffMs: Math.min(60_000, backoffMs * 2) };
}

/** Pure: counts rejected IPs while waiting for an allowlisted one, and says what's worth logging. */
export class IpHunt {
  tries = 0;
  private ips = new Set<string>();
  private since = 0;
  private lastSummary = 0;

  get distinct(): number {
    return this.ips.size;
  }

  /** Returns a line to log: the first rejection, then a summary every 10 minutes; otherwise null. */
  note(ip: string, now: number): string | null {
    const first = this.tries === 0;
    if (first) this.since = this.lastSummary = now;
    this.tries++;
    this.ips.add(ip);
    if (first) return `Live stream: Shyft turned away IP ${ip} (not on the allowlist). Retrying every ${Math.round(config.streamIpRetryMs / 1000)}s until an allowlisted IP comes up; quiet until then, with a summary every 10 min.`;
    if (now - this.lastSummary < HUNT_SUMMARY_MS) return null;
    this.lastSummary = now;
    return `Live stream: still waiting for an allowlisted IP — ${this.tries} tries, ${this.ips.size} different IPs in ${Math.round((now - this.since) / 60_000)} min, none allowed. \`npm run stream:ips\` shows which come up most.`;
  }

  /** Clears the count; returns how the wait went, if there was one. */
  reset(now: number): string | null {
    const out = this.tries ? `after ${this.tries} tries over ${Math.max(1, Math.round((now - this.since) / 60_000))} min` : null;
    this.tries = 0;
    this.ips.clear();
    return out;
  }
}

export function streamConfigured(): boolean {
  return !!config.grpcUrl || config.streamParser === "rust";
}

export class LiveStream {
  readonly book = new LiveBook({ maxWallets: config.streamMaxWallets, idleMs: config.streamIdleHours * 3_600_000, earlyBuySeconds: config.earlyBuySeconds });
  private tracked = new Set<string>();
  private pendingSwaps: ParsedSwap[] = [];
  private stats = { txs: 0, swaps: 0, since: Date.now() };
  private retryMs = 1_000;
  private hunt = new IpHunt();
  private stopped = false;
  private timers: NodeJS.Timeout[] = [];
  private rust: RustIngestClient | null = null;
  private compare: CompareStats | null = null;
  readonly smart: SmartMoney;

  constructor(
    private db: DB,
    private watcher: LeaderWatcher,
  ) {
    this.smart = new SmartMoney(db, this.book, { lookupNames: true });
  }

  /** Re-read which wallets are in the database (call after discovery / promotion). */
  refreshTracked(): void {
    this.tracked = new Set((this.db.prepare("SELECT address FROM wallets").all() as { address: string }[]).map((r) => r.address));
  }

  start(): void {
    this.refreshTracked();
    this.timers.push(setInterval(() => this.flush(), FLUSH_MS));
    this.timers.push(setInterval(() => this.promote(), 60_000));
    if (config.streamParser === "rust") {
      this.rust = new RustIngestClient(config.geIngestSocket, (e) => this.onRustEvent(e), (s, d) => this.onRustStatus(s, d));
      this.rust.start();
      return;
    }
    if (config.streamParser === "compare") {
      const stats = (this.compare = new CompareStats());
      this.rust = new RustIngestClient(config.geIngestSocket, (e) => stats.add("rust", e.signature, e.needsPrice ? null : comparable(e.swaps), Date.now()), (s, d) => this.onRustStatus(s, d));
      this.rust.start();
      this.timers.push(
        setInterval(() => {
          stats.expire(Date.now());
          const line = stats.report();
          if (line) say("info", line);
        }, 60_000),
      );
    }
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    this.rust?.stop();
    this.flush();
    setMeta(this.db, "stream_status", "stopped");
  }

  private request(): SubscribeRequest {
    const programs = config.streamPrograms.length ? config.streamPrograms : Object.keys(VENUES);
    return {
      accounts: {},
      slots: {},
      transactions: { dex: { vote: false, failed: false, accountInclude: programs, accountExclude: [], accountRequired: [] } },
      transactionsStatus: {},
      blocks: {},
      blocksMeta: {},
      entry: {},
      blockFooter: {},
      accountsDataSlice: [],
      commitment: CommitmentLevel.CONFIRMED,
    } as SubscribeRequest;
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    let ping: NodeJS.Timeout | undefined;
    try {
      const client = new Client(config.grpcUrl, config.grpcToken || undefined, {
        grpcMaxDecodingMessageSize: 64 * 1024 * 1024,
        grpcHttp2KeepAliveInterval: 15_000,
        grpcKeepAliveTimeout: 10_000,
        grpcKeepAliveWhileIdle: true,
      });
      await client.connect();
      const stream = await client.subscribe(this.request());
      const waited = this.hunt.reset(Date.now());
      say("info", `Live stream connected (${new URL(config.grpcUrl).host})${waited ? ` ${waited} of waiting for an allowlisted IP` : ""}: watching every DEX swap on Solana.`);
      setMeta(this.db, "stream_status", "connected");
      setMeta(this.db, "stream_ip_tries", 0);
      this.retryMs = 1_000;
      let id = 0;
      ping = setInterval(() => {
        // Keeps the connection alive through load balancers that drop idle streams. The full filter is
        // re-sent with the ping because every write replaces the subscription.
        stream.write({ ...this.request(), ping: { id: ++id } } as SubscribeRequest, () => undefined);
      }, PING_MS);
      await new Promise<void>((resolve, reject) => {
        stream.on("data", (u: SubscribeUpdate) => this.onUpdate(u));
        stream.on("error", reject);
        stream.on("end", resolve);
        stream.on("close", resolve);
      });
      say("warn", "Live stream ended; reconnecting.");
    } catch (e) {
      const message = describe(e);
      const plan = retryPlan(message, this.retryMs, config.streamIpRetryMs);
      this.retryMs = plan.nextBackoffMs;
      if (plan.ip) {
        this.recordIp(plan.ip);
        const line = this.hunt.note(plan.ip, Date.now());
        if (line) say("warn", line);
        setMeta(this.db, "stream_status", "waiting_for_ip");
        setMeta(this.db, "stream_ip_tries", this.hunt.tries);
        setMeta(this.db, "stream_ip_distinct", this.hunt.distinct);
      } else {
        say("warn", `Live stream error: ${message}. Reconnecting in ${Math.round(plan.delayMs / 1000)}s.`);
        setMeta(this.db, "stream_status", "reconnecting");
      }
      if (ping) clearInterval(ping);
      await new Promise((r) => setTimeout(r, plan.delayMs));
      void this.connect();
      return;
    }
    if (ping) clearInterval(ping);
    setMeta(this.db, "stream_status", "reconnecting");
    await new Promise((r) => setTimeout(r, this.retryMs));
    this.retryMs = Math.min(60_000, this.retryMs * 2);
    void this.connect();
  }

  /** Remembers an IP the provider turned away (counted once per minute for `npm run stream:ips`). */
  private recordIp(ip: string): void {
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO stream_ip_seen (ip, tries, minutes, first_seen, last_seen) VALUES (?, 1, 1, ?, ?)
         ON CONFLICT(ip) DO UPDATE SET tries = tries + 1,
           minutes = minutes + (substr(last_seen, 1, 16) <> substr(excluded.last_seen, 1, 16)), last_seen = excluded.last_seen`,
      )
      .run(ip, now, now);
  }

  private onUpdate(u: SubscribeUpdate): void {
    const t = u.transaction;
    if (!t?.transaction) return;
    this.stats.txs++;
    const now = Date.now();
    const conv = convertGrpcTx(t.transaction as unknown as GrpcTxInfo, Number(t.slot), now);
    if (!conv) return;
    const all: ParsedSwap[] = [];
    for (const signer of conv.signers) {
      const swaps = parseSwaps(conv.tx, signer, { solUsdAt });
      if (this.compare) all.push(...swaps);
      this.onSignerSwaps(signer, swaps, conv.tx, now);
    }
    if (this.compare) this.compare.add("ts", conv.tx.transaction.signatures[0], comparable(all), now);
  }

  private onSignerSwaps(signer: string, swaps: ParsedSwap[], tx: TxLike, now: number): void {
    if (!swaps.length) return;
    this.stats.swaps += swaps.length;
    for (const swap of swaps) {
      this.book.record(swap, now);
      this.smart.onSwap(swap, now);
    }
    if (this.watcher.isWatching(signer)) void this.watcher.handleStreamed(signer, tx, now);
    else if (this.tracked.has(signer)) this.pendingSwaps.push(...swaps);
  }

  /** STREAM_PARSER=rust: one event from ge-ingest, handled exactly like a gRPC update. */
  private onRustEvent(e: IngestEvent): void {
    this.stats.txs++;
    const now = Date.now();
    for (const { signer, swaps } of eventSwaps(e, { solUsdAt })) this.onSignerSwaps(signer, swaps, e.tx, now);
  }

  private onRustStatus(s: "connected" | "disconnected", detail?: string): void {
    if (s === "connected") say("info", `Rust ingest connected (${config.geIngestSocket}, STREAM_PARSER=${config.streamParser}).`);
    else say("warn", `Rust ingest socket ${config.geIngestSocket} unavailable; ${detail ?? "retrying"}.`);
    if (config.streamParser === "rust") setMeta(this.db, "stream_status", s === "connected" ? "connected" : "reconnecting");
  }

  /** Writes stored swaps for tracked wallets and running totals for everyone. */
  flush(): void {
    try {
      if (this.pendingSwaps.length) {
        const batch = this.pendingSwaps.splice(0);
        insertSwaps(this.db, batch);
        const touch = this.db.prepare("UPDATE wallets SET last_activity_at = MAX(COALESCE(last_activity_at, ''), ?) WHERE address = ?");
        this.db.transaction(() => batch.forEach((s) => touch.run(s.ts, s.wallet)))();
      }
      this.smart.flush();
      this.book.rescore();
      const dirty = this.book.takeDirty();
      const up = this.db.prepare(
        `INSERT INTO wallet_activity (address, first_seen_at, last_seen_at, swaps, buys, sells, volume_sol, live_pnl_sol, live_pnl_usd, live_closed, live_wins, live_kind, live_ai_score, promoted)
         VALUES (@address, @first, @last, @swaps, @buys, @sells, @volume, @pnl, @pnlUsd, @closed, @wins, @kind, @ai, @promoted)
         ON CONFLICT(address) DO UPDATE SET last_seen_at=excluded.last_seen_at, swaps=excluded.swaps, buys=excluded.buys, sells=excluded.sells,
           volume_sol=excluded.volume_sol, live_pnl_sol=excluded.live_pnl_sol, live_pnl_usd=excluded.live_pnl_usd, live_closed=excluded.live_closed, live_wins=excluded.live_wins,
           live_kind=excluded.live_kind, live_ai_score=excluded.live_ai_score, promoted=MAX(promoted, excluded.promoted)`,
      );
      this.db.transaction(() => {
        for (const w of dirty) {
          up.run({
            address: w.address, first: new Date(w.firstSeen).toISOString(), last: new Date(w.lastSeen).toISOString(), swaps: w.swaps, buys: w.buys, sells: w.sells,
            volume: w.volumeSol, pnl: w.pnlSol, pnlUsd: w.pnlUsd, closed: w.closed, wins: w.wins, kind: w.kind, ai: w.aiScore, promoted: w.promoted || this.tracked.has(w.address) ? 1 : 0,
          });
        }
      })();
      this.book.evict();
      this.guardMemory();
      const secs = (Date.now() - this.stats.since) / 1000;
      setMeta(this.db, "stream_last_at", nowIso());
      setMeta(this.db, "stream_tx_per_sec", (this.stats.txs / secs).toFixed(1));
      setMeta(this.db, "stream_swaps_per_sec", (this.stats.swaps / secs).toFixed(1));
      setMeta(this.db, "stream_wallets_in_memory", this.book.size);
      setMeta(this.db, "agent_heap_mb", Math.round(process.memoryUsage().heapUsed / 1e6));
      this.stats = { txs: 0, swaps: 0, since: Date.now() };
    } catch (e) {
      say("error", `Live stream flush failed: ${(e as Error).message}`);
    }
  }

  private lastMemoryWarn = 0;

  /**
   * The live book is the agent's biggest memory user. If the heap passes 70% of Node's limit, forget the
   * least-active live wallets (their totals are already saved) instead of running out of memory and crashing.
   */
  private guardMemory(): void {
    const limit = getHeapStatistics().heap_size_limit;
    const used = process.memoryUsage().heapUsed;
    if (used < limit * 0.7) return;
    const n = this.book.shrinkTo(Math.floor(this.book.size * 0.6));
    if (Date.now() - this.lastMemoryWarn > 10 * 60_000) {
      this.lastMemoryWarn = Date.now();
      say("warn", `Memory at ${Math.round(used / 1e6).toLocaleString("en-US")} of ${Math.round(limit / 1e6).toLocaleString("en-US")} MB: forgot the ${n.toLocaleString("en-US")} least-active live wallets (keeping ${this.book.size.toLocaleString("en-US")}).`);
    }
  }

  /** Daily housekeeping: drop activity rows for wallets not seen in ACTIVITY_RETENTION_DAYS. */
  prune(): void {
    const before = new Date(Date.now() - config.activityRetentionDays * 86_400_000).toISOString();
    this.db.prepare("DELETE FROM wallet_activity WHERE last_seen_at < ? AND promoted = 0").run(before);
  }

  /** Wallets making real money on the stream get a full analysis. */
  private promote(): void {
    const list = this.book.promotable(config.streamPromotePnlUsd, config.streamPromoteMinClosed);
    let n = 0;
    for (const w of list) {
      w.promoted = true;
      w.dirty = true;
      const detail = `${w.pnlUsd >= 0 ? "+" : "−"}$${Math.abs(w.pnlUsd).toFixed(0)} realized over ${w.closed} closed trades seen live (${w.wins} wins)`;
      if (addWallet(this.db, w.address, "live_stream", detail)) {
        n++;
        if (n <= 5) say("wallet", `Live stream: ${short(w.address)} is making money (${detail}) — queued for full analysis.`);
      }
    }
    if (n) {
      this.refreshTracked();
      if (n > 5) say("wallet", `Live stream: ${n} profitable wallets queued for full analysis.`);
    }
  }
}
