"""
The quote/mark model: what a Jupiter sell quote is worth relative to the last ok tracked price, by how old that price is.
Fit on PRE-TEST shadow quotes only (sim.yaml never: no calibration table on quotes sampled on/after the test start).

Three curves over the tracked-price age, each a monotone (non-increasing) step table interpolated in log-age:

  obs_ratio(age, venue, tape)  what the exit policy SEES for a stale coin: mean quote / last price over quotes WITH a route,
                               alive and dead coins together, by venue group and tape state (ok tracked prints in the last
                               10 min). Only what is known at t: never conditioned on future darkness.
  m_alive(age)                 the environment's sell value of a coin whose tape is alive later (hindsight, environment only)
  f_dark(age)                  ... of a coin whose tape is dead for the next 6 h (no-route quotes count as 0); below
                               sim.yaml no_route_below the quote has no route

Source: GodsEyeBrainData/research/sim-fidelity/shadow_rug_samples.parquet (brain/research/sim-fidelity/shadow_rug.py:
the shadow_samples quotes joined to the ok-filtered tape: close_ok = Q x last ok price at/before the quote, age_ok_s,
n_tape_10min, tape_dead = no tracked swap after it). Fitted tables are saved to <DATA>/sim/quote_model.json.

    qm = QuoteModel.load()      # fit once (QuoteModel.fit(...).save()) or the sim.yaml m_age_table fallback
    qm.obs_ratio(age_s, venue_group, n10)
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd

from brain.data import splits
from brain.data.loaders import data_dir

AGE_EDGES = np.array([0.0, 10.0, 60.0, 90.0, 300.0, 1800.0, 21600.0, 86400.0 * 7])  # seconds; last bin is open
VENUES = ("pumpswap", "pumpfun", "other")
TAPES = ("none", "thin", "busy")  # ok tracked prints in the last 10 min: 0 / 1-9 / >= 10
PRIOR_N = 20.0  # shrinkage weight toward the parent cell (age bin pooled over venue / tape)
SOURCE = Path("research") / "sim-fidelity" / "shadow_rug_samples.parquet"
SAVED = Path("sim") / "quote_model.json"

# sim.yaml m_age_table (train sellable samples) and a pre-test f_dark: the fallback when no fit is saved
FALLBACK_ALIVE = [0.996, 1.002, 0.987, 0.987, 0.960, 0.880, 0.780]
FALLBACK_DARK = [0.998, 0.56, 0.36, 0.17, 0.075, 0.075, 0.068]


def venue_group(venue) -> np.ndarray:
    """pumpswap / pumpfun (bonding curve) / other, from the swap venue with ' (via bot)' stripped."""
    v = pd.Series(np.asarray(venue, dtype=object)).fillna("").astype(str).str.replace(" (via bot)", "", regex=False).str.lower()
    return np.select([v.str.startswith("pumpswap"), v.str.startswith("pumpfun") | v.str.startswith("pump.fun")], [0, 1], 2).astype(np.int8)


def tape_group(n10) -> np.ndarray:
    n = np.asarray(n10, dtype=np.float64)
    return np.where(n >= 10, 2, np.where(n >= 1, 1, 0)).astype(np.int8)


def age_bin(age_s) -> np.ndarray:
    return np.clip(np.searchsorted(AGE_EDGES, np.asarray(age_s, dtype=np.float64), side="right") - 1, 0, len(AGE_EDGES) - 2)


def _knots() -> np.ndarray:
    """log10 of each bin's representative age (geometric mid; the first bin at 3 s, the open last bin at 2 d)."""
    mids = np.sqrt(np.maximum(AGE_EDGES[:-1], 3.0) * AGE_EDGES[1:])
    mids[0] = 3.0
    return np.log10(mids)


def monotone_down(y: np.ndarray, w: np.ndarray | None = None) -> np.ndarray:
    """Weighted isotonic (non-increasing) fit by pool-adjacent-violators."""
    y = np.asarray(y, dtype=np.float64)
    w = np.ones_like(y) if w is None else np.asarray(w, dtype=np.float64)
    blocks: list[list[float]] = []  # [value, weight, count]
    for v, ww in zip(y, w):
        blocks.append([v, ww, 1])
        while len(blocks) > 1 and blocks[-2][0] < blocks[-1][0]:
            v2, w2, c2 = blocks.pop()
            v1, w1, c1 = blocks.pop()
            tw = w1 + w2
            blocks.append([(v1 * w1 + v2 * w2) / tw if tw > 0 else (v1 + v2) / 2, tw, c1 + c2])
    return np.concatenate([[b[0]] * b[2] for b in blocks])


@dataclass
class QuoteModel:
    alive: np.ndarray                 # [n_bins]
    dark: np.ndarray                  # [n_bins]
    obs: np.ndarray                   # [n_venues, n_tapes, n_bins]
    meta: dict

    # ------------------------------------------------------------------------------------------------ evaluation
    def _interp(self, table: np.ndarray, age_s) -> np.ndarray:
        x = np.log10(np.maximum(np.asarray(age_s, dtype=np.float64), 1.0))
        return np.interp(x, _knots(), table)

    def m_alive(self, age_s) -> np.ndarray:
        return self._interp(self.alive, age_s)

    def f_dark(self, age_s) -> np.ndarray:
        return self._interp(self.dark, age_s)

    def obs_ratio(self, age_s, vgroup, tgroup) -> np.ndarray:
        age_s = np.asarray(age_s, dtype=np.float64)
        v = np.broadcast_to(np.asarray(vgroup, dtype=np.int64), age_s.shape)
        t = np.broadcast_to(np.asarray(tgroup, dtype=np.int64), age_s.shape)
        x = np.log10(np.maximum(age_s, 1.0))
        k = _knots()
        j = np.clip(np.searchsorted(k, x) - 1, 0, len(k) - 2)
        f = np.clip((x - k[j]) / (k[j + 1] - k[j]), 0.0, 1.0)
        a, b = self.obs[v, t, j], self.obs[v, t, j + 1]
        return a + (b - a) * f

    # ------------------------------------------------------------------------------------------------ fitting
    @classmethod
    def fit(cls, samples: pd.DataFrame, before=None) -> "QuoteModel":
        """
        samples: the shadow_rug_samples columns (sampled_at, status, transient_err, close_ok, quote_val, rug, age_ok_s,
        venue, n_tape_10min, tape_dead). Only quotes sampled before `before` are used. The default is the selection start:
        the gate chooses on the selection window, so a calibration that had seen those days would grade its own homework.
        """
        before = pd.Timestamp(before) if before is not None else splits.period("selection").start
        d = samples[(samples["status"] == "ok") & ~samples["transient_err"].astype(bool) & samples["close_ok"].notna()
                    & (samples["close_ok"] > 0) & (pd.to_datetime(samples["sampled_at"], utc=True) < before)].copy()
        if d.empty:
            raise ValueError("no shadow quotes before the cutoff to fit on")
        d["r"] = np.where(d["rug"].astype(bool), 0.0, d["quote_val"] / d["close_ok"]).clip(0, 2)
        d["b"] = age_bin(d["age_ok_s"])
        d["v"] = venue_group(d["venue"])
        d["t"] = tape_group(d["n_tape_10min"].fillna(0))
        nb = len(AGE_EDGES) - 1

        def curve(x: pd.DataFrame, prior: list[float]) -> tuple[np.ndarray, np.ndarray]:
            g = x.groupby("b")["r"].agg(["sum", "size"]).reindex(range(nb), fill_value=0)
            y = (g["sum"] + PRIOR_N * np.asarray(prior)) / (g["size"] + PRIOR_N)
            return monotone_down(y.to_numpy(), g["size"].to_numpy() + PRIOR_N), g["size"].to_numpy()

        dead = d["tape_dead"].astype(bool)
        alive, n_alive = curve(d[~dead], FALLBACK_ALIVE)
        dark, n_dark = curve(d[dead], FALLBACK_DARK)
        routed = d[~d["rug"].astype(bool)]
        base, _ = curve(routed, FALLBACK_ALIVE)
        obs = np.zeros((len(VENUES), len(TAPES), nb))
        n_obs = np.zeros((len(VENUES), len(TAPES), nb), dtype=int)
        for v in range(len(VENUES)):
            for t in range(len(TAPES)):
                g = routed[(routed["v"] == v) & (routed["t"] == t)].groupby("b")["r"].agg(["sum", "size"]).reindex(range(nb), fill_value=0)
                y = (g["sum"] + PRIOR_N * base) / (g["size"] + PRIOR_N)
                obs[v, t] = monotone_down(y.to_numpy(), g["size"].to_numpy() + PRIOR_N)
                n_obs[v, t] = g["size"].to_numpy()
        meta = {"n": int(len(d)), "fit_before": before.isoformat(), "sampled_from": str(pd.to_datetime(d["sampled_at"]).min()),
                "sampled_to": str(pd.to_datetime(d["sampled_at"]).max()), "n_alive": n_alive.tolist(), "n_dark": n_dark.tolist(),
                "n_obs": n_obs.tolist(), "age_edges_s": AGE_EDGES.tolist(), "venues": list(VENUES), "tapes": list(TAPES),
                "source": str(SOURCE)}
        return cls(alive=alive, dark=dark, obs=obs, meta=meta)

    @classmethod
    def fallback(cls) -> "QuoteModel":
        a = np.asarray(FALLBACK_ALIVE)
        return cls(alive=monotone_down(a), dark=monotone_down(np.asarray(FALLBACK_DARK)), obs=np.broadcast_to(monotone_down(a), (3, 3, len(a))).copy(),
                   meta={"fallback": "sim.yaml m_age_table / pre-test f_dark"})

    # ------------------------------------------------------------------------------------------------ persistence
    def to_dict(self) -> dict:
        return {"alive": self.alive.tolist(), "dark": self.dark.tolist(), "obs": self.obs.tolist(), "meta": self.meta}

    def save(self, path: Path | None = None) -> Path:
        path = path or data_dir() / SAVED
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(self.to_dict(), indent=1))
        return path

    @classmethod
    def from_dict(cls, d: dict) -> "QuoteModel":
        return cls(alive=np.asarray(d["alive"]), dark=np.asarray(d["dark"]), obs=np.asarray(d["obs"]), meta=d.get("meta", {}))

    @classmethod
    def load(cls, path: Path | None = None, fit_if_missing: bool = True) -> "QuoteModel":
        path = path or data_dir() / SAVED
        if path.is_file():
            return cls.from_dict(json.loads(path.read_text()))
        src = data_dir() / SOURCE
        if fit_if_missing and src.is_file():
            qm = cls.fit(pd.read_parquet(src))
            try:
                qm.save(path)
            except OSError:
                pass
            return qm
        return cls.fallback()


if __name__ == "__main__":  # python -m brain.sim.quotes: refit on the pre-selection shadow quotes and print the tables
    qm = QuoteModel.fit(pd.read_parquet(data_dir() / SOURCE))
    print("saved", qm.save())
    print("age edges (s)", AGE_EDGES.tolist())
    print("m_alive", np.round(qm.alive, 3).tolist(), "n", qm.meta["n_alive"])
    print("f_dark ", np.round(qm.dark, 3).tolist(), "n", qm.meta["n_dark"])
    for v, vn in enumerate(VENUES):
        for t, tn in enumerate(TAPES):
            print(f"obs {vn:<8} {tn:<5}", np.round(qm.obs[v, t], 3).tolist())
