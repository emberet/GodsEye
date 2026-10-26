# Copy-trade edge, alpha decay and adversaries on Solana memecoins (as of 2026-10-27)

Source-quality legend used below: **[P]** = peer-reviewed / arXiv preprint with data; **[D]** = Dune/on-chain analysis by a named analyst or firm; **[V]** = vendor / affiliate / blog (weak); **[N]** = secondary news (figures not independently re-checked). Items I could only see through a search-engine summary (page fetch blocked) are marked "(snippet only)".

Headline: I found **no independent, peer-reviewed measurement of out-of-sample profitability for publicly tracked Solana memecoin wallets or for commercial copy-bots (Trojan, Maestro, BonkBot, GMGN, Axiom, Photon, Cielo)**. The best direct evidence is one arXiv/WWW'26 paper (copier return 3% vs leader 14%, with zero modeled delay) and one unattributed 2-week experiment reported by TokenPost (a 2-minute-delay copy lost about 41% per token). Everything else is base rates, adversary mechanics and analogies.

---

## 1. Is copying tracked memecoin wallets profitable? Base rates for memecoin / pump.fun traders

### Takeaway
Base rates are poor: across Apr 2024 - Dec 2025 most active pump.fun wallets lost money in a given month (profitable share 30-51%), and winners are overwhelmingly tiny (about 90% of wallets are within +/-$500 per month). The profitable-wallet share jumped to 70-73% in Mar-Apr 2026, but that is realized-only, netted across tokens, bot-inclusive and mostly sub-$500, so it is weak evidence of a durable edge for a follower. No rigorous study exists of copy-bot user outcomes.

### Cited Findings
- Monthly share of profitable wallets on Pump.fun + PumpSwap (realized PnL, Dune `amount_usd`): Apr 2024 47.6%; Oct 2024 41.95%; Dec 2024 38.3%; Mar 2025 34.1%; Jun 2025 30.1% (low, 5.22M wallets); Sep 2025 39.1%; Dec 2025 44.0%; Jan 2026 50.1%; Feb 2026 56.8%; Mar 2026 70.0%; Apr 2026 73.3% (3.14M wallets). — [CoinGecko Research (last updated 7 May 2026)](https://www.coingecko.com/research/publications/pump-fun-traders-are-making-a-comeback) [D]
- Apr 2026 PnL tiers by wallet count: profit >$1K 5.37%; $500-1K 2.77%; $1-500 65.14%; loss $1-500 25.23%; loss $500-1K 0.71%; loss >$1K 0.78%. So about 90.4% of wallets sit within +/-$500. — [CoinGecko Research](https://www.coingecko.com/research/publications/pump-fun-traders-are-making-a-comeback) [D]
- CoinGecko's method caveats: realized PnL only (unsold bags excluded, so losses understated); buys/sells netted per wallet across all tokens; USD values derived and may be distorted for illiquid memecoins; bots and wash trading NOT filtered; author cannot conclusively explain the early-2026 shift and hypothesises unprofitable traders exiting (active wallets fell from 5.2M in May 2025 to 1.8M in Dec 2025). — [CoinGecko Research](https://www.coingecko.com/research/publications/pump-fun-traders-are-making-a-comeback) [D]
- Jan 2025 Dune dashboard (analyst Adam Tehc, via press): about 55,000 of about 13.5M wallets (about 0.4%) realized >$10K; 0.048% >$100K; 0.00217% (293 wallets) >$1M. Pump.fun's co-founder disputed it (post-Raydium buys and unrealized gains excluded; about 30% of wallets only ever placed a single sell order, suggesting non-human wallets). — [Decrypt via search snippet, page blocked](https://decrypt.co/300403/pump-fun-traders-millionaires); also [Brave New Coin](https://bravenewcoin.com/insights/over-99-of-pump-fun-traders-miss-the-10k-mark) (snippet only) [D/N]
- Sept 2025 Dune data on PUMP-token-era wallets (via Bubblemaps/press): nearly 10,000 traders cleared >$1,000 for about $332M total; just under 400 wallets earned >$100K producing $264M; 28 wallets >$1M. This implies about 80% of that profit pool sits in under 400 wallets. The 80% figure is my arithmetic on press-reported numbers. — [Decrypt/Cryptometer via search snippet](https://www.cryptometer.io/news/pump-fun-data-shows-most-traders-havent-locked-major-gains/) [D/N, unverified]
- 90-day Solana-wide window (FOMO app dashboard, relayed via a YouTube host): of 300,000+ active traders only about 19,000 (about 6%) profitable; median trader lost $120; nearly 90% of profitable accounts made <$100. Window/definition not stated; DailyCoin did not verify. — [DailyCoin, 3 Sep 2026](https://dailycoin.com/only-25-wallets-cleared-10k-as-solana-meme-coins-surge/) [N, low confidence]. Conflicts in level with CoinGecko's monthly 30-73% profitable share (different universe, window, netting).
- A cross-chain study found only 10.21% of 20,327 meme coins with 3-month price data gained >100%, and Solana had the lowest "success rate" among high-return tokens (0.79%); 50.43% of Solana tokens with price changes lost value. — [Mongardini et al., arXiv 2507.01963 (USENIX Security '26)](https://arxiv.org/html/2507.01963v1) [P]
- TRUMP token (Nansen data, via MEXC news): by end June 2026 988,905 retail buyers lost a cumulative $3.81B while a narrow group of early traders captured about $4B. — [MEXC News syndication (Yahoo/CCN piece cites same)](https://finance.yahoo.com/markets/crypto/articles/memecoins-making-comeback-2026-crypto-120215128.html) [N, secondhand, I did not open Nansen original]
- Direct copy-bot user outcomes (Trojan/Maestro/BonkBot/GMGN/Axiom/Photon/Cielo): searches returned only volume/user counts and security incidents (BonkBot 2024 breach about $208K; Maestro router exploit, over 280 ETH lost), no PnL study. — [CoinGecko Learn: top Telegram bots](https://coingecko.com/learn/top-telegram-trading-bots) (snippet only) [V/N]
- Vendor "how to copy trade" guides are affiliate-disclosed and make unverifiable claims (e.g. 0.5 SOL to 52 SOL overnight); one admits some "smart money" wallets are bots, wash traders or lucky gamblers. — [MadeOnSol guide](https://madeonsol.com/blog/how-to-copy-trade-on-solana) (snippet only) [V]

### Inferences
- A copier is not drawing from the "73% profitable" population: that statistic is dominated by sub-$500 small-lot wallets and by netted realized flows. The relevant base rate for a systematic follower is the pre-2026 30-45% profitable share with a long, thin right tail, then reduced by friction (Section 2).
- The sharp rise in profitable share while active wallets fell by about 65% from the May 2025 peak is consistent with survivorship (losers left), not with improved strategy quality. This is an inference, and CoinGecko itself only hypothesises it.
- Profit concentration is extreme (hundreds of wallets hold most of the realized profit), so any leaderboard sorted by realized USD PnL is disproportionately populated by this tail, which is also where insiders, snipers and wash-traders sit (Sections 3-4).

### Gaps
- No Dune/academic figure for the share of total profit earned by the top 1% of pump.fun wallets (only threshold counts); would need to be computed directly from Dune.
- No independent source on copy-bot cohort PnL (Trojan/Maestro/BonkBot/GMGN/Axiom/Photon/Cielo). Bot Dune dashboards (e.g. "dex-trading-bot-wars") track volume/users, not copier PnL.
- Fire Hustle / FOMO-dashboard 6% figure has no stated methodology; treat as unverified.

---

## 2. Edge lost to entry delay, slippage, fees/tips and thin-pool price impact

### Takeaway
The only quantified copier-vs-leader gap I could verify is 14% leader vs 3% copier per coin (arXiv/WWW'26), and that models zero delay and only bonding-curve slippage, so it is an optimistic bound. A separate 2-week experiment (reported 20 Oct 2026, researcher unnamed) found a 2-minute-delayed copy of big wallet clusters lost about 41% per token across 93 tokens. No source gives a clean 1s/5s/30s decay curve for Solana memecoins.

### Cited Findings
- Smart-money wallets averaged 14% return per meme coin versus an estimated copier return of 3% per investment "under market frictions"; statistic-driven models gave negative copier returns despite accurate wallet identification. 6,000 pump.fun coins, Flipside on-chain data, chronological 70/15/15 split. — [Resisting Manipulative Bots in Meme Coin Copy Trading, arXiv 2601.08641 / WWW'26 (DOI 10.1145/3774904.3792635)](https://arxiv.org/html/2601.08641) [P]
- Friction model in that paper (Appendix A.6): copier delay modeled as zero (copier trades "immediately after" the leader); slippage is the only friction, from the constant-product bonding-curve reserve shift: buy cost ratio Y/(Y-2d) > 1; imitation penalty = R(leader) - R(copier) > 0; assumes the copier matches the leader's size exactly; ignores fees and any real latency. Main text separately notes pump.fun's 1% fee. — [arXiv 2601.08641](https://arxiv.org/html/2601.08641). I could not confirm whether the 3% figure nets the 1% fee. The search summary describing it as "realistic frictions" overstates what the appendix models.
- Two-minute-delay test, pump.fun + Stonk new tokens from late Aug 2026 (more than 1M pools, 7.7M wallets, 384M swaps, 22.8M first buys over two weeks): entering 2 minutes after large wallet clusters (450-2,000 wallets) bought lost about 41% per token over 93 tokens (median result a 95% decline); a sub-group of 16 tightly connected clusters gained about 10% per token; following clusters with positive records lost about 11% per token; a single-wallet backtest lost about 20% per trade; a "double then exit on -40%" rule lost about 19% per trade after costs; cluster entries doubled before a 40% drawdown in 50-60% of cases vs 17% for others, but this advantage did not survive delayed entry; a neural net selecting 771 picks over 8 days raised doubling share from about 10% to 26% yet lost money every day (about -11% per pick, 55% hit a stop within 24h). — [TokenPost, 20 Oct 2026](https://www.tokenpost.com/news/investing/35409) [N: researcher/org unnamed, exit rules and costs for the 2-minute test not stated, tests not comparable with each other]
- Over 50% of pump.fun tokens were sniped in the creation block (Mar 15-Apr 2025 data); among deployer-funded snipers over 55% fully exited within 1 minute, about 85% within 5 minutes, over 11% within 15 seconds; over 90% sold in 1-2 swaps. — [Pine Analytics, "Exit Liquidity Machines", 21 Apr 2025](https://pineanalytics.substack.com/p/exit-liquidity-machines) [D, older]
- Rug pulls complete fast: median lifecycle <1 hour for freeze-authority abuse, pump-and-dump and liquidity manipulation; 75th percentile generally <=5 hours. — [Chen et al., "From Hype to Collapse", arXiv 2603.24625](https://arxiv.org/abs/2603.24625) [P]
- Leader-information horizon analog (not memecoin): on Hyperliquid perps, wallets ranked by post-trade price movement keep their rank across adjacent 10-day windows (Spearman 0.52); tracking top-ranked "toxic" wallets lifts out-of-sample R^2 of 1-second returns from 10.88% to 12.31% (t=9.2); the cohort increment is 1.6x the largest of 200 matched placebo cohorts and exceeds every placebo through 10 seconds. — [Zhai, "Public Trader Identity", arXiv 2608.04373, Aug 2026](https://arxiv.org/pdf/2608.04373) [P, different venue and asset class]
- Jito/priority-fee context: Jito tips are a separate direct SOL transfer to a validator tip account (minimum 1,000 lamports); one 2026 source says tips are over 60% of priority-fee volume (70%+ in volatile markets); a small set of MEV actors dominate tip volume in PvP venues such as PumpSwap/pump.fun. A developer resource lists 0.0001-0.001 SOL for simple swap protection and 0.001-0.01 SOL for competitive arbitrage. One unverified blog says top traders paid up to 18% of gross profit in tips on launch days. — [RPCFast, "Jito Explained" (2026)](https://rpcfast.com/blog/jito-explained-bundles-tips-mev-solana) (snippet only) [V]
- Platform fee rates for Axiom/GMGN/Photon/Trojan/Maestro: not obtainable from these searches.
- Measurement method for copy lag (vendor docs, no data): signal_delay = signal_received - source_trade; execution = my_fill - signal_received; total_lag = my_fill - source_trade; price_difference = my_fill_price - source_price; report median, p90 and failed/unmatched separately. Illustrative claim that a lag consuming a third of the leader's median hold time can flip a +40% exit to +10% is explicitly an example, not a measurement. — [MadeOnSol, "Measuring copy-trade lag" (updated 17 Oct 2026)](https://madeonsol.com/blog/measuring-copy-trade-lag-kol-timing-api) [V]
- Sandwich/MEV: validator DeezNode reportedly extracted over $13M in one month (Dec 2024; 1.55M sandwich txs; source is a DarkLake founder's post relayed by Finbold); a sandwich bot "arsc" reportedly earned about $30M over a couple of months; Solana Foundation threatened to expel validators joining private-mempool sandwiching (2024); Telegram-bot users with high slippage tolerance are most exposed. — [Finbold](https://finbold.com/this-solana-validator-extracted-over-13m-from-users-in-one-month-using-sandwich-attacks/), [Blockworks Lightspeed](https://blockworks.com/news/lightspeed-newsletter-solana-sandwich-attacks) (snippets) [N, 2024-25, older; I found no 2026 sandwich data]

### Inferences
- Because the arXiv appendix assumes zero delay, the gap between 14% and 3% is the floor on decay, not the typical case; real delay adds on top. Taking it together with the TokenPost result, once the follower lags past the first seconds the sign flips for new-launch tokens.
- Edge loss is likely front-loaded within seconds for launch-block/early-cluster entries, since snipers exit within 1-5 minutes (Pine) and rugs finish within about 1 hour (Chen). A 0.1 SOL copier on a thin pool pays little price impact itself, but fees and tips are a fixed-cost drag that is proportionally larger on small tickets. This latter point is reasoning, not a sourced number.
- Hyperliquid evidence suggests that "who" is persistent but the exploitable signal lives at the 1-10s horizon; analogy only.

### Gaps
- No measured 1s / 5s / 30s decay curve for Solana memecoin leader entries; would need own forward test using Yellowstone/Geyser timestamps.
- Slippage/impact tables for thin pools at 0.1-1 SOL size, not found.
- Whether the 3% copier return includes the 1% pump.fun fee: unresolved.
- TokenPost experiment: author/organisation, exit rules and full cost model not disclosed; original publication not located.

---

## 3. Alpha decay: do wallets get "burned" when tracked or listed? Front-running of followers; leaders dumping on followers

### Takeaway
There is mechanism-level evidence that visible wallets get front-run and that the platforms themselves can leak or exploit wallet data, but I found no study that measures a before/after drop in a wallet's performance once it was publicly listed (Kolscan, GMGN, etc.). Treat decay as plausible and likely, but unquantified.

### Cited Findings
- The WWW'26 paper states copy trading on memecoins has an exploitable attack surface: adversaries deploy manipulative bots to front-run trades, conceal positions and fabricate sentiment. Snipers buy in the first 1-5 blocks (about 0.4-2 s; Solana block about 400 ms; K=5 detection window); bundle bots (creator-linked wallets buying in the launch block) appear in roughly one quarter of projects; bump bots (repeated flips) and comment bots fake attention. — [arXiv 2601.08641](https://arxiv.org/html/2601.08641) [P]
- That paper's ablations: removing its wallet agent cut AUC 11.3% and copier gross return 9.4%; coin agent -9.8% / -8.5%; timing agent -3.5% / -1.6%. XGBoost had the highest AUC; the multi-agent LLM system was close behind. — [arXiv 2601.08641, Table 2](https://arxiv.org/html/2601.08641) [P]
- Axiom insider allegation (late Feb 2026): ZachXBT alleged a senior Axiom business-development employee used internal dashboards that linked users' wallets and histories to track KOL wallets, compiled a spreadsheet of target KOL wallets and front-ran memecoin shills; Axiom said it removed access to the support tools and was investigating. Allegations, not adjudicated. — [Yahoo Finance report on ZachXBT investigation](https://finance.yahoo.com/news/zachxbt-investigation-accuses-axiom-employee-141228617.html); [DeFiRate](https://defirate.com/?p=6200) [N]
- Kolscan: tracker of KOL/smart-money wallets with token-level PnL and win rate; acquired by Pump.fun in July 2025 and free since; promoted for spotting KOLs who promote while selling. Kolscan's own token drew early buyers who made over $3M around the acquisition news. A Change.org petition argues the leaderboard incentivises KOLs to attract copy-traders (advocacy, one-sided). — [UwUU Kolscan review](https://uwuu.ai/blog/kolscan-review); [DL News](https://www.dlnews.com/articles/defi/memecoin-kols-bag-millions-as-pump-fun-buys-kolscan-tracker/); [Change.org](https://www.change.org/p/ban-kolscan-io) (snippets) [V/N]
- SHAR (Sharpei) case: reached over $50M market cap, fell about 95%; ZachXBT flagged insider wallets selling about $3M at once; a leaked deck allegedly claimed "50+ tier-1 KOLs" onboarded (some named KOLs denied involvement). — [Decrypt (snippet)](https://decrypt.co/288160?amp=1) [N]
- Bloomberg (via CryptoSlate, Mar 2025): cabals launch and trade memecoins; KOLs reportedly receive large allocations or deep discounts to promote; insiders capture the most lucrative trades; TRUMP and MELANIA fell about 85% and about 95% from peaks. — [CryptoSlate](https://cryptoslate.com/solana-has-become-a-breeding-ground-for-pump-and-dump-memecoin-cabals-bloomberg/) [N]
- A vendor guide notes a survivorship quirk in KOL win rates: wallets that buy and never sell show a 100% win rate on closed trades until they dump, so analysis must count only closed positions. — [MadeOnSol KOL guide](https://madeonsol.com/blog/how-to-track-kol-wallets-solana-api) (snippet) [V]
- Another rule-of-thumb source claims a wallet-list's "top 200 wallets sustained 81.5% win rate out-of-sample" with no methodology: do not rely. — [Medium, "Memecoin Trading Encyclopedia"](https://medium.com/@rakesh.therani/the-memecoin-trading-encyclopedia-35-concepts-backed-byproduction-data-6745ab79d1c9) (fetch blocked; snippet only) [V, unverified]
- Persistence analog outside memecoins: Hyperliquid wallets retain ranking across adjacent 10-day windows (rho=0.52, persistence concentrated in the top decile); a prediction-market study reports 44% of accounts classified skilled in training remain so on held-out events (vs about 10% persistence cited for skilled mutual-fund managers). — [Zhai, arXiv 2608.04373](https://arxiv.org/pdf/2608.04373); [arXiv 2605.02287 (snippet only)](https://arxiv.org/pdf/2605.02287) [P, not memecoins]

### Inferences
- Persistence of "informedness" in perps/prediction markets suggests some wallets keep an edge, but memecoin wallet edge is often structural (being early, deployer-funded, bundled), which is not copyable and is not "skill" that persists to a follower.
- The platform-level leak risk (Axiom allegation) means wallets are exposed even without being on a public board; any single tracking provider is a potential alpha-decay vector.
- Whether public listing causes decay is untested; a direct test is feasible by comparing a wallet's pre-/post-listing markouts at fixed delays.

### Gaps
- No event-study of wallet performance before vs after Kolscan/GMGN/Cielo listing.
- No dataset matching KOL tweet timestamps to wallet sells; only case reports (SHAR, etc.).
- Axiom claims are allegations; final outcome not verified.

---

## 4. Adversarial manipulation: fake PnL, wash trading, insiders/fresh wallets, bundles, honeypots, freeze authority, rugs

### Takeaway
Manipulation is the norm among launches (most pump.fun launches are high-risk by one academic labelling; Solidus claims about 99% pump-and-dump/rug). Leaderboards ranked by realized PnL can be gamed by wash trading and by deployer-funded sniping, and no tracker I found filters those by default. Freeze-authority abuse is one of three documented Solana rug mechanisms.

### Cited Findings
- MemeTrans: 41,470 pump.fun tokens that migrated to Raydium (1 Dec 2024-1 Mar 2025, about 218.5M txs). 84.13% labelled high-risk (min price within 20 min post-migration <0.3x migration price, or manipulation score >=0.7), 11.34% medium, 4.53% low. Pre-migration txs: 73.5% swaps, 21.4% wash trades, 4.9% transfers. 98.7% of mint txs are "create & buy". Bundled accounts: 28.13% of holders, 36.50% of supply (fund-flow linkage 28.22%, in-transaction multi-account buys 9.16%, Jito bundles 15.96%). Risk-ranking top 100 cut loss from 60.71% to 26.64% and lifted precision 0.254 to 0.800. — [MemeTrans, arXiv 2602.13480](https://arxiv.org/html/2602.13480v1) [P; high-risk label is the authors' price/detector definition]
- Solana rug pulls: 100,063 tokens newly issued on Orca/Raydium/Meteora in H1 2025 analysed; 76,469 (about 76%) flagged as rug pulls by the authors' pipeline (0.26% estimated false-positive on 382 audited labels); three patterns: freeze-authority abuse, liquidity withdrawal, pump-and-dump; at least $151M direct quantifiable losses across 7,322 profiting addresses; 78 large syndicates (Star and Cluster topologies); rug median lifecycle in the benchmark 0.01 days. — [Chen et al., arXiv 2603.24625](https://arxiv.org/abs/2603.24625) [P]
- Solidus Labs (via press): about 98.6-99% of pump.fun launches are pump-and-dump/rug; 93% of Raydium pools show such signs; median Raydium rug about $2,800. Report date, sample and definitions not stated by the articles I could open. — [The Defiant](https://thedefiant.io/news/defi/alarming-99-of-memecoin-launches-on-pumpfun-are-pump-and-dumps-or-rug-pulls-report); [Forklog](https://forklog.com/en/report-98-of-pump-funs-memecoins-deemed-scams/) [N; methodology unknown]
- Cross-chain manipulation study (34,988 coins): 82.6% (584/707) of >100% gainers show at least one suspicious activity; wash trading confirmed in 1,014 events on 282 tokens (181 Solana tokens, the most); a new "liquidity-pool price inflation" (LPI) attack with median buy volume $54 produced >500% gains in half of events; 91 pump-and-dump operations on 60 tokens (54 on Solana), median pump 143.95% then dump 55.82%; 61.67% of P&D tokens had earlier artificial growth; 50.59% of wash operations were by a single actor; 55 persistent manipulators across 14 tokens. The paper reports no dollar loss figure for victims and does not study followers. — [arXiv 2507.01963](https://arxiv.org/html/2507.01963v1) [P] (a search-engine summary claiming "$9.3M losses to 17,000 addresses" came from the abstract/other version; I could not confirm it in the body, so treat as unverified)
- Wash-trading on Solana, April 2026 case study (5 tokens): OpenLie token had $532K DEX volume from 233 wallets in 12 h (40,523 trades, avg $13.14, 96% of wallets both bought and sold, top-10 round-trip ratio 0.95-1.00), 30/30 flagged wallets traced to one funder seeding 200+ bots with 0.5 SOL in under a minute; 3 of 5 tokens single-funder, 2 diffuse (likely a volume-bot service). Published by a vendor (Bitquery) with public repo. — [Bitquery, April 2026](https://bitquery.io/blog/solana-volume-numbers-are-a-lie) [V with reproducible method]
- Deployer-funded sniping (Pine Analytics, Mar-Apr 2025): over 15,000 SOL realized net profit in a month, over 15,000 launches (about 1.75% of launches), 4,600+ sniper wallets, 10,400+ deployers, 87% of snipes profitable, typical 1-100 SOL per wallet (outliers >500 SOL); burner wallets, multi-hop (5-7 hops) funding, split buys over 2-4 wallets; the author's own implication is that profit/win-rate leaderboards can reward extraction rather than skill, and one-hop funding filters undercount. Direct-funding filter only; a subset. — [Pine Analytics](https://pineanalytics.substack.com/p/exit-liquidity-machines) [D, older, 2025]
- Insider-style single events: ZREAL (Jan 2026) wallet turned about $285 into about $627K (Lookonchain flagged; insider status alleged, not confirmed). — reported in a search-result summary of [Yahoo Finance/CCN "Are Memecoins Making a Comeback in 2026?"](https://finance.yahoo.com/markets/crypto/articles/memecoins-making-comeback-2026-crypto-120215128.html) and MEXC syndication; I did not open the original Lookonchain post [N, unverified]
- Bubblemaps: defines bundles as multiple wallets buying in the same block or first few blocks; suggests >15% bundled supply as serious concern; Sept 2026 revamp adds a memecoin feed that filters tokens with insider clusters/bundles. Older cases: BRETT (over 80% of supply bought by 100+ OKX-funded wallets), Cardi B token (insiders >50%). — [Bubblemaps blog](https://blog.bubblemaps.io/how-to-analyze-meme-coin-holders-with-bubblemaps/); [Benzinga/Defiant press release](https://www.benzinga.com/content/61806673/bubblemaps-sets-new-industry-standard-catching-rug-pulls-they-happen) (snippets) [V/N]
- Token-level traps: freeze authority (holder can freeze your token account; buys still work so chart looks alive), mint authority (supply inflation), Token-2022 extensions (transfer fees, permanent delegate, transfer hook, non-transferable/default-frozen) are the honeypot-class flags; scanners read the mint account directly. Scoring weights (e.g. transfer hook 50/100) are vendor heuristics; no independent false-positive data found. — [InsightX docs](https://docs.insightx.network/reference/scanner-solana-indicators); [DexTools tutorial](https://www.dextools.io/tutorials/freeze-authority-and-update-authority-scams); [DEV Community](https://dev.to/mrvlyouknowwho/freeze-authority-is-the-solana-honeypot-how-to-check-any-spl-token-in-10-seconds-free-no-wallet-15h4) (snippets) [V]
- Fake "top trader" profiles/fabricated signals exist on off-chain copy-trading platforms (SEC suit over $12.5M); I found no documented on-chain case of a decoy "alpha wallet" purpose-built to bait Solana trackers. — [InvestmentNews](https://www.investmentnews.com/regulation-legal-compliance/fake-signals-frozen-accounts-sec-sues-crypto-ai-platform-over-125m/268436) [N]
- Tracker PnL pipelines can be naive: third-party "smart money" actors compute realized/unrealized PnL with FIFO matching, which would count wash round-trips as profit; one guide notes no documented transfer/airdrop filtering in some PnL calcs. Also GMGN ranks by profit/win rate/ROI/frequency; I found no GMGN methodology doc stating wash-trade filtering. The latter is a gap, not evidence they do or do not filter. — [Apify smart-money actor](https://apify.com/gochujang/smart-money-tracker) (snippet) [V]

### Inferences
- A copier selecting "top earners by recent realized USD PnL" is exposed to three concrete failure modes: (a) leaders whose PnL is deployer-funded snipes or insider allocations (unreplicable edge); (b) wash-inflated or self-trade PnL on thin pools; (c) buying tokens whose exit is blocked (freeze/transfer-hook) or whose liquidity is pulled within an hour.
- Because rugs complete within hours (Chen) and 84% of migrated tokens are high-risk (MemeTrans), per-trade exit logic and token-structure checks matter more than leader selection alone.
- Not found: any quantification of how often copy-traders specifically get caught in rugs vs all traders.

### Gaps
- Fraction of copy-traders' trades that end in rugs/honeypots: no data.
- Exact Solidus Labs report date/method: not found.
- No independent confirmation of the $9.3M / 17,000 victim figures attributed to arXiv 2507.01963.
- No documented decoy-alpha-wallet attack on Solana trackers (absence in my searches, not proof of absence).

---

## 5. Defenses used by good copy systems (follower side and leader side)

### Takeaway
Published, evidence-backed defenses are thin. The strongest quantitative support is for token-risk classification using holder concentration, bundle statistics and market activity (MemeTrans cut loss from 60.7% to 26.6% on top-100 risk-ranked picks) and for wallet-history + coin-context models (WWW'26 ablations). Most other defenses (sizing, kill-switch, consensus) appear only as vendor best practice.

### Cited Findings
- Token-risk model: 122 features across contextual, holding-concentration, market-activity, bundle and time-series groups; market-activity features (sale duration, tx/buyer/holder counts) most important (removing them cost the most AUPRC, 0.5729 to 0.5369); bundle-aware holder concentration raises median top-10 share by 24% (high-risk) vs 6% (low-risk); best MLP AUPRC 0.5729 (hybrid 0.5827). Excluding launches <1 min or <100 holders removed launches that were 94.9% high-risk. — [MemeTrans, arXiv 2602.13480](https://arxiv.org/html/2602.13480v1) [P]
- Copier-side filters in the WWW'26 design: conditioning on wallet history (average return over previous coins, trade count, return std, t-stat, time since first/last trade), entry context (time since launch, purchase price/size), and bot flags (bundle/sniper/bump/comment) at the trader's first trade; combining wallet, coin and timing agents. Wallet and coin signals contribute most (Section 3 ablation). Authors' stated lesson: statistic-only models can identify skilled wallets yet still yield negative copier returns. — [arXiv 2601.08641](https://arxiv.org/html/2601.08641) [P]
- Bubblemaps and scanners give practical thresholds: bundled supply >15% = serious concern; check freeze/mint authority and Token-2022 extensions on the mint account. — [Bubblemaps](https://blog.bubblemaps.io/how-to-analyze-meme-coin-holders-with-bubblemaps/); [InsightX](https://docs.insightx.network/reference/scanner-solana-indicators) [V]
- Leader-side suggestions from the vendor literature: favour wallets with longer median hold times because infrastructure lag consumes a larger share of short holds; count only closed positions for win rate; report lag p50/p90 and unmatched copies separately. — [MadeOnSol](https://madeonsol.com/blog/measuring-copy-trade-lag-kol-timing-api); [MadeOnSol KOL guide](https://madeonsol.com/blog/how-to-track-kol-wallets-solana-api) [V]
- Pine Analytics recommends behaviour-based adaptive trust scores over static tags, penalising low-effort high-frequency extraction, and tiered risk flags for repeat same-block deployer-linked sniping. — [Pine Analytics](https://pineanalytics.substack.com/p/exit-liquidity-machines) [D]
- Consensus/cluster signal: in the TokenPost experiment, tightly connected clusters were the only sub-group with positive per-token result (about +10% over just 16 tokens, delay entry), implying small sample and fragility. — [TokenPost](https://www.tokenpost.com/news/investing/35409) [N]
- Slippage guardrail evidence: high slippage tolerance on Telegram bots is the main sandwich exposure. — [Blockworks Lightspeed (snippet)](https://blockworks.com/news/lightspeed-newsletter-solana-sandwich-attacks) [N, older]

### Inferences
- Reasoned (not sourced) defense stack consistent with the evidence above: hard token-structure gate (freeze/mint authority, Token-2022 extensions, bundled-supply %, top-10 concentration), skip tokens younger than the sniper window, require leader hold-time distribution to exceed the follower's end-to-end lag by a wide margin, reject leaders whose profit is concentrated in a few same-block/deployer-linked snipes, cap price drift vs leader's fill, size by fixed tiny lots and kill-switch on rolling realized drawdown.
- A learning loop that tunes a win-rate bar from 1h/6h/24h post-signal outcomes will measure token drift, not copier execution quality, and the evidence above says the first minutes dominate; adding a seconds/minutes horizon and the realized fill vs leader fill would capture the decay. (Applicability comment only; GodsEye internals not researched, per instructions.)

### Gaps
- No published out-of-sample evaluation of any complete follower-side defense stack on live Solana memecoin copy-trading.
- No published evidence for specific drawdown-kill-switch thresholds or consensus counts.

---

## 6. Measuring true copyability of a leader (simulation design and metrics)

### Takeaway
No standard published methodology exists for Solana memecoins beyond (a) the WWW'26 copier-vs-leader return gap with a bonding-curve slippage model and (b) vendor lag-decomposition formulas. A defensible approach is to replay each leader trade at a swept delay with a pool-state-based fill model and compare to the leader's own fill.

### Cited Findings
- Imitation penalty definition: epsilon = R(leader) - R(copier) under constant-product slippage with copier trade immediately after the leader and equal size. — [arXiv 2601.08641, App. A.6](https://arxiv.org/html/2601.08641) [P]
- Lag decomposition and matching rules (match by signature when possible, else by wallet+mint+side+narrow window; flag ambiguous matches; label timestamp type as tx time vs service receipt vs local clock; pair first buy with first later sell per mint; partial exits/multi-round trips/pre-window positions not captured). — [MadeOnSol](https://madeonsol.com/blog/measuring-copy-trade-lag-kol-timing-api) [V]
- Skill-vs-luck test design: randomise trade direction holding everything else fixed, and use matched-placebo cohorts (200 activity-matched cohorts) to show a ranking is not just activity/size. — [arXiv 2605.02287 (snippet)](https://arxiv.org/pdf/2605.02287); [Zhai, arXiv 2608.04373](https://arxiv.org/pdf/2608.04373) [P, non-memecoin]
- Time-ordered evaluation: score wallets in one window, freeze the ranking, evaluate in the next (adjacent 10-day windows; chronological 70/15/15 splits by each trader's first transaction per coin). — [Zhai](https://arxiv.org/pdf/2608.04373); [arXiv 2601.08641](https://arxiv.org/html/2601.08641) [P]
- Benchmarking datasets: MemeTrans (41,470 tokens, 218.5M txs) and Chen et al. (117-token confirmed rug benchmark; labels released) can be used to validate token filters. — [arXiv 2602.13480](https://arxiv.org/html/2602.13480v1); [arXiv 2603.24625](https://arxiv.org/abs/2603.24625) [P]

### Inferences
Proposed metric set (my design, derived from the sources above; not validated):
- Replay each leader buy at delay d in {1s, 2s, 5s, 15s, 30s, 60s, 120s} using pool state at t0+d (reserves or Jupiter quote snapshot); fill = quote(size) + fee + priority/Jito tip; exit the follower on the leader's sell replayed with the same delay, plus the follower's own stop rules.
- Per-leader outputs: copier minus leader return (imitation penalty) per delay; median/p90 entry price drift vs leader fill; share of trades where price at t0+d is already above the leader fill by more than X%; hit rate and expectancy after costs; fraction of PnL from top-1 and top-3 trades; time-to-first-sell distribution vs follower lag; share of leader trades in the creation block / first N blocks / deployer-linked; share of trades in tokens later freezing, rugging or with >15% bundled supply; markouts at 1/6/24h *and* at 10s/60s/5m.
- Out-of-sample: freeze the leader score on window A, evaluate copy-sim on window B; compare to placebo cohorts matched on activity.
- Use bootstrap confidence intervals and a minimum count of distinct tokens (not trades); apply a multiple-testing penalty when picking top-N from many leaders.

### Gaps
- No published reference implementation or benchmark for Solana-memecoin copy-simulation.
- Pool-state history at 400 ms resolution requires own Geyser/archive data; not discussed in any source found.

---

## 7. Base-rate summary table (for the report writer)

### Takeaway
Numbers cluster as: 30-50% of active pump.fun wallets profitable monthly pre-2026 (73% in Apr 2026, mostly <$500); about 75-84% of launches classified rug/high-risk by academic pipelines (99% by Solidus, unverified); leaders' per-coin return 14% vs copier 3% (zero delay); 2-minute delayed cluster-following -41% per token (unattributed experiment).

### Cited Findings
- Profitable-wallet share, Apr 2024-Apr 2026: 30.1% (Jun 2025) to 73.3% (Apr 2026). — [CoinGecko Research](https://www.coingecko.com/research/publications/pump-fun-traders-are-making-a-comeback) [D]
- High-risk launch share: 84.13% of migrated pump.fun tokens (MemeTrans); 76% of new pools on Orca/Raydium/Meteora H1 2025 flagged rug (Chen et al.); about 98.6-99% (Solidus, no methodology). — [arXiv 2602.13480](https://arxiv.org/html/2602.13480v1); [arXiv 2603.24625](https://arxiv.org/abs/2603.24625); [The Defiant](https://thedefiant.io/news/defi/alarming-99-of-memecoin-launches-on-pumpfun-are-pump-and-dumps-or-rug-pulls-report)
- Leader 14% vs copier 3% per coin (zero-delay, bonding-curve slippage only). — [arXiv 2601.08641](https://arxiv.org/html/2601.08641)
- 2-min-delay cluster copy -41% per token (93 tokens). — [TokenPost](https://www.tokenpost.com/news/investing/35409)
- 87% of deployer-funded same-block snipes profitable. — [Pine Analytics](https://pineanalytics.substack.com/p/exit-liquidity-machines)

### Inferences
- Definitions of "rug/high-risk" differ (price-drop threshold vs behaviour pipeline vs undisclosed), so the 76-99% range is a definitional spread, not a confidence interval. Datasets also overlap in time poorly (Dec 2024-Mar 2025 vs H1 2025 vs undated), and none cover mid-2026 after the profitability shift.

### Gaps
- Newest (H2 2026) rug/high-risk rates and wallet-profit concentration are not available from the sources I found; CoinGecko ends Apr 2026.
- Out-of-sample persistence for memecoin leaders specifically: no study found.
