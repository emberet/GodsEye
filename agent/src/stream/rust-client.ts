/**
 * Optional Rust ingest (rust/ingest, `ge-ingest`): reads its NDJSON events from GE_INGEST_SOCKET.
 * Selected with STREAM_PARSER (default "ts", which does not use this file at all):
 *   • rust    – the agent does not open its own gRPC stream; swaps come from ge-ingest. The service has no SOL/USD
 *               price, so Node applies the price here (applyPrice), and transactions flagged `needsPrice` (a signer
 *               holds USDC/USDT) are re-parsed by the TypeScript parser from the event's `tx`.
 *   • compare – the agent keeps its own gRPC stream and TypeScript results (behaviour unchanged) and also reads the
 *               socket, matching transactions by signature and logging how many agree, differ, or were seen by only
 *               one side, with a few samples of each difference.
 * The service never signs or sends anything; this client only reads.
 * Event schema v1 is documented in rust/ingest/README.md.
 */
import { createConnection, type Socket } from "node:net";
import { parseSwaps, type ParsedSwap, type ParseOptions, type TxLike } from "../chain/parse";

export const EVENT_SCHEMA_VERSION = 1;

export interface IngestEvent {
  v: number;
  signature: string;
  slot: number;
  receivedAtMs: number;
  lagMs: number | null;
  signers: string[];
  needsPrice: boolean;
  /** Parsed without a price: solUsd/usdAmount null, USDC/USDT-priced swaps absent (see needsPrice). */
  swaps: ParsedSwap[];
  tx: TxLike;
}

/** Pure: give swaps parsed without a price the price the TypeScript parser would have used (same arithmetic). */
export function applyPrice(swaps: ParsedSwap[], solUsdAt?: ParseOptions["solUsdAt"]): ParsedSwap[] {
  return swaps.map((s) => {
    const price = solUsdAt ? solUsdAt(Date.parse(s.ts)) : null;
    return { ...s, solUsd: price, usdAmount: price ? s.solAmount * price : null };
  });
}

/** Pure: the swaps of one event, per signer in signer order, exactly as the TypeScript stream would produce them. */
export function eventSwaps(e: IngestEvent, opts: ParseOptions): { signer: string; swaps: ParsedSwap[] }[] {
  if (e.needsPrice) return e.signers.map((signer) => ({ signer, swaps: parseSwaps(e.tx, signer, opts) }));
  const priced = applyPrice(e.swaps, opts.solUsdAt);
  return e.signers.map((signer) => ({ signer, swaps: priced.filter((s) => s.wallet === signer) }));
}

/** Pure: the fields compared in compare mode. ts, solUsd and usdAmount depend on when each side received the
 *  transaction (block time is absent on gRPC), so they are left out. */
export function comparable(swaps: ParsedSwap[]): string {
  return JSON.stringify(swaps.map(({ ts: _t, solUsd: _p, usdAmount: _u, ...rest }) => rest));
}

/** Pure: matches the two sides by signature and keeps counts plus a few samples of each kind of difference. */
export class CompareStats {
  matched = 0;
  same = 0;
  differ = 0;
  tsOnly = 0;
  rustOnly = 0;
  skippedNeedsPrice = 0;
  samples: string[] = [];
  private pending = new Map<string, { side: "ts" | "rust"; value: string | null; at: number }>();

  constructor(
    private ttlMs = 30_000,
    private maxSamples = 5,
  ) {}

  get waiting(): number {
    return this.pending.size;
  }

  /** `value` null = not comparable (a needsPrice event, priced only on the TS side). */
  add(side: "ts" | "rust", signature: string, value: string | null, now: number): void {
    const other = this.pending.get(signature);
    if (!other) {
      this.pending.set(signature, { side, value, at: now });
      return;
    }
    if (other.side === side) return; // duplicate delivery on one side
    this.pending.delete(signature);
    if (value === null || other.value === null) {
      this.skippedNeedsPrice++;
      return;
    }
    this.matched++;
    if (other.value === value) this.same++;
    else {
      this.differ++;
      if (this.samples.length < this.maxSamples) {
        const [ts, rust] = side === "ts" ? [value, other.value] : [other.value, value];
        this.samples.push(`${signature}\n  ts:   ${ts.slice(0, 600)}\n  rust: ${rust.slice(0, 600)}`);
      }
    }
  }

  /** Signatures one side saw and the other did not within the TTL. */
  expire(now: number): void {
    for (const [sig, p] of this.pending) {
      if (now - p.at < this.ttlMs) continue;
      this.pending.delete(sig);
      if (p.value === null) this.skippedNeedsPrice++;
      else if (p.side === "ts") this.tsOnly++;
      else this.rustOnly++;
    }
  }

  /** One log line, then counters reset. Null when nothing happened. */
  report(): string | null {
    if (!this.matched && !this.tsOnly && !this.rustOnly && !this.skippedNeedsPrice) return null;
    const line =
      `Parser compare (TS vs Rust): ${this.matched} matched, ${this.same} identical, ${this.differ} different, ` +
      `${this.tsOnly} TS-only, ${this.rustOnly} Rust-only, ${this.skippedNeedsPrice} needsPrice skipped` +
      (this.samples.length ? `. Samples:\n${this.samples.join("\n")}` : ".");
    this.matched = this.same = this.differ = this.tsOnly = this.rustOnly = this.skippedNeedsPrice = 0;
    this.samples = [];
    return line;
  }
}

/** Reads events from the unix socket; reconnects with backoff. Read-only. */
export class RustIngestClient {
  private sock: Socket | null = null;
  private stopped = false;
  private retryMs = 1_000;
  private buf = "";
  connected = false;
  badLines = 0;

  constructor(
    private path: string,
    private onEvent: (e: IngestEvent) => void,
    private onStatus: (s: "connected" | "disconnected", detail?: string) => void = () => undefined,
  ) {}

  start(): void {
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.sock?.destroy();
  }

  private connect(): void {
    if (this.stopped) return;
    const sock = createConnection(this.path);
    this.sock = sock;
    sock.setEncoding("utf8");
    sock.on("connect", () => {
      this.connected = true;
      this.retryMs = 1_000;
      this.onStatus("connected");
    });
    sock.on("data", (chunk: string) => this.feed(chunk));
    sock.on("error", () => undefined); // "close" follows
    sock.on("close", () => {
      const was = this.connected;
      this.connected = false;
      this.buf = "";
      if (this.stopped) return;
      this.onStatus("disconnected", `retrying in ${Math.round(this.retryMs / 1000)}s`);
      setTimeout(() => this.connect(), was ? 1_000 : this.retryMs);
      this.retryMs = Math.min(30_000, this.retryMs * 2);
    });
  }

  /** Splits the byte stream into lines (exposed for tests). */
  feed(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (!line.trim()) continue;
      let e: IngestEvent;
      try {
        e = JSON.parse(line) as IngestEvent;
      } catch {
        this.badLines++;
        continue;
      }
      if (e.v !== EVENT_SCHEMA_VERSION) {
        this.badLines++;
        continue;
      }
      this.onEvent(e);
    }
  }
}
