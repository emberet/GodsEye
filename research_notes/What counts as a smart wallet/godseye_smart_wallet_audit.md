# Audit: the wallets GodsEye calls "smart" (server database, 27 Oct 2026)

This was a read-only look at `smart_wallets`, `wallets` and `wallet_stats` on the Hetzner server, plus `npm run replay`. The replay used the top 40 wallets by 30-day profit, delays of 2/5/15 s, the last 14 days and the default size and fees. It's checked against [smart_vs_not_smart.md](smart_vs_not_smart.md).

## Today's rule (agent/src/smart/smart-money.ts)
A wallet is smart if either:
- **Analyzed:** at least 10 closed trades in 30 days, 30-day profit above zero, a win rate at or above the learned bar, and not a Quitter or Lucky streak.
- **Live:** at least $250 profit over at least 5 closed trades on the stream, and a win rate at least 5 points above the bar.

A wallet is dropped if, over at least 10 measured buys, the median price move 6 h after its buys is −15% or worse.

## What the database shows
There are 1,492 active smart wallets: 1,397 analyzed and 95 live.

| Finding | Count | Why it matters |
|---|---|---|
| The learned win-rate bar has fallen to **0.40** | 606 of 1,492 win less than half their trades | "Smart" now means anything profitable with 10+ trades |
| Classified **bot/AI** (`kind = ai`) | 1,241 of 1,397 analyzed | Only 13 are classified human |
| Average hold **under 1 minute** | 229 | Can't be copied at a 2–15 s delay |
| Average hold **1–5 minutes** | 628 | Mostly scalping bots |
| **20 or more transactions an hour** | 901 | A bot frequency |
| Tier **insider** | 717 | Kept on purpose (see insider-wallets-ok); their edge is launch-block access |
| Tier **unrated**, not proven | 328 | Passed the smart filter without passing GodsEye's own Proven test |
| Best trade is **40% or more** of profit | 231 | Concentrated: one or two trades carry them |
| Lead score **never measured** (fewer than 10 buys measured) | 1,039 | The "follows, doesn't lead" check hasn't run on 70% of them |
| Live-source wallets | 95 | Picked on as few as 5 trades and $250 |

## The 10 wallets actually copied
All 10 are bot-classified and tagged insider.

- **6L3fPs, GxhREM, 2XqJKx:**
  - about **$18,000 buys** and a **98–100% win rate**;
  - $0.5–0.97M profit in 30 days, spread across many tokens;
  - lead score built on 0–4 buys.

  The replay barely finds their tokens on the stream: tape coverage is 1–3%. When it does, the price is about 4× higher by the time GodsEye could buy. **Copying them at a 5 s delay loses about 87% per trade** (they made +56 to +72%). This is the creator/sniper pattern the papers describe: a near-perfect record made in a window no copier can reach.
- **Hfy1et, DpDFLS, FEanU7, D2wQKi, 96JYcf, EewEeF, 8Q4tyZ:**
  - **140–200 transactions an hour**, about $250 buys;
  - 2–4 minute average holds, 51–61% wins;
  - in the replay, a **median hold of 7–10 s**.

  The replay's copy return is +4 to +20% mean but **−1 to −4% median**. A few outliers carry the mean; a typical copy loses.

## Top 40 by profit, replayed
- 36 of the 40 make **460–1,400 round trips in 14 days**, with a median hold of 6–11 s: high-frequency bots.
- At a 5 s delay the pooled **median copy return is −3%**, and the copy wins 38% of trades.
- The pooled mean is meaningless: **99% of it comes from one position**. It's a price-tape outlier of several million percent (wallets 4TC62i, FFdBLY). The replay doesn't apply the 1,000× cap that `MAX_PLAUSIBLE_RETURN_PCT` gives the lead score. Fix that before trusting replay averages.

## What this says
The stats GodsEye ranks on (profit, win rate, trade count) are the ones bots and launch-block wallets max out. What separates a copyable trader is:
- **hold time** a 2–15 s delay can follow (minutes to hours, not seconds);
- **entry timing** outside the launch block;
- **trade frequency** a human could make;
- **per-token return**, not per-swap;
- a **positive copy replay at GodsEye's own delay**.

Rules from the research worth turning into code, from the most to the least evidence. None of these is done yet.
1. **Bot gate:** not smart if the median hold is under 15 s, or there are more than about 20 tx/h, or a buy and sell fall in one transaction. This would remove most of today's list.
2. **Copy-replay gate:** a wallet must be positive at the median, at the real delay and size, in both halves of the window (needs the outlier cap first).
3. **Per-token significance** instead of the 0.40 win-rate bar: 25+ tokens in 30 days and a t-stat above 2 on per-token return.
4. **Concentration:** the top 3 tokens under 60% of profit, and still profitable without the best token.
5. **Lead score must exist:** don't count a wallet as smart until at least 10 of its buys have been measured, or count it at a small weight.
6. **Insiders:** still copied (user decision), but scored apart from skill. Their profit says nothing about what a copy earns, and the replay shows it.
