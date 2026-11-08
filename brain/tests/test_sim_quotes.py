"""brain.sim.quotes and brain.sim.stress: the quote model is fit on pre-test quotes only and is monotone; obs_ratio is
conditioned on known-at-t inputs only; the stress scenarios are the ones stress.yaml names; training chaos stays in range."""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd
import pytest
import yaml

from brain.data import splits
from brain.sim import stress
from brain.sim.params import Chaos
from brain.sim.quotes import QuoteModel, age_bin, monotone_down, tape_group, venue_group

STRESS = Path(__file__).resolve().parents[1] / "spec" / "stress.yaml"


def samples(n=600, seed=0, when="2026-10-28", ratio_alive=0.98, dark_ratio=0.05) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    age = np.exp(rng.uniform(0, np.log(80_000), n))
    dead = rng.random(n) < 0.4
    rug = dead & (age > 300) & (rng.random(n) < 0.8)
    close = np.full(n, 0.1)
    quote = np.where(rug, np.nan, np.where(dead, close * dark_ratio, close * ratio_alive))
    return pd.DataFrame({"sampled_at": pd.Timestamp(when, tz="UTC"), "status": "ok", "transient_err": False, "close_ok": close,
                         "quote_val": np.where(rug, 0.0, quote), "rug": rug, "age_ok_s": age, "venue": rng.choice(["pumpswap", "pumpfun (via bot)", "jupiter"], n),
                         "n_tape_10min": rng.integers(0, 20, n), "tape_dead": dead})


def test_fit_ignores_quotes_from_the_test_period():
    pre = samples()
    poisoned = pd.concat([pre, samples(400, 1, when=str(splits.test_start() + pd.Timedelta(hours=1)), ratio_alive=5.0, dark_ratio=2.0)])
    a, b = QuoteModel.fit(pre), QuoteModel.fit(poisoned)
    assert np.allclose(a.alive, b.alive) and np.allclose(a.dark, b.dark) and np.allclose(a.obs, b.obs)
    assert b.meta["n"] == len(pre)


def test_curves_are_monotone_and_dark_falls_below_alive():
    q = QuoteModel.fit(samples())
    ages = np.array([1, 30, 100, 1000, 10_000, 100_000])
    assert np.all(np.diff(q.m_alive(ages)) <= 1e-12) and np.all(np.diff(q.f_dark(ages)) <= 1e-12)
    assert np.all(q.f_dark(ages[2:]) < q.m_alive(ages[2:]))
    r = q.obs_ratio(ages, np.zeros(6, int), np.ones(6, int))
    assert np.all(np.diff(r) <= 1e-12) and r[0] <= 1.05


def test_helpers():
    assert venue_group(["pumpswap (via bot)", "pumpfun", "meteora damm v2", None]).tolist() == [0, 1, 2, 2]
    assert tape_group([0, 3, 10]).tolist() == [0, 1, 2]
    assert age_bin([0, 9.9, 10, 1e9]).tolist() == [0, 0, 1, 6]
    assert monotone_down([1.0, 0.5, 0.7, 0.2]).tolist() == pytest.approx([1.0, 0.6, 0.6, 0.2])
    fb = QuoteModel.fallback()
    assert fb.f_dark(3600) < 0.10 < fb.f_dark(60)


def test_saved_round_trip(tmp_path):
    q = QuoteModel.fit(samples())
    f = q.save(tmp_path / "qm.json")
    q2 = QuoteModel.load(f)
    assert np.allclose(q.obs, q2.obs) and q2.meta["n"] == q.meta["n"]


def test_stress_suite_names_match_stress_yaml():
    names = [s["name"] for s in yaml.safe_load(STRESS.read_text())["stress_suite"]]
    assert [f.__name__ for f in stress.SCENARIOS] == names
    sc = {s.name: s for s in stress.scenarios(include_test=True)}
    assert sc["base_selection"].chaos == Chaos() and sc["base_selection"].dates == ("2026-10-31", "2026-11-01")
    assert sc["dead_pool_extreme"].chaos.dead_pool["pumpswap"] == 1.0
    assert sc["sell_outage"].chaos.sell_fail_p == 0.5
    assert len(sc["delay_x4"].chaos.backlog_hours) == 2 and sc["delay_x4"].chaos.delay_mult == 4.0
    assert sum(v == 7.49 for v in sc["fee_spike"].chaos.tx_spike.values()) == 14
    assert "held_out_test" not in {s.name for s in stress.scenarios()}


def test_training_chaos_ranges():
    rng = np.random.default_rng(0)
    hours = stress.hour_starts(["2026-10-28"])
    draws = [stress.sample_training_chaos(rng, hours) for _ in range(300)]
    assert {c.delay_mult for c in draws} == {1.0, 2.0, 4.0}
    assert all(0.5 <= c.slip_mult <= 3.0 and 0.0003 <= c.tx_cost_sol <= 0.0008 and 0 <= c.rug_rate <= 0.1 for c in draws)
    assert all(0.9 <= c.dead_pool["pumpswap"] <= 1.0 and 0.245 <= c.sell_fail_p <= 0.5 and 0.098 <= c.buy_fail_p <= 0.2 for c in draws)
    assert 0.15 < np.mean([c.universe_keep < 1 for c in draws]) < 0.45
    assert 0.01 < np.mean([len(c.backlog_hours) / 24 for c in draws]) < 0.06
    assert all(set(c.tx_spike.values()) <= {3.41, 7.49, 27.14} for c in draws)
