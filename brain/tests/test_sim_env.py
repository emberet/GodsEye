"""brain.sim.env: the reward.yaml reward. Exit rewards telescope to g(U) exactly, sell_half is allowed once, blocked /
forced paths settle, and the one-episode Env agrees with the batch."""
from __future__ import annotations

import numpy as np
import pytest

from brain.sim.env import BatchEnv, Env, g, kappa_from_spec
from test_sim_engine import BASE, L, P0, build, flat_tape, signal, sw


def window():
    swaps = flat_tape(0, 6000, every=9) + flat_tape(0, 6000, every=13, mint="M2", start_id=9000, price=2 * P0)
    sigs = []
    for i, (t, m, ls) in enumerate([(100, "M1", 400), (300, "M2", 2000), (700, "M1", None), (1200, "M2", 1250)]):
        price = P0 if m == "M1" else 2 * P0
        swaps.append(sw(100 + i, L, t, "buy", price, mint=m, tokens=1e6))
        if ls:
            swaps.append(sw(200 + i, L, ls, "sell", price, mint=m, tokens=1e6, bal=1e6))
        sigs.append(signal(100 + i, t, mint=m, price=price))
    # a crash on M1 after 3000 s, so some positions meet the hard stop
    swaps += flat_tape(3000, 6000, every=9, price=0.2 * P0, start_id=20_000)
    data, p = build(swaps, sigs)
    return data, p


def test_kappa_is_read_from_reward_yaml():
    assert kappa_from_spec() == 1.5
    assert g(np.array([0.1, -0.1]), 1.5).tolist() == pytest.approx([0.1, -0.15])


def test_exit_rewards_telescope_to_g_of_the_realized_pnl():
    data, p = window()
    rng = np.random.default_rng(1)
    env = BatchEnv(data, p, seed=0, kappa=1.5, features=True)
    dec = env.reset(np.arange(4))
    total = np.zeros(4)
    stepped = np.zeros(4, bool)
    n_steps = 0
    while dec is not None:
        assert {"oth_buyers_5m", "pts_5m", "ret_now", "minutes_held"} <= set(dec.state)
        a = rng.choice([0, 0, 0, 0, 1, 2], size=len(dec.idx))
        stepped[dec.idx] = True
        tr, dec = env.step(a)
        np.add.at(total, tr.idx, tr.reward)
        n_steps += 1
    res = env.results()
    assert n_steps > 3
    for i in np.flatnonzero(stepped):
        assert total[i] == pytest.approx(g(res["pnl"][i], 1.5), abs=1e-12)
    assert np.allclose(res["R"], g(res["pnl"].to_numpy(), 1.5))


def test_sell_half_is_allowed_once():
    data, p = window()
    env = BatchEnv(data, p, kappa=1.5)
    dec = env.reset([2])  # the leader never sells M1 for this one
    halves = 0
    while dec is not None:
        tr, dec = env.step(np.ones(len(dec.idx), dtype=np.int64))  # always sell_half
        halves += 1
    out = env.results()
    assert out["half_sold"][0]
    assert out["n_tx"][0] <= 3  # the buy, one half, and the forced close (a second half is a hold)


def test_single_env_matches_the_batch():
    data, p = window()
    e = Env(data, params=p, kappa=1.5)
    s = e.reset(0)
    assert s is not None and 0 <= s["minutes_held"] < 1
    total, done = 0.0, False
    while not done:
        s, r, done, info = e.step(0)
        total += r
    assert info["reason"] in ("exit", "hard-stop", "max-hold", "dead")
    assert total == pytest.approx(info["R"], abs=1e-12)
    b = BatchEnv(data, p, kappa=1.5)
    d = b.reset([0])
    while d is not None:
        _, d = b.step(np.zeros(len(d.idx), dtype=np.int64))
    assert b.results()["pnl"][0] == pytest.approx(info["pnl"], rel=1e-12)


def test_no_position_returns_the_entry_outcome():
    data, p = window()
    e = Env(data, params=p.__class__(**{**p.__dict__, "buy_fail_p": 1.0}), kappa=1.5)
    assert e.reset(0) is None
    assert e.info["reason"] == "buy-fail" and e.info["pnl"] == pytest.approx(-p.tx_cost_sol)
