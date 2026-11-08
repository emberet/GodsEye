"""
How a learner plugs into the learning checks: one protocol for the reference learner and the real trainer.

    data = TrainData(window, features, params, kappa)        # a world's training days, point-in-time features
    pol = learner.fit(data, seed=0)                          # -> Policy
    pol.stake(features, sig)                                 # stake fraction per signal (0 = skip; the checks want 0 or 1)
    pol.exit(state, decision)                                # fraction of tokens_left to sell (engine exit policy)
    pol2 = learner.fine_tune(pol, data, transitions, seed)   # optional: paper transitions (CONTRACT.md brain_transitions)
    res = score(pol, window, features, params)               # evaluate.Result on another window

The real trainer joins by exposing `assure_learner()` in brain.train (or brain.policy): a zero-argument function that
returns an object with `name`, `fit(data, seed)` and, optionally, `fine_tune(policy, data, transitions, seed)`.
`learners()` finds it and the checks then run on it as well as on the reference learner; until it exists those checks
are skipped with that reason, never passed.
"""
from __future__ import annotations

import importlib
from dataclasses import dataclass, field
from typing import Callable, Protocol

import numpy as np
import pandas as pd

from brain.sim import engine
from brain.sim.evaluate import Result, Window, evaluate
from brain.sim.params import Chaos, SimParams

NOT_COPIES = ("skip", "too-late", "bad-print", "no-fill")


@dataclass
class TrainData:
    window: Window
    features: pd.DataFrame          # one row per window.data.sig row, same order (episode_id first)
    params: SimParams = field(default_factory=SimParams)
    kappa: float = 1.5
    chaos: Chaos = field(default_factory=Chaos)

    @property
    def sig(self) -> pd.DataFrame:
        return self.window.data.sig

    def labels(self, exit_policy, chaos: Chaos | None = None, seed: int = 0) -> pd.DataFrame:
        """Every signal copied at full stake with `exit_policy` (unlimited slots): per row pnl, reason, entered, close_t."""
        d = self.window.data
        rows = np.arange(len(d.sig))
        b = d.book(rows, np.full(len(rows), self.params.max_trade_sol), self.params, chaos or self.chaos, seed)
        engine.run(b, exit_policy)
        out = b.outcomes()
        out["pnl"] = np.where(out["reason"].isin(NOT_COPIES).to_numpy(), 0.0, out["pnl"].to_numpy())
        return out

    def subset(self, rows) -> "TrainData":
        rows = np.asarray(rows)
        d = self.window.data
        sig = d.sig.iloc[rows].reset_index(drop=True)
        from brain.sim.signals import leader_sells
        data = engine.SimData(d.tape, sig, leader_sells(sig, d.tape), d.quotes)
        days = sorted(sig["day"].unique().tolist())
        w = Window(data=data, days=days, start=self.window.start, end=self.window.end, meta=dict(self.window.meta))
        return TrainData(w, self.features.iloc[rows].reset_index(drop=True), self.params, self.kappa, self.chaos)


class Policy(Protocol):
    name: str

    def stake(self, features: pd.DataFrame, sig: pd.DataFrame) -> np.ndarray: ...

    def exit(self, state: dict, decision=None) -> np.ndarray: ...


class Learner(Protocol):
    name: str

    def fit(self, data: TrainData, seed: int = 0) -> Policy: ...


@dataclass
class FixedPolicy:
    """A policy from plain callables: the baselines and the mutants of the checks."""
    name: str
    stake_fn: Callable
    exit_fn: Callable

    def stake(self, features, sig):
        return np.asarray(self.stake_fn(features, sig), dtype=np.float64)

    def exit(self, state, decision=None):
        return self.exit_fn(state, decision)


def entry_of(policy, features: pd.DataFrame, p: SimParams):
    """An evaluate() entry callback (stake in SOL) for `policy` over `features` (looked up by episode_id)."""
    fi = features.set_index("episode_id")

    def entry(sig: pd.DataFrame) -> np.ndarray:
        f = fi.loc[sig["episode_id"]].reset_index()
        frac = np.clip(np.asarray(policy.stake(f, sig.reset_index(drop=True)), dtype=np.float64), 0, 1)
        return frac * p.max_trade_sol
    return entry


def score(policy, window: Window, features: pd.DataFrame, params: SimParams | None = None, chaos: Chaos = Chaos(), seed: int = 0,
          B: int = 300) -> Result:
    p = params or SimParams()
    return evaluate(window, entry_of(policy, features, p), policy.exit, p, chaos, seed, B=B)


def learners() -> tuple[list, list[str]]:
    """(learners to check, why any expected learner is missing): the reference learner always, the trainer once it exists."""
    from brain.assure.reference import ReferenceLearner
    out, missing = [ReferenceLearner()], []
    found = False
    for mod in ("brain.train", "brain.policy"):
        try:
            m = importlib.import_module(mod)
        except ImportError:
            continue
        fn = getattr(m, "assure_learner", None)
        if fn is not None:
            out.append(fn())
            found = True
            break
    if not found:
        missing.append("the trainer (brain.train / brain.policy assure_learner()) is not built yet: its learning checks are skipped")
    return out, missing
