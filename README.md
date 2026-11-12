# GodsEye — Sees every wallet. Copies the winners.

**GodsEye** copy-trades Solana wallets and keeps a public wallet database: a tier and an AI / bot or Human verdict for every wallet it studies, with the evidence on show. The public label for the insider tier is **Early-entry pattern** (`shared/src/constants.ts`).

> ⚠️ **Paper by default. Real money takes one word.** `COPY_MODE=paper` (the default) simulates copy trades and moves no funds. `COPY_MODE=real` spends real SOL from the agent's wallet, sized by the risk governor from what the wallet holds: 5% a trade to start (3–10%), no new buys for the UTC day after a 20% fall, and a self-pause 50% below its high (`agent/src/copy/risk.ts`). Only the word `real` turns it on; any other word there, or a safety switch or limit the agent can't read, stops it at start instead of guessing. Real mode never makes a new wallet. `npm run pause` stops new buys; sells and safety exits keep running.

Nothing here is a promise of profit. Nothing here is financial advice.

## How it runs

`npm run agent` starts the loop (`agent/src/index.ts`). Schedules are UTC cron expressions in `.env`.

| Piece | What it does | Code |
|---|---|---|
| Live stream (optional) | Confirmed swaps via gRPC (`GRPC_URL`, `GRPC_TOKEN`: Shyft, Triton, Helius, or QuickNode). Live P&L on the Live page. A wallet at or above `STREAM_PROMOTE_PNL_USD` (default 50, never below 25) over `STREAM_PROMOTE_MIN_CLOSED` closed trades (default 2, never below 2) is promoted to full analysis. | `agent/src/stream/` |
| Discovery | Every 30 minutes (`DISCOVER_CRON`): new wallets from busy pools, plus a fresh wallet a tracked wallet funds. | `agent/src/discovery/` |
| Analysis | Every 10 minutes (`ANALYZE_CRON`): transactions, realized P&L, tier, AI / human. | `agent/src/analysis/` |
| Learning loop | Every 15 minutes (`LEARN_CRON`): who is eligible to copy, and how much. The moving follow bar is hidden on the public site. | `agent/src/learning/` |
| Copy engine | Leader buy → GodsEye buy, sized by weight. Leader sell → the same fraction. Our own stop, take-profit, and max-hold run every minute. Every transaction is checked before it is signed (`agent/src/copy/verify.ts`). | `agent/src/copy/` |
| Smart money | Bots and wallets the copy-fill replay says do not pay are left out. Signals need several wallets and demand that is not one cluster. | `agent/src/smart/` |

Tiers, first match: Quitter, Early-entry pattern, Lucky streak, Needs attention, Proven, Unrated. Rules and evidence live in `agent/src/analysis/tiers.ts`. An AI / bot score means a program is placing the trades; an agent and a script look the same on-chain (`agent/src/analysis/classifier.ts`). That score is not the brain below.

## The neural network

The trading nets are small multilayer perceptrons, class `QNet` in `brain/brain/policy/nets.py`: a linear layer, a ReLU, a linear layer, a ReLU, then a linear output. Both hidden layers are 128 units. Training is PyTorch on the Mac. The server never runs PyTorch. It loads the exported ONNX (`brain/brain/export_onnx.py`, `agent/src/brain/model.ts`). The state-value net used inside exit training is not exported.

**Entry.** Five bootstrapped members. By default each one maps the normalised entry features to two q-values in SOL: skip, or one full copy (`COPY_MAX_TRADE_SOL`). `--actions 5` trains the five stake fractions named in `brain/spec/CONTRACT.md` instead. Skip's q is fixed at 0. `brain/spec/features.yaml` lists 29 entry features (`venue_group` is one-hot; 13 features have a missing flag). The manifest is the exact column list. `social_score` and `social_missing` stay masked until those columns vary in training. Hard gates in that spec run before any network and skip the signal for every account.

**Exit.** Twenty-one exit features, two of them with a missing flag, so 23 inputs. Three q-values: hold, sell half (once), sell all. Config hard stops sit on top of this net and can override it (`agent/src/brain/policy.ts`).

**Social, separate.** `brain/brain/social/train.py` is another MLP: 32 units, 16 units, one output, with dropout only while training. `social.onnx` is a predicted 14-day copy return for an owner-linked wallet. It is not an entry or exit action, and it is not published.

The decision rule is `agent/src/brain/policy.ts`. It does not send an order. For the Brain paper account, score is the members' mean q minus `margin_c` times their spread, and a stake is taken only when that score is above 0. The Explore paper account picks one member at random and adds a curiosity term to every stake.

## The brain

The brain is the paper-trading system around those networks. It is not the copy engine. It does not sign, does not hold keys, and does not change `COPY_MODE`.

`BRAIN_MODE=paper` (the default) lets `agent/src/brain/` run three paper accounts, Brain, Explore, and Baseline, when a bundle is loaded. `BRAIN_MODE=off` runs none of them. Bundles live under `BRAIN_DIR` (default `data/brain`). `current` must point at a directory whose `manifest.json` and ONNX hashes match. With no bundle, entry decisions do not run (`decideEntry` returns null). `brain_enabled: false` means the Brain account skips every signal and only Explore keeps taking paper trades.

Weights are not in this git repository. Nothing here records whether a server currently has a promoted bundle. The file both sides share is `brain/spec/CONTRACT.md`.

### Hourly training on the Mac

The cycle is `brain/scripts/cycle.sh`: pull, train, gate, push, then the same for the private social model. It does not run inside `npm run agent`.

Prerequisites:

- A conda env from `brain/environment.yml` (`conda env create -f environment.yml`, then `conda run -n godseye-brain pip install -e .` from `brain/`). Default interpreter: `~/miniconda3/envs/godseye-brain` (`BRAIN_ENV` overrides).
- `BRAIN_DATA_DIR` must already exist. The default for `cycle.sh` and `pull.sh` is `~/GodsEyeBrainData`. If that path is missing, the cycle exits without creating it (an unplugged drive must not become an empty folder on the internal disk).
- Pull uses `ssh` to the host `BRAIN_SERVER` (default alias `GodsEye`) and reads `BRAIN_SERVER_DB` (default `/opt/godseye/app/data/godseye.db`). A failed pull stops the cycle before any train or push.

What one cycle does:

- Mode is hourly, unless the local hour is 03 and `CYCLE_MODE` is unset, in which case it retrains from scratch. `CYCLE_MODE=full` forces that.
- The promotion gate is `python -m brain.gate --bundle <dir> --no-test`. Exit 0 pushes the bundle for the paper Brain account. Exit 3 pushes it explore-only (`brain_enabled: false`), and only while the server has no promoted model. `CYCLE_EXPLORE_ONLY=0` makes exit 3 keep the server's model instead. Any other exit keeps the current bundle. The social model pushes only on exit 0.
- The held-out test window is not scored on this hourly path (`--no-test`). That look is manual, once.

Install launchd once, with the data directory set (the installer refuses to guess):

```bash
BRAIN_DATA_DIR="/path/to/GodsEyeBrainData" brain/scripts/install-launchd.sh
```

That writes `~/Library/LaunchAgents/work.godseye.brain.plist` and runs `cycle.sh` every hour. Launchd's own log is `~/Library/Logs/godseye-brain-launchd.log`. The cycle log is `$BRAIN_DATA_DIR/logs/cycle-YYYY-MM-DD.log`. If launchd cannot read an external drive, run the loop from a process that already can (it stops when that process ends or the Mac restarts):

```bash
BRAIN_DATA_DIR="/path/to/GodsEyeBrainData" nohup brain/scripts/cycle-loop.sh >/dev/null 2>&1 &
```

`cycle.sh` and `cycle-loop.sh` share a lock, so they do not train over each other. One cycle at a time. If `BRAIN_DATA_DIR` is unset, `cycle-loop.sh` uses the path written at the top of that file. A step whose Python module is missing is skipped. This loop does not change live trading, and a gate pass is not a real-money clearance.

## Reinforcement training

Learning is offline, on the Mac. The server records paper outcomes. It does not update weights while it paper-trades.

**Entry is not reinforcement learning.** `brain/brain/policy/entry.py` is a contextual bandit. The simulator copies ungated signals at full stake, exits them with the chosen exit policy, once plain and once under a stressed draw, and the target is the loss-weighted net SOL result of that copy (`brain/spec/reward.yaml`). Five MLPs regress that target with a Huber loss, each on its own bootstrap sample. The hourly run warm-starts those weights and can add logged paper transitions only after their rewards are grounded. Skip's target is 0.

**Exit is offline reinforcement learning.** `brain/brain/policy/exit.py` fits Implicit Q-Learning (Kostrikov, Nair, and Levine, 2021) on trajectories from a mix of behaviour policies in the simulator: a short supervised fit on the remaining value, then IQL. Step rewards are potential-based and add up to the same loss-weighted result as the closed trade. If a hand rule beats that IQL head on the selection window, the exported exit net is the rule distilled into the same shape, and only its best action is meaningful. Training does not read the held-out test window (`brain/spec/splits.yaml`).

**Two different checks, and neither is proof of profit.**

- `python -m brain.assure` asks whether the trainer still behaves on synthetic markets with a planted truth (skip when there is no edge, do not copy gated signals, do not read a leaked future column, and the other checks in `brain/brain/assure/learning.py`). `--real` adds read-only checks on the drive. A skipped check is not a pass. This command does not push a bundle.
- `python -m brain.gate --bundle <dir>` is the promotion check. It replays the ONNX bundle the way the server would, on the selection window, against the B4 hand rule, and it calls `brain.assure` `check_bundle` (bundle shape, plus the trainer's synthetic learning checks). The hourly cycle passes `--no-test`, so this is not the held-out test window, and it is not GitHub CI or `npm test`.

Exit codes of that gate:

- **0, promote.** Sanity, stress, the comparison with B4, and the assure check all passed. The bundle can be pushed with `brain_enabled: true`. The paper Brain account may then use it. That is the "ready" state in this repo. It means the paper account is allowed to trade the bundle. It does not mean the bundle made money, and it does not mean it is safe with real SOL.
- **3, explore-only.** Sanity and the stress checks passed. The bar did not. The cycle pushes it with `brain_enabled: false`, and only while the server has no promoted model. The Brain account skips. Explore can still take paper trades so a later run has data. `CYCLE_EXPLORE_ONLY=0` does not push this case.
- **Anything else.** The server keeps the bundle it already has.

The social model has no explore-only push. Only gate exit 0 pushes it.

## Replay worker

Copy-fill replays of a **file** database run on a worker thread so the synchronous sqlite read does not freeze the agent (`agent/src/replay/off-thread.ts`, `agent/src/replay/replay-worker.ts`). The worker opens its own read-only connection. An in-memory database, which is what the tests use, is replayed on the caller instead. On current `main` the worker is started as the TypeScript file `replay-worker.ts` and is `unref()`'d, so it does not keep the process alive by itself. The read-only CLI is `npm run replay` (`-- <address>`, `-- --top 30`, `--delays`, `--until-days`; flags are in `agent/src/cli/replay.ts`). Rug checks and the live position limits are not replayed.

That worker startup is what [pull request 13](https://github.com/emberet/GodsEye/pull/13) changes. It is open and not on `main`. Until it merges, `main` still has the behavior above.

## Quant and Rust (optional)

Neither is on the buy path unless you opt in. Neither signs.

**Python quant** (`quant/`, Python 3.11+): an offline job. It reads sqlite read-only and writes `wallet_skill` and `sizing_params`. From `quant/`:

```bash
python3 -m venv .venv && .venv/bin/pip install -e ".[dev]"
.venv/bin/python -m quant.run --dry-run
.venv/bin/pytest -q && .venv/bin/ruff check . && .venv/bin/ruff format --check .
```

From the repo root, `npm run quant:dry` and `npm run quant` call `python3 -m quant.run` (they do not create the venv). Settings are `QUANT_<NAME>` in `quant/quant/config.py`. `QUANT_KELLY_FRACTION` above 0.25 is refused. The agent reads the tables only when asked: `QUANT_SIZING` defaults to off (`shadow` logs a size and changes nothing; `on` can only shrink a size), and `QUANT_SKILL_GATE` defaults to off. `QUANT_USE_FLOW` defaults to off.

**Rust** (`rust/ingest/`, toolchain file `rust/ingest/rust-toolchain.toml`, channel stable): `ge-ingest` and `ge-parse` are an optional ingest/parser path. `ge-flow`'s `ge-analyze` is an offline backtest and wallet-flow pass over the database. `npm run flow:dry` writes nothing; `npm run flow` writes `backtest_results` and `wallet_clusters`. CI runs `cargo fmt`, `cargo clippy`, `cargo test --workspace --locked`, and a bench compile, from `rust/ingest`.

## Money in and out

The agent keeps score per unit, like a fund (`agent/src/funding/ledger.ts`, table `wallet_flows`). A deposit buys units and a withdrawal redeems them, so neither counts as a win or a loss. SOL that leaves the wallet unexplained, above `FUNDING_OUTFLOW_PAUSE_SOL`, pauses new buys and tells the owner; sells keep running.

**Its own pump.fun coin** (`agent/src/creator/rewards.ts`, `CREATOR_REWARDS=off|dry|on`). 30% of the creator rewards go to the agent's wallet to trade with, 70% to `CREATOR_PAYOUT_WALLET`. After launching the coin from the agent's wallet:

1. Set `CREATOR_PAYOUT_WALLET` and `CREATOR_REWARDS=dry` in `.env`, then restart.
2. `npm run creator -- split <mint>` builds and simulates pump.fun's split. Check it, then run it again with `--confirm`. pump.fun locks the split for good once it is set.
3. Watch a dry payout or two in the log, then set `CREATOR_REWARDS=on`.

With the split set, pump.fun pays each share straight to its wallet. Without one, the agent claims as the creator and sends 70% on in the same transaction. Launching from the agent's wallet makes that wallet public: a coin's creator is visible on-chain. The agent never copies its own coin.

## Public feed

The local site is `npm run dashboard` (Next.js on port 3000). The nav is Home, Wallets (All wallets, New wallets by funder at `/groups`), Copying (Trades, Who it copies, Results, Proof, Paper AI at `/paper`), and Live (Live trades, Runners). It reads `data/godseye.db` while the agent writes (WAL).

Every public API answer goes through `shared/src/public-view.ts`. It lists the fields each feed may show, so a new column stays private until it is added there. Left out: the hot-wallet address and the agent's own transaction signatures, raw logs, copy-decision internals (reason text, weight, latency), learned tuning, X handles and the list of X accounts, and anything named social. The insider tier is shown as Early-entry pattern. The wallet balance is shown; the address is not. `GODSEYE_FULL_FEED=1` shows the full feed on a local development run (`npm run dashboard`) only; a production build and Vercel ignore it.

Vercel cannot see the sqlite file. `npm run publish-dashboard` copies the snapshot to Turso, through the same filter before it leaves the machine. The hosted site uses the read-only token. Root directory on Vercel is `dashboard`.

## Run, develop, test

Node.js **20.10 or newer** (`package.json` `engines`). CI is Node 20 (`npm ci`, `npm run typecheck`, `npm test`).

```bash
npm install
npm run setup          # copies .env.example to .env if you have none; creates data/
```

Open `.env` and set `HELIUS_API_KEY` or `SOLANA_RPC_URL`. The example file is `.env.example`. Do not commit `.env`.

| Command | What it does |
|---|---|
| `npm run agent` | Discovery, analysis, learning, copy trading, and (unless `BRAIN_MODE=off`) the paper brain. |
| `npm run agent:forever` | `scripts/run-agent.sh`. |
| `npm run dashboard` | Site at http://localhost:3000. |
| `npm run site:forever` | `scripts/run-site.sh`. |
| `npm run wallet` | This install's wallet address and balance. |
| `npm run status` | Alive or not, results, tiers, who is being copied. |
| `npm run pause` / `npm run resume` | Stop or restart new copy buys. |
| `npm run funding` | Deposits, withdrawals and the risk governor's state. `npm run funding -- expect <SOL>` announces a withdrawal, so it doesn't pause the agent. |
| `npm run creator` | The creator-rewards switch for the agent's own pump.fun coin. `npm run creator -- split <mint>` shows the one-time split; `--confirm` sets it. |
| `npm run alert-test` / `npm run alert-check` | Set up and try the owner's Telegram alerts / a look from outside that tells the owner when the agent has stopped reporting in (for a timer of its own). |
| `npm run close-all` | Sell every open copy. Stop the agent first, and pause so a restart does not buy again (`agent/src/cli/close-all.ts`). |
| `npm run discover` / `npm run analyze` / `npm run learn` | One pass each. `npm run analyze -- <address>` adds that wallet and analyzes it. |
| `npm run replay` | Read-only copy-fill replay. |
| `npm run shadow` / `npm run audit` / `npm run pool` | Read-only reports. See `agent/src/cli/`. |
| `npm run publish-dashboard` | Push the public snapshot. |
| `npm test` | `shared`, then `agent`, then `dashboard`. |
| `npm run typecheck` | `tsc --noEmit` in those three workspaces. |

Workspaces are `shared`, `agent`, and `dashboard`. One `.env`. One sqlite file, `data/godseye.db`. Tests set `GODSEYE_TEST=1` and must not open the real database or the network (`shared/test/setup.ts`).

## Honest limits

- Copying enters after the leader, at a worse price. Past profit is not the next trade.
- P&L for wallets is in USD at the time each trade settled. Non-memecoins and trades with no usable price are left out.
- Analysis does not read a wallet's whole life. The funder of a very old wallet is often unknown.
- Live-stream P&L counts only swaps seen since this process started. It is a filter, not a verdict.
- Labels are automated guesses with evidence attached, not accusations.
- The hot wallet is a key file on the machine that runs the agent. Fund it only with what you can lose. Keep its address private as well: anyone who knows it can watch its trades and trade against them.
- The brain's paper results are not the copy engine's results, and a promoted bundle is not clearance to use real SOL.
