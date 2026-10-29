# Why the copy engine slowed down (Oct 28–29) and what was fixed

## Short version
GrokBot's code was **not** what slowed it down: none of its Phase 1–4 work was running on the server until today. The live agent was still on `03993d3`. The slowdown came from **Shyft**:

- **RPC quota.** From **Oct 28 11:00 UTC** Shyft's RPC answers *"Your request quota has been reached… upgrade your subscription"* to most requests.
- **gRPC token.** Since today's restart, Shyft's gRPC stream also refuses the token: *"token not found"*.

GodsEye used the one Shyft key for everything: wallet history reads and the copy path (leader transactions, rug checks, the wallet balance, sending trades). Once the quota ran out, the copy path was stuck behind the same 429s.

## What the slowdown looked like
| | Oct 27 | Oct 28–29 |
|---|---|---|
| Average delay from leader's trade to GodsEye's decision | ~1 s | 4–12 s (peaks of 40–70 s) |
| Shyft 429s per hour | 0 | ~1,000 HTTP + ~2,500 websocket |
| Learning loop | every 15 min | **stopped at Oct 27 21:45** (hung waiting on the dead websocket) |
| Rug check on new buys | answered | "couldn't verify the token on Solana" |
| Jupiter quotes | answered | some 429s |
| Agent memory | — | 4.9 of 5 GB (database 10.8 GB, growing ~3 GB/day) |

The database grew because about 3.7 million swaps a day were stored. Half of all stored swaps (6.7 M) belonged to the 3,305 wallets already flagged as bots.

## Fixes (on GodsEye `main`, deployed Oct 29 15:38 UTC)
1. **The copy path has its own RPC** (`COPY_RPC_URL`, defaulting to Helius with `HELIUS_API_KEY`). This covers leader transactions, rug checks, holders, pools, the wallet, and sending and confirming trades. Wallet history stays on Shyft. Helius handled 25 concurrent calls with no errors.
2. **The leader websocket is on Helius**, so it works again alongside the stream. With the stream down, leader buys were seen **0.9 s and 1.2 s** after they happened.
3. **`watcher.sync` gives up on any call after 10 s**, so a dead websocket can no longer freeze the learning loop. The loop is running again; its first run at 15:36 replaced 6 of the 10 leaders.
4. **Bots are no longer stored swap by swap from the stream**, and analysis re-reads a bot only once a week (`BOT_REANALYZE_DAYS=7`). Copied wallets are always kept. This cuts history RPC and database growth roughly in half.
5. **GrokBot's one-time closed-trades backfill runs in the background** (300 ms slices). On startup it had blocked the agent for about an hour, with copying and stop losses offline. Startup now takes seconds.
6. **GrokBot's copy reserve only applies when the copy path shares the main RPC.** Otherwise it would keep 20% of Shyft's budget idle for calls that no longer go there.

The server `.env` already pins discovery and analysis to the old sizes (12 pools, 25 new wallets per run, 60 per analysis run, concurrency 8). GrokBot's larger defaults (40 / 100 / 90 / 12) therefore aren't in effect, which is right while Shyft's quota is out.

## Still needs you
- **Shyft account.** Renew or upgrade the plan, or check the dashboard for a usage reset date. Until then:
  - **no gRPC stream:** live wallet discovery and the smart-money feed run on stale data;
  - **wallet analysis keeps hitting 429s.**

  Copying itself no longer depends on Shyft. When the token works again, the stream reconnects by itself within a minute.
- **One new leader:** `8UUX…BMJR` got **48% weight** (+$247k this week, 23 closed trades, 100% wins, a fresh wallet). That is a lot of weight on one fresh wallet; worth a look.

## For GrokBot
- Default `DISCOVER_POOLS`, `DISCOVER_MAX_NEW_PER_RUN`, `ANALYZE_PER_RUN` and `ANALYZE_CONCURRENCY` were raised 3–4×. On the current Shyft plan that runs out the quota faster; keep the old defaults until the plan is bigger.
- Anything that walks the whole `wallet_swaps` table (13.9 M rows, ~10 GB) has to run in slices or off the main thread. A synchronous pass takes about an hour.
- `wallet_swaps` has no retention by size, only by age (`SWAPS_RETENTION_DAYS=90`). At ~2–3 GB/day the 5 GB memory cap and page cache were already saturated. Consider pruning swaps of bot-flagged wallets: that needs your OK, since it deletes data.
