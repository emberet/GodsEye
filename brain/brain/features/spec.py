"""
brain/spec/features.yaml as code: the entry and exit feature lists, their transforms, missing-value rules and the
model's column layout, plus the one encoder both heads use (raw values -> transformed -> normalised).

    from brain.features import spec
    feats = spec.entry_features()                        # [Feature(...), ...] in spec order
    cols = spec.columns(feats, categories)               # cp_lrshr_7d, ..., venue_group=pumpswap, ..., log_fee_missing
    X = spec.encode(raw_frame, feats, categories)        # transformed, NaN where a train_mean default is still to fill
    norm = spec.fit_norm(X, cols)                        # from FIT training rows only
    Z = spec.normalise(X, norm)                          # what the network sees (missing -> 0)

Raw values follow the spec definitions; a missing value is NaN (None for the categorical). The rules
(features.yaml conventions.missing_values / transforms / vector_layout):
  - missing with missing_flag: `<name>_missing` = 1;
  - missing with a numeric default: the raw value becomes the default, then the transform;
  - missing with default train_mean: the transformed value becomes the column's training mean (normalised 0);
  - onehot and _missing columns keep mean 0, std 1 (left as 0/1); every other column is (x - mean) / std.
agent/src/brain/features.ts implements the same; spec/golden/ pins both.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import numpy as np
import pandas as pd
import yaml

SPEC_PATH = Path(__file__).resolve().parents[2] / "spec" / "features.yaml"
STD_FLOOR = 1e-6  # a column whose fit std is below this is constant there: its std becomes 1 (CONSTANT_STD)
CONSTANT_STD = 1.0
MIN_LEVEL_SHARE = 0.001  # a categorical level needs this share of the fit training rows, else it is `other`
OTHER = "other"


@dataclass(frozen=True)
class Feature:
    name: str
    head: str
    transform: str
    missing_flag: bool
    default: float | str  # a raw value, "train_mean", or (onehot) the level used when missing

    @property
    def onehot(self) -> bool:
        return self.transform == "onehot"


@lru_cache(maxsize=4)
def load(path: Path = SPEC_PATH) -> dict:
    return yaml.safe_load(Path(path).read_text())


def version(path: Path = SPEC_PATH) -> int:
    return int(load(path)["version"])


def _features(head: str, path: Path) -> list[Feature]:
    out = []
    for f in load(path)[head]:
        d = f.get("default", 0.0)
        out.append(Feature(f["name"], head, str(f.get("transform", "none")), bool(f.get("missing_flag", False)),
                           d if isinstance(d, str) else float(d)))
    return out


def entry_features(path: Path = SPEC_PATH) -> list[Feature]:
    return _features("entry", path)


def exit_features(path: Path = SPEC_PATH) -> list[Feature]:
    return _features("exit", path)


def venue_groups(path: Path = SPEC_PATH) -> list[dict]:
    """venue_group's mapping rules, in order (first match wins)."""
    for f in load(path)["entry"]:
        if f["name"] == "venue_group":
            return f["venue_groups"]
    raise KeyError("venue_group")


def gates(path: Path = SPEC_PATH) -> list[str]:
    return [g["name"] for g in load(path)["gates"]]


# ---------------------------------------------------------------------------------------------------------------------
# Column layout


def columns(feats: list[Feature], categories: dict[str, list[str]] | None = None) -> list[str]:
    """The model's input columns: spec order, a onehot feature as `<name>=<level>`, `<name>_missing` after flagged ones."""
    out: list[str] = []
    for f in feats:
        if f.onehot:
            out += [f"{f.name}={lv}" for lv in (categories or {})[f.name]]
        else:
            out.append(f.name)
        if f.missing_flag:
            out.append(f"{f.name}_missing")
    return out


def binary_columns(feats: list[Feature], categories: dict[str, list[str]] | None = None) -> set[str]:
    """Columns left as 0/1 by the normalisation (mean 0, std 1): onehot levels and _missing flags."""
    out = set()
    for f in feats:
        if f.onehot:
            out |= {f"{f.name}={lv}" for lv in (categories or {})[f.name]}
        if f.missing_flag:
            out.add(f"{f.name}_missing")
    return out


# ---------------------------------------------------------------------------------------------------------------------
# Transforms


def transform(kind: str, x):
    """features.yaml conventions.transforms on a float or an array (NaN stays NaN)."""
    x = np.asarray(x, dtype=np.float64)
    if kind in ("none", "share"):
        y = x
    elif kind == "log1p":
        y = np.log1p(np.maximum(x, 0.0))
    elif kind == "log10":
        y = np.log10(np.maximum(x, 1.0))
    elif kind == "signed_log":
        y = np.sign(x) * np.log1p(np.abs(x))
    elif kind.startswith("clip:"):
        lo, hi = (float(v) for v in kind[5:].split(","))
        y = np.clip(x, lo, hi)
    else:
        raise ValueError(f"unknown transform {kind}")
    return y if y.ndim else float(y)


def _level(v, levels: list[str], default: str) -> str:
    v = default if v is None or v is pd.NA or (isinstance(v, float) and math.isnan(v)) else str(v)
    return v if v in levels else OTHER


def encode(raw: pd.DataFrame | dict, feats: list[Feature], categories: dict[str, list[str]] | None = None) -> np.ndarray:
    """
    Raw values (a frame with one column per feature, or one case as a dict) -> the transformed matrix [n, columns],
    NaN where a train_mean default is still to be filled (normalise does it).
    """
    if isinstance(raw, dict):
        raw = pd.DataFrame([raw])
    n = len(raw)
    cols: list[np.ndarray] = []
    for f in feats:
        if f.onehot:
            levels = (categories or {})[f.name]
            v = raw[f.name].to_numpy(dtype=object) if f.name in raw else np.full(n, None, dtype=object)
            lv = np.array([_level(x, levels, str(f.default)) for x in v], dtype=object)
            for level in levels:
                cols.append((lv == level).astype(np.float64))
            if f.missing_flag:
                cols.append(np.array([x is None or x is pd.NA or (isinstance(x, float) and math.isnan(x)) for x in v], dtype=np.float64))
            continue
        x = pd.to_numeric(raw[f.name], errors="coerce").to_numpy(dtype=np.float64) if f.name in raw else np.full(n, np.nan)
        miss = ~np.isfinite(x)
        if f.default != "train_mean":
            x = np.where(miss, float(f.default), x)
        cols.append(np.where(miss & (f.default == "train_mean"), np.nan, transform(f.transform, x)))
        if f.missing_flag:
            cols.append(miss.astype(np.float64))
    return np.column_stack(cols) if cols else np.zeros((n, 0))


# ---------------------------------------------------------------------------------------------------------------------
# Normalisation


@dataclass
class Norm:
    columns: list[str]
    mean: np.ndarray
    std: np.ndarray

    def to_json(self) -> dict:
        return {"columns": self.columns, "mean": [float(v) for v in self.mean], "std": [float(v) for v in self.std]}

    @classmethod
    def from_json(cls, d: dict) -> "Norm":
        return cls(list(d["columns"]), np.asarray(d["mean"], dtype=np.float64), np.asarray(d["std"], dtype=np.float64))


class NormAccumulator:
    """Running sums for fit_norm over chunks (a full feature build never holds all fit rows at once)."""

    def __init__(self, cols: list[str], binary: set[str]):
        self.columns = cols
        self.binary = np.array([c in binary for c in cols])
        self.n = np.zeros(len(cols))
        self.s = np.zeros(len(cols))
        self.ss = np.zeros(len(cols))
        self.shift: np.ndarray | None = None  # the first chunk's means: sums of squares around them stay accurate

    def add(self, X: np.ndarray) -> None:
        if not len(X):
            return
        ok = np.isfinite(X)
        if self.shift is None:
            cnt = ok.sum(0)
            self.shift = np.where(cnt > 0, np.where(ok, X, 0.0).sum(0) / np.maximum(cnt, 1), 0.0)
        d = np.where(ok, X - self.shift, 0.0)
        self.n += ok.sum(0)
        self.s += d.sum(0)
        self.ss += (d * d).sum(0)

    def norm(self) -> Norm:
        shift = self.shift if self.shift is not None else np.zeros(len(self.columns))
        n = np.maximum(self.n, 1)
        m = self.s / n
        var = np.maximum(self.ss / n - m * m, 0.0)
        mean = np.where(self.n > 0, shift + m, 0.0)
        std = np.sqrt(var)
        std = np.where(std < STD_FLOOR, CONSTANT_STD, std)  # constant in training (social_* before X data): a later value
        # moves the input by its raw difference instead of by a million standard deviations
        mean = np.where(self.binary, 0.0, mean)
        std = np.where(self.binary, 1.0, std)
        return Norm(list(self.columns), mean, std)


def fit_norm(X: np.ndarray, cols: list[str], binary: set[str] | None = None) -> Norm:
    """Mean / std of each transformed column over the rows where it is present (FIT training rows only)."""
    acc = NormAccumulator(cols, binary if binary is not None else {c for c in cols if c.endswith("_missing") or "=" in c})
    acc.add(np.asarray(X, dtype=np.float64))
    return acc.norm()


def normalise(X: np.ndarray, norm: Norm) -> np.ndarray:
    """(x - mean) / std per column; a train_mean-missing value (NaN) becomes 0."""
    Z = (np.asarray(X, dtype=np.float64) - norm.mean) / norm.std
    return np.where(np.isfinite(Z), Z, 0.0)


def fit_levels(counts: dict[str, int], min_share: float = MIN_LEVEL_SHARE) -> list[str]:
    """
    A categorical's levels from its counts over FIT training rows: those with >= min_share of the rows, most frequent
    first (ties by name), then `other` (which also takes every unseen level).
    """
    items = sorted(((str(k), int(v)) for k, v in counts.items() if k is not None), key=lambda kv: (-kv[1], kv[0]))
    total = sum(v for _, v in items)
    return [k for k, v in items if k != OTHER and v >= min_share * total] + [OTHER]
