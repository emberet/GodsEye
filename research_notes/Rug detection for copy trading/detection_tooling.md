# Solana token-risk / rug-detection tooling: coverage, latency, accuracy, cost (as of 2026-10-27)

Scope note: research used public documentation pages and web search only; nothing was signed up for and no vendor API was called. Several primary pages could not be read (listed under Gaps in each section). No source found gives a measured "seconds until first useful report" figure for any vendor.

## 1. What does each tool check, is there an API, what does it cost, and does it cover seconds-to-minutes-old tokens?

### Takeaway
Only a few tools expose structured Solana token-risk data through a real API with a free tier: RugCheck (already used), GoPlus (beta Solana endpoint, free tier), Jupiter Tokens v2 (free key, 1 rps), and Bubblemaps (credit-based, needs Pro key). None publishes an indexing-latency guarantee. Several others (SolSniffer, Token Sniffer, Birdeye security, Vybe) could not be verified from primary docs.

### Cited Findings

**RugCheck**
- Checks (third-party summary): mint/freeze authority, LP lock/burn, top holder concentration, creator holdings, market/liquidity data, metadata mutability; "doesn't detect bundled wallets" per one comparison page, while another (Solana Tracker blog, a competitor) says RugCheck-style scans cover snipers, bundlers, insider clusters and shared funding paths. These two descriptions conflict. — [MadeOnSol scanner roundup](https://madeonsol.com/blog/best-solana-token-scanners-rugcheck-solsniffer-defi); [Solana Tracker blog](https://www.solanatracker.io/blog/rugchecks)
- Known endpoint paths seen in third-party code: `/v1/tokens/{mint}/report/summary` and `/stats/new_tokens`; clients treat HTTP 429 as the rate-limit signal. — [goat-mcp RugCheck client](https://glama.ai/mcp/servers/@cryptoleek-team/goat-mcp/blob/d2e796192eac82c5c78f93be345183d7007d034f/rugcheck/src/api.ts); [RugCheck skill listing](https://termo.ai/skills/rugcheck)
- API key: a Feb 2026 blog (secondary, unverified) says an API key is generated in the rugcheck.xyz dashboard and sent as `X-API-KEY`. The bot currently calls the report endpoint keyless. — [Qodex blog](https://qodex.ai/blog/how-to-get-a-rugcheck-api-key-and-start-using-the-api)
- RugCheck's own site says it covers "Solana and Fogo" tokens and links an API page, but the fetched text had no limits/pricing/ToS. — [rugcheck.xyz/api](https://www.rugcheck.xyz/api)
- The bot's own code warns "liquidity lock unknown (RugCheck has no pool data yet)", i.e. the bot already treats missing `markets` data as a known state for young coins. — local file `/Users/srinjoydas/GodsEye/agent/src/market/rugcheck.ts` (lines ~96-100)

**GoPlus Security (Solana)**
- Endpoint: `GET https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses=<mint>`, labelled Beta, `Authorization: Bearer <token>`; 200/401/403/404 responses documented. — [GoPlus docs](https://docs.gopluslabs.io/reference/solanatokensecurityusingget)
- Response fields: `mintable`, `freezable`, `closable`, `balance_mutable_authority`, `default_account_state`, `metadata_mutable`, `transfer_fee` (+upgradable), `transfer_hook` (+upgradable, with `malicious_address`), `none_transferable`, `creators[]` (with `malicious_address`), `holders` (top 10 with `is_locked`, `locked_detail`, `percent`, `tag`), `lp_holders` (top 10), `dex[]` (per pool `burn_percent`, `lp_amount`, `open_time`, `tvl`, `fee_rate`), `trusted_token`. — [GoPlus docs](https://docs.gopluslabs.io/reference/solanatokensecurityusingget)
- Free tier per GoPlus's (Chinese-language) security-API page: 150K monthly units, 30k/day, 150/min; paid tiers $199 to $3,499/mo, batch calls from the first paid tier. Docs page itself states no rate limits; a developer asking for real-time endpoint limits got no answer in the forum thread found. — [GoPlus security API page](https://gopluslabs.io/zh/security-api); [GoPlus forum](https://docs.gopluslabs.io/discuss/68d6607e1c829d912557b2bb)
- Docs describe the Solana API as covering SPL and SPL-2022 and surfacing "early risk signals"; no latency figure published. — [GoPlus docs home](https://docs.gopluslabs.io/)

**Birdeye token security**
- Data API tiers (from Birdeye pricing docs as summarised by search): Standard free 1 rps; Starter $99 15 rps; Premium $199 50 rps / 1,000 rpm; Premium Plus $250; Business $699, 70M compute units, 100 rps / 1,500 rpm, all APIs plus websockets; Business Classic $999; Enterprise custom. Limits apply at account level. A third-party skill listing says free is 30K CU/month at 1 rps. — [Birdeye pricing](https://docs.birdeye.so/docs/pricing); [Birdeye rate limiting](https://docs.birdeye.so/docs/rate-limiting); [skill listing](https://skillselion.com/skills/agiprolabs/claude-trading-skills/birdeye-api)
- A third-party listing says the security call covers ownership, mintability, freezability, top-holder concentration, mutable metadata and rug indicators. Not confirmed from Birdeye's own endpoint page (fetch timed out). — [skill listing](https://skillselion.com/skills/starchild-ai-agent/official-skills/birdeye)

**SolSniffer**
- Third-party descriptions: Snifscore 0-100 from 20+ indicators (mint/freeze/metadata authorities, LP lock/burn, holder distribution, creation details, socials); API with batch lookups. — [MadeOnSol roundup](https://madeonsol.com/blog/best-solana-token-scanners-rugcheck-solsniffer-defi); [Bitbond overview](https://www.bitbond.com/resources/solsniffer-solanas-security-and-analytics-platform/)
- Pricing is contradictory across third parties: "100 free calls per month, paid from $47/mo" (MadeOnSol roundup) vs "free" (MadeOnSol compare pages). Official docs at solsniffer.com/api-service/ could not be opened. — [MadeOnSol roundup](https://madeonsol.com/blog/best-solana-token-scanners-rugcheck-solsniffer-defi); [MadeOnSol compare](https://madeonsol.com/compare/solsniffer-vs-tokenspy)

**Token Sniffer (owned/hosted by Solidus Labs)**
- API: Pro pack $99/mo for 500 smell tests and 500 tokens per day; Enterprise (custom) adds latest tokens and pairs (24h, scam or not), malicious token/address lists, event monitoring, historical rug DB. The page does not mention Solana. — [Solidus TokenSniffer API](https://www.soliduslabs.com/tokensniffer/api)
- Solana support is disputed: one directory says Solana plus 15 networks, another frames TokenSniffer as EVM with Solana a gap. — [MadeOnSol](https://madeonsol.com/compare/getblock-vs-tokensniffer); [Sharpe comparison](https://www.sharpe.ai/compare/sharpe-vs-tokensniffer)

**DexScreener**
- Not a risk scanner. Pair schema gives `pairCreatedAt`, `liquidity.usd/base/quote`, `txns`, `volume`, `fdv`, `marketCap`, `labels`, `info`, `boosts`. Documented 60 requests/min on token-profiles/latest, recent-updates, community-takeovers, ads, metas. Pair/token endpoints list no limit on the official page; third parties repeat ~300/min for DEX data and max 30 addresses per tokens call. — [DexScreener API reference](https://docs.dexscreener.com/api/reference); [openSVM MCP README](https://cdn.jsdelivr.net/gh/openSVM/dexscreener-mcp-server@main/README.md)
- Useful as a "does a pool exist and how big is its liquidity" cross-check only.

**Jupiter (Tokens v2, Shield, strict/verified)**
- Tokens API v2: `/tokens/v2/search` (up to 100 mints comma-separated), `/tag?query=verified|lst|stocks`, `/toporganicscore|toptraded|toptrending/{interval}`, `/recent` (30 mints by default, ordered by first-pool creation time). Fields: `audit.mintAuthorityDisabled`, `audit.freezeAuthorityDisabled`, `audit.topHoldersPercentage` (0-100), `organicScore` + label, `isVerified`, `tags` (verified/strict/community), holder count, liquidity, mcap. Rate limits not stated on the page. — [Jupiter Tokens v2](https://developers.jup.ag/docs/tokens/v2)
- API access: keyless 0.5 rps; free key 1 rps; Pro $500/mo at 150 rps. — [Jupiter API setup](https://developers.jup.ag/docs/api-setup)
- Shield warnings: `NOT_VERIFIED`, `LOW_ORGANIC_ACTIVITY`, `NEW_LISTING`, `HAS_FREEZE_AUTHORITY`, `HAS_MINT_AUTHORITY`; severities `info`/`warning`; sourcing not described; the page notes the Ultra Swap API "is no longer actively maintained and has been superseded by Swap V2". — [Jupiter Shield](https://developers.jup.ag/docs/ultra-api/shield)
- Meteora says JupShield combines Jupiter's tech with RugCheck and Blockaid. — [Meteora docs](https://docs.meteora.ag/user-guide/usage/staying-safe)
- Verification can be removed (no liquidity, stopped trading, moved contract, ticker conflict). Unverified tokens remain tradable. — [Jupiter verification docs](https://docs.jup.ag/user-docs/launch/vrfd/token-verification)
- Strict list is being replaced by a single aggregated list with tags; strict repo to be deprecated. — [Jupiter forum](https://discuss.jup.ag/t/ecosystem-master-token-list/19786)

**Bubblemaps (Data API)**
- OpenAPI `/v0` endpoints: `tokens/search`, `tokens/metadata/{chain}/{addr}`, `tokens/holders` (limit 80/250/500, `refresh`), `tokens/map` (clusters, `magic_nodes`, `time_nodes`, `return_relationships`), `tokens/metrics`, `tokens/screenshot`, `addresses/metadata` (batch to 2,500), `relationships/subgraph`. Solana is a supported chain. Auth `X-ApiKey`. — [Bubblemaps OpenAPI](https://docs.bubblemaps.io/openapi.json)
- Cluster fields: `share`, `amount`, `holder_count`, `holders`, `magic_node_count`, `time_node_count`. Score fields: `bubblemaps_score` (nullable), `gini_index`, `herfindahl_hirschman_index`, `nakamoto_coefficient`. `supply_stats` includes `cexs`, `dexs`, `contracts`, `fresh_wallets`, `top_10_adjusted`, and a single numeric `bundles`; no dedicated bundle object. — [Bubblemaps OpenAPI](https://docs.bubblemaps.io/openapi.json)
- Keys from the Pro platform; monthly credits per subscription, per-endpoint credit costs (some optional params cost more); over-credit gives 429; separate 10k calls/min per-IP limit. Plan prices not found. — [Bubblemaps auth docs](https://docs.bubblemaps.io/data/api/authentication.md)

**Helius**
- Plans: Free $0 (1M credits, 10 RPC rps, 2 DAS rps); Developer $49 (10M, 50 rps, 10 DAS rps); Business $499 (100M, 200 rps, 50 DAS rps); Professional $999 (200M, 500 rps, 100 DAS rps). DAS call = 10 credits, standard RPC = 1, getProgramAccounts = 10, webhook push = 1, Parsed Events API = 10 per request (page tells users to migrate off Enhanced Transactions). LaserStream gRPC: not on Free, devnet-only on Developer, mainnet from Business; data add-ons only on Professional ($400 per 5TB up). Webhooks on every plan, count limit not stated. — [Helius pricing](https://www.helius.dev/pricing.md)
- DAS `getAsset`/`searchAssets` for fungible tokens returns `token_info` (supply, decimals, token_program, price_info) and `mint_extensions` for Token-2022; the fetched page did not show `mint_authority`/`freeze_authority` fields. — [Helius fungible token extension](https://www.helius.dev/docs/das/fungible-token-extension.md)

**Solscan / Vybe / Moralis**
- Solscan Pro: Lite $49/mo 20M CU, 1,000 req/60 s (no multi or account-metadata/funded_by endpoints); Level 2 $199; Level 3 $399; `/token/meta` 100 CU on V2. Pages disagree on Level 4 ($1,099). — [Solscan API levels](https://docs.solscan.io/api-access/solscan-pro-api-levels-and-details); [Solscan Lite](https://docs.solscan.io/api-access/solscan-api-lite-plan); [CU calc](https://docs.solscan.io/api-access/solscan-pro-api-c.u-calculation)
- Vybe: conflicting third-party numbers (free 4 req/min and 12,000 credits/month; or pay-per-call USDC $0.01-$0.03 via pay.sh). No official risk/security endpoint found. — [Solana Compass](https://solanacompass.com/projects/vybe-network); [pay.sh news](https://solanacompass.com/news/vybe-network-goes-live-on-paysh-with-46-solana-analytics-endpoints-for-ai-agents)
- Moralis: pump.fun endpoints for new, bonding, graduated tokens and bonding status (launched March 2025), PumpSwap support; plan-based limits (FAQ: free "typically 25 requests per second with a daily quota"); a separate Data Feeds product streams pump.fun launch events. No risk/security fields found. — [Moralis changelog](https://docs.moralis.com/changelog/pump-fun-api); [Moralis FAQ](https://docs.moralis.com/web3-data-api/solana/tutorials/pump-fun-api-faq); [Moralis feed recipe](https://docs.moralis.com/data-feeds/recipes/token/token-bonding-status)

**Solana Tracker (not requested but relevant)**
- Risk object: score 1-10, `rugged`, `jupiterVerified`, `top10`, `dev`, `snipers`, `insiders`, `bundlers` (wallet counts, balances, percent of supply), `fees`, `risks[]`. No prices, limits or latency in the article. — [Solana Tracker risk API article](https://www.solanatracker.io/resources/check-solana-token-rug-risk-api)

**pump.fun's own API**
- No official documentation found. A community reference lists `frontend-api-v3.pump.fun` (`/coins/{mint}`, `/trades/all/{mint}`), JWT bearer auth, `x-ratelimit-*` headers and 429s; unofficial and unverified. — [BankkRoll pumpfun-apis](https://github.com/BankkRoll/pumpfun-apis); [rate limiting page](https://www.mintlify.com/BankkRoll/pumpfun-apis/essentials/rate-limiting)
- PumpPortal docs could not be found by search.

**Open-source detectors**
- `solwatch` (Rust crate): reads mint account for freeze/mint authority and Token-2022 traps, bundle risk, 0-100 score; "bundle" method not explained in the docs found. — [docs.rs solwatch](https://docs.rs/crate/solwatch/0.1.7)
- RugCheck AI MCP server (Python, MIT): getAccountInfo-based mint/freeze/Token-2022 screening, self-hostable, plus sell simulation for honeypots; listing says "quality - not tested". — [Glama listing](https://glama.ai/mcp/servers/c6r74ryf9e); [mcpservers.org](https://mcpservers.org/zh-TW/servers/mrwizardlyloaf/rugcheck-ai)
- "Solana Rug Guard" (Python, MIT, 13-factor score incl. LP locks, holder concentration, sniper patterns): evidence is only a DexScreener promo page; treat as unverified. — [DexScreener page](https://dexscreener.com/solana/F4J5LKyEQraMem8nspPAzwHXaaKMMDsxyt7GUK94pump)
- SolRugDetector (academic, March 2026) is rule-based on on-chain data; code release not confirmed. — [arXiv 2603.24625](https://arxiv.org/abs/2603.24625)
- I did not open any GitHub repo directly, so licenses, maintenance and star counts are unverified.

### Inferences
Comparison table (cells marked "(unverified)" rest on third-party or incomplete sources):

| Tool | Real API? | Free tier / price | Rate limit | Signals vs what the bot already has | Seconds-old tokens |
|---|---|---|---|---|---|
| RugCheck | Yes | Free, bot uses keyless; key may now be required (unverified) | Not published; 429s | Score, risks[], LP lock %, insider networks | Bot code says pool data can be missing; no timing published |
| GoPlus Solana | Yes (beta) | Free 150K units/mo, 150/min; paid $199-$3,499 | Free: 30k/day, 150/min (Chinese page) | Authorities, extensions, holders top 10 with locks, LP holders, per-pool LP burn %, malicious-address flags | No latency published |
| Birdeye security | Yes (unverified endpoint detail) | Free 1 rps tiny CU; $99-$699+ | 1 to 100 rps by tier | Authorities, top holders (unverified) | Unknown |
| SolSniffer | Yes (unverified) | 100 free calls/mo vs "free" (conflict) | Unknown | Snifscore + authorities, LP, holders | Unknown |
| Token Sniffer | Yes, Solana unclear | $99/mo Pro, 500/day | 500/day | EVM-centric | Unknown |
| DexScreener | Yes | Free | 60/min profiles; ~300/min pairs (third party) | Pool existence, liquidity, pair age | Not a risk tool |
| Jupiter Tokens v2 / Shield | Yes | Free 1 rps key; Pro $500 150 rps | 0.5 / 1 / 150 rps | Authorities, top holders %, organic score, verified | `recent` is by first-pool creation; new coins will be unverified by definition |
| Bubblemaps | Yes | Credits, price not found | 10k/min per IP + credits | Clusters, top-10 adjusted, fresh wallets, bundle count | Unknown; `refresh` param exists |
| Helius | Yes (RPC/DAS/gRPC/webhooks) | Free to $999 | 10 to 500 rps | Raw data, not verdicts | Chain-fresh (RPC) |
| Solscan / Vybe / Moralis | Yes | $49+ / unclear / plan-based | See above | Token meta/holders; no verdicts | Unknown |
| pump.fun | Unofficial only | n/a | Unknown | Bonding state, trades | Fresh at source |

---

## 2. Latency and coverage on minutes-old tokens: when does each tool first return a useful report?

### Takeaway
I found no published or independently measured time-to-first-report for RugCheck, GoPlus, Birdeye, SolSniffer or Bubblemaps. The only hard timing data is that Solana rugs are fast (median about 17 minutes in one study), which means any vendor lag of minutes covers much of a token's useful life. Latency must be measured empirically.

### Cited Findings
- Median rug-pull lifecycle on Solana was 0.0116 days (about 17 minutes) in the SolRugDetector labelled data, mean 1.03 days; median lifespans by type: rug pull 0.0246 d (~35 min), freeze-authority abuse 0.483 d, liquidity manipulation 0.0385 d (~55 min), pump-and-dump 0.0221 d (~32 min). The authors say most types have median lifecycle under an hour. — [arXiv 2603.24625 HTML](https://arxiv.org/html/2603.24625v1)
- Jupiter's `/tokens/v2/recent` orders by first pool creation, not mint time, and the page does not say whether all new tokens are covered. — [Jupiter Tokens v2](https://developers.jup.ag/docs/tokens/v2)
- Jupiter Shield has a `NEW_LISTING` warning, implying it treats newness as a risk flag rather than lacking data. — [Jupiter Shield](https://developers.jup.ag/docs/ultra-api/shield)
- GoPlus Solana: no latency figure found; vendor-scale claims only (30M+ daily API calls, 40+ chains). — [GoPlus blog](https://blog.gopluslabs.io/2025/07/17/financing/2025-07-17-ANNOUNCING-GoPlus-Security%E2%80%99s-Enhanced-Focus-on-Foundational-Web3-Security/)
- Solana Tracker's article says a scan is a snapshot at scan time that goes stale; recommends re-scanning after liquidity is added or moved, authority changes, or a new cluster appears. It names timeouts/rate limits as failure modes to treat as "unknown risk". — [Solana Tracker blog](https://www.solanatracker.io/blog/rugchecks)
- Third-party open-source projects explicitly read the mint on-chain "to assess a token too new to be indexed elsewhere" (vendor claim, not a measurement). — [mcpservers.org RugCheck AI](https://mcpservers.org/zh-TW/servers/mrwizardlyloaf/rugcheck-ai)
- A separate sniper-oriented project uses a 3.5 s timeout and 3 s cache for RugCheck calls, an example of how tight sniper integrations treat RugCheck latency. — [Glama token-rugcheck](https://glama.ai/mcp/servers/AetherCore-Dev/token-rugcheck/schema)
- Internal GodsEye data: 340 of 478 priced would-be copies were on tokens under 5 minutes old at the leader's buy, and the rug screen has never run live (0 rows in `rug_checks`), so RugCheck/RPC latency on young tokens is unmeasured in this project. — local file `/Users/srinjoydas/GodsEye/research_notes/Rug detection for copy trading/internal_audit.md`
- Search for DexScreener indexing delay on new PumpSwap pairs returned no documented number. — [search result set incl. MadeOnSol PumpSwap explainer](https://madeonsol.com/blog/what-is-pumpswap)

### Inferences
- Chain-derived signals (authorities, extensions, pool state) are available at the slot the mint/pool exists. Vendor-derived signals (RugCheck `markets`, GoPlus `dex`/`lp_holders`, Bubblemaps clusters, Jupiter organic score) depend on the vendor's indexer and are probably the later ones; ordering is a hypothesis, not measured.
- A bot that copies a leader within seconds cannot wait minutes for a vendor report, so vendor reports are better used as a second-stage veto (re-check at +1 to +5 min, for exits and position sizing) than as the entry gate.
- Cheapest way to get real latency numbers: a shadow job that, for every leader buy, polls RugCheck, GoPlus (free key) and Jupiter Tokens v2 every few seconds from the mint's first-seen time and logs the first time each returns non-empty pool/holder data. This also matches the shadow-mode recommendation in the internal audit.

### Gaps
- Time-to-first-useful-report for each vendor: not published anywhere found.
- RugCheck's official documentation (swagger, rate limits, ToS, whether a key is now required): `api.rugcheck.xyz/swagger/index.html` rendered only "Swagger UI", OpenAPI json paths returned 404, `docs.rugcheck.xyz` did not resolve.
- DexScreener, Birdeye and GeckoTerminal pool-indexing delay: no sources found.

---

## 3. Independent accuracy evidence (precision/recall, false positives, failure modes)

### Takeaway
There is exactly one independent-ish quantitative comparison on Solana: the March 2026 SolRugDetector paper, which scored RugChecker (rugcheck.xyz), Solsniffer, Solanatracker and a fourth tool. It is not a test of early prediction, and the paper's authors built a competing tool. Everything else is EVM-only academic work or vendor marketing. No benchmark of GoPlus Solana, Birdeye, Bubblemaps or Jupiter Shield on Solana was found.

### Cited Findings
- SolRugDetector Table IV on a 182-token set (117 rug pulls from incident reports + 65 legitimate tokens that are Jupiter-verified with Organic Score at least 80): — [arXiv 2603.24625 HTML](https://arxiv.org/html/2603.24625v1)

| Method | Applicability | Precision | Recall | F1 |
|---|---|---|---|---|
| SolRugDetector (authors') | 100% | 100% | 93.16% | 96.46% |
| Solana Rug Checker | 96.15% | 67.74% | 35.90% | 46.93% |
| RugChecker (rugcheck.xyz) | 100% | 76.92% | 94.02% | 84.62% |
| Solsniffer | 100% | 67.45% | 97.44% | 79.72% |
| Solanatracker | 99.45% | 98.96% | 81.89% | 89.62% |

- Authors say RugChecker and Solsniffer have high recall and lower precision from "casting a wider net"; some tools flagged USDC and USDT as rug pulls. They argue tools rely on static metadata (e.g. freeze authority retained) and miss behavioural rugs like pump-and-dump, and that attackers can renounce permissions at creation. — [arXiv 2603.24625 HTML](https://arxiv.org/html/2603.24625v1)
- Paper does not say when baselines were queried relative to token creation or what output counted as a "flag". SolRugDetector's rules were derived from the same 117 rug tokens used in evaluation, which may inflate its numbers. Paper limits its own detection to the first 24 hours. — [arXiv 2603.24625 HTML](https://arxiv.org/html/2603.24625v1)
- The paper's own large-scale labelling: 76,469 of 100,063 tokens launched on Orca, Raydium and Meteora in H1 2025 flagged as rug pulls (76.42%); manual audit of 382 flagged tokens found 1 false positive (0.26%), but 9 of 100 unflagged tokens were false negatives. Rules: freeze authority abuse, liquidity withdrawal by a creator-linked address, pump-and-dump (holder drop at least 0.73). — [arXiv 2603.24625 HTML](https://arxiv.org/html/2603.24625v1)
- SoK on DeFi rug pulls (ISSTA 2025) assessed 14 tools on Ethereum/BNB data only (no Solana): GoPlus averaged 50% hit rate on combination cases, Blocksafu 45%, Token Sniffer 0%; best root-cause coverage De.Fi 61.76% (21/34); 9 root causes missed by all tools. No false-positive rate reported. — [arXiv 2403.16082 HTML](https://arxiv.org/html/2403.16082v1); [ISSTA 2025](https://conf.researchr.org/details/issta-2025/issta-2025-papers/25/SoK-A-Taxonomic-Analysis-of-DeFi-Rug-Pulls-Types-Dataset-and-Tool-Assessment)
- ICSE 2024 "Stop Pulling my Rug" reports its own tool Tokeer at 98.0% recall and 98.9% precision, outperforming GoPlus and Pied-Piper (EVM; GoPlus's own figures not in the snippet). Vendor-of-method claim. — [ICSE 2024](https://conf.researchr.org/details/icse-2024/icse-2024-software-engineering-in-practice/11/Stop-Pulling-my-Rug-Exposing-Rug-Pull-Risks-in-Crypto-Token-to-Investors)
- Solidus Labs (which hosts the TokenSniffer API) reports about 98.7% of pump.fun tokens (Jan 2024 to Mar 2025, 7M+ tokens, those with at least five trades) showed pump-and-dump or rug characteristics and 93% of Raydium pools showed soft-rug traits; one summary says the 98.6% metric is liquidity falling below $1,000, which marks collapse not proven fraud. Only about 97,000 of 7M+ pump.fun coins kept at least $1,000 liquidity. Vendor report, not peer reviewed. — [Solidus report](https://www.soliduslabs.com/reports/solana-rug-pulls-pump-dumps-crypto-compliance); [DeepStrike summary](https://deepstrike.io/blog/rug-pull-statistics); [The Defiant](https://thedefiant.io/alarming-99-of-memecoin-launches-on-pumpfun-are-pump-and-dumps-or-rug-pulls-report)
- Qualitative failure modes named by comparison sites: single score compresses risks; a 15% and 50% creator holding can be flagged the same; renounced authority does not rule out concentrated supply; an LP lock does not stop insiders selling; a token can pass a static scan and later gain a new wallet cluster. No measured rates. — [MadeOnSol roundup](https://madeonsol.com/blog/best-solana-token-scanners-rugcheck-solsniffer-defi); [Solana Tracker blog](https://www.solanatracker.io/blog/rugchecks); [DEXTools comparison via search](https://www.dextools.io/tutorials/rugcheck-vs-token-sniffer-comparison)
- Internal GodsEye tape (10 days, 478 priced would-be copies): 16.5% fell at least 50% within 60 min, 1.3% at least 90%, 14.0% had a leader sell at 50% of entry or worse; the author flags that the tape goes silent after a liquidity pull, so these are lower bounds. — local file `/Users/srinjoydas/GodsEye/research_notes/Rug detection for copy trading/internal_audit.md`

### Inferences
- The paper's negatives are blue-chip Jupiter-verified tokens, so the precision numbers are not a false-alarm rate on legitimate brand-new memecoins, the population a copy-trader actually faces. The USDC/USDT false alarms suggest score-threshold tools mis-flag established tokens; the bot already allowlists such mints.
- The 94% RugCheck recall most likely reflects flags that appear after the rug (rugged/LP removed). It is not evidence that RugCheck predicts rugs at minute 1. The paper does not specify timing, so this is a reading, not a finding.
- The paper's numbers are the best available prior for ranking vendors on Solana (Solanatracker highest precision; Solsniffer highest recall; RugCheck balanced), but they come from a competing tool's authors on a small set, so they should be treated as hypothesis-grade.

### Gaps
- No independent Solana evaluation of GoPlus, Birdeye security, Bubblemaps or Jupiter Shield.
- No dataset of "safe-scored then rugged" Solana cases with timing; no precision/recall at fixed token ages (e.g. at 30 s, 2 min, 5 min).
- MemeTrans (84% high-risk) and Chen ~76% figures cited in the internal audit were not re-verified here.

---

## 4. Which signals are cheap to compute ourselves versus vendor-only?

### Takeaway
Everything in the bot's current hard-block list that is a property of the mint, extensions, pool or early holders can be read from RPC or a gRPC stream with no vendor. Vendors add value mainly through labelled/reputation data (malicious addresses, verified lists, cross-token creator history, entity clustering) and through caching expensive multi-call scans.

### Cited Findings
- Vendors themselves expose mint/freeze and Token-2022 fields that are simply mint-account reads: GoPlus `mintable`, `freezable`, `transfer_hook`, `default_account_state`; Jupiter `audit.mintAuthorityDisabled/freezeAuthorityDisabled`. — [GoPlus docs](https://docs.gopluslabs.io/reference/solanatokensecurityusingget); [Jupiter Tokens v2](https://developers.jup.ag/docs/tokens/v2)
- Open-source projects confirm the pattern: authorities and Token-2022 traps read directly via `getAccountInfo` on the mint, no indexer needed. — [Glama RugCheck AI](https://glama.ai/mcp/servers/c6r74ryf9e); [docs.rs solwatch](https://docs.rs/crate/solwatch/0.1.7)
- Helius DAS returns token supply/extension data but, on the page read, not mint/freeze authority; DAS calls cost 10 credits and RPC 1 credit, with gRPC streaming from Business ($499). — [Helius fungible token extension](https://www.helius.dev/docs/das/fungible-token-extension.md); [Helius pricing](https://www.helius.dev/pricing.md)
- Vendor-only items observed: GoPlus `malicious_address` tags and `trusted_token`; Jupiter `isVerified`, `organicScore`; Bubblemaps `time_nodes`/`magic_nodes` clusters and `bubblemaps_score`; Token Sniffer historical rug DB (Enterprise); RugCheck `insiderNetworks`. — [GoPlus docs](https://docs.gopluslabs.io/reference/solanatokensecurityusingget); [Jupiter Tokens v2](https://developers.jup.ag/docs/tokens/v2); [Bubblemaps OpenAPI](https://docs.bubblemaps.io/openapi.json); [Solidus TokenSniffer API](https://www.soliduslabs.com/tokensniffer/api)
- SolRugDetector's rules (freeze-authority use, creator-linked address profiting from liquidity removal, holder-count decline) are all derivable from transaction and state data alone, per the authors. — [arXiv 2603.24625 HTML](https://arxiv.org/html/2603.24625v1)

### Inferences
(From general Solana knowledge, not from a cited page.)
- Cheap, own-computable, near-instant: mint/freeze authority; Token-2022 extensions (permanent delegate, pausable, default frozen, transfer fee, transfer hook); metadata mutability; supply; LP token burn or LP-lock status for known AMM programs and pump.fun curve/PumpSwap state; sell-ability by `simulateTransaction` of a sell; launch-slot buyers from a gRPC block/transaction stream.
- Moderate cost: top-N holder share (needs largest-accounts plus owner resolution, AMM and curve vaults excluded); first-funder tracing for top holders (several RPC calls per wallet, rate-limit sensitive); creator wallet history (signature scan) and prior-token outcomes if the bot keeps its own database.
- Vendor-only or impractical to rebuild: curated malicious-address and scam-token labels, Jupiter verification/organic score, cross-chain entity clustering, years of historical rug databases, social/off-chain signals.
- A homegrown creator-reputation table built from the bot's own observed launches is probably the highest-value signal no vendor sells, and grows with every shadow-mode run.

### Gaps
- Whether Helius `getAsset` exposes mint/freeze authority was not confirmed (page showed a trimmed sample).
- No source quantified RPC cost (calls, credits) of full holder/funder clustering on young tokens.

---

## 5. Licensing, ToS and reliability concerns for commercial or multi-request-per-second use

### Takeaway
ToS were not readable for most vendors. The firm facts are rate/credit ceilings: free tiers are 1 rps or lower for Jupiter, Birdeye and Helius DAS (2 rps), so "several requests per second" per vendor needs a paid plan or batching. RugCheck's limits and commercial terms are undocumented in anything I could read.

### Cited Findings
- Jupiter: keyless 0.5 rps, free key 1 rps, Pro $500/mo 150 rps; Tokens v2 search batches up to 100 mints per call. — [Jupiter API setup](https://developers.jup.ag/docs/api-setup); [Jupiter Tokens v2](https://developers.jup.ag/docs/tokens/v2)
- Jupiter Ultra Swap API (where Shield is documented) is no longer actively maintained, superseded by Swap V2. — [Jupiter Shield](https://developers.jup.ag/docs/ultra-api/shield)
- Birdeye: Standard 1 rps; Starter 15 rps; Premium 50 rps; Business 100 rps/1,500 rpm; account-level limit; wallet endpoints have a lower limit. — [Birdeye pricing](https://docs.birdeye.so/docs/pricing); [Birdeye rate limiting](https://docs.birdeye.so/docs/rate-limiting)
- GoPlus: free 150/min and 30k/day; batch calls only on paid tiers; docs page gives no limits and the Solana endpoint is labelled Beta. — [GoPlus security API page](https://gopluslabs.io/zh/security-api); [GoPlus docs](https://docs.gopluslabs.io/reference/solanatokensecurityusingget)
- Bubblemaps: credit-based; over-credit gives 429; 10k calls/min per IP; early-version API ("will be built out over time"). — [Bubblemaps auth](https://docs.bubblemaps.io/data/api/authentication.md); [Bubblemaps intro](https://docs.bubblemaps.io/data/api/introduction.md)
- Helius: DAS limits 2/10/50/100 rps by plan; 429 on excess; webhooks 1 credit per push. — [Helius pricing](https://www.helius.dev/pricing.md); [Helius rate limits](https://docs.helius.xyz/docs/billing/rate-limits.md)
- DexScreener: 60 rpm on profile/ads/metas endpoints. — [DexScreener API reference](https://docs.dexscreener.com/api/reference)
- Solscan Lite 1,000 req/60 s, excludes multi endpoints. — [Solscan Lite](https://docs.solscan.io/api-access/solscan-api-lite-plan)
- pump.fun: only unofficial documentation; JWT auth and 429s claimed. — [BankkRoll pumpfun-apis](https://github.com/BankkRoll/pumpfun-apis)
- Solana Tracker SDK: rate-limit errors carry `retryAfter`; REST client has no built-in timeout/retry. — [Solana Tracker article](https://www.solanatracker.io/resources/check-solana-token-rug-risk-api)
- Third-party RugCheck wrappers treat 429 as the limit signal; no documented numeric cap found. — [goat-mcp client](https://glama.ai/mcp/servers/@cryptoleek-team/goat-mcp/blob/d2e796192eac82c5c78f93be345183d7007d034f/rugcheck/src/api.ts)

### Inferences
- Single-vendor dependency risk is real: RugCheck keyless access could be gated or throttled without notice (a Feb 2026 post already describes API keys). The bot's current fail-open for RugCheck (on-chain checks continue) is the right design; the blocking checks that matter most already come from RPC.
- Beta (GoPlus Solana), "early version" (Bubblemaps) and "no longer actively maintained" (Jupiter Ultra/Shield) labels mean schema changes are likely; wrap each vendor behind an adapter and log raw responses.
- Redistribution: the project policy is a public, read-only, redacted site, so showing vendor-derived scores publicly may need a licence check per vendor; no ToS text was read, so this is unchecked.

### Gaps
- ToS/commercial-use/redistribution terms for RugCheck, GoPlus, Birdeye, Jupiter, Bubblemaps, SolSniffer and Token Sniffer: not read (pages not retrieved or not found).
- Birdeye token-security endpoint page (timed out), SolSniffer official API page, Token Sniffer readme (`tokensniffer.readme.io`), Vybe official docs, PumpPortal docs: not read.
- Bubblemaps plan prices and per-endpoint credit costs: not found.

---

## 6. Verdict: which sources to use alongside RugCheck

### Takeaway
Keep on-chain RPC checks as the gate (they are the only signals available at second zero), keep RugCheck as a fail-open secondary signal, add GoPlus (free tier) and Jupiter Tokens v2 (free key) as cheap second opinions, and add Bubblemaps only as an asynchronous cluster check if its credit price is acceptable. Do not pay for SolSniffer, Token Sniffer or Birdeye security before measuring. This verdict is an inference from the findings above, not a sourced claim.

### Inferences
1. **Primary gate (own code, RPC/gRPC):** authorities, Token-2022 extensions, LP burn/pool state, sell simulation, launch-slot bundle share, holder/funder clustering. Already largely in `rugcheck.ts` and `holders.ts`. Evidence: vendors' own fields for these are plain mint reads; SolRugDetector's rules are all on-chain.
2. **RugCheck:** keep, but treat "empty markets / no pool data" as an explicit UNKNOWN state with a bounded retry (e.g. re-check at +30 s, +2 min) instead of a pass or fail; paper suggests it is high recall, moderate precision (76.9%), so use score as a veto with a high threshold, not as the sole reason to block.
3. **GoPlus Solana (add):** free, structured, includes top-10 holders with lock detail, per-pool LP burn % and malicious-address tags, which RugCheck does not obviously offer. Beta label and unknown latency mean: shadow-log first, never fail closed on it.
4. **Jupiter Tokens v2 (add):** free key at 1 rps with 100-mint batching is cheap enough for post-entry re-checks (organic score, holder count, verified). Do not block on `NOT_VERIFIED` or `NEW_LISTING`: every fresh memecoin has them. Do not depend on Shield, because its host API is unmaintained.
5. **Bubblemaps (conditional):** the only Solana-capable vendor with a purpose-built cluster model (`time_nodes`, `magic_nodes`, `top_10_adjusted`, `fresh_wallets`, `bundles`). Use as an async confirmation for coins that already passed the gate (position sizing or early exit), not an entry gate; price unknown, so check credits before committing.
6. **Helius:** use for RPC/DAS and, if the stream isn't already covered, gRPC from the $499 Business plan; do not use DAS or Enhanced Transactions as a risk source. The page recommends migrating Enhanced Transactions to the Parsed Events API.
7. **Skip for now:** SolSniffer (conflicting pricing, docs unreadable, lowest precision tier in the only comparison), Token Sniffer (Solana support unconfirmed; $99/mo for 500 tests a day is too small for per-buy checks), Birdeye security (needs paid tier for more than 1 rps, endpoint unverified), DexScreener (no risk data), Solscan/Vybe/Moralis (no verdict fields; Moralis pump.fun feed is a launch-discovery option rather than a rug check), pump.fun frontend API (unofficial, JWT, Cloudflare risk).
8. **Highest-value next step is measurement, not more vendors:** run the shadow harness described in Section 2 and the internal audit so that, within a couple of weeks, the project has its own per-vendor time-to-first-report and its own label-versus-outcome table. Public evidence is too thin to pick winners.

### Gaps
- Final ranking would change if any vendor's time-to-first-report on sub-5-minute tokens turns out to be under about 10 seconds; nothing found supports or rules that out.
