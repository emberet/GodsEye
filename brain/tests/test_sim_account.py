"""brain.sim.account: paper.ts room() rules (5 slots, one coin, budget, daily loss limit, stake scaling), the metrics and
the mint-clustered CI / paired difference the gate uses."""
from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from brain.sim.account import account, cluster_ci, max_drawdown, metrics, one_per_coin, paired_diff
from brain.sim.params import SimParams
from brain.sim.tape import T0_MS

DAY0 = int(pd.Timestamp("2026-10-31", tz="UTC").timestamp() * 1000) - T0_MS
MIN = 60_000


def outs(rows) -> pd.DataFrame:
    """rows: (episode_id, mint, t_dec_min, close_min, stake, pnl[, reason])."""
    d = pd.DataFrame([r if len(r) == 7 else (*r, "exit") for r in rows], columns=["episode_id", "mint", "t", "c", "stake", "pnl", "reason"])
    return pd.DataFrame({
        "episode_id": d["episode_id"], "leader": "L", "mint": d["mint"], "day": "2026-10-31", "t_dec": DAY0 + d["t"] * MIN, "stake": d["stake"],
        "entered": ~d["reason"].isin(["buy-fail"]), "E": DAY0 + d["t"] * MIN + 4000, "close_t": DAY0 + d["c"] * MIN, "pnl": d["pnl"],
        "reason": d["reason"], "n_tx": 2, "rent_lost": d["reason"].eq("dead"), "censored": False, "entry_age_s": 1.0,
        "n_decisions": 3, "n_stale90": 1, "n_stale60m": 0, "hold_s": (d["c"] - d["t"]) * 60.0, "half_sold": False,
    }), (DAY0 + d["t"] * MIN).to_numpy()


def test_five_slots_one_coin_and_first_come_first_served():
    rows = [(i, f"m{i}", i, 100, 0.1, 0.01) for i in range(6)] + [(10, "m0", 7, 20, 0.1, 0.05), (11, "m9", 200, 210, 0.1, 0.02)]
    o, t = outs(rows)
    acc = account(o, t)
    assert acc["episode_id"].tolist()[:5] == [0, 1, 2, 3, 4]
    assert 5 not in acc["episode_id"].tolist() and 10 not in acc["episode_id"].tolist()
    assert acc.attrs["blocked"]["positions"] == 1 and acc.attrs["blocked"]["coin"] == 1  # #5: 5 open; #10: m0 is held
    assert 11 in acc["episode_id"].tolist()


def test_daily_loss_limit_blocks_until_the_next_utc_day():
    rows = [(i, f"m{i}", i * 2, i * 2 + 1, 0.1, -0.11) for i in range(6)] + [(20, "x", 1500, 1501, 0.1, 0.01)]
    o, t = outs(rows)
    acc = account(o, t)
    # the limit is checked before entering: losses 0.11 x 5 = 0.55 >= 0.5 block the 6th; the next day (min 1500) is open
    assert len(acc[acc["open_day"] == "2026-10-31"]) == 5
    assert acc.attrs["blocked"]["daily_loss"] == 1
    assert 20 in acc["episode_id"].tolist()


def test_daily_loss_limit_counts_net_realized_pnl():
    # paper.ts: day_loss_sol -= pnl on every close, so a winner closed the same day offsets the losses
    rows = [(i, f"m{i}", i * 2, i * 2 + 1, 0.1, -0.11) for i in range(4)] + [(9, "w", 8, 9, 0.1, 0.2)]
    rows += [(i, f"m{i}", i * 2, i * 2 + 1, 0.1, -0.11) for i in range(10, 13)]
    o, t = outs(rows)
    acc = account(o, t)
    # when #12 decides: 6 x -0.11 + 0.2 = -0.46 net, open (losses alone, 0.66, would have blocked it)
    assert acc.attrs["blocked"]["daily_loss"] == 0
    # after it: 7 x -0.11 + 0.2 = -0.57 -> the limit is reached
    rows.append((13, "late", 40, 41, 0.1, 0.01))
    o, t = outs(rows)
    acc = account(o, t)
    assert acc.attrs["blocked"]["daily_loss"] == 1 and 13 not in acc["episode_id"].tolist()


def test_cash_shrinks_the_stake_and_scales_the_pnl():
    p = SimParams(bankroll_sol=0.45)
    rows = [(i, f"m{i}", i, 100, 0.1, 0.02) for i in range(5)]
    o, t = outs(rows)
    acc = account(o, t, p)
    assert acc["size"].round(6).tolist()[:4] == [0.1, 0.1, 0.1, 0.1]
    # budget left 0.05, but cash pays each entry's fee and rent too: 0.45 - 4 x (0.1 + tx + rent) - tx - rent
    size = 0.45 - 4 * (0.1 + p.tx_cost_sol + p.rent_sol) - p.tx_cost_sol - p.rent_sol
    fixed = 2 * p.tx_cost_sol
    last = acc.iloc[4]
    assert last["size"] == pytest.approx(size)
    assert last["pnl_acct"] == pytest.approx((0.02 + fixed) * size / 0.1 - fixed)


def test_metrics_per_decision_per_copy_and_slots():
    rows = [(i, f"m{i % 3}", i * 10, i * 10 + 5, 0.1, 0.01 * (1 if i % 2 else -1)) for i in range(10)]
    rows += [(50, "z", 600, 600, 0.0, 0.0, "skip"), (51, "z", 610, 610, 0.1, 0.0, "too-late")]
    o, t = outs(rows)
    acc = account(o, t)
    m = metrics(o, acc, ["2026-10-31"], B=200)
    assert m["per_copy"]["n"] == 10
    assert m["per_decision"]["n"] == 11  # the too-late signal is not a decision the policy could take; the skip is
    assert m["per_decision"]["mean_sol"] == pytest.approx(sum(r[5] for r in rows[:10]) / 11)
    assert m["account"]["trades"] == 10
    assert m["account"]["slot_utilisation"] == pytest.approx(10 * 5 / (1440 * 5), rel=1e-6)
    assert m["account"]["copies_per_day"] == {"2026-10-31": 10}


def test_per_signal_metrics_keep_one_position_per_coin():
    # three copies of coin "a" while the first is open (minutes 0-30), one after it closed; a blocked copy blocks nothing
    rows = [(1, "a", 0, 30, 0.1, -0.05), (2, "a", 5, 50, 0.1, 0.40), (3, "a", 10, 12, 0.1, 0.40), (4, "a", 30, 40, 0.1, 0.02),
            (5, "b", 6, 8, 0.1, 0.01), (6, "a", 35, 36, 0.0, 0.0, "skip")]
    o, t = outs(rows)
    assert one_per_coin(o).tolist() == [True, False, False, True, True, True]  # #4 decides as #1 closes: the coin is free
    m = metrics(o, account(o, t), ["2026-10-31"], B=100)
    assert m["per_copy"]["n"] == 3 and m["per_copy"]["n_stacked"] == 2
    assert m["per_copy"]["mean_sol"] == pytest.approx((-0.05 + 0.02 + 0.01) / 3)
    assert m["per_decision"]["n"] == 6 and m["per_decision"]["mean_sol"] == pytest.approx((-0.05 + 0.02 + 0.01) / 6)
    assert m["by_day"]["2026-10-31"]["copies"] == 3
    # the paired difference scores a blocked copy 0, like a skip
    d = paired_diff(o, o.assign(pnl=0.0), B=50)
    assert d["mean_diff"] == pytest.approx((-0.05 + 0.02 + 0.01) / 6)


def test_cluster_ci_and_paired_diff():
    rng = np.random.default_rng(0)
    pnl = rng.normal(0.01, 0.01, 2000)
    lo, hi = cluster_ci(pnl, np.arange(2000) % 50, B=400)
    assert lo < 0.01 < hi
    a = pd.DataFrame({"episode_id": [1, 2, 3], "mint": ["a", "b", "c"], "pnl": [0.01, -0.02, 0.0]})
    b = pd.DataFrame({"episode_id": [2, 4], "mint": ["b", "d"], "pnl": [-0.01, 0.03]})
    d = paired_diff(a, b, B=200)
    assert d["n"] == 4 and d["mean_diff"] == pytest.approx((0.01 - 0.01 + 0.0 - 0.03) / 4)


def test_max_drawdown():
    assert max_drawdown(np.array([1.0, 1.2, 0.9, 1.1, 0.8])) == pytest.approx(0.4)
