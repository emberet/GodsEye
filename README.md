# GodsEye — Sees every wallet. Copies the winners.

**GodsEye** copy-trades Solana wallets, AI agents and humans alike, and always sides with whoever is making money right now. It also keeps a **public wallet database**: every wallet it studies gets a tier (Insider pattern, Lucky streak, Needs attention, Quitter, Proven, Unrated) and an **AI / bot or Human** verdict, with the evidence on show.

> ⚠️ **Real money by default.** `COPY_MODE=real` means copy trades spend real SOL from GodsEye's wallet. Limits are on by default (0.1 SOL per trade, 1 SOL in total, stop for the day after 0.5 SOL of losses). Set `COPY_MODE=paper` to simulate. Pause new buys any time with `npm run pause`.

---

## 1. How it works

```
 Discovery ──▶ Analysis ──▶ Learning loop ──▶ Copy engine
 (find wallets)  (P&L, tier,     (who to copy,      (watch leaders live,
                  AI or human)    how much)          copy buys & sells)
                       │                                   │
                       └────────── public dashboard ◀──────┘
```

| Step | What happens | Code |
|---|---|---|
| **Live stream** (gRPC, optional) | Streams every confirmed swap on pump.fun, PumpSwap, Raydium, Orca, Meteora and Jupiter. Every trading wallet gets a live P&L and live AI/human score (**Live Stream** page); wallets making ≥ $100 over ≥ 3 closed trades are promoted to full analysis; leaders' swaps reach the copy engine instantly. Works with Shyft, Triton, Helius or QuickNode gRPC (`GRPC_URL`, `GRPC_TOKEN`). | `agent/src/stream/` |
| **Smart money** (live) | Follows where wallets that make money are putting it. Smart money = analyzed wallets with a track record plus wallets winning big on the stream right now, minus **bots** (median hold under 15 s, over 20 transactions an hour, or buying and selling in the same block) and wallets that **copying wouldn't have paid on** (the copy-fill replay at GodsEye's real delay must show a positive median return). Every trade they make is recorded; 3+ smart wallets buying (or dumping) the same token within an hour is a **signal**, but only if the token has **real, independent demand**: the live stream keeps a tally of every swap by every wallet, and a token whose trading comes from a handful of wallets, one wallet or wallets buying and selling the same amounts back is judged *thin* or *wash*; wallets that share a funder count as one voice; and a token whose pool Jupiter shows as empty (a drained Meteora bonding-curve pair, say) is left out. Tokens judged thin or wash are hidden from the feed and its signals; too-early ones are marked *not verified yet*. Thresholds are first guesses (`ORGANIC_*`). 1, 6 and 24 hours later GodsEye measures what the price did, so it **learns** which signals work and which wallets actually lead price; wallets whose buys keep dropping stop counting as smart, and lead scores scale copy weights (0.5×–1.5×). Shown on **Home** (where smart money is moving, signals), on wallet pages, and under **Copying → Who it copies** (what GodsEye has learned). | `agent/src/smart/` |
| **Discovery** (every 30 min) | Reads the latest big trades in Solana's busiest and trending pools (GeckoTerminal) and adds every new wallet, including wallets created minutes ago. Also adds any brand-new wallet a tracked wallet sends SOL to (a trader moving to a fresh wallet). | `agent/src/discovery/` |
| **Analysis** (every 10 min) | For each wallet: reads its transactions, keeps SOL-priced swaps, finds its first transaction (age, **fresh** or not, **who funded it**), looks up when each token it bought launched, computes realized P&L, then assigns a **tier** and an **AI / human** verdict. | `agent/src/analysis/` |
| **Learning loop** (every 15 min) | Re-weights every wallet by recent profit (USD at settlement). Only wallets with a track record are eligible: Proven tier, or ≥ `MIN_CLOSED_FOR_PROVEN` (10) closed trades in 30 days, never a Lucky streak, and a win rate at or above the **follow bar**. The follow bar isn't fixed: every cycle GodsEye looks at how following worked out (its own copy trades, or until there are enough, the 6-hour result of every smart-wallet buy), grouped by the leader's win rate, and moves the bar toward the lowest level that still paid, at most 5 points per cycle, within 40–80%. Losing this week → weight 0 at once. Also learns from GodsEye's *own* results: if copying a wallet lost money (late entries, slippage), it's dropped. Bots and wallets the copy-fill replay says don't pay at GodsEye's delay are never copied (the same gates as smart money). Only the top `COPY_MAX_LEADERS` earners are copied. | `agent/src/learning/` |
| **Copy engine** (live) | Subscribes to each leader's transactions. Leader buys → GodsEye buys (sized by weight). Leader sells X% → GodsEye sells X%. GodsEye's own stop-loss / take-profit / max-hold run every minute. | `agent/src/copy/` |

### Wallet tiers (first rule that matches wins)

| Tier | Rule |
|---|---|
| 💤 **Quitter** | No swaps for `QUIT_AFTER_DAYS` (7). |
| 🕵 **Insider pattern** | Any of: it created the token, or was funded by the token's creator, and traded it · ≥ 3 profitable positions that started in a token's first 10 minutes, with ≥ 40% of its buys that early · repeatedly sold near the top right before a crash (the token fell ≥ 50% within an hour of the sale, checked with 15-minute price candles), at least 3 times and in ≥ 25% of its closed trades. |
| 🍀 **Lucky streak** | Profitable, but one trade made ≥ 70% of the profit, or fewer than `MIN_CLOSED_FOR_PROVEN` (10) closed trades. |
| ⚠ **Needs attention** | A winner losing this week · a brand-new wallet buying ≥ 3 SOL a trade · one funder behind 5–24 tracked wallets · funded by a tracked wallet (possible rotation). |
| 🏆 **Proven** | Profitable over 30 days and this week, ≥ 10 closed trades, ≥ 50% wins, no single trade > 50% of profit. |
| · **Unrated** | Too few trades, or not profitable. |

Every rule that fires stores **evidence** (with the transaction link) that's shown on the wallet's page. The site calls it an "Insider *pattern*" on purpose: these are automated reads of on-chain behaviour, not accusations.

### AI / bot or Human?

Each wallet starts at 50 and gains or loses points for behaviour, each with a reason shown publicly:

| Signal | Points |
|---|---|
| ≥ 120 transactions per hour, swaps or not (faster than anyone can click) | +30 (≥ 30/h: +10) |
| Trades around the clock, no daily quiet window (≥ 2 days, ≥ 20 swaps) | +25 |
| Bought tokens within 10 s of launch (≥ 2 times) | +20 |
| > 100 swaps per active day | +20 |
| Clockwork timing between trades | +15 |
| Same buy size every time | +15 |
| Bought and sold within a minute (≥ 3 times) | +15 |
| Jito tips on ≥ 70% of trades · calls DEX programs directly | +10 each |
| A 6h+ quiet window every day (sleep) | −20 |
| < 10 swaps per active day | −10 |
| Mostly round-number buys like 0.5 / 1 SOL | −10 |
| Mostly trades through a trading-bot app | −5 |

≥ 65 → **AI / bot**, ≤ 35 → **Human**, between → **Undecided**. Fewer than 8 swaps → Undecided, unless the transaction rate alone gives it away. On-chain, an AI agent and a scripted bot look the same, so "AI / bot" means *a program is placing the trades*.

### Fresh wallets and groups

Every wallet's first transaction tells GodsEye when it was created and who sent it its first SOL. Wallets with the same funder form a **group** (the **Fresh Wallets** page), which is how one trader running many new wallets shows up. A funder behind 25+ wallets is treated as a likely exchange.

### Never signing blind

GodsEye builds swaps with Jupiter's API, but **checks every transaction before signing** (`agent/src/copy/verify.ts`):
1. **Static check:** GodsEye is the fee payer and the only signer; only Jupiter and plumbing programs at the top level; plain SOL transfers may only go to GodsEye's own wrapped-SOL account; token instructions may only sync or close GodsEye's own accounts; the priority fee is within the limit.
2. **Simulation:** a buy must cost no more than planned and deliver at least the quoted minimum of tokens into GodsEye's own account; a sell must return at least the quoted minimum SOL.

After a trade lands, GodsEye records what *actually* happened on-chain, not what the quote said. Every decision is also written to the hash-chained **Proof Ledger** before it's executed.

---

## 2. Commands

Install **Node.js 20+** from https://nodejs.org, then in this folder:

```bash
npm install
npm run setup          # creates .env — open it and add HELIUS_API_KEY at least
```

| Command | What it does |
|---|---|
| `npm run agent` | Run GodsEye: discovery, analysis, learning and live copy trading. Leave it running. |
| `npm run dashboard` | The website at http://localhost:3000 (run in a second terminal). |
| `npm run wallet` | GodsEye's wallet address (send SOL here to fund real copy trading) + balance. |
| `npm run status` | Is GodsEye alive? Results, tier counts, who it's copying. |
| `npm run pause` / `npm run resume` | Stop / restart new copy buys. Sells and safety exits keep working. |
| `npm run discover` | Find new wallets once. |
| `npm run analyze` | Analyze the next batch of wallets once. |
| `npm run analyze -- <address>` | Add any wallet and analyze it now (prints its tier, AI/human reasons, evidence). |
| `npm run learn` | Run the learning loop once and print the weights. |
| `npm run replay` | What would copying each leader have earned at a 1–120 s delay, with fees and price impact? Read-only; `-- <address>`, `-- --top 30`, `--delays`, `--size`, `--fee-bps`, `--depth`, `--until-days`. Model and limits: `agent/src/replay/model.ts`. |
| `npm run shadow` | The shadow log: every token a leader bought, rug-screened on arrival (raw inputs kept) and followed for 24 h with price, liquidity and a Jupiter sell quote, **with or without SOL in the wallet**. Prints how fully it's following and how tokens fared by verdict and by each cutoff. Read-only; `-- --days 30`, `-- --json`. Filled by the running agent; off with `SHADOW_ENABLED=false`. Nothing in it is shown on the website. Code: `agent/src/shadow/`. |
| `npm run pool` | What a token's contract and pools look like, from chain: `-- <token mint>` shows its token program, authorities, Token-2022 extensions and transfer fee, then each pool a buy would go through (found with a Jupiter quote) with its reserves, price and the SOL that can be sold in before the price falls 10 / 20 / 50%. `-- <mint> --size 0.5` quotes another size; `-- --pool <address>` reads one pool. Decodes pump.fun curves, PumpSwap, Raydium AMM v4 / CPMM / LaunchLab, Meteora DAMM v2 and the Dynamic Bonding Curve; says "not read" for the rest. Read-only. Code: `agent/src/pools/`, `agent/src/market/mint-profile.ts`. |
| `npm run audit` | The decision audit trail. After each learning run the agent records, for every wallet that changed, its state (copy / watch / ignore / block), the rule that decided it, every number the weight came from, how much of its history was really seen, the evidence for and against, and what would change it. For every leader buy it considered, it records each check in order and the outcome, including skips that `copy_trades` throttles. A **log-only copyability gate** also quotes each candidate at GodsEye's size (price impact, drift from the leader's price, buy-then-sell loss, fees, and how much the pool it buys from could take back before the price falls 20%, read from the pool on chain) and stores what it *would* have decided; it changes no copy. `-- wallet <address>` explains one wallet over time; `-- why <signature or token>` shows every check on a buy; `-- --days 30`, `-- --json`. Off with `AUDIT_ENABLED=false` / `GATE_LOG_ENABLED=false`. Not shown on the website. Code: `agent/src/audit/`. |
| `npm test` | Run the tests. |

### Going live, in order

1. Add your RPC to `.env`: `SOLANA_RPC_URL` (e.g. Shyft `https://rpc.shyft.to?api_key=…`) or `HELIUS_API_KEY`. The public RPC is too slow for analysis (about 3 minutes per wallet). With a gRPC plan, also set `GRPC_URL` and `GRPC_TOKEN` to watch every swap live.
2. Optional but recommended: start with `COPY_MODE=paper` for a few days to see who GodsEye would copy, on the **Who GodsEye Copies** and **Live Copies** pages.
3. `npm run wallet` → send SOL to that address (budget + reserve, e.g. 1.1 SOL). **Back up `data/wallet/godseye-keypair.json`**: that file *is* the wallet.
4. `COPY_MODE=real`, then `npm run agent`. GodsEye copies nobody until the learning loop finds wallets that are actually profitable, usually after the first few analysis runs.

---

## 3. The website

| Page | Shows |
|---|---|
| **Home** | Status, GodsEye's realized P&L and win rate, tier counts, who it's copying, open positions, live log. |
| **Live Stream** | Stream health (transactions/sec, wallets in memory) and every wallet seen swapping: live P&L, live AI/human, whether it's been promoted to a full analysis. |
| **Wallet Database** | Every wallet: search by address or funder, filter by tier / AI-human / fresh, sort by P&L, weight, AI score… |
| **Wallet page** | Tier and why, evidence with transaction links, AI/human score breakdown, stats, recent swaps, sibling wallets, GodsEye's weight history and copy results for it. |
| **Fresh Wallets** | New wallets grouped by funder, with AI / human counts. |
| **Who GodsEye Copies** | Current weights, why, and every promotion and drop by the learning loop. |
| **Live Copies** | Open positions, every copy decision (filled / skipped / failed, with reasons and delay), closed positions, rug checks. |
| **Performance / Proof Ledger** | Equity curve from closed copies; tamper-evident decision log you can verify in the browser. |

### Host it on Vercel

Vercel can't see GodsEye's database, so GodsEye publishes the dashboard data to a free **Turso** database after every job (wallet pages only when they change), and the site reads it with a read-only key.

1. https://turso.tech → create a database `godseye` → copy its URL. Create two tokens: **full access** (for GodsEye) and **read only** (for Vercel).
2. On GodsEye's computer, put `TURSO_DATABASE_URL` and the full-access `TURSO_AUTH_TOKEN` in `.env`, then run `npm run publish-dashboard`.
3. On Vercel: set `TURSO_DATABASE_URL` + the **read-only** `TURSO_AUTH_TOKEN`, Root Directory = `dashboard`, then redeploy.

---

## 4. Honest notes

- **Copy trading memecoins is very risky.** A wallet's past profit says nothing about its next trade, and GodsEye always enters *after* the leader, at a worse price. The learning loop drops wallets whose copies lose money, but that only happens after some losses.
- **P&L is in USD, each trade valued when it settled.** A memecoin bought or sold for SOL is worth SOL × SOL's price at that moment (live Jupiter price for the last 90 minutes, hourly SOL/USDC closes before that, ~40 days back); USDC/USDT legs are their exact dollar amount; memecoin ↔ memecoin swaps that route through SOL are valued at the SOL that moved between the pools. So SOL's own price swings never show up as trading profit. SOL figures are kept alongside. Non-memecoins (wrapped BTC/ETH, staked SOL, EURC, big DeFi tokens), token ↔ token swaps with no SOL hop, plain SOL ↔ USDC conversions and trades whose SOL price is unknown are left out rather than guessed. Analysis reads the last 300 transactions of a wallet, then everything new.
- **"Launch-minute" buys** use the token's first pool on GeckoTerminal. If GeckoTerminal doesn't know a token yet, those buys simply aren't counted as early.
- **Creator links** use RugCheck's report of who created a token. The funder of very old wallets is often unknown (GodsEye reads at most ~3,300 transactions back).
- **The live stream stores running totals for every wallet** (`wallet_activity`, kept 30 days) but full swap history only for wallets in the database. Live P&L only counts swaps seen since GodsEye started watching, so it's a quick filter, not a verdict; promoted wallets get the full analysis.
- **Labels are automated guesses**, shown with the evidence behind them. They're a reason to look closer, not a verdict about any person.
- **GodsEye's hot wallet** is a key file on the machine running it. Only fund it with what you're prepared to lose, and keep that machine secure.
- Nothing here is financial advice.

## 5. For developers

- Node workspaces: `shared` (database, tiers, dashboard data), `agent` (GodsEye), `dashboard` (Next.js 14). One `.env`, one SQLite DB at `data/godseye.db` (WAL mode, so the dashboard reads while the agent writes).
- Swap parsing works from balance changes, not DEX-specific instruction formats: `agent/src/chain/parse.ts`.
- Pure, tested logic: `analysis/pnl.ts`, `analysis/classifier.ts`, `analysis/tiers.ts`, `learning/weights.ts`, `copy/verify.ts`.
- Proof ledger: `hash = sha256(prev_hash + "|" + canonical_json_payload)` (`shared/src/proof.ts`).

## Quant layer (Python, offline)

`quant/` is an offline batch job that judges whether each wallet's record is skill or luck and writes
fractional-Kelly sizing parameters. It never signs, never holds keys, and is never in the buy path: it reads
the SQLite DB through a read-only (`mode=ro`) connection and writes only its own two tables
(`wallet_skill`, `sizing_params`, declared for TypeScript in `shared/src/quant-schema.ts`) through a short
separate write connection. It reads `closed_trades` and, if that table is missing, rebuilds the same round
trips from `wallet_swaps`.

Per wallet (30-day window, 30 closed trades minimum): binomial test of win rate against matched random
entries in the same tokens, permutation test of entry timing within each token's window, bootstrap CI on
median return, Deflated Sharpe Ratio given the number of wallets tested, Benjamini-Hochberg FDR across
wallets, out-of-sample persistence (first half vs second half), Beta shrinkage of win rate, and a penalty for
profit concentrated in one trade. `verdict = 'skill'` needs FDR significance AND persistence AND the minimum
sample AND best-trade share <= 50%. Sizing is quarter Kelly at most (`kelly_mult <= 0.25 x kelly_full`,
never below 0, 0 for thin or negative-edge data), with drawdown and bootstrap risk-of-ruin estimates.
Rows are valid for 6 hours.

```sh
cd quant && python3 -m venv .venv && .venv/bin/pip install -e ".[dev]"
.venv/bin/python -m quant.run --dry-run   # compute, write nothing
.venv/bin/python -m quant.run             # write wallet_skill + sizing_params
npm run quant                             # same, from the repo root
.venv/bin/pytest -q && .venv/bin/ruff check .
```

Schedule it hourly with cron (`0 * * * * cd /opt/GodsEye/quant && .venv/bin/python -m quant.run >> ../data/quant.log 2>&1`)
or the systemd units in `quant/deploy/`. Settings are env vars `QUANT_<NAME>` (see `quant/quant/config.py`);
`QUANT_KELLY_FRACTION` is refused above 0.25.

The agent uses the results only when you opt in:

| Env | Default | Effect |
| --- | --- | --- |
| `QUANT_SIZING` | `off` | `shadow`: logs the quant size next to the real one, changes nothing. `on`: size = min(current size, hard cap, `COPY_MAX_TRADE_SOL`, budget x weight x `kelly_mult`) from a fresh row only, otherwise the current formula. It can only reduce a size. |
| `QUANT_SKILL_GATE` | `off` | `on`: a leader whose verdict is `luck` gets weight 0. |

### Data layer and discovery (phase 1)

- **`closed_trades`** (`shared/src/schema.ts`, `shared/src/closed-trades.ts`): every closed round trip, materialised from `wallet_swaps` with the same average-cost logic as the wallet stats (`realize` in `agent/src/analysis/pnl.ts`). Backfilled once at agent startup (meta key `closed_trades_backfill_v1`; rerun any time with `npm run backfill:closed`, which only upserts, so it is idempotent), then kept current every time a wallet is analysed. Unique on `(wallet, mint, entry_ts)`, indexed on `(wallet, entry_ts)` and `(mint, entry_ts)`.
  - Units: `wallet_swaps.ts` is ISO-8601 UTC text; `entry_ts`/`exit_ts` are **Unix epoch seconds**. `entry_sol`/`exit_sol`/`pnl_sol` in SOL, `return_pct = pnl_sol / entry_sol * 100`. `jito_tip_entry` is the opening buy's `wallet_swaps.jito_tip` flag (1/0). `token_age_sec_at_entry` is null when the launch time is unknown.
  - Entry timing: `entry_price_rank` (0..1) is the share of the token's observed swap prices (all tracked wallets, first observation up to the exit) below the entry price; null with fewer than 5 observations. `token_prices` only stores the latest price per token, so the path comes from `wallet_swaps`. `pool_age_pct` is not stored: pool lifetime isn't observable from the data GodsEye keeps.
  - `closed_trades` is never pruned, so round trips outlive their raw swaps.
- **Wider discovery** (all in `.env`): `DISCOVER_POOLS=40` (was 12), `DISCOVER_MAX_NEW_PER_RUN=100` (was 25), `ANALYZE_PER_RUN=90` (was 60), `ANALYZE_CONCURRENCY=12` (was 8), stream promotion at `STREAM_PROMOTE_PNL_USD=50` over `STREAM_PROMOTE_MIN_CLOSED=2` (was $100 over 3), with hard floors of $25 and 2 trades.
- **RPC guard** (`agent/src/chain/rpc-budget.ts`): `RPC_MAX_RPS` is unchanged. `RPC_COPY_RESERVE=0.2` keeps 20% of it for the copy engine: history reads are paced at the remaining 80%, and slow further while copy calls run above their share. Copy calls are never delayed.
- **SQLite hygiene**: daily housekeeping at `PRUNE_CRON` deletes `wallet_swaps` older than `SWAPS_RETENTION_DAYS` (90; 0 = keep; copied wallets and open-position leaders are kept) and stale `wallet_activity` rows (`ACTIVITY_RETENTION_DAYS`), then runs a passive WAL checkpoint (also after each analysis run and the backfill). New indexes: `wallet_swaps(mint, ts)`, `wallet_swaps(ts)`, `wallet_activity(promoted, last_seen_at)`.

### Backtest kernel and money flow (phase 4, Rust, offline)

`rust/ingest/crates/ge-flow` (binary `ge-analyze`) reads the DB **read-only** (`mode=ro` + `query_only`) and writes
only two new tables, `backtest_results` and `wallet_clusters` (`CREATE TABLE IF NOT EXISTS`), in one short write
transaction at the end (`--dry-run` writes nothing). It never signs, sends or touches the network.

- **Backtest** (`src/backtest.rs`): a port of the TS copy-fill replay (`agent/src/replay/model.ts`): the token's stored
  swaps as a price tape, constant-product depth estimated from the tape, our fill `--delay` s (default 5) after the
  leader's swap, fixed size `--size` (0.1 SOL = the `COPY_MAX_TRADE_SOL` default), DEX fee `--fee-bps` (100), an extra
  adverse `--slippage-bps` (100) on each of our fills, 0.0005 SOL per transaction, the leader's sells mirrored
  proportionally (>= 90% = all), and the agent's stop-loss 35% / take-profit 300% / max-hold 48 h on a one-minute grid.
  Rug/holder checks and budget/position/daily-loss limits are not replayed. Per leader (wallets with >= 5 closed trades):
  `n_trades`, `copy_return_pct` (sum P&L / sum cost), `copy_pnl_sol`, `ideal_return_pct` (leader's own fills, no costs),
  `win_rate`, `max_drawdown` (**SOL**, peak-to-trough of cumulative copy P&L), and the assumptions used.
  The tape only holds swaps GodsEye stored, so delay costs are a lower bound.
- **Money flow** (`src/flow.rs`), per wallet in `wallet_clusters`:
  - *follower*: >= 3 mints (and >= 30% of its mints) first bought 2-120 s after the same other wallet, and more than
    twice as often as the reverse. `follows` names that wallet; `lead_lag_score` is the share.
  - *sybil*: in a cluster joined by lockstep buys (>= 3 shared mints within 2 s, >= 30% of the smaller wallet's mints)
    or by a shared `wallets.funder` (funders of more than 50 wallets, likely exchanges, are ignored). `cluster_id` is the
    cluster's first wallet.
  - `leader` (someone follows it) or `independent` otherwise. `independent_score` = (1 - lead_lag) x (1 - lockstep share)
    x (0.5 if it shares a funder), 0..1.
- **Skill model** (`quant/quant/flow.py`): with `QUANT_USE_FLOW=on` (default **off**) the quant job can only take
  `skill` away: a follower or sybil-cluster wallet, or one without a fresh (< `QUANT_FLOW_MAX_AGE_HOURS`=48 h) positive
  `copy_return_pct`, gets `luck`; `skill_score` is multiplied by `independent_score`. Run `ge-analyze` before the quant job.

```sh
npm run flow:dry                      # compute and print a summary, write nothing
npm run flow                          # write backtest_results + wallet_clusters
cd rust/ingest && cargo run --release -p ge-flow --bin ge-analyze -- --db /path/to/godseye.db --json --dry-run --delay 15 --slippage-bps 300
QUANT_USE_FLOW=on npm run quant:dry   # see how many 'skill' verdicts survive
```

Other flags: `--days N` (only swaps from the last N days), `--min-closed 5`, `--threads N`, `--depth SOL` (fixed pool
depth), `--follow-window 120`, `--sync-sec 2`, `--min-events 3`. Bench: `cd rust/ingest && cargo bench -p ge-flow`.
