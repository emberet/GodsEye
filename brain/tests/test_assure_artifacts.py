"""brain.assure.artifacts: every report artifact check passes on the rebuilt simulator, and fails on the artifact itself."""
from __future__ import annotations

from dataclasses import replace

import numpy as np
import pytest

from brain.assure import artifacts as A
from brain.assure import features as F
from brain.assure.suite import _stacked_frame
from brain.assure.worlds import World, WorldSpec
from brain.sim.params import SimParams

P = SimParams()


@pytest.fixture(scope="module")
def world():
    return World(WorldSpec(seed=0, backfill_days=(4,)))


def test_a1_dead_coins_are_written_off_and_the_tape_price_mutant_fails(world):
    c = A.dead_coins(world, p=P)
    assert c.passed, c.value
    m = A.dead_coins(world, quotes=A.tape_valued(), p=P)
    assert not m.passed and m.value["mean_return"] > 0      # the report's artifact: rugs look like wins on the tape


def test_a2_follow_exit_fills_after_the_sell_and_the_minute_close_mutant_fails(world):
    c = A.exit_timing(world, p=P)
    assert c.passed, c.value
    m = A.exit_timing(world, A.minute_close, p=P)
    assert not m.passed and m.value["mean_return"] > 0      # B3's "+2.2 SOL"


def test_a3_stops_fill_at_the_gap_and_a_clamped_stop_fails(world):
    c = A.stops_at_gap(world, p=P)
    assert c.passed, c.value
    win = world.window()
    t = world.truth_of(win)
    rows = np.flatnonzero((t["kind"] == "loud_rug").to_numpy() & (win.data.sig["gate"].to_numpy() == ""))
    out = A.evaluate(win, A.full_stake(P), A.hold, P, rows=rows, B=10).out
    hs = (out["reason"] == "hard-stop").to_numpy()
    out.loc[hs, "pnl"] = -0.6 * out.loc[hs, "stake"]        # filled at the stop level
    assert not A.stops_at_gap(world, P, out=out).passed


def test_a4_break_even_matches_the_measured_costs_and_the_old_fee_fails():
    c = A.break_even(P)
    assert c.passed, c.value
    assert 0.035 < c.value["at_0.1_sol"] < 0.045
    assert not A.break_even(replace(P, tx_cost_sol=0.00015)).passed   # the agent's old 0.00015 understates small stakes
    assert not A.break_even(replace(P, fee_bps=0.0)).passed


def test_a5_calibration_must_predate_the_selection_window():
    ok = {"n": 100, "fit_before": "2026-10-31T00:00:00+00:00", "sampled_to": "2026-10-30 23:00:00+00:00"}
    bad = {"n": 100, "fit_before": "2026-11-02T00:00:00+00:00", "sampled_to": "2026-11-01 23:36:00+00:00"}
    assert A.calibration_cutoff(ok, "2026-10-31").passed
    assert not A.calibration_cutoff(bad, "2026-10-31").passed
    assert not A.calibration_cutoff({"n": 1}, "2026-10-31").passed      # no recorded cutoff
    assert A.calibration_cutoff({"fallback": "x"}, "2026-10-31").passed


def test_a6_point_in_time_builder_passes_and_the_leaky_one_fails(world):
    m = F.mirror(world, P)
    assert A.point_in_time(world, F.build, m, cuts=(0.5,)).passed
    leaky = A.point_in_time(world, lambda *a, **k: F.build(*a, leaky=True, **k), m, cuts=(0.5,))
    assert not leaky.passed and "leak_canary" in leaky.value["features_that_changed"]


def test_a7_stacked_copies_count_once_and_a_broken_rule_fails(monkeypatch):
    assert A.one_per_coin_rule(_stacked_frame()).passed
    monkeypatch.setattr(A, "one_per_coin", lambda out: np.ones(len(out), bool))
    assert not A.one_per_coin_rule(_stacked_frame()).passed
