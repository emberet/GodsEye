"""
brain.train's selection rules: the exit choice on the paired per-decision statistic, and reward.yaml's day-block bootstrap
p95 of the max drawdown that the (kappa, margin_c) grid filters on.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from brain.train import exit_winner, maxdd_p95


def test_the_rule_replaces_iql_only_when_the_paired_ci_is_below_zero():
    # 2026-11-07T22-48-49Z's numbers: IQL ahead per decision with the CI above 0 (t1's per-copy mean looked better)
    assert exit_winner({"mean_diff": 8.4e-5, "ci95_mint": [1.9e-5, 1.5e-4]}, "t1") == {
        "chosen": "iql", "significant": True, "decision_rule": exit_winner({"ci95_mint": [0, 0]}, "t1")["decision_rule"]}
    tie = exit_winner({"mean_diff": -1e-5, "ci95_mint": [-4e-5, 2e-5]}, "t1")
    assert tie["chosen"] == "iql" and not tie["significant"]
    assert exit_winner({"mean_diff": -6e-5, "ci95_mint": [-9e-5, -2e-5]}, "t1")["chosen"] == "t1"


def acc(rows):
    return pd.DataFrame(rows, columns=["open_day", "close_at", "pnl_acct"])


def test_maxdd_p95_resamples_whole_days():
    # day a loses 0.3 then wins it back; day b is flat: drawing a twice gives 0.3, a then b 0.3, b twice 0
    a = acc([("a", 1, -0.3), ("a", 2, 0.3), ("b", 3, 0.0)])
    assert maxdd_p95(a, ["a", "b"], 1.0, B=400) == pytest.approx(0.3)
    # two losing days in a row draw a deeper drawdown than the single path's
    a = acc([("a", 1, -0.4), ("b", 2, 0.5)])
    p95 = maxdd_p95(a, ["a", "b"], 1.0, B=400)
    assert p95 == pytest.approx(0.8) and p95 > 0.4  # the one path's own max drawdown is 0.4
    assert maxdd_p95(acc([]), ["a"], 1.0) == 0.0


def test_maxdd_p95_keeps_closes_in_time_order_within_a_day():
    a = acc([("a", 2, -0.2), ("a", 1, 0.2)])  # in close order: +0.2 then -0.2 -> drawdown 0.2 from the 1.2 high
    assert maxdd_p95(a, ["a"], 1.0, B=50) == pytest.approx(0.2)
    rng = np.random.default_rng(0)
    big = acc([(d, i, x) for i, (d, x) in enumerate(zip(rng.choice(["a", "b", "c"], 300), rng.normal(0, 0.01, 300)))])
    assert maxdd_p95(big, ["a", "b", "c"], 1.0, B=200, seed=1) == maxdd_p95(big, ["a", "b", "c"], 1.0, B=200, seed=1)
