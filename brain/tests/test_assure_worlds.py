"""brain.assure worlds, point-in-time features and reward grounding: the planted truth is what the simulator sees."""
from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from brain.assure import features as F
from brain.assure.transitions import from_brain_transitions, ground_rewards
from brain.assure.worlds import World, WorldSpec
from brain.baselines import follow_leader
from brain.sim.evaluate import evaluate
from brain.sim.params import SimParams

P = SimParams()


@pytest.fixture(scope="module")
def world():
    return World(WorldSpec(seed=0, backfill_days=(4,)))


@pytest.fixture(scope="module")
def mirror(world):
    return F.mirror(world, P)


def test_worlds_are_deterministic():
    a, b = World(WorldSpec(seed=3, days=2)), World(WorldSpec(seed=3, days=2))
    pd.testing.assert_frame_equal(a.swaps, b.swaps)
    pd.testing.assert_frame_equal(a.sig, b.sig)
    assert not World(WorldSpec(seed=4, days=2)).swaps["price_sol"].equals(a.swaps["price_sol"])


def test_planted_truth_shows_in_the_simulator(world):
    win = world.window()
    r = evaluate(win, lambda s: np.full(len(s), P.max_trade_sol), follow_leader, P, B=10)
    o = r.out.merge(world.truth[["episode_id", "cohort", "kind", "oracle"]], on="episode_id")
    o = o[o["entered"]]
    m = o.groupby("oracle")["pnl"].mean()
    assert m[True] > 0.003 > -0.003 > m[False]                         # the edge pays after costs, the rest loses
    assert o[o["kind"] == "silent_rug"]["pnl"].mean() < -0.05          # silent rugs are mostly written off
    assert r.metrics["account"]["final_equity"] < 0.2                  # copy-all busts the 1 SOL account (report: B1)
    ro = evaluate(win, world.oracle(win, P), follow_leader, P, B=10)
    assert ro.metrics["account"]["net_sol"] > 0.5


def test_gates_fire_on_the_planted_traps(world):
    t = world.truth
    g = world.sig["gate"].to_numpy()
    assert (g[(t["kind"] == "hiprice_rug").to_numpy()] == "pumpswap_hiprice").mean() > 0.95
    young = t["kind"].isin(["young_rug", "young_ok"]).to_numpy()
    assert (g[young] == "young_amm").mean() > 0.95
    assert (g[(t["kind"] == "normal").to_numpy()] == "").mean() > 0.98


def test_backfilled_days_are_stored_late(world):
    lag = (world.sig["ins_ms"] - world.sig["t_ms"]) / 1000
    bf = world.truth["backfilled"].to_numpy()
    assert lag[bf].median() > 3600 and lag[~bf].max() < 5


def test_features_are_point_in_time_and_the_leaky_mutant_is_not(world, mirror):
    f = F.build(world, mirror)
    assert f["leak_canary"].isna().all()                                # its value is stored after every decision
    cut = int(world.sig["t_dec"].quantile(0.6))
    sig, mt, tape = F.truncate(world, mirror, cut)
    ids = sig.loc[sig["t_dec"] < cut, "episode_id"]
    a = f.set_index("episode_id").loc[ids]
    b = F.build(world, mt, sig=sig, tape=tape).set_index("episode_id").loc[ids]
    pd.testing.assert_frame_equal(a, b)
    fl = F.build(world, mirror, leaky=True)
    assert fl["leak_canary"].notna().all()
    bl = F.build(world, mt, leaky=True, sig=sig, tape=tape).set_index("episode_id").loc[ids]
    assert not np.allclose(fl.set_index("episode_id").loc[ids, "cp_n_7d"], bl["cp_n_7d"])


def test_ground_rewards_writes_off_stale_closes_of_dead_coins(world):
    t = world.truth.set_index("episode_id")
    sig = world.sig.set_index("episode_id")
    rug = t.index[(t["kind"] == "silent_rug").to_numpy() & t["rug_t"].notna().to_numpy()][:5]
    ok = t.index[(t["kind"] == "normal").to_numpy()][:5]
    rows = pd.DataFrame({"mint": sig.loc[list(rug) + list(ok), "mint"].to_numpy(), "stake": 0.1, "reward": 0.03,
                         "close_ms": np.r_[(t.loc[rug, "rug_t"].to_numpy() * 1000).astype(np.int64) - F.world_t0() + 900_000,
                                           sig.loc[ok, "t_ms"].to_numpy() + 600_000],
                         "mark_age_s": np.r_[np.full(5, 900.0), np.full(5, 900.0)]})
    g = ground_rewards(rows, world.tape, P)
    assert g["grounded"].iloc[:5].all() and (g["reward"].iloc[:5] < -0.1).all()     # dead after a stale mark: written off
    assert not g["grounded"].iloc[5:].any() and (g["reward"].iloc[5:] == 0.03).all()  # alive: kept
    fresh = ground_rewards(rows.assign(mark_age_s=5.0), world.tape, P)
    assert not fresh["grounded"].any()                                                 # sold on a fresh price: kept


def test_from_brain_transitions_joins_entry_features_and_the_close():
    rows = pd.DataFrame([
        {"id": 1, "ts": "2026-11-07T00:00:00Z", "kind": "entry", "position_id": 7, "mint": "M", "features": "[1.0, 2.0]", "action": 1.0,
         "reward": -0.1, "done": 1, "info": '{"base_size_sol": 0.1}'},
        {"id": 2, "ts": "2026-11-07T00:10:00Z", "kind": "exit", "position_id": 7, "mint": "M", "features": "[]", "action": 2,
         "reward": -0.1, "done": 1, "info": '{"mark_age_s": 400}'},
        {"id": 3, "ts": "2026-11-07T00:00:00Z", "kind": "entry", "position_id": 8, "mint": "N", "features": "[1.0, 2.0]", "action": 1.0,
         "reward": 0.0, "done": 1, "info": '{"blocked": "budget"}'},
    ])
    out = from_brain_transitions(rows, ["a", "b"])
    assert len(out) == 1 and out["a"].iat[0] == 1.0 and out["mark_age_s"].iat[0] == 400 and out["stake"].iat[0] == pytest.approx(0.1)
