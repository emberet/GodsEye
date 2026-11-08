"""
The trainer as a brain.assure learner (protocol.py): the same heads and rules as brain.train, on a synthetic world's
TrainData, so the learning checks (null world, veto, edge, traps, leak canary, ..., ONNX) run on what ships.

    lr = BrainLearner()
    pol = lr.fit(data, seed)                  # TrainData: a world's training days and point-in-time features
    pol.stake(features, sig); pol.exit(state) # protocol.Policy
    lr.fine_tune(pol, data, transitions)      # paper transitions (rewards grounded first)
    lr.onnx_roundtrip(pol, features, sig)     # share of signals whose ONNX decision equals the PyTorch one

Differences from the real pipeline, all forced by the worlds' size (a few thousand signals, no selection window):
  - inputs are the world's feature columns (brain.assure.features), every one but `leak_canary`, which no spec defines;
    a column with missing values gets a `_missing` flag, the value its training mean;
  - the exit (IQL vs two leader-sold rules, shipped exactly as networks) and the margin are chosen jointly out of fold on
    the training days: a margin qualifies only when the copies it makes beat skip with t >= 2 (entry.qualify), else the
    policy copies nothing (the research default);
  - training runs on CPU (tiny batches).
"""
from __future__ import annotations

import tempfile
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import pandas as pd

from brain.baselines import RuleExit
from brain.policy import entry as pe
from brain.policy import exit as px
from brain.policy.nets import QNet, predict
from brain.sim import engine
from brain.sim.env import g
from brain.sim.params import Chaos

EXCLUDE = ("episode_id", "leak_canary")
BATCH = 256  # a world has a few thousand rows: small batches, enough steps per epoch
# exit candidates besides IQL: sell on the leader's first sell (follow-the-leader for a leader that sells it all), and the
# same with a 5-minute cap; both read only exit features, so the shipped network is exactly the rule (exit.rule_net)
RULES = (px.ThresholdExit("leader_sold", (("leader_sold", 0.5),)),
         px.ThresholdExit("leader_sold|t5", (("leader_sold", 0.5), ("minutes_held", 5.0))))
# the chaos half of the labels and trajectories: delays, slippage and missing exit features (a world plants its own rugs
# and costs, so injected rugs and fee spikes on top would only teach it that nothing pays)
STRESS = Chaos(delay_mult=2.0, slip_mult=1.5, dropout_p=0.15)


@dataclass
class TableEncoder:
    """Numeric feature columns -> standardised inputs; missing -> the training mean plus a `_missing` flag."""
    inputs: tuple = ()
    flags: tuple = ()
    mean: np.ndarray = field(default_factory=lambda: np.zeros(0))
    std: np.ndarray = field(default_factory=lambda: np.ones(0))

    def fit(self, f: pd.DataFrame) -> "TableEncoder":
        self.inputs = tuple(c for c in f.columns if c not in EXCLUDE)
        X = f[list(self.inputs)].to_numpy(np.float64)
        self.flags = tuple(c for c, k in zip(self.inputs, np.isnan(X).any(0)) if k)
        self.mean = np.nan_to_num(np.nanmean(np.where(np.isfinite(X), X, np.nan), 0)) if len(X) else np.zeros(len(self.inputs))
        sd = np.nan_to_num(np.nanstd(np.where(np.isfinite(X), X, np.nan), 0)) if len(X) else np.ones(len(self.inputs))
        self.std = np.where(sd < 1e-6, 1.0, sd)
        return self

    def columns(self) -> list[str]:
        return list(self.inputs) + [c + "_missing" for c in self.flags]

    def __call__(self, f: pd.DataFrame) -> np.ndarray:
        X = np.column_stack([pd.to_numeric(f[c], errors="coerce").to_numpy(np.float64) if c in f else np.full(len(f), np.nan) for c in self.inputs]) \
            if self.inputs else np.zeros((len(f), 0))
        miss = ~np.isfinite(X)
        Z = np.where(miss, 0.0, (X - self.mean) / self.std)
        F = np.column_stack([miss[:, self.inputs.index(c)] for c in self.flags]).astype(np.float64) if self.flags else np.zeros((len(f), 0))
        return np.hstack([Z, F]).astype(np.float32)


@dataclass
class BrainWorldPolicy:
    name: str
    enc: TableEncoder
    ens: pe.Ensemble
    qualified: bool
    exit_net: QNet
    exit_norm: object
    meta: dict = field(default_factory=dict)

    def q(self, features: pd.DataFrame) -> np.ndarray:
        return self.ens.q(self.enc(features))

    def stake(self, features: pd.DataFrame, sig: pd.DataFrame) -> np.ndarray:
        if not self.qualified or not self.ens.members:
            return np.zeros(len(sig))
        gated = sig["gate"].to_numpy() != "" if "gate" in sig else np.zeros(len(sig), bool)
        return np.where(gated, 0.0, self.ens.decide(self.q(features)))

    def exit(self, state, decision=None):
        return px.ExitPolicy(self.exit_net, self.exit_norm, px.ExitFeaturizer())(state, decision)


@dataclass
class BrainLearner:
    name: str = "brain"
    members: int = pe.MEMBERS
    iql_steps: int = 2500
    epochs_max: int = 30

    def _labels(self, data, exit_policy, rows, seed: int) -> np.ndarray:
        """P&L per row at full stake with `exit_policy`, base and under a training-chaos draw (columns)."""
        d = data.window.data
        out = []
        for c, s in ((Chaos(), seed), (STRESS, seed + 1)):
            b = d.book(rows, np.full(len(rows), data.params.max_trade_sol), data.params, c, s)
            engine.run(b, exit_policy)
            o = b.outcomes()
            pnl = np.where(o["reason"].isin(pe.NOT_DECISIONS + ("no-fill",)).to_numpy(), np.nan, o["pnl"].to_numpy())
            out.append(pnl)
        return np.column_stack(out)

    def _iql(self, data, rows, seed: int):
        fz = px.ExitFeaturizer()
        bufs = [px.collect(data.window, rows, fz, chaos=c, seed=seed + k, params=data.params, kappa=data.kappa)
                for k, c in enumerate((Chaos(), STRESS))]
        buf = px.Buffer.concat(bufs)
        norm = px.fit_exit_norm(buf.X)
        iql, info = px.fit_exit(buf, norm, steps=self.iql_steps, seed=seed, dev="cpu", log_every=0, batch=1024)
        return iql, norm, buf, {k: v for k, v in info.items() if k != "history"}

    def _oof(self, Z, Y, w, day, seed: int) -> tuple[np.ndarray, np.ndarray, int]:
        """Out-of-fold ensemble mean / std of q by day (every training day validates once) and the epoch count."""
        days = sorted(set(day) - {"paper"})
        folds = [days[i::min(4, len(days))] for i in range(min(4, len(days)))]
        mu, sd = np.full(len(Y), np.nan), np.full(len(Y), np.nan)
        best_ep = []
        for k, fd in enumerate(folds):
            va = np.isin(day, fd)
            tr = ~va
            if tr.sum() < 50 or not va.any():
                continue
            net, hist = pe.fit_member(Z[tr], Y[tr], pe.day_weights(day[tr]), epochs=self.epochs_max, seed=seed * 31 + k,
                                      valid=(Z[va], Y[va], pe.day_weights(day[va])), patience=5, dev="cpu", batch=BATCH)
            best_ep.append(int(np.argmin(hist)) + 1)
            mems = [net] + pe.fit_ensemble(Z[tr], Y[tr], w[tr], day[tr], epochs=best_ep[-1], members=2, seed=seed * 31 + k + 7, dev="cpu",
                                           batch=BATCH)
            q = np.stack([predict(m, Z[va])[:, 1] for m in mems])
            mu[va], sd[va] = q.mean(0), q.std(0)
        return mu, sd, (max(2, int(np.median(best_ep))) if best_ep else 8)

    def fit(self, data, seed: int = 0, extra: pd.DataFrame | None = None, exit_from=None):
        """
        Exit candidates (the IQL head, the leader-sold rules) x margins, chosen jointly out of fold: the exit decides which
        leaders' records pay, so it is judged by the value of the copies the entry head then makes, not on all signals.
        """
        sig = data.sig
        use = (sig["gate"].to_numpy() == "") if "gate" in sig else np.ones(len(sig), bool)
        rows = np.flatnonzero(use)
        if len(rows) < 50:
            return self._skip_all(data, "too few ungated signals")
        enc = TableEncoder().fit(data.features.iloc[rows])
        Z0 = enc(data.features.iloc[rows])
        day0 = sig["day"].to_numpy()[rows]
        if exit_from is None:
            iql, xnorm, buf, iinfo = self._iql(data, rows, seed)
            cands = {"iql": px.ExitPolicy(iql, xnorm, px.ExitFeaturizer()), **{r.name: r for r in RULES}}
        else:
            iql, xnorm, buf, iinfo = exit_from.exit_net, exit_from.exit_norm, None, {}
            cands = {exit_from.meta.get("exit_kind", "iql"): px.ExitPolicy(iql, xnorm, px.ExitFeaturizer())}
        tried = {}
        for name, ex in cands.items():
            P = self._labels(data, ex, rows, seed + 100)
            R = g(P, data.kappa)
            Y = np.where(np.isfinite(R).all(1), (1 - pe.CHAOS_WEIGHT) * R[:, 0] + pe.CHAOS_WEIGHT * R[:, 1], np.nanmean(R, axis=1))
            ok = np.isfinite(Y)
            Z, Yc, day, w = Z0[ok], Y[ok][:, None], day0[ok], np.ones(int(ok.sum()))
            if extra is not None and len(extra):
                Zx = enc(extra)
                Yx = g(extra["reward"].to_numpy(np.float64) * (data.params.max_trade_sol / extra["stake"].to_numpy(np.float64)), data.kappa)
                Z, Yc = np.vstack([Z, Zx]), np.vstack([Yc, Yx[:, None]])
                day = np.concatenate([day, np.full(len(Zx), "paper")])
                w = np.r_[w, np.ones(len(Zx))]
            mu, sd, epochs = self._oof(Z, Yc, w, day, seed)
            real = np.isfinite(mu) & np.asarray([d != "paper" for d in day])
            qual = pe.qualify(mu[real], sd[real], Yc[real, 0]) if real.any() else {"qualified": False}
            tried[name] = {"qual": qual, "Z": Z, "Y": Yc, "w": w, "day": day, "epochs": epochs, "mean_R_all": float(np.nanmean(Y))}
        ok = {k: v for k, v in tried.items() if v["qual"].get("qualified")}
        summary = {k: {"oof": v["qual"], "mean_R_all": v["mean_R_all"]} for k, v in tried.items()}
        if not ok:
            pol = self._skip_all(data, "no exit and margin beat skip out of fold", enc=enc, exit_net=iql, xnorm=xnorm)
            pol.meta.update(exit=summary, exit_kind="iql")
            return pol
        name = max(ok, key=lambda k: ok[k]["qual"]["value"])
        t = ok[name]
        exit_net, xinfo = iql, {"kind": name, "iql": iinfo}
        if name != "iql" and exit_from is None:
            exit_net = px.rule_net(cands[name], xnorm)
        mem = pe.fit_ensemble(t["Z"], t["Y"], t["w"], t["day"], epochs=t["epochs"], members=self.members, seed=seed, dev="cpu", batch=BATCH)
        ens = pe.Ensemble(mem, pe.ACTIONS, float(t["qual"]["margin_c"]))
        return BrainWorldPolicy(self.name, enc, ens, True, exit_net, xnorm, {"exit": xinfo, "candidates": summary, "exit_kind": name,
                                                                              "epochs": t["epochs"], "rows": int(len(t["Y"]))})

    def _skip_all(self, data, why: str, enc=None, exit_net=None, xnorm=None) -> BrainWorldPolicy:
        if exit_net is None:
            exit_net = QNet(len(px.exit_columns()), 3)
            xnorm = px.fit_exit_norm(np.zeros((1, len(px.exit_columns())), np.float32))
        return BrainWorldPolicy(self.name, enc or TableEncoder().fit(data.features.iloc[:0]), pe.Ensemble([], pe.ACTIONS), False,
                                exit_net, xnorm, {"reason": why})

    def fine_tune(self, policy: BrainWorldPolicy, data, transitions: pd.DataFrame, seed: int = 0, ground: bool = True, tape=None):
        """Refit the entry head with the paper transitions added (rewards grounded first); the exit head is kept."""
        from brain.assure.transitions import ground_rewards
        tr = ground_rewards(transitions, tape if tape is not None else data.window.data.tape, data.params) if ground else transitions
        return self.fit(data, seed, extra=tr, exit_from=policy)

    def onnx_roundtrip(self, policy: BrainWorldPolicy, features: pd.DataFrame, sig: pd.DataFrame) -> float:
        """Export every network, decide again through onnxruntime: share of signals with the same stake."""
        from brain.export_onnx import export, run, session
        a = np.asarray(policy.stake(features, sig))
        if not policy.qualified or not policy.ens.members:
            return 1.0
        with tempfile.TemporaryDirectory() as d:
            sess = []
            for k, m in enumerate(policy.ens.members):
                export(m, Path(d) / f"entry-{k}.onnx")
                sess.append(session(Path(d) / f"entry-{k}.onnx"))
            ens = pe.Ensemble([lambda Z, s=s: run(s, Z) for s in sess], policy.ens.actions, policy.ens.margin_c)
            gated = sig["gate"].to_numpy() != "" if "gate" in sig else np.zeros(len(sig), bool)
            b = np.where(gated, 0.0, ens.decide(ens.q(policy.enc(features))))
        return float((a == b).mean()) if len(a) else 1.0
