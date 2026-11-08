"""
Train the PRIVATE social model: `python -m brain.social.train` (on the Mac; nothing here touches the server).

Dataset, point in time (features.yaml `social`): one row per (owner-linked wallet, as-of day t at 00:00 UTC):
  inputs  the social inputs at t (features.py: only what was known before t)
  target  y14(w, t) = mean copy outcome over w's copy-eligible first buys in [t, t + 14 d), only with >= 5 of them;
          training weight n / (n + 18); usable once matured: t + 14 d + 30 h <= the newest resolution in the ledger (a copy
          bought just before t + 14 d resolves by its 24 h hold plus the 6 h grounded lookahead, so none is missing),
          and only where the ledger the Mac holds is complete: t >= its coverage start + 7 d + 30 h (the server prunes
          rows after 8 days, see data.py; own_record_shrunk reads rows resolved in [t - 7 d, t), bought up to 30 h earlier).
          Below that the 14-day mean and the own record would be partial windows.
The copy outcome is the strict mirror y (the cp_lrshr_7d ledger) when the ledger exists, else the research reference label
(data.copies says which; the manifest records it). own_record_shrunk reads every resolved ledger row, not just first buys:
the server's scorer reads the ledger that way.

Minimum data (features.yaml social.gate): at least 300 owner-linked wallets with a matured y14. With fewer, no bundle is
written and the run exits 0 with one log line: today the X tables are empty, so this is the normal outcome.

Model: a small MLP on the normalised inputs predicting y14 - pop_mean; the exported net adds pop_mean back, so social.onnx
outputs the predicted 14-day copy return (CONTRACT.md "Social score") and the server stores score = output - pop_mean.
Validation is out of time: the last 30 % of as-of days, with the training days ending 15 d before them (the 14-day labels
overlap). The gate (features.yaml social.gate) is ONE pre-registered test there: Spearman of the prediction with y14, raw
and partial on own_record_shrunk, wallet-bootstrap 95 % CIs, both lower bounds > 0, >= 300 validation wallets.

ONE test means one look. The first run where the test is valid (embargo room, >= 300 validation wallets, the mirror ledger
as the source so own_record_shrunk is the server's) records it in PRIVATE_DIR/social_gate.json: validation days, seed,
model hash, feature spec version, target source and result. Every later run copies that verdict into its manifest (`gate`,
which is all the server trusts) and does not test again, whatever its seed; this run's own numbers go to
metrics.validation_check, for information only. A pass carries over only to a run on the same feature spec version and
target source as the look: any other run's gate says passed = false (an untested model), until a new look. After a failed
(or not carried) verdict, `--retest` looks once more, only on days whose labels can't overlap any earlier look's
(validation days from the last look's last day + 14 d), at a Bonferroni-corrected level (95 % CI -> 1 - 0.05 / looks);
every look is kept.

Output: PRIVATE_DIR/models/<version>/{manifest.json, social.onnx}; push it with `python -m brain.push --social <dir>`.
Logs carry counts only, never a wallet, a handle or a post.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
import torch
from scipy import stats
from torch import nn

from brain import config
from brain.social import data as sdata
from brain.social.features import (DAY, SHRINK_N, Index, InputSpec, SocialTables, build_index, feature_names, fill_values,
                                   load_spec, owner_accounts, raw_inputs, transformed, vector)

MIN_WALLETS = 300  # owner-linked wallets with a matured y14 (features.yaml social.gate)
MIN_COPIES = 5  # copies in the 14-day window for a usable target
HORIZON = 14 * DAY
RESOLVE = 30 * 3600.0  # a mirror copy resolves at most 24 h (hold) + 6 h (grounded lookahead) after its buy
MATURE = HORIZON + RESOLVE  # the last copy of the window has resolved
OWN_LEAD = 7 * DAY + RESOLVE  # own_record_shrunk at t reads rows resolved in [t - 7 d, t): bought from t - 7 d - 30 h
VAL_SHARE = 0.3
EMBARGO = 15 * DAY
ALPHA = 0.05  # the gate's CIs are 1 - ALPHA / looks
SERVER_LEDGER = "mirror_ledger"  # the only target source whose own_record_shrunk is built like the server's
MODEL_FILE = "social.onnx"
GATE_FILE = "social_gate.json"  # under PRIVATE_DIR: the looks taken at the pre-registered test
LOG = "[social]"


def log(msg: str) -> None:
    print(f"{LOG} {msg}", flush=True)


# ---------------------------------------------------------------------------------------------------------------------
# Dataset


def asof_grid(links: pd.DataFrame, data_end: float, ledger_start: float | None = None) -> list[float]:
    """Days (00:00 UTC) from the day after the first link was known to the last day whose 14-day target has matured
    (data_end = the newest resolved_at in the ledger), and none before the ledger is complete for both the target and
    own_record_shrunk (ledger_start + OWN_LEAD; ledger_start = where the ledger's coverage starts, None = no bound)."""
    if links.empty or not np.isfinite(data_end):
        return []
    first = (np.floor(links.first_seen.min() / DAY) + 1) * DAY
    if ledger_start is not None:
        if not np.isfinite(ledger_start):
            return []
        first = max(first, np.ceil((ledger_start + OWN_LEAD) / DAY) * DAY)
    return [float(t) for t in np.arange(first, data_end - MATURE + 1, DAY)]


def targets(copies: pd.DataFrame) -> dict[str, tuple[np.ndarray, np.ndarray]]:
    """leader -> (buy_ts[], y[]) sorted by buy_ts."""
    out = {}
    for lead, g in copies.dropna(subset=["y"]).sort_values("buy_ts").groupby("leader", sort=False):
        out[lead] = (g.buy_ts.to_numpy(float), g.y.to_numpy(float))
    return out


def y14(tg: dict, wallet: str, t: float) -> tuple[float, int] | None:
    c = tg.get(wallet)
    if c is None:
        return None
    lo, hi = np.searchsorted(c[0], t, "left"), np.searchsorted(c[0], t + HORIZON, "left")
    n = int(hi - lo)
    return (float(c[1][lo:hi].mean()), n) if n >= MIN_COPIES else None


def labelled(ix: Index, tg: dict, asofs: list[float]) -> pd.DataFrame:
    """(wallet, t, y, n) for every owner-linked wallet with a usable target at each as-of day."""
    rows = []
    for t in asofs:
        for w in ix.links_by_wallet:
            if not owner_accounts(ix, w, t):
                continue
            lab = y14(tg, w, t)
            if lab:
                rows.append((w, t, lab[0], lab[1]))
    return pd.DataFrame(rows, columns=["wallet", "t", "y", "n"])


def with_inputs(ix: Index, spec: list[InputSpec], rows: pd.DataFrame, pop_mean: float) -> tuple[list[dict], list[int]]:
    xs, n_posts = [], []
    for w, t in rows[["wallet", "t"]].itertuples(index=False):
        raw, n = raw_inputs(ix, w, t, pop_mean)
        xs.append(transformed(spec, raw))
        n_posts.append(n)
    return xs, n_posts


def split_days(asofs: list[float]) -> tuple[list[float], list[float], bool]:
    """(train days, validation days, embargoed): validation = the last VAL_SHARE of days; training ends EMBARGO before.
    Without room for the embargo, training takes every earlier day and the gate can't pass."""
    k = max(1, int(round(len(asofs) * VAL_SHARE)))
    val = asofs[-k:]
    train = [t for t in asofs if t <= val[0] - EMBARGO]
    if train:
        return train, val, True
    return [t for t in asofs if t < val[0]], val, False


def retest_split(asofs: list[float], after: float) -> tuple[list[float], list[float], bool] | None:
    """A retest's (train days, validation days, embargoed): validation only on days whose 14-day labels start after the
    last look's validation days ended (>= after + HORIZON); None when there are no such days."""
    val = [t for t in asofs if t >= after + HORIZON]
    if not val:
        return None
    train = [t for t in asofs if t <= val[0] - EMBARGO]
    return (train, val, True) if train else ([t for t in asofs if t < val[0]], val, False)


# ---------------------------------------------------------------------------------------------------------------------
# Model


class Net(nn.Module):
    """y14 - pop_mean from the normalised inputs."""

    def __init__(self, n_in: int):
        super().__init__()
        self.body = nn.Sequential(nn.Linear(n_in, 32), nn.ReLU(), nn.Dropout(0.1), nn.Linear(32, 16), nn.ReLU(), nn.Linear(16, 1))

    def forward(self, x):
        return self.body(x)


class Exported(nn.Module):
    """What social.onnx runs: x [n, F] -> y [n, 1], the predicted 14-day copy return."""

    def __init__(self, net: Net, pop_mean: float):
        super().__init__()
        self.net = net
        self.register_buffer("pop", torch.tensor([pop_mean], dtype=torch.float32))

    def forward(self, x):
        return self.net(x) + self.pop


def pick_device(name: str) -> torch.device:
    if name == "auto":
        return torch.device("mps" if torch.backends.mps.is_available() else "cpu")
    return torch.device(name)


def fit(x: np.ndarray, y: np.ndarray, w: np.ndarray, groups: np.ndarray, device: torch.device, seed: int = 0,
        epochs: int = 300, patience: int = 25, batch: int = 1024) -> Net:
    """Weighted MSE with early stopping on the last 20 % of the training days (time-ordered `groups`)."""
    torch.manual_seed(seed)
    rng = np.random.default_rng(seed)
    days = np.unique(groups)
    cut = days[int(len(days) * 0.8)] if len(days) >= 5 else np.inf
    fit_m, stop_m = groups < cut, groups >= cut
    net = Net(x.shape[1]).to(device)
    opt = torch.optim.AdamW(net.parameters(), lr=1e-3, weight_decay=1e-3)
    tx, ty, tw = (torch.tensor(a, dtype=torch.float32, device=device) for a in (x, y, w))

    def loss(idx: np.ndarray):
        i = torch.as_tensor(idx, device=device)
        p = net(tx[i]).squeeze(1)
        return (tw[i] * (p - ty[i]) ** 2).sum() / tw[i].sum()

    best, best_state, bad = np.inf, None, 0
    fit_idx, stop_idx = np.flatnonzero(fit_m), np.flatnonzero(stop_m)
    for _ in range(epochs):
        net.train()
        for b in np.array_split(rng.permutation(fit_idx), max(1, len(fit_idx) // batch)):
            opt.zero_grad()
            loss(b).backward()
            opt.step()
        if not len(stop_idx):
            continue
        net.eval()
        with torch.no_grad():
            v = float(loss(stop_idx))
        if v < best - 1e-9:
            best, bad = v, 0
            best_state = {k: t.detach().clone() for k, t in net.state_dict().items()}
        else:
            bad += 1
            if bad >= patience:
                break
    if best_state is not None:
        net.load_state_dict(best_state)
    return net.cpu().eval()


def predict(net: Net, x: np.ndarray) -> np.ndarray:
    with torch.no_grad():
        return net(torch.tensor(x, dtype=torch.float32)).squeeze(1).numpy()


def export_onnx(net: Net, pop_mean: float, n_in: int, path: Path) -> None:
    torch.onnx.export(Exported(net, pop_mean).eval(), (torch.zeros(1, n_in),), str(path), input_names=["x"], output_names=["y"],
                      dynamic_axes={"x": {0: "n"}, "y": {0: "n"}}, opset_version=17, dynamo=False, external_data=False)


# ---------------------------------------------------------------------------------------------------------------------
# The pre-registered out-of-time test


def _partial_spearman(a: np.ndarray, b: np.ndarray, c: np.ndarray) -> float:
    """Spearman of a and b after removing c (ranks, linear residuals)."""
    ra, rb, rc = (stats.rankdata(v) for v in (a, b, c))
    X = np.column_stack([np.ones_like(rc), rc])
    res = lambda v: v - X @ np.linalg.lstsq(X, v, rcond=None)[0]  # noqa: E731
    ea, eb = res(ra), res(rb)
    d = np.sqrt((ea ** 2).sum() * (eb ** 2).sum())
    return float((ea * eb).sum() / d) if d > 0 else 0.0


def gate(pred: np.ndarray, y: np.ndarray, own: np.ndarray, wallets: np.ndarray, embargoed: bool, min_wallets: int,
         B: int = 500, seed: int = 0, alpha: float = ALPHA, server_ledger: bool = True) -> dict:
    """Raw and partial (on own_record_shrunk) Spearman with wallet-bootstrap (1 - alpha) CIs; passed only when both lower
    bounds > 0. `valid` says whether this was a real test: without embargo room, enough validation wallets or the server's
    own_record_shrunk it is not, and no correlation is computed (a look that can't count is not taken either)."""
    n_w = int(len(np.unique(wallets)))
    out: dict = {"wallets": n_w, "rows": int(len(y)), "embargoed": embargoed, "min_wallets": min_wallets, "alpha": alpha}
    invalid = ("no embargo room" if not embargoed
               else f"{n_w} validation wallets (need {min_wallets})" if n_w < max(min_wallets, 2) or len(y) < 3
               else "own_record_shrunk isn't the server's (the target source is not the mirror ledger)" if not server_ledger
               else None)
    if invalid:
        return out | {"passed": False, "valid": False, "reason": invalid}
    raw = float(stats.spearmanr(pred, y).statistic)
    part = _partial_spearman(pred, y, own)
    uniq, inv = np.unique(wallets, return_inverse=True)
    members = [np.flatnonzero(inv == i) for i in range(len(uniq))]
    rng = np.random.default_rng(seed)
    bs_raw, bs_part = [], []
    for _ in range(B):
        idx = np.concatenate([members[i] for i in rng.integers(0, len(uniq), len(uniq))])
        if np.ptp(pred[idx]) == 0 or np.ptp(y[idx]) == 0:
            continue
        bs_raw.append(stats.spearmanr(pred[idx], y[idx]).statistic)
        bs_part.append(_partial_spearman(pred[idx], y[idx], own[idx]))
    lo, hi = 100 * alpha / 2, 100 * (1 - alpha / 2)
    ci = lambda v: [float(np.nanpercentile(v, lo)), float(np.nanpercentile(v, hi))] if v else [np.nan, np.nan]  # noqa: E731
    out |= {"spearman": raw, "spearman_ci": ci(bs_raw), "partial_spearman": part, "partial_spearman_ci": ci(bs_part)}
    passed = out["spearman_ci"][0] > 0 and out["partial_spearman_ci"][0] > 0
    return out | {"passed": bool(passed), "valid": True, "reason": None if passed else "a lower bound is <= 0"}


def read_looks(path: Path) -> list[dict]:
    """The looks already taken at the pre-registered test (oldest first); [] before the first."""
    if not path.is_file():
        return []
    return list(json.loads(path.read_text()).get("looks", []))


def write_looks(path: Path, looks: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp")
    tmp.write_text(json.dumps({"passed": bool(looks[-1]["result"]["passed"]), "looks": looks}, indent=2))
    tmp.replace(path)


def recorded_gate(looks: list[dict], spec_version: int | None = None, source: str | None = None) -> dict:
    """The manifest `gate` of a run that doesn't test: the recorded verdict, said where it came from. A pass holds only for
    a run on the feature spec version and target source the look tested (None = not checked): otherwise this model is
    untested and its gate fails until a new look."""
    last = looks[-1]
    passed = bool(last["result"]["passed"])
    reason = None if passed else "the pre-registered test failed"
    if passed and spec_version is not None and last.get("feature_spec_version") != spec_version:
        passed, reason = False, f"untested spec version: the look tested feature spec {last.get('feature_spec_version')}, this run is {spec_version}"
    elif passed and source is not None and last.get("source") != source:
        passed, reason = False, f"target source changed: the look tested {last.get('source')}, this run is {source}"
    return {"passed": passed, "preregistered": True, "looks": len(looks), "tested_version": last["version"],
            "tested_at": last["at"], "reason": reason}


# ---------------------------------------------------------------------------------------------------------------------
# The run


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def train(tables: SocialTables, copies: pd.DataFrame, out_root: Path, *, ledger: pd.DataFrame | None = None, source: str = "unknown",
          ledger_start: float | None = None, min_wallets: int = MIN_WALLETS, device: str = "auto", seed: int = 0,
          now: datetime | None = None, spec_path: Path | None = None, gate_file: Path | None = None, retest: bool = False) -> Path | None:
    """Builds the dataset, trains, writes PRIVATE models/<version>/; None (no bundle) when the data is below the minimum.
    copies = the first-buy outcomes (the target), ledger = every resolved ledger row (own_record_shrunk; default copies),
    ledger_start = where the ledger's coverage starts (data.copies; default its earliest buy),
    gate_file = where the pre-registered test's looks are kept (default PRIVATE_DIR/social_gate.json)."""
    spec_version, spec = load_spec(spec_path) if spec_path else load_spec()
    names = feature_names(spec)
    ledger = copies if ledger is None else ledger
    tables.ledger = ledger[["leader", "y", "resolved_at"]]
    ix = build_index(tables)
    tg = targets(copies)
    data_end = float(np.nanmax(ledger.resolved_at.to_numpy(float))) if len(ledger) else float("nan")
    if ledger_start is None:
        ledger_start = float(np.nanmin(ledger.buy_ts.to_numpy(float))) if len(ledger) else float("nan")
    asofs = asof_grid(tables.links, data_end, ledger_start)
    rows = labelled(ix, tg, asofs)
    n_wallets = rows.wallet.nunique() if len(rows) else 0
    if n_wallets < min_wallets:
        covered = (data_end - ledger_start) / DAY if np.isfinite(data_end) and np.isfinite(ledger_start) else 0.0
        log(f"too little data: {n_wallets} owner-linked wallets with a matured 14-day target (need {min_wallets}); "
            f"the ledger covers {covered:.1f} d (labels need {(OWN_LEAD + MATURE) / DAY:.1f}); no bundle written.")
        return None

    gate_file = gate_file or config.PRIVATE_DIR / GATE_FILE
    looks = read_looks(gate_file)
    carried = recorded_gate(looks, spec_version, source) if looks else None
    testing = not looks or (retest and not carried["passed"])
    days = sorted(rows.t.unique().tolist())
    split = retest_split(days, looks[-1]["validation"]["last_day"]) if looks and testing else None
    if looks and testing and split is None:
        log("no days for a retest yet (they must start 14 d after the last look's validation days); keeping the recorded verdict.")
        testing = False
    train_days, val_days, embargoed = split or split_days(days)
    pop_mean = float(copies.y[copies.buy_ts < val_days[0]].mean())
    if not np.isfinite(pop_mean):
        pop_mean = float(copies.y.mean())
    xs, n_posts = with_inputs(ix, spec, rows, pop_mean)
    tr = rows.t.isin(train_days).to_numpy()
    va = rows.t.isin(val_days).to_numpy()
    fill = fill_values(spec, [x for x, m in zip(xs, tr) if m])
    X = np.array([vector(spec, x, fill) for x in xs], dtype=np.float64)
    mean = X[tr].mean(0)
    std = X[tr].std(0)
    std = np.where(std < 1e-6, 1.0, std)
    Z = ((X - mean) / std).astype(np.float32)
    y = rows.y.to_numpy(float)
    w = (rows.n / (rows.n + SHRINK_N)).to_numpy(float)

    net = fit(Z[tr], y[tr] - pop_mean, w[tr], rows.t.to_numpy()[tr], pick_device(device), seed)
    pred = predict(net, Z) + pop_mean
    own = X[:, names.index("own_record_shrunk")]
    check = gate(pred[va], y[va], own[va], rows.wallet.to_numpy()[va], embargoed, MIN_WALLETS, seed=seed,
                 alpha=ALPHA / (len(looks) + 1) if testing else ALPHA, server_ledger=source == SERVER_LEDGER)
    look = testing and check["valid"]  # this run takes the (next) look
    g = check if look or not looks else carried
    rmse = lambda m: float(np.sqrt(np.average((pred[m] - y[m]) ** 2, weights=w[m])))  # noqa: E731
    base = lambda m: float(np.sqrt(np.average((pop_mean - y[m]) ** 2, weights=w[m])))  # noqa: E731

    now = now or datetime.now(timezone.utc)
    version = now.strftime("%Y-%m-%dT%H-%M-%SZ")
    out_root.mkdir(parents=True, exist_ok=True)
    tmp = out_root / f".{version}.tmp"
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir()
    export_onnx(net, pop_mean, len(names), tmp / MODEL_FILE)
    check_onnx(tmp / MODEL_FILE, Z[:256], pred[:256])
    manifest = {
        "version": version,
        "kind": "social",
        "created_at": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "feature_spec_version": spec_version,
        "features": names,
        "norm": {"mean": mean.tolist(), "std": std.tolist()},
        "fill": [fill[s.name] for s in spec],
        "file": MODEL_FILE,
        "input": "x",
        "output": "y",
        "pop_mean": pop_mean,
        "shrink_n": SHRINK_N,
        "gate": g,
        "metrics": {
            "target_source": source,
            "validation_check": None if g is check else check,  # this run's numbers when it is not the test: information only
            "rows": {"train": int(tr.sum()), "validation": int(va.sum())},
            "wallets": {"labelled": int(n_wallets), "train": int(rows.wallet[tr].nunique()), "validation": int(rows.wallet[va].nunique())},
            "days": {"train": len(train_days), "validation": len(val_days), "embargoed": embargoed},
            "rmse": {"train": rmse(tr), "validation": rmse(va) if va.any() else None,
                     "validation_pop_mean": base(va) if va.any() else None},
            "n_posts_median": float(np.median(n_posts)),
        },
        "sha256": {MODEL_FILE: sha256(tmp / MODEL_FILE)},
    }
    if look:
        looks.append({"at": manifest["created_at"], "version": version, "model_sha256": manifest["sha256"][MODEL_FILE], "seed": seed,
                      "source": source, "feature_spec_version": spec_version,
                      "validation": {"first_day": val_days[0], "last_day": val_days[-1], "days": len(val_days)}, "result": g})
        write_looks(gate_file, looks)
        manifest["gate"] = g | {"preregistered": True, "looks": len(looks)}
    (tmp / "manifest.json").write_text(json.dumps(manifest, indent=2))
    final = out_root / version
    if final.exists():
        shutil.rmtree(final)
    tmp.rename(final)
    verdict = (f"pre-registered test (look {len(looks)}) {'passed' if g['passed'] else 'failed'}" if look
               else f"not tested ({check['reason']})" if not looks
               else f"recorded verdict: {'passed' if g['passed'] else 'failed'}" + (f" ({g['reason']})" if g["reason"] else ""))
    log(f"bundle {version}: {int(tr.sum())} train / {int(va.sum())} validation rows, {n_wallets} wallets; gate {verdict}.")
    return final


def check_onnx(path: Path, z: np.ndarray, expect: np.ndarray) -> None:
    """The exported net gives PyTorch's numbers (onnxruntime, CPU)."""
    import onnxruntime as ort

    s = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
    got = s.run(["y"], {"x": z.astype(np.float32)})[0][:, 0]
    if not np.allclose(got, expect, atol=1e-4):
        raise RuntimeError(f"social.onnx differs from PyTorch by {np.abs(got - expect).max():.2e}")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", type=Path, default=config.PRIVATE_DIR / "models", help="bundles go to <out>/<version>/")
    ap.add_argument("--device", default="auto", help="auto (Apple GPU when available), cpu or mps")
    ap.add_argument("--seed", type=int, default=0, help="training seed (never changes a recorded gate verdict)")
    ap.add_argument("--retest", action="store_true",
                    help="after a failed pre-registered test: look once more, on new days only, Bonferroni-corrected")
    args = ap.parse_args(argv)
    t0 = time.time()
    tables = sdata.load_social()
    if tables.links.empty:
        log("no wallet <-> X account links yet (the private social tables are empty or not pulled: python -m brain.social.pull); "
            "no bundle written.")
        return 0
    copies, ledger, source, start = sdata.copies()
    if copies.empty:
        log("no copy outcomes (neither the mirror ledger nor the research reference label); no bundle written.")
        return 0
    from brain.data import connect

    con = connect(derived=False)
    try:
        copies = sdata.drop_pruned_firsts(con, copies, start)
        pairs = tables.posts.explode("mints").dropna(subset=["mints"])
        pairs = pairs.merge(tables.links[["wallet", "author_id"]], on="author_id")[["wallet", "mints"]].rename(columns={"mints": "mint"})
        tables.first_buys = sdata.first_buys(con, pairs)
        tables.funders = sdata.funders(con)
    finally:
        con.close()
    log(f"{tables.links.wallet.nunique()} linked wallets, {len(tables.posts)} posts, {len(copies)} copy outcomes ({source}).")
    out = train(tables, copies, args.out, ledger=ledger, source=source, ledger_start=start, device=args.device, seed=args.seed,
                retest=args.retest)
    log(f"done in {time.time() - t0:.0f} s" + (f": {out}" if out else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
