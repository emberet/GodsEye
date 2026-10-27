# GodsEye Rust ingest (`rust/ingest`)

An optional, read-only Rust port of the live-stream hot path. Nothing here signs or sends a transaction or holds a key.
The agent keeps using its TypeScript parser unless `STREAM_PARSER` says otherwise (default `ts`).

| crate | what |
|---|---|
| `ge-parse` | Byte-for-byte port of `agent/src/chain/parse.ts` (`parseSwaps`, `detectVenue`, routed SOL) and `agent/src/stream/convert.ts`, plus the bot signs as pure functions: median hold, same-block round trips (`computeStats` in pnl.ts), tx/hour (`txPerHourFrom`), `botReason` (copy-check.ts). JS number semantics are reproduced (f64 arithmetic in the same order, `Math.round`, `10 ** d`, `Number(str)`, `JSON.stringify` number formatting via ryu-js, `toISOString`). |
| `ge-ingest` | Service: Yellowstone gRPC (or a replay file) -> convert -> parse -> one NDJSON event per transaction on a unix socket, Prometheus metrics on HTTP. |

## Run

```sh
cd rust/ingest
cargo build --release
# live (same variables as the agent)
GRPC_URL=https://grpc.example GRPC_TOKEN=... ./target/release/ge-ingest
# replay a fixture file (no network); waits for a socket client, then exits when done
GE_INGEST_REPLAY=fixtures/real.ndjson ./target/release/ge-ingest
```

Then in the agent's `.env`: `STREAM_PARSER=compare` first (TS results used, differences logged every minute), and
`STREAM_PARSER=rust` only once compare shows no differences. Remove the line (or `ts`) to go back.

| variable | default | meaning |
|---|---|---|
| `GRPC_URL`, `GRPC_TOKEN` | | Yellowstone endpoint and `x-token`. The token is never logged. |
| `STREAM_PROGRAMS` | the agent's `VENUES` | comma-separated program ids (accountInclude), same as the agent |
| `GE_INGEST_SOCKET` | `/tmp/godseye-ingest.sock` | unix socket, created mode 0600; every connected client gets every event |
| `GE_INGEST_METRICS_ADDR` | `127.0.0.1:9466` | `GET /metrics` (Prometheus text), `GET /healthz` |
| `GE_INGEST_REPLAY` | | replay this fixture NDJSON instead of connecting to gRPC |
| `GE_INGEST_REPLAY_RATE` | `0` (as fast as possible) | transactions per second when replaying |
| `GE_INGEST_REPLAY_LOOP` | `0` | `1` = replay forever |
| `GE_INGEST_REPLAY_NO_WAIT` | `0` | `1` = start replaying without waiting for a client |
| `GE_INGEST_BUFFER` | `65536` | events buffered per slow client before the oldest are dropped (counted in `ge_ingest_dropped_events_total`) |
| `STREAM_IP_RETRY_MS` | `10000` | retry pace while the provider rejects this IP (as in the agent); other errors back off to 60 s |

gRPC: subscribe with `vote: false, failed: false, accountInclude: STREAM_PROGRAMS`, commitment CONFIRMED, a ping every
10 s that re-sends the full filter (same as stream.ts). Protos are vendored from yellowstone-grpc `v10.0.2+solana.3.0.6`.

## Event schema v1

One JSON object per line, one line per non-vote transaction that has a message and meta:

```json
{"v":1,"signature":"5x...","slot":312345678,"receivedAtMs":1761550000123,"lagMs":420,
 "signers":["Wallet..."],"needsPrice":false,"swaps":[ParsedSwap...],"tx":TxLike}
```

| field | meaning |
|---|---|
| `v` | schema version, `1`. Clients skip other versions. |
| `signature`, `slot` | first signature (base58), slot |
| `receivedAtMs` | ms since epoch when ge-ingest received the update (also the swap `ts`, as gRPC has no block time) |
| `lagMs` | receive time minus the provider's `created_at`, null when absent (and in replay) |
| `signers` | the transaction's signers, in order (convert.ts) |
| `needsPrice` | true when a signer has a USDC/USDT balance in the transaction. Such swaps need a SOL/USD price, which the service does not have: the consumer re-parses `tx` itself. |
| `swaps` | every signer's swaps, signer order, exactly as `parseSwaps` prints them with `JSON.stringify`, but parsed without a price: `solUsd` and `usdAmount` are null and USDC/USDT-priced swaps are absent. The agent sets `solUsd = price`, `usdAmount = price ? solAmount * price : null` (rust-client.ts `applyPrice`), which is the parser's own arithmetic for non-stable swaps. |
| `tx` | the converted transaction as convert.ts builds it (`TxLike`: slot, blockTime null, meta, signatures, accountKeys with lookup-table keys appended, program ids). `meta.err` is `{"failed":true}` or null. |

## Metrics (`/metrics`)

`ge_ingest_tx_total`, `ge_ingest_swaps_total`, `ge_ingest_events_total`, `ge_ingest_parse_errors_total`,
`ge_ingest_dropped_events_total`, `ge_ingest_reconnects_total`, `ge_ingest_tx_per_sec`, `ge_ingest_swaps_per_sec`,
`ge_ingest_lag_ms` (last), `ge_ingest_lag_ms_avg`, `ge_ingest_last_slot`, `ge_ingest_clients`, `ge_ingest_connected`.

## Equivalence (golden fixtures)

`fixtures/` holds shared NDJSON inputs (gRPC-shaped transactions: base58 bytes, string lamports) and the TypeScript
outputs as goldens:

| set | contents |
|---|---|
| `tests` | the scenarios from `agent/test/parse.test.ts` |
| `synthetic` | 3000 seeded transactions across 24 shapes (buys, sells, new and closed token accounts, Token-2022 rent, wSOL, USDC/USDT and SOL+USDC, routed token-to-token, two tokens, airdrops, non-memecoins, dust, huge amounts, second signer, missing uiTokenAmount or meta, votes, failed) |
| `real` | 320 mainnet transactions (40 per default program) fetched over public RPC |
| `bot` | 500 random closed-position histories for the bot signs |

* `cargo test`: Rust output == golden, byte for byte, for every line; bot signs == golden; protobuf round trip; price
  applied in Node == golden; the program tables match the TypeScript sources; `<set>.events.ndjson` is current.
* `npm test` (agent/test/rust-golden.test.ts): the TypeScript parser still produces the goldens, and the Rust events
  (`*.events.ndjson`) pushed through the rust-mode path (applyPrice or TS re-parse) equal the goldens.

Regenerate after a parser change: `npm run rust:fixtures -w agent -- golden`, then
`GE_UPDATE_EVENTS=1 cargo test` here. New real transactions: `npm run rust:fixtures -w agent -- fetch [RPC_URL] [N]`.

## Benchmarks (measured)

Measured 2026-10-27 on an 8-vCPU Intel Xeon VM, rustc 1.99.1 (`cargo bench`, criterion, release, thin LTO) and
Node 20.19.2 (`npm run bench:parse -w agent`, median of 50 passes after 20 warm-up). Same inputs on both sides,
already decoded from protobuf; both convert (including base58) and parse every signer.

| workload | TypeScript | Rust | speed-up |
|---|---|---|---|
| convert + parse, 320 real tx | 8,760 tx/s | 114,650 tx/s | 13x |
| convert + parse, 3000 synthetic tx | 23,059 tx/s | 351,120 tx/s | 15x |
| ge-ingest full path per update: protobuf decode + convert + parse + event line, real | n/a | 22,992 tx/s | |
| protobuf decode only, real | n/a | 93,892 tx/s | |
| event line only, real | n/a | 55,201 tx/s | |

These are single-thread CPU numbers for the parser, not end-to-end latency. In rust mode Node still JSON-parses every
event (a few KB each), so the agent-side saving is smaller than the parser speed-up.
