# Organic / quality metrics for Solana tokens: what providers publish, how they are built, and what is known about their reliability (as of 2026-10-27)

Method note for the report writer: all pages were read through WebFetch/WebSearch, which return model-generated summaries of the page, not raw HTML. Field lists and numbers below are as reported by those summaries. Items marked "search-snippet only" come from a search summary and the page itself was not opened. Public docs/GET only; no keys were used and no live API calls were made, so nothing about live latency or live accuracy was measured by me. I went well past the suggested tool-call budget because the scope is wide, and several areas are still thin (see Gaps in each section).

---

## Q1. Jupiter's organic score and the Tokens v2 stats fields: definition, inputs, limits, free tier, freshness, accuracy evidence

### Takeaway
Jupiter's `organicScore` is a 0-100, ecosystem-relative composite of four "organic" signals (volume, holders, traders, buyers). "Organic" is defined negatively: wallets tied to known sniping, copy-trading or automated-execution platforms are flagged non-organic, and every other wallet defaults to organic. The formula, weights and label cutoffs are not public, I found no independent accuracy study, and Jupiter itself says fresh tokens have volatile scores and that classification is rule-based with known edge cases.

### Cited Findings
**Definition and inputs**
- Organic Score is a 0-100 measure of how genuine a token's trading activity is, meant to filter out bots, snipers and copy-trading tools. It combines four signals: organic volume, organic holders, organic traders, organic buyers. Wallets trading through known bot/automation channels are non-organic; the rest count as organic. The exact formula is not published. — [Jupiter dev docs: Organic Score](https://developers.jup.ag/docs/tokens/organic-score)
- Every trade is classified by whether the signer wallet is organic. Classification is binary and per-wallet, not per-trade. Non-organic wallets are those tied to known trading accounts, pipelines or automated platforms (sniping, copy-trading, automated execution), identified through on-chain patterns. The approach is conservative: it flags non-organic wallets and defaults everything else to organic, rather than detecting organic behaviour directly. — [Jupiter blog: What is organic score](https://developers.jup.ag/blog/what-is-organic-score)
- Scores are normalised against the rest of the ecosystem (scaled to the top of the distribution) and express relative ordering, not an absolute amount of organic activity. Early growth is weighted heavily (10 to 100 organic buyers matters far more than 10,000 to 10,100); SOL and USDC sit near 100 because returns diminish at scale. — [Jupiter blog](https://developers.jup.ag/blog/what-is-organic-score); [Jupiter dev docs](https://developers.jup.ag/docs/tokens/organic-score)
- `organicScoreLabel` is `high` / `medium` / `low`; no numeric cutoffs are published and both Jupiter pages recommend filtering on the raw `organicScore` because the buckets are wide. — [Jupiter dev docs](https://developers.jup.ag/docs/tokens/organic-score); [Jupiter blog](https://developers.jup.ag/blog/what-is-organic-score)
- Jupiter says the exact calculation and thresholds are withheld to prevent gaming, and that the score is one input to token verification alongside market cap, holders, onchain liquidity and social support (search-snippet only, from docs.jup.ag verification/Discover pages). — [Jupiter Token Verification docs](https://docs.jup.ag/user-docs/launch/vrfd/token-verification)
- Jupiter's own docs describe the score as a signal, not a guarantee; statistics may be manipulated by sophisticated traders and a high score does not mean a token is safe (search-snippet only). — [Jupiter Discover docs](https://docs.jup.ag/user-docs/trade/terminal/token-discovery)
- Low organic metrics can cause a token to be excluded from Jupiter's Price API responses, and the score is a core input to data-assisted verification. — [Jupiter blog](https://developers.jup.ag/blog/what-is-organic-score)

**API fields (GET `https://api.jup.ag/tokens/v2/search?query=<symbol|name|mint>`)**
- Top-level fields in the documented example: `id, name, symbol, icon, decimals, circSupply, totalSupply, tokenProgram, firstPool{id, createdAt}, holderCount, audit{mintAuthorityDisabled, freezeAuthorityDisabled, topHoldersPercentage (0-100)}, organicScore, organicScoreLabel, isVerified, tags, fdv, mcap, usdPrice, priceBlockId, liquidity, stats5m, stats1h, stats6h, stats24h, updatedAt`. `query` accepts comma-separated values, up to 100 mints per call; symbol/name searches return 20 mints by default. Docs warn the response shape is subject to change. — [Jupiter dev docs: Token Search v2](https://developers.jup.ag/docs/tokens/v2/search)
- Each of `stats5m/1h/6h/24h` has: `priceChange, liquidityChange, volumeChange, buyVolume, sellVolume, buyOrganicVolume, sellOrganicVolume, numBuys, numSells, numTraders, numOrganicBuyers, numNetBuyers`. The search reference page itself does not define these sub-fields. — [Jupiter dev docs: Token Search v2](https://developers.jup.ag/docs/tokens/v2/search)
- Definitions that do exist (blog): `numOrganicBuyers` = organic wallets whose buys exceeded their sells; `numNetBuyers` = the same net-buy test across all wallets including bots and market makers. `numTraders` appears to be all traders (24h example: SOL 812,709; TRUMP 2,947; ASPEN 3,034). — [Jupiter blog](https://developers.jup.ag/blog/what-is-organic-score)
- `audit.isSus` also exists in live responses (not in the doc example): a third-party bot PR reports it was present on 2 of 130 recent/trending tokens sampled, and treats presence as a block signal. It also notes the V2 schema has no dedicated "banned" field. — [fciaf420/meridian PR #107](https://github.com/fciaf420/meridian/pull/107)
- Other relevant endpoints: `/tokens/v2/recent` (sorted by first pool creation, not mint time) and a category endpoint `/tokens/v2/toporganicscore/5m` ranking tokens by 5-minute organic score. — [Jupiter blog](https://developers.jup.ag/blog/what-is-organic-score). A third-party skill listing gives the route form `/{category}/{interval}` with categories toporganicscore/toptraded/toptrending and intervals 5m/1h/6h/24h, but the official guide's endpoint table reportedly lists only the trending variant, so verify against the OpenAPI reference (search-snippet only). — [Jupiter: how to get token information](https://developers.jup.ag/docs/guides/how-to-get-token-information)

**Worked numbers from Jupiter's blog (24h, vendor-published)**
- SOL score 98.9: total buy vol $7.36B, organic buy vol $36.6M (0.5%). Fartcoin 96.5: $4.66M total, $538K organic (11.5%). JUP 93.6: $1.66M total, $226K organic (13.6%). TRUMP 85.3: $10.4M total, $74K organic (0.7%). ASPEN 45.1: $1.61M total, $1,034 organic (0.06%), 3,034 traders but 11 organic buyers. Organic share was computed by the blog author, not exposed or recommended by Jupiter. — [Jupiter blog](https://developers.jup.ag/blog/what-is-organic-score)

**Limits, cost, free tier**
- Rate-limit table (60-second sliding window, per organisation, Swap/Price/Token requests share one bucket): Keyless 0.5 RPS (30 RPM, no key), Free 1 RPS (60 RPM, key), Developer 10 RPS (600 RPM), Launch 50 RPS (3,000 RPM), Pro 150 RPS (9,000 RPM). No per-endpoint weighting is described. 429 on excess; headers `x-ratelimit-remaining/current/reset`. — [Jupiter rate limits](https://developers.jup.ag/docs/portal/rate-limits)
- Prices: Free $0, Developer $25/mo, Launch $100/mo, Pro $500/mo. All plans share the same base URL, data freshness and latency. — [Jupiter API setup](https://developers.jup.ag/docs/api-setup)
- `lite-api.jup.ag` "will be phased out once the new API gateway is stable"; its rate limit will be reduced step by step until retired; migration is only a base-URL change to `api.jup.ag`, and keyless access on `api.jup.ag` at 0.5 RPS replaces it. Grace period ended 30 June 2026; no fixed date for old gateway retirement. — [Jupiter migration guide](https://developers.jup.ag/docs/portal/migration.md)
- Earlier changelog language (Nov 2025 announcement, Feb 2026 postponement, "free users should migrate and use an API key") is reported by search snippet only. — [Jupiter changelog Nov 2025](https://developers.jup.ag/changelog/2025-11). The Token Search page I fetched still says to send `x-api-key`, whereas the rate-limit/migration pages say keyless works at 0.5 RPS; these pages are not fully consistent about whether a key is needed.

**Freshness for minutes-old tokens**
- The doc states no update interval or caching policy; each token has an `updatedAt` timestamp. — [Jupiter dev docs: Token Search v2](https://developers.jup.ag/docs/tokens/v2/search)
- Jupiter blog: fresh tokens have volatile scores because they lack history; the system does not try to capture every organic wallet so absolute numbers may undercount; wallet classification is rule-based with known edge cases; the score has run for over a year and is still being improved. — [Jupiter blog](https://developers.jup.ag/blog/what-is-organic-score)
- A third-party paper-trading bot PR expects a launch only a few seconds old to usually have no Jupiter reading yet, so it stores the token's age at lookup time. The author could not reach the live endpoint from their sandbox, so this is an expectation, not a measurement. — [Asayed36/trading-bot PR #206](https://github.com/Asayed36/trading-bot/pull/206)

**Accuracy evidence**
- No independent evaluation of the organic score was found. The only third-party usage evidence is that one open-source agent shows `organicScore`/`isVerified` as display-only and gates on `audit.isSus`/banned instead, giving no rationale for not gating on organic score. — [fciaf420/meridian PR #107](https://github.com/fciaf420/meridian/pull/107)

### Inferences
- Because "organic" = "not on a known bot/automation list", a sybil farm made of fresh plain wallets funded with SOL dust (the pattern Bitquery documents in Q4) would plausibly be counted as organic. The score is better read as "volume/traders not attributable to known sniper/copy/automation platforms" than "volume from independent humans".
- The blog's table shows organic share of buy volume is tiny even for top-scoring tokens (0.5% to 13.6%), so `buyOrganicVolume / buyVolume` is not comparable to a "percent organic" notion from other vendors, and a high score can coexist with an organic share below 1%.
- `numOrganicBuyers` is a net-buyer count (buys > sells per wallet), so it undercounts one-way early buyers who have not sold and is not the same thing as "unique buyers". Unique buyers per window cannot be read from Jupiter; `numTraders` is the closest (all wallets, bots included).
- For a 100-mint batch per call at 30 RPM keyless, throughput is not the bottleneck for polling a watchlist; per-token freshness and score stability in the first minutes is.
- Being a negative-list design, the score will lag new bot infrastructure until Jupiter's list catches up; for sniper-bot detection on brand-new tokens it needs a self-computed complement.

### Gaps
- Exact formula, weights, label cutoffs, and recompute cadence: not published.
- Whether `stats5m` and `organicScore` are populated for tokens in their first 1-5 minutes, and the lag between swap and `updatedAt`: no measurement found (needs a live probe; not done because of the no-key/GET-only constraint and no live calls).
- Whether current keyless (`api.jup.ag`, 0.5 RPS) behaviour is stable and whether `lite-api.jup.ag` still resolves today: the docs say phased out, but I did not test it.
- Official definition of `numTraders`, `numBuys`/`numSells` (per swap vs per wallet) and of `audit.isSus`: not in the docs I could read.
- Independent accuracy, false-positive/false-negative rates: none found.

---

## Q2. Other providers' notions of organic/quality, and which expose unique buyers/makers per window

### Takeaway
Only a few providers give unique-wallet counts per window: GeckoTerminal/CoinGecko (`buyers`/`sellers` per pool for m5 to h24), Birdeye (`trade-data` unique wallets per custom timeframe), Solana Tracker (`unique buyers/sellers` for 5m/1h/6h/24h) and Jupiter (`numTraders`). DexScreener's public API shows buys/sells counts but no makers field in the schema I could read. Security-style tools (RugCheck, SolSniffer, Webacy, Bubblemaps) score contract and holder risk (authorities, concentration, bundles, snipers), not organic trading. I could not verify Birdeye field names, RugCheck/Vybe/Solscan schemas, or any Chainalysis/Solidus definition of organic volume.

### Cited Findings
**GeckoTerminal (CoinGecko API)**
- Pool objects have `transactions` keyed `m5, m15, m30, h1, h6, h24`, each with integer `buys`, `sells`, `buyers`, `sellers` (h24 example: 1827 buys, 1119 sells, 874 buyers, 642 sellers); `volume_usd` keyed by the same windows (strings); nullable `reserve_in_usd`; `pool_created_at`. 20 pools per page; beyond 10 pages needs Analyst plan or above. — [CoinGecko docs: trending pools](https://docs.coingecko.com/reference/trending-pools-list.md)
- Cache: the page has a "Cache / Update Frequency" section but my fetch returned no numeric values; a search summary claims 60 s for keyless/public and 30 s for paid. Treat as unconfirmed. — [CoinGecko docs](https://docs.coingecko.com/reference/trending-pools-list.md)
- A pool trades endpoint returns individual trades labelled buy/sell with USD volume (search-snippet only). — [geckoterminal-api (PyPI)](https://pypi.org/project/geckoterminal-api)
- The page does not define whether `buyers`/`sellers` are distinct wallets per window or per-pool, nor how they treat routers; I did not find a definition. Keyless limits not stated in the page I read.

**Birdeye**
- Token Trade Data (Single) returns buy/sell counts, trade counts, unique wallets, volume and change metrics for requested custom timeframes via a `frames` parameter (e.g. `5m,1h,24h`); change percentages compare the current window with the previous matching window; cost 12 compute units per request; chain via `x-chain`. A multiple-token variant exists. (search-snippet only; the official page was 404/redirect in fetch and the exact field names, e.g. whether `unique_wallet`, were not confirmed). — [Birdeye: Token Trade Data (Single)](https://docs.birdeye.so/reference/get-defi-v3-token-trade-data-single); [Birdeye x402 reference](https://docs.birdeye.so/reference/x402.md)
- Birdeye publishes a compute-unit cost page and a data-accessibility-by-package page (which plans include which endpoints). I could not retrieve their contents. — [CU cost](https://docs.birdeye.so/reference/compute-unit-cost); [Data accessibility by packages](https://docs.birdeye.so/docs/data-accessibility-by-packages)
- Third-party skill doc claims V3 endpoints use snake_case and V1 camelCase (secondhand, unverified). — [claudeskills.info Birdeye skill](https://claudeskills.info/skills/agiprolabs/claude-trading-skills/birdeye-api/)

**DexScreener**
- Public API endpoints: `/token-profiles/latest/v1`, `/token-profiles/recent-updates/v1`, `/community-takeovers/latest/v1`, `/ads/latest/v1`, `/token-boosts/latest/v1`, `/token-boosts/top/v1`, `/orders/v1/{chainId}/{tokenAddress}`, `/latest/dex/pairs/{chainId}/{pairId}`, `/latest/dex/search`, `/token-pairs/v1/...`, `/tokens/v1/...`, `/metas/...`. 60 requests/minute stated for profiles, takeovers, ads and metas endpoints; no limit stated for the others in what I could read. — [DexScreener API reference](https://docs.dexscreener.com/api/reference)
- Pair object: `txns` per timeframe with `buys` and `sells` (integers), `volume`, `priceChange`, `liquidity{usd,base,quote}`, `pairCreatedAt`, `fdv`, `marketCap`, `labels`, `boosts.active`, `info`. No "makers" field appears in the schema. Ad objects carry `type`, `durationHours`, `impressions`. — [DexScreener API reference](https://docs.dexscreener.com/api/reference)
- DexScreener says its data comes from a custom indexer reading chains in real time "without human moderation". — [DexScreener docs](https://docs.dexscreener.com/)

**Solana Tracker**
- `GET /stats/{token}` returns buy/sell volume (USD), buy/sell counts, unique buyers and unique sellers, and price change for 5m, 1h, 6h, 24h. Rate limits not documented on the page; separate sniper/bundler guide exists. — [Solana Tracker docs](https://docs.solanatracker.io/guides/token-research.md)

**Webacy**
- Solana-oriented outputs: DD Lite covers top-10 holders, sniping, bundling, total holders, mintable/freezable; holder-analysis endpoint adds sniper/bundler detection; a trading-lite pre-trade check has an overall risk value (docs example skips tokens above 70). API key required. (search-snippet only) — [Webacy docs](https://docs.webacy.com/integrations/agent-reference)

**RugCheck, SolSniffer, Vybe, Solscan**
- SolSniffer "Snifscore" is a 0-100 risk rating built from 20+ indicators incl. mint/freeze authority; vendor-authored post says API returns top-50 holders and wallet clusters (search-snippet only; official schema not found). — [Bitbond: SolSniffer overview](https://www.bitbond.com/resources/solsniffer-solanas-security-and-analytics-platform/)
- Vybe: a token-trader activity summary endpoint exists (buy/sell volume, PnL, win/loss) and a top-PnL-traders endpoint takes mint + resolution (1d/7d/30d) and sorts by `totalVolumeUsd`/`tradesCount` (via a community Apify wrapper, not the core reference). — [Vybe Apify actor](https://apify.com/vybe/solana-token-top-pnl-traders-api/Help%20&%20Support)
- RugCheck: Swagger page fetched but the JS-rendered content was empty; `openapi.json` returned 404. No schema verified. Solscan: not retrieved.

**Bubblemaps**
- Decentralization Score is 0 to 100 (higher = more decentralized), computed from the latest bubble map using top holders and links between them, excluding CEX and contracts; fewer/smaller clusters, smaller gaps between top-holder amounts and lower collective top-holder share raise it. Links are gas-token and token transfers (search-snippet of Bubblemaps' Notion page; the page body would not render in fetch). — [Bubblemaps decentralization score](https://bubblemaps.notion.site/Bubblemaps-Decentralization-Score-ba767100c9534945ae390fd2467e4add)
- Bubblemaps' feed screens new tokens for "bundles" (wallets buying in the same block or within seconds of launch) and "clusters" (shared funding source or transfer chain); no numeric thresholds, "fresh wallets" is not mentioned, and no API is described. Vendor-promoted article that also promotes the $BMT token. — [HackerNoon: Bubblemaps platform rebuild](https://hackernoon.com/bubblemaps-rebuilds-its-platform-to-screen-out-rug-pulls-before-traders-ever-see-the-token)

**Chainalysis / Solidus definitions of organic vs wash**
- Searched; nothing from Chainalysis or Solidus defining organic volume for Solana tokens surfaced. A generic definition of wash trading found in a vendor blog: one entity moves crypto between wallets it controls to give the illusion of organic trading. — [Bitquery](https://bitquery.io/blog/solana-volume-numbers-are-a-lie) (search summary)
- Another vendor (MadeOnSol) tags each swap as organic or "mev-suspect" because sandwich bots double-count victim swaps on the same pool: the nearest operational "organic volume" definition found, vendor-authored. — [MadeOnSol: MEV-stripped organic volume](https://madeonsol.com/blog/mev-stripped-organic-volume-solana-memecoin-api)

### Inferences
- Who gives unique-wallet counts per window (usable as "unique buyers/makers" proxies): GeckoTerminal (`buyers`, `sellers`, m5 to h24), Solana Tracker (`unique buyers/sellers`, 5m/1h/6h/24h), Birdeye (`unique wallets`, custom frames), Jupiter (`numTraders`, 5m/1h/6h/24h). DexScreener's API exposes only buy/sell transaction counts.
- Unique-wallet counts from aggregators are only as meaningful as their wallet attribution (signer vs token-account owner vs router/program); none of the sources I read document this. A raw-swap calculation keyed on the fee payer/signer is the way to control that definition.
- Security tools (RugCheck, SolSniffer, Webacy, Bubblemaps) answer "can this rug / is supply concentrated or bundled", which is complementary to, not a substitute for, trading-activity organicity.
- The absence of makers in DexScreener's API (the site UI shows "makers" but the schema I read does not) means makers-based screens need scraping or a different source; I did not verify the UI claim.

### Gaps
- Birdeye: exact response field names, plan gating and CU costs for token security, holder, creation-info, trade-data (page content not retrievable; docs moved to data.birdeye.so and fetch returned 404 on the redirect target).
- GeckoTerminal: unique buyers/sellers definition and confirmed keyless rate limit and cache duration.
- DexScreener: why some tokens have no profile/boost/ad data (not documented in pages read; only inference is that profiles/boosts/ads are paid or claimed features); makers field availability.
- RugCheck report fields (score, risks, top holders, insider networks), Solscan Pro API, Vybe core reference, Bubblemaps public API: not verified.
- Chainalysis/Solidus: no organic vs wash definition retrieved.
- Pricing for Birdeye, Vybe, Solana Tracker, SolSniffer, Webacy: not retrieved.

---

## Q3. Practitioner and academic metric definitions, thresholds and failure modes

### Takeaway
The documented, sourceable metrics are: trades per unique trader, average trade size, share of wallets trading both sides, round-trip ratio, funding-source concentration (Bitquery); volume-to-liquidity, holders vs volume, interval and size repetition, price pinned vs volume (MadeOnSol, unsourced rules of thumb); and graph cycles/volume symmetry (TUM thesis). Almost no metric has a threshold with credible provenance: the only numeric thresholds I found are MadeOnSol's unsourced rules of thumb and case-study values from Bitquery.

### Cited Findings
- Bitquery's wash-detection method (April 2026, 12 hours of Solana DEX trades): rank tokens by trade count, then compute trades per trader, average trade size in USD and the share of wallets trading on both sides; combine into a composite "wash score"; then trace each flagged wallet's first inbound SOL transfer and aggregate by sender. — [Bitquery: Solana volume numbers are a lie](https://bitquery.io/blog/solana-volume-numbers-are-a-lie)
- Values reported for the flagged token OpenLie: $532,461 volume in 12h, 233 wallets, 40,523 trades (174 trades per wallet), average trade $13.14, 96% of wallets both bought and sold, round-trip ratio 0.95 to 1.00 for the top 10 wash wallets, a funder seeded at least 200 bots with 0.5 SOL each in a 52-second burst (21 April 2026) and 30 of 30 flagged wallets matched the dominant funder. Two other flagged tokens were funded by one-off senders with 0.002 SOL dust, so funding-source clustering did not catch them. — [Bitquery](https://bitquery.io/blog/solana-volume-numbers-are-a-lie)
- Another flagged token showed ~$0.18 buys and ~$0.16 sells per wallet over ~400 trades; authors read this as price pinning rather than volume inflation. — [Bitquery](https://bitquery.io/blog/solana-volume-numbers-are-a-lie)
- MadeOnSol heuristics (vendor educational/promotional page; no dataset or method cited): volume-to-liquidity above 20:1 "warrants suspicion", organic active tokens roughly 1:1 to 10:1; fewer than 100 holders on a high-volume token is a warning (example: ~$1M daily volume with 50 holders "almost certainly wash traded"); fixed-interval trades, identical trade amounts, perfectly alternating buy-sell, wallets funded from a common parent in a short window, price held in a 1-2% range for hours, flat 24h volume; wait 24-48h to see if volume persists. No thresholds given for wallet age or round-trip counts. — [MadeOnSol: Solana volume bots explained](https://madeonsol.com/blog/solana-volume-bots-explained)
- Cost context: a wash trade costs on the order of $0.00025 in transaction fee plus 0.25-1% pool fee, so $100K of fake daily volume costs roughly $250-$1,000 in pool fees (arithmetic on the vendor's assumed fees). — [MadeOnSol](https://madeonsol.com/blog/solana-volume-bots-explained)
- Academic: a TUM master's thesis (submitted 10 June 2025) built a graph-based detector for Solana AMM tokens using strongly connected components and volume symmetry checks, applied to a curated set of high-risk tokens; it reports a substantial presence of wash trading concentrated among a small set of accounts and tokens, with temporal clustering and liquidity-provider patterns. — [Wiedenmann, TUM master's thesis](https://www.cs.cit.tum.de/fileadmin/w00cfj/sebis/thesis/250610_Wiedenmann_Thesis.pdf)
- The thesis's literature section (secondary quotes, not Solana): Victor & Weintraud (WWW 2021) found more than 30% of tokens on IDEX and EtherDelta had been wash traded (~$159M volume), ~10% almost exclusively wash-traded on one exchange; Le Pennec et al. estimated 96-98% of Ether trading volume as highly suspicious. — [Wiedenmann thesis](https://www.cs.cit.tum.de/fileadmin/w00cfj/sebis/thesis/250610_Wiedenmann_Thesis.pdf)
- Jupiter's metric family: organic buyers (net buyers that are not on the bot list), `numNetBuyers`, `buyOrganicVolume`. — [Jupiter blog](https://developers.jup.ag/blog/what-is-organic-score)
- Bubblemaps' "bundles" metric: wallets buying in the same block or within seconds of launch; "clusters": wallets linked by shared funding. — [HackerNoon](https://hackernoon.com/bubblemaps-rebuilds-its-platform-to-screen-out-rug-pulls-before-traders-ever-see-the-token)
- A MEV-aware volume definition: classify swaps as organic vs MEV-suspect so sandwich legs do not double-count volume. — [MadeOnSol](https://madeonsol.com/blog/mev-stripped-organic-volume-solana-memecoin-api) (search-snippet only)

### Inferences
(Failure modes and calculation notes are my reasoning, not sourced findings.)

| Metric | Definition (compute from raw swaps) | Threshold with provenance | Failure modes |
|---|---|---|---|
| Unique traders vs swap count (trades per trader) | distinct signer wallets / swaps in window | Bitquery used it only as a ranking input (OpenLie 174/wallet); no cutoff published | Real active traders and MM/arb bots also have high ratios; sybil farms with one-trade-per-wallet defeat it |
| Volume per unique trader / avg trade size | window volume / distinct traders; mean USD per swap | Case value only: $13.14 avg in OpenLie | Dust-size wash is easy to randomise; retail also trades small on pump-style launches |
| Buyer/seller balance | unique buyers vs unique sellers, or net buyers | None credible; Jupiter's `numNetBuyers`/`numOrganicBuyers` are one implementation | Early phase is naturally buyer-heavy; sybils can balance; bots count as net buyers |
| Top-N wallet share of volume | sum of top N wallets' volume / total | none found | Legitimate MMs/whales; concentration also true of real thin markets |
| Share of volume from wallets < N days old | needs wallet first-seen time | none found | Fresh wallets are normal on new-token launches and for new users; old funded wallets can be used for wash (Bitquery: aged funder for one token) |
| Share of buys by bots/snipers | tag by same-block/first-N-slot buys, known program/bot labels | Bubblemaps "same block or within seconds of launch" (no number) | Labels lag new bot tooling; tipped/Jito bundles hide in shared slots |
| Holder growth | holders at t vs t0 | none | Airdrops/sybil holders inflate it; holder count via snapshot is noisy |
| Volume-to-liquidity | window volume / pool liquidity | MadeOnSol: >20:1 suspicious, 1:1 to 10:1 organic (unsourced) | Thin-liquidity but legitimate hot tokens; liquidity pulled; ratio is time-window dependent |
| Volume-to-market-cap | daily volume / mcap | A "Sigel" analysis reportedly used it (unverified, see Gaps) | Mcap derived from price × supply, easy to manipulate |
| Price impact per dollar traded | Δprice per $ of net flow | none found | Needs good pool-state reconstruction; wash flows at balanced two-sided volume have zero net impact (which is itself a signal) |
| Repeated identical sizes / fixed intervals | histogram of trade sizes and inter-trade deltas per wallet | MadeOnSol qualitative only | Bots can jitter; DCA tools/legitimate bots also repeat |
| Round-trip patterns | per-wallet buy and sell of same token with near-zero net | Bitquery: 0.95-1.00 ratio and 96% two-sided in one case | MMs and arbitrageurs are legitimately two-sided; routes through multiple pools hide cycles |
| Funding-source clustering | first inbound SOL sender per wallet | Bitquery: 30/30 matched in one case; failed (diffuse dust funding) in two | Exchange-funded or mixer-funded wallets look unrelated; common funder like an exchange hot wallet over-merges |
| Volume from tracked smart wallets only | volume restricted to a labelled set | none | Label set selection bias, survivorship; small samples |

- The common theme: single metrics are easy for an operator to randomise; Bitquery itself needed a composite score plus a funding trace, and its funding trace failed on two of five suspects.

### Gaps
- No credible-source numeric thresholds found for: top-N concentration, wallet-age share, bot/sniper share, holder growth, price impact per dollar, identical-size repetition counts.
- The Sigel analysis (reported 41.4% of Solana memecoin and NFT volume as wash trading using a volume/market-cap threshold ratio) appeared only in a search summary; primary source not opened and threshold unknown.
- Primary academic literature (e.g. Cong et al. on wash trading, Victor & Weintraud) was only seen as secondary quotes inside the TUM thesis; their metric definitions were not read here.
- I did not find any peer-reviewed Solana-specific definition of "organic" volume.

---

## Q4. How often do new Solana tokens have mostly inorganic activity? (independent vs vendor)

### Takeaway
There is no independent, representative measurement of the share of new Solana tokens with mostly inorganic activity. What exists is (a) case studies of selected suspects, (b) one unreviewed master's thesis on curated high-risk tokens, and (c) vendor/analyst headline figures (e.g. "up to 93%") with weak or unverified methodology. Prevalence numbers should not be quoted as measured facts.

### Cited Findings
**Independent or academic (limited)**
- TUM master's thesis (June 2025): wash trading detected on Solana AMM tokens, concentrated in few accounts and tokens, but applied to a hand-selected high-risk set, so it gives no market-wide prevalence. — [Wiedenmann thesis](https://www.cs.cit.tum.de/fileadmin/w00cfj/sebis/thesis/250610_Wiedenmann_Thesis.pdf)
- A WWW 2024 paper on Solana NFT pools found 138 pools involved in wash trading, 8 with a wash rate above 50%; this is NFTs, not fungible tokens (search-snippet only). — [arXiv 2403.10879](https://web3.arxiv.org/abs/2403.10879)

**Vendor case studies (selection-biased)**
- Bitquery (data vendor): of five tokens selected as top wash suspects from a 12-hour window (27-28 April 2026), three traced to a single funder and two were diffusely funded; OpenLie had 96% two-sided wallets. Article contains no market-wide estimate. — [Bitquery](https://bitquery.io/blog/solana-volume-numbers-are-a-lie)
- Bitquery's America250 investigation: ~6,000 "buyers" funded by shared hubs and about 99% of volume SOL cycling back (search-snippet only). — [Bitquery: America250](https://bitquery.io/investigations/token-factory-america250)

**Headline claims (weak provenance)**
- Flip Research (July 2024, "SOL- The Emperor's New Clothes"): up to 93% of Solana trading activity may be non-organic; 282.2M transactions vs 1.3M daily active users (about 217 per user) on 26 July 2024 compared with Ethereum under 3 per user. Only one outlet reports the 93% figure; the report itself was not read. — [Benzinga](https://benzinga.com/z/40071441); [Cryptonews](https://cryptonews.com/news/bots-suspected-in-solanas-surge-over-ethereum-claims-researcher-flip-research/)
- Flip Research cited a Raydium pool with ~$3 liquidity and over $5M 24h volume; Glassnode reportedly flagged a pool with $7 liquidity and almost $400K 24h volume (secondhand). — [Cointelegraph](https://cointelegraph.com/news/bots-pushing-solana-over-ethereum-research); [Cointelegraph on Glassnode](https://cointelegraph.com/markets/solana-record-318b-transfer-volume-bot-driven-wsol-price-suffer)
- Jupiter's own data: for top-scoring tokens organic buy volume was 0.06% to 13.6% of buy volume (24h), a measurement of "not on bot list" volume, not a wash estimate. — [Jupiter blog](https://developers.jup.ag/blog/what-is-organic-score)

### Inferences
- Selection bias dominates the sourceable evidence: Bitquery ranked by trade count, which finds wash tokens by construction; it cannot estimate prevalence.
- Flip's per-user transaction ratio conflates bots, arbitrage, MEV and spam with wash trading on non-memecoin activity; it speaks to chain activity, not new-token activity.
- Pool-fee economics (cheap wash trading, per MadeOnSol arithmetic) make high prevalence plausible but do not measure it.

### Gaps
- No peer-reviewed, representative sample of new Solana tokens (e.g. pump.fun launches or Raydium/PumpSwap new pools) with organic/wash classification.
- A search summary referred to a July 2026 study estimating bot-related DEX transactions at over $250M daily volume in January 2026; no URL or primary was retrieved, so not used.
- Vendor reports from Pine Analytics, Helius, Chainalysis, Solidus were searched in passing but no relevant document was retrieved.

---

## Q5. Typical "minimum viable organic activity" thresholds used by bots/screeners and their provenance

### Takeaway
I found no well-sourced thresholds for minimum unique traders, holders or 5-minute volume. The open-source bots examined either log organic score without gating or gate only on contract-safety/liquidity filters, and the only numeric heuristics (MadeOnSol) are unsourced.

### Cited Findings
- Meridian (open-source agent): `organicScore` is informational only (shown on cards, not gating). Its `blockJupiterSuspicious` filter blocks when `audit.isSus` is present or the token is banned; unknown tokens or lookup failures are allowed; checks cached 60 s; filter is default on and the agent may only tighten it. — [fciaf420/meridian PR #107](https://github.com/fciaf420/meridian/pull/107)
- Asayed36 paper-trading bot: logs Jupiter `organicScore`, label and `stats1h` fields at every paper buy, logging only, no trading rule uses them; stores seconds since token creation at lookup. Uses lite-api search; 5-8 s lookup timeout; re-checks every 10 s. — [Asayed36/trading-bot PR #206](https://github.com/Asayed36/trading-bot/pull/206)
- Generic Solana sniper repos reviewed via search listing filter on liquidity bounds, burn, mint/freeze-authority renounced; holder/unique-buyer settings were not visible in the snippets. — [fdundjer/solana-sniper-bot](https://github.com/fdundjer/solana-sniper-bot); [GoldRush sniper guide](https://goldrush.dev/guides/building-a-solana-memecoin-sniper-bot-using-the-goldrush-streaming-api-part-1/)
- Webacy docs example for bots: skip tokens with overall risk above 70 (a risk score, not an activity threshold). — [Webacy docs](https://docs.webacy.com/integrations/agent-reference)
- MadeOnSol (unsourced): fewer than 100 holders on a high-volume token is a warning; volume/liquidity above 20:1 suspicious; wait 24-48h to see whether volume persists. — [MadeOnSol](https://madeonsol.com/blog/solana-volume-bots-explained)

### Inferences
- Because Jupiter's score is relative and "early growth matters most", a cutoff on `organicScore` for tokens minutes old will mostly reflect how few organic buyers there are, not manipulation; combining it with count-based minima (`numOrganicBuyers`, `numTraders`) from the stats windows is more interpretable, but values should be calibrated on the user's own data.
- Since the one bot that discards organic score as a gate does so without stated rationale, treat its choice as weak evidence that the score is not trusted for entries, not as a finding.

### Gaps
- No credible-provenance numeric minima for unique traders in the first N minutes, minimum holders, or minimum 5-minute volume were found (searched GitHub-style sources only briefly; no screener configs from named, credible practitioners were retrieved).
- Terminal/Telegram bot defaults (e.g. Trojan, BonkBot, Photon, GMGN filters) were not checked.
- Recommended next step if more is needed: pull defaults from specific open-source screener repos' config files and from GMGN/Photon/BullX filter documentation.
