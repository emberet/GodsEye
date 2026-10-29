# GrokBot's Rust and Python layer: what went live, what was fixed, what it improved (Oct 29)

## Now running on the server
| Part | What it does | How it runs |
|---|---|---|
| **ge-ingest** (Rust) | Reads the ERPC gRPC stream, parses every DEX swap, hands it to the agent over a local socket | `ge-ingest.service`, always on, 512 MB cap. Settings in `/etc/godseye/ingest.env` (gRPC only, no wallet keys) |
| **Agent, `STREAM_PARSER=rust`** | Takes swaps from ge-ingest instead of parsing the stream itself | `godseye-agent` |
| **ge-analyze** (Rust) | Backtest of copying every leader, plus money flow (followers, sybil clusters) | `godseye-flow.timer`, every 6 h, 2.5 GB cap, low priority |
| **Quant job** (Python) | Skill vs luck per wallet, quarter-Kelly sizing; uses the money-flow results | `godseye-quant.timer`, hourly at :40, 2.5 GB cap, low priority |
| **Quant in the agent** | `QUANT_SIZING=shadow`: logs the quant size next to each real copy, changes nothing. `QUANT_SKILL_GATE=off` | `.env` |

## Measured improvements
| | Before | After |
|---|---|---|
| Stream transactions received | ~400/s, and ERPC paused the agent's own stream for reading too slowly | **~560–650/s**, no pauses or drops; 0 parse differences TS vs Rust over 42,830 transactions |
| Agent CPU | ~45% (at ~210 tx/s) | **13–22%** (at 500–650 tx/s) |
| Event-loop stalls | up to 22.7 s (copy replay 7 s, analysis 2 s every ~15 s) | a few of 2–3 s |
| Copy decision delay after leader's trade | 3.6 s avg / 36 s max (17:50–19:00) | **0.8 s avg / 2.2 s max** (19:19–19:57) |
| ge-analyze memory | 5.4 GB (could get the agent OOM-killed) | **1.8 GB** |
| Quant job | killed at 6.4 GB, never finished | **finishes in ~16 min** under a 2.5 GB cap |

## Fixes made to GrokBot's code
1. **ge-analyze:** wallet and mint shared per address, and the unused signature dropped: 5.4 GB to 1.8 GB.
2. **Quant data loading:**
   - closed trades are filtered in SQLite;
   - price paths are streamed into numpy arrays, only for tokens of testable wallets;
   - bot wallets that aren't copied are skipped (`QUANT_SKIP_BOTS=1`).
3. **`upsertClosedTrades`** (Phase 1) re-ran a whole-price-path query for every closed trade on every analysis. Now each trade's rank is computed once.
4. **Example systemd units** replaced with real ones that have memory caps.

## Fixes to the agent found while measuring
- **Copy replay** runs on a worker thread with its own read-only connection; it had been holding the event loop for up to 7 s.
- **Smart-money non-memecoin purge** runs hourly instead of every 5 min (~1 s scan each time).
- **New diagnostics:**
  - event-loop delay and CPU every 5 min (`agent_meta.event_loop`, logged hourly);
  - any stall of 2 s or more is logged with the jobs running;
  - any SQLite statement of 500 ms or more is logged.

## What the quant layer says about the current leaders (19:56)
All 10 copied wallets come out as **luck** (p ≈ 1: their entries do no better than random entries in the same tokens), with kelly_mult 0. Of the rest:
- 7,879 wallets are luck, 11,932 have too few trades (insufficient), and **1** is skill.
- The Rust backtest still shows a positive copy return for all 10 (+2.5% to +17%).

Turning on `QUANT_SKILL_GATE=on` or `QUANT_SIZING=on` today would stop all copying. Both stay off and in shadow until the owner decides.

## Left to do
- `entry_price_rank` for new trades on very busy tokens still takes ~1 s (the query reads every swap of the token). A covering index on `wallet_swaps(mint, ts, price_sol)` would fix it. Building it on 14M rows locks writes for a few minutes, so do it during a planned restart.
- When the ERPC day pass ends:
  - change `GRPC_URL` in both `/opt/godseye/app/.env` and `/etc/godseye/ingest.env`;
  - restart `ge-ingest`.

  Copying keeps working on the Helius websocket meanwhile.
