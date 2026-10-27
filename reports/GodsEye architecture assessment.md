# GodsEye architecture assessment (27 Oct 2026, HEAD 4e1a0b4)

Read-only review of the code against the wallet-intelligence brief. No behaviour was changed. Counts marked "local DB" come from `data/copycow.db`, a smaller database than the server's, whose figures are in `research_notes/What counts as a smart wallet/`. Line references were checked by three separate readers of the code.

**In flight elsewhere.** Another session has uncommitted edits adding a bot / hold-time / frequency gate and a replay-based copy check for smart wallets (`agent/src/smart/copy-check.ts`, `smart-money.ts`, `pnl.ts`, `config.ts`, `schema.ts`). Phase 0 below is that work. Nothing here should duplicate it.

## 1. How a wallet becomes a copied trade, today

1. **Entry.** `addWallet` (`discovery/discover.ts:31`) inserts a row from four sources: a single trade of at least $300 in a busy pool (`top_pool_trader`), live-stream promotion at $100 profit / 3 closed / 50% wins (`live_stream`), a tracked leader funding a new account (`funded_by_tracked`), or manual. No evidence is required beyond the source rule.
2. **Reconstruction.** `analyze.ts` reads about 7 days of transactions (up to 1,000, deeper for promising wallets). `chain/parse.ts` turns balance changes into swaps and only emits one when exactly one non-stable token moves against an opposite-signed SOL/USDC leg. Plain transfers, airdrops, burns, LP adds/removes and wallet migrations produce no swap, so a balance decrease is never booked as a sale. `analysis/pnl.ts` then uses average cost, realises partial sells, and ignores sells of tokens it never saw bought.
3. **Classification.** `analysis/tiers.ts` assigns one tier, first match wins: quitter, insider, lucky streak, needs attention, proven, unrated. `analysis/classifier.ts` separately scores bot-vs-human from behaviour; it does not gate anything.
4. **Weight.** `learning/weights.ts` turns tier, 7/30-day profit, closed trades, win rate and a lead score into a `copy_weight`. Quitters and lucky streaks get 0; the top `COPY_MAX_LEADERS` (10) share the weight. `adaptive.ts` learns one number, the win-rate bar.
5. **Trade.** `copy/engine.ts` `copyBuy`: weight above 0, leader buy of at least 0.2 SOL, seen within 60 s, rug screen, budget / position / daily-loss / balance limits, then a Jupiter buy at 300 bps slippage. Exits mirror the leader's sells (at 90% or more of its balance, all of it) plus our own stop-loss, take-profit and max-hold.

## 2. Which of the five properties is tested

| Property | Tested by | Verdict |
|---|---|---|
| Profitable | `tiers.ts`, `pnl.ts`: realised USD P&L, 7 and 30 days | Yes, but gross of fees and Jito tips, open bags ignored, and the "30-day" window is really about 7 days (`HISTORY_DAYS=7`) |
| Consistently skilled | Proven tier: 10+ closed, win rate at or above the bar, best winner under 50% of winners | Weak. No significance test, no per-token returns. The learned bar has drifted to its floor (0.40) |
| Repeatable edge | Lead score (median 6 h price move after its buys, needs 10+ measured buys) | Weak. Unmeasured for most wallets; no split-window or out-of-sample test |
| Copyable | Only "copies of this leader lost 0.2 SOL in 14 days" (needs 3+ closed copies) | Missing. Phase 0 starts to fix it for smart wallets |
| Currently actionable | `pnl_7d > 0`, not quitter, 60 s lateness limit | Thin. Nothing checks that its recent trades are still copyable at our speed |

The code does treat these as different in a few places, but it never separates them into distinct evidence. A profitable bot or a launch-block insider passes all five.

## 3. Gaps against the brief

| Brief | In the code | Gap |
|---|---|---|
| States: copy / watch / ignore / block | Tier plus a 0 to 1 weight. Watch is "unrated or weight 0"; ignore and block do not exist | No explicit state, no evidence for and against, no reassessment conditions. Tier history is overwritten (`analyze.ts:257-269`), and state evidence is rewritten every run |
| Interpretable score with uncertainty | One product formula in `weights.ts:65-85`, clamped linear confidence `closed/20` | No shrinkage or intervals, no median, profit factor or drawdown per wallet, `best_trade_share` is against winners only, inputs not stored, only a prose reason |
| Data quality | `history_from`, `history_done`, `age_is_lower_bound` stored | Nothing in tiers or weights reads them: a wallet with 3 days of history is scored like one with 30 |
| Trade-level copyability | Lateness, rug screen, limits | `priceImpactPct` is fetched and never read; no liquidity or depth gate; no check of our price against the leader's; no fee-to-size check |
| Uncertain exits | Retries with in-memory backoff, no cap | A missing price skips the position, so stop-loss and max-hold never fire; no unsellable state; a leader transferring tokens out leaves the position open; reconcile only reports |
| Relationship intelligence | Funder-group size flag (`sibling_wallets`), `rotated_from` | No clustering of leaders or de-duplication of signals; a second leader's buy of a held mint is dropped silently with no record |
| Adaptive without overfitting | Follow bar, lead-score multiplier, 14-day copy loss drop | Only one learned value; the bar pools paper and real copies (`adaptive.ts:99`); no walk-forward; the median test has no significance |
| Auditable history | `weight_history`, `param_history`, proof ledger of orders, shadow log | Skips and the inputs behind each decision are not recorded; weights can't be reproduced |
| Realistic backtest | `replay/*` models delay, fees, impact, exits; shadow log measures token outcomes | Doesn't model limits or rug screen; no automated walk-forward; results aren't stored; the shadow log never feeds a decision |

## 4. Defects found along the way (small, independent of the roadmap)

1. The follow-bar learning mixes paper and real copies (`learning/adaptive.ts:99`), unlike the per-mode loss limit in `loop.ts`.
2. The one-position-per-mint check at `copy/engine.ts:187` is not scoped to the current mode, so a paper position can block a real buy.
3. Early returns at `engine.ts:186-187` leave no skip row or log line.
4. Every "30-day" stat and label is really since `history_from` (about 7 days; the RPC returns only about 2 to 3 days of old transactions).
5. Wallet P&L ignores fees and tips while GodsEye's own P&L is net, so a wallet's profit and our results aren't comparable. The standing rule is net of fees.
6. Event evidence outlives the tier it justified (local DB: 11,322 `early_entry` rows for 1,340 insiders).
7. Comment drift: `schema.ts:48` omits `live_stream`; `config.ts:59` says 55% wins where the code uses the bar plus 5 points.

## 5. Proposed order of work

Each phase is small, tested, and leaves the live path unchanged until its own switch is turned on. Measure first, enforce second.

| Phase | What | Why now | Touches |
|---|---|---|---|
| 0 | Bot / hold-time / frequency gate and replay copy check (in flight) | Evidence says all 10 copied leaders are bot-classified, and some lose heavily at a 5 s delay | Another session |
| 1 | **Decision audit trail.** Append-only `wallet_evaluations` (state, tier, weight, score inputs and components, data-quality fields, reasons for and against, reassess conditions) and `copy_decisions` (the ordered checks and their results per leader buy, including skips) | Everything later needs it: calibration, walk-forward, "why did we not copy this". No behaviour change | `learning/loop.ts`, `analysis/analyze.ts`, `copy/engine.ts`, schema |
| 2 | **Wallet state layer.** Derive copy / watch / ignore / block from tier, weight, data quality and Phase 0 results, with evidence both ways, expiry, and a separate permanent-exclusion list (the existing `IGNORE_WALLETS`) | Gives the brief's states without a second competing system | `tiers.ts` (read-only use), new `wallet-state.ts` |
| 3 | **Trade copyability gate in log-only mode.** From the Jupiter quote: price impact, size against pool depth, our price against the leader's, fee-to-size. Fail closed on a missing quote. Calibrate against the shadow log and replay, then enable | Closes the biggest pre-buy hole (impact and drift are never checked) | `copy/engine.ts`, `copy/executor.ts`, shadow log |
| 4 | **Uncertain-exit rules.** Price fallback from a sell quote; bounded persisted retries; `unsellable` and `written_off` states; flag leader transfers as "unknown" instead of ignoring; mode-scope fix | Positions can currently sit past their stop with no price | `copy/engine.ts`, `copy/recovery.ts` |
| 5 | **Signal independence.** Cluster leaders (shared funder, repeated co-buys) and record corroboration instead of dropping a second leader silently | Avoids ten related wallets counting as ten confirmations | new `relationships.ts`, `engine.ts:187` |
| 6 | **Scoring with uncertainty.** Fees netted, per-token returns, median, profit factor, drawdown, concentration net of the best trade, shrinkage, honest windows | Needs Phases 1 and 0 to be calibrated rather than guessed | `pnl.ts`, `weights.ts` (overlaps Phase 0) |
| 7 | **Walk-forward harness.** Choose wallets using only data before a cut-off, replay after it, compare with a no-trade baseline and a top-by-profit baseline, store the results | Settles whether any of the above helps | `replay/*` |

## 6. Decisions needed

- **Insiders.** The brief lists creator and allocation advantages as something a follower cannot reproduce, and a block category. The standing decision is that insider-pattern wallets stay copyable and are not put in a separate tier. The proposal keeps both: an insider can be in the copy state, and a per-trade check decides whether this trade is copyable. Say if you want it otherwise.
- **Brief scope.** The pasted brief ends in the middle of section 12 ("Performance by"). If there were further sections, paste them.
- **Start point.** Phase 1 is the recommended start. Phase 3 in log-only mode is the next most valuable and can start alongside it.
