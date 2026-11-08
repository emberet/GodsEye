"""brain.baselines and the mirror ledger (brain.sim.ledger): the exit rules, B2's point-in-time weights and stake, B4's
veto, cp_* features over [t - 7 d, t) on resolved_at, and the strict mirror copy outcome on a hand-built tape."""
from __future__ import annotations

import duckdb
import numpy as np
import pandas as pd
import pytest

from brain import baselines as B
from brain.sim.ledger import HAIRCUT, cp_features, mirror
from brain.sim.params import SimParams
from brain.sim.signals import prepare
from brain.sim.tape import T0_MS, SwapTape
from test_sim_engine import BASE, L, O, P, P0, flat_tape, signal, sw

DAY = 86_400_000


def st(**kw) -> dict:
    n = len(next(iter(kw.values())))
    base = {"ret_now": np.zeros(n), "peak_ret": np.zeros(n), "drawdown_from_peak": np.zeros(n), "minutes_held": np.zeros(n),
            "event_leader_sell": np.zeros(n, bool), "leader_sell_frac": np.zeros(n)}
    base.update({k: np.asarray(v) for k, v in kw.items()})
    return base


def test_follow_leader_is_the_copy_engine_rule():
    s = st(event_leader_sell=[True, True, False, True], leader_sell_frac=[0.3, 0.95, 1.0, 0.0])
    assert B.follow_leader(s).tolist() == [0.3, 1.0, 0.0, 0.0]


def test_rule_exits():
    s = st(ret_now=[-0.4, 3.5, 0.1, 0.0, np.nan], peak_ret=[0, 3.5, 0.5, 0, 0], drawdown_from_peak=[0.4, 0, 0.27, 0, 0],
           minutes_held=[1, 1, 1, 11, 1], event_leader_sell=[False, False, False, False, True], leader_sell_frac=[0, 0, 0, 0, 0.5])
    assert B.B2_EXIT(s).tolist() == [1.0, 1.0, 0.0, 0.0, 0.5]
    assert B.RuleExit("x", trail=0.2)(s).tolist() == [1.0, 0.0, 1.0, 0.0, 0.5]
    assert B.RuleExit("x", follow=False, time_min=10)(s).tolist() == [0.0, 0.0, 0.0, 1.0, 0.0]
    assert len({e.name for e in B.EXIT_CANDIDATES}) == len(B.EXIT_CANDIDATES)


def test_b2_weights_are_point_in_time_and_sized_by_copysize():
    con = duckdb.connect()
    con.execute("""CREATE TABLE weight_history AS SELECT * FROM (VALUES
        ('A', TIMESTAMPTZ '2026-10-30 00:00:00+00', 0.05), ('A', TIMESTAMPTZ '2026-10-31 12:00:00+00', 0.0),
        ('B', TIMESTAMPTZ '2026-10-30 00:00:00+00', 0.5), ('C', TIMESTAMPTZ '2026-10-30 00:00:00+00', 0.005)) t(wallet, ts, new_weight)""")
    t = lambda s: int(pd.Timestamp(s, tz="UTC").timestamp() * 1000) - T0_MS  # noqa: E731
    w = B.weights_at(con, ["A", "A", "A", "B", "Z"], [t("2026-10-29"), t("2026-10-31"), t("2026-11-01"), t("2026-10-31"), t("2026-10-31")])
    assert w.tolist() == [0.0, 0.05, 0.0, 0.5, 0.0]
    s = pd.DataFrame({"leader": ["A", "B", "B", "C"], "mint": ["xpump", "ypump", "y", "zpump"], "t_dec": [t("2026-10-31")] * 4})
    stake = B.b2_entry(con, SimParams())(s)
    assert stake.tolist() == [0.05, 0.1, 0.0, 0.0]  # copySize; non-pump coin; below COPY_MIN_TRADE_SOL


def test_cp_features_window_and_shrinkage():
    led = pd.DataFrame({"leader": ["A"] * 4 + ["B"], "y": [0.5, -0.5, 1.0, 9.0, -1.0], "resolved_ms": [0, DAY, 2 * DAY, 9 * DAY, DAY]})
    cp = cp_features(led, ["A", "A", "A", "B", "Z"], [DAY, 3 * DAY, 8 * DAY + 1, 2 * DAY, 2 * DAY])
    assert cp["cp_n_7d"].tolist() == [1, 3, 1, 1, 0]   # [t - 7 d, t): resolved at exactly t is not known yet, 7 d + 1 ms ago is gone
    assert cp["cp_lrshr_7d"][1] == pytest.approx((np.log1p(0.5) + np.log1p(-0.5) + np.log1p(1.0)) / 23)
    assert cp["cp_win_7d"][1] == pytest.approx(2 / 3)
    assert cp["cp_lrshr_7d"][3] == pytest.approx(np.log1p(-0.99) / 21)
    assert np.isnan(cp["cp_win_7d"][4]) and cp["cp_lrshr_7d"][4] == 0


def test_b4_vetoes_gated_unknown_and_bottom_leaders():
    led = pd.DataFrame({"leader": ["good", "bad"], "y": [0.5, -0.9], "resolved_ms": [0, 0]})
    s = pd.DataFrame({"leader": ["good", "bad", "new", "good"], "t_dec": [DAY] * 4, "gate": ["", "", "", "young_amm"]})
    stake = B.b4_entry(led, q20=-0.01, p=SimParams())(s)
    assert stake.tolist() == [0.1, 0.0, 0.0, 0.0]


def test_mirror_ledger_strict_timing():
    # entry: first non-leader ok print in [ts + 15, ts + 135]; exit: first non-leader SELL at/after leader sell + 15 s
    swaps = [sw(1, L, 100, "buy", P0, tokens=1e6), sw(2, L, 116, "buy", 1.5 * P0),       # the leader's own print is skipped
             sw(3, O, 118, "buy", P0), sw(4, L, 200, "sell", P0, tokens=1e6, bal=1e6),
             sw(5, O, 214, "sell", 3 * P0), sw(6, P, 216, "buy", 3 * P0), sw(7, O, 220, "sell", 2 * P0)]
    # a second coin the leader holds 24 h while it dies
    swaps += [sw(10, L, 1000, "buy", P0, mint="M2"), sw(11, O, 1020, "buy", P0, mint="M2"), sw(12, O, 1100, "sell", 0.9 * P0, mint="M2")]
    # a third that crashes through -60 % before the leader sells: stop at the gap print
    swaps += [sw(20, L, 2000, "buy", P0, mint="M3", tokens=1e6), sw(21, O, 2020, "buy", P0, mint="M3"), sw(22, O, 2100, "sell", 0.3 * P0, mint="M3"),
              sw(23, L, 2200, "sell", 0.3 * P0, mint="M3", tokens=1e6, bal=1e6), sw(24, O, 2300, "sell", 0.3 * P0, mint="M3")]
    tape = SwapTape.from_frame(pd.DataFrame(swaps), insert_index=False)
    sig = prepare(pd.DataFrame([signal(1, 100), signal(10, 1000, mint="M2"), signal(20, 2000, mint="M3")]))
    end = (BASE + 10 * 86400) * 1000 - T0_MS
    led = mirror(sig, tape, end).set_index("episode_id")
    assert led.loc[1, "how"] == "follow"
    assert led.loc[1, "y"] == pytest.approx(2.0 - 1 - HAIRCUT)                 # the 220 sell at 2x (the 3x sell at 214 is before 215)
    assert led.loc[1, "resolved_ms"] == (BASE + 220) * 1000 - T0_MS
    assert led.loc[10, "how"] == "held_dark" and led.loc[10, "y"] == pytest.approx(-1.0)  # dead: no haircut (features.yaml)
    assert led.loc[10, "resolved_ms"] == (BASE + 1000 + 30 * 3600) * 1000 - T0_MS
    assert led.loc[20, "how"] == "stop" and led.loc[20, "y"] == pytest.approx(0.3 - 1 - HAIRCUT)
    # not resolved by the data end: left out
    assert 10 not in mirror(sig, tape, (BASE + 86400) * 1000 - T0_MS)["episode_id"].tolist()


def test_mirror_ledger_resolves_at_insert_time():
    # the same copy as above, but the deciding sell reached the server an hour late, and on a second coin the buy itself
    # was stored a day late: resolved_at is the latest insert time, never the block time
    swaps = [sw(1, L, 100, "buy", P0, tokens=1e6), sw(3, O, 118, "buy", P0), sw(4, L, 200, "sell", P0, tokens=1e6, bal=1e6, ins=500),
             sw(7, O, 220, "sell", 2 * P0, ins=3820)]
    swaps += [sw(10, L, 1000, "buy", P0, mint="M2", tokens=1e6), sw(11, O, 1020, "buy", P0, mint="M2"),
              sw(12, L, 1100, "sell", P0, mint="M2", tokens=1e6, bal=1e6), sw(13, O, 1120, "sell", P0, mint="M2")]
    tape = SwapTape.from_frame(pd.DataFrame(swaps), insert_index=False)
    late_buy = {**signal(10, 1000, mint="M2"), "ins_ts": pd.Timestamp(BASE + 1000 + 86400, unit="s", tz="UTC")}
    sig = prepare(pd.DataFrame([signal(1, 100), late_buy]))
    led = mirror(sig, tape, (BASE + 10 * 86400) * 1000 - T0_MS).set_index("episode_id")
    ms = lambda s: (BASE + s) * 1000 - T0_MS  # noqa: E731
    assert led.loc[1, "how"] == "follow" and led.loc[1, "resolved_ms"] == ms(3820)
    assert led.loc[10, "how"] == "follow" and led.loc[10, "resolved_ms"] == ms(1000 + 86400)
    # a leader sell stored after the deciding print sets the time too
    swaps[2] = sw(4, L, 200, "sell", P0, tokens=1e6, bal=1e6, ins=9000)
    led = mirror(sig, SwapTape.from_frame(pd.DataFrame(swaps), insert_index=False), (BASE + 10 * 86400) * 1000 - T0_MS).set_index("episode_id")
    assert led.loc[1, "resolved_ms"] == ms(9000)
