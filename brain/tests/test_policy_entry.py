"""
brain.policy.entry: stake targets from the simulator's outcomes, the input chaos, the training loop and the decision rules
the runtime mirrors (agent/src/brain/policy.ts pickStake / decideEntry / decideExplore).
"""
from __future__ import annotations

import numpy as np
import pandas as pd
import pytest
import torch

from brain.features import spec
from brain.policy import entry as pe
from brain.policy.nets import QNet, predict
from brain.sim.env import g
from brain.sim.params import SimParams

P = SimParams()


def outcomes(pnl, n_tx=2, rent_lost=False, stake=0.1):
    n = len(pnl)
    return pd.DataFrame({"pnl": np.asarray(pnl, dtype=float), "stake": np.full(n, stake), "n_tx": np.full(n, n_tx),
                         "rent_lost": np.full(n, rent_lost)})


def test_stake_targets_full_stake_is_g_of_pnl_and_fractions_keep_fixed_costs():
    out = outcomes([0.05, -0.04, -0.1006])
    Y = pe.stake_targets(out, (0, 0.5, 1.0), kappa=1.5, p=P)
    assert Y.shape == (3, 2)
    np.testing.assert_allclose(Y[:, 1], g(out["pnl"], 1.5))
    fixed = 2 * P.tx_cost_sol
    np.testing.assert_allclose(Y[:, 0], g((out["pnl"] + fixed) * 0.5 - fixed, 1.5))
    # a write-off keeps the lost rent as a fixed cost at every stake
    w = pe.stake_targets(outcomes([-0.1026], rent_lost=True), (0, 0.5), kappa=1.0, p=P)
    assert w[0, 0] == pytest.approx((-0.1026 + 2 * P.tx_cost_sol + P.rent_sol) * 0.5 - 2 * P.tx_cost_sol - P.rent_sol)


def test_day_weights_give_every_day_the_same_total():
    day = np.array(["a"] * 90 + ["b"] * 10)
    w = pe.day_weights(day)
    assert w[day == "a"].sum() == pytest.approx(w[day == "b"].sum())
    assert w.mean() == pytest.approx(1.0)


def test_pick_stake_mirrors_policy_ts():
    acts = (0.0, 0.25, 0.5, 1.0)
    s = np.array([[0.0, 0.01, 0.02, 0.02],      # tie: the smaller stake (a larger one needs a strictly higher score)
                  [0.0, -0.01, -0.02, 0.0],     # nothing above 0: skip
                  [0.0, np.nan, 0.001, -1.0],   # a NaN score is never chosen
                  [5.0, -1.0, -1.0, -1.0]])     # the skip action's own score never matters
    np.testing.assert_array_equal(pe.pick_stake(s, acts), [0.5, 0.0, 0.5, 0.0])


def test_ensemble_decide_uses_mean_minus_c_std_and_explore_one_member_plus_curiosity():
    q = np.array([[[0, 0.03]], [[0, 0.01]], [[0, -0.01]]], dtype=np.float32)  # members x 1 signal x actions
    ens = pe.Ensemble([None, None, None], (0.0, 1.0))
    mu, sd = ens.stats(q)
    assert mu[0, 1] == pytest.approx(0.01) and sd[0, 1] == pytest.approx(np.std([0.03, 0.01, -0.01]))
    assert ens.decide(q, 0.0)[0] == 1.0
    assert ens.decide(q, 1.0)[0] == 0.0            # 0.01 - 0.0163 < 0
    picks = [ens.explore(q, 0.0, np.random.default_rng(s))[0] for s in range(200)]
    assert 0.5 < np.mean(picks) < 0.8               # 2 of 3 members say copy
    assert all(ens.explore(q, 10.0, np.random.default_rng(s))[0] == 1.0 for s in range(20))  # curiosity lifts all
    assert pe.Ensemble([], (0.0, 1.0)).decide(np.zeros((1, 4, 2)), 0.0).tolist() == [0, 0, 0, 0]


@pytest.fixture
def meta():
    """A feature-build meta with a real norm for features.yaml's entry columns (no drive needed)."""
    feats = spec.entry_features()
    cats = {"venue_group": ["pumpswap", "pumpfun_curve", "other"]}
    cols = spec.columns(feats, cats)
    rng = np.random.default_rng(0)
    raw = pd.DataFrame({f.name: (rng.choice(["pumpswap", "pumpfun_curve", None], 400) if f.onehot else
                                 np.where(rng.random(400) < 0.2, np.nan, rng.normal(1, 2, 400))) for f in feats})
    X = spec.encode(raw, feats, cats)
    norm = spec.fit_norm(X, cols, spec.binary_columns(feats, cats))
    return {"columns": cols, "categories": cats, "norm": norm.to_json(), "raw": raw}


def test_augment_drops_a_feature_exactly_as_a_live_missing_value(meta):
    aug = pe.Augment.for_entry(meta)
    feats = spec.entry_features()
    norm = spec.Norm.from_json(meta["norm"])
    raw = meta["raw"].iloc[:50].copy()
    Z = spec.normalise(spec.encode(raw, feats, meta["categories"]), norm).astype(np.float32)
    for name in ("cp_win_7d", "venue_group", "log_token_age", "cp_n_7d"):
        Zd = Z.copy()
        aug.drop(Zd, np.ones(50, bool), name)
        r2 = raw.copy()
        r2[name] = None if name == "venue_group" else np.nan
        want = spec.normalise(spec.encode(r2, feats, meta["categories"]), norm).astype(np.float32)
        np.testing.assert_allclose(Zd, want, atol=1e-6)
    cold = aug.scenario(Z, cold_ledger=True)
    for f in pe.CP_FEATURES:
        np.testing.assert_allclose(cold[:, aug.groups[f]], np.broadcast_to(aug.missing[aug.groups[f]], (50, len(aug.groups[f]))))
    np.testing.assert_array_equal(aug.scenario(Z, seed=3, dropout=0.3), aug.scenario(Z, seed=3, dropout=0.3))
    noisy = aug(Z, np.random.default_rng(0))
    assert noisy.shape == Z.shape and not np.array_equal(noisy, Z)
    binary = spec.binary_columns(feats, meta["categories"])
    flags = [i for i, c in enumerate(meta["columns"]) if c in binary]
    assert set(np.unique(noisy[:, flags])) <= {0.0, 1.0}  # noise never touches a flag or a one-hot level


def test_input_mask_hides_the_social_columns(meta):
    mask = pe.input_mask(meta["columns"])
    net = QNet(len(mask), 1, mask=mask, scale=0.1, skip_zero=True)
    x = np.random.default_rng(1).normal(0, 1, (8, len(mask))).astype(np.float32)
    y = x.copy()
    for c in pe.MASKED:
        y[:, meta["columns"].index(c)] += 100.0
    np.testing.assert_allclose(predict(net, x), predict(net, y))
    assert (predict(net, x)[:, 0] == 0).all()  # skip is 0


def test_fit_member_learns_a_planted_signal_and_early_stopping_keeps_the_best_epoch():
    rng = np.random.default_rng(0)
    Z = rng.normal(0, 1, (3000, 6)).astype(np.float32)
    y = np.where(Z[:, 0] > 0.5, 0.02, -0.01)[:, None] + rng.normal(0, 0.005, (3000, 1))
    tr, va = slice(0, 2400), slice(2400, None)
    net, hist = pe.fit_member(Z[tr], y[tr], np.ones(2400), epochs=12, seed=0, valid=(Z[va], y[va], np.ones(600)), dev="cpu", batch=256)
    q = predict(net, Z[va])[:, 1]
    assert np.corrcoef(q, y[va, 0])[0, 1] > 0.8
    with torch.no_grad():
        best = float(pe._loss(net.raw(torch.from_numpy(Z[va])), torch.as_tensor(y[va] / 0.1, dtype=torch.float32), torch.ones(600)))
    assert best == pytest.approx(min(hist), rel=1e-4)


def test_early_stop_and_ensemble_on_day_folds():
    rng = np.random.default_rng(1)
    n = 2400
    day = np.repeat(["d1", "d2", "d3", "d4"], n // 4)
    Z = rng.normal(0, 1, (n, 4)).astype(np.float32)
    y = (0.01 * Z[:, :1] + rng.normal(0, 0.01, (n, 1)))
    ep, rec = pe.early_stop(Z, y, np.ones(n), day, [(["d1", "d2"], ["d3"]), (["d1", "d2", "d3"], ["d4"])], seed=0, dev="cpu", max_epochs=6)
    assert 2 <= ep <= 6 and all("best_epoch" in r and r["spearman"] > 0.3 for r in rec)
    mem = pe.fit_ensemble(Z, y, np.ones(n), day, epochs=ep, members=3, seed=0, dev="cpu", batch=256)
    q = pe.Ensemble(mem, (0.0, 1.0)).q(Z)
    assert q.shape == (3, n, 2) and q.std(0)[:, 1].mean() > 0  # bootstrap members disagree a little


def test_qualify_skips_noise_and_takes_the_most_cautious_margin_near_the_best():
    rng = np.random.default_rng(0)
    mu = rng.normal(0, 0.01, 4000)
    sd = np.full(4000, 0.002)
    assert not pe.qualify(mu, sd, rng.normal(-0.002, 0.05, 4000))["qualified"]
    y = np.where(mu > 0.004, 0.03, -0.02) + rng.normal(0, 0.005, 4000)
    r = pe.qualify(mu, sd, y)
    assert r["qualified"] and r["margin_c"] >= 1.0 and r["t"] >= 2
