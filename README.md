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
| **Smart money** (live) | Follows where wallets that make money are putting it. Smart money = analyzed wallets with a track record plus wallets winning big on the stream right now. Every trade they make is recorded; 3+ smart wallets buying (or dumping) the same token within an hour is a **signal**. 1, 6 and 24 hours later GodsEye measures what the price did, so it **learns** which signals work and which wallets actually lead price; wallets whose buys keep dropping stop counting as smart, and lead scores scale copy weights (0.5×–1.5×). See the **Smart money** page. | `agent/src/smart/` |
| **Discovery** (every 30 min) | Reads the latest big trades in Solana's busiest and trending pools (GeckoTerminal) and adds every new wallet, including wallets created minutes ago. Also adds any brand-new wallet a tracked wallet sends SOL to (a trader moving to a fresh wallet). | `agent/src/discovery/` |
| **Analysis** (every 10 min) | For each wallet: reads its transactions, keeps SOL-priced swaps, finds its first transaction (age, **fresh** or not, **who funded it**), looks up when each token it bought launched, computes realized P&L, then assigns a **tier** and an **AI / human** verdict. | `agent/src/analysis/` |
| **Learning loop** (every 15 min) | Re-weights every wallet by recent profit (USD at settlement). Only wallets with a track record are eligible: Proven tier, or ≥ `MIN_CLOSED_FOR_PROVEN` (10) closed trades in 30 days, never a Lucky streak. Losing this week → weight 0 at once. Also learns from GodsEye's *own* results: if copying a wallet lost money (late entries, slippage), it's dropped. Only the top `COPY_MAX_LEADERS` earners are copied. | `agent/src/learning/` |
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
