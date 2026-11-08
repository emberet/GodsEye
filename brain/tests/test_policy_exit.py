"""
brain.policy.exit: the exit columns from the simulator's state (fast path = brain.features), trajectory collection with
the reward.yaml shaping (a position's rewards telescope to g(net P&L)), IQL and rule distillation, the runtime's argmax.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from brain.assure.worlds import World, WorldSpec
from brain.baselines import RuleExit
from brain.features import exit as fx
from brain.policy import exit as px
from brain.policy.score import choose, simulate
from brain.policy.bundle import stake_callback
from brain.sim.env import BatchEnv, g
from brain.sim.evaluate import evaluate
from brain.sim.params import Chaos, SimParams
from brain.sim.tape import T0_MS

T1 = RuleExit("t1", follow=False, time_min=1)


@pytest.fixture(scope="module")
def world():
    return World(WorldSpec(seed=3, days=4, signals_per_day=150))


@pytest.fixture(scope="module")
def buf(world):
    w = world.window()
    rows = np.flatnonzero(w.data.sig["gate"].to_numpy() == "")[:250]
    return px.collect(w, rows, px.ExitFeaturizer(), seed=0, params=SimParams()), w, rows


def hourly():
    h0 = 1_793_000_000 // 3600 * 3600
    idx = np.arange(h0, h0 + 48 * 3600, 3600)
    return pd.Series(np.where(np.arange(48) % 7 == 3, 0.0, np.arange(48) * 10.0 + 5), index=idx)[lambda s: (s.index // 3600) % 5 != 0]


def test_fast_encode_equals_the_features_package_on_random_states():
    rng = np.random.default_rng(0)
    n = 3000
    st = {k: rng.normal(0, 2, n) for k in px.ENGINE_KEYS}
    for k in ("leader_sold", "half_sold", "quote_failed", "sell_quote_ratio_missing"):
        st[k] = (rng.random(n) < 0.3).astype(float)
    for k in px.ENGINE_KEYS:
        st[k] = np.where(rng.random(n) < 0.1, np.nan, st[k])
    h = hourly()
    st["t"] = rng.integers(int(h.index.min()) - 7200, int(h.index.max()) + 7200, n) * 1000 - T0_MS
    st["row"] = rng.integers(0, 50, n)
    fz = px.ExitFeaturizer(np.where(rng.random(50) < 0.3, np.nan, rng.normal(0, 1, 50)), h)
    a, b = fz.encode(st), fz.encode_reference(st)
    assert a.shape == (n, len(px.exit_columns()))
    assert np.array_equal(np.isnan(a), np.isnan(b)) and np.nanmax(np.abs(a - b)) == 0
    t_ms = st["t"] + T0_MS
    np.testing.assert_array_equal(np.isnan(fz.active_wallets(t_ms)), np.isnan(fx.active_wallets_1h(t_ms, h)))
    np.testing.assert_allclose(fz.active_wallets(t_ms), fx.active_wallets_1h(t_ms, h))


def test_collect_rewards_telescope_to_g_of_the_net_pnl(buf):
    b, w, rows = buf
    assert len(b) > len(rows) and set(np.unique(b.a)) <= {0, 1, 2}
    assert np.isfinite(b.r).all()
    env = BatchEnv(w, params=SimParams(), seed=0, features=True)  # same seed: the same positions, closes and P&L
    df = pd.DataFrame({"pos": b.pos, "r": b.r, "G": b.G, "done": b.done})
    # each position's chain: one done transition, at the end; the first transition's remaining value = sum of its rewards
    for p, grp in df.groupby("pos"):
        assert grp["done"].sum() == 1 and grp["done"].iloc[-1]
        assert grp["G"].iloc[0] == pytest.approx(grp["r"].sum())
    # nxt points at the same position's next transition
    nx = b.nxt[~b.done]
    assert (nx > np.flatnonzero(~b.done)).all() and (b.pos[nx] == b.pos[~b.done]).all()
    # potential shaping: a position's rewards sum to g(realized net P&L)
    env.reset(rows)
    beh = px.BehaviourMix(len(rows), 0)  # collect's behaviour, same seed: the same actions in the same order
    while env.dec is not None:
        env.step(beh(env.dec.state, env.dec.idx))
    res = env.results()
    first = df.groupby("pos")["G"].first()
    np.testing.assert_allclose(first.to_numpy(), g(res["pnl"].to_numpy()[first.index], 1.5), atol=1e-9)


def test_pick_exit_masks_sell_half_once_taken_and_ties_go_to_the_earlier_action():
    q = np.array([[0.0, 0.2, 0.1], [0.1, 0.1, 0.1], [0.0, 0.5, 0.2], [np.nan, -1.0, -2.0]])
    np.testing.assert_array_equal(px.pick_exit(q, [False, False, True, False]), [1, 0, 2, 1])


def test_fit_exit_and_the_policy_give_runtime_fractions(buf):
    b, w, rows = buf
    norm = px.fit_exit_norm(b.X)
    net, info = px.fit_exit(b, norm, steps=200, seed=0, dev="cpu", log_every=0, batch=256)
    assert net.n_out == 3 and info["transitions"] == len(b)
    r = evaluate(w, lambda s: np.full(len(s), 0.1), px.ExitPolicy(net, norm, px.ExitFeaturizer()), SimParams(), rows=rows, B=20)
    assert r.out["entered"].sum() > 0
    st = {k: b.S[k][:50] for k in px.RULE_KEYS}
    st.update({k: np.zeros(50) for k in px.ENGINE_KEYS if k not in st})
    f = px.ExitPolicy(net, norm, px.ExitFeaturizer())(st)
    assert set(np.unique(f)) <= {0.0, 0.5, 1.0}


def test_paper_transitions_become_iql_transitions_that_telescope_to_g_of_the_grounded_pnl():
    import json
    from brain.features import spec
    cols = px.exit_columns()
    rng = np.random.default_rng(0)
    old = spec.Norm(cols, rng.normal(0, 1, len(cols)), rng.uniform(0.5, 2, len(cols)))
    enc = rng.normal(0, 1, (5, len(cols)))
    z = (enc - old.mean) / old.std  # what the runtime logged (normalised with the logging bundle's norm)
    info = lambda r: json.dumps({"ret_now": r, "source": "tick"})  # noqa: E731
    rows = pd.DataFrame({
        "id": [1, 2, 3, 4, 5, 6, 7],
        "position_id": [10, 10, 10, 11, 11, 12, 10],
        "model_version": ["v1", "v1", "v1", "v1", "v1", "v0", "v1"],
        "features": [json.dumps(z[0].tolist()), json.dumps(z[1].tolist()), json.dumps(z[2].tolist()), json.dumps(z[3].tolist()), "[]",
                     json.dumps(z[4].tolist()), "[]"],
        "action": [0, 1, 0, 0, 2, 2, 2],
        "info": [info(0.10), info(0.40), info(-0.2), info(0.0), json.dumps({"forced": "hard-stop"}), info(0.5), json.dumps({"forced": "max-hold"})],
    })
    closed = pd.DataFrame({"position_id": [10, 11, 12], "stake": [0.1, 0.05, 0.1], "reward": [0.012, -0.031, 0.02]})
    b = px.transitions_buffer(rows, closed, lambda v: old if v == "v1" else None, kappa=1.5)
    # forced rows are not decisions; v0 has no manifest here, so position 12 is dropped
    assert len(b) == 4 and b.meta["positions"] == 2
    np.testing.assert_allclose(b.X, enc[:4], atol=1e-5)  # back to encoded columns (fit_exit normalises them itself)
    np.testing.assert_array_equal(b.a, [0, 1, 0, 0])
    np.testing.assert_array_equal(b.done, [False, False, True, True])
    np.testing.assert_array_equal(b.nxt, [1, 2, -1, -1])
    # every position's rewards sum to g(U), U the grounded P&L from `closed`
    np.testing.assert_allclose(pd.Series(b.r).groupby(b.pos).sum().to_numpy(), g(np.array([0.012, -0.031]), 1.5))
    np.testing.assert_allclose(b.G[[0, 3]], g(np.array([0.012, -0.031]), 1.5))
    # u at the 2nd decision of position 10: the whole position at +40 %, 1 % fee, two transactions
    u1 = 0.1 * 1.4 * 0.99 - 0.1 - 2 * 0.0003
    assert b.r[0] == pytest.approx(float(g(u1, 1.5)))
    # after the half sold at +40 %: half held at -20 %, half realized at +40 %, three transactions
    u2 = 0.1 * (0.5 * 0.8 * 0.99 + 0.5 * 1.4 * 0.99) - 0.1 - 3 * 0.0003
    assert b.r[1] == pytest.approx(float(g(u2, 1.5) - g(u1, 1.5)))
    assert len(px.transitions_buffer(rows.iloc[:0], closed, lambda v: old, 1.5)) == 0


def test_rule_net_is_exactly_the_time_rule_in_the_simulator(buf):
    b, w, rows = buf
    norm = px.fit_exit_norm(b.X)
    net = px.rule_net(T1, norm)
    full = lambda s: np.full(len(s), 0.1)  # noqa: E731
    want = evaluate(w, full, T1, SimParams(), rows=rows, B=20).out
    got = evaluate(w, full, px.ExitPolicy(net, norm, px.ExitFeaturizer()), SimParams(), rows=rows, B=20).out
    np.testing.assert_array_equal(got["close_t"], want["close_t"])
    np.testing.assert_allclose(got["pnl"], want["pnl"])
    assert px.is_time_rule(T1) and not px.is_time_rule(RuleExit("follow|t1", time_min=1))


def test_distill_learns_a_rule_on_the_buffered_states(buf):
    b, w, rows = buf
    norm = px.fit_exit_norm(b.X)
    net, info = px.distill(T1, b, norm, epochs=30, seed=0, dev="cpu")
    assert info["agreement"] > 0.95 and info["rule"] == "t1"


def test_one_simulation_scores_any_stake_vector_as_evaluate_would(world):
    """policy.score: choose(simulate(...), frac) == evaluate() of the same decisions (the calibration grids rely on it)."""
    w = world.window()
    sig = w.data.sig
    gated = sig["gate"].to_numpy() != ""
    ei = type("EI", (), {"gated": gated, "ps_r": np.full(len(sig), np.nan)})()
    full = simulate(w, ei, T1, SimParams(), Chaos(), 0)
    frac = np.where(gated, 0.0, (np.arange(len(sig)) % 3 == 0).astype(float))
    got = choose(full, w, frac, SimParams(), B=50)["metrics"]
    want = evaluate(w, stake_callback(frac, 0.1), T1, SimParams(), Chaos(), 0, B=50, features=True).metrics
    for k in ("n", "mean_sol", "sum_sol"):
        assert got["per_copy"][k] == pytest.approx(want["per_copy"][k], rel=1e-9, abs=1e-12)
    assert got["per_decision"]["mean_sol"] == pytest.approx(want["per_decision"]["mean_sol"], rel=1e-9, abs=1e-12)
    assert got["account"]["net_sol"] == pytest.approx(want["account"]["net_sol"], rel=1e-9, abs=1e-12)
    assert got["account"]["trades"] == want["account"]["trades"]


def test_fill_outliers_are_flagged_and_cleaned_to_skips():
    from brain.policy.score import clean, fill_outliers
    o = pd.DataFrame({"pnl": [0.5, -0.01, 0.02, 0.9], "stake": [0.1] * 4, "reason": ["exit"] * 4, "entered": [True] * 4,
                      "entry_vs_print": [0.27, 1.01, 0.99, 1.0], "sale_vs_print": [1.0, 0.97, 1.3, 3.4]})
    np.testing.assert_array_equal(fill_outliers(o), [True, False, False, True])
    c = clean(o)
    assert c["pnl"].tolist() == [0.0, -0.01, 0.02, 0.0] and c["reason"].tolist() == ["skip", "exit", "exit", "skip"]


def test_simulate_reports_fills_against_the_tape(world):
    w = world.window()
    sig = w.data.sig
    ei = type("EI", (), {"gated": sig["gate"].to_numpy() != "", "ps_r": np.full(len(sig), np.nan)})()
    full = simulate(w, ei, T1, SimParams(), Chaos(), 0)
    e = full.loc[full["entered"] & (full["reason"] != "dead-entry"), ["entry_vs_print", "sale_vs_print"]]
    assert e["entry_vs_print"].notna().all() and e["entry_vs_print"].between(0.5, 2).mean() > 0.95
