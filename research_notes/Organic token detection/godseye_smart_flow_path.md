# How tokens with no real market reach GodsEye's smart-money feed (code path, data, and what is available to filter them)

Scope: read-only investigation of /Users/srinjoydas/GodsEye (branch `copytrade-rebuild`) and `data/copycow.db` (opened with `sqlite3 -readonly`). "Sources" are repo `file:line` references and SQL run against the database. No file in the repo was edited.

Database facts that frame every number below:
- `smart_flows` holds 172,942 rows over 5,223 mints, 2026-10-19T09:27Z to 2026-10-25T19:09Z. The stream then went down: `agent_meta.stream_status = waiting_for_ip` (IP allowlist rejections, 470 tries) as of 2026-10-26T22:39Z.
- There are no smart flows on Oct 23 and Oct 24. Per-day flow counts: Oct 19 6,240; Oct 20 74,306; Oct 21 28,242; Oct 22 34,403; Oct 25 29,751.
- "Last 3 days" below means the 3 days before the last flow: ts >= 2026-10-22T19:09Z. That is 33,827 flows, 1,296 mints, 878 wallets. Only Oct 22 (evening) and Oct 25 have data inside it.
- `wallet_swaps` is 2,856,656 rows, 2026-10-16 to 2026-10-26, for the 6,959 tracked wallets in `wallets` only. Of the 1,873 wallets that ever made a smart flow, 1,869 are in `wallets`, and 5,000 of 5,000 sampled recent flows have a matching `wallet_swaps` row. So the tape fully covers smart wallets' own trades, but sees only a small fraction of all traders in a token.
- Scratch tables used for the analysis are in `/private/tmp/claude-501/-Users-srinjoydas-GodsEye/069e91a1-a401-4d16-81bb-f5bcf1331f55/scratchpad/` (`scratch.db`, `all.db`, `*.sql`). The repo database was never written.

---

## 1. Path from a stream swap to `smart_flows` and `smart_signals`; what lets a market-less token through

### Takeaway
Nothing in the smart path looks at liquidity, volume, number of traders, pool existence or external market data. A swap is recorded if a currently-"smart" wallet makes it and the mint is not on a short stablecoin/major/wrapped list, so a token that only smart wallets trade is recorded like any other. Everything in the path is stream-only except token names (Shyft, with a GeckoTerminal fallback) and SOL's USD price (GeckoTerminal hourly closes).

### Cited Findings
Step by step (file:line):
1. **Subscription filter.** `agent/src/stream/stream.ts:125-139`. The gRPC request is `accountInclude: programs`, with `programs = config.streamPrograms.length ? config.streamPrograms : Object.keys(VENUES)` (`stream.ts:126`). `.env` has `STREAM_PROGRAMS=` empty (`.env:38`), so the filter is the 9 program ids in `chain/programs.ts:7-17`: Jupiter v6, pump.fun, PumpSwap, Raydium (AMM v4, CLMM, CPMM), Orca Whirlpool, Meteora DLMM (`LBUZ…`) and Meteora Dynamic AMM (`Eo7W…`). Failed transactions and votes are excluded (`vote:false, failed:false`; `convert.ts:52` also drops votes). Commitment is CONFIRMED.
   - A swap on a program not on that list is only seen if the same transaction also touches a listed program, for example Jupiter routing through it. **A Meteora DBC-only or Meteora DAMM v2-only transaction never reaches GodsEye at all.**
2. **Conversion.** `stream/convert.ts:49-84` turns the gRPC transaction into the RPC-shaped `TxLike`. `blockTime` is set to the time GodsEye received the update (`convert.ts:65`), not the chain time. Signers are the first `numRequiredSignatures` keys (`convert.ts:82-83`).
3. **Parse.** `stream.ts:217-218` runs `parseSwaps(conv.tx, signer, { solUsdAt })` for each signer. `agent/src/chain/parse.ts:174-295` filters as follows:
   - Failed transactions are dropped (`parse.ts:176`).
   - If any moved token is in `NON_MEMECOIN_MINTS`, the swap is dropped (`parse.ts:234`; list in `shared/src/constants.ts:18-42`, 23 mints).
   - Exactly one non-quote token must move (`parse.ts:268`), or two that settle through SOL (`parse.ts:244-266`).
   - The wallet must pay or receive SOL, wSOL, USDC or USDT in the opposite direction (`parse.ts:281-285`).
   - Minimum size is `MIN_SOL = 0.0001` SOL (`parse.ts:26`, `parse.ts:287`).
   - USDC/USDT-priced swaps are dropped if SOL's price is unknown (`parse.ts:278`).
   - `usdAmount` = SOL x SOL/USD price at that time, or the exact USDC/USDT amount (`parse.ts:292`).
4. **Every wallet's swap is fed to two consumers** (`stream.ts:221-224`): `LiveBook.record` (per-wallet stats) and `SmartMoney.onSwap`.
5. **`SmartMoney.onSwap`** (`agent/src/smart/smart-money.ts:124-151`):
   - `priceUsd = usdAmount / tokenAmount` (`:125`). It is stored in `this.prices` for every mint, from every wallet's swap, before the smart check (`:126-129`). The price is simply the last swap's price.
   - `if (!this.smart.has(s.wallet)) return` (`:130`) is the first real filter. The smart set is the 1,296 wallets in `smart_wallets` with `active=1` (analyzed track record or winning live, minus buys-tops, bot gate and copy gate: `:244-315`).
   - `if (this.notMeme(s.mint)) return` (`:131`, `:207-209`) calls `isNonMemecoin(mint, cachedTokenInfo(...)?.symbol)` (`shared/src/constants.ts:55-57`). It uses the mint list plus a symbol list (`constants.ts:60-67`, wrapped/stock patterns at `:48-52`). **If the token has no cached symbol it passes.**
   - The swap is queued for `smart_flows` (`:132-133`), after which it needs `usdAmount !== null` (`:134`). Later, `flush()` (`:154-181`) does `INSERT OR IGNORE INTO smart_flows (signature, ts, wallet, mint, side, usd, price_usd, wallet_win_rate)` (`:163`). **There is no minimum USD for a flow row.** The smallest recorded flow is whatever passed `MIN_SOL`.
   - There is no check on the quote asset, venue, pool liquidity, token age, other traders or holder count.
6. **Signal** (`smart-money.ts:135-150`, pure logic in `detectSignal` `:57-72`):
   - A per-mint list of smart events within `SMART_SIGNAL_WINDOW_MINUTES` (60) is kept.
   - It fires when at least `SMART_SIGNAL_WALLETS` (3) distinct wallets have a net-positive (accumulate) or net-negative (exit) USD position in the window and the sum is at least `SMART_SIGNAL_MIN_USD` ($500) (`config.ts:62-66`, `.env:67-70`).
   - There is a 6 h per-(kind, mint) cooldown (`:45`, `:141`).
   - The row stores `price_usd` and `token_age_min = now - firstSeen`, where `firstSeen` is the first time this process saw a priced swap of the mint (`:127`, `:143`, `:146`). It is not the token's real age: it resets on restart (see the example below with `age_min` = 3e-5).
7. **Names** (the only non-stream calls in the smart path): `flush()` with `lookupNames` calls `tokenInfo()` once per new mint (`smart-money.ts:156-162`; `stream.ts:103`).
   - `tokenInfo` (`market/tokens.ts:61-97`) asks Shyft `token/get_info` first (`market/shyft.ts`).
   - It asks GeckoTerminal `/tokens/{mint}/pools` only if Shyft gave no symbol or the caller passes `launch`/`pool` (`tokens.ts:69-72`). The smart path passes neither.
   - It asks RPC for decimals if missing (`tokens.ts:84`).
   - RugCheck, Birdeye and Jupiter price APIs are not used anywhere in `smart/` or `stream/`. `market/holders.ts`, `rugcheck.ts` and the other market modules are imported only by `copy/engine.ts`, `copy/executor.ts`, `analysis/analyze.ts`, `shadow/*` and `audit/gate.ts`.
   - `solUsdAt` (`stream.ts:20`) comes from `sol_price_hourly`, filled from GeckoTerminal SOL/USDC pool hourly closes (`market/solprice.ts`).
8. **Purge** (`smart-money.ts:212-237`, run every refresh): once a mint's name is known and it is a non-memecoin, its flows and signals are deleted. It only removes known majors/wrappers.

Observed in the database (2026-10-22T19:09Z to 2026-10-25T19:09Z):
- 33,827 flows; the smallest `usd` is $0.01, 183 flows are under $1 and 1,942 under $10 (no floor).
- `token_info` coverage of the 1,296 mints: 96 have no symbol (`symbol IS NULL`), and 591 have never been asked about GeckoTerminal (`launch_checked_at IS NULL`). Only 5 mints were checked and not found (`launch_checked_at` set, `pool_created_at` null), so the database holds almost no "unknown to GeckoTerminal" signal.
- Example of a token that passed with no symbol: `7c52LfFGGbxRv4JuUQGyc6tSB6uxQZYBjwsgM5Vmpump` (`token_info.symbol` null, never asked about launch). Two buys at 2026-10-25T18:37:12Z: $102 at $4.29e-5 and $18,327 at $1.33e-4. It had 6 tape swaps from 3 tracked wallets and ranked #2 in the simulated Home feed with net +$18,429.
- A DexScreener query (`api.dexscreener.com/tokens/v1/solana/…`, run on Oct 27) returned `[]` for it, and for `vNJrbTyZ…` (JUFF) and `6isLJ1xT…` (sender), the two single-smart-buyer Jupiter-venue tokens discussed in section 4.

### Inferences
- A token with no external market data passes every filter as long as one active smart wallet buys it for at least 0.0001 SOL of value and its symbol is unknown or not on the major list. Signals need 3 distinct smart wallets and $500 (see section 2).
- The "hit/miss" and price used for ranking come from the stream's own last-swap price, so a pool with a single trader has a self-referential price (see section 2).

### Gaps
- I did not verify, by reading a transaction on chain, which program ids the offending tokens' swaps hit. I only know the venue label the code assigned.

---

## 2. Price and `ret_1h/6h/24h`; no-pool tokens; can a handful of swaps make a signal; independence of the 3 wallets

### Takeaway
Prices are the last swap price seen on the stream by any wallet, with no sanity check beyond a 100,000% cap on the return. Returns are "latest price at evaluation time vs the wallet's own fill price", so a token with almost no other trading yields 0% or a self-made price move. A signal needs only 3 distinct addresses and $500 combined. Independence is not checked, and the database shows many signals where wallets share a funder.

### Cited Findings
- **Price per mint** is `this.prices: Map<mint, {usd, ts, firstSeen}>` (`smart-money.ts:91-98`). It is updated in `onSwap` for every swap by every wallet (`:125-129`), pruned only when it exceeds 200,000 entries (`:180`), and persisted to `token_prices` only for "watched" mints (those smart money touched in the last 26 h: `:132`, `:164-177`). `token_prices` has 5,274 rows.
- **`price_usd` of a flow or signal** is the swap's own execution price (USD / tokens), including the trader's price impact (`:125`, `:163-169`).
- **`evaluate()`** (`smart-money.ts:184-205`), run every 5 min (`agent/src/index.ts:163-167`): for each row still unchecked at a horizon (1 h, 6 h, 24 h) whose horizon has passed:
  - It takes `p = this.prices.get(mint) ?? dbPrice(mint)` (`:195`), which is the **latest** price at evaluation time, not the price at the horizon moment.
  - It counts as usable if `now - horizon <= LATE_MS (2 h)` and `p.ts >= horizon - STALE_MS (6 h)` (`:196`, constants `:41-43`). A price last updated up to 6 h before the horizon is accepted.
  - The result is `returnPct(from, to)` (`:76-80`): null if `to/from - 1` exceeds `MAX_PLAUSIBLE_RETURN_PCT` = 100,000% (`replay/model.ts:98`, i.e. 1,000x), otherwise the percentage.
  - A row that misses its window (agent down, no price) is marked checked with a null return (`:198`).
- **Dashboard "change since first smart buy"** is `token_prices.price_usd / first buy price_usd in last 24h - 1` (`shared/src/dashboard-data.ts:370`, `:408`).
- **Venue/pool is irrelevant** to the price: there is no pool lookup. A token "unknown to DexScreener/GeckoTerminal" is treated identically as long as swaps parse. External APIs only name it (section 1, point 7).
- **Measured returns in the 3-day window**, for `side='buy'` flows (`smart_flows`):

  | Tape wallets in mint | Buy flows | ret_1h measured | ret_1h exactly 0 | ret_6h measured |
  |---|---|---|---|---|
  | 1 | 359 | 359 | 12 | 51 |
  | 2-3 | 518 | 518 | 8 | 57 |
  | 4-10 | 1,130 | 1,126 | 7 | 99 |
  | 11+ | 15,001 | 14,989 | 18 | 2,386 |

  Across all 33,827 flows only 5,334 have `ret_6h` (the stream was down Oct 23-24, so most 6 h and 24 h checks lapsed). The 4-10 bucket's average 6 h return is +1,046%, driven by outliers admitted by the 1,000x cap. The 1 h return is measured for essentially every flow because some other swap usually updates the price.
- **Minimum distinct buyers in a signal:** `SMART_SIGNAL_WALLETS=3` (`config.ts:62`, `.env:67`). Counting is per distinct wallet address with a positive net USD in the 60-minute window (`detectSignal` `:62-72`). Total must reach $500.
- **Independence is not required.** There is no check on funder, cluster, creation time or on-chain relation between the wallets. Database evidence for the 192 signals in the window (`smart_signals`, 143 mints):
  - Each signal's wallet list (JSON) was joined to `wallets.funder`. The funder is known for only 441 of 1,134 signal-wallet rows (39%).
  - **68 of 192 signals** have at least two wallets with the same known funder, and **30** have at least half their wallets sharing a funder.
  - Signal 759 (WAKARU, accumulate): 10 wallets, **all 10 with the same funder**, total $540 (about $54 each), a $500 floor barely cleared.
  - Signals 761, 812, 773, 855 are similar (9 of 9, 8 of 8, 8 of 15, 7 of 11 wallets share a funder).
  - 1,078 of 1,134 signal-wallet rows are `wallets.kind='ai'` (the AI/human classifier); 4 are `human`, 52 `unknown`. The bot gate (`smart/copy-check.ts`) uses hold time, tx rate and same-block round trips, not this label.
- **Small-token signals:** Signal 724 (Vizeye, `7RDx65BJ…bonk`, 2026-10-22T22:42Z): 3 wallets, $778 = $19 + $551 + $208. The whole tape for this mint is 7 swaps by 7 wallets, 8.7 SOL; the signal's `token_age_min` = 8.2 and 6 h return +16.8%. Signals 712 and 713 (two different mints, same symbol "XUH", one minute apart, $1,226 and $1,228, 3 wallets each, `age_min` = 3e-5 and 1e-3, 6 h return about -48%): the same smart wallets bought two clone tokens.
- Signals whose mint has at most 10 distinct wallets in the tape: 7 of 192. At most 3 wallets: 0 (necessarily, since 3 smart wallets is the minimum). 2 of 192 are under 20 SOL of tape volume.

### Inferences
- A handful of swaps by a handful of wallets can produce a signal: yes, as small as 3 wallets and $500. Relevant parameters are the thresholds in `config.ts:62-66`.
- Since stream price = last swap, a thin token's "return" is whatever the next buyer/seller pays, which can be the smart wallet's own follow-up. This feeds the scorecard and (below) the learning loop. `smart_flows` returns are consumed by the follow-bar learner (`learning/adaptive.ts:105`) and the buys-tops drop rule (`smart-money.ts:269-291`), so inorganic tokens also contaminate those.

### Gaps
- The funder is unknown for 61% of signal wallets, so the 68/30 figures are lower bounds.
- I did not measure how many 6 h returns are self-referential (same wallet sets the later price).

---

## 3. Venue detection; what happens to a Meteora DBC swap

### Takeaway
Meteora DBC (`dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN`) is not a recognised program anywhere in the repo (no match in a case-insensitive grep for `dbcij3` or "bonding" across agent, shared, dashboard, scripts, README). A DBC-only transaction is never streamed. If it is streamed because Jupiter or another listed program is in the transaction, `detectVenue` labels it by that program, not as Meteora. `venue` is stored only in `wallet_swaps` and `LiveBook`, not in `smart_flows`.

### Cited Findings
- **Recognised programs** (`chain/programs.ts:7-17`): `jupiter` (JUP6…), `pumpfun` (6EF8…), `pumpswap` (pAMM…), `raydium` (675k…, CAMM…, CPMM…), `orca` (whirL…), `meteora` (`LBUZ…` DLMM, `Eo7W…` Dynamic AMM v1). **Not in the map:** Meteora DBC (`dbcij3…`), Meteora DAMM v2 (cp-amm), Moonshot, Phoenix, Lifinity and others. Precedence: `VENUE_RANK = jupiter, pumpfun, pumpswap, raydium, orca, meteora` (`programs.ts:20`). `PLUMBING` is the set of System, ComputeBudget, SPL Token, Token-2022, ATA and Memo programs (`:23-31`).
- **`detectVenue`** (`parse.ts:97-110`):
  1. Look at top-level instruction program ids. If any is in `VENUES`, return the highest-ranked label.
  2. Otherwise look at inner-instruction program ids. If none match, **return `null`**.
  3. If an inner match exists and a top-level program is neither plumbing nor a venue, return `"<venue> (via bot)"`; otherwise just `<venue>`.
- **For a Meteora DBC swap:**
  - Direct (top-level DBC instruction, plus ComputeBudget etc.): no top-level match, inner instructions are Token/System/DBC self-CPI events, so no match, and the result is **`null`** (unknown).
  - Called by a bot/router program (Photon, Axiom, Trojan, BonkBot style) that does not itself touch a listed program: also `null`.
  - Routed through Jupiter: the top level has Jupiter, so **`jupiter`** (or `jupiter (via bot)` behind a wrapper). The underlying DBC pool is invisible.
  - Through a pump.fun/Raydium instruction elsewhere in the transaction: that program's label, possibly with `(via bot)`.
  - There is no code path that produces `meteora` for DBC. The existing `meteora` label means DLMM or Dynamic AMM v1 only.
- **Where venue is stored/used:**
  - `ParsedSwap.venue` (`parse.ts:89`), `wallet_swaps.venue TEXT` (`shared/src/schema.ts:80-103`), `LiveBook.recent[].venue` (`live-book.ts:69`) and the AI/human classifier.
  - **`smart_flows` and `smart_signals` have no `venue` column** (`schema.ts:308-345`). The only way to find a flow's venue is to join to `wallet_swaps` on (signature, wallet, mint).
  - The test for venue labels is `agent/test/parse.test.ts:46-52`.
- **Database evidence that the stream never delivers unknown-venue swaps:**
  - Joining the 33,827 window flows to `wallet_swaps` gives **0 rows with a null venue** (all 33,827 matched a venue).
  - `wallet_swaps` null-venue share by day: Oct 17 16.8%, **Oct 18 36.7% (92,896 of 253,043)**, Oct 19 12.9%, Oct 20 5.1%, Oct 21 5.7%, Oct 22 0.8%, Oct 25 **0.1% (151 of 166,158)**. The early days are history backfills from RPC (`chain/history.ts`) that see every program; later days are stream-delivered.
  - Overall: 255,623 of 2,856,656 tape swaps (8.9%) have a null venue.
  - So unrecognised venues are invisible to smart flows rather than showing as "unknown".
- **Venue mix of the 33,827 window flows** (via the tape): pumpswap 26,544; pumpfun (via bot) 2,120; pumpfun 1,597; raydium 1,292; meteora 542; jupiter 411; orca 376; pumpswap (via bot) 336; jupiter (via bot) 208; meteora (via bot) 182; raydium (via bot) 163; orca (via bot) 56.

### Inferences
- A DBC-launched token appears in the feed only through the Jupiter/other-listed-program share of its trading (labelled `jupiter` or `jupiter (via bot)`). The stream therefore sees a biased and small slice of its real volume.
- Tokens that trade mostly on DBC and graduate to DAMM v2 would be seen almost only via Jupiter-routed swaps.

### Gaps
- No row in the database was identified as DBC by program id. I could not confirm that the owner's tokens used the `jupiter` label. Candidate lists for checking are in section 4.

---

## 4. Per-mint "organic-ish" statistics from the tape (smart_flows tokens, last 3 days)

### Takeaway
Of 1,296 mints with a smart flow in the window, 444 (34%) have only 1-3 wallets in the tape, 189 (15%) only one, and 259 (20%) have only smart wallets in the tape. These are mostly pump.fun curve tokens (688 of the 1,296 are `pumpfun`-dominant) and Jupiter-labelled tokens, but they carry only about 4% of flow dollars. Their effect is on feed ranking, not on volume.

### Cited Findings
Method: for the 1,296 mints in `smart_flows` with `ts >= 2026-10-22T19:09Z`, aggregate all `wallet_swaps` for that mint (whole tape, 2026-10-16 to 2026-10-26). "Smart wallet" means any address that ever has a `smart_flows` row (1,873). The tape counts only the 6,959 tracked wallets, so every count of wallets and volume is a lower bound for the real market.

Distinct tape wallets per mint (1,296 mints; median 7, mean 21.6):

| Tape wallets | Mints | Avg SOL volume | Avg swaps | Smart flows | Flow USD |
|---|---|---|---|---|---|
| 1 | 189 | 3.9 | 11 | 734 | $36,054 |
| 2-3 | 255 | 13.6 | 17 | 1,162 | $141,055 |
| 4-10 | 311 | 70.5 | 62 | 2,298 | $208,081 |
| 11+ | 541 | 863.0 | 465 | 29,633 | $4,443,949 |

Threshold counts (mints): 1 wallet: 189; at most 3: 444; at most 5: 564; at most 10: 755; at most 5 swaps: 269; at most 10 swaps: 434; under 5 SOL volume: 352; under 20 SOL: 649; top-1 wallet at least 80% of SOL volume: 306; top-3 at least 95%: 506; mints with zero sells in the tape: 15; zero buys: 53; every tape wallet is smart: 271 (259 of the at-most-3 group); smart wallets at least 95% of volume: 328. For the at-most-3 group (444 mints): 278 had all tape activity within 5 min, 396 within 1 h.

Flow dollars on mints with at most 3 tape wallets: $177k of $4.83M (3.7%); 1,896 of 33,827 flows (5.6%).

Same cut over all history (5,223 mints in `smart_flows`): 663 with 1 wallet, 1,532 (29%) with at most 3, 2,868 with at most 10, 1,059 with only smart wallets, 2,361 under 20 SOL. Of the at-most-3 mints, `pumpfun` (693 via bot + 548 direct) = 1,241, Jupiter 135, PumpSwap 72, Raydium 44, Meteora 30, Orca 7, null 3.

Venue (dominant venue of the mint's tape swaps, 1,296 mints): pumpfun (via bot) 371, pumpfun 317, pumpswap 240, pumpswap (via bot) 88, jupiter 75, raydium 48, meteora (via bot) 43, jupiter (via bot) 43, raydium (via bot) 29, meteora 19, null 9, orca 8, orca (via bot) 6. Among the 444 at-most-3-wallet mints: pumpfun (via bot) 164, pumpfun 154, jupiter (via bot) 29, jupiter 23, pumpswap 18, raydium 17, meteora (via bot) 17, raydium (via bot) 8, meteora 4, orca (via bot) 3, null 3, pumpswap (via bot) 2, orca 2. Share of mints that are at-most-3: pumpfun-dominant 318 of 688 (46%), jupiter-dominant 52 of 118 (44%), meteora-dominant 21 of 62 (34%), raydium 25 of 77, pumpswap 20 of 328 (6%).

Null / unknown venue:
- **No token in `smart_flows` has a null-venue flow** (0 of 33,827).
- 44 of the 1,296 mints have at least one null-venue swap in the tape (1,416 swaps, 2,794 SOL), but none has only null-venue swaps; these are RPC history rows for tracked wallets.

Tokens with only one smart buyer and a Jupiter label (potential DBC-through-Jupiter candidates; verify on chain):

| Mint | Symbol | Flows (buy/sell) | Tape wallets | Tape SOL | Dominant venue |
|---|---|---|---|---|---|
| `vNJrbTyZFksUrN7gfEPy1qnHkaXWsS9M78Y1QkhfEFV` | JUFF | 1 buy $1,340 | 2 | 16.5 | jupiter |
| `6isLJ1xTZo93jNFwQWJ5SDwLAzei4w2kV5fYtRmkkvrt` | sender | 4 sells $583 | 2 | 6.1 | jupiter |
| `CWZ6BsdnjkDVTGkmL6bGbJXXig6ceef12KvyGQW14cMt` | ANTFUN | 2 buys / 4 sells | 2 | 158.1 | jupiter |
| `BaHDt91i4mpVtuxfWBnSJqzEWib3cfm6S8paJGpZL3q1` | NUTCOIN | 3 flows | 3 | 8.2 | jupiter |

All of these come from queries joining `smart_flows` to the scratch aggregate. The query is `select … from f where dv like 'jupiter%' and wallets<=3 order by fbuy_usd+fsell_usd desc`.

What the feed looked like (simulation of `getSmartMoney`'s own query, top 40 by net 24h, `dashboard-data.ts:356-376`):
- At 2026-10-25T19:09Z: of the 40 tokens shown, 5 have at most 2 smart buyers, 4 have at most 10 tape wallets, 1 has at most 3, 1 has under 20 SOL tape volume, 3 have one wallet providing at least 80% of tape volume.
- At 2026-10-25T12:00Z: 7 with at most 2 smart buyers, 1 with at most 3 tape wallets, 4 with at most 10, 4 with top-1 at least 80%.
- Top rows at 19:09Z: BIRB (`G7vQWurM…`): 381 flows by 1 buyer and 1 seller, net +$24,319, Raydium. `7c52LfFG…pump` (no symbol): 2 flows, 2 buyers, net +$18,429, 3 tape wallets, 479 SOL. SpaceX (`F6k2rSmj…`): 16 buyers. BMT (`FQgtfugB…`): 384 flows, 1 buyer and 1 seller, net +$10,869. So single-wallet churn (hundreds of flows by one smart buyer and one smart seller) ranks at the top, since the sort is net USD (`dashboard-data.ts:375`).
- The Oct 23 and Oct 24 snapshots are empty or partial because the stream was down.

DexScreener presence (one-off post-hoc snapshot via `api.dexscreener.com/tokens/v1/solana/<30 mints>` on Oct 27, all 1,296 mints):

| Tape wallets | Mints | No pairs returned | Pairs with 24h vol < $1k |
|---|---|---|---|
| 1 | 189 | 149 (79%) | 26 |
| 2-3 | 255 | 209 (82%) | 25 |
| 4-10 | 311 | 177 (57%) | 54 |
| 11+ | 541 | 230 (43%) | 127 |

- **Caution:** 765 of 1,296 mints (59%) have no pairs, including tokens with thousands of SOL of tape volume (e.g. Marvin `B6y7reoJ74H6DGY3xTWnie8tv54r6NVusR4AxCjFsA2r`: 12,366 SOL, 37 smart buyers; `latest/dex/tokens` also returned 0 pairs).
- So "no DexScreener data" is also true of dead or rugged tokens whose pools have been delisted since. It cannot by itself separate "never had a market" from "had one and it died". By dominant venue: pumpfun 499 of 688 no pairs, pumpswap 162 of 328, jupiter 43 of 118, meteora 42 of 62, raydium 13 of 77.
- The no-pair mints account for 69% of window flow dollars ($3.34M of $4.83M) and 24,534 of 33,827 flows.

### Inferences
- A cheap, local, "only 1-3 wallets in the tape" test removes about 34% of mints and 3.7% of dollars, so it would clean the feed without much loss of real flow. But it undercounts real participation (tape = 6,959 wallets of a stream seeing 856,565), so a stream-wide per-mint tally (section 5) is the proper signal.
- Because the stream sees only listed-program swaps, DBC tokens look thinner than they are; a "thin" label would be partly a visibility artefact.

### Gaps
- No program-level ground truth for DBC in the database.
- DexScreener results are a snapshot after the fact and conflate dead and never-listed tokens.
- The tape is not the market: all wallet counts are lower bounds.
- Oct 23-24 have no data at all.

---

## 5. Per-token data the live stream already sees for all wallets; what a rolling per-mint tally would take

### Takeaway
The stream already sees every swap by every wallet, but GodsEye keeps per-wallet counters only (`LiveBook`, `wallet_activity`) and one per-mint record (last USD price, last-seen time, first-seen time). There are no per-mint counters. The natural hook is in `SmartMoney.onSwap` before the smart-wallet check, or in the `stream.ts:221-224` loop.

### Cited Findings
- **Per-wallet:** `LiveBook` (`stream/live-book.ts:18-39`, `:54-73`) keeps per wallet: swaps, buys, sells, volumeSol, last 60 swaps, live P&L and AI score. `wallet_activity` stores totals for 856,565 wallets (3,368,691 swaps, 2,123,930 SOL, first seen 2026-10-18T20:43Z, last 2026-10-25T19:09Z; `schema.ts:247-263`). Nothing per mint.
- **Per-mint:** only `SmartMoney.prices` (`smart-money.ts:91`, updated at `:125-129` for every swap, pruned above 200,000 entries at `:180`) with fields `usd`, `ts`, `firstSeen`. It is the one structure that already touches every mint on every swap.
- **Throughput:** `stream_swaps_per_sec` and `stream_tx_per_sec` are written to `agent_meta` at each flush (`stream.ts:261-262`) but the stored values are 0.0 now (stream down).
  - From `wallet_activity`: 3.37M swaps; if the stream was up all of Oct 18 20:43 to Oct 25 19:09 (about 596,000 s) that is about 5.6 swaps/s on average, about 7.8/s if only the 5 days with smart flows were connected.
  - Hourly distinct-wallet counts (`last_seen_at`): 61,587 wallets in 2026-10-25 18:00-19:00Z, so peaks of at least 17 wallets/s.
- **Memory and CPU:** the live book is already the heaviest structure (150,000 wallets x 200 swaps filled a 4 GB heap, `live-book.ts:15`; `guardMemory` at `stream.ts:277-286`). A per-mint tally of counters costs far less than a wallet's 60 swaps. With O(1) map operations per swap at less than a few dozen swaps per second, CPU is negligible. The number of distinct mints seen per day is not measured anywhere; `token_prices` is only watched mints (5,274 rows).

Design sketch with hooks:
- **Data per mint:** `swaps`, `buys`, `sells`, `volumeUsd`, `firstSeen`, `lastSeen`, a bounded set of distinct makers (cap about 32, then switch to a count estimate), and a top-1/top-3 wallet-volume tracker (a small Misra-Gries sketch or a 3-slot array) for concentration, plus a rolling window (for example 1 h and 24 h buckets in a ring of 24-96 slots). At about 200-400 bytes per mint, 300,000 mints is about 60-120 MB, so prune like `prices` (`:180`) and drop mints quiet for a day unless watched.
- **Hook point 1:** in `SmartMoney.onSwap`, between the price update and `if (!this.smart.has(s.wallet)) return` (`smart-money.ts:125-130`). The tally then sees all wallets' swaps with no change to `stream.ts`.
- **Hook point 2:** `stream.ts:221-224`, next to `this.book.record(swap, now)`, with a new `MintBook` class mirroring `LiveBook` (record, evict, takeDirty). This keeps `smart-money.ts` pure and follows the existing pattern; `stream.ts:231-257` `flush()` is where totals are written and `book.evict()` is called.
- **Use at signal time:** in `onSwap` after `detectSignal` (`:138-139`) and again at INSERT (`:144-146`): reject or flag the signal if the mint's tally fails the organic test.
- **Persistence:** either new columns on `smart_flows`/`smart_signals`/`token_prices` via `ADDED_COLUMNS` in `shared/src/db.ts:42-51` (with `AFTER_ADDING` for backfill), or a new `token_stats` table in `shared/src/schema.ts`. `flush()` already loops over `watched` mints to upsert `token_prices` (`smart-money.ts:170-177`); add the tally there.
- **Persisted all-wallet tallies would also allow backfilling the existing feed:** none exist today. A one-off backfill is only possible from the tape (tracked wallets only).

### Inferences
- The cost is dominated by memory for the maker set, not CPU. Bounded sketches keep it small.
- Because first-seen is per process (`firstSeen`, `smart-money.ts:127`) and not persisted for non-watched mints, a restart resets token age and tallies.

### Gaps
- Distinct-mint count per hour and day is unmeasured; I could not read the stream rate while it was down.
- I did not benchmark any memory figure; they are estimates.

---

## 6. How the website displays smart flows; existing filters; where an "organic" flag would go

### Takeaway
The feed is one SQL query plus a symbol-based filter. The Home panel shows only symbol, buyer and seller counts and net USD, and links to DexScreener. A new flag would be added in the query (or a joined table), the shared type, and the Home panel; it can be used to filter in SQL or to badge a row.

### Cited Findings
- **Query:** `shared/src/dashboard-data.ts:356-413` (`getSmartMoney`). For flows from the last 24 h it groups by mint: `buy_usd_1h/sell_usd_1h/buy_usd_24h/sell_usd_24h`, `buyers_24h`, `sellers_24h`, `first_smart_buy_at`, `last_trade_at`, `first_price` and `now_price` (`LEFT JOIN token_info`, `token_prices`). It orders by `(buy_usd_24h - sell_usd_24h) DESC LIMIT 40` (`:375-376`). The filter `!f.symbol || !isNonMemecoinSymbol(f.symbol)` (`:407`) and the same for signals (`:409`) remove known majors/wrappers. Unnamed tokens pass. `change_since_first_buy` is `now_price / first_price - 1` (`:408`). There is no filter on trader count, volume or token age.
- **Types:** `shared/src/dashboard-types.ts:386-399` `SmartFlowRow` {mint, symbol, buy_usd_1h, sell_usd_1h, buy_usd_24h, sell_usd_24h, buyers_24h, sellers_24h, first_smart_buy_at, change_since_first_buy, last_trade_at}; `SmartSignalRow` `:401-413`; `SmartMoneyData` `:441-450`. The dashboard has a mirrored copy of the types at `dashboard/lib/types.ts` and an empty default at `dashboard/lib/data.ts:32`.
- **API:** `dashboard/app/api/smart/route.ts`: local mode calls `getSmartMoney` from `lib/queries.ts`; hosted mode serves the published snapshot (`feed("smart")`). The published snapshot builds the same data (`buildDashboardSnapshot`, `dashboard-data.ts:421-435`, `smart: getSmartMoney(d)`), so an added field flows to both automatically. `apiRoute` (`dashboard/lib/api.ts`) only adds caching and error handling; the API is public and read-only.
- **Home page:** `dashboard/app/page.tsx:37-39` polls `/api/smart` every 15 s and takes `flows.slice(0, 5)` and `signals.slice(0, 3)`. Panel "Smart money flows · net 24h" (`page.tsx:111-129`): an arrow icon (green up if net >= 0), `symbol ?? shortAddr(mint)`, `"{buyers_24h} buying · {sellers_24h} selling"`, and net USD, as an anchor to `dexscreenerToken(mint)` (`dashboard/lib/format.ts:51`). The "Signals" panel (`:130-150`) shows symbol (via `TokenLink`, `components/wallet-badges.tsx:80-92`), "{wallet_count} wallets bought/dumped", age, and the 6 h or 1 h return. The Leaders page (`dashboard/app/leaders/page.tsx:16-18`, `:60-95`) shows the scorecard (hit rate by 1 h/6 h/24 h) and per-wallet lead stats. Fields such as volume, trader count, venue, age or liquidity are not shown.
- **Existing filters:** `isNonMemecoin` (mint + symbol, `shared/src/constants.ts:55-57`) and `isNonMemecoinSymbol` (`:48-52`) are used in `parse.ts:234` (mints only), `smart-money.ts:25,208` (agent side), `dashboard-data.ts:9,407,409` (display side), `copy/engine.ts:149-150`, `replay/run.ts:62-64`, `discovery/discover.ts:22`, `analysis/analyze.ts:141`. Applied twice for smart money: at arrival (when named) and at display (by symbol).

### Inferences
- Place an `organic` flag (or numeric metrics) in the `getSmartMoney` SQL via a join to a stats table, expose it on `SmartFlowRow`/`SmartSignalRow`, and either filter with `WHERE` before `LIMIT 40` (so the 40 slots are not wasted) or show a badge/"thin" tag in the Home panel next to the buyer count. Filtering at the SQL level also means `slice(0, 5)` gets the top five organic rows.
- The agent-side counterpart is the check inside `onSwap` before inserting `smart_signals`, plus the agent log line (`smart-money.ts:147-150`).

### Gaps
- I did not inspect `dashboard/lib/types.ts` line by line (assumed to re-export shared types).
- I did not check whether the website has other consumers of `/api/smart` beyond Home and Leaders.

---

## 7. Existing tests and conventions

### Takeaway
Tests use Node's built-in runner with in-memory SQLite and small hand-written swaps; the smart-money pieces are exercised as pure functions plus one end-to-end `SmartMoney` test. New code should follow those patterns.

### Cited Findings
- **Runner:** `agent/package.json:21`: `tsx --import ../shared/test/setup.ts --test test/*.test.ts`. Tests use `node:test`, `node:assert/strict`, `openDb(":memory:")` from `@godseye/shared`.
- **`agent/test/smart.test.ts` (194 lines):**
  - `detectSignal` tests: 3 wallets within an hour; too few wallets, too little money, or spread too long gives null; a wallet that buys and sells nets out; 3 dumping = exit (`:19-37`).
  - Helpers `ev(min, wallet, side, usd)` and `swap(wallet, side, usd, priceUsd, i)` build events and `ParsedSwap`s (`:41-46`).
  - `end to end` (`:48-77`): inserts wallets and `wallet_stats`, calls `copyable(db, w)` to pass the copy gate, builds `new SmartMoney(db, null)`, calls `refresh()`, feeds `onSwap` x3, `flush`, checks `smart_signals` and `smart_flows`, adds a later price and checks `evaluate()` gives the ret_1h.
  - Learning drop (`:79-91`), non-memecoin skip and purge (`:93-125`), 1,000x cap (`:127-132`), bot gate and copy gate (`:134-171`), copy replays (`:173-194`). The existing signal test uses uncorrelated wallets (no funder), so independence is untested.
- **`agent/test/stream.test.ts` (102 lines):** builds a gRPC transaction with `Keypair`s and `bs58`, checks `convertGrpcTx` parses like RPC (lookup-table key order, `venue === "jupiter"`), that votes and failed transactions are skipped, a LiveBook promotion/eviction test, `retryPlan` and `IpHunt`.
- **`agent/test/live-book.test.ts` (33 lines):** unchanged wallets are not rewritten, 60-swap cap, no signature stored, `shrinkTo` keeps promoted wallets.
- **`agent/test/parse.test.ts`:** `detectVenue` cases at `:46-52` (bot-routed pump.fun gives `"pumpfun (via bot)"`, direct gives `"pumpfun"`). `agent/test/helpers.ts` provides `swapTx({solDelta, tokenBefore, tokenAfter, programs, inner, …})`, `WALLET/MINT/POOL/JUP/PUMP`, `swap()`, `stubFetch`, `passCopyGate`, `iso`/`H`/`D`. `programs: [...]` and `inner: [...]` make it easy to test a new venue's labelling.
- **Conventions:** pure logic functions are exported and tested directly (`detectSignal`, `leadStats`, `returnPct`); config comes from `agent/src/config.ts` with `envNum("NAME", default)` and `.env.example` documentation; schema is in `shared/src/schema.ts`, with columns added later through `ADDED_COLUMNS` and `AFTER_ADDING` in `shared/src/db.ts:42-79`; user-facing log lines use `say("learn", …)`; file headers are plain-language block comments; `isNonMemecoin` sits in `shared/` so both the agent and the dashboard use it.

### Inferences
- A new organic test should be a pure exported function (for example `organicVerdict(tally, cfg)`) with tests like `detectSignal`'s, and an end-to-end case in `smart.test.ts` that feeds swaps from a non-smart wallet and checks the signal is or isn't produced.

### Gaps
- I did not run the test suite.

---

## Gaps and options

### Gaps (open questions)
1. **No ground truth for DBC.** No row in the database identifies a swap as Meteora DBC, and the repo has no DBC id. To confirm the owner's tokens' path, take one signature from `wallet_swaps` for a suspect mint (for example JUFF `vNJrbTyZ…`) and read its program ids on chain. Expected: `jupiter` or `jupiter (via bot)`, because a DBC-only transaction cannot arrive (section 3).
2. **Visibility bias.** The stream filter excludes DBC and DAMM v2, so a DBC token's activity in GodsEye is only the Jupiter-routed slice; any "thin token" test built on stream counts will over-flag these tokens unless the program list is widened.
3. **DexScreener as a label is not reliable after the fact** (59% of mints have no pairs two days later, including tokens with 12,000 SOL of tape volume). A live-time check would differ from this snapshot.
4. **Tape is not the market.** It covers 6,959 wallets, versus 856,565 seen by the stream.
5. **Data gaps.** The stream is down since 2026-10-25T19:09Z (allowlist IP rejections), there is no data for Oct 23-24, and few 6 h/24 h returns exist for the window (5,334 of 33,827 have `ret_6h`).
6. **Funder coverage.** The funder is known for 39% of signal wallets, so the sybil-cluster counts (68 and 30 of 192 signals) are lower bounds.

### Options (cheapest first; none implemented)
1. **Display-only (hours):** in `getSmartMoney` (`dashboard-data.ts:356-376`), add columns computed from the tape (distinct wallets, SOL volume, top-1 share) and drop or badge rows with at most 3 tape wallets, before the `LIMIT 40`. This is a stopgap; it undercounts real participation.
2. **Gate signals (small):** in `onSwap` before `INSERT INTO smart_signals` (`smart-money.ts:144`), require that the number of distinct smart buyers sharing no `wallets.funder` is at least `SMART_SIGNAL_WALLETS`, and tighten `SMART_SIGNAL_MIN_USD` per wallet (for example $100 each). Evidence: 68 of 192 signals include wallets sharing a funder; signal 759 was 10 wallets, $540 total.
3. **Stream-wide MintBook (medium, recommended):** per-mint rolling tally of every swap (distinct makers, swaps, USD volume, buys/sells, top-1/top-3 share, first/last seen) hooked at `smart-money.ts:125-130` or `stream.ts:221-224`, persisted into new columns on `smart_flows`/`smart_signals` or a `token_stats` table. Flag `organic` when, for example, distinct makers >= N, top-3 share <= X, volume >= Y over the window, and at least one non-smart, non-funder-linked maker is on each side. Use the flag to (a) suppress signals, (b) filter `getSmartMoney`, and (c) exclude non-organic flows from the learning inputs (`adaptive.ts:105`, `smart-money.ts:269`).
4. **Widen venue coverage (small, separate):** add DBC (`dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN`) and DAMM v2 (cp-amm) to `chain/programs.ts:7-17` (and `VENUE_RANK`) so the stream receives and labels them (`meteora` or a new `meteora-dbc`). This raises load, but makes venue-level rules possible (for example "DBC pre-graduation needs more makers").
5. **Store venue on flows (small):** add `venue` to `smart_flows` via `ADDED_COLUMNS` (`shared/src/db.ts:42-51`) so the feed and any filter can use it without the `wallet_swaps` join.
6. **Optional live-time external check (medium):** at signal time, ask DexScreener/GeckoTerminal whether the token has a pool with liquidity and volume (already available through `fetchTokenLaunch`, `market/geckoterminal.ts:206`). It is rate-limited (GeckoTerminal about 9 calls a minute per `shyft.ts` header), so keep it for the rare signal, not each flow.
