# Golden feature vectors

`entry.json` and `exit.json` pin the brain's input vectors (`brain/spec/features.yaml`, version in
`feature_spec_version`); `filter.json` pins the trailing "ok price" filter that marks the ring's `ok` flags. The
Python side (`brain/brain/features/`) and the server (`agent/src/brain/features.ts`, `state.ts`) must both reproduce
every case to 1e-6 (the filter's flags exactly). Regenerate after a spec change with

```bash
/Users/srinjoydas/miniconda3/envs/godseye-brain/bin/python -m brain.features.golden
```

The cases are hand-made in `brain/brain/features/golden.py`; every name and number is made up (no real wallets, coins
or social data). `tests/test_features_golden.py` fails when the files are stale.

## File layout

```json
{
  "feature_spec_version": 1,
  "head": "entry",
  "features": ["cp_lrshr_7d", "..."],
  "columns": ["cp_lrshr_7d", "cp_n_7d", "cp_win_7d", "cp_win_7d_missing", "...", "venue_group=pumpswap", "..."],
  "categories": {"venue_group": ["pumpswap", "...", "other"]},
  "norm": {"mean": [], "std": []},
  "cases": [{"name": "...", "note": "...", "input": {}, "expected": {"gate": null, "raw": {}, "vector": []}}]
}
```

- `features`: the spec's features in order. `columns`: the model's input columns (features.yaml
  `conventions.vector_layout`): a onehot feature becomes `<name>=<level>` in `categories` order, a feature with
  `missing_flag` is followed by `<name>_missing`.
- `categories` and `norm` are FIXED, made-up values for these tests (not a trained model's); a real bundle carries its
  own in `manifest.json` (`entry.categories`, `entry.norm`). They are chosen so that some cases hit a level outside the
  list (`orca`, `meteora_other`, `other` venues), which must map to `<name>=other`.
- `expected.raw`: each feature's raw value before any transform; `null` = missing. `venue_group` is the level string.
- `expected.vector`: the normalised vector, aligned with `columns`. `expected.gate` (entry only): the first hard gate that
  fires, or `null` when the signal reaches the network.

## Entry case input (the server's state when it decides)

Times: ISO strings (`2026-11-10T12:00:00.800Z`) where the server reads a DB row, epoch ms numbers for in-memory state.
Compare times as integer epoch ms (JS `Date.parse`): several cases sit exactly on a window edge.

| key | shape | from |
|---|---|---|
| `now` | ISO | decision time t |
| `swap` | `{wallet, mint, side, sol_amount, price_sol, token_amount, token_balance_before, venue, fee_lamports, ts, signature}` | the incoming leader buy; `ts` (block time) is T |
| `ring` | `[{wallet, side, sol, price, ts, at, ok}]` (ms) | `StreamState` ring of the coin (`at` = when it arrived) |
| `hist_max` | `{price, ts, at}` (ms) or null | the coin's highest ok price that left the ring |
| `first_seen` | `{firstSeenAt, firstOkPrice, firstOkAt, creator, creatorResolvedAt}` (ms) or null | `StreamState.firstSeen(mint)` / `brain_token_first_seen`; `creator` null = not looked up, `""` = none found |
| `leader_holding` | `{buyTs, postBuyTokens, soldTokens}` or null | `StreamState.leaderHolding(leader, mint)` |
| `active_wallets_1h` | number or null | `StreamState.activeWallets1h(t)` |
| `screen` | `{failed, lp_locked_pct}` or null | the paper screen, if it returned before t |
| `db.wallet_swaps` | `[{mint, side, sol_amount, ts}]` | the leader's rows in `wallet_swaps` (the scan filters `[T - 7 d, T)`) |
| `db.token_info` | `{pool_created_at, launch_checked_at}` or null | `token_info` row of the coin |
| `db.creator_coins` | `[{mint, first_seen_at}]` | `brain_token_first_seen` rows with the coin's creator |
| `db.social_scores`, `db.social_model_version` | `{score, model_version, updated_at}` or null; string or null | `social_scores` row of the leader; the live social model |
| `ledgers.mirror` | `[{resolved_at, y, lr}]` | `mirror_ledger` rows of the leader |
| `ledgers.ps` | `[{avail_at, r, done}]` | `ps_ledger` rows of the leader |
| `ledgers.dd` | `[{avail_at, dead, done}]` | `dd_ledger` rows of the leader |

The inputs hold rows on both sides of every window edge; the feature code applies the windows itself (swaps by block
time `[T - W, T)` and delivered before t; ledger rows by availability time `[t - W, t)`).

The leader's `wallets` row is not an input: a buy is a signal only when its wallet is analyzed (in `wallets`), which the
runtime checks before it computes anything (offline that is `known_at_t`). Its copy weight sizes only the Baseline
account. The coin's first-seen and creator rows are `first_seen` (the mint's own `brain_token_first_seen` row) and
`db.creator_coins` (the creator's other rows).

## Exit case input

| key | shape | from |
|---|---|---|
| `now` | ISO | decision time t |
| `position` | `{leader, mint, tokens, tokens_left, venue}` | `brain_paper_positions` |
| `state` | `{ret_now, peak_ret, minutes_held, leader_sold, half_sold, minutes_since_price, quote_failed, mins_since_tracked_price, sell_quote_ratio, ret_5m_ago, leader_sold_frac, minutes_since_leader_sold}` | `paper.ts` `ExitState` (`null` = missing) |
| `ring` | as above | the coin's ring at t (`oth_*`, `pts_5m` over `[t - 5 min, t)`, delivered before t) |
| `active_wallets_1h` | number or null | `StreamState.activeWallets1h(t)` |
| `leader_ps_r_7d` | number or null | the entry decision's `ps_r_7d`, kept with the position |

## Cases

`entry.json`: a typical copy; bot leaders (a flipper, sold before the decision, sold more than held, holding unknown);
first sightings (never seen, seen by this very swap, a pumpswap one that the young_amm gate stops); every gate and its
edges (young_amm on several venues and exactly at 10 min, pumpswap_hiprice just above and below, below_min, too_late,
screen failed / unlocked / passed); venue levels (missing, unseen `orca`, `jupiter`, an unknown string); window edges of
the ledgers, the leader scan, the 5-min ring, the highs (on block time, not arrival) and the creator count; missing
prices, fees, creators, token times, hourly counts; social live / stale / other model; an age past the cap; a first ok
price from this second; a clock near midnight. `exit.json`: holding in profit, the leader partly out, a dead coin with
no route, after sell_half, a pumpswap entry, clipped moonshots, missing carried values, a position written down to zero,
flow window edges, a position with no tokens recorded, a position 45 s old.

## filter.json: the trailing price filter

The ring cases above give `ok` as an input; the server computes it with `TrailingFilter` (`agent/src/brain/state.ts`).
`filter.json` pins that rule (features.yaml `conventions.tracked_swap`, `derive.build_prices` offline,
`brain/brain/features/prices.py` as a one-swap-at-a-time reference):

```json
{"window": 10, "outlier_x": 10.0, "min_sol": 0.001, "min_tokens": 1.0,
 "cases": [{"name": "...", "note": "...", "input": {"swaps": [{"wallet": "...", "price": 1e-7, "sol": 0.2, "tokens": 2000000.0}]},
            "expected": {"ok": [true]}}]}
```

Each case is ONE coin's swaps in arrival order, fed to a fresh filter; `expected.ok` is the flag of each swap, exact
(booleans, no tolerance). The rule: valid = price > 0, sol >= `min_sol`, tokens >= `min_tokens`; a valid price is ok
when it is within `outlier_x` (inclusive) of the median of the coin's previous `window` VALID prices (the first valid
price is ok) and it is not lone (among those previous prices no print by another wallet is within `outlier_x` of it
while at least one by another wallet is not). Every valid price enters the window, ok or not: a filter that keeps only
the prices it accepted fails `rug_heals_on_the_7th_print`, `pump_heals_on_the_6th_print` and `window_is_ten`. The median
of an even count is the mean of the middle two.
