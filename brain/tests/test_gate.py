"""
brain.gate: the decision (skip-everything never promotes, a safety failure rejects), the paired statistics it uses, the
robustness slices, a bundle that fails sanity, and the --social sanity path.
"""
from __future__ import annotations

import json
from types import SimpleNamespace

import numpy as np
import pandas as pd
import pytest
import torch

import brain.gate as gate
from brain.export_onnx import export, sha256


def out(pnl, mint, stake=0.1, reason="exit", t=None):
    n = len(pnl)
    t = np.arange(n) * 1000 if t is None else t
    return pd.DataFrame({"episode_id": np.arange(n), "mint": mint, "pnl": np.asarray(pnl, float), "stake": np.full(n, stake),
                         "reason": [reason] * n, "t_dec": t, "t_ms": t, "close_t": t + 10, "row": np.arange(n)})


def c(name, ok):
    return gate.check(name, ok, None, "")


def test_decide_never_promotes_skip_everything_and_rejects_on_safety():
    sanity, safe = [c("bundle_files", True)], [c("combined_worst", True)]
    assert gate.decide(sanity, safe, [c("b4_per_copy", True), c("copies_per_day", True)]) == gate.PROMOTE
    # skip-everything: beats B4 per decision (B4 loses) but opens no copies -> at most explore-only
    assert gate.decide(sanity, safe, [c("b4_per_decision", True), c("copies_per_day", False)]) == gate.EXPLORE_ONLY
    assert gate.decide(sanity, [c("crash_rugwave_replay", False)], [c("b4_per_copy", True)]) == gate.REJECT
    assert gate.decide([c("bundle_files", False)], safe, [c("b4_per_copy", True)]) == gate.REJECT
    assert gate.decide(sanity, [], [c("b4_per_copy", True)]) == gate.REJECT  # no stress suite run: no promotion


def test_per_copy_diff_is_paired_by_mint():
    rng = np.random.default_rng(0)
    mint = rng.integers(0, 60, 600).astype(str)
    base = rng.normal(-0.002, 0.01, 600)
    a, b = out(base + 0.004, mint), out(base, mint)
    d = gate.per_copy_diff(a, b, B=300)
    assert d["mean_diff"] == pytest.approx(0.004) and d["ci95_mint"][0] > 0
    same = gate.per_copy_diff(b, b, B=100)
    assert same["mean_diff"] == pytest.approx(0.0) and same["ci95_mint"][0] == pytest.approx(0.0, abs=1e-12)
    none = gate.per_copy_diff(out(base, mint, stake=0.0, reason="skip"), b)
    assert none["mean_diff"] is None


def test_by_storage_splits_live_from_backfilled_signals():
    rng = np.random.default_rng(1)
    mint = rng.integers(0, 80, 800).astype(str)
    base = rng.normal(-0.002, 0.01, 800)
    lag = np.where(np.arange(800) < 300, 5.0, 3600.0)  # 300 stored in time, 500 backfilled
    edge = np.where(lag > gate.LIVE_LAG_S, 0.01, -0.003)  # the "edge" lives only on backfilled signals
    a, b = out(base + edge, mint).assign(ins_lag_s=lag), out(base, mint).assign(ins_lag_s=lag)
    r = gate.by_storage(a, b, B=200)
    assert r["stored_in_time"]["signals"] == 300 and r["stored_late"]["signals"] == 500
    assert r["stored_in_time"]["mean_diff"] == pytest.approx(-0.003) and r["stored_late"]["mean_diff"] == pytest.approx(0.01)
    # a candidate that copies nothing stored in time has no live slice at all (mean_diff None: the check fails)
    none = gate.by_storage(a.assign(stake=np.where(lag > gate.LIVE_LAG_S, 0.1, 0.0)), b, B=50)
    assert none["stored_in_time"]["mean_diff"] is None


def test_robustness_drops_the_top_mints_and_each_venue():
    pnl = np.r_[np.full(99, -0.001), 5.0]
    o = out(pnl, np.arange(100).astype(str))
    r = gate.robustness(o, np.array(["pumpswap"] * 50 + ["other"] * 50))
    assert r["without_top1pct_mints"] == pytest.approx(-0.001) and r["min"] < 0
    assert r["without_other"] == pytest.approx(-0.001) and r["without_pumpswap"] > 0
    # a selective policy: 1,000 signals on 1,000 mints, 100 copied; the top 1 % is of its 100 mints (one), not of the 1,000
    pnl = np.r_[np.full(99, 0.002), 0.05, np.zeros(900)]
    sel = out(pnl, np.arange(1000).astype(str), stake=np.r_[np.full(100, 0.1), np.zeros(900)],
              reason=None).assign(reason=["exit"] * 100 + ["skip"] * 900)
    r = gate.robustness(sel, np.array(["pumpswap"] * 1000))
    assert r["n_copied_mints"] == 100 and r["n_top_mints"] == 1
    assert r["without_top1pct_mints"] == pytest.approx(99 * 0.002 / 999)
    assert r["without_top1pct_window_mints"] == pytest.approx(90 * 0.002 / 990)
    # both readings of "the top 1 % of mints" are checked: an edge that only the policy-mint reading keeps fails
    pnl = np.r_[np.full(10, 0.004), np.full(90, -0.0003), np.zeros(900)]
    sel = sel.assign(pnl=pnl)
    r = gate.robustness(sel, np.array(["pumpswap"] * 1000))
    assert r["without_top1pct_mints"] > 0 > r["without_top1pct_window_mints"] and r["n_top_window_mints"] == 10
    assert r["min"] == r["without_top1pct_window_mints"]


def test_safety_checks_follow_stress_yaml():
    ok = {"combined_worst": {"per_decision": 0.0, "worst_day": -0.2, "gated_copies": 0},
          "crash_rugwave_replay": {"per_decision": 0.0, "per_decision_ci95": [-0.001, 0.001], "min_equity": 0.9, "gated_copies": 0}}
    assert all(x["passed"] for x in gate.safety_checks(ok))
    bad = json.loads(json.dumps(ok))
    bad["crash_rugwave_replay"]["min_equity"] = 0.6
    bad["combined_worst"]["gated_copies"] = 2
    got = {x["name"]: x["passed"] for x in gate.safety_checks(bad)}
    assert not got["crash_rugwave_replay"] and not got["stress_gated_copies"] and got["combined_worst"]


def test_a_broken_bundle_is_rejected_before_any_scoring(tmp_path, monkeypatch):
    d = tmp_path / "v1"
    d.mkdir()
    (d / "manifest.json").write_text(json.dumps({"version": "v1", "entry": {"members": ["entry-0.onnx"], "features": [], "norm": {"mean": [], "std": []},
                                                                            "actions": [0, 1]},
                                                 "exit": {"file": "exit.onnx", "features": [], "norm": {"mean": [], "std": []}}, "sha256": {}}))
    monkeypatch.setattr(gate.build, "load_meta", lambda: {"columns": [], "categories": {}, "norm": {"columns": [], "mean": [], "std": []}})
    code, rep = gate.gate(d, SimpleNamespace())
    assert code == gate.REJECT and rep["decision"]["why"] == "sanity"
    path = gate.write_report(d, rep)
    assert path == tmp_path / "v1.gate-report.json" and json.loads(path.read_text())["decision"]["exit"] == gate.REJECT


class Social(torch.nn.Module):
    def __init__(self, n):
        super().__init__()
        self.lin = torch.nn.Linear(n, 1)
        self.n_in = n

    def forward(self, x):
        return self.lin(x)


def test_social_bundle_sanity(tmp_path):
    d = tmp_path / "s1"
    d.mkdir()
    export(Social(4), d / "social.onnx")
    # the social trainer names its output y
    import onnx
    m = onnx.load(d / "social.onnx")
    m.graph.output[0].name = "y"
    m.graph.node[-1].output[0] = "y"
    onnx.save(m, d / "social.onnx")
    man = {"version": "s1", "kind": "social", "features": ["a", "b", "c", "d"], "norm": {"mean": [0] * 4, "std": [1] * 4},
           "file": "social.onnx", "input": "x", "output": "y", "sha256": {"social.onnx": sha256(d / "social.onnx")}}
    (d / "manifest.json").write_text(json.dumps(man))
    code, rep = gate.social(d)
    assert code == gate.PROMOTE, rep
    (d / "social.onnx").write_bytes((d / "social.onnx").read_bytes() + b"0")
    assert gate.social(d)[0] == gate.REJECT


def manifest(version="v1", **data):
    return {"version": version, "metrics": {"data": data}}


def test_a_bundle_trained_on_held_out_days_fails_sanity(tmp_path):
    ok = gate.trained_on(manifest(trained_days=["2026-10-18", "2026-10-29"]), tmp_path / "v1")
    assert gate.holdout_check(ok)["passed"] and not ok["test_in_sample"]
    for day in ("2026-10-30", "2026-10-31", "2026-11-03"):  # embargo, selection, test (--allow-holdout)
        t = gate.trained_on(manifest(trained_days=["2026-10-29", day]), tmp_path / "v1")
        assert t["held_out_days"] == [day] and not gate.holdout_check(t)["passed"]
    # bundles from before the field: the fit days the manifest lists, else the saved state's meta
    assert gate.trained_on(manifest(fit_days=[{"day": "2026-10-31", "n": 5}]), tmp_path / "v1")["held_out_days"] == ["2026-10-31"]
    st = tmp_path / "_state" / "v2"
    st.mkdir(parents=True)
    (st / "brain.json").write_text(json.dumps({"meta": {"trained_days": ["2026-11-01"]}}))
    t = gate.trained_on({"version": "v2", "metrics": {}}, tmp_path / "v2")
    assert t["held_out_days"] == ["2026-11-01"] and t["source"].endswith("brain.json")
    # nothing says what it trained on: rejected
    t = gate.trained_on({"version": "v3", "metrics": {}}, tmp_path / "v3")
    assert t["trained_days"] is None and not gate.holdout_check(t)["passed"]


def test_paper_transitions_make_test_in_sample_and_may_not_touch_selection(tmp_path):
    live = gate.trained_on(manifest(trained_days=["2026-10-29"], paper_transitions_range=["2026-11-08T01:00:00+00:00", "2026-11-09T05:00:00+00:00"]),
                           tmp_path / "v1")
    assert gate.holdout_check(live)["passed"] and live["test_in_sample"]
    # a range spans every period between its ends: fit .. test passes through embargo and selection
    early = gate.trained_on(manifest(trained_days=["2026-10-29"], paper_transitions_range=["2026-10-29T23:00:00+00:00", "2026-11-03T00:00:00+00:00"]),
                            tmp_path / "v1")
    assert early["paper_transitions_periods"] == ["fit", "embargo", "selection", "test"] and not gate.holdout_check(early)["passed"]


def test_test_is_opt_in_and_scored_once_per_bundle(tmp_path, monkeypatch):
    d = tmp_path / "v1"
    d.mkdir()
    (d / "manifest.json").write_text(json.dumps({"version": "v1"}))
    calls = []

    def fake_gate(bundle_dir, a):
        calls.append(a)
        return gate.EXPLORE_ONLY, {"version": "v1", "checks": {"bar": []}, "decision": {"exit": gate.EXPLORE_ONLY}}
    monkeypatch.setattr(gate, "gate", fake_gate)
    assert gate.main(["--bundle", str(d), "--no-test"]) == gate.EXPLORE_ONLY  # cycle.sh's flag: still accepted
    assert gate.main(["--bundle", str(d)]) == gate.EXPLORE_ONLY and not calls[-1].final_test  # the default: no TEST
    assert gate.main(["--bundle", str(d), "--final-test"]) == gate.EXPLORE_ONLY and calls[-1].final_test
    gate.append_ledger(tmp_path, {"version": "v1", "at": "2026-11-08T00:00:00Z", "per_copy": 0.01})
    n = len(calls)
    with pytest.raises(SystemExit) as e:  # a second TEST scoring of the same bundle is refused before anything runs
        gate.main(["--bundle", str(d), "--final-test"])
    assert e.value.code == 2 and len(calls) == n
    assert gate.main(["--bundle", str(d), "--final-test", "--rescore-test"]) == gate.EXPLORE_ONLY and len(calls) == n + 1
    with pytest.raises(SystemExit):
        gate.main(["--bundle", str(d), "--final-test", "--no-test"])
    rep = json.loads((tmp_path / "v1.gate-report.json").read_text())
    assert rep["gate_sha256"] == gate.code_hash() and len(rep["gate_sha256"]) == 64


def test_the_ledger_labels_test_numbers_already_seen(tmp_path):
    assert gate.ledger_summary(tmp_path, "v1")["views_all_bundles"] == 0
    gate.append_ledger(tmp_path, {"version": "v0", "at": "a"})
    gate.append_ledger(tmp_path, {"version": "v1", "at": "b"})
    gate.append_ledger(tmp_path, {"version": "v1", "at": "c"})
    s = gate.ledger_summary(tmp_path, "v1")
    assert s["views_all_bundles"] == 3 and s["bundles"] == ["v0", "v1"] and [r["at"] for r in s["views_this_bundle"]] == ["b", "c"]
    assert "not a clean holdout" in s["label"] and gate.ledger_path(tmp_path) == tmp_path / "_work" / "test-ledger.jsonl"
