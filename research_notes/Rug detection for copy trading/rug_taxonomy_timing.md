# Solana memecoin rug and token-scam taxonomy: mechanism, signature, prevalence, timing, exit

Research date: 2026-10-27. Scope: Solana only. Tags: [P] = academic paper or preprint (not necessarily peer reviewed), [V] = vendor or marketing, [D] = independent analyst or on-chain forensics, [N] = news or secondary report, [O] = official protocol docs or repo, [U] = could not verify / snippet only. Dates are publication dates where known.
This file adds to, and in places corrects, `/Users/srinjoydas/GodsEye/research_notes/Memecoin wallet tracking methods/copy_edge_and_adversaries.md` section 4. Items already in that file (MemeTrans headline numbers, Chen 76%/100,063, SolRPDS, Pine deployer-funded sniping, Bubblemaps >15% bundle rule) are not re-derived.

---

## Q1. Which rug/scam types exist on pump.fun, PumpSwap, Raydium and Meteora launches in 2025-2026, and what are mechanism, on-chain signature, prevalence, time-to-rug and exit-ability for each?

### Takeaway
On Solana the dominant measured mechanism is behavioural, not contract-level: of 76,469 flagged tokens in Chen et al., 79% are "pump-and-dump" (holder/pool-balance cliff, no LP pull, no freeze), 20% are LP withdrawal and only 0.6% are freeze-authority abuse. On pump.fun itself the structure removes two classic rugs (no creator-held LP after migration, so no LP pull; no creator LP at all on the curve), which leaves insider/bundle/sniper/creator dumps as the live risk for an early-minutes copier; the classic LP pull and freeze/Token-2022 traps apply mainly to Raydium/Meteora/Orca launches and non-pump.fun mints.

### Cited Findings

#### Structural facts about pump.fun and PumpSwap that gate which rugs are possible [O unless noted]
- Pump program (official docs): `migrate` is permissionless once the curve is complete; liquidity moves to a PumpSwap pool "and the LP tokens received are burnt". A migrated canonical pool therefore has no creator LP to pull. — [pump-public-docs, PUMP_PROGRAM_README](https://raw.githubusercontent.com/pump-fun/pump-public-docs/main/docs/PUMP_PROGRAM_README.md)
- The same README does not state mint authority, freeze authority or token program for created coins (I could not verify authority status from official docs). — same source [U]
- Curve fee 100 bps per buy/sell in that README (docs may lag current fee schedule; Dynamic Fees V1 changed creator fees Sept 2025). — same source; [The Block, 2026-01-09](https://www.theblock.co/amp/post/384975/pump-fun-overhauls-creator-fees-token-launches-highest-daily-september)
- PumpSwap README: LP fee 20 bps, protocol fee 5 bps on buys/sells, creator fee accrues to the pool's `coin_creator`; admin can change fee config/recipients/admin key and can disable operations globally (flags "currently unused"); a "CTO team" can change a pool's `creator_fee_bps`. `create_pool` gives the creator LP tokens in general; the README does not itself say they are burned at migration (the Pump program README does). — [PumpSwap README](https://raw.githubusercontent.com/pump-fun/pump-public-docs/main/docs/PUMP_SWAP_README.md)
- "Synthetic migration" doc: the buy that empties the curve can exceed remaining supply; "no curve buys or sells are possible until migration happens" after that buy. So there is a short window between curve completion and `migrate` in which nobody can sell. — [pump-public-docs index](https://github.com/pump-fun/pump-public-docs)
- Token program split: legacy `create` mints use SPL Token; `create_v2` mints use Token-2022 and are tied to Mayhem Mode (Nov 2025). Which Token-2022 extensions pump.fun enables on those mints is not stated in anything I could open. — [Chainstack bot update (undated; image path Nov 2025)](https://chainstack.com/trading-bot-update-full-mayhem-mode-support-for-pump-fun/amp/) [V]; [community SDK skill page](https://smithery.ai/skills/sendaifun/pumpfun) [U]
- Extra per-launch conditions: Mayhem Mode (opt-in) mints 1B extra tokens (supply 2B), an AI agent trades for 24 h and unused agent tokens are burned; launches ~17.3k/day before vs ~17.8k/day after. — [The Block, 2025-11-18](https://www.theblock.co/post/379285/pump-funs-new-mayhem-mode-fails-boost-token-launches-revenue)
- Graduation (curve completion) rate: ~1.4% historical (Dune) and "fewer than 2%" (The Block tracker) as of 2026-06-10; Q4 2024 study found <2%. — [Solana Compass, 2026-06-10](https://solanacompass.com/news/pumpfun-launched-42000-tokens-in-one-day-fewer-than-2-will-ever-reach-a-dex); [Mancino arXiv 2512.11850 via search result](https://arxiv.org/html/2512.11850v2) [P, snippet]
- BOOST (default launch mechanism, article dated 2026-07-29): ~20% of migration liquidity that used to be locked permanently in the PumpSwap pool ("dead liquidity") now funds automatic market buys during the first 5 minutes after migration, with every token bought burned. Graduation rate hit 6.7% on 2026-07-24 (about 8x June average; prior four days averaged 4.7% vs 2.5% the week before). — [The Block, 2026-07-29](https://theblock.co/post/409815/pump-fun-token-graduation-rate-jumps-boost-changes-launch-incentives)

#### Per-type taxonomy

**1. Liquidity pull / LP removal (Raydium V4, Orca, Meteora; NOT canonical PumpSwap pools)**
- Mechanism: deployer pairs token with SOL, holds the LP tokens, waits for buys, removes liquidity. Solidus's 4-step description: deployer supplies all pool liquidity, waits for trades, removes liquidity once pool SOL has risen. — [Solidus Labs report, May 2025](https://www.soliduslabs.com/reports/solana-rug-pulls-pump-dumps-crypto-compliance) [V]
- Chen definition: a creator-related address (mint authority or initial pool deployer) executes a profitable liquidity removal followed by collapse below an activity threshold. — [Chen et al. arXiv 2603.24625 v2, 2026-05-31](https://arxiv.org/html/2603.24625) [P]
- Prevalence: 15,606 of 76,469 flagged tokens (20.4%); 26 of 117 manually verified benchmark rugs (22%). Chen universe is H1 2025 Orca/Raydium/Meteora pool tokens and explicitly excludes pump.fun-only tokens that never created a pool. — same Chen source
- Solidus (Raydium V4 only): detection by LP-token burn and share of LP supply withdrawn (50% and 90% thresholds gave the same count; 90% used); 388,000 pools examined (The Defiant says 361,000; Forklog 388,000), ~93% flagged "soft rug"; median rug ~$2,832; 25% under $732; largest $1.9M. Date range for Raydium pools not given. — [Solidus](https://www.soliduslabs.com/reports/solana-rug-pulls-pump-dumps-crypto-compliance) [V]
- Timing (Chen lifecycle = creation to first confirmed fraud-related profit-taking tx; 24 h observation window): liquidity-manipulation median 0.0385 days (~55 min) and P75 0.966 days (~23 h) if Table IV is in days as labelled; the paper's text instead says median "<1 hour" and P75 "generally does not exceed 5 hours" for all three types. The table header and the prose disagree for this type (see Q2 for the unit problem). — Chen Table IV and Section V-B
- Exit-ability: once removed, the pool holds little or none of the quote asset; sells return ~0 or fail. Chen: "token price collapses or drops to zero and market trading becomes dysfunctional shortly thereafter." — Chen
- Large-cap variant (LIBRA, 2025-02-14): the deployer added one-sided Meteora pools holding only LIBRA while removing USDC and SOL; over $87M removed per Bubblemaps (other sources $100M-$107M); liquidity pools earned >$25M fees within an hour of the peak; token later lost >95% (time not stated). ~82% of supply was unlocked. Bubblemaps ties the creator wallet's funder to MELANIA sniping and to ~$6M sniping profit on LIBRA. Class action against Meteora/Kelsier/KIP was dismissed on 2026-09-29 for failure to state legally recognised claims (not a finding the conduct did or did not happen). — [Bubblemaps, 2025-03-25](https://blog.bubblemaps.io/how-hayden-davis-rugged-libra-for-100m-with-president-milei/) [D]; [Solana Compass on dismissal](https://solanacompass.com/news/judge-dismisses-libra-and-m3m3-memecoin-class-action-against-meteora-and-ben-chow) [N, snippet via search]
- Note on figures: the Solidus Raydium "93%" is a share of pools with a large LP withdrawal, not proof of intent; Solidus also states 25% of rugs were under $732. — Solidus

**2. Freeze-authority abuse (SPL Token legacy mints created outside pump.fun)**
- Mechanism: creator keeps SPL freeze authority; after a victim buys, issuer calls FreezeAccount; frozen accounts cannot transfer or swap, while insider accounts stay free to sell. — Chen
- Chen labelling requires retained authority AND at least one executed FreezeAccount against a user account (so dormant authorities don't count). — Chen
- Prevalence: 461 of 76,469 flagged tokens (0.6%); 2 of 117 benchmark (1.7%). — Chen. Scanner vendors list it as a leading flag, but the measured share is tiny; I found no independent count of tokens that merely retain the authority. — [InsightX docs](https://docs.insightx.network/reference/scanner-solana-indicators) [V]
- Timing: Table IV freeze-authority-abuse median 0.483 days (~11.6 h), P75 4.69 days if read as days; prose says median <1 h. Longest-lived of the three types in the table. — Chen
- Exit-ability: no, for the frozen account (hard rug). Chart looks alive because insiders and unfrozen buyers still trade.

**3. Mint-authority abuse**
- Mechanism: retained mint authority allows supply inflation then dumping. Chen counts a mint-authority address as a "creator-related" address for the LP-removal pattern, but reports no separate mint-abuse category or count. — Chen [only an indirect finding]
- No independent prevalence figure found for mint-authority abuse on its own. [U]

**4. Sell-restricted honeypots and Token-2022 extension tricks**
- Solana docs list the Token-2022 extensions: TransferFeeConfig, TransferHook, PermanentDelegate, Pausable (mint/burn/transfer can be paused), DefaultAccountState, NonTransferable, MintCloseAuthority, ConfidentialTransfer, etc. — [Solana docs, Token Extensions](https://www.solana.com/docs/tokens/extensions) [O]
- Chen's framing: Solana rugs are mainly executed through freeze abuse, LP withdrawal and pump-and-dump "rather than malicious token contract logic" (because the token program is shared). — [Chen](https://arxiv.org/html/2603.24625) [P]
- Permanent delegate precedent: "RED" token, Sept 2024, a Jupiter user's swap was reversed ~7 seconds after settling because the mint carried PermanentDelegate and the delegate burned the bought tokens (PeckShield explained to Cointelegraph). — [Cointelegraph via search summary](https://cointelegraph.com/news/new-solana-scam-burn-tokens-from-inside-sol-wallets) [N, snippet only]
- Transfer-hook honeypot (hook rejects outbound transfers) and 99-100% transfer-fee honeypots are described only in scanner/guide content. I found no named, loss-quantified on-chain incident for transfer hook, transfer fee or default-frozen/pausable on Solana, and no peer-reviewed measurement. — [InsightX docs](https://docs.insightx.network/reference/scanner-solana-indicators); [Sharpe guide](https://www.sharpe.ai/rug-check/risk/honeypot) [V]
- Chen does not list Token-2022 at all (zero mentions in the full text). — [Chen](https://arxiv.org/html/2603.24625) [P]

**5. Pump-and-dump / insider, creator, cluster and bundled-supply dumps ("soft rug" family)**
- Mechanism (Chen): creator renounces LP and does not freeze, presents as fair launch, then dumps pre-allocated tokens, often dispersed across many addresses. Labelling rule: within a sustained post-launch window both holder count and the pool's token balance decline monotonically, with total holder reduction above 73% (τ = 0.73, chosen to admit gradual variants). — [Chen](https://arxiv.org/html/2603.24625) [P]
- Prevalence: 60,402 of 76,469 flagged tokens (79.0%); 89 of 117 benchmark (76%). Sampled false-positive rate 0.26% (95% upper bound 1.45%); of a 100-token sample labelled non-rug, 9 were missed rugs that played out over 3-7 days, outside the 24 h window. — Chen
- Timing: P&D median 0.0221 days (~32 min), P75 0.0489 days (~70 min) if days. — Chen Table IV
- Organisation: 78 large syndicates, median 36 members (1-169), median 48.5 tokens involved; syndicate median total profit $5,052, mean $56,504, max $988,894. Total quantifiable direct losses $151.09M across 7,322 profitable addresses (conservative: only direct withdrawals counted). — Chen Tables V-VI
- Insider/bundled supply evidence from famous cases:
  - HAWK (launch 2024-12-04): 96% of supply in one cluster at launch; deployer minted 100%, 3% to a Meteora pool, 97% through 10 wallets incl. a 17% fully unlocked "strategic allocation" to 285 presale wallets, 155 of whom sold, realising ~$3.3M; market cap ~$500M down to ~$25M (about 95%); the public pool was ~3% of supply. — [Bubblemaps, Dec 2024](https://blog.bubblemaps.io/hawk-anatomy-of-a-celebrity-rug/) [D]. Decrypt reports most of the 285 wallets dumped within the first minutes (snippet only) — [Decrypt via search](https://decrypt.co/295179/hawk-tuah-girls-meme-coin-faces-allegations-of-rug-pull-project-leads-deny-wrongdoing) [N, snippet]
  - MELANIA (2025-01-19): ~82% of supply in one wallet cluster, a presale wallet with 10% dumped most of it on day one. — [Bubblemaps, 2025-03-25](https://blog.bubblemaps.io/how-hayden-davis-rugged-libra-for-100m-with-president-milei/) [D]
  - YZY (Aug 2025): per Bubblemaps data 51,862 of 70,201 traders (73.8%) lost money, total loss $74.8M; 18,333 profited $66.6M, 86% of those under $1,000; 11 wallets took nearly 30% of profits; token fell "nearly 70%" within hours per The Block (other outlets: +1,400% in hour one then >80% down; Nansen: top 13 wallets $24.5M; Coinbase's Grogan: ~94% of supply with insiders; link to Hayden Davis unconfirmed). — [The Block, 2025-08-28](https://www.theblock.co/post/368557/kanye-west-yzy-11-netted-millions); other figures via [search summary](https://cointelegraph.com/news/yzy-token-bloodbath-sees-coordinated-snipers-extract-millions-from-kanye-fans) [N, snippet]
  - MemeTrans (known, re-used only for the soft-rug definition): label "high risk" includes min price within 20 min of migration below 0.3x migration price, i.e. a >70% drawdown that is still on-curve/sellable. — [arXiv 2602.13480](https://arxiv.org/html/2602.13480v1) [P]
- Exit-ability: yes at a loss (soft rug) unless the pool is drained, because sells go into the AMM or curve at the new price.

**6. Slow dev dump and creator-fee farming**
- Creator fee history: PumpSwap creator revenue share launched May 2025 (0.05% of eligible trades per The Block summary); Dynamic Fees V1 (Sept 2025) lowers creator fees as market cap rises; Jan 9, 2026 overhaul adds fee sharing up to 10 wallets, ownership transfer, revoke-update-authority and post-launch fee percentages; co-founder Alon Cohen: creator fees "may have skewed incentives toward low-risk coin creation instead of high-risk trading"; Feb 2026 Cashback Coins (fee redirected to traders, locked at launch; docs now label cashback claim "deprecated"); Mar 25, 2026 each token gets one fee-recipient redirect and then the config locks (anti "griefing"). — [The Block, 2026-01-09](https://www.theblock.co/amp/post/384975/pump-fun-overhauls-creator-fees-token-launches-highest-daily-september); [Cointelegraph, 2026-03-25](https://cointelegraph.com/news/pump-fun-creator-fee-cap-update-memecoin-model); [Block May 2025 via search snippet](https://www.theblock.co/news/defi/2025-05-13-pumpswap-revenue-tokens-354038) [N]
- The Cointelegraph piece does not mention dumps or rugs and notes the change does not restrict a creator selling their own holdings. — [Cointelegraph](https://cointelegraph.com/news/pump-fun-creator-fee-cap-update-memecoin-model)
- No quantitative measurement of "slow bleed" dev selling (share of tokens where the creator sells gradually over hours/days), creator-fee farming prevalence, or pre-/post-migration creator sell timing was found. Serial-deployer Substack (Apr 2025, secondary compilation, methods not stated): top 1% of deployers account for ~30% of launches; ~15% control clusters of 50+ wallets. — [Killy7 Substack, 2025-04-16](https://killy7.substack.com/p/serial-token-deployers-on-solana) [D, weak sourcing]
- Chen's data show slow rugs exist outside its window: of a 100-token non-rug sample, 9 were missed rugs unfolding over 3-7 days. — Chen

**7. Sniper and bundle supply capture (launch-block extraction)**
- Mechanism: wallets funded by the deployer or a related cluster buy in the creation block or first blocks (often via Jito bundles or multi-account buys in one tx), then sell into later buyers. Pine's "deployer-funded snipe" numbers are already in the sibling note.
- MemeTrans bundled stats are already in the sibling note. New: Kamat (arXiv 2607.02795, submitted 2026-07-02, v4 2026-10-05) identified 1,012 persistent early-buyer wallet cohorts (2-12 wallets; 2,965 addresses) from 1,578,333 buyer observations on 166,098 pump.fun launches (2026-06-11 to 06-25), but the abstract now says all numerical effect estimates are WITHDRAWN pending a corrected analysis (buyer records included sells and missed buys). Treat cohort-effect numbers as unusable; the cohort count and data scale are the only usable items. — [arXiv 2607.02795](https://arxiv.org/abs/2607.02795) [P, retracted numbers]
- LIBRA/YZY/HAWK above show the large-cap form: launch-block snipers fund-linked to the deployer or a repeat operator (Bubblemaps links LIBRA, MELANIA and YZY sniper flows to overlapping wallets, with the link to a named person unconfirmed for YZY). — Bubblemaps; The Block

**8. Fake or time-limited LP locks, and lock-adjacent traps**
- On pump.fun/PumpSwap canonical pools the LP is burned at migration (Pump README), so "fake lock" is largely not applicable to graduated pump.fun tokens; the question is only whether the pool you see is the canonical pool created by `migrate` (pool index 0). — [Pump README](https://raw.githubusercontent.com/pump-fun/pump-public-docs/main/docs/PUMP_PROGRAM_README.md); [PumpSwap README](https://raw.githubusercontent.com/pump-fun/pump-public-docs/main/docs/PUMP_SWAP_README.md) [O]
- Chen's LW labelling keys on LP retention by creator-related addresses and Solidus's Raydium detection on LP-token burns/withdrawal; neither paper reports a count of "fake locks" (time-limited lock contracts expiring, or LP sent to a lock the deployer can recall). I found no measurement of time-limited-lock rugs on Solana. [U]
- A secondary guide claims a bonding-curve token "migrates ~$10-15k of liquidity" to PumpSwap and that it is a thin market — vendor with a commercial interest. — [Hackernoon/Tsunammi](https://hackernoon.com/tsunammi-releases-research-pumpfun-launch-myths-every-token-operator-needs-to-clear-before-launch-d) [V]

**9. Bonding-curve and migration traps**
- No-sell window between completion and `migrate` (see structural facts). Migration is permissionless, so the window is normally closed by bots. — pump-public-docs
- Migration-moment dumps: MemeTrans's >70% drop within 20 min post-migration is the best number I have (84% of migrated tokens incl. a manipulation-score route). — MemeTrans (known)
- BOOST (Jul 2026) makes the first 5 minutes after migration structurally different (protocol buys + burns funded from the formerly dead 20%); no data yet on how rug/dump rates changed. — [The Block, 2026-07-29](https://theblock.co/post/409815/pump-fun-token-graduation-rate-jumps-boost-changes-launch-incentives)
- The Block says it is unclear whether the higher graduation rate will last and does not analyse rug risk. — same

**10. Metadata, impersonation and celebrity/hijack tokens**
- Chen found 3,203 tokens with inconsistent metadata (name/symbol mismatch such as an "Official TRUMP..." name with an ETH symbol) and 1,030 look-alike tokens imitating known brands/tokens among its flagged set, and concludes naming and off-chain features alone are not reliable fraud identifiers. — [Chen Table III and RQ1](https://arxiv.org/html/2603.24625) [P]
- Hijacked-celebrity-account pumps: SWEENEY (Sydney Sweeney's X account hijacked) +2,500% within 15 minutes then back toward zero over the next hour; HACKED token (Neymar, others hijacked) fell 96% in an hour to $5,700 market cap. These are 2024 cases. — [Decrypt, 2024](https://decrypt.co/250194/massive-twitter-hack-targets-large-accounts-crypto-scam) [N, snippet via search]
- Insane Labz/LABZ: paid impersonators of celebrities in Telegram; Bubblemaps linked a payment wallet to the token creator; token down >90%. — [Decrypt](https://decrypt.co/244248/fake-celebs-dana-white-nate-diaz-hasbulla-insane-labz) [N, snippet via search]

**11. Sandwich/MEV losses that look like rugs**
- Sandwich.me estimate (Accelerate 2025 talk, summary dated 2025-05-20, built from 8.5B trades): bots extracted $370M-$500M over 16 months; lower bound is SOL extracted, upper bound adds atomic memecoin revenue; per-validator "sandwich rate" average ~5% of blocks, outliers 30-60%; "wide/blind" sandwiches grew from ~1% to ~30% of attacks; attacks cluster around token launches and volatility; mitigations: validator client filtering, Jito "don't front" flag, Jito and Marinade validator blacklists, stake removal. The page is an AI-generated summary of a talk; memecoin-specific and per-victim figures not reported. — [Solana Compass](https://solanacompass.com/learn/accelerate-25/scale-or-die-at-accelerate-2025-the-state-of-solana-mev) [D/N, secondary]
- Later reports (Oct-Dec 2025): >6% of leader slots with sandwiches, Jito banned 15 more validators from JitoSOL, Marinade blacklisted >50 validators; Anza's Max Resnick said sandwiching is "way down" and attributes it to code improvements rather than blacklists. Only seen in search summaries (Blockworks page returned 403). — [Blockworks](https://blockworks.com/news/solana-sandwich-attacks-down) [N, snippet only; not opened]
- Jito closed its public mempool; one aggregator dated it 2025, but the linked The Block story pre-dates the June 2024 validator-removal story (I believe March 2024; not opened). — [The Block](https://www.theblock.co/amp/post/281504/solana-client-jito-labs-axes-mempool-function-following-increase-in-mev-attacks) [N, unverified date]

### Inferences
- Signatures a bot can observe (from standard SPL/Token-2022 semantics and the facts above, not separately sourced; verify against current program docs before coding):
  - Legacy SPL mint: `mintAuthority` and `freezeAuthority` fields non-null on the mint account; a FreezeAccount instruction on any token account is a hard flag. Token-2022 mint: parse the extension TLV list for TransferFeeConfig (fee bps and withdraw authority), TransferHook (hook program id), PermanentDelegate, Pausable, DefaultAccountState, NonTransferable, MintCloseAuthority.
  - LP pull: removal instruction by creator-related address; pool quote reserve drops >90% in a slot or few slots; one-sided pools (LIBRA).
  - Pump-and-dump/cluster dump: top-N holder cluster share at t0, clustered sells in the same minutes, holder count falling while pool token balance rises monotonically (Chen's rule).
  - Sandwich: your tx is bracketed by two same-signer swaps in the same block (detectable with block data); fill is worse than quote though the pool survives.
- For pump.fun-sourced candidates bought "in the first minutes" the dominant risks are classes 5, 7, 6 and 11. LP pull (1), freeze (2) and Token-2022 hook/fee traps (4) are mostly relevant to non-pump.fun launches or to `create_v2` mints whose extensions are unknown; verify extensions per mint instead of assuming.
- The Chen type mix (79/20/0.6) reflects pool-bearing tokens on Orca/Raydium/Meteora and its behaviour-based labelling favours the "cliff" type; it should not be read as the mix on pump.fun curves, where the LP-pull route does not exist.
- Because Chen's lifecycle ends at the first confirmed profit-taking transaction, its timing is a good proxy for "how long a late buyer has before the creator-side exit begins", but it does not cover rugs slower than 24 h.

### Gaps
- Official pump.fun statement of mint/freeze authority status for `create` and `create_v2` mints, and the list of Token-2022 extensions enabled on `create_v2`: not found; must be checked on-chain for a sample of recent mints.
- Any independent count of pump.fun creator-sell timing, slow-bleed dev selling or creator-fee farming: not found.
- Real prevalence of time-limited/fake LP locks, transfer-hook honeypots and transfer-fee honeypots on Solana: not found.
- Chainalysis figure "74,037 pump-and-dump tokens launched in 2024 (~3.6%)" appeared only in a search-engine summary; I could not find the primary Chainalysis text: unverified, do not use.
- Pine Analytics posts other than "Exit Liquidity Machines" (e.g. on bundles) were not found.
- Details of the YZY and HAWK sell timings in minutes: Bubblemaps/The Block did not give them in the pages I opened.

---

## Q2. What prevalence and timing numbers exist from independent measurement versus vendor claims?

### Takeaway
Independent academic measurement supports "most new pool-bearing Solana tokens end in rug-like behaviour and the median fraud lifecycle is well under a few hours" but each definition differs, and the vendor "98-99%" headline measures something much narrower than rugs (pump.fun tokens that dropped below $1,000 liquidity before graduating). Two additional corrections: Chen's lifecycle table is internally inconsistent in units, and the 76% excludes pump.fun-only curve tokens.

### Cited Findings
#### Independent / academic [P]
- Chen et al. (v2 dated 2026-05-31): 100,063 tokens newly issued on Orca, Raydium, Meteora (Jan 1-Jun 30 2025), 76,469 flagged (60,402 P&D, 15,606 LW, 461 FAA); labels are conservative lower bounds (24 h window, 9 of 100 "non-rug" sampled were slow missed rugs, ~15% of correctly excluded were still trading 6+ months later); pump.fun-only tokens that never created pools were excluded because Solidus reports 98.6% become worthless. — [arXiv 2603.24625](https://arxiv.org/html/2603.24625)
- Chen lifecycle definition: time from creation to the first confirmed fraud-related profit-taking transaction. Table IV (header "Days") rows: all rugs mean 2.91, P25 0.0087, median 0.0246, P75 0.0646; freeze abuse mean 14.56, P25 0.0327, median 0.483, P75 4.69; liquidity manipulation mean 9.87, P25 0.0090, median 0.0385, P75 0.966; pump-and-dump mean 0.059, P25 0.0085, median 0.0221, P75 0.0489. Converted from days: all rugs P25 ~12.5 min, median ~35 min, P75 ~93 min; P&D median ~32 min, P75 ~70 min; LW median ~55 min, P75 ~23 h; freeze median ~11.6 h, P75 ~4.7 days. The prose states the median lifecycle is "less than one hour" and the P75 "generally does not exceed 5 hours" for all three types, which contradicts the table for freeze (median) and LW/freeze (P75) if the table is in days. Table II (the 117 verified benchmark rugs) gives median lifecycle 0.0116 days (~17 min) and P75 0.0576 days (~83 min), which supports days for the benchmark. — Chen
- Chen: activity of rug tokens is concentrated on day one; the number of rugs correlates strongly with SOL price; rug tokens have minimal holder counts. — Chen
- MemeTrans, SolRPDS, "Catching the Rug": see sibling note.
- Marino et al., "Predicting the success of new crypto-tokens: the Pump.fun case" (arXiv 2602.14860, 2026-02-16): graduation probability modelled from SOL locked in curve plus structural/behavioural launch variables; the abstract gives no figures. — [arXiv](https://arxiv.org/abs/2602.14860) [P, abstract only]
- Kalal et al. cited in Chen: ~55% of newly issued Solana tokens/pools eventually show rug behaviour (highest density across major chains). I did not open the original. — via [Chen intro](https://arxiv.org/html/2603.24625) [P, secondary citation]

#### Vendor / marketing / forensic-vendor [V]
- Solidus Labs (May 2025; Token Sniffer vendor): pump.fun metric = tokens deployed Jan 2024-Mar 2025 with at least five trades that fell below $1,000 liquidity (in SOL terms), excluding tokens upgraded to Raydium; >7 million tokens in the sample, only ~97,000 stayed above $1,000; headline 98.7% in the summary, 98.6% in body, "98%" in conclusion. The page contains no time-to-rug statistic, no dollar losses for pump.fun, and an unfinished lorem-ipsum wash-trading section. The Defiant/Forklog coverage reports pump.fun disputing the report; I only saw that in a search summary. — [Solidus](https://www.soliduslabs.com/reports/solana-rug-pulls-pump-dumps-crypto-compliance); dispute via [search summary of Defiant/Forklog](https://thedefiant.io/news/defi/alarming-99-of-memecoin-launches-on-pumpfun-are-pump-and-dumps-or-rug-pulls-report) [U]
- Correction to sibling note: "99% of pump.fun launches are pump-and-dump/rug" is better read as "~98.6% of pump.fun tokens with 5+ trades that never migrated fell under $1,000 liquidity"; it is a failure-to-graduate/death metric consistent with the ~1.4% graduation rate, not a measure of fraud or of losses. — Solidus methodology vs [Solana Compass](https://solanacompass.com/news/pumpfun-launched-42000-tokens-in-one-day-fewer-than-2-will-ever-reach-a-dex)
- Tsunammi (marketing hackernoon piece): claims ~0.7-0.8% graduation in Jul-Aug 2025 (via MEXC) and thin PumpSwap liquidity at graduation. — [Hackernoon](https://hackernoon.com/tsunammi-releases-research-pumpfun-launch-myths-every-token-operator-needs-to-clear-before-launch-d) [V]

#### Independent forensics on named cases [D]
- LIBRA, HAWK, MELANIA, YZY above (Bubblemaps; wallet-level evidence, not intent findings; Bubblemaps is also a product vendor).

### Inferences
- The defensible statement for a builder: "roughly three-quarters of pool-bearing tokens on Orca/Raydium/Meteora in H1 2025 show a rug-like exit within the observation window, and more than 98% of pump.fun tokens never graduate"; these are two different populations and the 99% is not a rug rate.
- Use ~30-60 min as the central estimate for time from creation to first fraud-related profit-taking for pool-bearing rug tokens, with a fat right tail (freeze/LW up to a day or more) and Chen's own text saying <1 h median. The exact figure depends on the unresolved unit question.
- Slow rugs (3-7 days) are under-counted by 24 h windows; any "within an hour" statistic is biased toward fast rugs.

### Gaps
- Unit/typo in Chen Table IV not resolved (could check the released dataset: ITW-76469 and Benchmark-117 have per-token event summaries).
- No independent post-2025 rug-rate measurement for H2 2025-Oct 2026 (post-PumpSwap, post-creator-fee changes, post-BOOST).
- Solidus's own report date conflicts across sources (one search result implied a 2026 preprint; the vendor page says May 2025); I treat May 2025 as correct.
- Pump.fun's rebuttal quote could not be opened.

---

## Q3. How much loss is hard rug versus soft rug, and what does a 60-second-delayed buyer typically experience?

### Takeaway
Hard rugs (unsellable or liquidity-drained) are a small count share of what independent measurement flags (freeze 0.6% + LP pull 20% of flagged tokens), while soft rugs (holder/pool cliff via sellable dumps) are about 79% by count; I found no source that splits dollar losses by hard vs soft, and no measurement of what a one-minute-late buyer actually experiences.

### Cited Findings
- Count split of flagged rugs (Chen): P&D (soft, still sellable) 60,402 = 79.0%; LP withdrawal 15,606 = 20.4%; freeze abuse 461 = 0.6%. Benchmark of verified cases: 89 / 26 / 2. — [Chen](https://arxiv.org/html/2603.24625)
- Chen's own classification into "hard" (malicious contract logic) vs "soft" (market-mechanism) rugs places Solana mostly in behaviour-driven (soft) territory, since the token program is shared. — [Chen](https://arxiv.org/html/2603.24625)
- Dollar loss per Chen: at least $151.09M direct, 7,322 profitable addresses; $133.3M of it in SOL (median per-address SOL profit 5.99 SOL), $17.8M in stablecoins; only direct withdrawals counted. Not split by type. — Chen Table V
- Raydium LP-pull rugs by Solidus: median ~$2,832, 25% below $732, max $1.9M: small tickets dominate. — Solidus
- Large-cap cases were soft-rug-like for holders but with hard LP removal on the pool side: LIBRA (liquidity removed, >95% down), HAWK (~95% down from $500M peak, 3% of supply in the pool), YZY (74-80%+ down after +1,400% in first hour per different outlets). — Bubblemaps; The Block; Cointelegraph (snippets)
- YZY distribution of outcomes: 73.8% of 70,201 traders lost money; 86% of profitable wallets made under $1,000; 11 wallets took ~30% of profits. — [The Block, 2025-08-28](https://www.theblock.co/post/368557/kanye-west-yzy-11-netted-millions)
- Account-hijack pumps: SWEENEY +2,500% in 15 minutes then near-zero within the next hour; HACKED -96% in an hour. — Decrypt (2024, snippet)
- MemeTrans post-migration: ">70% drawdown within 20 min of migration" is the "high risk" criterion for 84% of migrated pump.fun tokens (includes manipulation route) and its top-100 risk-ranked picks cut loss from 60.71% to 26.64%. — [arXiv 2602.13480](https://arxiv.org/html/2602.13480v1) (known)
- Snipers exit within 1-5 minutes (Pine) — see sibling note for the source; deployer-funded snipes ~1.75% of launches.

### Inferences
- A copier entering ~60 s after a leader in a pump.fun token most likely buys after the sniper/bundle layer has filled and is selling or about to sell, on a pre-migration curve where (a) sells still work against curve liquidity, (b) price impact of the follower's own size is small, and (c) the realistic loss is a soft-rug drawdown (70-95%) with the exit still available, but at progressively worse prices: this is inference from curve mechanics, Chen's 32-min P&D median lifecycle and Pine's 1-5 min sniper exit, not a measured follower outcome.
- Hard-rug exposure for a pump.fun-only strategy should be small because (i) no LP pull after migration (LP burned), (ii) no creator LP on the curve. The residual hard-rug risks are (1) the migration no-sell window, (2) `create_v2`/Token-2022 mints with unvetted extensions, (3) copying a leader into non-pump.fun pools (Raydium/Meteora/Orca) where LP pull and freeze are live.
- Loss accounting should therefore track "% drawdown reachable by selling at t+X" rather than "rug yes/no".

### Gaps
- No measurement of follower (late-entry) P&L relative to leader or distribution of price at t0+60 s relative to fills for insider-pattern wallets: not found. This must be computed from your own data (the repo's copy-fill replay is the right tool).
- No hard vs soft dollar split on Solana.
- No data on how many soft rugs are sellable at which minute (liquidity depth vs sell size) beyond the pool-depth anecdotes above.

---

## Q4. What changed on Solana in 2025-2026 that affects rugs (PumpSwap, creator fees, Alpenglow, Jito/anti-sniper, Mayhem Mode)?

### Takeaway
Verified: PumpSwap (Mar 2025) burns LP on migration; creator-fee regime changed repeatedly (May 2025, Sept 2025, Jan/Feb/Mar 2026); Mayhem Mode and `create_v2`/Token-2022 mints arrived Nov 2025; BOOST changed post-migration mechanics in Jul 2026; sandwiching was publicly reduced but not eliminated. Alpenglow was scheduled for 2026-10-21 but I could not verify that it activated. I found no verified pump.fun anti-sniper feature.

### Cited Findings
- PumpSwap launched March 2025 as pump.fun's own DEX with instant, free migration for graduated tokens (the old 6 SOL migration fee eliminated). — [The Block, Mar 2025](https://www.theblock.co/post/347360/pump-fun-launches-dex-called-pumpswap-to-instantly-migrate-graduated-tokens) [N, via search snippet]
- LP tokens burned at migration (Pump program README). — [O](https://raw.githubusercontent.com/pump-fun/pump-public-docs/main/docs/PUMP_PROGRAM_README.md)
- Creator-fee sequence: May 2025 PumpSwap creator revenue share; Sept 2025 Dynamic Fees V1; Jan 9 2026 overhaul (fee sharing up to 10 wallets, transfer ownership, revoke update authority, post-launch fee percentages; ~30,000 launches on the Tuesday before, highest since mid-Sept); Feb 2026 Cashback Coins; Mar 25 2026 one-time recipient redirect then locked. — The Block (2026-01-09); Cointelegraph (2026-03-25)
- Mayhem Mode (Nov 2025) and `create_v2` on Token-2022 (see structural facts). The Block raised the concern that it "could be perceived as engaging in wash-like behavior" but found no impact on launch counts in the first week. One search summary also says the agent may randomly sell and could exhaust the curve; I could not confirm that in a primary source. — [The Block, 2025-11-18](https://www.theblock.co/post/379285/pump-funs-new-mayhem-mode-fails-boost-token-launches-revenue)
- BOOST (Jul 2026) described above; graduation 6.7% on 2026-07-24. — [The Block, 2026-07-29](https://theblock.co/post/409815/pump-fun-token-graduation-rate-jumps-boost-changes-launch-incentives)
- Alpenglow: Anza said it "goes live on mainnet-beta Wednesday, October 21" with finality falling from ~12.8 s to ~150 ms; user transactions pause between the gate and the handoff; Firedancer/Frankendancer not supported; `confirmed` and `finalized` become the same state; vote transactions (about 63% of transactions in early October) leave blocks. As of the article (2026-10-13) the feature gate showed "Not activated". A separate Anza post (reported 2026-10-20) gives slot 459,653,000, ~14:00 UTC; times differ across sources (14:00, 14:50, 13:20 UTC epoch start). A September 28 activation rumour was denied. I found no post-event source confirming activation. — [Solana Compass, 2026-10-13](https://solanacompass.com/news/anza-sets-alpenglow-mainnet-date-solanas-consensus-switch-is-scheduled-for-october-21-at-about-1450-utc); [Solana Compass slot post (search result)](https://solanacompass.com/news/alpenglow-is-pending-activation-on-solana-mainnet-with-towerbft-set-to-retire-at-slot-459653000) [U on outcome]
- Jito/MEV: public mempool closed (date unverified, see Q1 type 11); Marinade/Jito validator blacklists; Jito "don't front" sentinel; Anza's Resnick says sandwiching "way down" and credits code rather than bans (headline seen via search; page 403). — Solana Compass Accelerate 2025 page; Blockworks (snippet)
- Anti-sniper: I found no verified pump.fun feature that blocks first-block sniping or bundles. Believe app reportedly added "automatic and manual fee blocking" on new tokens; I only saw the intro. — [crypto.news](https://crypto.news/believe-memecoin-launchpad-rolls-out-rug-protection-features/) [U]
- Bubblemaps (Sept 2026 revamp) filters feeds for insider clusters/bundles (sibling note).

### Inferences
- Alpenglow (if live) shortens finality, not block inclusion order; it does not change who can snipe in the creation block. For a bot it removes the confirmed/finalized distinction and may temporarily pause transactions at the handoff; treat any stalled-fill logging around 2026-10-21 accordingly.
- The creator-fee redesign and BOOST push incentives toward holding the narrative rather than hit-and-run, but no measurement shows a lower rug rate; the Block, Cointelegraph and Cohen's own remarks describe intent, not outcomes.
- Post-migration early minutes now include protocol buy+burn flow funded from the formerly dead 20%; follower entries in minutes 0-5 after migration face a different price dynamic than the 2024-2025 datasets (MemeTrans, Chen) describe, so those datasets under-represent the current regime.

### Gaps
- Whether Alpenglow actually activated on 2026-10-21: unverified (check chain, `solana alpenglow-genesis-info`, or Anza/Foundation announcements).
- Date of Jito mempool closure: unverified (believed March 2024).
- Any verified pump.fun anti-snipe/anti-bundle feature in 2025-2026: not found.
- Mayhem Mode: agent sell behaviour and rug interaction not verified from primary docs; DefiLlama lists "Pump Fun Mayhem Fees" revenue (~$755K in one period) per a search summary only.
- Post-BOOST dump/rug statistics: none yet.
