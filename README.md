# GodsEye — Sees every wallet. Copies the winners.

**GodsEye** copy-trades Solana wallets and keeps a public wallet database: a tier and an AI / bot or Human verdict for every wallet it studies, with the evidence on show. The public label for the insider tier is **Early-entry pattern** (`shared/src/constants.ts`).

> ⚠️ **Real money by default.** `COPY_MODE=real` (the default in `agent/src/config.ts`) spends real SOL. Defaults: 0.1 SOL per trade, 1 SOL in open copies, stop for the UTC day after 0.5 SOL of realized losses. Set `COPY_MODE=paper` to simulate. `npm run pause` stops new buys; sells and safety exits keep running.

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

Tiers, first match: Quitter, Early-entry pattern, Lucky streak, Needs attention, Proven, Unrated. Rules and evidence live in `agent/src/analysis/tiers.ts`. An AI / bot score means a program is placing the trades; an agent and a script look the same on-chain (`agent/src/analysis/classifier.ts`).

## The brain (paper only)

The brain is a separate paper-trading system. It does not sign, does not hold keys, and does not replace the copy engine. `COPY_MODE` is untouched.

- **Networks.** Small MLPs trained in PyTorch on the Mac (`brain/brain/policy/nets.py`) and exported to ONNX. The entry ensemble scores skip versus stake. The exit network scores hold, sell half, or sell all. Hard stops in config sit on top of that exit. A private social model is a different net and is never published.
- **Server.** `BRAIN_MODE=paper` (the default) lets `agent/src/brain/` paper-trade Brain, Explore, and Baseline accounts when a bundle is loaded. `BRAIN_MODE=off` does none of that. Bundles live under `BRAIN_DIR` (default `data/brain`). `current` must point at a directory whose `manifest.json` and ONNX files match. With no bundle, entry decisions do not run. `brain_enabled: false` on a bundle means the Brain account skips every signal and only Explore keeps taking paper trades. That flag is a gate result, not a claim that the model is qualified or profitable, and not a claim about real SOL.
- **Weights are not in git.** This repository does not record whether any server has a promoted bundle.

The contract between the Mac trainer and the server is `brain/spec/CONTRACT.md`.

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

## Public feed

The local site is `npm run dashboard` (Next.js on port 3000). The nav is Home, Wallets (All wallets, New wallets by funder at `/groups`), Copying (Trades, Who it copies, Results, Proof, Paper AI at `/paper`), and Live (Live trades, Runners). It reads `data/godseye.db` while the agent writes (WAL).

Every public API answer goes through `shared/src/public-view.ts`. That hides the hot-wallet address, raw logs, copy-decision internals (reason text, weight, latency), learned tuning, and anything named social. The insider tier is shown as Early-entry pattern. The wallet balance is shown; the address is not. `GODSEYE_FULL_FEED=1` turns that redaction off and is for a dashboard that is not public.

Vercel cannot see the sqlite file. `npm run publish-dashboard` copies the public snapshot to Turso. The hosted site uses the read-only token. Root directory on Vercel is `dashboard`.

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
- The hot wallet is a key file on the machine that runs the agent. Fund it only with what you can lose.
- The brain's paper results are not the copy engine's results, and a promoted bundle is not clearance to use real SOL.
