# Solana memecoin pool types: pricing, on-chain state, depth, LP control, creation and migration

Research date 2026-10-27. Solana only. Public docs, public source and public GET endpoints only; no account, no keys, no RPC calls (so no offset below was validated against a live account).

Evidence tags used in every bullet:
- [V] read by me in a primary source this session (official docs, program source, IDL, official SDK source).
- [C] computed by me from [V] material (byte offsets summed from IDL or struct order, arithmetic, derived formulas). Offsets include the 8-byte Anchor discriminator unless stated.
- [L] live public GET on 2026-10-27 (Jupiter lite-api, GeckoTerminal, DexScreener). Point in time.
- [T] third-party or secondary (blog, news, vendor).
- [I] my inference or recommendation; not stated by a source.

Previous notes reused, not redone: `/Users/srinjoydas/GodsEye/research_notes/Organic token detection/meteora_dbc.md` (DBC offsets, events, keeper thresholds) and `/Users/srinjoydas/GodsEye/research_notes/Rug detection for copy trading/pre_buy_checks.md` and `post_buy_monitoring_calibration.md` (stressed-exit arithmetic, drain base rates). Sources I fetched for raw code live in the session scratchpad; every URL below is public.

Short list of things a developer most needs to know:
1. Every venue except the proprietary AMMs reduces to "x*y=k with some (virtual) reserves per price range", so one exit-capacity formula covers all of them: quote out for a -X% spot-price move = `Q_virtual * (1 - sqrt(1 - X))`, where `Q_virtual` is the quote-side virtual reserve of the liquidity that is active over that price range (section 2).
2. Pump.fun and PumpSwap changed materially in 2026: effective quote reserve is `vault + virtual_quote_reserves` (signed), fees may be parked in the vault, fee rates are market-cap tiers read from an on-chain `FeeConfig`, and BOOST adds extra virtual reserves. Naive "vault balance = liquidity" is wrong there.
3. "LP burned or locked" is a different check on each venue (SPL LP burn, lock program escrow, Token-2022 frozen NFT, `lock_release_point`, `permanent_lock_liquidity`). Section 17 has the matrix.

---

## 1. Program ids, discriminators, PDAs and cheap fetch patterns

### Takeaway
All program ids in the brief are confirmed against official source, IDLs or SDK constants, and each maps to a Jupiter route label today. Three programs (PumpSwap, Meteora DAMM v1, Meteora DAMM v2) all name their pool account `Pool` and therefore share the identical 8-byte discriminator, so an account must always be filtered by owner program, not by discriminator alone.

### Cited Findings
- Pump bonding curve program `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`, `Global` PDA seeds `["global"]` = `4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf`; BondingCurve PDA seeds `["bonding-curve", mint]` [V] — [PUMP_PROGRAM_README](https://raw.githubusercontent.com/pump-fun/pump-public-docs/main/docs/PUMP_PROGRAM_README.md)
- PumpSwap `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA`, `GlobalConfig` PDA `["global_config"]` = `ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw`; Pool PDA seeds `["pool", index(u16 LE), creator, baseMint, quoteMint]`; LP mint PDA `["pool_lp_mint", pool]` [V] — [PUMP_SWAP_README](https://raw.githubusercontent.com/pump-fun/pump-public-docs/main/docs/PUMP_SWAP_README.md); u16 LE encoding of `index` from [pump-swap-sdk 2.1.0 source](https://unpkg.com/@pump-fun/pump-swap-sdk@2.1.0/dist/index.js) [V]
- Raydium AMM v4 `675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8` (mainnet), described as constant product that also shares liquidity into OpenBook orders [V] — [raydium-amm README](https://raw.githubusercontent.com/raydium-io/raydium-amm/master/README.md); OpenBook v1 program `srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX` [V] — [raydium-sdk-V2 programId.ts](https://raw.githubusercontent.com/raydium-io/raydium-sdk-V2/master/src/common/programId.ts)
- Raydium CPMM `CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C` [V] — [cp-swap lib.rs](https://raw.githubusercontent.com/raydium-io/raydium-cp-swap/master/programs/cp-swap/src/lib.rs); CLMM `CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK`; LaunchLab `LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj` (also the `address` field in the Raydium LaunchLab IDL); Raydium lock program for both CPMM and CLMM `LockrWmn6K5twhz3y9w1dQERbmgSaRkfnTeTKbpofwE`, with lock authority PDAs `3f7GcQFG397GAaEnv51zR6tsTVihYRydnydDD1cXekxH` (CPMM) and `kN1kEznaF5Xbd8LYuqtEFcxzWSBk5Fv6ygX6SqEGJVy` (CLMM) [V] — [programId.ts](https://raw.githubusercontent.com/raydium-io/raydium-sdk-V2/master/src/common/programId.ts), [raydium_launchpad.json IDL](https://raw.githubusercontent.com/raydium-io/raydium-idl/master/raydium_launchpad/raydium_launchpad.json)
- Orca Whirlpools `whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc` [V] — [whirlpool lib.rs](https://raw.githubusercontent.com/orca-so/whirlpools/main/programs/whirlpool/src/lib.rs)
- Meteora DLMM `LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo` (IDL `lb_clmm` 0.12.0) [V] — [dlmm.json](https://raw.githubusercontent.com/MeteoraAg/dlmm-sdk/main/idls/dlmm.json); DAMM v1 `Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB` (IDL `amm` 0.5.3) [V] — [DBC SDK copy of damm-v1 IDL](https://raw.githubusercontent.com/MeteoraAg/dynamic-bonding-curve-sdk/main/packages/dynamic-bonding-curve/src/idl/damm-v1/idl.json); DAMM v2 `cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG` (IDL `cp_amm` 0.2.5) [V] — [damm-v2 lib.rs](https://raw.githubusercontent.com/MeteoraAg/damm-v2/main/programs/cp-amm/src/lib.rs), [damm-v2-sdk IDL](https://raw.githubusercontent.com/MeteoraAg/damm-v2-sdk/main/src/idl/cp_amm.json); DBC `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN` [V] — [DBC README via prior note](https://github.com/MeteoraAg/dynamic-bonding-curve); Dynamic Vault `24Uqj9JCLxUeoC3hGfh5W3s9FM9uCHDS2SG3LYwBpyTi` (prior note).
- Jupiter's program-id to label map (111 entries today) contains all of them: Pump.fun, Pump.fun Amm, Raydium, Raydium CP, Raydium CLMM, Raydium Launchlab, Whirlpool, Meteora DLMM, Meteora (DAMM v1), Meteora DAMM v2, Dynamic Bonding Curve [L] — [Jupiter program-id-to-label](https://lite-api.jup.ag/swap/v1/program-id-to-label)
- Discriminators (first 8 bytes of account data), from IDLs: pump `BondingCurve` `[23,183,248,55,96,216,172,96]`, pump `Global` `[167,232,232,177,200,108,114,127]`, pump `FeeConfig` `[143,52,146,187,219,123,76,155]`; DLMM `LbPair` `[33,11,49,98,181,101,177,13]`, `BinArray` `[92,142,92,220,5,148,70,181]`, `PositionV2` `[117,176,212,199,245,180,133,182]`; DBC `VirtualPool` `[213,224,5,209,98,69,119,92]`; LaunchLab `PoolState` `[247,237,227,245,215,195,222,70]`; DAMM v2 `Position` `[170,188,143,228,122,64,247,208]`. PumpSwap `Pool`, DAMM v1 `Pool` and DAMM v2 `Pool` are all `[241,154,109,4,17,177,109,188]` [V/C] — [pump.json](https://raw.githubusercontent.com/pump-fun/pump-public-docs/main/idl/pump.json), [pump_amm.json](https://raw.githubusercontent.com/pump-fun/pump-public-docs/main/idl/pump_amm.json), [dlmm.json](https://raw.githubusercontent.com/MeteoraAg/dlmm-sdk/main/idls/dlmm.json), [damm1 IDL](https://raw.githubusercontent.com/MeteoraAg/dynamic-bonding-curve-sdk/main/packages/dynamic-bonding-curve/src/idl/damm-v1/idl.json), [damm2 IDL](https://raw.githubusercontent.com/MeteoraAg/damm-v2-sdk/main/src/idl/cp_amm.json)
- Pool-address derivation from mints (PDA seeds, source-verified): Raydium CPMM `["pool", ammConfig, mintA, mintB]` with mints in sorted order (`token_0 < token_1`) [V] — [cpmm pda.ts](https://raw.githubusercontent.com/raydium-io/raydium-sdk-V2/master/src/raydium/cpmm/pda.ts); Raydium CLMM `["pool", amm_config, token_mint_0, token_mint_1, seed_index?]` [V] — [clmm pool.rs](https://raw.githubusercontent.com/raydium-io/raydium-clmm/master/programs/amm/src/states/pool.rs); Orca `["whirlpool", whirlpools_config, mint_a, mint_b, fee_tier_index_seed]` [V] — [whirlpool.rs](https://raw.githubusercontent.com/orca-so/whirlpools/main/programs/whirlpool/src/state/whirlpool.rs); Raydium AMM v4 is not derived from mints: it derives from the OpenBook market id with seeds `[programId, marketId, "amm_associated_seed"]` [V] — [liquidity utils.ts](https://raw.githubusercontent.com/raydium-io/raydium-sdk-V2/master/src/raydium/liquidity/utils.ts); LaunchLab, DLMM, DAMM v2 PDA seeds were not read (see Gaps); DBC `VirtualPool` seeds (quote mint, base mint, config) are from the prior note.
- `Pool`/state `dataSize` and mint offsets usable as `getProgramAccounts` filters, all [C] from the IDL/struct sources cited in the per-venue sections: AMM v4 752 bytes, `coin_vault_mint` 400, `pc_vault_mint` 432; CPMM 637 bytes, `token_0_mint` 168, `token_1_mint` 200; CLMM 1544 bytes, `token_mint_0` 73, `token_mint_1` 105; Orca 653 bytes, `token_mint_a` 101, `token_mint_b` 181; DLMM `LbPair` 904 bytes, `token_x_mint` 88, `token_y_mint` 120; DAMM v2 1112 bytes, `token_a_mint` 168, `token_b_mint` 200; DAMM v1 `token_a_mint` 40, `token_b_mint` 72; DBC `VirtualPool` 424 bytes, `base_mint` 136; PumpSwap `base_mint` 43, `quote_mint` 75.
- Multi-pool reality [L]: DexScreener lists 17 pairs for BIRB (`G7vQWurMkMMm2dU3iZpXYFTHT9Biio4F4gZCrwFpKNwG`): Raydium CLMM `GUWFT7bb...` at about $781k liquidity, Meteora DLMM at about $15k, several Meteora DAMM v2 and PumpSwap dust pools under $100, and GeckoTerminal also lists "stonkfun" launches where BIRB is the quote token — [DexScreener token-pairs](https://api.dexscreener.com/token-pairs/v1/solana/G7vQWurMkMMm2dU3iZpXYFTHT9Biio4F4gZCrwFpKNwG), [GeckoTerminal token pools](https://api.geckoterminal.com/api/v2/networks/solana/tokens/G7vQWurMkMMm2dU3iZpXYFTHT9Biio4F4gZCrwFpKNwG/pools?page=1)

### Inferences
- [I] Enumerate pools with an indexer GET (GeckoTerminal `/tokens/{mint}/pools`, DexScreener `/token-pairs/v1/solana/{mint}`, Jupiter) and then verify the shortlisted pool accounts on chain with `getMultipleAccounts`; running `getProgramAccounts` per program on every candidate token is heavy and commonly restricted on shared RPC nodes (not verified here). For tokens created in your own stream, record the pool address at the creation/migration event instead of searching later.
- [I] Always check `account.owner` against the program id table; the shared `Pool` discriminator means a discriminator-only decoder can mis-decode a DAMM v1 pool as PumpSwap.
- [I] A token can appear as the quote side of other pools (pump-coin quote mints up to depth 2, "stonkfun" style); filter pools by `base_mint == token` and treat `quote_mint == token` pools separately.

### Gaps
- DLMM `LbPair` PDA seeds, DAMM v2 pool PDA seeds (config-based vs customizable) and LaunchLab pool PDA seeds were not read; use indexers or events to find them.
- Whether `getProgramAccounts` with these filters is practical on the user's RPC provider was not tested.
- I could not validate any offset against a live account (RPC POST excluded by the task constraints).

---

## 2. Cross-venue depth: price impact formulas and one comparable "exit capacity" number

### Takeaway
Every readable venue is constant product on some virtual reserve pair per active price range, so the SOL you can extract for a given price decline has one closed form in-range (`Q_virtual*(1-sqrt(1-X))`) and a tick/bin/segment walk when the move leaves the range. A single comparable bot number is "net quote (in SOL) received when selling just enough tokens to move the pool's marginal price down X% (use X=10% and 30%)", computed by simulating the venue's own quote function.

### Cited Findings
- Constant product, Raydium CPMM: `out = floor(in * out_vault / (in_vault + in))` applied after fees on the input amount [V] — [constant_product.rs](https://raw.githubusercontent.com/raydium-io/raydium-cp-swap/master/programs/cp-swap/src/curve/constant_product.rs); Raydium AMM v4 and PumpSwap use the same form (sections 4 and 5).
- Concentrated liquidity (Orca, Raydium CLMM, Meteora DAMM v2, DBC curve segments) uses amounts `Δa = L*(1/√P_lo - 1/√P_hi)` (token A / base) and `Δb = L*(√P_hi - √P_lo)` (token B / quote) with Q64.64 sqrt prices; DBC source states these formulas verbatim in code comments, and Meteora's DAMM v2 formulas page gives `ΔA = L*(1/√P - 1/√P_max)`, `ΔB = L*(√P - √P_min)` [V] — [DBC curve.rs](https://raw.githubusercontent.com/MeteoraAg/dynamic-bonding-curve/main/programs/dynamic-bonding-curve/src/curve.rs), [DAMM v2 formulas](https://docs.meteora.ag/core-products/damm-v2/formulas.md)
- Tick crossing rule: moving a-to-b (price down) the active liquidity changes by `-liquidity_net` of the crossed tick; moving b-to-a it changes by `+liquidity_net` [V] — [Orca swap_manager.rs](https://raw.githubusercontent.com/orca-so/whirlpools/main/programs/whirlpool/src/manager/swap_manager.rs)
- Orca prices the step on the input amount after taking the fee first: `amount_calc = amount_remaining * (1_000_000 - fee_rate) / 1_000_000` [V] — [Orca swap_math.rs](https://raw.githubusercontent.com/orca-so/whirlpools/main/programs/whirlpool/src/math/swap_math.rs)
- Meteora DLMM: bin price `P_i = (1 + bin_step/10000)^i` in Q64.64; within a bin the exchange is constant sum (`out_Y = in_X*P`, `out_X = in_Y/P`), so depth is the sum of token amounts in bins (not a curve) [V] — [DLMM formulas](https://docs.meteora.ag/core-products/dlmm/formulas.md), [price_math.rs](https://raw.githubusercontent.com/MeteoraAg/dlmm-sdk/main/commons/src/math/price_math.rs)
- Jupiter route: a quote response's `routePlan[].swapInfo` carries `ammKey`, `label`, `inputMint`, `outputMint`, `inAmount`, `outAmount`, and each leg has `percent`; `priceImpactPct` is shown in the docs only as the string `"0"` with no unit stated [V] — [Jupiter get-quote docs](https://developers.jup.ag/docs/swap-api/get-quote)
- Live check of units [L]: a 100 SOL to USDC quote returned `priceImpactPct = 0.00097100...`, and a 5 SOL buy into a small PumpSwap pool returned `0.1987...`; those magnitudes are plausible only as fractions (0.097% and 19.9%), not as percent numbers — [Jupiter quote 100 SOL](https://lite-api.jup.ag/swap/v1/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&amount=100000000000&slippageBps=100)
- Prior-note stressed-exit arithmetic (constant product): token block `T` sold into base reserve `B` drops price by `1 - 1/(1+T/B)^2`; at migration the pump pool base reserve is about 206.9M tokens (section 3) — [pre_buy_checks.md](/Users/srinjoydas/GodsEye/research_notes/Rug%20detection%20for%20copy%20trading/pre_buy_checks.md)

### Inferences
Derived by me ([C]/[I]); the table below was checked numerically against a brute-force constant-product simulation.

Definitions for a pool with base reserve `B` (memecoin), quote reserve `Q` (the quote side, `Q_eff` where a venue has virtual quote), selling `T` base:
- Pre-fee output `out = Q*T/(B+T)`; marginal price after = `Q*B/(B+T)^2`; ratio to spot = `(B/(B+T))^2`.
- Spot-price decline `X` after selling `T`: `T = B*(1/sqrt(1-X) - 1)` and `out = Q*(1 - sqrt(1-X))`.
- Average execution shortfall at that size = `T/(B+T)` which equals `1 - sqrt(1-X)`; for constant product the end-spot move and the average shortfall are therefore the same number at the same size (table).

| spot decline X | T/B | out/Q (pre-fee) = avg shortfall |
|---|---|---|
| 5% | 0.026 | 2.53% |
| 10% | 0.054 | 5.13% |
| 20% | 0.118 | 10.56% |
| 30% | 0.195 | 16.33% |
| 50% | 0.414 | 29.29% |
| 75% | 1.000 | 50.00% |

Venue-specific meaning of `Q` for the exit number:
- Pump bonding curve: `Q = virtual_quote_reserves`, but the real SOL that can leave is `real_quote_reserves = virtual - 30 SOL` (initial virtual), so the formula is always satisfiable.
- PumpSwap: `Q = quote_vault.amount + virtual_quote_reserves` (signed add) priced; real extractable quote is `quote_vault.amount - protocol_fees - creator_fees` (the SDK throws if real reserves cannot cover the output).
- Raydium AMM v4: `Q = pc_vault.amount - need_take_pnl_pc`; CPMM: `vault - protocol_fees - fund_fees - creator_fees`.
- CLMM/Orca/DAMM v2/DBC within the active range: `Q_virtual = L*√P` (virtual quote), `B_virtual = L/√P`; this holds only while `√P' >= √P_lower_of_range`; below that, walk to the next range with its own `L`. Real quote left in range down to `P_lo` is `L*(√P - √P_lo)`.
- DLMM: no curve. Selling X for Y consumes bins at and below the active bin; one bin step is a `bin_step/10000` price move, so a `-X%` move spans `ln(1/(1-X))/ln(1+bin_step/10000)` bins (bin_step 100: 10.6 bins for -10%, 35.8 for -30%; bin_step 20: 52.7 and 178.5; bin_step 5: 210.8 and 713.5). Exit capacity is the Y amount (after the fee) in bins `[active - n, active]`; the variable fee grows as the volatility accumulator rises per bin crossed (section 10), so use the quote function.

Algorithm for one bot-comparable number (quote units; convert to SOL with the quote token's SOL price when the pool is USDC or token quoted):
```
exitCapacitySol(pool, X):
  state = readPoolState(pool)                       // venue adapter
  P0 = state.spotPrice
  // find the largest sell size T whose post-trade marginal price >= P0*(1-X)
  lo=0; hi=totalBaseInPoolOrSupply
  while hi-lo > tol: mid=(lo+hi)/2; if state.simulateSell(mid).endSpot >= P0*(1-X) then lo=mid else hi=mid
  return state.simulateSell(lo).netQuoteOut          // net of LP/protocol/creator fees
// bot features:
//   exit10 = exitCapacitySol(pool,0.10); exit30 = exitCapacitySol(pool,0.30)
//   ownImpact = 1 - simulateSell(myTokens).netQuoteOut / (myTokens*P0)
//   depthRatio = exit10 / (my position value)          // want >> 1
//   stress    = simulateSell(insiderTokens + bundleTokens + topHolderTokens).endSpot / P0   // prior note's T/B test
//   // aggregate across pools of the token: sum exit10 over pools but cap each pool at its own liquidity;
//   // never assume a sell splits perfectly: routers do split (Jupiter quote showed a 99%/1% split across two venues, section 14)
```
- [I] Use `exit10` for "can I get out" and `ownImpact` for "what does exiting cost"; the first measures depth, the second measures my fee and slippage. Report both in SOL, plus the venue's `LP burned/locked share` from section 16 as a separate gate, because depth that its owner can withdraw is not depth.
- [I] Cross-check any adapter against a Jupiter quote of the same size (`routePlan[].swapInfo.ammKey`/`label` tell which pool the router used) before trusting a hand-rolled adapter; a mismatch above a few bps usually means a missed fee bucket, a virtual reserve or an out-of-range tick.

### Gaps
- Jupiter's own definition of `priceImpactPct` (fraction vs percent, and relative to what reference price) is not documented on the page I fetched; my unit reading is from magnitudes only.
- No source gives a standard cross-venue "exit capacity" definition; the one above is mine.
- Multi-hop and split-route impact is not modelled; Jupiter route simulation is the only holistic check.

---

## 3. pump.fun bonding curve (`6EF8rrec...`)

### Takeaway
A constant-product curve on virtual reserves (initial 1,073,000,000 tokens / 30 SOL virtual, 793.1M tokens sold on the curve) with no LP and no pull risk; it completes when `real_token_reserves == 0`, then a permissionless `migrate` (now `migrate_v2`) opens a PumpSwap pool whose LP is burned. Fees are now market-cap-tiered via an on-chain `FeeConfig`, not a flat 1%.

### Cited Findings
- Curve is "based on Uniswap V2" with synthetic reserves; `Global` initial values at the time of the README: `initial_virtual_token_reserves` 1,073,000,000,000,000, `initial_virtual_sol_reserves` 30,000,000,000, `initial_real_token_reserves` 793,100,000,000,000, `token_total_supply` 1,000,000,000,000,000 (6 decimals), `fee_basis_points` 100, `pool_migration_fee` 15,000,001 lamports; `complete` is set at the end of a buy when `real_token_reserves == 0`; `migrate` is permissionless, idempotent, and the LP tokens received are burnt [V] — [PUMP_PROGRAM_README](https://raw.githubusercontent.com/pump-fun/pump-public-docs/main/docs/PUMP_PROGRAM_README.md)
- `BondingCurve` offsets (data incl. discriminator) [C] from [pump.json](https://raw.githubusercontent.com/pump-fun/pump-public-docs/main/idl/pump.json): `virtual_token_reserves` 8 (u64), `virtual_quote_reserves` 16, `real_token_reserves` 24, `real_quote_reserves` 32, `token_total_supply` 40, `complete` 48 (bool), `creator` 49, `is_mayhem_mode` 81, `is_cashback_coin` 82, `quote_mint` 83, `creator_fee_bps` 115 (u64), `can_edit_creator_fee` 123, `is_holder_reward` 124, `creator_fee` 125, `protocol_fees` 133, `depth` 141 (u8), `initial_virtual_quote_reserves` 142, `post_complete_base_out` 150, `post_complete_quote_in` 158; total 166. Older accounts are shorter (a trade needs at least 115 bytes) and missing trailing fields read as 0/false/default; `quote_mint` is `Pubkey::default()` for SOL-paired coins [V] — [PUMP_PROGRAM_README](https://raw.githubusercontent.com/pump-fun/pump-public-docs/main/docs/PUMP_PROGRAM_README.md), [buy.md](https://raw.githubusercontent.com/pump-fun/pump-public-docs/main/docs/instructions/BUY.md)
- `Global` account offsets [C]: `fee_basis_points` 105, `enable_migrate` 145, `pool_migration_fee` 146, `creator_fee_basis_points` 154, `buyback_basis_points` 997, `initial_virtual_quote_reserves` 1005, `whitelisted_quote_mints` 1013, `creator_fee_configurable` 1045, `is_holder_reward_enabled` 1086, total 1088; read it for the live initial values instead of hard-coding — [pump.json](https://raw.githubusercontent.com/pump-fun/pump-public-docs/main/idl/pump.json)
- Exact quote math from the official SDK (pump-sdk 4.1.0), all integer: buy cost for `n` tokens `= floor(n*vq/(vt-n)) + 1` (then fees added on top); tokens for a net quote input `= floor(in*vt/(vq+in))`; sell proceeds `= floor(in*vq/(vt+in))` then minus fees; for a gross buy budget the net input is `floor((amount-1)*10000/(totalFeeBps+10000))`; each fee is `ceil(amount*bps/10000)` of the curve amount; the creator fee is skipped when `bonding_curve.creator` is the default pubkey [V] — [pump-sdk source](https://unpkg.com/@pump-fun/pump-sdk@4.1.0/dist/index.js)
- Fee tiers: from "Monday, September 1" (the announcement gives no year; that weekday date is 2025, my inference [I]) the protocol/creator fee depends on market cap in lamports: curve `marketCap = virtualQuoteReserves * mintSupply / virtualTokenReserves` (mintSupply 1B for non-mayhem coins in the SDK), tier chosen from `FeeConfig.fee_tiers` (`market_cap_lamports_threshold` u128, `Fees{lp_fee_bps, protocol_fee_bps, creator_fee_bps}`), flat fee for non-canonical pools; the doc's table (a screenshot from that announcement) lists the bonding curve at 0.95% protocol + 0.30% creator = 1.25% total [V] — [FEE_PROGRAM_README](https://raw.githubusercontent.com/pump-fun/pump-public-docs/main/docs/FEE_PROGRAM_README.md), [fees.png](https://raw.githubusercontent.com/pump-fun/pump-public-docs/main/docs/fees.png). `FeeConfig` account: `flat_fees` at 41, `fee_tiers` vec at 65 [C] — [pump.json](https://raw.githubusercontent.com/pump-fun/pump-public-docs/main/idl/pump.json). A separate `buyback_basis_points` on `Global` and a `buyback_fee` in trades exist [V] — [pump.json](https://raw.githubusercontent.com/pump-fun/pump-public-docs/main/idl/pump.json)
- CONFLICT: README `Global` example shows `fee_basis_points = 100` (1%), which was what the prior note used; the fee program doc and SDK show tier-based fees (1.25% at the curve in the 2025 table), and the README's number is only the fallback when `feeConfig` is null [V] — [PUMP_PROGRAM_README](https://raw.githubusercontent.com/pump-fun/pump-public-docs/main/docs/PUMP_PROGRAM_README.md), [pump-sdk source](https://unpkg.com/@pump-fun/pump-sdk@4.1.0/dist/index.js). Treat the on-chain `FeeConfig` as authoritative.
- Newer features that change reading logic: `quote_mint` (USDC or another pump coin as quote; depth up to 2 per the 13 October announcement), trade v3 instructions with 17 accounts that keep protocol and creator fees on the curve until `sweep_*`, mayhem mode, holder-rewards coins (cashback is deprecated and `create_v2` rejects it) [V] — [pump-public-docs README](https://raw.githubusercontent.com/pump-fun/pump-public-docs/main/README.md)
- Graduation mechanics: after `complete`, every buy or sell fails with `BondingCurveComplete` until migration; v3 buys have "synthetic migration" (the last buy has no max size: it buys the rest at the price the PumpSwap pool will open with, constant product on `pool_base = curve base token balance - remaining`, `pool_quote = real_quote_reserves + curve_quote - pool_migration_fee`); `BondingCurve.post_complete_base_out` / `post_complete_quote_in` record it; events in order `TradeEvent`, `CompleteEvent`, `PostCompleteBuyEvent` [V] — [SYNTHETIC_MIGRATION](https://raw.githubusercontent.com/pump-fun/pump-public-docs/main/docs/SYNTHETIC_MIGRATION.md)
- Migration instruction `migrate_v2` creates the PumpSwap pool with accounts `pool`, `pool_authority` (PDA `["pool-authority", mint]` under the Pump program), `lp_mint`, `user_pool_token_account`, base/quote vaults; events `CompleteEvent`, `CompletePumpAmmMigrationEvent` [V] — [pump.json](https://raw.githubusercontent.com/pump-fun/pump-public-docs/main/idl/pump.json), [PUMP_SWAP_CREATOR_FEE_README](https://raw.githubusercontent.com/pump-fun/pump-public-docs/main/docs/PUMP_SWAP_CREATOR_FEE_README.md)
- `TradeEvent` carries post-trade virtual and real reserves, so reserves can be tracked from the stream without extra RPC (prior note; field list in IDL) — [pump.json](https://raw.githubusercontent.com/pump-fun/pump-public-docs/main/idl/pump.json)
- Admin surface (IDL instruction names): `set_params` (Global authority can update all Global fields, including initial reserves, fee basis points and recipients, affecting new coins), `set_virtual_quote_reserves`, `set_mayhem_virtual_params`, `set_quote_control_mint_reserves`, `admin_cto`, `toggle_create_v2`, `toggle_mayhem_mode`, `update_creator_fee_config`; there is no LP and no creator withdraw of curve liquidity [V names] — [pump.json](https://raw.githubusercontent.com/pump-fun/pump-public-docs/main/idl/pump.json), [PUMP_PROGRAM_README](https://raw.githubusercontent.com/pump-fun/pump-public-docs/main/docs/PUMP_PROGRAM_README.md)

### Inferences
- [C] End state of the original curve: `k = 1.073e15 * 3.0e10`; at `real_token_reserves = 0` virtual tokens = 279.9M, virtual SOL = 115.005, real SOL = 85.005. Pool opens with about 206.9M base and 84.99 SOL (after the 0.015 SOL migration fee); curve end price 4.1088e-7 SOL per whole token vs pool open price 4.1078e-7, so price is continuous apart from the fee.
- [C] Worked example, 1 SOL gross buy on a fresh curve at 1.25% total fee: net 0.98765 SOL buys 34.20M tokens; immediate sell-back returns 0.98765 SOL before the sell fee, so a flat-price round trip costs about 2 x total fee.
- [C] Exit capacity on the curve at a state with 60 real SOL (virtual 90 SOL, virtual tokens 357.67M): selling to move the spot price -10% takes 19.35M tokens and yields 4.62 SOL; -30% takes 69.8M tokens for 14.70 SOL; -50% takes 148.2M for 26.36 SOL (pre-fee). Use `virtual_quote_reserves` in the formula of section 2.
- [I] "Pull" risk on the curve is nil, but exit capacity on a young curve is small relative to a holder dump, and the curve cannot be sold into after `complete` until migration (no-sell window); treat `complete && !migrated` as untradable.
- [I] The creator-fee bps and the protocol-fee bps both vary with market cap on the curve; a bot that hard-codes 1% will under-estimate round-trip cost by tens of bps at low mcap.

### Gaps
- The current on-chain `FeeConfig` tier table was not read (no RPC); the only tier table seen is a 2025 screenshot, and the doc itself says tiers may change.
- `buyback_basis_points` value and whether `buyback_fee` is inside or on top of the quoted total fee were not determined.
- Current `Global.initial_*` values (post mayhem/quote-mint changes) were not read live; README values may be stale.
- Whether `migrate_v2` is now the only migration instruction in use (vs legacy `migrate`) was not checked live.

---

## 4. PumpSwap AMM (`pAMMBay6...`)

### Takeaway
A constant-product AMM. Price and depth must be read from the base vault and the effective quote reserve (`quote_vault.amount + Pool.virtual_quote_reserves`, a signed i128 that goes negative when fees are parked in the vault, and positive for boosted pools). Canonical migrated pools have a fixed derivation (index 0, creator = pool-authority PDA) and burned LP; anyone can still create non-canonical pools for the same mint.

### Cited Findings
- `Pool` offsets [C] from [pump_amm.json](https://raw.githubusercontent.com/pump-fun/pump-public-docs/main/idl/pump_amm.json): `pool_bump` 8, `index` 9 (u16), `creator` 11, `base_mint` 43, `quote_mint` 75, `lp_mint` 107, `pool_base_token_account` 139, `pool_quote_token_account` 171, `lp_supply` 203 (u64), `coin_creator` 211, `is_mayhem_mode` 243, `is_cashback_coin` 244, `virtual_quote_reserves` 245 (i128), `creator_fee_bps` 261 (u64), `can_edit_creator_fee` 269, `is_holder_reward` 270, `protocol_fees` 271, `creator_fees` 279; total 287 bytes of fields (docs say pools were extended to 300 bytes; older accounts are shorter and trailing fields read as 0). `GlobalConfig`: `lp_fee_basis_points` 40, `protocol_fee_basis_points` 48, `disable_flags` 56, `coin_creator_fee_basis_points` 313, `boost_enabled` 939.
- Pricing: constant product on base reserve = raw `pool_base_token_account.amount` and `effective_quote_reserves = pool_quote_token_account.amount + virtual_quote_reserves` (signed add), for both buy and sell; the program guarantees the sum is non-negative and fits u64 [V] — [PUMP_SWAP_README](https://raw.githubusercontent.com/pump-fun/pump-public-docs/main/docs/PUMP_SWAP_README.md), [NEGATIVE_VIRTUAL_QUOTE_RESERVES](https://raw.githubusercontent.com/pump-fun/pump-public-docs/main/docs/NEGATIVE_VIRTUAL_QUOTE_RESERVES.md)
- Why it goes negative: v2 trades keep protocol and creator fees in the quote vault and subtract them from `virtual_quote_reserves`, so `vault = real_quote + protocol_fees + creator_fees` and `virtual = boost_reserves - protocol_fees - creator_fees`; effective = `real_quote + boost_reserves`; sweeps pay fees out and add them back [V] — [VIRTUAL_QUOTE_RESERVES_FEE_ADJUSTMENT](https://raw.githubusercontent.com/pump-fun/pump-public-docs/main/docs/VIRTUAL_QUOTE_RESERVES_FEE_ADJUSTMENT.md). A pool is boosted when `virtual_quote_reserves + protocol_fees + creator_fees != 0`; trade events carry `can_boost` [V] — same doc.
- Exact quote math (pump-swap-sdk 2.1.0): buy base `n`: `quoteIn = ceil(Qeff*n/(B-n))`, user pays `quoteIn + ceil(quoteIn*lp) + ceil(quoteIn*protocol) + ceil(quoteIn*creator)` (creator fee 0 if `coin_creator` is default); sell base `n`: `out = floor(Qeff*n/(B+n))`, `userOut = out - ceil(out*lp) - ceil(out*creator) - ceil(out*protocol)`; the SDK throws if `(vault - feeBuckets) < out - lpFee` (real quote cannot cover) [V] — [pump-swap-sdk source](https://unpkg.com/@pump-fun/pump-swap-sdk@2.1.0/dist/index.js)
- Fees: `GlobalConfig` flat `lp 20 bps`, `protocol 5 bps` (no fee on deposit/withdraw); with a fee program the canonical pools use market-cap tiers (`poolMarketCap = quoteReserve * baseMintSupply / baseReserve`), non-canonical pools pay `FeeConfig.flat_fees`; the 2025 table shows 0-420 SOL mcap: LP 2 bps + protocol 93 bps + creator 30 bps = 1.25%; 420-1,470 SOL: 20+5+95 = 1.20%; stepping the creator fee down 5 bps per band (2.5 bps per band from about the 10-11M USD bands) to the top band (98,240 SOL+, 20M+ USD): LP 20 + protocol 5 + creator 5 = 0.30% [V] — [FEE_PROGRAM_README](https://raw.githubusercontent.com/pump-fun/pump-public-docs/main/docs/FEE_PROGRAM_README.md), [fees.png](https://raw.githubusercontent.com/pump-fun/pump-public-docs/main/docs/fees.png), [pump-swap-sdk source](https://unpkg.com/@pump-fun/pump-swap-sdk@2.1.0/dist/index.js)
- Canonical pool: `pool.creator == pump_pool_authority_pda(base_mint)`, seeds `["pool-authority", base_mint]` under the Pump program; canonical pool PDA is `poolPda(index=0, poolAuthority, mint, canonicalPoolQuoteMint)` with `canonicalPoolQuoteMint = WSOL` when the curve `quote_mint` is default [V] — [PumpSwap creator-fee doc](https://raw.githubusercontent.com/pump-fun/pump-public-docs/main/docs/PUMP_SWAP_CREATOR_FEE_README.md), [pump-swap-sdk source](https://unpkg.com/@pump-fun/pump-swap-sdk@2.1.0/dist/index.js)
- LP control: `create_pool` gives the creator LP tokens; `withdraw` burns the caller's own LP; `lp_supply` is "the total supply of the `lp_mint` without burns and lock-ups" (a direct burn by a user does not lower it); no pool-level admin can withdraw funds; admin can disable operations globally via `disable_flags` ("currently not used"), update fee config/recipients and the admin key [V] — [PUMP_SWAP_README](https://raw.githubusercontent.com/pump-fun/pump-public-docs/main/docs/PUMP_SWAP_README.md). Migrated pools: LP burned (Pump README, above).
- BOOST (IDL: `init_boost`, `boost_buy_and_burn`, `toggle_boost`; events `InitBoostEvent`, `BoostBuyAndBurnEvent` with `boost_vault_remaining`): The Block (2026-07-29) says roughly 20% of migration liquidity, previously locked permanently ("dead liquidity"), now funds automatic market buys in the first five minutes after migration and every token bought is burned; the 20% figure and the mechanism are the author's description, not a quoted pump.fun statement [V IDL names; T mechanism] — [pump_amm.json](https://raw.githubusercontent.com/pump-fun/pump-public-docs/main/idl/pump_amm.json), [The Block](https://theblock.co/post/409815/pump-fun-token-graduation-rate-jumps-boost-changes-launch-incentives)
- Events: `CreatePoolEvent` (pool, creator, base/quote mint, `pool_base_amount`, `pool_quote_amount`, `lp_token_amount_out`, `coin_creator`, `is_mayhem_mode`, `is_holder_reward`), `BuyEvent`/`SellEvent` (pool reserves, fee fields, `virtual_quote_reserves`, `can_boost`, `base_supply`, `creator_fee_unclaimed`), `DepositEvent`, `WithdrawEvent` (LP add/remove), `SweepPoolFeeEvent`, `DisableEvent`, `UpdateFeeConfigEvent` [V] — [pump_amm.json](https://raw.githubusercontent.com/pump-fun/pump-public-docs/main/idl/pump_amm.json)
- Live [L]: Jupiter quote 1 SOL to CATTLEAXE (`H7VZNC...pump`) returned one leg labelled "Pump.fun Amm" with `ammKey 3p3uYa9AYzV7w2nHEJeo8ANkuuwhYUonQvhHS8LyrqJY`, equal to the pool address GeckoTerminal lists — [Jupiter quote](https://lite-api.jup.ag/swap/v1/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=H7VZNCBynDK5ikBS9krDJ2Tx8CUr1wxedV19ZgkWpump&amount=1000000000&slippageBps=100), [GeckoTerminal pumpswap pools](https://api.geckoterminal.com/api/v2/networks/solana/dexes/pumpswap/pools?page=1)

### Inferences
- [I] To read a pool cheaply: `getMultipleAccounts([pool, base_vault, quote_vault])` (pool pubkeys for the two vaults are stored in the pool), decode `virtual_quote_reserves` as i128, compute `Qeff`; `real_extractable = quote_vault.amount - protocol_fees - creator_fees`.
- [I] Exit capacity: use the section 2 formula with `Q = Qeff`, then cap the proceeds at `real_extractable`. For a boosted pool `Qeff > real` so the price (and quotes) are higher than what the vault can ever pay out; do not size positions off `Qeff` alone.
- [I] LP-burn verification for a canonical pool: `1 - lp_mint.supply / pool.lp_supply` approximates the burned share (because the program's `lp_supply` ignores burns); confirm `pool.creator == pool-authority PDA` and `pool.index == 0`. The semantic is inferred from the documented definition of `lp_supply`; it was not tested on a live pool.
- [I] Fee drag round trip at 0.30% total (large pool) is about 0.6%; at the 1.25% low-mcap tier about 2.5%, so for fresh migrations (typically in the low tiers) fee drag is a real part of the expected cost of copying.
- [I] Non-canonical PumpSwap pools (any creator, any index, flat fees) are ordinary LP pools: the creator holds LP and `withdraw` can drain them; only canonical pools inherit the burn.

### Gaps
- Current live `FeeConfig` tiers and `flat_fees` were not read; the table is from the 2025 announcement.
- Exact boost parameters (share, window, who may call `boost_buy_and_burn`) are not documented in the files I fetched (`BOOST_README` returned 404).
- The `pool-v2` PDA (`["pool-v2", base_mint]`) appears as a remaining account when `coin_creator` is set; its purpose is not documented in the files read.

---

## 5. Raydium AMM v4 (`675kPX9M...`, OpenBook)

### Takeaway
A legacy constant-product pool with a fixed 0.25% fee on input; in current source the swap prices off vault balances minus the owed protocol PnL with no OpenBook order balances in the formula. LP is a plain SPL token; Raydium has no lock program for AMM v4, so "locked" means burned or held by a locker you must identify.

### Cited Findings
- `AmmInfo` layout (752 bytes), [C] from struct order in [state.rs](https://raw.githubusercontent.com/raydium-io/raydium-amm/master/program/src/state.rs): `status` 0 (u64), `nonce` 8, `order_num` 16, `depth` 24, `coin_decimals` 32, `pc_decimals` 40, `state` 48, `reset_flag` 56, `min_size` 64, `vol_max_cut_ratio` 72, `amount_wave` 80, `coin_lot_size` 88, `pc_lot_size` 96, `min_price_multiplier` 104, `max_price_multiplier` 112, `sys_decimal_value` 120, `fees` 128 (8 x u64: min_separate num/den, trade_fee num/den, pnl num/den, swap_fee num/den), `state_data` 192 (144 bytes, including `need_take_pnl_coin` 192 and `need_take_pnl_pc` 200 and `pool_open_time` 224), `coin_vault` 336, `pc_vault` 368, `coin_vault_mint` 400, `pc_vault_mint` 432, `lp_mint` 464, `open_orders` 496, `market` 528, `market_program` 560, `target_orders` 592, padding 624, `amm_owner` 688, `lp_amount` 720, `client_order_id` 728, `recent_epoch` 736. "coin" is the base token, "pc" is the quote.
- Status values: 0 uninitialized, 1 initialized, 2 disabled, 3 withdraw-only, 4 liquidity-only, 5 orderbook-only, 6 swap-only, 7 waiting-trade (becomes swap-only after `pool_open_time`) [V] — [state.rs](https://raw.githubusercontent.com/raydium-io/raydium-amm/master/program/src/state.rs), [processor.rs](https://raw.githubusercontent.com/raydium-io/raydium-amm/master/program/src/processor.rs)
- Default fees: `trade_fee 25/10000`, `swap_fee 25/10000`, `pnl 12/100`, `min_separate 5/10000` [V] — [state.rs](https://raw.githubusercontent.com/raydium-io/raydium-amm/master/program/src/state.rs)
- Swap math in `process_swap_base_in`: `total_pc = pc_vault.amount - need_take_pnl_pc`, `total_coin = coin_vault.amount - need_take_pnl_coin` (function `calc_total_without_take_pnl_no_orderbook`); `swap_fee = ceil(amount_in*swap_fee_num/swap_fee_den)`; `in_after_fee = amount_in - swap_fee`; coin to pc: `out = floor(total_pc*in_after_fee/(total_coin+in_after_fee))`, pc to coin symmetric [V] — [processor.rs](https://raw.githubusercontent.com/raydium-io/raydium-amm/master/program/src/processor.rs), [math.rs](https://raw.githubusercontent.com/raydium-io/raydium-amm/master/program/src/math.rs)
- Instruction tags (instruction data first byte): `Initialize2` 1, `SwapBaseIn` 9, `SwapBaseOut` 11, `SwapBaseInV2` 16 [V] — [instruction.rs](https://raw.githubusercontent.com/raydium-io/raydium-amm/master/program/src/instruction.rs)
- Admin: `set_params` (status, state, fees, open time) and the config-account instructions require the signer to equal a hard-coded `config_feature::amm_owner`/admin key (Raydium, not the pool creator); `WithdrawPnl` also has an owner check against that key [V, partly read] — [processor.rs](https://raw.githubusercontent.com/raydium-io/raydium-amm/master/program/src/processor.rs)
- LP: `lp_mint` is an SPL token; `lp_amount` (offset 720) is the program-tracked LP amount; Burn & Earn is documented for CPMM and CLMM only, not AMM v4 [V/T] — [Raydium Burn & Earn docs via search](https://docs.raydium.io/raydium/burn-and-earn)
- Pool derivation: from OpenBook market id, not from mints (section 1) [V].
- LaunchLab's `migrate_to_amm` instruction still lists OpenBook market accounts in the published IDL, while the Raydium docs say `MigrateToAmm` "lost its arguments and all OpenBook accounts in the 2026-09 upgrade" (docs.raydium.io LaunchLab overview); the two sources disagree, the IDL repo was last pushed 2026-05-18, so it is probably stale [V/T] — [raydium_launchpad.json](https://raw.githubusercontent.com/raydium-io/raydium-idl/master/raydium_launchpad/raydium_launchpad.json), [LaunchLab overview](https://docs.raydium.io/products/launchlab/overview.md)

### Inferences
- [I] Depth: read `coin_vault`, `pc_vault` token balances plus `need_take_pnl_*` from `AmmInfo` (three accounts in one `getMultipleAccounts`); apply section 2 with `Q = pc_vault - need_take_pnl_pc`, fee 25 bps on the input leg. Exit proceeds `= floor(Q*in_net/(B+in_net))`; the LP-side fee stays in the vaults, the 12% PnL share accrues in `need_take_pnl_*` and is excluded.
- [I] Burned-LP check: `1 - lp_mint.supply / AmmInfo.lp_amount` (burn lowers mint supply but not the program counter); plus confirm the largest LP holders are the incinerator/`11111...` or a known locker. Not verified on a live pool.
- [I] Drain = creator (or whoever holds LP) calls `withdraw` (instruction 4) on unburned LP; nothing else can pull funds. The admin-gated status switch can disable swaps (a Raydium-only control).

### Gaps
- Whether open-orders balances can still contribute reserves for old pools (the legacy `process_swap_base_in_v2` path was not compared) was not checked.
- The AMM v4 authority PDA address and the pool creation fee were not read.
- Whether any third-party lock program is common for AMM v4 LP was not researched.

---

## 6. Raydium CPMM (`CPMMoo8L...`)

### Takeaway
A clean constant-product pool: reserves are the two vault balances minus accrued protocol, fund and creator fees; `lp_supply` is a program counter that ignores burns; locking goes through Raydium's lock program (Fee Key NFT) and burns happen by SPL burn. Only the hard-coded admin can disable swaps.

### Cited Findings
- `PoolState` (637 bytes) [C] from [pool.rs](https://raw.githubusercontent.com/raydium-io/raydium-cp-swap/master/programs/cp-swap/src/states/pool.rs): `amm_config` 8, `pool_creator` 40, `token_0_vault` 72, `token_1_vault` 104, `lp_mint` 136, `token_0_mint` 168, `token_1_mint` 200, `token_0_program` 232, `token_1_program` 264, `observation_key` 296, `auth_bump` 328, `status` 329 (bit0 disable deposit, bit1 disable withdraw, bit2 disable swap), `lp_mint_decimals` 330, `mint_0_decimals` 331, `mint_1_decimals` 332, `lp_supply` 333, `protocol_fees_token_0` 341, `protocol_fees_token_1` 349, `fund_fees_token_0` 357, `fund_fees_token_1` 365, `open_time` 373, `recent_epoch` 381, `creator_fee_on` 389 (0 both tokens, 1 token0 only, 2 token1 only), `enable_creator_fee` 390, `creator_fees_token_0` 397, `creator_fees_token_1` 405.
- Reserves: `vault_amount_without_fee = vault - (protocol_fees + fund_fees + creator_fees)` per token; token_0 mint address is always less than token_1 [V] — [pool.rs](https://raw.githubusercontent.com/raydium-io/raydium-cp-swap/master/programs/cp-swap/src/states/pool.rs)
- `lp_supply` comment: "True circulating supply without burns and lock ups" [V] — [pool.rs](https://raw.githubusercontent.com/raydium-io/raydium-cp-swap/master/programs/cp-swap/src/states/pool.rs)
- Fees (`AmmConfig`, rates denominated in 1e-6): `trade_fee_rate`, `protocol_fee_rate`, `fund_fee_rate` (the last two are shares of the trade fee), `creator_fee_rate` (extra, on top of the trade fee), `creator_fee_share_rate`, `create_pool_fee`; trading fee `= ceil(amount*rate/1e6)` [V] — [config.rs](https://raw.githubusercontent.com/raydium-io/raydium-cp-swap/master/programs/cp-swap/src/states/config.rs), [fees.rs](https://raw.githubusercontent.com/raydium-io/raydium-cp-swap/master/programs/cp-swap/src/curve/fees.rs)
- `swap_base_input`: if the creator fee is on input, `total_fee = ceil(in*(trade+creator)/1e6)`, `in_less = in - total_fee`; otherwise `trade_fee = ceil(in*trade/1e6)`, `in_less = in - trade_fee` and `creator_fee = ceil(out_swapped*creator_rate/1e6)` is taken from the output; `out = floor(out_vault*in_less/(in_vault+in_less))`; the LP's share of the trade fee stays in the pool (`new_input_vault = in_vault + in_less`) [V] — [calculator.rs](https://raw.githubusercontent.com/raydium-io/raydium-cp-swap/master/programs/cp-swap/src/curve/calculator.rs)
- Pool derivation `["pool", ammConfig, mintA, mintB]` (section 1); several `AmmConfig` indexes exist, so several pools per pair are possible [V/I].
- Admin: `update_pool_status` and config updates are gated to `crate::admin::ID` (Raydium), not the pool creator; the instruction list has no creator-level pause or fee change; `collect_creator_fee` (and a permissionless variant) pays creator fees [V] — [update_pool_status.rs](https://raw.githubusercontent.com/raydium-io/raydium-cp-swap/master/programs/cp-swap/src/instructions/admin/update_pool_status.rs), [lib.rs](https://raw.githubusercontent.com/raydium-io/raydium-cp-swap/master/programs/cp-swap/src/lib.rs)
- LP locking: `lockCpLiquidity` instruction on the lock program (`LockrWmn6K...`), lock record PDA seeds `["locked_liquidity", nft_mint]`, LP held in `lock_lp_vault` = ATA of the LP mint owned by the lock authority PDA `3f7GcQFG...`; the position is represented by a Fee Key NFT; harvesting fees burns a part of the locked LP so the locked balance shrinks over time [V/T] — [cpmm.ts SDK](https://raw.githubusercontent.com/raydium-io/raydium-sdk-V2/master/src/raydium/cpmm/cpmm.ts), [cpmm pda.ts](https://raw.githubusercontent.com/raydium-io/raydium-sdk-V2/master/src/raydium/cpmm/pda.ts), [Raydium Burn & Earn search summary](https://docs.raydium.io/raydium/burn-and-earn)
- Creation events: `initialize` (and `initialize_with_permission`), `deposit`, `withdraw`, `swap_base_input/output`, `collect_*` instruction names [V] — [lib.rs](https://raw.githubusercontent.com/raydium-io/raydium-cp-swap/master/programs/cp-swap/src/lib.rs)

### Inferences
- [I] Cheap read: `getMultipleAccounts([pool, vault0, vault1])` then `vault_i - fees_i`; exit capacity per section 2 with `Q` the quote side's `vault_amount_without_fee`.
- [I] LP burned/locked share = `1 - lp_mint.supply/pool.lp_supply` (burned) plus `balance(lock_lp_vault)/pool.lp_supply` (locked via Raydium lock); the rest is withdrawable by its holders (creator, locker NFT holder not applicable). Not verified on a live pool.
- [I] Drain path: the creator or any holder of unlocked LP calls `withdraw`; locked positions can only harvest fees (burning small LP slices); admin can only disable swaps/deposits via status.

### Gaps
- The lock program's account layout (`LockedCpLiquidityState`) was not read; the lock PDA seeds above come from SDK code and the verification procedure is inferred.
- Fee tiers by `AmmConfig` index (0.25%, 0.3%, 1% etc.) were not read live; LaunchLab docs mention `AmmConfig[0]` as the 0.25% tier [T].
- The creator-fee share and mode defaults for launch tokens were not read.

---

## 7. Raydium CLMM (`CAMMCzo5...`)

### Takeaway
Standard tick-based concentrated liquidity (Q64.64 sqrt price, tick arrays, position NFTs). In-range depth is `L*√P` quote-virtual, but real depth is the sum over initialized tick liquidity below the price; LP control is by position NFT, and lock is through the Raydium lock program. The program now also has limit orders and a dynamic-fee option, which this note did not model.

### Cited Findings
- `PoolState` (1544 bytes) offsets [C] from [pool.rs](https://raw.githubusercontent.com/raydium-io/raydium-clmm/master/programs/amm/src/states/pool.rs): `bump` 8, `amm_config` 9, `owner` 41, `token_mint_0` 73, `token_mint_1` 105, `token_vault_0` 137, `token_vault_1` 169, `observation_key` 201, `mint_decimals_0` 233, `mint_decimals_1` 234, `tick_spacing` 235 (u16), `liquidity` 237 (u128), `sqrt_price_x64` 253 (u128), `tick_current` 269 (i32), `fee_growth_global_0_x64` 277, `fee_growth_global_1_x64` 293, `protocol_fees_token_0` 309, `protocol_fees_token_1` 317, `status` 389 (bit0 disable open/increase, bit1 disable decrease liquidity, bit2 collect fee, bit3 collect reward, bit4 disable swap, bit5 limit order), `fee_on` 390 (0 from input, 1 token0 only, 2 token1 only), `seed_index` 391, `reward_infos` 397 (3 x 169 bytes), `tick_array_bitmap` 904 (16 x u64), `fund_fees_token_0` 1064, `fund_fees_token_1` 1072, `open_time` 1080, `recent_epoch` 1088, `dynamic_fee_info` 1096 (80 bytes). Price (token1 per token0) `= (sqrt_price_x64/2^64)^2 * 10^(dec0-dec1)`.
- `AmmConfig`: `protocol_fee_rate` u32, `trade_fee_rate` u32 (1e-6 units), `tick_spacing` u16, `fund_fee_rate` u32 [V] — [config.rs](https://raw.githubusercontent.com/raydium-io/raydium-clmm/master/programs/amm/src/states/config.rs)
- Swap step math has a flag `is_fee_on_input` and supports exact-in and exact-out (`compute_swap` with `is_base_input`, `is_fee_on_input`) [V] — [swap_math.rs](https://raw.githubusercontent.com/raydium-io/raydium-clmm/master/programs/amm/src/libraries/swap_math.rs)
- Instruction set: `create_pool`, `create_customizable_pool`, `create_permissioned_pool`, `open_position(_v2, _with_token22_nft)`, `increase/decrease_liquidity(_v2)`, `swap(_v2)`, `swap_router_base_in`, `update_pool_status` (admin only), plus `open/increase/decrease/settle/close_limit_order`, `create_dynamic_fee_config` [V] — [lib.rs](https://raw.githubusercontent.com/raydium-io/raydium-clmm/master/programs/amm/src/lib.rs); `update_pool_status` requires `crate::admin::ID` [V] — [update_pool_status.rs](https://raw.githubusercontent.com/raydium-io/raydium-clmm/master/programs/amm/src/instructions/admin/update_pool_status.rs)
- Position lock: `LockClPositionLayoutV2` = `{bump, lockOwner, poolId, positionId, nftAccount, lockNftMint, recentEpoch}`; lock program `LockrWmn6K...`, lock authority PDA `kN1kEznaF5...` (the position NFT moves to the lock authority). Docs (via search) say Burn & Earn locks the liquidity permanently while fees can still be claimed by the Fee Key holder, and that only full-range positions are recommended because a locked position cannot be rebalanced [V/T] — [sdk clmm layout.ts](https://raw.githubusercontent.com/raydium-io/raydium-sdk-V2/master/src/raydium/clmm/layout.ts), [Raydium Burn & Earn](https://docs.raydium.io/raydium/burn-and-earn)
- Live [L]: a 1,000 USDC quote for BIRB returned label "Raydium CLMM" with `ammKey GUWFT7bbLphGrcpAPnnEnBbe1uErv9e6LLC2qPx2wZy1` equal to the GeckoTerminal pool id — [Jupiter quote](https://lite-api.jup.ag/swap/v1/quote?inputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&outputMint=G7vQWurMkMMm2dU3iZpXYFTHT9Biio4F4gZCrwFpKNwG&amount=1000000000&slippageBps=100)

### Inferences
- [I] Depth: decode `PoolState` (liquidity, sqrt_price, tick_current, tick_spacing), then fetch the tick arrays below the current price (tick-array PDAs from `tick_array_bitmap`), walk initialized ticks applying `-liquidity_net` when moving down, convert each step with the formulas in section 2, apply `trade_fee_rate` on the input. Tick-array size and PDA derivation for Raydium CLMM were not read (see Gaps), so use the SDK's tick-array helpers.
- [I] Single-sided drain pattern: a CLMM position above the current price holds only the memecoin; buyers paying quote into it let the owner later `decrease_liquidity` and take the quote. That is not a rug-by-removal event: liquidity "present" at the active price can be zero while `liquidity` (active L) looks fine. Conversely a creator can park quote-only liquidity below price and pull it at any time, which shows up as a drop in `PoolState.liquidity` and in vault balances. This is inference from CL mechanics, not a sourced incident.
- [I] A single `getAccountInfo(pool)` over-states depth if you read vault balances (they include out-of-range and uncollected-fee amounts); always compute from L and ticks.

### Gaps
- Tick array size/PDA seeds and `TickState` layout were not read (SDK or source file not fetched); the limit-order feature and dynamic fee (`dynamic_fee_info`) behaviour were not analysed, so the CL walk above may over-state depth when limit orders are present.
- The `LockedClPositionState` account fields on the lock program side were not read beyond the SDK layout.
- Whether new Raydium launches still create CLMM pools (LaunchLab is CPMM-only per the docs) was not measured.

---

## 8. Raydium LaunchLab (`LanMV9sAd7...`)

### Takeaway
A launchpad with three selectable curves (constant product, fixed price, linear price) on virtual+real reserves; graduation happens when the quote vault reaches the configured raise and then liquidity migrates to a CPMM pool (CPMM-only for new launches per the docs) with LP split between burn and a lock (Fee Key). Read `PoolState` for reserves and `PlatformConfig` for fees and burn/lock scales.

### Cited Findings
- `PoolState` from the IDL [C] (offsets with discriminator): `epoch` 8, `auth_bump` 16, `status` 17, `base_decimals` 18, `quote_decimals` 19, `migrate_type` 20, `supply` 21, `total_base_sell` 29, `virtual_base` 37, `virtual_quote` 45, `real_base` 53, `real_quote` 61, `total_quote_fund_raising` 69, `quote_protocol_fee` 77, `platform_fee` 85, `migrate_fee` 93, `vesting_schedule` 101 (5 x u64), `global_config` 141, `platform_config` 173, `base_mint` 205, `quote_mint` 237, `base_vault` 269, `quote_vault` 301, `creator` 333, `token_program_flag` 365, `amm_creator_fee_on` 366 — [raydium_launchpad.json](https://raw.githubusercontent.com/raydium-io/raydium-idl/master/raydium_launchpad/raydium_launchpad.json), [SDK layout.ts](https://raw.githubusercontent.com/raydium-io/raydium-sdk-V2/master/src/raydium/launchpad/layout.ts)
- Curve types: 0 constant product, 1 fixed price, 2 linear [V] — [curve.ts](https://raw.githubusercontent.com/raydium-io/raydium-sdk-V2/master/src/raydium/launchpad/curve/curve.ts)
  - Constant product: reserves `A_in = virtual_base - real_base`, `B_in = virtual_quote + real_quote`; buy `out = floor(in*A_out_reserve/(B_in+in))`, i.e. `tokens = in*(virtualA - realA)/(virtualB + realB + in)`; price `= (virtualB + realB)/(virtualA - realA)` [V] — [constantProductCurve.ts](https://raw.githubusercontent.com/raydium-io/raydium-sdk-V2/master/src/raydium/launchpad/curve/constantProductCurve.ts)
  - Fixed price: `out = in * virtualA / virtualB` (price `virtualB/virtualA`) [V] — [fixedPriceCurve.ts](https://raw.githubusercontent.com/raydium-io/raydium-sdk-V2/master/src/raydium/launchpad/curve/fixedPriceCurve.ts)
  - Linear: quote cost `realB = virtualA*realA^2/(2*2^64)`; buy out `= floor(sqrt(2*(realB+in)*2^64/virtualA)) - realA`; price `= virtualA*realA/2^64` [V] — [linearPriceCurve.ts](https://raw.githubusercontent.com/raydium-io/raydium-sdk-V2/master/src/raydium/launchpad/curve/linearPriceCurve.ts)
- Fees (rates over 1,000,000, total must be <= 1,000,000): protocol `tradeFeeRate` (global config), platform `feeRate`, creator `creatorFeeRate` (both on `PlatformConfig`), referral `shareFeeRate` (per transaction); fee `= ceil(amount*rate/1e6)`, pre-fee gross-up `ceil(post*1e6/(1e6-rate))`; no numeric defaults found [V] — [curve.ts](https://raw.githubusercontent.com/raydium-io/raydium-sdk-V2/master/src/raydium/launchpad/curve/curve.ts), [fee reference](https://docs.raydium.io/products/launchlab/tips-and-gotchas/launchlab-cpmm-fee-reference.md)
- `PlatformConfig` includes `platformScale`, `creatorScale`, `burnScale` (must sum to 1,000,000), `platformClaimFeeWallet`, `platformLockNftWallet`, `cpConfigId`, `creatorFeeRate` [V] — [SDK layout.ts](https://raw.githubusercontent.com/raydium-io/raydium-sdk-V2/master/src/raydium/launchpad/layout.ts). Docs: platform+creator scales are locked via LP-Lock (one Fee Key to the platform wallet after the 2026-08-17 upgrade), `burnScale` is burned permanently; graduation trigger `quote_vault.balance >= graduation_threshold`; `MigrateToCpswap` is signed by the migration wallet from `GlobalConfig`; new launches are CPMM-only (a Solana Compass article gives the CPMM-only mandate with an August 17 date) [T] — [LaunchLab overview](https://docs.raydium.io/products/launchlab/overview.md), [fee reference](https://docs.raydium.io/products/launchlab/tips-and-gotchas/launchlab-cpmm-fee-reference.md), [Solana Compass](https://solanacompass.com/news/raydium-launchlab-mandates-cpmm-only-graduation-and-locks-creator-lp-at-token-migration)
- Instructions: `initialize`, `initialize_v2`, `initialize_with_token_2022`, `buy_exact_in/out`, `sell_exact_in/out`, `migrate_to_cpswap` (accounts include `lock_program`, `lock_authority`, `lock_lp_vault`, `cpswap_pool`), `migrate_to_amm`; events `PoolCreateEvent`, `TradeEvent`; `PoolState.status` values were not read [V] — [IDL](https://raw.githubusercontent.com/raydium-io/raydium-idl/master/raydium_launchpad/raydium_launchpad.json)

### Inferences
- [I] Depth/exit: for the constant-product curve, `Q = virtual_quote + real_quote` and `B = virtual_base - real_base`; selling `T` base returns `Q*T/(B+T)` before fees; real quote available is `real_quote` so cap proceeds at `real_quote` (virtual quote cannot be paid out). Fixed and linear curves need their own functions above.
- [I] Graduated-token LP check: after migration the CPMM pool's `lock_lp_vault` balance and the burned share (section 6) give lock/burn percentages; `burnScale` and the scales on the platform config tell the intended split before migration.
- [I] Platform vs creator control: the lock destination (`platformLockNftWallet`) and `creatorFeeRate` let the platform skim fees; liquidity itself is not withdrawable if locked.

### Gaps
- `PoolState.status` encoding and exact `PoolState` size/dataSize were not confirmed.
- No default fee rates, no graduation threshold distributions, and no measured burn/lock splits were found.
- The conflict between the IDL (OpenBook accounts in `migrate_to_amm`) and the docs (accounts removed in 2026-09) is unresolved; the SDK/docs date claims are from vendor pages, not changelogs.

---

## 9. Orca Whirlpools (`whirLbMii...`)

### Takeaway
Uniswap-v3-style concentrated liquidity with Q64.64 sqrt price and 88-tick arrays; fee is charged on the input. LP ownership is a position NFT (optionally Token-2022 and lockable); lock is enforced by freezing the position token and creating a `LockConfig` PDA.

### Cited Findings
- `Whirlpool` (653 bytes, `8 + 261 + 384`) [C] from [whirlpool.rs](https://raw.githubusercontent.com/orca-so/whirlpools/main/programs/whirlpool/src/state/whirlpool.rs): `whirlpools_config` 8, `whirlpool_bump` 40, `tick_spacing` 41 (u16), `fee_tier_index_seed` 43, `fee_rate` 45 (u16, hundredths of a bp; u16::MAX is about 6.5%), `protocol_fee_rate` 47 (bps of the fee), `liquidity` 49 (u128), `sqrt_price` 65 (u128, Q64.64), `tick_current_index` 81 (i32), `protocol_fee_owed_a` 85, `protocol_fee_owed_b` 93, `token_mint_a` 101, `token_vault_a` 133, `fee_growth_global_a` 165, `token_mint_b` 181, `token_vault_b` 213, `fee_growth_global_b` 245, `reward_last_updated_timestamp` 261, `reward_infos` 269 (3 x 128).
- Price (B per A) `= (sqrt_price/2^64)^2 * 10^(dec_a - dec_b)`; tick range ±443,636; `TICK_ARRAY_SIZE = 88`; tick array PDA seeds `["tick_array", whirlpool, start_tick_index.to_string()]` (decimal string); a `Tick` is 113 bytes (`initialized`, `liquidity_net` i128, `liquidity_gross` u128, fee growth outside a/b, 3 reward growths); fixed tick array account 9,988 bytes (8 + 4 + 88*113 + 32) [C]; dynamic (variable size) tick arrays also exist now [V] — [tick.rs](https://raw.githubusercontent.com/orca-so/whirlpools/main/programs/whirlpool/src/state/tick.rs), [initialize_tick_array.rs](https://raw.githubusercontent.com/orca-so/whirlpools/main/programs/whirlpool/src/instructions/initialize_tick_array.rs)
- Swap step: fee on input; `amount_calc = amount_remaining*(1e6 - fee_rate)/1e6`; next price from `get_next_sqrt_price`; crossing ticks adjusts L by `∓liquidity_net` [V] — [swap_math.rs](https://raw.githubusercontent.com/orca-so/whirlpools/main/programs/whirlpool/src/math/swap_math.rs), [swap_manager.rs](https://raw.githubusercontent.com/orca-so/whirlpools/main/programs/whirlpool/src/manager/swap_manager.rs)
- `Position`: `whirlpool`, `position_mint`, `liquidity` u128, `tick_lower_index`, `tick_upper_index`, fee checkpoints/owed, rewards (LEN 8+136+72) [V] — [position.rs](https://raw.githubusercontent.com/orca-so/whirlpools/main/programs/whirlpool/src/state/position.rs)
- Lock: `lock_position` requires a non-empty position, a Token-2022 position mint, freezes the user's position token account, and creates a `LockConfig` PDA `["lock_config", position]`; `transfer_locked_position` exists; locked positions are rejected where zero-liquidity is required, so withdrawal is blocked while locked [V] — [lock_position.rs](https://raw.githubusercontent.com/orca-so/whirlpools/main/programs/whirlpool/src/instructions/lock_position.rs), [position.rs](https://raw.githubusercontent.com/orca-so/whirlpools/main/programs/whirlpool/src/state/position.rs)
- Admin: instruction names `set_fee_rate`, `set_protocol_fee_rate`, `set_default_fee_rate`, `set_fee_authority`, `set_collect_protocol_fees_authority`, `set_config_feature_flag`, and an `adaptive_fee` instruction directory (adaptive fee tiers with an oracle account) [V names] — [instructions listing](https://github.com/orca-so/whirlpools/tree/main/programs/whirlpool/src/instructions)
- Live [L]: DexScreener/GeckoTerminal show Orca pools for PUMP/SOL (`BofA2ViU...`, about $2.3M) as part of the top Orca pools — [GeckoTerminal orca pools](https://api.geckoterminal.com/api/v2/networks/solana/dexes/orca/pools?page=1)

### Inferences
- [I] Depth: read `Whirlpool`, the 2-3 tick arrays below `tick_current_index` (PDA seeds above), use the walk in section 2 with fee on input. Prefer the official `@orca-so/whirlpools-core` decoders over hand parsing because tick arrays have fixed and dynamic variants.
- [I] LP verification: a position is "locked" when its position NFT is Token-2022, the token account is frozen and a `LockConfig` exists for it; unlocked positions let the NFT holder `decrease_liquidity` at will. Sum over all positions (`getProgramAccounts` on `Position` by `whirlpool` at offset 8) to compute the locked share of in-range L; there is no pool-level counter.
- [I] Fee authorities can change `fee_rate` per pool, so a thin-fee pool can have its fee raised by the config authority (Orca), not by the pool creator.

### Gaps
- The Orca `WhirlpoolsConfig` mainnet address, `FeeTier` accounts and adaptive-fee oracle layout were not read.
- Who is authorised for `set_fee_rate` was not verified in code (inferred from instruction names).
- A "splash pool" (full-range only) variant is mentioned in swap-math comments but its on-chain flags were not read.

---

## 10. Meteora DLMM (`LBUZKhRx...`)

### Takeaway
Discrete price bins: each bin has a fixed price `P_i = (1+bin_step/10000)^i` and holds token X, token Y, or both (the active bin only). Depth is the sum of token amounts across bins, not a curve; fees are base plus a volatility-driven variable fee recalculated per crossed bin. LP is a position account (no LP token), lockable only by a time-based `lock_release_point`.

### Cited Findings
- `LbPair` (904 bytes) offsets [C] from [dlmm.json](https://raw.githubusercontent.com/MeteoraAg/dlmm-sdk/main/idls/dlmm.json): `parameters` (StaticParameters, 32 bytes) 8, `v_parameters` 40, `bump_seed` 72, `bin_step_seed` 73, `pair_type` 75, `active_id` 76 (i32), `bin_step` 80 (u16), `status` 82 (0 enabled, 1 disabled), `require_base_factor_seed` 83, `base_factor_seed` 84, `activation_type` 86, `creator_pool_on_off_control` 87, `token_x_mint` 88, `token_y_mint` 120, `reserve_x` 152, `reserve_y` 184, `protocol_fee` 216 (amount_x, amount_y), `reward_infos` 264 (2 x 144), `oracle` 552, `bin_array_bitmap` 584 (16 x u64), `last_updated_at` 712, `pre_activation_swap_address` 752, `base_key` 784, `activation_point` 816, `pre_activation_duration` 824, `creator` 848, token program flags 880/881, `version` 882. StaticParameters: `base_factor` u16, `filter_period`, `decay_period`, `reduction_factor`, `variable_fee_control` u32, `max_volatility_accumulator` u32, `min_bin_id`, `max_bin_id`, `protocol_share` u16, `base_fee_power_factor` u8, `function_type` u8, `collect_fee_mode` u8. VariableParameters: `volatility_accumulator`, `volatility_reference`, `index_reference`, `last_update_timestamp`.
- `BinArray` (10,136 bytes): `index` i64 at 8, `lb_pair` at 24, 70 bins at 56 (each `Bin` 144 bytes in the IDL: `amount_x`, `amount_y`, `price` u128 Q64.64, `liquidity_supply` u128, limit-order fields, fee-per-token trackers); bin id to array index is `floor(bin_id / 70)`; PDA seeds start with the constant `bin_array` (the remaining seeds, expected to be the pair and the array index, were not read); max bin id ±443,636; `MAX_BIN_STEP 400` [C/V] — [dlmm.json](https://raw.githubusercontent.com/MeteoraAg/dlmm-sdk/main/idls/dlmm.json), [constants.rs](https://raw.githubusercontent.com/MeteoraAg/dlmm-sdk/main/commons/src/constants.rs), [seeds.rs](https://raw.githubusercontent.com/MeteoraAg/dlmm-sdk/main/commons/src/seeds.rs)
- Price: `price_raw = (1 + bin_step/10000)^active_id` (Q64.64 raw Y per raw X); active bin holds both tokens, bins below only Y, bins above only X; reserves of the whole pair are the vault balances `reserve_x`, `reserve_y` (but only active/near bins matter for depth) [V] — [DLMM formulas](https://docs.meteora.ag/core-products/dlmm/formulas.md), [price_math.rs](https://raw.githubusercontent.com/MeteoraAg/dlmm-sdk/main/commons/src/math/price_math.rs)
- Fees (`FEE_PRECISION = 1e9`, `MAX_FEE_RATE = 100,000,000` = 10%): `base_fee = base_factor * bin_step * 10 * 10^base_fee_power_factor`; `variable_fee = ceil(variable_fee_control * (volatility_accumulator*bin_step)^2 / 1e11)`; `volatility_accumulator = min(volatility_reference + |index_reference - active_id|*10000, max_volatility_accumulator)`; `total = min(base+variable, MAX)`; fee from an input amount `= ceil(amount*total/1e9)`; protocol share `= fee*protocol_share/10000` (1,000 bps for standard pools, 2,000 for Launch Pools in the docs) [V] — [lb_pair.rs](https://raw.githubusercontent.com/MeteoraAg/dlmm-sdk/main/commons/src/extensions/lb_pair.rs), [DLMM formulas](https://docs.meteora.ag/core-products/dlmm/formulas.md)
- Quote loop: for each bin the SDK calls `update_volatility_accumulator()` then swaps against the bin and advances `active_id`; so the fee rises as bins are crossed; `fee_on_input` depends on `collect_fee_mode` (`InputOnly` or `OnlyY`) [V] — [quote.rs](https://raw.githubusercontent.com/MeteoraAg/dlmm-sdk/main/commons/src/quote.rs), [lb_pair.rs](https://raw.githubusercontent.com/MeteoraAg/dlmm-sdk/main/commons/src/extensions/lb_pair.rs)
- Limit orders: bins carry limit-order amounts (`open_order_amount`, `processed_order_remaining_amount`) and `get_max_amount_out_with_limit_orders` adds them when the pair supports limit orders (`function_type == LimitOrder`, or `Undetermined` with no reward mints) [V] — [bin.rs](https://raw.githubusercontent.com/MeteoraAg/dlmm-sdk/main/commons/src/extensions/bin.rs), [lb_pair.rs](https://raw.githubusercontent.com/MeteoraAg/dlmm-sdk/main/commons/src/extensions/lb_pair.rs)
- `PositionV2` (8,120 bytes): `lb_pair` 8, `owner` 40, `liquidity_shares` 72 (70 x u128), `lower_bin_id` 7912, `upper_bin_id` 7916, `operator` 7960, `lock_release_point` 7992 (u64), `fee_owner` 8001, `version` 8033, `permissionless_operation_bits` 8034 [C]; no LP token or NFT: the owner controls the position; operator can manage; "If liquidity is still locked, the program prevents liquidity removal until the lock has released" [V] — [dlmm.json](https://raw.githubusercontent.com/MeteoraAg/dlmm-sdk/main/idls/dlmm.json), [DLMM Dynamic Positions](https://docs.meteora.ag/core-products/dlmm/dynamic-positions.md)
- Admin/creator surface from instruction names: `set_pair_status` (operator-gated), `set_pair_status_permissionless`, `update_base_fee_parameters` (operator-gated), `set_activation_point`, `initialize_permission_lb_pair` (permissioned pair type) and pair type enum `Permissionless, Permission, CustomizablePermissionless, PermissionlessV2` [V names] — [dlmm.json](https://raw.githubusercontent.com/MeteoraAg/dlmm-sdk/main/idls/dlmm.json)

### Inferences
- [C] A bin step of 100 bps means `-10%` spans 10.6 bins and `-30%` 35.8 bins; for bin step 20 these are 52.7 and 178.5 bins; at base_factor 10,000 and bin_step 10 the base fee is 0.10%, at base_factor 8,000 and bin_step 80 it is 0.64% (arithmetic from the base-fee formula).
- [I] Depth read: `LbPair` plus `BinArray` accounts from `active_id`'s array downward (each array covers 70 bins; use the bitmap at 584 plus `BinArrayBitmapExtension` to find non-empty arrays); sum `amount_y` (selling X) and `amount_x` (buying X) with the per-bin fee. Exit capacity = `Σ amount_y_i` for bins `[active-n, active]` times `(1 - fee_i)`, with `n` from the section 2 table or by exact walk.
- [I] "Locked" test: a position is locked only until `lock_release_point`; compare it with current time/slot; there is no permanent lock for DLMM positions in the files read. Unlocked positions can `remove_liquidity` or `remove_all_liquidity` any time, so one wallet can remove all depth in one transaction (aggregate positions by owner to see concentration).

### Gaps
- LbPair PDA seed derivation, the DLMM HTTP Data API pool-listing semantics, and `BinArrayBitmapExtension` layout were not read.
- Whether `lock_release_point` is used in practice for memecoin launches (and whether DLMM has any permanent lock) was not researched.
- `lb_clmm` v0.12.0 limit-order mechanics (price priority vs LP liquidity) were read only at the extension-function level.

---

## 11. Meteora DAMM v1 (`Eo7WjKq6...`)

### Takeaway
A legacy dynamic AMM (constant product or stable) whose pool tokens sit in Meteora Dynamic Vaults, so reserves are not the pool's own token balances: pool reserve = (pool's LP in the vault) / (vault LP supply) * vault `total_amount` (less locked profit). LP is a normal SPL token; locks move LP into a `LockEscrow`. New DBC pools no longer target v1.

### Cited Findings
- `Pool` offsets [C] from [damm1 IDL](https://raw.githubusercontent.com/MeteoraAg/dynamic-bonding-curve-sdk/main/packages/dynamic-bonding-curve/src/idl/damm-v1/idl.json): `lp_mint` 8, `token_a_mint` 40, `token_b_mint` 72, `a_vault` 104, `b_vault` 136, `a_vault_lp` 168, `b_vault_lp` 200, `a_vault_lp_bump` 232, `enabled` 233, `protocol_token_a_fee` 234, `protocol_token_b_fee` 266, `fee_last_updated_at` 298, `fees` 330 (`trade_fee_numerator`, `trade_fee_denominator`, `protocol_trade_fee_numerator`, `protocol_trade_fee_denominator`, 32 bytes), `pool_type` 362 (enum, `Permissioned` or `Permissionless`), `stake` 363, `total_locked_lp` 395 (u64), `bootstrapping` 403 (`activation_point`, `whitelisted_vault`, `pool_creator`, `activation_type`), `partner_info`, `padding`, `curve_type` (enum `ConstantProduct` or `Stable{amp, token_multiplier, depeg, last_amp_updated_timestamp}`, variable size). (Offsets after `pool_type` assume a 1-byte enum.)
- `Vault`: `total_amount` at 11 (u64), `token_vault` 19, `lp_mint` 115, `locked_profit_tracker` 1203 [C] — same IDL.
- Swap accounts include both vaults, both vault-LP mints and the pool's vault-LP token accounts plus the Dynamic Vault program, confirming reserves live in the vaults [V] — same IDL (`swap` accounts: `a_vault`, `b_vault`, `a_token_vault`, `b_token_vault`, `a_vault_lp_mint`, `b_vault_lp_mint`, `a_vault_lp`, `b_vault_lp`, `protocol_token_fee`, `vault_program`).
- Locks: `lock` creates a `LockEscrow` (`pool`, `owner`, `escrow_vault`, `total_locked_amount`, `lp_per_token`, fee fields); the pool tracks `total_locked_lp`; the lock moves LP into escrow and limits redemption; the docs I fetched do not say whether a lock is permanent [V/T] — [DAMM v1 liquidity locks](https://docs.meteora.ag/legacy-products/damm-v1/liquidity-locks.md), [damm1 IDL](https://raw.githubusercontent.com/MeteoraAg/dynamic-bonding-curve-sdk/main/packages/dynamic-bonding-curve/src/idl/damm-v1/idl.json)
- Creation and admin instruction names: `initialize_permissionless_pool(_with_fee_tier)`, `initialize_customizable_permissionless_constant_product_pool`, `add/remove_*_liquidity`, `remove_liquidity_single_side`, `lock`, `set_pool_fees`, `enable_or_disable_pool`, `override_curve_param`, `update_activation_point` [V names] — [damm1 IDL](https://raw.githubusercontent.com/MeteoraAg/dynamic-bonding-curve-sdk/main/packages/dynamic-bonding-curve/src/idl/damm-v1/idl.json)
- DBC no longer creates new v1 pools (migration option 0 is deprecated, existing pools can still migrate) (prior note) — [DBC README](https://github.com/MeteoraAg/dynamic-bonding-curve)
- Live [L]: DexScreener labels many tiny BIRB pools "DYN"/"DYN2" (v1/v2) at under $100 — [DexScreener](https://api.dexscreener.com/token-pairs/v1/solana/G7vQWurMkMMm2dU3iZpXYFTHT9Biio4F4gZCrwFpKNwG)

### Inferences
- [I] Reserve of token A `= pool.a_vault_lp.amount * vaultA.total_amount_unlocked / a_vault.lp_mint.supply` (same for B) where unlocked amount excludes the locked profit; constant-product quote then applies on those reserves with the trade fee. The Dynamic Vault doc pages (`/legacy-products/dynamic-vault/formulas.md`) define the unlocked amount; I did not read them.
- [I] Because vault funds may be lent out to strategies, the immediately withdrawable amount can be less than `total_amount`; the vault's idle `token_vault` balance bounds a same-block exit (inference, not verified).
- [I] Burned/locked share `= (burned via supply gap + total_locked_lp)/lp_supply`; an unlocked, unburned LP holder (often the pool creator) can `remove_balance_liquidity`.

### Gaps
- DAMM v1 swap fee defaults, stable-curve (StableSwap amp) quoting, and exact vault `unlocked amount` formula were not read.
- PDA seeds of pool addresses (config-based vs permissioned) were not read.
- Lock permanence and unlock procedure were not documented in the sources fetched.

---

## 12. Meteora DAMM v2 (`cpamdpZC...`)

### Takeaway
A Uniswap-v3-like pool with a single price range (default full range), plus a "compounding" fee mode that makes it plain x*y=k. The pool account stores sqrt price, L and (for layout v1) tracked token amounts; LP is a Token-2022 position NFT whose position account separates unlocked, vested and permanently locked liquidity, and the pool keeps a `permanent_lock_liquidity` counter, so the locked share is one division.

### Cited Findings
- `Pool` (1,112 bytes, INIT_SPACE asserted 1,104) offsets [C] from [damm2 IDL](https://raw.githubusercontent.com/MeteoraAg/damm-v2-sdk/main/src/idl/cp_amm.json) and [pool.rs](https://raw.githubusercontent.com/MeteoraAg/damm-v2/main/programs/cp-amm/src/state/pool.rs): `pool_fees` 8 (160 bytes: base fee struct 40, `protocol_fee_percent`, `referral_fee_percent`, `compounding_fee_bps`, dynamic fee struct, `init_sqrt_price` u128), `token_a_mint` 168, `token_b_mint` 200, `token_a_vault` 232, `token_b_vault` 264, `whitelisted_vault` 296, `liquidity` 360 (u128), `protocol_a_fee` 392, `protocol_b_fee` 400, `dead_liquidity_fee_checkpoint` 408, `sqrt_min_price` 424, `sqrt_max_price` 440, `sqrt_price` 456 (u128 Q64.64), `activation_point` 472, `activation_type` 480 (0 slot, 1 timestamp), `pool_status` 481 (0 enabled, 1 disabled), `token_a_flag` 482, `token_b_flag` 483, `collect_fee_mode` 484 (0 both tokens (only the out token is collected), 1 only B, 2 compounding), `pool_type` 485 (0 permissionless, 1 customizable), `fee_version` 486 (0 max fee 50%, 1 max 99%), `fee_a_per_liquidity` 488, `fee_b_per_liquidity` 520, `permanent_lock_liquidity` 552 (u128), `metrics` 568, `creator` 648, `token_a_amount` 680, `token_b_amount` 688, `layout_version` 696 (v1 tracks token_a_amount/token_b_amount), `reward_infos` 728.
- Reserves from L: concentrated mode `A = L*(1/√P - 1/√P_max)`, `B = L*(√P - √P_min)`; compounding mode is plain `A*B = k` with no price range; `sqrt` range constants `MIN_SQRT_PRICE 4295048016`, `MAX_SQRT_PRICE 79226673521066979257578248091` [V] — [DAMM v2 formulas](https://docs.meteora.ag/core-products/damm-v2/formulas.md), [constants.rs](https://raw.githubusercontent.com/MeteoraAg/damm-v2/main/programs/cp-amm/src/constants.rs), [pool.rs](https://raw.githubusercontent.com/MeteoraAg/damm-v2/main/programs/cp-amm/src/state/pool.rs)
- Fees: numerator over 1e9; total `= min(base + dynamic, cap)`; trading fee from an included amount `= ceil(amount*numerator/1e9)`, included amount from an excluded one `= ceil(excl*1e9/(1e9 - numerator))`; fee split: protocol `= floor(fee*protocol_percent/100)` (default `PROTOCOL_FEE_PERCENT` 20), referral `= floor(protocol*referral_percent/100)`; fees on input or output depends on `collect_fee_mode` and direction (`fee_mode.fees_on_input`); base-fee modes: time scheduler linear/exponential (`fee = cliff - passed_period*reduction`), market-cap scheduler linear/exponential (by price change from `init_sqrt_price`), rate limiter (deprecated); fee caps 50% (version 0), 99% (version 1) and `MAX_FEE_NUMERATOR_POST_UPDATE` 10% constant appears in constants [V] — [DAMM v2 formulas](https://docs.meteora.ag/core-products/damm-v2/formulas.md), [fee.rs](https://raw.githubusercontent.com/MeteoraAg/damm-v2/main/programs/cp-amm/src/state/fee.rs), [constants.rs](https://raw.githubusercontent.com/MeteoraAg/damm-v2/main/programs/cp-amm/src/constants.rs)
- Swap: `swap2` (modes exact in / partial in / exact out), accounts `pool_authority`, `pool`, `input/output_token_account`, `token_a/b_vault`, mints, `payer`, programs, `referral_token_account`; event `EvtSwap2` [V] — [damm2 IDL](https://raw.githubusercontent.com/MeteoraAg/damm-v2-sdk/main/src/idl/cp_amm.json)
- `Position` (408 bytes): `pool` 8, `nft_mint` 40, `fee_a_pending` 136, `fee_b_pending` 144, `unlocked_liquidity` 152 (u128), `vested_liquidity` 168, `permanent_locked_liquidity` 184, `inner_vesting` 312, `delegate_permission` 392 [C] — [damm2 IDL](https://raw.githubusercontent.com/MeteoraAg/damm-v2-sdk/main/src/idl/cp_amm.json). The NFT holder controls the position; a delegate can call `remove_liquidity` only if the matching `delegate_permission` bit is set; locked liquidity cannot be withdrawn while locked; permanent lock is never withdrawable; position NFT is a Token-2022 NFT, the pool is its freeze and mint authority [V] — [DAMM v2 NFT positions](https://docs.meteora.ag/core-products/damm-v2/nft-positions.md)
- Lock instructions: `lock_position` (vesting with cliff/periodic release), `lock_inner_position`, `permanent_lock_position(permanent_lock_liquidity)`, `refresh_vesting`; events `EvtLockPosition`, `EvtPermanentLockPosition` [V] — [damm2 IDL](https://raw.githubusercontent.com/MeteoraAg/damm-v2-sdk/main/src/idl/cp_amm.json), [ix_permanent_lock_position.rs](https://raw.githubusercontent.com/MeteoraAg/damm-v2/main/programs/cp-amm/src/instructions/ix_permanent_lock_position.rs)
- Admin/creator instruction names: `set_pool_status`, `update_pool_fees`, `fix_pool_fee_params`, `claim_protocol_fee2`, `update_delegate_permission` (who is authorised for each was not read) [V names].
- Creation/migration: `initialize_pool` (config-based), `initialize_customizable_pool`, `initialize_pool_with_dynamic_config`; events `EvtInitializePool`, `EvtCreatePosition`, `EvtLiquidityChange` [V] — [damm2 IDL](https://raw.githubusercontent.com/MeteoraAg/damm-v2-sdk/main/src/idl/cp_amm.json)
- DBC to DAMM v2: the migrated pool opens at `migration_sqrt_price`; partner and creator each can hold unlocked, permanently locked and vesting buckets (six allocations total 100%); at least 10% of liquidity stays locked on day 1 after migration; vesting max 2 years; fixed 0.2% protocol migration fee; Meteora keeper auto-migrates when the quote threshold matches the keeper's list (10 SOL, 750 USDC, 100 TRUMP, 1500 JUP, 750 USD1, 1500 MET, 750 JupUSD, 42000 VIRTUAL) and otherwise a manual migrator is needed; transfer-fee migrations use compounding mode [V] — [DBC migration and liquidity](https://docs.meteora.ag/core-products/dbc/migration-and-liquidity.md), [DBC developer guide via prior note](https://docs.meteora.ag/developer-guides/dbc.md)

### Inferences
- [I] Cheapest depth read: one `getAccountInfo(pool)`; with `layout_version == 1` use `token_a_amount/token_b_amount` for the real reserves (verify against the two vault balances once to confirm that protocol fees are excluded); with concentrated mode derive virtual reserves from `liquidity`, `sqrt_price` and the range. Exit capacity: section 2 with `Q_virtual = L*√P`, capped by real quote `L*(√P - √P_min)`. For full range the cap equals the virtual reserve.
- [I] Locked share `= pool.permanent_lock_liquidity / pool.liquidity`; vesting liquidity is not recorded in the pool, so iterate `Position` accounts (`getProgramAccounts` with `pool` memcmp at offset 8) for `vested_liquidity` and `unlocked_liquidity`; "removable now" = `liquidity - permanent_lock_liquidity - (vested not yet released)`.
- [I] Migrated DBC pools in the prior live sample had post-graduation liquidity of about $0.5 for farm-style launches (prior note), so for DAMM v2 pools created by DBC check that `liquidity` is not already near zero and who holds the unlocked NFT positions before treating the pool as exit liquidity.

### Gaps
- Authorisation of `update_pool_fees`/`set_pool_status` (operator vs creator) was not read.
- The `liquidity_handler` module (concentrated vs compounding) and exact fee-scheduler constants were not read in full; the 10% constant in `constants.rs` was not interpreted.
- Pool PDA derivation (config-based and customizable) was not read.
- Whether `token_a_amount` equals vault balance minus protocol fees was not verified.

---

## 13. Meteora Dynamic Bonding Curve (`dbcij3LW...`)

### Takeaway
A launchpad program with a configurable piecewise liquidity curve (up to 16 segments in practice, 20 in the account) on a virtual pool; price is `sqrt_price` Q64.64, reserves are `base_reserve`/`quote_reserve`, and graduation happens when `quote_reserve >= migration_quote_threshold`, after which a keeper or manual migrator creates a DAMM v2 pool. Layout offsets, events and keeper thresholds are in the prior note.

### Cited Findings
- Offsets, discriminators, events and the keeper/threshold list: see `/Users/srinjoydas/GodsEye/research_notes/Organic token detection/meteora_dbc.md` section 1 (VirtualPool offsets: `config` 72, `creator` 104, `base_mint` 136, `base_vault` 168, `quote_vault` 200, `base_reserve` 232, `quote_reserve` 240, `sqrt_price` 280, `pool_type` 304, `is_migrated` 305, `migration_progress` 308 (0 pre-curve, 1 post-curve, 2 locked vesting, 3 created pool); PoolConfig offsets: `quote_mint` 8, `collect_fee_mode` 232, `migration_option` 233, `token_type` 237, `migration_quote_threshold` 264, `migration_sqrt_price` 280, `sqrt_start_price` 392, `curve` 408 (640 bytes) — computed there from IDL v0.2.2). Not re-derived here.
- Curve data: `config.curve[i] = {sqrt_price (u128 upper bound of segment i), liquidity (u128)}`; segment i spans from the previous point's `sqrt_price` (or `sqrt_start_price`) to its own; quote-to-base walks i upward and base-to-quote walks downward, with `Δa = L*(√P_hi - √P_lo)/(√P_hi*√P_lo)` (base) and `Δb = L*(√P_hi - √P_lo)/2^128` (quote, Q64.64 squares) [V] — [dbc_vp virtual_pool.rs](https://raw.githubusercontent.com/MeteoraAg/dynamic-bonding-curve/main/programs/dynamic-bonding-curve/src/state/virtual_pool.rs), [curve.rs](https://raw.githubusercontent.com/MeteoraAg/dynamic-bonding-curve/main/programs/dynamic-bonding-curve/src/curve.rs), [config.rs](https://raw.githubusercontent.com/MeteoraAg/dynamic-bonding-curve/main/programs/dynamic-bonding-curve/src/state/config.rs)
- `get_swap_result_from_exact_input`: compute `trade_fee_numerator` (base fee scheduler plus dynamic fee, or the minimum base fee for an eligible first swap), take the fee from the input when `fee_mode.fees_on_input` (else from the output), run the walk, require nothing left over (`InsufficientLiquidity`) [V] — [virtual_pool.rs](https://raw.githubusercontent.com/MeteoraAg/dynamic-bonding-curve/main/programs/dynamic-bonding-curve/src/state/virtual_pool.rs)
- Fees: base fee scheduler (linear/exponential/fixed, min 0.25%), optional dynamic fee, protocol 20% of the fee, referral and creator shares; migration fee 0.2% protocol (prior note and docs) [V] — [DBC fees docs via prior note](https://docs.meteora.ag/core-products/dbc/fees.md), [DBC migration and liquidity](https://docs.meteora.ag/core-products/dbc/migration-and-liquidity.md)
- Migration: `migration_damm_v2` (and manual migrator); no DBC event for the migration (a TODO in source); `EvtCurveComplete` marks curve full; after completion swaps fail with `PoolIsCompleted`; keepers `9rpVELNUXLoMjAcc19UCVLJ73xjXNoYKENvRMHcci2V2` (per the DBC developer guide) vs `Asi5DTGEeiso6k7ya6ndDabEZ7DRCgfTpCBLPH5E3aQs` (per Bitquery) differ between sources (prior note).
- Live (prior note, 2026-10-26/27 sample): of 100 high-volume DBC tokens 52 graduated, median time to graduate 5.6 minutes, median graduated-pool liquidity about $0.49 (prior note, [L]).
- Jupiter labels the program "Dynamic Bonding Curve"; `ammKey` is the virtual pool [L] — [program-id-to-label](https://lite-api.jup.ag/swap/v1/program-id-to-label).

### Inferences
- [I] Exit capacity on the curve: current segment index from `sqrt_price`; selling base `T` returns `Σ_segments L_i*(√P_i_hi' - √P_i_lo')` with segment boundaries from the config curve array; cap by `quote_reserve` (real quote in the vault). In-segment the section 2 closed form holds with `Q_virtual = L*√P` and `B_virtual = L/√P`. The curve cannot go below `sqrt_start_price`.
- [I] Graduation progress `= quote_reserve / migration_quote_threshold`; for the 10 SOL keeper threshold, a curve that completes at 10 SOL has very little exit capacity compared with a 85-SOL pump curve.

### Gaps
- Exact per-config supply split and anti-sniper fee parameters are config-specific and not documented numerically (prior note).
- Migration-to-keeper latency and the gap between curve completion and DAMM v2 creation were not measured.
- Which keeper address is current remains unresolved.

---

## 14. Proprietary / oracle AMMs (HumidiFi, SolFi, Tessera, Lifinity, others)

### Takeaway
These venues are closed-source market-maker programs funded by the operator's own inventory; the curve is steered by quote/oracle updates pushed by the operator many times per second, no public IDL exists, and depth is not derivable from a pool account balance. Treat them as "Jupiter-only" venues and size against Jupiter quotes, not against account reads.

### Cited Findings
- Description (Helius blog, 2025): fair value estimated off-chain, execution logic on-chain; willingness to trade expressed as a continuous curve updated by a designated authority "multiple times per second"; inventory in program-controlled vaults with no external LPs; no public IDLs or documented account layouts; off-chain simulation is not officially supported and programs can be upgraded at any time; one cited oracle update costs 143 compute units; the author labels as inference that vault balances are readable and that swaps halt if updates stop [T] — [Helius: Solana's proprietary AMM revolution](https://www.helius.dev/blog/solanas-proprietary-amm-revolution)
- Market share snapshots differ widely and by date: HumidiFi over 62.4% of executed volume and prop AMM share above 79.5% on Jupiter (one Substack); SolFi 21.1% and HumidiFi 16% of routed volume (an earlier snapshot); BisonFi over 35% of daily prop AMM volume and HumidiFi about 26.5% (a later report); Tessera 7-12% [T] — web-search summaries of [Step Data: prop AMMs](https://stepdata.substack.com/p/prop-amms-on-solana-bisonfi-ends), [Step Data: aggregators](https://stepdata.substack.com/p/the-rise-of-aggregators-in-solana) and [The Defiant](https://thedefiant.io/news/defi/over-40-of-jupiter-s-trading-volume-now-flows-through-private-amms) (which figure came from which post was not preserved; none confirmed by me)
- Entities: Tessera V associated with Wintermute, SolFi with Ellipsis Labs, HumidiFi's engineering team linked to Temporal; HumidiFi has not disclosed its team (web-search summary of secondary sources) [T].
- Jupiter's label map today includes: HumidiFi `9H6tua7jkLhdm3w8BvgpTn5LZNU7g4ZynDmCiNN3q6Rp`, SolFi `SoLFiHG9TfgtdUXUjWAxi3LtvYuFyDLVhBWxdMZxyCe`, SolFi V2 `SV2EYYJyRz2YhfXwXnhNAevDEui5Q6yrfyo13WtupPF`, TesseraV `TessVdML9pBGgG9yGks7o4HewRaXVAMuoVj4x83GLQH`, BisonFi, ZeroFi, GoonFi V2, Obric V2, AlphaQ, Kipseli `3TK9D8aoBFYjYZtKCjciPrVrRStsnvo7KmpcJqDavpaU`, Hadron, Manifest; Lifinity is absent from the current map [L] — [Jupiter program-id-to-label](https://lite-api.jup.ag/swap/v1/program-id-to-label)
- Live routing [L]: a 1 SOL to USDC quote routed 100% through Kipseli (`ammKey 7yD7gfXv49SFxhx9uTc11dEd7Nj98rGWeYMdZJgheZbG`); a 100 SOL quote split 99% Kipseli / 1% TesseraV (`ammKey 4U2JzGENeMhYuVMGMUeLdzPP9d4PwqnKX9iLxjwPXZU8`); both `ammKey`s are not conventional LP pool addresses you can decode from this note — [Jupiter quote 100 SOL](https://lite-api.jup.ag/swap/v1/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&amount=100000000000&slippageBps=100)
- Lifinity v2 descriptions in the web results are marketing copy: Pyth-driven pricing, "proactive" concentrated liquidity, pools protocol-owned and closed to new deposits per the Helius article; none describe on-chain state [T] — web-search results (OneKey listing pages, Helius).

### Inferences
- [I] For memecoin copy trading these venues matter mainly for majors and stable/SOL legs (SOL/USDC, USDC), not for fresh memecoins, which route through pump/Raydium/Meteora/Orca pools (Jupiter quotes for CATTLEAXE, BIRB, LMAO returned only public-AMM venues, [L]). The one counter example: a STONK quote routed through "Hadron" instead of the Meteora pool GeckoTerminal lists at about $2.4M, which shows routers can use venues absent from indexer pool lists.
- [I] Depth for prop AMMs is the router's quote: call the Jupiter quote endpoint at several sizes, read `outAmount`/`priceImpactPct`, and treat the result as non-binding (the quote depends on the operator's current curve and can move between quote and execution). Do not attempt to infer liquidity from vault balances even where readable; the operator can move inventory and change quotes each slot (inference).
- [I] Controls: all liquidity is operator-controlled and permissioned, so "LP burned/locked" does not apply; the relevant risks are counterparty (operator stops quoting) and program upgradeability (Helius notes upgrades are possible).

### Gaps
- No primary documentation, IDL or source for HumidiFi, SolFi, Tessera, Kipseli, Hadron; account layouts and withdrawal controls are unverified.
- Lifinity's current status and program id were not verified (absent from Jupiter's map; only secondary descriptions).
- The market share numbers are from secondary summaries with inconsistent dates.

---

## 15. Pool creation, migration and graduation: how to detect and how to pick "the pool for a token"

### Takeaway
Each venue exposes a creation instruction/event you can key off (table below); migrations are explicit only for pump (`CompleteEvent`/`CompletePumpAmmMigrationEvent`/`CreatePoolEvent`) and LaunchLab (`migrate_to_cpswap`); for DBC the only on-chain signal is the `migration_damm_v2` instruction (no DBC event). Picking the pool: compute depth per pool and take the one with the largest exit capacity, remembering that routers may use others.

### Cited Findings
- Detection table (all from IDLs/source):

| Venue | Creation signal | Graduation / migration signal |
|---|---|---|
| Pump curve | `create` / `create_v2`, `CreateEvent` | `TradeEvent` flips `complete`; `CompleteEvent`; `migrate`/`migrate_v2`; `CompletePumpAmmMigrationEvent` (has `pool`) |
| PumpSwap | `create_pool`, `CreatePoolEvent` (canonical when `creator` is the pool-authority PDA and index 0) | n/a; LP changes via `DepositEvent`/`WithdrawEvent` |
| Raydium AMM v4 | `Initialize2` (tag 1) | n/a (market-based) |
| Raydium CPMM | `initialize`, `initialize_with_permission` | LaunchLab `migrate_to_cpswap` CPI creates it |
| Raydium CLMM | `create_pool`, `create_customizable_pool`, `create_permissioned_pool` | n/a |
| LaunchLab | `initialize`, `initialize_v2`, `initialize_with_token_2022`, `PoolCreateEvent` | `migrate_to_cpswap` (or legacy `migrate_to_amm`); trigger `quote_vault.balance >= threshold` |
| Orca | `initialize_pool` (and token-extension variants) | n/a |
| DLMM | `initialize_lb_pair(2)`, `initialize_customizable_permissionless_lb_pair(2)`, `LbPairCreate` event | n/a |
| DAMM v1 | `initialize_permissionless_*` variants | n/a |
| DAMM v2 | `initialize_pool`, `initialize_customizable_pool`, `EvtInitializePool` | from DBC via `migration_damm_v2` |
| DBC | `initialize_virtual_pool_with_spl_token` / `_with_token2022`, `EvtInitializePool` | `EvtCurveComplete`; the `migration_damm_v2` instruction (no event); `is_migrated` set only there |

 — sources: [pump.json](https://raw.githubusercontent.com/pump-fun/pump-public-docs/main/idl/pump.json), [pump_amm.json](https://raw.githubusercontent.com/pump-fun/pump-public-docs/main/idl/pump_amm.json), [raydium-amm instruction.rs](https://raw.githubusercontent.com/raydium-io/raydium-amm/master/program/src/instruction.rs), [cp-swap lib.rs](https://raw.githubusercontent.com/raydium-io/raydium-cp-swap/master/programs/cp-swap/src/lib.rs), [clmm lib.rs](https://raw.githubusercontent.com/raydium-io/raydium-clmm/master/programs/amm/src/lib.rs), [launchpad IDL](https://raw.githubusercontent.com/raydium-io/raydium-idl/master/raydium_launchpad/raydium_launchpad.json), [dlmm.json](https://raw.githubusercontent.com/MeteoraAg/dlmm-sdk/main/idls/dlmm.json), [damm1 IDL](https://raw.githubusercontent.com/MeteoraAg/dynamic-bonding-curve-sdk/main/packages/dynamic-bonding-curve/src/idl/damm-v1/idl.json), [damm2 IDL](https://raw.githubusercontent.com/MeteoraAg/damm-v2-sdk/main/src/idl/cp_amm.json), prior DBC note.
- Anchor events are emitted as self-CPI inner instructions to the program (DBC note); Pump events likewise appear in logs/inner instructions per their IDLs [V/prior note].
- Pump to PumpSwap: pool PDA `["pool", 0u16, pool-authority PDA, mint, WSOL]` (section 4); the pool-authority PDA seeds `["pool-authority", mint]` under the Pump program [V] — [PumpSwap creator-fee doc](https://raw.githubusercontent.com/pump-fun/pump-public-docs/main/docs/PUMP_SWAP_CREATOR_FEE_README.md).
- DBC to DAMM v2: migration instruction accounts include `virtual_pool`, `config`, new `pool`, position NFT mints, `token_a/b_vaults`, and the DAMM v2 program; `is_migrated` and `migration_progress == 3` after it; Meteora's keeper handles configs whose threshold matches the list in section 12; otherwise manual migrator (prior note, docs).
- Multi-pool reality and pool choice: DexScreener returned 17 pairs for BIRB with only one above $100k liquidity (section 1); Jupiter chose a venue the indexer ranks lower for STONK (section 14) [L].

### Inferences
- [I] For a token a bot already follows, store `(pool_address, program_id, base_mint, quote_mint)` at the first creation/migration event, then maintain a candidate set: canonical PumpSwap PDA, plus any pool found via indexers; recompute `exitCapacitySol` for each and pick the maximum, while keeping the list because a thin pool can still be a drain target for a router-split exit.
- [I] Practical migration detector for pump: watch `CompletePumpAmmMigrationEvent` (contains the pool) or derive the canonical PDA and read it once; for DBC watch the `migration_damm_v2` instruction (top-level or inner) rather than a DBC event; for LaunchLab watch `migrate_to_cpswap`.
- [I] A signed hint for new pools: `activation_point`/`pool_open_time`/`open_time` (AMM v4 `state_data.pool_open_time`, CPMM `open_time`, DLMM `activation_point`, DAMM v2 `activation_point`) tell when trading starts; swaps before that fail or are whitelisted.

### Gaps
- Event discriminators and field layouts for events other than those already in the prior notes were not enumerated; for production, generate decoders from the IDLs.
- Latency between `complete` and the migration transaction for pump (and between curve full and DBC keeper migration) was not measured here.
- Orca `initialize_pool` variant names and DAMM v1 creation events were not enumerated.

---

## 16. Jupiter route plans: what they reveal about the pools a trade touched

### Takeaway
A route plan lists each hop as `swapInfo{ammKey, label, inputMint, outputMint, inAmount, outAmount}` with a `percent` split, where `label` is the DEX program label and `ammKey` is the pool/market account for programs with public pool accounts; the label map is also public. Verified live: for PumpSwap and Raydium CLMM the `ammKey` equals the pool address on the indexers; for prop AMMs it is an opaque account.

### Cited Findings
- Docs: `routePlan` is an array of steps each with `swapInfo` and `percent`; `ammKey` is the AMM account; `label` is the DEX name; amounts are raw integers; `otherAmountThreshold` is the minimum out after `slippageBps`; `maxAccounts` limits inner-swap accounts; the Metis Swap API is "no longer actively maintained" and superseded by Swap V2; example base URL `https://api.jup.ag/swap/v1/quote` with an `x-api-key` header [V] — [Jupiter get-quote docs](https://developers.jup.ag/docs/swap-api/get-quote)
- `lite-api.jup.ag/swap/v1/quote` answered unauthenticated GETs today (including `bps: null` for each leg) [L] — [example](https://lite-api.jup.ag/swap/v1/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&amount=1000000000&slippageBps=50)
- Observed labels and keys [L]: "Pump.fun Amm" with `ammKey = 3p3uYa9AYzV7w2nHEJeo8ANkuuwhYUonQvhHS8LyrqJY` (CATTLEAXE/SOL pool) and `CFwWK6esez97bvjy6LmGGte5WUEmBgGoVeuN3CF332bX` (LMAO/SOL pool); "Raydium CLMM" with `ammKey = GUWFT7bbLphGrcpAPnnEnBbe1uErv9e6LLC2qPx2wZy1`; "Hadron" `6AeR9Be7D8w81NRu9V14Qxsg8X9WxJeBqgrWMbVrCXVn`; "Kipseli"/"TesseraV" for SOL/USDC; a two-leg split 99%/1% for 100 SOL [Jupiter quotes](https://lite-api.jup.ag/swap/v1/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=DEZrHa3CeoQs2kGqMPo6D1TFgHB2KWoPMJMjf9HJpump&amount=5000000000&slippageBps=100), [GeckoTerminal pools](https://api.geckoterminal.com/api/v2/networks/solana/dexes/pumpswap/pools?page=1).
- Program id to label map: `https://lite-api.jup.ag/swap/v1/program-id-to-label` (111 entries today): use it to map the program that owns an `ammKey` account (or an inner-instruction program id) to a label; DBC is "Dynamic Bonding Curve", DAMM v2 "Meteora DAMM v2", DLMM "Meteora DLMM", DAMM v1 "Meteora", Orca "Whirlpool" [L] — [Jupiter label map](https://lite-api.jup.ag/swap/v1/program-id-to-label)
- GodsEye's `programs.ts` currently maps only DLMM and DAMM v1 to "meteora", with no DBC or DAMM v2 id (prior note, `meteora_dbc.md` header).

### Inferences
- [I] For a leader's executed Jupiter swap, read the route either from the transaction's inner instructions (program id + accounts of each swap CPI) or, for pre-trade checks, from a quote for the same size; each `ammKey` is a pool you can then decode with the adapters above (for opaque prop AMM keys: skip depth, use the Jupiter quote).
- [I] A route that touches only Pump.fun Amm and Raydium CLMM pools implies the pool state I can read directly; a route containing a prop-AMM leg means the quote is not reproducible by account reads and should use the router as the oracle.
- [I] Using `percent` and `inAmount/outAmount` per leg you can compute the per-pool average price the copied trade got, a better depth signal than the aggregate.

### Gaps
- The Swap V2 API's route structure (the docs say Metis is superseded) was not read; the lite-api v1 format may be deprecated.
- Whether `ammKey` is always the pool account for every label (some venues use a market/config key) was not verified beyond the examples above.
- `bps: null` and the unit of `priceImpactPct` are unexplained by the docs.

---

## 17. LP ownership, locks, burns and drains: verification matrix per program

### Takeaway
"LP burned" and "LP locked" must be verified with a venue-specific on-chain read: SPL LP burns appear as a mint-supply gap against a program counter (`lp_supply`/`lp_amount`); Raydium locks hold LP (or the position NFT) in a lock-program escrow; Orca locks freeze a Token-2022 position token; DAMM v2 keeps a pool-level `permanent_lock_liquidity`; DLMM only supports a release-time lock. Pump curve has no LP at all.

### Cited Findings
| Program | Who holds liquidity rights | Burn / lock mechanism | On-chain check | Admin-controllable bits |
|---|---|---|---|---|
| Pump curve | nobody (virtual) | n/a | `complete`, `real_*` | Global authority sets params for new coins |
| PumpSwap canonical | none after migration | LP burned at `migrate` | `lp_mint.supply` vs `pool.lp_supply`; `pool.creator` == pool-authority PDA | admin: fee config, recipients, global `disable` flags |
| PumpSwap non-canonical | creator / LP holders | no lock | LP holder list | as above |
| Raydium AMM v4 | LP token holders | SPL burn (no lock program) | `lp_mint.supply` vs `AmmInfo.lp_amount`; LP holder list | `amm_owner` (Raydium): status, fees |
| Raydium CPMM | LP token holders | SPL burn; Raydium lock program (Fee Key NFT), LP to `lock_lp_vault` | mint supply vs `lp_supply`; balance of lock authority ATA | Raydium admin: pool status, config |
| Raydium CLMM | position NFT holders | lock program (NFT to lock authority) | `LockClPosition` account per position | Raydium admin: pool status |
| LaunchLab | pre-migration: nobody; after: CPMM LP | `burnScale` burned; platform/creator scales locked | CPMM pool checks | platform/global config |
| Orca | position NFT holders | Token-2022 freeze + `LockConfig` | frozen token account, `["lock_config", position]` | config fee authorities |
| DLMM | position owner/operator | `lock_release_point` (time) | `PositionV2.lock_release_point` | operator/admin pair status and fee params |
| DAMM v1 | LP token holders | `lock` into `LockEscrow` | `Pool.total_locked_lp`, escrow vault balance | pool admin/operator instructions |
| DAMM v2 | position NFT holders | vesting lock, permanent lock | `Pool.permanent_lock_liquidity`, `Position.*_liquidity` | status/fee instructions |
| DBC | virtual; post-migration NFTs held by partner/creator | locks applied at migration | DAMM v2 position buckets | partner/creator claims, surplus withdrawals |

— sources: sections 3 to 13 and their cited primary files.
- Documented drain/pull risk facts: PumpSwap and CPMM/AMM v4 pools can be emptied only by LP holders (`withdraw`); Raydium admin controls status only; Orca/Raydium CLMM drains require owning the position (NFT) and it shows as `decrease_liquidity`; DLMM `remove_all_liquidity`; DAMM v2 `remove_liquidity` by NFT holder or an authorised delegate — [pump_amm.json](https://raw.githubusercontent.com/pump-fun/pump-public-docs/main/idl/pump_amm.json), [cp-swap lib.rs](https://raw.githubusercontent.com/raydium-io/raydium-cp-swap/master/programs/cp-swap/src/lib.rs), [clmm lib.rs](https://raw.githubusercontent.com/raydium-io/raydium-clmm/master/programs/amm/src/lib.rs), [dlmm.json](https://raw.githubusercontent.com/MeteoraAg/dlmm-sdk/main/idls/dlmm.json), [DAMM v2 NFT positions](https://docs.meteora.ag/core-products/damm-v2/nft-positions.md)
- Empirical mix of Solana rug mechanisms in H1 2025 on Orca/Raydium/Meteora: pump-and-dump 79.0%, liquidity withdrawal 20.4%, freeze-authority abuse 0.6% (prior notes, SolRugDetector, arXiv 2603.24625) — [arXiv 2603.24625](https://arxiv.org/abs/2603.24625)

### Inferences
- [I] Per-venue "locked/burned share" metric for a bot: `burned = 1 - lp_mint.supply / program_lp_counter`, `locked = lock_escrow_balance / counter` (AMM v4/CPMM/DAMM v1 style), `permanent_lock_liquidity / liquidity` (DAMM v2), `Σ locked positions' L / L_active` (Orca/CLMM, requires enumerating positions), `time_to_release` (DLMM). Combine with `(unburned, unlocked)` concentration: the top unlocked holder's share is the true drain capacity.
- [I] Drain precursor signals to stream: PumpSwap `WithdrawEvent` on non-canonical pools; Raydium LP token burns/transfers to unknown wallets; CLMM/Orca `decrease_liquidity`; DLMM `RemoveLiquidity`; DAMM v2 `EvtLiquidityChange` with negative delta; DBC post-migration `claim`/withdraw events.
- [I] A CLMM or DLMM "rug" can be a quote-side pull that leaves the memecoin side in place, so after a pull price drops only when sellers arrive; monitor the quote-side drop in active-range reserves, not the price.

### Gaps
- Raydium CLMM `LockedClPositionState` and the CPMM lock account layout were not read; the checks are inferred from SDK layouts.
- Who is authorised for each admin instruction in DLMM and DAMM v2 and Orca config was not verified in code.
- No source quantifies the share of drains by venue.
