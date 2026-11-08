"""
Real data for the policy: day windows of the simulator with their entry features (derived/features_entry), joined by
episode_id, and the folds of brain/spec/splits.yaml in days.

    days = usable_days("fit", con)                        # days with known_at_t, outage-free signals (and their counts)
    w = day_window(day, n_day, per_day, con, chaos, seed) # a day's signals, subsampled by a hash of episode_id
    ei = entry_inputs(w, meta)                             # normalised entry matrix aligned with w.data.sig, gates, ps_r_7d

Subsampling keys on hash(episode_id), so the same signals come back on every pass (and the tape cache is reused).
Every input is a features.yaml column computed point in time by the feature build (insert-time rule); the one column the
build fixes offline, signal_lateness_sec (always 1 s), is replaced by the simulator's own drawn lateness, as live.
"""
from __future__ import annotations

from dataclasses import dataclass

import duckdb
import numpy as np
import pandas as pd

from brain.data import splits
from brain.data.loaders import configure, data_dir, derived_dir, sql_str
from brain.features import build, spec

FEATURES_DIR = "features_entry"


def usable_days(period: str, con, min_signals: int = 200) -> pd.DataFrame:
    """Days of a splits.yaml period with copy-eligible, known_at_t, outage-free signals: day, n."""
    p = splits.period(period)
    end = p.end if p.end is not None else pd.Timestamp("2100-01-01", tz="UTC")
    df = con.execute(f"""SELECT day, count(*) AS n FROM episodes WHERE ts >= TIMESTAMPTZ '{p.start.isoformat()}'
                         AND ts < TIMESTAMPTZ '{end.isoformat()}' AND leader_sol >= 0.2 AND known_at_t AND NOT crosses_outage
                         GROUP BY 1 ORDER BY 1""").df()
    df["day"] = df["day"].astype(str)
    return df[df["n"] >= min_signals].reset_index(drop=True)


def sample_where(n_day: int, per_day: int | None) -> str:
    """A SQL filter keeping about per_day of the day's n_day signals (hash of episode_id; '' keeps all)."""
    if not per_day or per_day >= n_day:
        return ""
    k = max(1, int(round(10_000 * per_day / n_day)))
    return f"hash(episode_id) % 10000 < {k}"


def share_where(share: float) -> str:
    """A SQL filter keeping `share` of the signals by a hash of episode_id ('' = all)."""
    return "" if share >= 1 else f"hash(episode_id) % 10000 < {max(1, int(round(10_000 * share)))}"


def day_window(day: str, n_day: int, per_day: int | None, con, chaos=None, seed: int = 0, params=None, days: int = 1):
    from brain.sim.evaluate import load_window
    from brain.sim.params import Chaos
    start = pd.Timestamp(day, tz="UTC")
    return load_window(start, start + pd.Timedelta(days=days), con=con, chaos=chaos or Chaos(), seed=seed, params=params,
                       where=sample_where(n_day, per_day))


def feature_con() -> duckdb.DuckDBPyConnection:
    con = duckdb.connect()
    configure(con, temp_dir=data_dir() / "tmp" / "duckdb_policy")
    return con


def features_for(sig: pd.DataFrame, con: duckdb.DuckDBPyConnection | None = None, root=None) -> pd.DataFrame:
    """features_entry rows (raw values) for the signals, in sig's order; a signal without a row gets NaN everywhere."""
    own = con is None
    con = con or feature_con()
    try:
        ids = pd.DataFrame({"episode_id": sig["episode_id"].to_numpy(np.int64), "_i": np.arange(len(sig))})
        con.register("_ids", ids)
        days = sorted(set(sig["day"].astype(str)))
        g = sql_str(str(derived_dir(root) / FEATURES_DIR / "*" / "[!.]*.parquet"))
        cols = ", ".join(["f.episode_id", "f.gate"] + [f"f.{c}" for c in build.FEATURE_COLUMNS])
        dl = ", ".join(sql_str(d) for d in days)
        df = con.execute(f"""SELECT i._i, {cols} FROM read_parquet({g}, hive_partitioning=true) f JOIN _ids i USING (episode_id)
                             WHERE CAST(f.day AS VARCHAR) IN ({dl})""").df()
        con.unregister("_ids")
    finally:
        if own:
            con.close()
    out = df.set_index("_i").reindex(np.arange(len(sig)))
    out["episode_id"] = sig["episode_id"].to_numpy(np.int64)
    out["has_features"] = np.isin(np.arange(len(sig)), df["_i"].to_numpy())
    return out.reset_index(drop=True)


@dataclass
class EntryInputs:
    Z: np.ndarray          # [n, columns] normalised (float32), aligned with window.data.sig rows
    gated: np.ndarray      # a features.yaml gate fired (the simulator's gates, or the feature build's), or no features
    ps_r: np.ndarray       # raw ps_r_7d (the exit head's leader_ps_r_7d)
    raw: pd.DataFrame | None = None

    def subset(self, rows) -> "EntryInputs":
        return EntryInputs(self.Z[rows], self.gated[rows], self.ps_r[rows], None if self.raw is None else self.raw.iloc[rows].reset_index(drop=True))


def entry_inputs(window, meta: dict | None = None, con=None, keep_raw: bool = False) -> EntryInputs:
    meta = meta or build.load_meta()
    sig = window.data.sig
    raw = features_for(sig, con)
    if "lateness_s" in sig:  # features.yaml: the simulator overwrites the offline 1 s with its drawn lateness
        raw["signal_lateness_sec"] = sig["lateness_s"].to_numpy(np.float64)
    X = spec.encode(raw, spec.entry_features(), meta["categories"])
    Z = spec.normalise(X, spec.Norm.from_json(meta["norm"])).astype(np.float32)
    sim_gate = sig["gate"].to_numpy() != "" if "gate" in sig else np.zeros(len(sig), bool)
    feat_gate = raw["gate"].notna().to_numpy() | ~raw["has_features"].to_numpy(bool)
    return EntryInputs(Z, sim_gate | feat_gate, pd.to_numeric(raw["ps_r_7d"], errors="coerce").to_numpy(np.float64),
                       raw if keep_raw else None)


def fold_days(days: list[str]) -> list[tuple[list[str], list[str]]]:
    """splits.yaml folds inside fit, as (train days, validation days) among `days` (the fit -> selection fold is the gate's)."""
    sel = splits.period("selection").start
    out = []
    for f in splits.folds():
        if f.valid_from >= sel:
            continue
        tr = [d for d in days if pd.Timestamp(d, tz="UTC") < f.train_to]
        va = [d for d in days if f.valid_from <= pd.Timestamp(d, tz="UTC") < f.valid_to]
        if tr and va:
            out.append((tr, va))
    return out
