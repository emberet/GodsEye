"""brain.features.exit as the simulator calls it: a dict of arrays shaped like brain/sim/engine.py Decision.state gives the
same raw features as the per-decision inputs, the engine's precomputed names and missing flags are honoured, and the
offline hourly lookup follows tracked_active_wallets_1h."""
from __future__ import annotations

import json
import math

import numpy as np
import pandas as pd

from brain.features import build, golden, spec
from brain.features import exit as fx


def golden_inputs() -> list[dict]:
    doc = json.loads((golden.GOLDEN_DIR / "exit.json").read_text())
    return [fx.case_inputs(c["input"]) for c in doc["cases"]]


def same(a, b) -> bool:
    return (math.isnan(a) and math.isnan(b)) or abs(a - b) <= 1e-12 * max(1.0, abs(a))


def test_a_dict_of_arrays_gives_the_same_rows_as_one_decision_at_a_time():
    rows = golden_inputs()
    keys = sorted({k for r in rows for k in r})
    batch = {k: np.array([r.get(k, np.nan) for r in rows], dtype=object if k == "venue" else np.float64) for k in keys}
    got = fx.exit_raw(batch)
    assert isinstance(got, pd.DataFrame) and len(got) == len(rows)
    for i, r in enumerate(rows):
        one = fx.exit_raw(r)
        assert all(same(one[k], float(got[k].iloc[i])) for k in one), i


def test_the_engines_state_names_and_missing_flags_are_honoured():
    n = 3
    state = {  # what engine.Book._state returns: derived values precomputed, no tokens / venue / ret_5m_ago
        "ret_now": np.array([0.2, -0.5, 1.0]), "peak_ret": np.array([0.4, 0.0, 1.0]), "minutes_held": np.array([3.0, 30.0, 61.0]),
        "leader_sold": np.array([0.0, 1.0, 1.0]), "half_sold": np.zeros(n), "minutes_since_price": np.array([0.5, 1.5, 1.5]),
        "position": np.array([1.0, 0.5, 1.0]), "mins_since_tracked_price": np.array([0.5, 40.0, 1440.0]),
        "quote_failed": np.zeros(n), "sell_quote_ratio": np.array([1.0, 0.4, 1.0]), "sell_quote_ratio_missing": np.array([1.0, 0.0, 1.0]),
        "mom5": np.array([0.1, -0.7, 0.0]), "leader_sold_frac": np.array([0.0, 0.3, 1.0]),
        "minutes_since_leader_sold": np.array([0.0, 12.0, 50.0]), "entry_venue_pumpswap": np.array([0.0, 1.0, 0.0]),
        "oth_buyers_5m": np.array([2.0, 0.0, 1.0]), "oth_sellers_5m": np.zeros(n), "oth_net_sol_5m": np.array([0.4, 0.0, -1.0]),
        "pts_5m": np.array([5.0, 0.0, 1.0]),
        "t": np.array([1, 2, 3]), "episode_id": np.array([7, 8, 9]),  # event context: ignored
    }
    raw = fx.exit_raw(state)
    assert list(raw["position"]) == [1.0, 0.5, 1.0] and list(raw["mom5"]) == [0.1, -0.7, 0.0]
    assert list(raw["entry_venue_pumpswap"]) == [0.0, 1.0, 0.0]
    assert np.isnan(raw["sell_quote_ratio"][0]) and raw["sell_quote_ratio"][1] == 0.4 and np.isnan(raw["sell_quote_ratio"][2])
    assert raw["drawdown_from_peak"][0] == 1 - 1.2 / 1.4 and raw["drawdown_from_peak"][1] == 0.5
    assert raw["entry_tracked_active_wallets_1h"].isna().all() and raw["leader_ps_r_7d"].isna().all()
    feats = spec.exit_features()
    cols = spec.columns(feats)
    Z = fx.exit_matrix(state, spec.fit_norm(spec.encode(raw, feats), cols))
    assert Z.shape == (n, len(cols)) and np.isfinite(Z).all()
    assert list(Z[:, cols.index("sell_quote_ratio_missing")]) == [1.0, 0.0, 1.0]


def test_hourly_lookup_reads_the_previous_complete_hour():
    h0 = 1_792_800_000 // 3_600 * 3_600
    hourly = pd.Series([10.0, 0.0, 30.0], index=[h0, h0 + 3_600, h0 + 7_200])
    t_s = np.array([h0 + 3_600, h0 + 3_600 + 3_599, h0 + 7_200 + 1, h0 + 10_800, h0 + 14_400, h0 + 100])
    got = build.active_wallets_at(t_s, hourly)
    # an hour with nothing delivered is one no process saw: missing like an hour outside the data, never 0
    assert np.array_equal(got[[0, 1, 3]], [10.0, 10.0, 30.0]) and np.isnan(got[[2, 4, 5]]).all()
    assert np.array_equal(fx.active_wallets_1h(t_s * 1000, hourly), got, equal_nan=True)


def test_hours_no_process_saw_are_missing():
    """active_hours: empty hours, derive's ingest-outage hours and a dip inside an hour are NaN; the rest keep their count."""
    h0 = 1_792_800_000 // 3_600 * 3_600
    hours = np.arange(h0, h0 + 8 * 3_600, 3_600)
    counts = pd.Series([5_000.0, 5_200.0, 36.0, 5_100.0, 40.0, 30.0, 20.0], index=hours[[0, 1, 2, 3, 5, 6, 7]])  # h0+4h: none
    got = build.active_hours(counts, hours, outage=[h0 + 6 * 3_600])
    assert got.index.name == "h" and list(got.index) == list(hours)
    want = [5_000.0, 5_200.0, np.nan, 5_100.0, np.nan, 40.0, np.nan, 20.0]  # dip; empty; outage. A lasting drop stays.
    assert np.array_equal(got.to_numpy(), want, equal_nan=True)
    t_s = hours + 3_600 + 5
    assert np.array_equal(build.active_wallets_at(t_s, got), want, equal_nan=True)
