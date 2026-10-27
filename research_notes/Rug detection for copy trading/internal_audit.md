# Internal audit: what GodsEye's own data says about rugs

Database: `data/copycow.db` (read-only). Swap tape 2026-10-16 to 2026-10-26 (2.86 M swaps). Queries and the script are re-runnable: `rug_outcome_audit.ts.txt` in this folder (copy into `agent/` as a `.ts` file and run with `npx tsx`; delete it afterwards, it only resolves `@godseye/shared` from inside the workspace).

## 1. GodsEye has never bought a token, and the rug screen has never run

| Table | Finding |
|---|---|
| `positions` | 0 rows |
| `copy_trades` | 741 rows, all `real` / `buy` / `skipped`; 0 filled, 0 failed, 0 sells |
| skip reasons | 464 "wallet has 0.000 SOL, needs … — send SOL to 52Nh…pzMQ", 277 "seen Ns after the leader traded" (late) |
| `rug_checks` | 0 rows |
| `agent_log` | 0 lines mentioning a rug check |
| `proof_ledger` | 0 rows |

Why: in `copyBuy` ([engine.ts:179-207](agent/src/copy/engine.ts)) the order is non-memecoin, lateness, `roomFor` (which includes the wallet-balance check for real mode), and only then `rugCheck`. The wallet holds 0 SOL, so every buy stops in `roomFor` or earlier and `rugCheck` is never called.

Consequences for the research questions:
- Q1 (our own rug rate): unanswerable from our trades; there are none.
- Q2 (do thresholds work; false-positive cost): unanswerable; no verdict has ever been produced, so there is no pass/blocked history to compare. The 6 h cache and latest-verdict-only upsert would also have erased history.
- The whole screen (RugCheck calls, the `getTokenLargestAccounts` / funder-tracing holder checks, their timeouts and the 10 s RugCheck timeout) is unexercised live. Its latency, RPC cost and failure rate on minutes-old tokens are unmeasured.

## 2. What the tape can say: how often copyable leader entries fell hard

Universe: 22,361 buys of ≥ 0.2 SOL by the 10 wallets with `copy_weight > 0`, on 877 distinct mints (no non-memecoin filtered out). For each mint, the first leader buy ≥ 0.2 SOL is the would-be copy. Entry price = first stored swap in the 5 s to 120 s after the leader's buy (a model of our fill; 399 of 877 mints had no stored swap in that window and are dropped), leaving **478 entries**. Outcome prices come from later stored swaps by any tracked wallet.

| Group | n | fell ≥ 50% within 60 min | fell ≥ 90% within 60 min | a leader sold at ≤ 50% of our entry price |
|---|---|---|---|---|
| all | 478 | 16.5% | 1.3% | 14.0% |
| venue pumpswap | 246 | 30.1% | 2.4% | 26.4% |
| venue unknown (mostly older / routed tokens) | 232 | 2.2% | 0.0% | 0.9% |
| token age < 5 min at leader buy | 340 | 13.5% | 0.9% | 11.5% |
| token age unknown | 135 | 24.4% | 2.2% | 20.7% |
| tape thin (< 3 other-wallet swaps within ±2 min) | 131 | 26.0% | 2.3% | 23.7% |
| tape covered | 347 | 13.0% | 0.9% | 10.4% |

(Percentages for 60 min use entries with a full 60 min of data after entry; 6 h figures are similar: 1.7% ended ≤ 10% of entry.)

Per leader (≥ 15 matured entries): collapse-to-10% rate 0% for 6 of 8 leaders, 4.7% for `96JYcf2u`, 12.5% for `6L3fPsEZ` (n = 16). Tiny numbers; not a ranking.

## 3. Why these numbers understate rugs (read this before quoting them)

- The tape holds only swaps by the 6,192 wallets that have stored swaps. After a liquidity pull nobody tracked trades, so **the price series simply stops at the last pre-rug price and the collapse is never observed.** In 93.5% of entries the tape is silent within 60 min of entry (58% within 10 min), so "no drop seen" carries almost no information about 60-minute survival. Of the entries that fell ≥ 90%, the drop was seen only because someone tracked traded at the bottom.
- The 14% "a leader sold at ≤ 50% of entry price" is a better lower bound on deep drawdowns than the price-path numbers, because leaders do sell into declines. Still a lower bound: leaders who never sold (bag-holding or an unsellable token) are invisible.
- Selection: entries need a stored swap within 2 min of the leader buy. That keeps liquid, actively-traded tokens and drops 45% of mints. A token that cannot be traded at all in the first 2 min is exactly where honeypots would sit.
- The venue split (pumpswap 30% vs unknown 2%) is probably confounded with token age and launch type, not a causal venue effect. Venue is NULL for older/routed trades.
- Price is `price_sol` from swaps (includes fee and impact); a ≥ 50% move is well outside that noise.

## 4. What this means for the research

1. The existing literature figures (Chen ~76% rug pools, MemeTrans 84% high-risk) cannot be checked against our data. Our leaders buy mostly < 5-minute-old pumpswap tokens (340 of 478 priced entries), the group those studies call highest risk, but our tape cannot see the outcome.
2. Roughly one in six (16.5%) would-be copies fell by half within the hour on observed prices, and about 14% had a leader exit at half price or worse. That alone is large relative to the 35% stop-loss: a stop-loss only helps if the exit fills. Whether it fills on a rugged pool is the unknown the report must address.
3. **The cheapest way to get real rug evidence is to log, not to analyse:** run the rug screen in shadow mode on every leader buy (it is read-only and needs no SOL), append every verdict with its inputs to a history table, and sample later prices from a source that sees all trades (Jupiter/Birdeye/GeckoTerminal candles, which the agent already uses for `crash_checks`). That removes both the "never ran" and the "invisible after the pull" problems.
4. The gap between 741 skipped buys and zero fills also means the first live results will arrive only once the wallet is funded; until then, shadow mode is the only measurement path.
