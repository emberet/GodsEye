# Real-time data infrastructure for tracking wallets' memecoin trades on Solana (latency, completeness, cost)

Access date for all pages and prices below: 2026-10-27 (pages fetched live that day; search-snippet-only facts are flagged). Context: GodsEye already runs a Yellowstone-style gRPC stream and parses swaps from balance changes, so the notes concentrate on what changes the decision: what the network looks like now (200 ms slots, Alpenglow), what each provider costs, where shred-level data really helps, and what to join in.

Evidence-quality warning: nearly every latency benchmark found is published by a vendor selling a competing product (RPC Fast, Shyft, OrbitFlare, Shreder, Alchemy). No independent third-party provider ranking was found. Treat all ms figures as directional.

---

## 1. Data-ingestion options: latency, commitment tradeoffs, 2026 pricing, filter limits, reliability/backfill

### Takeaway
For a copy-trader already on Yellowstone-style gRPC, the realistic choices are: stay on `processed` gRPC (the lowest-latency path that still carries full execution metadata), and optionally add a shred-derived early-signal feed (RabbitStream / OrbitFlare Jetstream / Triton shreds) that leads gRPC by only single-digit to low-hundreds of ms depending on whose benchmark you believe. Jito ShredStream was officially scheduled for shutdown on 2026-09-05 (replacement DoubleZero Edge). Pricing has fragmented: flat monthly (Shyft, Helius add-ons), bandwidth-metered (Triton $0.08/GB, Alchemy $75/TB, QuickNode credits), so a thousands-of-wallets filter that is narrow is cheap on metered plans and a wide program-wide firehose is expensive.

### Cited Findings

**Network baseline (changes all latency math)**
- Mainnet slot time is now 200 ms: 350 ms on Aug 21, 300 ms Aug 28, 250 ms Sep 18, 200 ms on Oct 9, 2026 (epoch 1053, slot 454,896,000); epochs are now ~24 h — [Solana: reduced slot times](https://solana.com/upgrades/reduced-slot-times)
- Alpenglow consensus switch was scheduled for Oct 21, 2026 (~14:50 UTC; slot 459,653,000 retires TowerBFT). Per Solana Foundation guidance relayed by Solana Compass: `confirmed` and `finalized` become the same state, finality target ~150 ms (down from 12.8 s) but "an expectation, not a constant"; vote transactions leave blocks (votes ~63% of tx before); tick entries leave the data stream — [Solana Compass, Oct 13 2026](https://solanacompass.com/news/anza-sets-alpenglow-mainnet-date-solanas-consensus-switch-is-scheduled-for-october-21-at-about-1450-utc)
- Agave 4.3 tags every Geyser/gRPC event with a `bank_id` because a slot can carry more than one candidate block; the Foundation advises buffering by slot and `bank_id`, keeping the confirmed candidate, and reconciling feeds from different providers on blockhash — [Solana Compass](https://solanacompass.com/news/anza-sets-alpenglow-mainnet-date-solanas-consensus-switch-is-scheduled-for-october-21-at-about-1450-utc)
- Helius docs (generic, pre-Alpenglow wording): processed ~400 ms, confirmed ~2–3 s, finalized ~15–30 s — [Helius LaserStream latency guide](https://www.helius.dev/docs/laserstream/guides/measuring-latency.md), [Helius WebSocket docs](https://www.helius.dev/docs/laserstream/websocket.md)

**Yellowstone gRPC / Dragon's Mouth (protocol facts)**
- Commitment enum PROCESSED=0, CONFIRMED=1, FINALIZED=2; streams default to processed; confirmed/finalized are buffered server-side and Triton recommends handling commitment client-side by buffering events per slot and releasing on slot-status notifications. Some finalized notifications are not issued, so mark ancestors finalized when you see a finalized slot — [Triton docs](https://docs.triton.one/rpc-pool/grpc-subscriptions)
- Triton documents no hard size cap on `account_include`; recommends a compressed cuckoo-filter account filter once tracking roughly 100+ accounts; about 1% of updates can be false positives so re-verify against your exact set locally — [Triton docs](https://docs.triton.one/rpc-pool/grpc-subscriptions)
- Replay: `from_slot` works only within the server's retained window (check `first_available` via `SubscribeReplayInfo`); replay uses the same filters/commitment; starts at a slot boundary so duplicates are possible; Rust client auto-reconnect (v13.1.0+, off by default) with `RecoverMissedData` (default since 13.3.0) resumes from last processed slot, falls back to live if outside the window; `SkipMissedData` loses outage data. Each new subscribe request overwrites the previous one, so keep a local copy of the full config. Idle-stream closing by load balancers: send pings (server pongs ~15 s) — [Triton docs](https://docs.triton.one/rpc-pool/grpc-subscriptions)
- Server-side operator limits exist in the open-source server (`grpc.filters`: `account_include_max`, `account_max`, etc.; unlimited if omitted), so provider caps are policy not protocol; open-source server rate-limiting is "not yet implemented"; validator-generated blocks always report zero entries; default gRPC client max message 4 MB — [yellowstone-grpc README](https://github.com/rpcpool/yellowstone-grpc); 4 MB figure: [search snippet summarising Solana docs](https://solana.com/zh/docs/payments/accept-payments/indexing)
- `SubscribeDeshred` (pre-execution decoded transactions, with ALT-loaded addresses but no status/logs/inner instructions/balances) returns UNIMPLEMENTED on the open-source server; only on Triton's extension branch `master-triton-ext` — [yellowstone-grpc README](https://github.com/rpcpool/yellowstone-grpc)

**Helius LaserStream (gRPC) + Enhanced WebSockets + webhooks**
- Plans: Free $0 (no LaserStream), Developer $49 (LaserStream devnet only; Enhanced WS included), Business $499 (100M credits, 200 rps, LaserStream mainnet), Professional $999 (200M credits, 500 rps, mainnet). Data add-ons (Professional only): 5 TB $400, 10 TB $750, 25 TB $1,750, 50 TB $3,250, 100 TB $6,000; overage 2 credits per 0.1 MB. Shred Delivery: $1,000/month per IP ($800 on Professional). Page FAQ says "$500" for the 5 TB add-on vs $400 in table (internal discrepancy) — [Helius plans](https://www.helius.dev/docs/billing/plans.md)
- LaserStream: processed/confirmed/finalized; replay "limited to the last ~48 hours (~691,200 slots)", replays older than ~20 min return finalized-only data; SDK auto-reconnect; multi-node failover listed; cuckoo-filter for >~10,000 accounts (3–4 bytes/account, "hundreds of thousands of accounts" per stream; Rust & JS SDKs); no numeric filter caps published; no connection-limit numbers published. Seven mainnet regions: ewr, pitt, slc, ams, fra, tyo, sgp — [Helius LaserStream gRPC](https://www.helius.dev/docs/laserstream/grpc.md), [Helius latency guide](https://www.helius.dev/docs/laserstream/guides/measuring-latency.md)
- Helius publishes no typical LaserStream latency number, no vendor comparison; recommends `processed` and a two-parallel-stream test from the same region — [Helius latency guide](https://www.helius.dev/docs/laserstream/guides/measuring-latency.md)
- Enhanced WebSocket `transactionSubscribe`: 2 credits per 0.1 MB streamed + 1 credit per connection; "up to 200 ms faster than standard Agave RPC-based WebSockets"; 10-minute inactivity timer, ping at least every minute; reconnect with exponential backoff (1 s to 30 s cap) + restore subscriptions; no numeric subscription cap published — [Helius WebSocket docs](https://www.helius.dev/docs/laserstream/websocket.md)
- Webhooks: types = enhanced, raw, discord; 1 credit per event delivered (even if your endpoint fails), 100 credits per create/edit/delete; no delivery guarantee stated, retries can create duplicates; auto-disabled at ≥95% failure over 7 days (24 h on Free); no latency number and no max-address number on the page (a figure of 100,000 addresses was NOT supported by the page) — [Helius webhooks](https://www.helius.dev/docs/webhooks.md)
- Helius "Parsed Streams" is presented as the successor to enhanced-transaction webhooks, also 1 credit/event — [Helius webhooks](https://www.helius.dev/docs/webhooks.md); product page: [Helius parsed streams](https://www.helius.dev/docs/parsed-streams)

**Triton One**
- Pricing page lists a single PAYG plan, $125 minimum prepaid deposit (non-refundable, valid 12 months); streaming services $0.08/GB bandwidth; unary RPC $0.08/GB + $10 per million calls; all features on every endpoint; limits described only as "flexible". The page does not name Dragon's Mouth/Yellowstone but streaming is $0.08/GB. Shred Streaming (per IP, per data centre): Frankfurt/Amsterdam $1,500/mo or $0.59 per 15 min; London/NY/Tokyo $900/mo or $0.35 per 15 min. "Preconfs" (Jito BAM and Harmonic): the greater of $0.0015/slot or $50 per million messages — [Triton pricing](https://triton.one/pricing)
- Competitor-sourced figures (lower reliability): Corvus Labs says Triton Yellowstone is PAYG at $0.08/GB; OrbitFlare says Triton gRPC is included on dedicated nodes from ~$5,000/mo — [Corvus Labs](https://docs.corvus-labs.io/platform/pricing-comparison), [OrbitFlare vs Triton (via search snippet)](https://orbitflare.com/compare/triton)

**Shyft**
- Free $0 (no gRPC); Build $199 (10 gRPC connections), Grow $349 (20), Accelerate $649 (50); extra connections $100 per 10; unlimited IPs, no subscribe-rate limit on new plans (old plan: 1 IP, 50 subscribe requests/min); RabbitStream included on Build/Grow/Accelerate (no separate price); dedicated Solana RPC from $1,800/mo; dedicated gRPC price not listed; flat fee, no bandwidth metering per Shyft's marketing — [Shyft pricing](https://shyft.to/solana-rpc-grpc-pricing), [Shyft gRPC page (via search)](https://www.shyft.to/solana-yellowstone-grpc)
- RabbitStream: ingests raw UDP shreds from multiple sources, shred decode only server-side before delivery, so data arrives "before any execution, log, or balance change is recorded" (Shyft's wording). Vendor benchmark vs Jito ShredStream (geyserbench v1.2.2, 10,000+ tx/run): RabbitStream first 92.7–98.6% of the time; when Jito was behind, p50 3.8–6.7 ms, p99 15–82 ms (Frankfurt/NY/Amsterdam). Both delivered 100% of valid transactions; no comparison against Yellowstone gRPC on that page — [Shyft RabbitStream vs Jito ShredStream](https://docs.shyft.to/solana-shredstreaming/rabbitstream-vs-jito-shredstream-benchmarks)

**QuickNode**
- From June 1, 2026 Solana gRPC is included in Scale ($499/mo) and Business plans; metered at 10 API credits per 0.1 MB of data delivered; Build/Accelerate keep the paid add-on (Accelerate + add-on = $748/mo). Earlier add-on: from $499/mo, up to 25 feeds, historical replay up to 3,000 recent slots — [QuickNode blog (search snippet; page not fetched)](https://www.quicknode.com/hi/blog/solana-grpc-is-now-included-with-scale-and-business-plans), [QuickNode marketplace add-on](https://marketplace.quicknode.com/add-on/yellowstone-grpc-geyser-plugin)

**Alchemy (alternative)**
- Solana gRPC: $75 per TB streamed, no monthly minimum. Public benchmark (Oct 14–16 2026, PumpSwap account stream, `processed`, 20,000 tx per region, Fly runners, geyserbench `latency` example): p90 +2.4 to +13.1 ms and p99 +6.8 to +23.6 ms behind the fastest delivery within a run across six regions (p50 column = TCP RTT: 1.8 ms US East, 15.6 US West, 21.9 EU West, 5.2 EU Central, 4.3 Singapore, 3.3 Tokyo). Explicitly not end-to-end validator latency, not a provider ranking, does not measure missed events/reconnect/backfill — [Alchemy methodology](https://www.alchemy.com/blog/solana-grpc-benchmark-methodology)

**Other gRPC resellers (search-snippet level only)**
- Solana Tracker: Yellowstone bundled with Business (€399/mo) / Professional (€799/mo) shared plans and dedicated nodes, flat-rate plan €200/mo; Solana Vibe Station $150–250/mo — [Solana Tracker](https://www.solanatracker.io/yellowstone-grpc), [Solana Vibe Station](https://docs.solanavibestation.com/services/solana-node-services/geyser-grpc-streaming)

**Shred-level feeds (earlier than gRPC, no execution result)**
- Jito ShredStream docs page carries a sunset notice: shutdown September 5, 2026; migrate to DoubleZero Edge. Requirements had been Discord approval of a pubkey, UDP 20000, no NAT, max two regions; ~1,200-byte shreds; optional gRPC proxy emitting decoded `Entry` transactions; "hundreds of milliseconds" claim without benchmarks — [Jito docs](https://docs.jito.wtf/lowlatencytxnfeed/)
- OrbitFlare (competitor, biased) says Jito announced the deprecation in early July and lists replacements: OrbitFlare Shredstream (raw UDP shreds, nine regions, 60-minute free trial) and Jetstream V2 (server-side deshredding, filtered decoded transactions over gRPC, includes ALT resolution). Its Frankfurt test (10,014 tx): OrbitFlare first 95.93%; when Jito behind: p50 6.51 ms, p99 28.77 ms. No DoubleZero Edge latency data — [OrbitFlare on dev.to](https://dev.to/orbitflarerpc/jito-shredstreams-last-slot-your-two-ways-out-53np)
- RPC Fast (vendor) reports: Jito-enabled node received 99.71% of ~185k matched tx faster, average advantage 120 ms, p99 ~270 ms (vs a default node); same vendor's pages claim ShredStream gRPC leads Yellowstone by "~50–100 ms" on one page, a 4.82 ms median lead (99.9% win rate, 58,688 tx, single Frankfurt observer) on another, and "~2 minutes" on another (clearly erroneous/different setup). RPC Fast's SaaS Yellowstone plan caps: 10 concurrent streams, one filter per type, up to 10 pubkeys, block filters disabled; dedicated nodes not gated — [RPC Fast blog](https://rpcfast.com/blog/shredstream-vs-geyser-vs-standard-rpc), [RPC Fast docs via search](https://docs.rpcfast.com/solana-dedicated-nodes/solana-node-performance)
- Shreder (competitor, one Frankfurt run, 10,000 tx): Shreder Fastlane first for ~86% of matched tx vs ~14% for Helius LaserStream; p50 delta 2.92 ms, p99 45.08 ms — [Shreder benchmark](https://shreder.xyz/benchmarks/shreder-fastlane-vs-helius-laserstream/) (search snippet only)
- Aperture TxStream (RPC Fast) attaches a predicted execution result ("around 95% accurate") for ~791 µs added to median delivery — [RPC Fast blog](https://rpcfast.com/blog/shredstream-vs-geyser-vs-standard-rpc)

**Bitquery**
- CoreCast gRPC advertises <300 ms median; Kafka with offset replay <500 ms p95 (vendor figures); Kafka credentials require an enterprise plan; standard plans get GraphQL WebSocket subscriptions; gRPC requires at least one filter; no 2026 per-tier pricing found — [Bitquery CoreCast](https://www.bitquery.io/products/solana-grpc-streams), [Bitquery pump.fun guide](https://www.bitquery.io/blog/best-pump-fun-api)

**Standard WebSocket (logsSubscribe/accountSubscribe)**
- Helius says its Enhanced WebSocket is up to 200 ms faster than standard Agave WebSockets (implying standard WS is slower and less filterable); RPC Fast describes standard JSON-RPC/WebSocket as "easiest to integrate… but JSON-heavy and filter-light" — [Helius WS docs](https://www.helius.dev/docs/laserstream/websocket.md), [RPC Fast](https://rpcfast.com/blog/shredstream-vs-geyser-vs-standard-rpc)

**Birdeye (REST/WS, not a primary trade feed)**
- Tiers (per search summary of the official pricing page): Standard free 30,000 CU/mo at 1 rps; Starter $99 3M CU 15 rps; Premium $199 10M CU 50 rps; Business $699 70M CU 100 rps; WebSockets on Premium Plus ($250) per official table (a competitor wrongly said Premium); Wallet API group has its own lower limits; pay-per-request x402 route 100 req/s/IP — [Birdeye rate limiting](https://docs.birdeye.so/docs/rate-limiting), [Birdeye pricing (search summary; direct fetch 404'd after redirect)](https://docs.birdeye.so/docs/pricing)

### Inferences
- With 200 ms slots, `processed` is now roughly one slot (200 ms) from the leader producing the block; the entire benchmarked inter-provider spread (single-digit to ~25 ms at p99 within one provider, ~3–7 ms median shred lead in same-region tests) is small relative to your own execution path, so provider choice should be driven by completeness/failover/price, not by 5 ms differences.
- Vendor shred benchmarks disagree by 20x (4.8 ms median lead vs 50–120 ms average); the larger numbers likely compare against non-Jito default nodes. Expect low single-digit to low tens of ms against a well-peered Yellowstone provider; only a head-to-head with geyserbench on your own region can settle it.
- Shred feeds carry no logs/inner-instruction/token-balance metadata, so a balance-delta swap parser cannot run on them; you would have to decode instructions yourself (and resolve ALTs) and treat it as an unconfirmed "heads-up" to be reconciled with the gRPC result. Value is highest for leader-wallet detection, not for sizing the copy.
- Billing model matters more than headline price: Triton/Alchemy/QuickNode/Helius add-ons meter bytes, so a narrow wallet-only transaction filter is cheap while a program-wide firehose (all pump.fun/PumpSwap/Raydium txs with full meta) can reach terabytes per month. Shyft Build/Grow/Accelerate are flat but capped by connection count.
- Post-Alpenglow, `confirmed` ≈ `finalized`; if the foundation's ~150 ms finality holds, waiting for confirmation becomes far cheaper than the old 400 ms–2.5 s, but this is unmeasured in what I found.

### Gaps
- Official Triton Dragon's Mouth rate/connection limits and any filter caps: not published on the pricing or docs pages fetched.
- Helius LaserStream: no published max pubkeys per `account_include`, connection limits, or latency figure; Helius webhook max addresses per webhook not found on the page.
- QuickNode's current Yellowstone filter/connection limits and current docs: only blog/marketplace snippets seen; not fetched.
- Birdeye pricing page could not be fetched directly (404 after redirect); tier numbers come from a search summary of the official page.
- DoubleZero Edge docs/latency/pricing: not found; whether Jito actually shut ShredStream down on Sep 5 not confirmed (docs page still shows the notice).
- Whether Alpenglow actually activated on Oct 21, 2026: only pre-activation scheduling articles found; no post-activation confirmation or measured `confirmed` latency post-change.
- No independent (non-vendor) provider-vs-provider benchmark and no data on missed-event rates, gap frequency or reconnect times per provider.
- Bitquery per-tier pricing and QuickNode/Triton Yellowstone-specific limits for 2026: not found.

---

## 2. Tracking thousands of wallets cheaply: per-wallet vs program-wide, filter capacity, backfill

### Takeaway
Subscribe to a single transaction stream with an `account_include` list of the tracked wallets (or a cuckoo-filter compressed list for thousands) rather than per-wallet subscriptions or a program-wide stream filtered locally; this keeps bandwidth proportional to the wallets' actual activity. Backfill gaps with provider replay (`from_slot`, ~48 h on LaserStream) plus idempotent dedupe on signature.

### Cited Findings
- Transaction filters AND across fields and OR within arrays; `account_include` matches any listed account; `account_required` needs all; `vote:false`, `failed:false` filter out noise server-side — [yellowstone-grpc README](https://github.com/rpcpool/yellowstone-grpc), [Helius LaserStream example filter](https://www.helius.dev/docs/laserstream/grpc.md)
- For roughly 100+ accounts Triton recommends a compressed (cuckoo) account filter; Helius recommends it above ~10,000 accounts and says it handles "hundreds of thousands of accounts" in one stream at ~3–4 bytes per account (Rust/JS SDKs); expect ~1% false positives that you must drop locally — [Triton docs](https://docs.triton.one/rpc-pool/grpc-subscriptions), [Helius LaserStream](https://www.helius.dev/docs/laserstream/grpc.md)
- Each new `SubscribeRequest` replaces the previous one on that stream, so updating the wallet list means re-sending the full config; keep a local copy — [Triton docs](https://docs.triton.one/rpc-pool/grpc-subscriptions)
- Provider caps on lists vary: RPC Fast's SaaS Yellowstone tier allows only 10 pubkeys and one filter per type (dedicated unlimited); Shyft plans cap concurrent connections (10/20/50) not filters; open-source server caps are operator-set — [RPC Fast blog](https://rpcfast.com/blog/shredstream-vs-geyser-vs-standard-rpc), [Shyft pricing](https://shyft.to/solana-rpc-grpc-pricing), [yellowstone-grpc README](https://github.com/rpcpool/yellowstone-grpc)
- Backfill: Triton/Yellowstone `from_slot` replay limited to retained window, same filters/commitment, duplicates at the slot boundary, client auto-reconnect `RecoverMissedData`; Helius LaserStream replay ~48 h (~691,200 slots), older than ~20 min returns finalized only; QuickNode add-on historically replayed up to 3,000 recent slots — [Triton docs](https://docs.triton.one/rpc-pool/grpc-subscriptions), [Helius LaserStream](https://www.helius.dev/docs/laserstream/grpc.md), [QuickNode marketplace](https://marketplace.quicknode.com/add-on/yellowstone-grpc-geyser-plugin)
- Helius webhooks bill 1 credit per event delivered and may retry/duplicate; Helius Enhanced WS 2 credits/0.1 MB — both add per-event cost proportional to wallet activity — [Helius webhooks](https://www.helius.dev/docs/webhooks.md), [Helius WS docs](https://www.helius.dev/docs/laserstream/websocket.md)
- Because Agave 4.3 tags events with `bank_id`, and forks/candidate blocks can exist per slot, dedupe and reconcile on blockhash/signature, not slot alone — [Solana Compass](https://solanacompass.com/news/anza-sets-alpenglow-mainnet-date-solanas-consensus-switch-is-scheduled-for-october-21-at-about-1450-utc)

### Inferences
- Per-wallet `accountSubscribe` is wasteful (one subscription each, account updates not transactions, no ALT-aware transaction meta); a single multi-address transaction filter is the standard efficient pattern.
- Use two layers: (1) hot list of active/copy-targets via explicit `account_include` (cheap, exact); (2) wide watch-list (thousands) via cuckoo filter on a second stream or the same stream if the provider supports it, verified locally.
- A program-wide stream filtered locally is only worth it if you need market context (volume, other buyers); its bandwidth cost on metered plans can be dominated by pump.fun/PumpSwap traffic.
- Gap policy: persist last seen `(slot, signature)`; on reconnect request `from_slot = last_slot - N` and dedupe by signature; for gaps beyond the replay window, fall back to `getSignaturesForAddress` + `getTransaction` per wallet (not researched here, general knowledge, unverified).
- Redundancy: run two providers/regions in parallel and take the first-arriving, deduped on signature; this was the only reliability strategy implied by multi-source tests (not directly sourced).

### Gaps
- Actual tested ceilings for `account_include` length at Helius/Triton/Shyft/QuickNode (none published); whether a cuckoo-filter config is supported by Shyft/QuickNode gRPC endpoints.
- Failure/gap statistics per provider; whether replay is available on Shyft/QuickNode shared plans today.
- Cost model for a program-wide stream: no source quantified GB/day for pump.fun+PumpSwap+Raydium streams.

---

## 3. Parsing: balance-delta vs instruction decoding, venue pitfalls

### Takeaway
Balance-delta parsing (pre/post token + SOL balances, signer-centric) is venue-agnostic and robust to new programs, but must be hardened for ALTs, wSOL, Token-2022, fees/tips, and failed transactions. Pump.fun and PumpSwap changed their layouts repeatedly in 2026 (v2/v3 instructions, new events, virtual quote reserves, creator-fee and holder-reward changes), so instruction/event decoding of those programs needs version-aware handling.

### Cited Findings
- Pump.fun official docs list: new `create_v2`, `TRADE_V3` and `PUMP_SWAP_TRADE_V2` instruction docs; "bonding curve `create_v2` and trade instructions use new v3 and v2 layouts with fewer accounts. Parsers should handle both legacy and new instruction formats"; events gained fields (`CreateEvent`/`CreatePoolEvent.is_holder_reward`, `TradeEvent.holder_rewards_bps`, PumpSwap `BuyEvent`/`SellEvent.holder_rewards` and appended `virtual_quote_reserves`) — [pump-fun/pump-public-docs](https://github.com/pump-fun/pump-public-docs)
- `virtual_quote_reserves` is a signed `i128` and can be negative from Sept 30; effective quote reserves = `pool_quote_token_account.amount + virtual_quote_reserves` — [pump-public-docs](https://github.com/pump-fun/pump-public-docs)
- Fees/creator fees on new trade instructions stay on the bonding curve/pool and are paid out later via permissionless `sweep_protocol_fee` / `sweep_creator_fee`; holder-reward coins route creator fee to holders each trade; cashback coins can no longer be created but existing ones still trade; "synthetic migration" means the pool opens at the price where the last buy stopped — [pump-public-docs](https://github.com/pump-fun/pump-public-docs)
- Pump program ID `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`; PumpSwap AMM `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA`; migration moves liquidity to PumpSwap and burns LP; PumpSwap fee 0.25% (0.2% LP, 0.05% protocol) — secondary sources, verify against IDL: [Pump.fun public docs via search index](https://docsearch.algolia.com/mcp/docs/repo/pump-fun/pump-public-docs), [The Block](https://www.theblock.co/post/347360/pump-fun-launches-dex-called-pumpswap-to-instantly-migrate-graduated-tokens)
- Parser-library release notes: PumpSwap Buy/Sell decoders must handle both log and inner-instruction (CPI) paths; reject truncated payloads; default fields added by later upgrades (buyback/boost) for older events; quote-mint handling bug where WSOL quote mints were replaced by a SOL placeholder and where later buy/sell instructions overwrote create-instruction quote fields; PumpSwap inner-instruction event discriminators are 16 bytes, not 8 — [sol-parser-sdk 0.6.1](https://docs.rs/crate/sol-parser-sdk/0.6.1), [sol-shred-sdk 3.0.2](https://docs.rs/crate/sol-shred-sdk/3.0.2/source/src/instr/pump_amm_inner.rs)
- Third-party skill guide: pump.fun sell instruction has creator_vault and token_program accounts swapped vs buy (causes failed txs if copying buy layout); `create_v2` uses Token-2022 — treat as unverified: [pumpfun skill guide](https://playbooks.com/skills/sendaifun/skills/pumpfun)
- Shyft's Pump AMM parsing doc and Helius "Parsed Streams" exist as reference/managed parsing; `solana-dex-parser` lists PumpSwap among supported protocols — [Shyft Pump AMM parsing](https://docs.shyft.to/solana-yellowstone-grpc/examples/pump-amm/solana-grpc-pump-amm-transaction-parsing), [Helius parsed streams](https://www.helius.dev/docs/parsed-streams), [solana-dex-parser](https://classic.yarnpkg.com/en/package/solana-dex-parser)
- Most token movement is recorded in inner instructions (CPIs); parsers reading only top-level instructions miss routed swaps — [Shyft Pump AMM parsing doc / search summary](https://docs.shyft.to/solana-yellowstone-grpc/examples/pump-amm/solana-grpc-pump-amm-transaction-parsing)
- Yellowstone filter `failed:false` drops failed transactions server-side; message payload is raw protobuf; ALT-loaded addresses arrive as `loaded_writable_addresses`/`loaded_readonly_addresses` (deshred stream docs state this explicitly; regular stream meta described only by reference to `geyser.proto`) — [yellowstone-grpc README](https://github.com/rpcpool/yellowstone-grpc)
- Jito tips: paid to one of eight Jito tip accounts (system transfers inside the bundle's txs) — [RPC Fast bundle guide / search summary](https://rpcfast.com/blog/how-to-improve-your-jito-bundle-landing-rate-on-solana)

### Inferences
- Resolve `account_keys` as static keys + `loaded_writable_addresses` + `loaded_readonly_addresses` (in that order) before indexing into `pre/postTokenBalances` `accountIndex`; mis-ordered ALT resolution is a classic silent-corruption bug (this is from general Solana knowledge; I found no source that spells it out for Yellowstone — verify against `yellowstone-grpc-proto` and Solana tx-status docs).
- Balance-delta rules to implement (general knowledge, unverified in this research): compute delta per (owner, mint), not per token-account; net out wSOL by also using native SOL lamport deltas and wSOL account deltas, add back the fee and Jito tip and rent for ATA creation/closing; ignore transactions with `meta.err != null`; treat Token-2022 transfer-fee mints (received amount < sent) and confidential/extension mints carefully; detect multi-hop/Jupiter routes by net per-signer mint deltas and tag the dominant venue from the program list; bundles appear as separate transactions, so tip transactions and "sandwich" siblings in the same slot must not be attributed to the leader.
- Hybrid is the robust design: balance-delta for the economic truth (amount in/out, price) and event/instruction decoding only to (a) identify venue/pool/bonding curve, (b) get creator, fee, and reserve fields for the early-token context. Pump.fun's 2026 churn (v2/v3 layouts, signed negative virtual reserves, holder rewards, sweep-based creator fees) means price derived from reserves or from "fee-adjusted" event fields is the most fragile; derive effective price from wallet mint/SOL deltas instead.
- Because pump.fun and PumpSwap fees may not be moved to the creator in the same transaction anymore (stay in the curve/pool until swept), the fee portion of a trader's SOL delta may be indistinguishable from price impact without event decoding; use the trade event for the fee split if you need exact fees.

### Gaps
- Raydium CPMM/CLMM/LaunchLab, Meteora DLMM/DBC, Orca Whirlpool, and Jupiter v6 route-specific parsing pitfalls: no authoritative source collected in this pass (only general knowledge, not cited).
- Exact IDL account lists for `create_v2`, `buy_v2/v3`, `sell`, `migrate`, and CompleteEvent field layout: official docs fetched did not cover CompleteEvent or migrate instruction accounts; only the README index was read, not the per-instruction docs.
- Token-2022 transfer-fee extension handling in Pump/PumpSwap tokens: not verified.
- Whether Yellowstone regular-transaction `loaded_*_addresses` are populated inside `TransactionStatusMeta` for every provider: not verified from primary sources.
- How Alpenglow's `bank_id` affects `processed` duplicates for the same signature in a slot: guidance says buffer per `bank_id`, but no worked example found.

---

## 4. Early-token context signals and their APIs

### Takeaway
Cheapest reliable path for creation/curve/migration/dev-sell signals is your own gRPC stream (pump.fun `CreateEvent`/`TradeEvent`/complete + creator = wallet), because REST APIs lag and are rate-limited. For holder concentration, liquidity and volume, use Birdeye or GeckoTerminal for breadth and RugCheck/Helius DAS for deeper checks, and expect free tiers to be too slow for per-trade enrichment.

### Cited Findings
- DexScreener public API rate limit: 60 requests/min on token-profiles, recent updates, community takeovers, ads and metas endpoints; limits for boosts, orders, pairs, search, tokens endpoints not stated on the page — [DexScreener API reference](https://docs.dexscreener.com/api/reference)
- GeckoTerminal public API (CoinGecko): free tier 30 calls/minute, no auth in beta, higher limits only via paid CoinGecko API; new-pools endpoint specifics not confirmed — [CoinGecko support](https://support.coingecko.com/hc/en-us/articles/22612838274841-Does-GeckoTerminal-have-an-API), [GeckoTerminal API guide](https://apiguide.geckoterminal.com/authentication)
- Birdeye: tiers per section 1; rate limit is account-wide across APIs; Wallet API group has its own lower limit; `GET /defi/v2/tokens/new_listing` with `meme_platform_enabled` exists (third-party skill page; CU cost not found) — [Birdeye rate limiting](https://docs.birdeye.so/docs/rate-limiting), [birdeye-api skill page](https://skillselion.com/skills/agiprolabs/claude-trading-skills/birdeye-api)
- RugCheck: official docs not located; third-party wrappers describe a report endpoint returning risk score, mint/freeze authority, holder count, liquidity, top-holder/top-10/insider share, and a `/v1/tokens/{mint}/report/summary` path plus an insiders graph; one wrapper claims 1 rps free limit — that is the wrapper's limit, not necessarily RugCheck's — [RugCheck API wrapper](https://oanor.com/api/rugcheck-api), [Termo skill](https://termo.ai/skills/rugcheck)
- Helius DAS: plan rate limits are DAS 2 rps (Free), 10 (Developer), 50 (Business), 100 (Professional) — [Helius plans](https://www.helius.dev/docs/billing/plans.md)
- Helius Wallet API `funded-by` returns the first incoming SOL transfer funder; paid plans only; Beta; 404 when never funded; no credit cost stated — [Helius Wallet API funded-by](https://www.helius.dev/docs/wallet-api/funded-by.md)
- Pump.fun CreateEvent/TradeEvent/PumpSwap Buy/Sell events are emitted in logs and CPI inner instructions and expose creator-related fields and reserves; migration "synthetic" price continuity — [pump-public-docs](https://github.com/pump-fun/pump-public-docs)
- Helius "Parsed Streams"/Parsed Events: managed decoded events at 1 credit/event — [Helius webhooks](https://www.helius.dev/docs/webhooks.md), [Helius blog](https://www.helius.dev/blog/parsed-events-and-streams)

### Inferences
- Stream-derived (no REST needed, zero extra latency): token creation (pump `create`/`create_v2`), creator wallet, bonding-curve progress (from real reserves in TradeEvent), migration (complete event / PumpSwap pool creation), dev sells (creator wallet's balance delta in the mint), first-N-buyers, volume and buyer count. Holder concentration needs token-account state (accountSubscribe on mint's largest accounts, or `getTokenLargestAccounts`/DAS), which is not available from the swap stream alone.
- At 30/min (GeckoTerminal) and 60/min (DexScreener) free limits you can enrich only on the leader's actual buys (rare), not every token on the firehose; Birdeye Starter+ (15 rps) is a more realistic enrichment path. Cache per mint aggressively.
- RugCheck holder/insider data is fine as a second-pass filter at buy time but its freshness for tokens only seconds old is unverified; for the first 30–60 s rely on your own stream.

### Gaps
- Official RugCheck API docs, auth model and rate limits: not found.
- Birdeye per-endpoint CU costs, whether `token_security`/holder endpoints are in free/Starter tiers, and measured freshness of `new_listing` for pump.fun launches: not found.
- GeckoTerminal new-pools endpoint indexing delay; DexScreener indexing delay for new pump.fun tokens: no source.
- Helius DAS `getTokenAccounts` latency/credit cost for top-holder concentration: not fetched.

---

## 5. Alerting latency chain after a leader's swap

### Takeaway
With 200 ms slots, the chain from leader swap to your landed copy is dominated by detection commitment choice, your decision logic, quote/build, and landing path (Jito/BAM hop ≈ 50 ms by Jito's own figure), not by 5–20 ms provider differences. Realistic minimum is a few slots behind the leader, with `processed` detection and a pre-built, pre-signed transaction path.

### Cited Findings
- Slot time 200 ms since Oct 9, 2026 — [Solana reduced slot times](https://solana.com/upgrades/reduced-slot-times)
- Provider stream spread within one provider's `processed` feed: p90 +2.4–13.1 ms, p99 +6.8–23.6 ms behind the fastest delivery (vendor benchmark, PumpSwap) — [Alchemy methodology](https://www.alchemy.com/blog/solana-grpc-benchmark-methodology)
- Shred-derived feeds lead gRPC/other feeds by roughly single-digit ms median (3.8–6.7 ms p50 when behind; p99 16–82 ms) per vendors, with larger vendor claims (avg 120 ms/p99 270 ms) vs default nodes — [Shyft](https://docs.shyft.to/solana-shredstreaming/rabbitstream-vs-jito-shredstream-benchmarks), [OrbitFlare](https://dev.to/orbitflarerpc/jito-shredstreams-last-slot-your-two-ways-out-53np), [RPC Fast](https://rpcfast.com/blog/shredstream-vs-geyser-vs-standard-rpc)
- Jito says the Block Engine added "an extra hop of roughly 50ms"; Direct Bundle Ingest to BAM (whitelist only) skips it; Jito's own data: bundles landed +16.9% (106.3M to 124.3M), end-to-end land rate 0.45% to 0.57% between Sep 3–20 and Sep 20–Oct 7, but gains are not isolated to routing; BAM-connected validators ~37% of stake at epoch 1050 — [Solana Compass on BAM DBI](https://solanacompass.com/news/jito-announces-bam-direct-bundle-ingest-routing-solana-bundles-past-the-block-engines-50ms-hop)
- Jito tip floor endpoint reports 25th/50th/75th/95th/99th percentile landed tips plus EMA of 50th; tips go to one of eight tip accounts; RPC Fast says multi-relay multi-region parallel submission beats a single endpoint (vendor opinion) — [RPC Fast bundle guide](https://rpcfast.com/blog/how-to-improve-your-jito-bundle-landing-rate-on-solana)
- Triton offers "Preconfs" (Jito BAM and Harmonic) at the greater of $0.0015/slot or $50/million messages — [Triton pricing](https://triton.one/pricing)
- Alpenglow target finality ~150 ms; `confirmed` and `finalized` equal after activation (activation scheduled for Oct 21, unconfirmed here) — [Solana Compass](https://solanacompass.com/news/anza-sets-alpenglow-mainnet-date-solanas-consensus-switch-is-scheduled-for-october-21-at-about-1450-utc)

### Inferences
- Rough budget (my arithmetic from the cited figures plus unverified assumptions on your own components): leader's tx lands in a leader slot (0 reference); validator turbine propagation/processing before your gRPC provider emits it at `processed` — on the order of one slot (up to ~200 ms) per Helius' "processed ≈ one validator confirmation" and RPC Fast's 120 ms avg shred lead; network to you (1–20 ms RTT); parse+decide (1–5 ms if in-process, mostly your code); quote (Jupiter API HTTP round trip, tens to 100+ ms, not researched) or local pool math; sign+send over Jito (~50 ms hop on the Block Engine path per Jito, not cited for send latency); inclusion in a later leader slot (≥1 slot, 200 ms, often 2–3 because of leader rotation in 4-slot blocks — general knowledge, unverified). Total realistic range 400 ms to 1.5 s behind the leader's `processed` event; the leader's own slot is already gone by the time you act.
- Biggest controllable losses: (1) using Jupiter quote API per alert instead of local AMM math for pump.fun/PumpSwap (a direct pump/PumpSwap buy instruction removes the aggregator hop); (2) waiting for `confirmed` instead of acting on `processed` (now roughly equal post-Alpenglow, re-measure); (3) sending to one RPC instead of parallel (Jito + staked RPC/SWQoS); (4) cold TCP/TLS connections and region mismatch (colocate with the provider's region: ewr/fra/tyo/etc.); (5) tip too low in a hot token (tip floor percentile).
- A shred-level pre-alert is worth it only if you can act speculatively (e.g., pre-build the copy transaction and send as soon as gRPC confirms the leader tx did not fail) — gains of 3–120 ms by vendors' numbers versus risk of copying failed leader transactions.
- Bundles and BAM: a bundle's transactions appear in the stream as ordinary transactions in one slot; the leader's swap may be inside a bundle with tip and protection, so your copy cannot be in the same bundle (not atomic with theirs) and will land after.

### Gaps
- No source quantifying end-to-end copy-trade latency from a leader's `processed` swap to landing; no measured Jito `sendBundle`/staked-RPC landing latency per region; Jito tip-floor current values.
- Jupiter API quote/swap-instruction latency not researched (out of scope per brief).
- Whether 200 ms slots changed leader-rotation (4 consecutive slots per leader) behaviour and skip rates: not researched; Solana says each step is gated by skip rate.
- Post-Alpenglow measured gRPC latency for `confirmed`: none found.

---

## 6. "Leader moved to a new wallet": detecting SOL sweeps to fresh wallets in real time

### Takeaway
No packaged real-time service detects this; build it on the same gRPC stream by watching System Program transfers (and wSOL closes/transfers) out of tracked wallets and flagging recipients that are brand-new/zero-history with large outflows. Helius `funded-by` can back-check lineage after the fact.

### Cited Findings
- Native SOL transfers are System Program transfer instructions; a GetBlock tutorial shows subscribing to Yellowstone for the System Program and decoding transfers (amount, sender, recipient), written for high-value alerts — [Solana Cookbook](https://solana.com/es/developers/cookbook/transactions/send-sol), [GetBlock guide](https://docs.getblock.io/guides/listening-to-high-value-sol-transactions-via-yellowstone-geyser-grpc-with-getblock)
- Helius Wallet API `funded-by` (Beta, paid plan): returns the wallet's first incoming SOL transfer (funder, amount, signature, slot); only the immediate funder; 404 if never funded; wallets created by airdrop/program initialisation without a SOL transfer have no data; history only after feature deployment — [Helius funded-by](https://www.helius.dev/docs/wallet-api/funded-by.md)
- Transaction filter semantics: with `account_include` = tracked wallets you receive every transaction touching them including transfers out; `account_required` can target a wallet plus the System Program — [yellowstone-grpc README](https://github.com/rpcpool/yellowstone-grpc)

### Inferences
- Detection from your existing wallet-filtered stream (no extra subscription): for each tracked wallet's transaction, compute native SOL delta (lamports) and wSOL/USDC deltas from `pre/postBalances` and token balances; if a tx has no swap but a large net SOL outflow (e.g., >70–90% of the wallet's balance, threshold is your design) to a counterparty never seen before, mark counterparty as "candidate successor." Immediately add it to `account_include` (re-sending the full subscribe request), tag it with a parent link and a probation score.
- Corroboration signals available from the same data: successor's first activity within N slots, same first-buy tokens as leader, same funding amount ≈ leader's outflow minus fee, funding via exchange/bridge (lower confidence), outflows split across several fresh wallets (fan-out) — add children recursively with depth limit.
- Also watch inbound: any new wallet whose first SOL deposit came from a tracked wallet is a candidate even if you missed the outflow (use the `funded-by` API as a one-time backfill check, rate-limited by plan).
- Edge cases: leaders may fund via intermediate hops, CEX, or token swaps (sell all to SOL then transfer), or by moving tokens rather than SOL; ATA-only transfers; closing wSOL accounts sends rent to destination. Filtering noise (dust transfers, rent returns, tips) needs a minimum-size threshold.
- Fan-out cost scales with the candidates added; cap candidate list and expire candidates with no matching activity.

### Gaps
- No source describing an existing real-time "wallet migration" detector or its false-positive rates; thresholds above are unvalidated design choices.
- Helius Wallet API credit cost and rate limit for `funded-by`/identity: not stated on the fetched page.
- Whether other providers' enhanced transaction filters can match System Program transfers by destination account only (needed for inbound detection of unseen wallets): not verified.
