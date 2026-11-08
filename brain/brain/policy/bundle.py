"""
A model bundle as the simulator's policy: the ONNX files the server would run, through onnxruntime (CPU), with the
manifest's norms and decision rules (CONTRACT.md "Decision", "Exploration"; agent/src/brain/policy.ts).

    b = Bundle(dir)                                   # manifest, hashes and widths checked, one session per network
    ei = entry_inputs(window, meta)                   # brain.policy.data
    stake = b.entry_stakes(ei)                        # fraction per signal row (gated = 0), mean - margin_c * std rule
    r = evaluate(window, b.entry_callback(ei), b.exit_policy(ExitFeaturizer(ei.ps_r, hourly)), ...)

The gate scores bundles this way, so what it promotes is exactly what the server would trade: not the PyTorch copy.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from brain.export_onnx import run, session, sha256
from brain.features import spec
from brain.policy.entry import Ensemble
from brain.policy.exit import ExitFeaturizer, ExitPolicy


class BundleError(Exception):
    pass


class Bundle:
    def __init__(self, path, check_hashes: bool = True):
        self.dir = Path(path)
        self.manifest = m = json.loads((self.dir / "manifest.json").read_text())
        e, x = m["entry"], m["exit"]
        if check_hashes:
            for f in [*e["members"], x["file"]]:
                if f not in m.get("sha256", {}) or sha256(self.dir / f) != m["sha256"][f]:
                    raise BundleError(f"sha256 mismatch or missing for {f}")
        self.actions = tuple(float(a) for a in e["actions"])
        self.margin_c = float(e.get("margin_c", 0.0))
        self.explore_cfg = m.get("explore", {"rate": 0.0, "curiosity": 0.0})
        self.brain_enabled = m.get("brain_enabled", True) is not False
        self.entry_norm = spec.Norm(list(e["features"]), np.asarray(e["norm"]["mean"]), np.asarray(e["norm"]["std"]))
        self.exit_norm = spec.Norm(list(x["features"]), np.asarray(x["norm"]["mean"]), np.asarray(x["norm"]["std"]))
        self.members = [session(self.dir / f) for f in e["members"]]
        self.exit_sess = session(self.dir / x["file"])
        self.ensemble = Ensemble([lambda Z, s=s: run(s, Z) for s in self.members], self.actions, self.margin_c)

    @property
    def version(self) -> str:
        return self.manifest["version"]

    def entry_q(self, Z: np.ndarray) -> np.ndarray:
        return self.ensemble.q(Z)

    def entry_meta(self) -> dict:
        """The feature-build meta the bundle was trained with (columns, categories, norm): normalise raw features with it, as
        the runtime does with the manifest, not with a feature build made later."""
        e = self.manifest["entry"]
        return {"columns": list(e["features"]), "categories": e.get("categories", {}),
                "norm": {"columns": list(e["features"]), "mean": e["norm"]["mean"], "std": e["norm"]["std"]}}

    def exit_q(self, Z: np.ndarray) -> np.ndarray:
        return run(self.exit_sess, Z)

    def check_columns(self, entry_columns: list[str]) -> None:
        if list(self.entry_norm.columns) != list(entry_columns):
            raise BundleError("entry.features differ from the feature build's columns")
        if list(self.exit_norm.columns) != spec.columns(spec.exit_features()):
            raise BundleError("exit.features differ from features.yaml exit columns")

    def entry_stakes(self, ei, margin_c: float | None = None, q: np.ndarray | None = None) -> np.ndarray:
        """Brain account stake fractions per row (0 when gated, or when brain_enabled is false)."""
        if not self.brain_enabled:
            return np.zeros(len(ei.Z))
        q = self.entry_q(ei.Z) if q is None else q
        return np.where(ei.gated, 0.0, self.ensemble.decide(q, margin_c))

    def explore_stakes(self, ei, seed: int = 0, q: np.ndarray | None = None, curiosity: float | None = None) -> np.ndarray:
        """Explore account stake fractions, for every ungated row (the routing by explore.rate is the caller's)."""
        q = self.entry_q(ei.Z) if q is None else q
        c = self.explore_cfg["curiosity"] if curiosity is None else curiosity
        return np.where(ei.gated, 0.0, self.ensemble.explore(q, c, np.random.default_rng(seed)))

    def exit_policy(self, fz: ExitFeaturizer) -> ExitPolicy:
        return ExitPolicy(self.exit_q, self.exit_norm, fz)


def stake_callback(frac: np.ndarray, max_trade_sol: float):
    """An evaluate() entry callback from stake fractions per window row (evaluate passes sig rows with their row index)."""
    frac = np.asarray(frac, dtype=np.float64)
    return lambda sig: frac[sig.index.to_numpy()] * max_trade_sol
