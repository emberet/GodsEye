"""
The time splits from brain/spec/splits.yaml (the single definition; nothing else hard-codes the dates):

    from brain.data import splits
    splits.period_of(ts)                      # 'fit' | 'embargo' | 'selection' | 'test' | None (before data_start)
    con.sql(f"SELECT * FROM episodes WHERE {splits.period_sql('ts')} = 'selection'")
    for f in splits.folds(): ...              # rolling-origin folds: train [data_start, train_to), valid [valid_from, valid_to)

`mode: rolling` (the default since 2026-11-13) moves the periods with the data: they are counted back from the anchor,
the UTC day of the data build's label end (derived/_meta.json label_end_ts: where complete labels stop). Test is the
last `test_days` before the anchor, selection the `selection_days` before that, then the embargo, and fit is everything
from data_start up to it. Each rebuild of derived/ therefore trains on everything older and keeps a fresh, unseen
slice as the test. With no build to anchor on (a fresh data dir, the tests), or one too short to leave a fit period,
the fixed `periods` / `folds` apply.
BRAIN_SPLITS_ANCHOR=YYYY-MM-DD pins the anchor. Derive passes the anchor of the build it is writing, so the `period`
column it stores and these functions always agree.

episodes.parquet carries the result as the `period` column (derive writes it with period_sql).
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass
from datetime import datetime
from functools import lru_cache
from pathlib import Path

import pandas as pd
import yaml

SPEC = Path(__file__).resolve().parents[2] / "spec" / "splits.yaml"


@dataclass(frozen=True)
class Period:
    name: str
    start: pd.Timestamp
    end: pd.Timestamp | None  # None = open-ended


@dataclass(frozen=True)
class Fold:
    name: str
    train_from: pd.Timestamp
    train_to: pd.Timestamp
    valid_from: pd.Timestamp
    valid_to: pd.Timestamp


def ts(s) -> pd.Timestamp | None:
    return None if s is None else pd.Timestamp(s).tz_convert("UTC")


@lru_cache(maxsize=4)
def load(path: Path = SPEC) -> dict:
    return yaml.safe_load(Path(path).read_text())


def _meta_path() -> Path:
    from brain.data.loaders import derived_dir  # late: loaders imports nothing from here, but keep the import light

    return derived_dir() / "_meta.json"


@lru_cache(maxsize=8)
def _anchor_from(meta: str, mtime: float) -> pd.Timestamp | None:
    try:
        end = json.loads(Path(meta).read_text()).get("label_end_ts")
    except (OSError, ValueError):
        return None
    return pd.Timestamp(end).tz_convert("UTC").floor("D") if end else None


def current_anchor() -> pd.Timestamp | None:
    """BRAIN_SPLITS_ANCHOR, else the UTC day of the current build's label end, else None."""
    pinned = os.environ.get("BRAIN_SPLITS_ANCHOR", "").strip()
    if pinned:
        return pd.Timestamp(pinned, tz="UTC").floor("D")
    try:
        meta = _meta_path()
        return _anchor_from(str(meta), meta.stat().st_mtime) if meta.is_file() else None
    except OSError:
        return None


def _anchor(anchor, path: Path) -> pd.Timestamp | None:
    """
    The anchor in use: the one given, else the current one; None in fixed mode, without one, or when it would leave no
    fit period at all (data that ends before data_start + test + selection + embargo, e.g. a test's synthetic swaps).
    """
    if load(path).get("mode") != "rolling":
        return None
    if anchor is not None:
        t = pd.Timestamp(anchor)
        a = (t.tz_convert("UTC") if t.tzinfo else t.tz_localize("UTC")).floor("D")
    else:
        a = current_anchor()
    if a is None:
        return None
    r = load(path)["rolling"]
    fit_end = a - pd.Timedelta(days=r["test_days"] + r["selection_days"]) - pd.Timedelta(hours=load(path)["embargo_hours"])
    return a if fit_end > data_start(path) else None


def periods(path: Path = SPEC, anchor=None) -> list[Period]:
    a = _anchor(anchor, path)
    if a is None:
        return [Period(p["name"], ts(p["from"]), ts(p["to"])) for p in load(path)["periods"]]
    r = load(path)["rolling"]
    test = a - pd.Timedelta(days=r["test_days"])
    sel = test - pd.Timedelta(days=r["selection_days"])
    emb = sel - pd.Timedelta(hours=load(path)["embargo_hours"])
    return [Period("fit", data_start(path), emb), Period("embargo", emb, sel), Period("selection", sel, test), Period("test", test, None)]


def period(name: str, path: Path = SPEC, anchor=None) -> Period:
    for p in periods(path, anchor):
        if p.name == name:
            return p
    raise KeyError(name)


def test_start(path: Path = SPEC, anchor=None) -> pd.Timestamp:
    return period("test", path, anchor).start


def data_start(path: Path = SPEC) -> pd.Timestamp:
    return ts(load(path)["data_start"])


def folds(path: Path = SPEC, anchor=None) -> list[Fold]:
    d0 = data_start(path)
    a = _anchor(anchor, path)
    if a is None:
        return [Fold(f["name"], d0, ts(f["train_to"]), ts(f["valid_from"]), ts(f["valid_to"])) for f in load(path)["folds"]]
    # Walking back from fit -> selection: train up to train_to, the embargo, then validate on the next fold_days.
    r = load(path)["rolling"]
    avoid = {pd.Timestamp(d, tz="UTC") for d in r.get("avoid_valid_days", [])}
    emb = pd.Timedelta(hours=load(path)["embargo_hours"])
    step = pd.Timedelta(days=r["fold_days"])
    sel = period("selection", path, a)
    out: list[tuple] = [(period("fit", path, a).end, sel.start, sel.end)]
    valid_to = sel.start
    while len(out) < r["n_folds"]:
        valid_from = valid_to - step
        train_to = valid_from - emb
        if train_to - d0 < step:  # too little left to train on
            break
        days = set(pd.date_range(valid_from, valid_to - pd.Timedelta(seconds=1), freq="D"))
        if days & avoid:
            valid_to -= pd.Timedelta(days=1)  # slide past the avoided day
            continue
        out.append((train_to, valid_from, valid_to))
        valid_to = valid_from
    out.reverse()
    return [Fold(f"f{i + 1}", d0, t, v0, v1) for i, (t, v0, v1) in enumerate(out)]


def period_of(t: datetime | pd.Timestamp | str, path: Path = SPEC, anchor=None) -> str | None:
    t = pd.Timestamp(t)
    t = t.tz_localize("UTC") if t.tzinfo is None else t.tz_convert("UTC")
    for p in periods(path, anchor):
        if p.start <= t and (p.end is None or t < p.end):
            return p.name
    return None


def period_sql(col: str = "ts", path: Path = SPEC, anchor=None) -> str:
    """A SQL CASE mapping a TIMESTAMPTZ column to its period name (NULL before data_start)."""
    parts = []
    for p in periods(path, anchor):
        cond = f"{col} >= TIMESTAMPTZ '{p.start.isoformat()}'"
        if p.end is not None:
            cond += f" AND {col} < TIMESTAMPTZ '{p.end.isoformat()}'"
        parts.append(f"WHEN {cond} THEN '{p.name}'")
    return f"(CASE {' '.join(parts)} END)"


def describe(path: Path = SPEC, anchor=None) -> dict:
    """The periods in use, for a report or a build's meta: {name: [from, to]} and the anchor."""
    a = _anchor(anchor, path)
    return {"mode": load(path).get("mode", "fixed"), "anchor": str(a) if a is not None else None,
            "periods": {p.name: [str(p.start), str(p.end) if p.end is not None else None] for p in periods(path, anchor)}}
