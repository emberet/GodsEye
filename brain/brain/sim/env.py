"""
The exit environment for the trainer, with the reward of brain/spec/reward.yaml.

Vectorised (what training uses): many positions advance together; each one asks for an action only at its own events.

    env = BatchEnv(window, seed=0)                         # window: evaluate.load_window(...) (or a SimData)
    dec = env.reset(rows, stake_frac=1.0)                  # entries filled; dec.idx / dec.state = the first decisions
    while dec is not None:
        a = policy(dec.state)                              # 0 hold, 1 sell_half, 2 sell_all (EXIT_ACTIONS)
        tr, dec = env.step(a)                              # tr: completed transitions (idx, reward, done, next_idx)
    env.results()                                          # per row: pnl (net SOL), R = g(pnl), reason

One episode (gym-like):

    e = Env(window); s = e.reset(row)                      # None when no position opened (info in e.info)
    s, r, done, info = e.step(2)

Reward (reward.yaml): g(x) = x - (kappa - 1) * max(0, -x), kappa 1.5, gamma 1, lambda 0. Exit steps are potential-based:
r = g(u_next) - g(u_prev), u = net P&L if the rest were sold now at its GROUNDED value (Book.potential), u_0 = 0; the step
that closes the position (by the action, a hard stop, the max hold or a write-off) gets g(U) - g(u_prev), U = realized net
P&L, so the rewards of a position always sum to g(U) exactly. sell_half is allowed once: a second one is a hold (CONTRACT.md).
The entry head's target is R = g(U) of the whole position (results()).
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np
import yaml

from brain.sim import engine
from brain.sim.params import Chaos, SimParams

EXIT_ACTIONS = ("hold", "sell_half", "sell_all")
REWARD_SPEC = Path(__file__).resolve().parents[2] / "spec" / "reward.yaml"


def kappa_from_spec(path: Path = REWARD_SPEC) -> float:
    return float(yaml.safe_load(path.read_text())["kappa"])


def g(x, kappa: float) -> np.ndarray:
    x = np.asarray(x, dtype=np.float64)
    return x - (kappa - 1.0) * np.maximum(0.0, -x)


@dataclass
class Transitions:
    idx: np.ndarray        # positions whose earlier action this completes
    reward: np.ndarray
    done: np.ndarray       # the position closed (reward includes the terminal g(U))
    info: dict


class BatchEnv:
    def __init__(self, window, params: SimParams | None = None, chaos: Chaos = Chaos(), seed: int = 0, kappa: float | None = None,
                 features: bool = True):
        self.data = window.data if hasattr(window, "data") else window
        self.p = params or SimParams.load()
        self.chaos, self.seed, self.features = chaos, seed, features
        self.kappa = kappa_from_spec() if kappa is None else kappa
        self.book: engine.Book | None = None
        self.dec: engine.Decision | None = None

    def reset(self, rows, stake_frac=1.0) -> engine.Decision | None:
        rows = np.atleast_1d(np.asarray(rows, dtype=np.int64))
        stake = np.clip(np.broadcast_to(np.asarray(stake_frac, dtype=np.float64), rows.shape), 0, 1) * self.p.max_trade_sol
        self.book = self.data.book(rows, stake, self.p, self.chaos, self.seed, features=self.features, shaping=True)
        self.u_prev = np.zeros(len(rows))
        self.waiting = np.zeros(len(rows), bool)  # acted, waiting for the next decision or the close
        self.acted_at = np.full(len(rows), -1, dtype=np.int64)
        self.dec = self.book.advance()
        return self.dec

    def step(self, actions, fractions: bool = False) -> tuple[Transitions, engine.Decision | None]:
        """
        Apply actions to the current decisions: indices into EXIT_ACTIONS (0 hold, 1 sell_half, 2 sell_all), or with
        fractions=True the fraction of tokens_left to sell (as Book.act). Never guessed from the values: [1.0] is sell_half.
        """
        assert self.dec is not None, "no decision pending: reset() first"
        b, d = self.book, self.dec
        if fractions:
            frac = np.clip(np.asarray(actions, dtype=np.float64), 0, 1)
        else:
            a = np.asarray(actions)
            if not (np.isin(a, (0, 1, 2)).all() and (a.dtype.kind in "iu" or a.dtype.kind == "f")):
                raise ValueError(f"exit actions must be indices into {EXIT_ACTIONS} (sell fractions: step(..., fractions=True))")
            a = a.astype(np.int64)
            half = (a == 1) & ~b.half[d.idx]
            frac = np.where(a == 2, 1.0, np.where(half, 0.5, 0.0))
        b.act(d.idx, frac)
        self.waiting[d.idx] = True
        self.dec = b.advance()
        return self._settle(), self.dec

    def _settle(self) -> Transitions:
        """Rewards for positions that acted and now either face their next decision or are closed."""
        b = self.book
        closed = self.waiting & b.closed
        nxt = np.zeros(b.n, bool)
        if self.dec is not None:
            nxt[self.dec.idx] = True
        nxt &= self.waiting & ~closed
        idx = np.flatnonzero(closed | nxt)
        u_new = np.zeros(len(idx))
        c = closed[idx]
        u_new[c] = b.pnl(idx[c])
        if (~c).any():
            u_new[~c] = b.potential(idx[~c])
        r = g(u_new, self.kappa) - g(self.u_prev[idx], self.kappa)
        self.u_prev[idx] = u_new
        self.waiting[idx] = False
        # positions that closed while nobody was waiting (forced before their first decision) are settled in results()
        return Transitions(idx=idx, reward=r, done=c, info={"reason": np.asarray(engine.REASONS)[b.reason[idx]]})

    def results(self):
        """Per row: the realized net P&L, the entry target R = g(pnl), the close reason, and the shaping residual check."""
        b = self.book
        out = b.outcomes()
        out["R"] = g(out["pnl"].to_numpy(), self.kappa)
        return out


class Env:
    """One position at a time, gym-style, over BatchEnv."""

    def __init__(self, window, **kw):
        self.batch = BatchEnv(window, **kw)
        self.info: dict = {}

    def _state(self, d) -> dict:
        return {k: (v[0] if hasattr(v, "__len__") and len(v) else v) for k, v in d.state.items()}

    def reset(self, row: int, stake_frac: float = 1.0) -> dict | None:
        d = self.batch.reset([row], stake_frac)
        b = self.batch.book
        self.info = {"entered": bool(b.entered[0]), "reason": engine.REASONS[b.reason[0]]}
        if d is None:
            self.info.update(pnl=float(b.pnl([0])[0]), R=float(g(b.pnl([0]), self.batch.kappa)[0]))
            return None
        return self._state(d)

    def step(self, action: int):
        tr, d = self.batch.step(np.array([action]))
        b = self.batch.book
        r = float(tr.reward.sum()) if len(tr.idx) else 0.0
        done = bool(b.closed[0])
        info = {"reason": engine.REASONS[b.reason[0]]}
        if done:
            info.update(pnl=float(b.pnl([0])[0]), R=float(g(b.pnl([0]), self.batch.kappa)[0]))
            return None, r, True, info
        return self._state(d), r, False, info
