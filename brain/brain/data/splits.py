"""
The time splits from brain/spec/splits.yaml (the single definition; nothing else hard-codes the dates):

    from brain.data import splits
    splits.period_of(ts)                      # 'fit' | 'embargo' | 'selection' | 'test' | None (before data_start)
    con.sql(f"SELECT * FROM episodes WHERE {splits.period_sql('ts')} = 'selection'")
    for f in splits.folds(): ...              # rolling-origin folds: train [data_start, train_to), valid [valid_from, valid_to)

episodes.parquet carries the result as the `period` column (derive writes it with period_sql).
"""
from __future__ import annotations

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


def periods(path: Path = SPEC) -> list[Period]:
    return [Period(p["name"], ts(p["from"]), ts(p["to"])) for p in load(path)["periods"]]


def period(name: str, path: Path = SPEC) -> Period:
    for p in periods(path):
        if p.name == name:
            return p
    raise KeyError(name)


def test_start(path: Path = SPEC) -> pd.Timestamp:
    return period("test", path).start


def data_start(path: Path = SPEC) -> pd.Timestamp:
    return ts(load(path)["data_start"])


def folds(path: Path = SPEC) -> list[Fold]:
    d0 = data_start(path)
    return [Fold(f["name"], d0, ts(f["train_to"]), ts(f["valid_from"]), ts(f["valid_to"])) for f in load(path)["folds"]]


def period_of(t: datetime | pd.Timestamp | str, path: Path = SPEC) -> str | None:
    t = pd.Timestamp(t)
    t = t.tz_localize("UTC") if t.tzinfo is None else t.tz_convert("UTC")
    for p in periods(path):
        if p.start <= t and (p.end is None or t < p.end):
            return p.name
    return None


def period_sql(col: str = "ts", path: Path = SPEC) -> str:
    """A SQL CASE mapping a TIMESTAMPTZ column to its period name (NULL before data_start)."""
    parts = []
    for p in periods(path):
        cond = f"{col} >= TIMESTAMPTZ '{p.start.isoformat()}'"
        if p.end is not None:
            cond += f" AND {col} < TIMESTAMPTZ '{p.end.isoformat()}'"
        parts.append(f"WHEN {cond} THEN '{p.name}'")
    return f"(CASE {' '.join(parts)} END)"
