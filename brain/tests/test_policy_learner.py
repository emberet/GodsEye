"""
brain.policy.learner (the trainer as a brain.assure learner) and the training helpers of brain.train: stakes are skip or
full only, gated signals are never copied, a world without an edge copies nothing, ONNX decides like PyTorch, the weights
round-trip for hourly warm starts, and the entry target weighs the chaos run as documented.
"""
from __future__ import annotations

import numpy as np
import pytest

import brain.train as train
from brain.assure.features import build as world_features
from brain.assure.features import mirror
from brain.assure.protocol import TrainData, learners
from brain.assure.worlds import World, WorldSpec
from brain.features import spec
from brain.policy import entry as pe
from brain.policy import exit as px
from brain.policy.brain import Brain
from brain.policy.learner import BrainLearner, TableEncoder
from brain.policy.nets import QNet, predict
from brain.sim.env import g
from brain.sim.params import SimParams


def world_data(seed: int, null: bool = False, days: int = 8):
    w = World(WorldSpec(seed=seed, days=days, signals_per_day=300, null=null))
    f = world_features(w, mirror(w, SimParams()))
    tr, te = w.days[:-2], w.days[-2:]
    win_tr, win_te = w.window(tr), w.window(te)
    fi = f.set_index("episode_id")
    ft = fi.loc[win_tr.data.sig["episode_id"]].reset_index()
    fe = fi.loc[win_te.data.sig["episode_id"]].reset_index()
    return TrainData(win_tr, ft, SimParams(), 1.5), win_te, fe


@pytest.fixture(scope="module")
def edge():
    data, win, f = world_data(2)
    return data, win, f, BrainLearner(iql_steps=300).fit(data, seed=0)


def test_the_trainer_is_found_by_the_learning_checks():
    ls, missing = learners()
    assert any(isinstance(x, BrainLearner) for x in ls) and not missing


def test_stakes_are_skip_or_full_and_never_on_a_gated_signal(edge):
    data, win, f, pol = edge
    st = np.asarray(pol.stake(f, win.data.sig))
    assert set(np.unique(st)) <= {0.0, 1.0}
    gated = win.data.sig["gate"].to_numpy() != ""
    assert gated.any() and (st[gated] == 0).all()
    assert pol.meta.get("exit_kind") in ("iql", "leader_sold", "leader_sold|t5")


def test_the_leak_canary_is_not_an_input(edge):
    data, win, f, pol = edge
    assert "leak_canary" not in pol.enc.inputs and "episode_id" not in pol.enc.inputs
    f2 = f.assign(leak_canary=np.random.default_rng(0).normal(0, 9, len(f)))
    np.testing.assert_array_equal(pol.stake(f, win.data.sig), pol.stake(f2, win.data.sig))


def test_onnx_decides_like_pytorch(edge):
    data, win, f, pol = edge
    assert BrainLearner().onnx_roundtrip(pol, f, win.data.sig) == 1.0


def test_a_world_without_an_edge_copies_nothing():
    data, win, f = world_data(101, null=True)
    pol = BrainLearner(iql_steps=200).fit(data, seed=0)
    assert (np.asarray(pol.stake(f, win.data.sig)) == 0).mean() >= 0.99


def test_table_encoder_flags_missing_and_standardises():
    import pandas as pd
    f = pd.DataFrame({"episode_id": [1, 2, 3, 4], "a": [1.0, 2.0, 3.0, np.nan], "b": [5.0, 5.0, 5.0, 5.0], "leak_canary": [9.0] * 4})
    enc = TableEncoder().fit(f)
    Z = enc(f)
    assert enc.columns() == ["a", "b", "a_missing"]
    np.testing.assert_allclose(Z[:, 2], [0, 0, 0, 1])
    assert Z[3, 0] == 0 and Z[:, 1].tolist() == [0, 0, 0, 0]  # missing -> the mean; a constant column stays 0


def test_entry_targets_weigh_the_chaos_run():
    ed = {"pnl": np.array([[0.01, -0.02], [0.02, np.nan], [np.nan, -0.01]])}
    Y = train.entry_targets(ed, 1.5, (0.0, 1.0), SimParams(), chaos_weight=0.25)
    np.testing.assert_allclose(Y[:, 0], [0.75 * 0.01 + 0.25 * g(-0.02, 1.5), 0.02, g(-0.01, 1.5)])


def test_brain_weights_round_trip(tmp_path):
    cols = px.exit_columns()
    meta = {"columns": ["a", "b"], "categories": {}, "norm": {"columns": ["a", "b"], "mean": [0, 0], "std": [1, 1]}}
    members = [QNet(2, 1, mask=[1, 0], scale=0.1, skip_zero=True) for _ in range(2)]
    xnorm = px.fit_exit_norm(np.random.default_rng(0).normal(0, 1, (50, len(cols))).astype(np.float32))
    b = Brain(members, QNet(len(cols), 3, scale=0.1), meta, xnorm, (0.0, 1.0), 1.5, {"rate": 0.1, "curiosity": 0.5}, {"trained_days": ["d"]})
    b.save(tmp_path / "s")
    c = Brain.load(tmp_path / "s")
    x = np.random.default_rng(1).normal(0, 1, (7, 2)).astype(np.float32)
    np.testing.assert_allclose(predict(c.members[1], x), predict(members[1], x))
    assert c.margin_c == 1.5 and c.actions == (0.0, 1.0) and c.meta["trained_days"] == ["d"]
    assert train.latest_state(tmp_path) is None
    b.save(tmp_path / "_state" / "2026-11-07T00-00-00Z")
    assert train.latest_state(tmp_path).name == "2026-11-07T00-00-00Z"
