"""
The paper account over a policy's simulated copies, and the metrics every policy is judged on.

    acc = account(out, t_dec, params)   # 1 SOL bankroll, 5 slots, one position per coin, daily loss limit (paper.ts room())
    m = metrics(out, acc, days)          # per decision / per copy (mint-clustered CI), per day, account, drawdown, slots

Positions are simulated unconstrained (book.outcomes(): every chosen signal as if it were the only one), then the account
takes them first come first served at their decision time, like paper.ts room(): a coin already held, 5 open positions,
the bankroll in open positions, cash, and the UTC day's NET realized loss >= 0.5 SOL (gains offset losses, paper.ts
day_loss_sol -= pnl) each block a new entry. A position's exit does not depend on the account, so this split is exact
except that a position the account had to shrink (budget, cash) is scaled: proceeds in proportion to the stake, fixed
costs (the fees the book actually charged, chaos and fee spikes included, and lost rent) unchanged. Cash moves by the
book's own buy fee (fee_open) and the rent deposit at the open, and back at the close, so it nets to the position's pnl.

The per-signal metrics (per copy, per decision, by day, paired_diff) keep sim.yaml's one-position-per-coin rule with
unlimited slots (one_per_coin): a copy made while an earlier copy of the same coin is still open is never opened, so it
scores 0 like a skip. Without it a few heavily copied coins decide the mean (the top 1 % of mints held 47 % of B4's
selection copies).
"""
from __future__ import annotations

import heapq
import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd
import yaml

from brain.sim.params import SimParams
from brain.sim.tape import T0_MS

COPY_REASONS_EXCLUDED = ("skip", "too-late", "bad-print", "no-fill")
RUIN_SOL = 0.5  # reward.yaml ruin_penalty: an account below 0.5 SOL
RAILS_SPEC = Path(__file__).resolve().parents[2] / "spec" / "rails.yaml"


@dataclass(frozen=True)
class Rails:
    """
    The server's real-money rails (spec/rails.yaml, agent/src/copy/risk.ts) as fractions of the account. With them the
    account sizes each trade as stake / max_trade_sol × (equity × start_trade_pct, at least min_trade_sol and at most
    equity × max_trade_pct), holds any number of positions the cash allows (COPY_MAX_POSITIONS=0 on the server), stops
    buying for the UTC day once realized equity is daily_stop_pct below the day's start, and for good once it is
    drawdown_pause_pct below its high. Equity is realized (open positions at cost), like the governor's high.
    """
    start_trade_pct: float = 5
    max_trade_pct: float = 10
    daily_stop_pct: float = 20
    drawdown_pause_pct: float = 50
    min_trade_sol: float = 0.05
    min_equity_sol: float = 0.5
    reserve_sol: float = 0.05

    @classmethod
    def load(cls, path: Path = RAILS_SPEC) -> "Rails":
        d = yaml.safe_load(Path(path).read_text())
        return cls(**{k: float(d[k]) for k in cls.__dataclass_fields__})


def is_copy(out: pd.DataFrame) -> np.ndarray:
    """Signals the policy copied and the market let it try (buy failures and dead entries count, gated/unfillable do not)."""
    return (out["stake"].to_numpy() > 0) & ~out["reason"].isin(COPY_REASONS_EXCLUDED).to_numpy()


def one_per_coin(out: pd.DataFrame) -> np.ndarray:
    """
    Per row: False for a copy paper.ts could not open because an earlier opened copy of the same coin is still open at its
    decision time (t_dec, else t_ms; open until max(close_t, t_dec), freed at exactly close_t like account()). Copies
    are taken in (t_dec, episode_id) order, so a blocked copy never blocks a later one. Rows that are not copies: True.
    """
    keep = np.ones(len(out), bool)
    c = np.flatnonzero(is_copy(out))
    if not len(c):
        return keep
    t = out["t_dec"].to_numpy(np.int64)[c] if "t_dec" in out else out["t_ms"].to_numpy(np.int64)[c]
    end = np.maximum(out["close_t"].to_numpy(np.int64)[c], t)
    m = pd.factorize(out["mint"].to_numpy()[c])[0]
    o = np.lexsort((out["episode_id"].to_numpy()[c], t, m))
    free_at: dict = {}
    for i, mi, ti, ei in zip(o.tolist(), m[o].tolist(), t[o].tolist(), end[o].tolist()):
        if ti < free_at.get(mi, -1):
            keep[c[i]] = False
        else:
            free_at[mi] = ei
    return keep


def counted(out: pd.DataFrame) -> np.ndarray:
    """The copies the per-signal metrics count: is_copy and one_per_coin (out["solo"] when evaluate() stored it)."""
    solo = out["solo"].to_numpy(bool) if "solo" in out else one_per_coin(out)
    return is_copy(out) & solo


def day_of(ms) -> str:
    return time.strftime("%Y-%m-%d", time.gmtime((int(ms) + T0_MS) / 1000))


def account(out: pd.DataFrame, t_dec: np.ndarray, p: SimParams = SimParams(), rails: Rails | None = None) -> pd.DataFrame:
    """
    out: book.outcomes() rows; t_dec: decision time (ms) per row. Returns the attempts the account took, in order, with
    size, pnl (scaled to the size), close_t, close_day, eq_after (realized equity after each close) and attrs: blocked
    counts, slot_seconds (open-position seconds), first/last decision. `rails`: the real-money rails instead of the
    paper account's fixed sizes and limits (Rails).
    """
    c = is_copy(out)
    o = out[c].assign(t_dec=np.asarray(t_dec)[c]).sort_values(["t_dec", "episode_id"], kind="stable").reset_index(drop=True)
    # the book's charged fees; frames without them (older outcomes, tests) fall back to the base fee per transaction
    fees = o["fees"].to_numpy(np.float64) if "fees" in o else o["n_tx"].to_numpy() * p.tx_cost_sol
    fee_open = o["fee_open"].to_numpy(np.float64) if "fee_open" in o else np.full(len(o), p.tx_cost_sol)
    fixed = fees + np.where(o["rent_lost"].to_numpy(), p.rent_sol, 0.0)
    stake = o["stake"].to_numpy(np.float64)
    pnl0 = o["pnl"].to_numpy(np.float64)
    ex = o["close_t"].to_numpy(np.int64)
    ts = o["t_dec"].to_numpy(np.int64)
    mint = o["mint"].to_numpy()
    heap: list = []
    held: dict = {}
    deployed = 0.0
    cash = eq = p.bankroll_sol
    cur_day, day_loss = None, 0.0
    slot_ms = 0
    last_t = ts[0] if len(ts) else 0
    rec = []
    blocked = {"min_trade": 0, "daily_loss": 0, "coin": 0, "positions": 0, "budget": 0, "cash": 0}
    if rails:
        blocked.update(small=0, day_stop=0, paused=0)
    high = day_start = p.bankroll_sol
    paused = False

    def roll(t):
        nonlocal cur_day, day_loss, day_start
        d = day_of(t)
        if cur_day is None or d > cur_day:
            cur_day, day_loss, day_start = d, 0.0, eq

    def advance(t):
        nonlocal slot_ms, last_t
        slot_ms += len(heap) * max(0, t - last_t)
        last_t = max(last_t, t)

    def close_until(t):
        nonlocal cash, eq, deployed, day_loss
        while heap and heap[0][0] <= t:
            advance(heap[0][0])  # count the slot time before the position leaves
            et, i, size, pnl = heapq.heappop(heap)
            held.pop(mint[i], None)
            deployed -= size
            cash += size + pnl + fee_open[i] + p.rent_sol  # = proceeds - sell fees (+ rent back unless lost)
            roll(et)
            eq += pnl
            day_loss -= pnl  # net realized P&L of the UTC day (paper.ts close: day_loss_sol -= pnl)
            rec.append((i, size, pnl, et, eq))

    for i in range(len(ts)):
        close_until(ts[i])
        advance(ts[i])
        roll(ts[i])
        min_trade = p.min_trade_sol
        if rails:
            high = max(high, eq)
            paused = paused or eq <= high * (1 - rails.drawdown_pause_pct / 100)
            if paused:
                blocked["paused"] += 1
                continue
            if eq <= day_start * (1 - rails.daily_stop_pct / 100):
                blocked["day_stop"] += 1
                continue
            have = eq - rails.reserve_sol  # what it has to trade with: realized equity less the fee reserve
            if have < rails.min_equity_sol:
                blocked["small"] += 1
                continue
            min_trade = rails.min_trade_sol
            per_trade = min(have * rails.max_trade_pct / 100, max(min_trade, have * rails.start_trade_pct / 100))
            want = stake[i] / p.max_trade_sol * per_trade
            budget = have
        else:
            want = min(stake[i], p.max_trade_sol)
            budget = p.bankroll_sol
        if want < min_trade:
            blocked["min_trade"] += 1
            continue
        if not rails and day_loss >= p.daily_loss_sol:
            blocked["daily_loss"] += 1
            continue
        if mint[i] in held:
            blocked["coin"] += 1
            continue
        if not rails and len(heap) >= p.max_positions:
            blocked["positions"] += 1
            continue
        size = min(want, budget - deployed)
        if size < min_trade:
            blocked["budget"] += 1
            continue
        size = min(size, cash - fee_open[i] - p.rent_sol)
        if size < min_trade:
            blocked["cash"] += 1
            continue
        pnl = (pnl0[i] + fixed[i]) * (size / stake[i]) - fixed[i] if stake[i] > 0 else pnl0[i]
        cash -= size + fee_open[i] + p.rent_sol
        deployed += size
        heapq.heappush(heap, (max(int(ex[i]), int(ts[i])), i, size, pnl))
        held[mint[i]] = i
    close_until(np.iinfo(np.int64).max)
    cols = list(zip(*rec)) if rec else [[], [], [], [], []]
    ii = np.asarray(cols[0], dtype=np.int64)
    tr = o.iloc[ii].copy().reset_index(drop=True)
    tr["size"] = np.asarray(cols[1], dtype=np.float64)
    tr["pnl_acct"] = np.asarray(cols[2], dtype=np.float64)
    tr["close_at"] = np.asarray(cols[3], dtype=np.int64)
    tr["close_day"] = [day_of(t) for t in tr["close_at"]]
    tr["open_day"] = [day_of(t) for t in tr["t_dec"]]
    tr["eq_after"] = np.asarray(cols[4], dtype=np.float64)
    tr.attrs.update(blocked=blocked, slot_ms=int(slot_ms), first_t=int(ts[0]) if len(ts) else 0, last_t=int(last_t), n_wanted=int(len(ts)))
    return tr


def max_drawdown(eq: np.ndarray) -> float:
    return float((np.maximum.accumulate(eq) - eq).max()) if len(eq) else 0.0


def cluster_ci(pnl: np.ndarray, groups: np.ndarray, B: int = 1000, seed: int = 0, denom: np.ndarray | None = None) -> tuple[float, float]:
    """95 % CI of sum(pnl) / sum(denom) (denom = 1 per row: the mean) by a Poisson bootstrap over clusters (mints)."""
    pnl = np.asarray(pnl, dtype=np.float64)
    if len(pnl) == 0:
        return (float("nan"), float("nan"))
    codes, inv = np.unique(np.asarray(groups), return_inverse=True)
    s = np.bincount(inv, weights=pnl, minlength=len(codes))
    n = np.bincount(inv, weights=np.ones(len(pnl)) if denom is None else np.asarray(denom, dtype=np.float64), minlength=len(codes))
    rng = np.random.default_rng(seed)
    out = np.empty(B)
    for b0 in range(0, B, 100):
        w = rng.poisson(1.0, (min(100, B - b0), len(codes)))
        out[b0:b0 + len(w)] = (w @ s) / np.maximum(w @ n, 1e-12)
    lo, hi = np.percentile(out, [2.5, 97.5])
    return float(lo), float(hi)


def paired_diff(a: pd.DataFrame, b: pd.DataFrame, B: int = 1000, seed: int = 0) -> dict:
    """
    Per-decision difference a - b over the same signals (by episode_id; a skipped signal = 0, and so is a copy the
    one-position-per-coin rule blocks), with a mint-clustered CI: how the gate compares a candidate with a baseline.
    """
    a, b = (x.assign(pnl=np.where(counted(x), x["pnl"].to_numpy(), 0.0)) if {"stake", "reason", "close_t"} <= set(x) else x for x in (a, b))
    m = a[["episode_id", "mint", "pnl"]].merge(b[["episode_id", "pnl"]], on="episode_id", how="outer", suffixes=("_a", "_b"))
    if m["mint"].isna().any():
        mm = pd.concat([a[["episode_id", "mint"]], b[["episode_id", "mint"]]]).drop_duplicates("episode_id")
        m = m.drop(columns="mint").merge(mm, on="episode_id", how="left")
    d = m["pnl_a"].fillna(0).to_numpy() - m["pnl_b"].fillna(0).to_numpy()
    lo, hi = cluster_ci(d, m["mint"].to_numpy(), B, seed)
    return {"n": int(len(d)), "mean_diff": float(d.mean()) if len(d) else float("nan"), "ci95_mint": [lo, hi]}


def metrics(out: pd.DataFrame, acc: pd.DataFrame, days: list[str], p: SimParams = SimParams(), B: int = 1000, seed: int = 0) -> dict:
    """
    Everything a policy is reported with (stress.yaml stress_suite metrics, the gate's inputs). Per copy / per decision /
    by day count only the copies one_per_coin keeps (n_stacked = the copies it blocked); the account applies its own rules.
    """
    copy = counted(out)
    stacked = is_copy(out) & ~copy
    pnl = out["pnl"].to_numpy(np.float64)
    pc = pnl[copy]
    mints_c = out["mint"].to_numpy()[copy]
    n_dec = int(len(out) - (out["reason"].isin(("too-late", "bad-print"))).sum())  # decisions the policy could take
    lo, hi = cluster_ci(pc, mints_c, B, seed)
    dlo, dhi = cluster_ci(np.where(copy, pnl, 0.0)[~out["reason"].isin(("too-late", "bad-print")).to_numpy()],
                          out["mint"].to_numpy()[~out["reason"].isin(("too-late", "bad-print")).to_numpy()], B, seed)
    entered = out["entered"].to_numpy() & copy
    reasons = out.loc[copy, "reason"].value_counts().to_dict()
    per_copy = {
        "n": int(copy.sum()), "n_mints": int(len(np.unique(mints_c))), "mean_sol": float(pc.mean()) if len(pc) else float("nan"),
        "ci95_mint": [lo, hi], "sum_sol": float(pc.sum()), "median_sol": float(np.median(pc)) if len(pc) else float("nan"),
        "win_rate": float((pc > 0).mean()) if len(pc) else float("nan"),
        "ret_on_stake": float(pc.sum() / out["stake"].to_numpy()[copy].sum()) if copy.any() else float("nan"),
        "gain_loss_ratio": float(pc[pc > 0].mean() / -pc[pc < 0].mean()) if (pc > 0).any() and (pc < 0).any() else float("nan"),
        "exit_reasons": {k: int(v) for k, v in reasons.items()},
        "censored": int(out.loc[copy, "censored"].sum()), "n_stacked": int(stacked.sum()),
        "median_hold_s": float(np.nanmedian(out.loc[entered, "hold_s"])) if entered.any() else float("nan"),
    }
    per_decision = {"n": n_dec, "mean_sol": float(pnl[copy].sum() / max(n_dec, 1)), "ci95_mint": [dlo, dhi],
                    "copy_rate": float(copy.sum() / max(n_dec, 1))}
    by_day = {}
    for d in days:
        m = (out["day"] == d).to_numpy()
        mc = m & copy
        by_day[d] = {"signals": int(m.sum()), "copies": int(mc.sum()), "sum_sol": round(float(pnl[mc].sum()), 6),
                     "mean_per_copy": float(pnl[mc].mean()) if mc.any() else None}
    # account
    eq = np.r_[p.bankroll_sol, acc["eq_after"].to_numpy()] if len(acc) else np.array([p.bankroll_sol])
    a_pnl = acc["pnl_acct"].to_numpy() if len(acc) else np.zeros(0)
    taken_entered = acc["entered"].to_numpy() if len(acc) else np.zeros(0, bool)
    daily = acc.groupby("close_day")["pnl_acct"].sum().reindex(days, fill_value=0.0) if len(acc) else pd.Series(0.0, index=days)
    opened = acc[acc["entered"]].groupby("open_day").size().reindex(days, fill_value=0) if len(acc) else pd.Series(0, index=days)
    span_ms = max(1, len(days) * 86_400_000)
    acct = {
        "trades": int(taken_entered.sum()), "attempts": int(len(acc)), "net_sol": float(a_pnl.sum()), "final_equity": float(eq[-1]),
        "min_equity": float(eq.min()), "max_drawdown_sol": max_drawdown(eq), "ruined": bool(eq.min() < RUIN_SOL),
        "win_rate": float((a_pnl[taken_entered] > 0).mean()) if taken_entered.any() else float("nan"),
        "mean_per_trade": float(a_pnl[taken_entered].mean()) if taken_entered.any() else float("nan"),
        "worst_day_sol": float(daily.min()), "daily_pnl": {d: round(float(v), 6) for d, v in daily.items()},
        "copies_per_day": {d: int(v) for d, v in opened.items()}, "copies_per_day_mean": float(opened.mean()),
        "slot_utilisation": float(acc.attrs.get("slot_ms", 0) / (span_ms * p.max_positions)) if len(acc) else 0.0,
        "blocked": acc.attrs.get("blocked", {}), "wanted": int(acc.attrs.get("n_wanted", 0)),
        "positive_days": int((daily > 0).sum()),
    }
    stale90 = out.loc[entered, "n_stale90"].sum() / max(out.loc[entered, "n_decisions"].sum(), 1)
    stale60m = out.loc[entered, "n_stale60m"].sum() / max(out.loc[entered, "n_decisions"].sum(), 1)
    coverage = {"exit_decisions_on_price_gt_90s": float(stale90), "exit_decisions_on_price_gt_60min": float(stale60m),
                "entries_on_price_gt_90s": float((out.loc[entered, "entry_age_s"] > 90).mean()) if entered.any() else float("nan"),
                "entries_on_price_gt_60min": float((out.loc[entered, "entry_age_s"] > 3600).mean()) if entered.any() else float("nan")}
    return {"per_decision": per_decision, "per_copy": per_copy, "by_day": by_day, "account": acct, "coverage": coverage}
