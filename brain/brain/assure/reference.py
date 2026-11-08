"""
The reference learner: the smallest learner that does what reward.yaml and CONTRACT.md ask, so the learning checks are
known to be passable (and a broken check shows up as the reference failing). It is not a product model.

  entry   a bootstrapped ensemble of gradient-boosted regressors of g(pnl) (reward.yaml: losses x kappa) at full stake,
          per exit rule; copy at full stake when mean - c * std > 0, else skip (stakes are skip or full only).
          Gated signals (features.yaml gates) are never copied and never trained on.
  exit    one rule of EXIT_MENU (follow the leader, plus a time / trailing stop), chosen with c out of fold by day (every
          training day validates once). Only choices whose out-of-fold value beats skip with t >= 2 qualify (none:
          skip everything); of those, the most cautious within 10 % of the best value, so luck can't buy a small margin.
          Then refit on all the days.
  fine_tune  adds paper transitions (rows with features and a reward) to the training rows; with ground=True the rewards
          are re-valued first (transitions.ground_rewards), so an optimistic paper mark can't teach it to copy rugs.

Labels come from the rebuilt simulator only (TrainData.labels): grounded valuation, the leader-sell exit timing, the
observed-gap stops and the real costs, never a tape price.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor
from threadpoolctl import threadpool_limits

from brain.assure.features import COLUMNS
from brain.assure.protocol import TrainData
from brain.baselines import RuleExit
from brain.sim.env import g

EXIT_MENU = (RuleExit("follow"), RuleExit("follow|t5", time_min=5), RuleExit("follow|trail20|t30", trail=0.20, time_min=30))
C_GRID = (0.0, 0.5, 1.0, 2.0)
TRANSITION_WEIGHT = 1.0  # paper transitions count like any training row: weighting them 3x made honest data hurt (overfit)
T_MIN = 2.0          # a choice must beat skip out of fold with t >= 2, else the learner skips everything
INPUTS = tuple(c for c in COLUMNS if c != "leak_canary")  # the canary is offered too: see ReferenceLearner(use_canary)


@dataclass
class EnsemblePolicy:
    name: str
    members: list
    c: float
    exit_rule: RuleExit
    inputs: tuple
    meta: dict = field(default_factory=dict)

    def q(self, features: pd.DataFrame) -> tuple[np.ndarray, np.ndarray]:
        X = features[list(self.inputs)].to_numpy(np.float64)
        P = np.stack([m.predict(X) for m in self.members]) if self.members else np.zeros((1, len(X)))
        return P.mean(0), P.std(0)

    def stake(self, features: pd.DataFrame, sig: pd.DataFrame) -> np.ndarray:
        mu, sd = self.q(features)
        gated = sig["gate"].to_numpy() != "" if "gate" in sig else np.zeros(len(sig), bool)
        return np.where((mu - self.c * sd > 0) & ~gated, 1.0, 0.0)

    def exit(self, state, decision=None):
        return self.exit_rule(state, decision)


@dataclass
class ReferenceLearner:
    name: str = "reference"
    members: int = 5
    use_canary: bool = False   # True only in the leak check's mutant: train on every column, the canary included
    max_iter: int = 120

    def _inputs(self) -> tuple:
        return COLUMNS if self.use_canary else INPUTS

    def _ensemble(self, X, y, seed: int, n: int | None = None, w=None) -> list:
        rng = np.random.default_rng(seed)
        out = []
        for k in range(n or self.members):
            b = rng.integers(0, len(X), len(X))
            m = HistGradientBoostingRegressor(max_iter=self.max_iter, learning_rate=0.06, max_leaf_nodes=15, min_samples_leaf=25,
                                              l2_regularization=1.0, early_stopping=False, random_state=int(rng.integers(2**31)))
            with threadpool_limits(1):  # tiny fits: threads only add overhead (5x slower)
                m.fit(X[b], y[b], sample_weight=None if w is None else w[b])
            out.append(m)
        return out

    def _rows(self, data: TrainData) -> np.ndarray:
        s = data.sig
        return (s["gate"].to_numpy() == "") if "gate" in s else np.ones(len(s), bool)

    def fit(self, data: TrainData, seed: int = 0, extra: pd.DataFrame | None = None) -> EnsemblePolicy:
        inputs = self._inputs()
        use = self._rows(data)
        day = data.sig["day"].to_numpy()
        days = sorted(np.unique(day))
        folds = [days[i::min(4, len(days))] for i in range(min(4, len(days)))]  # out-of-fold by day: every training day validates once
        X = data.features[list(inputs)].to_numpy(np.float64)
        best = None
        cand = []
        labels = {}
        for k, rule in enumerate(EXIT_MENU):
            lab = data.labels(rule, seed=seed)
            y = g(lab["pnl"].to_numpy(), data.kappa)
            labels[rule.name] = y
            mu, sd = np.full(len(y), np.nan), np.full(len(y), np.nan)
            for fi, fd in enumerate(folds):
                va = use & np.isin(day, fd)
                tr = use & ~np.isin(day, fd)
                if tr.sum() < 50 or not va.any():
                    continue
                P = np.stack([m.predict(X[va]) for m in self._ensemble(X[tr], y[tr], seed * 101 + k * 7 + fi, n=3)])
                mu[va], sd[va] = P.mean(0), P.std(0)
            v_ = use & np.isfinite(mu)
            if not v_.any():
                continue
            for c in C_GRID:
                yc = y[v_][(mu[v_] - c * sd[v_]) > 0]
                t = float(yc.mean() / (yc.std(ddof=1) / np.sqrt(len(yc)))) if len(yc) > 2 and yc.std(ddof=1) > 0 else 0.0
                if t >= T_MIN:  # only choices whose out-of-fold value is significantly positive
                    cand.append((float(yc.sum()), c, k))
        if cand:
            # the most cautious (largest margin, then the simplest exit) of the choices within 10 % of the best validation value
            top = max(v for v, _, _ in cand)
            ok = [x for x in cand if x[0] >= top - 0.1 * abs(top)]
            v, c, k = max(ok, key=lambda x: (x[1], -x[2]))
            best = ((v, c), EXIT_MENU[k], c)
        if best is None:  # nothing beat skip significantly out of fold (or too little data): skip everything
            return EnsemblePolicy(self.name, [], 0.0, EXIT_MENU[0], inputs, {"reason": "nothing significantly beats skip"})
        if best[0][0] <= 0:  # nothing earned anything on validation: skip is the answer (the research default)
            return EnsemblePolicy(self.name, [], 0.0, EXIT_MENU[0], inputs, {"reason": "no validation value", "val_g_sum": best[0][0]})
        rule = best[1]
        y = labels[rule.name]
        Xa, ya, wa = X[use], y[use], np.ones(int(use.sum()))
        if extra is not None and len(extra):
            Xa = np.vstack([Xa, extra[list(inputs)].to_numpy(np.float64)])
            ya = np.r_[ya, g(extra["reward"].to_numpy(np.float64), data.kappa)]
            wa = np.r_[wa, np.full(len(extra), TRANSITION_WEIGHT)]
        mem = self._ensemble(Xa, ya, seed, w=wa)
        return EnsemblePolicy(self.name, mem, best[2], rule, inputs, {"exit": rule.name, "c": best[2], "val_g_sum": best[0][0],
                                                                       "n_train": int(use.sum())})

    def fine_tune(self, policy: EnsemblePolicy, data: TrainData, transitions: pd.DataFrame, seed: int = 0, ground: bool = True,
                  tape=None) -> EnsemblePolicy:
        """Refit with the paper transitions added; ground=True re-values their rewards on the tape first."""
        from brain.assure.transitions import ground_rewards
        tr = ground_rewards(transitions, tape if tape is not None else data.window.data.tape, data.params) if ground else transitions
        return self.fit(data, seed, extra=tr)
