"""
brain.export_onnx: a bundle as CONTRACT.md "Model bundle" describes it, ONNX equal to PyTorch to 1e-5, hashes, staging,
and policy.bundle running it the way the server does (agent/src/brain/model.ts validateManifest rules).
"""
from __future__ import annotations

import json

import numpy as np
import pandas as pd
import pytest
import torch

import brain.export_onnx as ex
from brain.baselines import RuleExit
from brain.features import spec
from brain.policy import entry as pe
from brain.policy import exit as px
from brain.policy.bundle import Bundle, BundleError
from brain.policy.nets import QNet, predict


@pytest.fixture(scope="module")
def parts():
    feats = spec.entry_features()
    cats = {"venue_group": ["pumpswap", "pumpfun_curve", "missing", "other"]}
    cols = spec.columns(feats, cats)
    rng = np.random.default_rng(0)
    raw = pd.DataFrame({f.name: (rng.choice(["pumpswap", "pumpfun_curve", None], 300) if f.onehot else rng.normal(1, 2, 300)) for f in feats})
    norm = spec.fit_norm(spec.encode(raw, feats, cats), cols, spec.binary_columns(feats, cats))
    meta = {"columns": cols, "categories": cats, "norm": norm.to_json()}
    torch.manual_seed(0)
    members = [QNet(len(cols), 1, mask=pe.input_mask(cols), scale=0.1, skip_zero=True).eval() for _ in range(5)]
    xcols = px.exit_columns()
    X = rng.normal(0, 1, (400, len(xcols))).astype(np.float32)
    xnorm = px.fit_exit_norm(X)
    exit_net = QNet(len(xcols), 3, scale=0.1).eval()
    Ze = spec.normalise(spec.encode(raw, feats, cats), norm).astype(np.float32)
    return {"meta": meta, "members": members, "exit": exit_net, "xnorm": xnorm, "Ze": Ze, "Zx": px.normalise(X, xnorm)}


def write(parts, root, **kw):
    args = dict(actions=(0.0, 1.0), margin_c=1.5, explore={"rate": 0.05, "curiosity": 0.5}, metrics={"validation": {"x": 1}},
                check_entry=parts["Ze"], check_exit=parts["Zx"])
    args.update(kw)
    return ex.write_bundle(root, "2026-11-07T12-00-00Z", parts["members"], parts["exit"], parts["meta"], parts["xnorm"], **args)


def test_bundle_follows_the_contract(parts, tmp_path):
    d = write(parts, tmp_path)
    assert d == tmp_path / "2026-11-07T12-00-00Z" and not list(tmp_path.glob(".*.tmp"))  # staged, then renamed into place
    m = json.loads((d / "manifest.json").read_text())
    e, x = m["entry"], m["exit"]
    assert m["feature_spec_version"] == spec.version() and m["brain_enabled"] is True
    assert e["members"] == [f"entry-{k}.onnx" for k in range(5)] and e["input"] == "x" and e["output"] == "q"
    assert e["actions"] == [0.0, 1.0] and e["margin_c"] == 1.5 and e["categories"] == parts["meta"]["categories"]
    assert e["features"] == parts["meta"]["columns"] and len(e["norm"]["mean"]) == len(e["features"])
    assert x["file"] == "exit.onnx" and x["actions"] == ["hold", "sell_half", "sell_all"] and x["features"] == px.exit_columns()
    assert m["explore"] == {"rate": 0.05, "curiosity": 0.5} and m["metrics"]["validation"] == {"x": 1}
    assert set(m["sha256"]) == {*e["members"], "exit.onnx"}
    assert all(ex.sha256(d / f) == h for f, h in m["sha256"].items())
    assert max(m["metrics"]["onnx_max_abs_diff"].values()) <= ex.TOL
    assert ex.verify(d)["ok"]


def test_the_bundle_runs_what_pytorch_computes(parts, tmp_path):
    d = write(parts, tmp_path)
    b = Bundle(d)
    q = b.entry_q(parts["Ze"])
    want = np.stack([predict(m, parts["Ze"]) for m in parts["members"]])
    np.testing.assert_allclose(q, want, atol=1e-5)
    assert (q[:, :, 0] == 0).all()  # skip is 0
    np.testing.assert_allclose(b.exit_q(parts["Zx"]), predict(parts["exit"], parts["Zx"]), atol=1e-5)
    ens = pe.Ensemble(parts["members"], (0.0, 1.0), 1.5)
    np.testing.assert_array_equal(b.ensemble.decide(q), ens.decide(want))
    b.check_columns(parts["meta"]["columns"])
    with pytest.raises(BundleError):
        b.check_columns(parts["meta"]["columns"][::-1])


def test_a_tampered_or_incomplete_bundle_is_refused(parts, tmp_path):
    d = write(parts, tmp_path)
    (d / "exit.onnx").write_bytes((d / "exit.onnx").read_bytes() + b"x")
    v = ex.verify(d)
    assert not v["ok"] and "exit.onnx hash mismatch" in v["problems"]
    with pytest.raises(BundleError):
        Bundle(d)
    (d / "entry-3.onnx").unlink()
    assert "entry-3.onnx missing" in ex.verify(d)["problems"]


def test_parity_failure_writes_nothing(parts, tmp_path, monkeypatch):
    real = ex.run
    monkeypatch.setattr(ex, "run", lambda s, X, batch=65_536: real(s, X, batch) + 1e-3)
    with pytest.raises(ex.ParityError):
        write(parts, tmp_path)
    assert not (tmp_path / "2026-11-07T12-00-00Z").exists()


def test_verify_applies_the_runtime_manifest_rules(parts, tmp_path):
    d = write(parts, tmp_path)
    m = json.loads((d / "manifest.json").read_text())
    m["entry"]["actions"] = [0.25, 1.0]
    (d / "manifest.json").write_text(json.dumps(m))
    assert any("actions" in p for p in ex.verify(d)["problems"])


def test_a_rule_exit_ships_exactly(parts, tmp_path):
    net = px.rule_net(RuleExit("t1", follow=False, time_min=1), parts["xnorm"])
    d = write({**parts, "exit": net}, tmp_path)
    b = Bundle(d)
    cols = px.exit_columns()
    st = {k: np.zeros(5) for k in px.ENGINE_KEYS}
    st["minutes_held"] = np.array([0.0, 0.5, 0.99, 1.0, 7.0])
    pol = b.exit_policy(px.ExitFeaturizer())
    np.testing.assert_array_equal(pol(st), [0, 0, 0, 1, 1])
    assert len(cols) == net.n_in


def test_the_hourly_fine_tune_reads_each_logging_bundles_exit_norm(parts, tmp_path):
    from brain.train import exit_norms
    d = write(parts, tmp_path)
    norm_of = exit_norms(tmp_path)
    n = norm_of(d.name)
    assert n.columns == px.exit_columns()
    np.testing.assert_allclose(n.mean, parts["xnorm"].mean) and np.testing.assert_allclose(n.std, parts["xnorm"].std)
    assert norm_of("2026-01-01T00-00-00Z") is None and norm_of(None) is None  # an unknown version's rows are dropped
