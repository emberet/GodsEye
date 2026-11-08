"""
Export a trained brain as a model bundle (CONTRACT.md "Model bundle"): entry-0..4.onnx, exit.onnx and manifest.json.

    d = write_bundle(models_dir, version, members, exit_net, entry_meta, exit_norm, margin_c=1.0, explore={...},
                     metrics={...}, check_entry=Z[:512], check_exit=Zx[:512])

Each network is exported with input "x" (float32 [n, F], the normalised features in the manifest's order) and output
"q" (float32 [n, actions]), then run once in onnxruntime (CPU, as the server runs it) on real inputs: every output must
equal PyTorch's to 1e-5 or nothing is written. The bundle is built in a hidden staging folder next to the final one;
manifest.json is written last (with the sha256 of every network file) and the folder is renamed into place, so a reader
never sees a half-written bundle. Data, never code: the bundle lives under the data drive's models/, not in the repo.
"""
from __future__ import annotations

import hashlib
import json
import shutil
import warnings
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import torch

from brain.features import spec

TOL = 1e-5
OPSET = 17
EXIT_ACTIONS = ["hold", "sell_half", "sell_all"]


class ParityError(RuntimeError):
    """An exported network does not give PyTorch's numbers."""


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with Path(path).open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def export(net: torch.nn.Module, path: Path) -> None:
    """The TorchScript exporter (as brain.social.train): plain MLPs, opset 17, a dynamic batch axis."""
    net = net.to("cpu").eval()
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", DeprecationWarning)
        torch.onnx.export(net, (torch.zeros(1, net.n_in),), str(path), input_names=["x"], output_names=["q"],
                          dynamic_axes={"x": {0: "n"}, "q": {0: "n"}}, opset_version=OPSET, dynamo=False, external_data=False)


def session(path: Path):
    import onnxruntime as ort
    so = ort.SessionOptions()
    so.intra_op_num_threads = 1
    so.inter_op_num_threads = 1
    return ort.InferenceSession(str(path), so, providers=["CPUExecutionProvider"])


def run(sess, X: np.ndarray, batch: int = 65_536) -> np.ndarray:
    X = np.asarray(X, dtype=np.float32)
    out = [sess.run(["q"], {"x": X[i:i + batch]})[0] for i in range(0, len(X), batch)]
    return np.concatenate(out) if out else np.zeros((0, 0), np.float32)


def parity(path: Path, net: torch.nn.Module, X: np.ndarray, tol: float = TOL) -> float:
    """Max |onnxruntime - torch| over X; raises ParityError above tol."""
    X = np.asarray(X, dtype=np.float32)
    with torch.no_grad():
        want = net.to("cpu").eval()(torch.from_numpy(X)).numpy()
    got = run(session(path), X)
    err = float(np.abs(got - want).max()) if len(X) else 0.0
    if got.shape != want.shape or not err <= tol:
        raise ParityError(f"{Path(path).name}: onnxruntime differs from torch by {err:.2e} (shape {got.shape} vs {want.shape})")
    return err


def version_now(now: datetime | None = None) -> str:
    return (now or datetime.now(timezone.utc)).strftime("%Y-%m-%dT%H-%M-%SZ")


def write_bundle(out_root: Path, version: str, members: list, exit_net: torch.nn.Module, entry_meta: dict, exit_norm: spec.Norm, *,
                 actions, margin_c: float, explore: dict, metrics: dict, check_entry: np.ndarray, check_exit: np.ndarray,
                 brain_enabled: bool = True, extra: dict | None = None) -> Path:
    """
    entry_meta: the feature build's meta (columns, categories, norm). Returns the bundle directory <out_root>/<version>.
    """
    out_root = Path(out_root)
    out_root.mkdir(parents=True, exist_ok=True)
    tmp = out_root / f".{version}.tmp"
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir()
    err = {}
    names = []
    for k, m in enumerate(members):
        f = f"entry-{k}.onnx"
        export(m, tmp / f)
        err[f] = parity(tmp / f, m, check_entry)
        names.append(f)
    export(exit_net, tmp / "exit.onnx")
    err["exit.onnx"] = parity(tmp / "exit.onnx", exit_net, check_exit)
    enorm = spec.Norm.from_json(entry_meta["norm"])
    if list(enorm.columns) != list(entry_meta["columns"]):
        raise ValueError("entry norm columns differ from the feature build's columns")
    xcols = spec.columns(spec.exit_features())
    if list(exit_norm.columns) != xcols:
        raise ValueError("exit norm columns differ from features.yaml exit columns")
    now = datetime.now(timezone.utc)
    manifest = {
        "version": version,
        "created_at": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "feature_spec_version": spec.version(),
        "entry": {
            "features": list(entry_meta["columns"]),
            "norm": {"mean": [float(v) for v in enorm.mean], "std": [float(v) for v in enorm.std]},
            "members": names,
            "input": "x",
            "output": "q",
            "actions": [float(a) for a in actions],
            "margin_c": float(margin_c),
            "categories": entry_meta["categories"],
        },
        "exit": {
            "features": xcols,
            "norm": {"mean": [float(v) for v in exit_norm.mean], "std": [float(v) for v in exit_norm.std]},
            "file": "exit.onnx",
            "input": "x",
            "output": "q",
            "actions": EXIT_ACTIONS,
        },
        "brain_enabled": bool(brain_enabled),
        "explore": {"rate": float(explore["rate"]), "curiosity": float(explore["curiosity"])},
        "metrics": {**metrics, "onnx_max_abs_diff": err},
        "sha256": {f: sha256(tmp / f) for f in [*names, "exit.onnx"]},
        **(extra or {}),
    }
    (tmp / "manifest.json").write_text(json.dumps(manifest, indent=1, default=_json))
    final = out_root / version
    if final.exists():
        shutil.rmtree(final)
    tmp.rename(final)
    return final


def _json(o):
    if isinstance(o, (np.floating, np.integer)):
        return o.item()
    if isinstance(o, np.ndarray):
        return o.tolist()
    if isinstance(o, (set, frozenset)):
        return sorted(o)
    return str(o)


def verify(bundle: Path) -> dict:
    """Re-check a written bundle: manifest shape, every hash, every network runs with the declared widths."""
    bundle = Path(bundle)
    m = json.loads((bundle / "manifest.json").read_text())
    problems = []
    for f, h in m["sha256"].items():
        if not (bundle / f).is_file():
            problems.append(f"{f} missing")
        elif sha256(bundle / f) != h:
            problems.append(f"{f} hash mismatch")
    e, x = m["entry"], m["exit"]
    for f in e["members"]:
        if f not in m["sha256"]:
            problems.append(f"{f} has no hash")
    if x["file"] not in m["sha256"]:
        problems.append("exit.onnx has no hash")
    if not problems:
        for f in e["members"]:
            q = run(session(bundle / f), np.zeros((2, len(e["features"])), np.float32))
            if q.shape != (2, len(e["actions"])) or not np.isfinite(q).all():
                problems.append(f"{f}: output {q.shape}")
        q = run(session(bundle / x["file"]), np.zeros((2, len(x["features"])), np.float32))
        if q.shape != (2, 3) or not np.isfinite(q).all():
            problems.append(f"exit.onnx: output {q.shape}")
    a = e["actions"]
    if not (a and a[0] == 0 and all(b > c for b, c in zip(a[1:], a[:-1])) and a[-1] <= 1):
        problems.append(f"entry.actions {a}: must start at 0, increase, end <= 1")
    if len(e["norm"]["mean"]) != len(e["features"]) or len(x["norm"]["mean"]) != len(x["features"]):
        problems.append("norm length differs from features")
    if any(s <= 0 for s in e["norm"]["std"] + x["norm"]["std"]):
        problems.append("a norm std <= 0")
    return {"ok": not problems, "problems": problems, "version": m.get("version")}
