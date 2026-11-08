"""
The exit head: offline RL (IQL) over hold / sell_half / sell_all on simulator trajectories (reward.yaml exit_shaping).

    fz = ExitFeaturizer(ps_r, hourly)                   # Decision.state -> the 23 features.yaml exit columns
    buf = collect(window, rows, fz, chaos, seed)        # BatchEnv trajectories under a mix of behaviour policies
    net, info = fit_exit(buf, norm)                     # supervised pretrain on the remaining value, then IQL
    tb = transitions_buffer(rows, closed, norm_of, k)   # the paper account's own exit decisions (hourly fine-tune)
    pol = ExitPolicy(net, norm, fz)                     # an engine exit policy: pol(state, decision) -> fraction to sell

Rewards are BatchEnv's: potential-based, r = g(u_next) - g(u_prev) with u the GROUNDED value of the position if sold now,
so a position's rewards sum to g(realized net P&L) exactly and Q(s, a) = E[g(U) | s, a] - g(u_s). gamma = 1.

Behaviour (what the data covers): per position one of the research exits (brain.baselines EXIT_CANDIDATES and B2's,
with 5 % random actions), a random hazard (sell everything with p per decision, p log-uniform 1 %..30 %, half as often
sell half), or a patient holder (p 0.2 %..1 %, so 24 h holds and dead coins are in the data too).

IQL (Kostrikov et al. 2021) never queries an action the data lacks: V(s) is the tau-expectile of Q_target(s, a) over the
data's actions, Q(s, a) regresses r + V(s'), and the policy is the argmax of Q with sell_half masked once taken
(policy.ts pickExit). The supervised pretrain fits Q(s, a_taken) and V(s) to the Monte-Carlo remaining value first.
`distill(rule)` instead teaches the same network one of the rule exits (used when a rule beats IQL on selection): its
q are then preferences, not values, and only their argmax is meaningful.
"""
from __future__ import annotations

import copy
import json
import time
from dataclasses import dataclass, field

import numpy as np
import pandas as pd
import torch
from torch import nn

from brain.baselines import B2_EXIT, EXIT_CANDIDATES
from brain.features import exit as fx
from brain.features import spec
from brain.policy.nets import QNet, device, predict
from brain.sim.env import BatchEnv, g
from brain.sim.tape import T0_MS

EXIT_ACTIONS = ("hold", "sell_half", "sell_all")
FRACTION = np.array([0.0, 0.5, 1.0])
ENGINE_KEYS = ("ret_now", "peak_ret", "minutes_held", "leader_sold", "half_sold", "minutes_since_price", "position",
               "mins_since_tracked_price", "quote_failed", "sell_quote_ratio", "sell_quote_ratio_missing", "mom5", "leader_sold_frac",
               "minutes_since_leader_sold", "entry_venue_pumpswap", "oth_buyers_5m", "oth_sellers_5m", "oth_net_sol_5m", "pts_5m")
RULE_KEYS = ("ret_now", "peak_ret", "drawdown_from_peak", "minutes_held", "event_leader_sell", "leader_sell_frac", "half_sold")
RULES = tuple(EXIT_CANDIDATES) + (B2_EXIT,)
TAU = 0.7
HUBER_STAKES = 2.0


def log(*a) -> None:
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def exit_columns() -> list[str]:
    return spec.columns(spec.exit_features())


# ------------------------------------------------------------------------------------------------------------ features
@dataclass
class ExitFeaturizer:
    """
    The exit columns of a decision (features.yaml exit) from the engine's state, plus what the state lacks: the entry's
    ps_r_7d (leader_ps_r_7d, per signal row of the window) and the hour's tracked active wallets (the feature build's
    hourly table at t). Either is missing (NaN) when not given, as on the synthetic worlds.
    """
    ps_r: np.ndarray | None = None
    hourly: pd.Series | None = None

    def active_wallets(self, t_ms) -> np.ndarray:
        """entry_tracked_active_wallets_1h at epoch ms: the feature build's own rule (features.build.active_wallets_at)."""
        if self.hourly is None:
            return np.full(len(np.atleast_1d(t_ms)), np.nan)
        return fx.active_wallets_1h(np.asarray(t_ms, dtype=np.int64), self.hourly)

    def raw(self, st: dict) -> pd.DataFrame:
        return fx.exit_raw(self.inputs(st))

    def encode(self, st: dict) -> np.ndarray:
        """Transformed, not normalised (NaN where a train_mean default is still to fill): what the norm is fit on."""
        return fast_encode(self.inputs(st))

    def encode_reference(self, st: dict) -> np.ndarray:
        """The same through brain.features (pandas): slow, the definition fast_encode is tested against."""
        return spec.encode(self.raw(st), spec.exit_features()).astype(np.float32)

    def inputs(self, st: dict) -> dict:
        n = len(st["ret_now"])
        inp = {k: np.asarray(st[k], dtype=np.float64) for k in ENGINE_KEYS if k in st}
        rows = np.asarray(st["row"], dtype=np.int64) if "row" in st else None
        inp["leader_ps_r_7d"] = self.ps_r[rows] if self.ps_r is not None and rows is not None else np.full(n, np.nan)
        inp["active_wallets_1h"] = self.active_wallets(np.asarray(st["t"], dtype=np.int64) + T0_MS) if "t" in st else np.full(n, np.nan)
        return inp


_EXIT_SPEC: list | None = None


def fast_encode(inp: dict) -> np.ndarray:
    """
    features.exit.exit_raw + spec.encode for the simulator's inputs (ENGINE_KEYS, leader_ps_r_7d, active_wallets_1h) in
    numpy: the simulator asks for a decision thousands of times per day and the pandas path costs ~4 ms a call.
    tests/test_policy_exit.py pins it to the reference path on random states (missing values and flags included).
    """
    global _EXIT_SPEC
    if _EXIT_SPEC is None:
        _EXIT_SPEC = spec.exit_features()
    n = len(inp["ret_now"])

    def col(name, default=np.nan):
        return np.asarray(inp[name], dtype=np.float64) if name in inp else np.full(n, default)

    ret, peak = col("ret_now"), col("peak_ret")
    with np.errstate(divide="ignore", invalid="ignore"):
        dd = np.where(1.0 + peak > 0, np.maximum(0.0, 1.0 - (1.0 + ret) / (1.0 + peak)), 0.0)
    lsf = col("leader_sold_frac")
    raw = {
        "ret_now": ret, "peak_ret": peak, "drawdown_from_peak": dd, "minutes_held": col("minutes_held"),
        "leader_sold": (col("leader_sold", 0.0) > 0).astype(np.float64), "half_sold": (col("half_sold", 0.0) > 0).astype(np.float64),
        "minutes_since_price": col("minutes_since_price"), "position": col("position"),
        "mins_since_tracked_price": np.minimum(col("mins_since_tracked_price"), fx.TRACKED_CAP_MIN),
        "quote_failed": (col("quote_failed", 0.0) > 0).astype(np.float64), "sell_quote_ratio": col("sell_quote_ratio"), "mom5": col("mom5"),
        "oth_buyers_5m": col("oth_buyers_5m", 0.0), "oth_sellers_5m": col("oth_sellers_5m", 0.0), "oth_net_sol_5m": col("oth_net_sol_5m", 0.0),
        "pts_5m": col("pts_5m", 0.0), "leader_sold_frac": np.where(np.isfinite(lsf), np.clip(lsf, 0.0, 1.0), 0.0),
        "minutes_since_leader_sold": col("minutes_since_leader_sold", 0.0), "entry_venue_pumpswap": col("entry_venue_pumpswap", 0.0),
        "entry_tracked_active_wallets_1h": col("active_wallets_1h"), "leader_ps_r_7d": col("leader_ps_r_7d"),
    }
    out = []
    for f in _EXIT_SPEC:
        x = raw[f.name]
        flag = col(f.name + "_missing", 0.0)
        x = np.where(flag > 0, np.nan, x)
        miss = ~np.isfinite(x)
        if f.default != "train_mean":
            x = np.where(miss, float(f.default), x)
        out.append(np.where(miss & (f.default == "train_mean"), np.nan, spec.transform(f.transform, x)))
        if f.missing_flag:
            out.append(miss.astype(np.float64))
    return np.column_stack(out).astype(np.float32)


def fit_exit_norm(X: np.ndarray) -> spec.Norm:
    cols = exit_columns()
    return spec.fit_norm(X, cols, spec.binary_columns(spec.exit_features()))


def normalise(X: np.ndarray, norm: spec.Norm) -> np.ndarray:
    return spec.normalise(X, norm).astype(np.float32)


# ------------------------------------------------------------------------------------------------------------ behaviour
class BehaviourMix:
    """Per position: a research rule (40 %), a random hazard (45 %) or a patient holder (15 %); actions 0/1/2."""

    def __init__(self, n: int, seed: int = 0, rules=RULES, shares=(0.40, 0.45, 0.15), eps: float = 0.05):
        rng = np.random.default_rng(seed)
        self.rng = rng
        self.rules = rules
        self.kind = rng.choice(3, size=n, p=list(shares))
        self.rule = rng.integers(0, len(rules), n)
        self.p_all = np.where(self.kind == 1, np.exp(rng.uniform(np.log(0.01), np.log(0.30), n)), np.exp(rng.uniform(np.log(0.002), np.log(0.01), n)))
        self.eps = eps

    def __call__(self, st: dict, idx: np.ndarray) -> np.ndarray:
        n = len(idx)
        a = np.zeros(n, dtype=np.int64)
        kind, rid = self.kind[idx], self.rule[idx]
        r = kind == 0
        if r.any():
            for k in np.unique(rid[r]):
                m = r & (rid == k)
                frac = np.asarray(self.rules[k](st), dtype=np.float64)[m]
                a[m] = np.where(frac >= 1.0, 2, np.where(frac > 0, 1, 0))
            noise = r & (self.rng.random(n) < self.eps)
            a[noise] = self.rng.integers(0, 3, int(noise.sum()))
        h = ~r
        if h.any():
            u = self.rng.random(n)
            p = self.p_all[idx]
            a[h] = np.where(u < p, 2, np.where(u < 1.5 * p, 1, 0))[h]
        return a


# ------------------------------------------------------------------------------------------------------------ data
@dataclass
class Buffer:
    X: np.ndarray            # [N, 23] encoded exit columns (not normalised)
    a: np.ndarray            # effective action (a second sell_half is a hold)
    r: np.ndarray            # shaped reward (SOL)
    done: np.ndarray
    nxt: np.ndarray          # index of the next transition of the same position (-1 when done)
    G: np.ndarray            # Monte-Carlo remaining value (sum of this and later rewards)
    pos: np.ndarray          # position id (unique across concatenated buffers)
    S: dict = field(default_factory=dict)  # the engine fields the rule exits read (for distill)
    meta: dict = field(default_factory=dict)

    def __len__(self) -> int:
        return len(self.a)

    @staticmethod
    def concat(parts: list["Buffer"]) -> "Buffer":
        parts = [b for b in parts if len(b)]
        if not parts:
            return empty_buffer()
        off, pos_off, nx = 0, 0, []
        pos = []
        for b in parts:
            nx.append(np.where(b.nxt >= 0, b.nxt + off, -1))
            pos.append(b.pos + pos_off)
            off += len(b)
            pos_off += int(b.pos.max()) + 1 if len(b.pos) else 0
        S = {k: np.concatenate([b.S[k] for b in parts]) for k in parts[0].S}
        return Buffer(np.concatenate([b.X for b in parts]), np.concatenate([b.a for b in parts]), np.concatenate([b.r for b in parts]),
                      np.concatenate([b.done for b in parts]), np.concatenate(nx), np.concatenate([b.G for b in parts]), np.concatenate(pos),
                      S, {"parts": [b.meta for b in parts]})

    def save(self, path) -> None:
        np.savez(path, X=self.X, a=self.a, r=self.r, done=self.done, nxt=self.nxt, G=self.G, pos=self.pos,
                            **{"S_" + k: v for k, v in self.S.items()})

    @classmethod
    def load(cls, path) -> "Buffer":
        z = np.load(path)
        S = {k[2:]: z[k] for k in z.files if k.startswith("S_")}
        return cls(z["X"], z["a"], z["r"], z["done"], z["nxt"], z["G"], z["pos"], S)


def empty_buffer() -> Buffer:
    z = np.zeros(0)
    return Buffer(np.zeros((0, len(exit_columns())), np.float32), z.astype(np.int64), z, z.astype(bool), z.astype(np.int64), z,
                  z.astype(np.int64), {k: z for k in RULE_KEYS})


def collect(window, rows, featurizer: ExitFeaturizer, chaos=None, seed: int = 0, behaviour=None, kappa: float | None = None,
            params=None) -> Buffer:
    """Trajectories of `rows` (copied at full stake) under the behaviour mix: one transition per exit decision."""
    from brain.sim.params import Chaos
    env = BatchEnv(window, params=params, chaos=chaos or Chaos(), seed=seed, kappa=kappa, features=True)
    rows = np.asarray(rows, dtype=np.int64)
    beh = behaviour or BehaviourMix(len(rows), seed)
    X, A, P, S = [], [], [], {k: [] for k in RULE_KEYS}
    n_tr = 0
    rew, dn, nxt = [], [], []
    pending = np.full(len(rows), -1, dtype=np.int64)    # the transition each position's last action opened
    link = np.full(len(rows), -1, dtype=np.int64)       # a settled, not-done transition waiting for its next state
    d = env.reset(rows)
    while d is not None:
        ids = n_tr + np.arange(len(d.idx))
        n_tr += len(d.idx)
        X.append(featurizer.encode(d.state))
        for k in RULE_KEYS:
            S[k].append(np.asarray(d.state[k], dtype=np.float64))
        w = link[d.idx] >= 0
        for arr in (rew, dn, nxt):
            arr.append(np.full(len(d.idx), np.nan if arr is rew else (False if arr is dn else -1)))
        lk = link[d.idx[w]]
        if len(lk):
            _set(nxt, lk, ids[w])
        link[d.idx[w]] = -1
        a = np.asarray(beh(d.state, d.idx), dtype=np.int64)
        a = np.where((a == 1) & (np.asarray(d.state["half_sold"]) > 0), 0, a)  # sell_half is allowed once (env: a hold)
        A.append(a)
        P.append(d.idx.copy())
        pending[d.idx] = ids
        tr, d = env.step(a)
        if len(tr.idx):
            tid = pending[tr.idx]
            _set(rew, tid, tr.reward)
            _set(dn, tid, tr.done)
            link[tr.idx[~tr.done]] = tid[~tr.done]
    if not n_tr:
        return empty_buffer()
    buf = Buffer(np.concatenate(X), np.concatenate(A), np.concatenate(rew).astype(np.float64), np.concatenate(dn).astype(bool),
                 np.concatenate(nxt).astype(np.int64), np.zeros(n_tr), np.concatenate(P).astype(np.int64),
                 {k: np.concatenate(v) for k, v in S.items()})
    ok = np.isfinite(buf.r)
    if not ok.all():  # never settled (should not happen): end the chain before it
        buf.done[~ok] = True
        buf.r[~ok] = 0.0
    buf.G = remaining_value(buf.r, buf.pos)
    res = env.results()
    buf.meta = {"positions": int(len(rows)), "entered": int(res["entered"].sum()), "transitions": int(n_tr),
                "mean_pnl_behaviour": float(res.loc[res["entered"], "pnl"].mean()) if res["entered"].any() else None}
    return buf


def _set(chunks: list, ids: np.ndarray, vals) -> None:
    """Write vals at global transition ids into a list of per-round chunks."""
    sizes = np.cumsum([0] + [len(c) for c in chunks])
    ids = np.asarray(ids)
    vals = np.broadcast_to(np.asarray(vals), ids.shape)
    k = np.searchsorted(sizes, ids, "right") - 1
    for c in np.unique(k):
        m = k == c
        chunks[c][ids[m] - sizes[c]] = vals[m]


def remaining_value(r: np.ndarray, pos: np.ndarray) -> np.ndarray:
    """Per transition: the sum of its reward and every later reward of the same position (transitions in time order)."""
    s = pd.Series(r[::-1]).groupby(pos[::-1]).cumsum().to_numpy()[::-1]
    return s.astype(np.float64)


DEX_FEE = 0.01  # model.ts: 100 bps per side


def transitions_buffer(rows: pd.DataFrame, closed: pd.DataFrame, norm_of, kappa: float, tx_cost_sol: float = 0.0003) -> Buffer:
    """
    The paper account's exit decisions (brain_transitions, CONTRACT.md) as IQL transitions, for the hourly fine-tune.

    rows: exit rows of Brain/Explore positions (id, position_id, model_version, features, action, info); forced rows
    (`features` empty) are not decisions and are skipped. closed: one row per closed position with `position_id`,
    `stake` (SOL) and `reward` = its net SOL P&L, grounded first (brain.assure.transitions.ground_rewards).
    norm_of(model_version) -> the exit Norm that version normalised with (its manifest), or None to drop its rows:
    features are logged normalised, so each row is mapped back to encoded columns (what fit_exit normalises).

    Rewards follow BatchEnv: u_prev starts at 0, a decision's reward is g(u at the next decision) - g(u_prev), and the
    last one gets g(U) - g(u_prev) with U the grounded P&L, so a position's rewards sum to g(U). The paper book logs no
    potential, so u at a decision is estimated from its info: the rest sold at ret_now and the half sold at the ret_now
    of the decision that sold it, a 1 % DEX fee per side, the transaction costs so far.
    """
    xcols = exit_columns()
    if not len(rows) or not len(closed):
        return empty_buffer()
    cl = closed.drop_duplicates("position_id").set_index("position_id")
    X, A, R, D, P = [], [], [], [], []
    for pid, grp in rows[rows["position_id"].isin(cl.index)].sort_values("id").groupby("position_id", sort=False):
        feats, acts, us = [], [], []
        stake = float(cl.at[pid, "stake"])
        half_ret, n_tx = None, 1
        for f, a, v, info in zip(grp["features"], grp["action"], grp["model_version"], grp["info"]):
            f = json.loads(f) if isinstance(f, str) else f
            if f is None or len(f) != len(xcols):
                continue
            nm = norm_of(v)
            if nm is None:
                continue
            d = json.loads(info) if isinstance(info, str) and info else (info or {})
            ret = float(d.get("ret_now", 0.0) or 0.0)
            held = 0.5 if half_ret is not None else 1.0
            sold = 0.0 if half_ret is None else 0.5 * (1 + half_ret) * (1 - DEX_FEE)
            us.append(stake * (held * (1 + ret) * (1 - DEX_FEE) + sold) - stake - (n_tx + 1) * tx_cost_sol)
            feats.append(np.asarray(f, dtype=np.float64) * nm.std + nm.mean)
            a = int(a)
            acts.append(a)
            if a == 1 and half_ret is None:
                half_ret, n_tx = ret, n_tx + 1
        if not feats:
            continue
        u = np.r_[0.0, us[1:], float(cl.at[pid, "reward"])]  # u_prev of each decision, then U
        X.append(np.vstack(feats))
        A.append(np.asarray(acts))
        R.append(g(u[1:], kappa) - g(u[:-1], kappa))
        D.append(np.r_[np.zeros(len(feats) - 1, bool), True])
        P.append(np.full(len(feats), len(P)))
    if not X:
        return empty_buffer()
    n = np.cumsum([0] + [len(x) for x in X])
    nxt = np.concatenate([np.r_[np.arange(n[k] + 1, n[k + 1]), -1] for k in range(len(X))])
    r = np.concatenate(R)
    pos = np.concatenate(P)
    z = np.zeros(len(r))
    return Buffer(np.vstack(X).astype(np.float32), np.concatenate(A), r, np.concatenate(D), nxt, remaining_value(r, pos), pos,
                  {k: z for k in RULE_KEYS}, {"positions": len(X), "transitions": int(len(r)), "source": "brain_transitions"})


# ------------------------------------------------------------------------------------------------------------ training
def _huber(pred, y, w=None):
    per = nn.functional.huber_loss(pred, y, reduction="none", delta=HUBER_STAKES)
    return per.mean() if w is None else (per * w).sum() / w.sum().clamp_min(1e-9)


def fit_exit(buf: Buffer, norm: spec.Norm, *, scale: float = 0.1, pretrain_epochs: int = 2, steps: int = 20_000, tau: float = TAU,
             batch: int = 4096, lr: float = 3e-4, polyak: float = 0.005, seed: int = 0, dev=None, init: QNet | None = None,
             log_every: int = 5000) -> tuple[QNet, dict]:
    """Supervised pretrain (Q(s, a_taken), V(s) -> remaining value), then IQL. Returns the Q network (q in SOL)."""
    torch.manual_seed(seed)
    rng = np.random.default_rng(seed)
    dev = dev or device()
    Z = torch.as_tensor(normalise(buf.X, norm))
    n_in = Z.shape[1]
    q = copy.deepcopy(init) if init is not None else QNet(n_in, 3, scale=scale)
    v = QNet(n_in, 1, scale=scale)
    q, v = q.to(dev), v.to(dev)
    A = torch.as_tensor(buf.a, dtype=torch.long)
    Rw = torch.as_tensor(buf.r / scale, dtype=torch.float32)
    G = torch.as_tensor(buf.G / scale, dtype=torch.float32)
    Dn = torch.as_tensor(buf.done.astype(np.float32))
    NX = torch.as_tensor(np.where(buf.nxt >= 0, buf.nxt, 0), dtype=torch.long)
    oq = torch.optim.Adam(q.parameters(), lr=lr)
    ov = torch.optim.Adam(v.parameters(), lr=lr)
    hist = {"pretrain": [], "iql": []}
    n = len(Z)
    if init is None:
        for ep in range(pretrain_epochs):
            order = torch.as_tensor(rng.permutation(n))
            tot = 0.0
            for i in range(0, n, batch):
                b = order[i:i + batch]
                x, a, gt = Z[b].to(dev), A[b].to(dev), G[b].to(dev)
                oq.zero_grad()
                lq = _huber(q.raw(x).gather(1, a[:, None]).squeeze(1), gt)
                lq.backward()
                oq.step()
                ov.zero_grad()
                lv = _huber(v.raw(x).squeeze(1), gt)
                lv.backward()
                ov.step()
                tot += lq.item() * len(b)
            hist["pretrain"].append(tot / n)
    qt = copy.deepcopy(q).eval()
    for p_ in qt.parameters():
        p_.requires_grad_(False)
    run_q = run_v = 0.0
    for s in range(steps):
        b = torch.as_tensor(rng.integers(0, n, batch))
        x, a, r, d, nx = Z[b].to(dev), A[b].to(dev), Rw[b].to(dev), Dn[b].to(dev), NX[b]
        with torch.no_grad():
            qta = qt.raw(x).gather(1, a[:, None]).squeeze(1)
        vv = v.raw(x).squeeze(1)
        u = qta - vv
        lv = (torch.abs(tau - (u < 0).float()) * u * u).mean()  # expectile regression
        ov.zero_grad()
        lv.backward()
        ov.step()
        with torch.no_grad():
            vn = v.raw(Z[nx].to(dev)).squeeze(1)
            target = r + (1.0 - d) * vn
        lq = _huber(q.raw(x).gather(1, a[:, None]).squeeze(1), target)
        oq.zero_grad()
        lq.backward()
        oq.step()
        with torch.no_grad():
            for pt, pq in zip(qt.parameters(), q.parameters()):
                pt.mul_(1 - polyak).add_(pq, alpha=polyak)
        run_q, run_v = 0.98 * run_q + 0.02 * lq.item(), 0.98 * run_v + 0.02 * lv.item()
        if log_every and (s + 1) % log_every == 0:
            hist["iql"].append({"step": s + 1, "loss_q": run_q, "loss_v": run_v})
            log(f"  iql step {s + 1}: loss q {run_q:.4f} v {run_v:.4f}")
    q = q.to("cpu").eval()
    return q, {"transitions": int(n), "steps": steps, "tau": tau, "history": hist, "action_share": np.bincount(buf.a, minlength=3).tolist()}


def distill(rule, buf: Buffer, norm: spec.Norm, *, epochs: int = 20, batch: int = 4096, lr: float = 1e-3, seed: int = 0, dev=None,
            scale: float = 0.1) -> tuple[QNet, dict]:
    """Teach the exit network a rule exit (its action on every buffered state): cross-entropy on the network's q."""
    torch.manual_seed(seed)
    rng = np.random.default_rng(seed)
    dev = dev or device()
    st = {k: buf.S[k] for k in RULE_KEYS}
    frac = np.asarray(rule(st), dtype=np.float64)
    y = np.where(frac >= 1.0, 2, np.where(frac > 0, 1, 0))
    y = np.where((y == 1) & (buf.S["half_sold"] > 0), 0, y)
    Z = torch.as_tensor(normalise(buf.X, norm))
    Y = torch.as_tensor(y, dtype=torch.long)
    net = QNet(Z.shape[1], 3, scale=scale).to(dev)
    opt = torch.optim.Adam(net.parameters(), lr=lr)
    w = torch.as_tensor(1.0 / np.bincount(y, minlength=3).clip(1), dtype=torch.float32).to(dev)  # rare actions count
    for ep in range(epochs):
        order = torch.as_tensor(rng.permutation(len(Z)))
        for i in range(0, len(Z), batch):
            b = order[i:i + batch]
            opt.zero_grad()
            loss = nn.functional.cross_entropy(net.raw(Z[b].to(dev)), Y[b].to(dev), weight=w)
            loss.backward()
            opt.step()
    net = net.to("cpu").eval()
    pred = pick_exit(predict(net, Z.numpy()), buf.S["half_sold"] > 0)
    return net, {"rule": getattr(rule, "name", str(rule)), "agreement": float((pred == y).mean()),
                 "agreement_sell_all": float((pred[y == 2] == 2).mean()) if (y == 2).any() else None}


@dataclass(frozen=True)
class ThresholdExit:
    """
    Sell everything once any exit feature reaches its threshold, e.g. (("minutes_held", 1.0),) = B4's t1, or
    (("leader_sold", 0.5),) = sell on the leader's first delivered sell (follow-the-leader for a leader selling it all).
    Reads only exit features, so threshold_net can ship it exactly.
    """
    name: str
    conds: tuple

    def __call__(self, st: dict, d=None) -> np.ndarray:
        n = len(st["ret_now"])
        out = np.zeros(n, bool)
        with np.errstate(invalid="ignore"):
            for col, th in self.conds:
                out |= np.asarray(st[col], dtype=np.float64) >= th
        return np.where(out, 1.0, 0.0)


def as_threshold(rule) -> ThresholdExit | None:
    """A rule exit that is a ThresholdExit in disguise (B4's t1: only a hold time), else None."""
    if isinstance(rule, ThresholdExit):
        return rule
    if getattr(rule, "time_min", None) is not None and not rule.follow and rule.sl is None and rule.tp is None and rule.trail is None:
        return ThresholdExit(rule.name, (("minutes_held", float(rule.time_min)),))
    return None


def is_time_rule(rule) -> bool:
    return as_threshold(rule) is not None and not isinstance(rule, ThresholdExit)


def rule_net(rule, norm: spec.Norm, scale: float = 0.1, sharp: float = 1000.0) -> QNet:
    """
    The exit network of a ThresholdExit (one or two conditions), built by hand, no training: q(sell_all) - q(hold) =
    sharp x max_k (x_k - th_k) on the normalised columns, sell_half never chosen, so the bundle ships exactly the rule
    that was chosen. Each threshold sits a hair below its raw value (1e-4), so reaching it exactly sells (a tie would go
    to hold).
    """
    r = as_threshold(rule)
    if r is None or not 1 <= len(r.conds) <= 2:
        raise ValueError(f"{getattr(rule, 'name', rule)}: not a one- or two-condition threshold rule")
    cols = list(norm.columns)
    feats = {f.name: f for f in spec.exit_features()}
    js, ths = [], []
    for col, th in r.conds:
        j = cols.index(col)
        js.append(j)
        ths.append((float(spec.transform(feats[col].transform, th - 1e-4)) - float(norm.mean[j])) / float(norm.std[j]))
    net = QNet(len(cols), 3, hidden=(3, 3), scale=scale)
    with torch.no_grad():
        l1, l2, l3 = net.body[0], net.body[2], net.body[4]
        for layer in (l1, l2, l3):
            layer.weight.zero_()
            layer.bias.zero_()
        # a = x_0 - th_0, b = x_1 - th_1 (b = a with one condition); max(a, b) = relu(a - b) + relu(b) - relu(-b)
        j0, j1 = js[0], js[-1]
        t0, t1 = ths[0], ths[-1]
        l1.weight[0, j0] += 1.0
        l1.weight[0, j1] -= 1.0
        l1.bias[0] = -t0 + t1                     # u0 = relu(a - b)
        l1.weight[1, j1], l1.bias[1] = 1.0, -t1   # u1 = relu(b)
        l1.weight[2, j1], l1.bias[2] = -1.0, t1   # u2 = relu(-b)
        for k in range(3):
            l2.weight[k, k] = 1.0
        l3.weight[1, :] = -sharp
        l3.bias[1] = -1.0                         # sell_half: always below hold
        l3.weight[2, 0], l3.weight[2, 1], l3.weight[2, 2] = sharp, sharp, -sharp
    return net.eval()


# ------------------------------------------------------------------------------------------------------------ policy
def pick_exit(q: np.ndarray, half_sold) -> np.ndarray:
    """policy.ts pickExit: argmax with sell_half masked once taken; ties go to the earlier action."""
    q = np.where(np.isfinite(q), q, -np.inf).copy()
    q[np.asarray(half_sold, dtype=bool), 1] = -np.inf
    return q.argmax(1)


class ExitPolicy:
    """An engine exit policy from a q function over normalised exit columns (torch net or an ONNX session's run)."""

    def __init__(self, qfn, norm: spec.Norm, featurizer: ExitFeaturizer):
        self.qfn = qfn if callable(qfn) and not isinstance(qfn, nn.Module) else (lambda Z, m=qfn: predict(m, Z))
        self.norm, self.fz = norm, featurizer

    def q(self, st: dict) -> np.ndarray:
        return self.qfn(normalise(self.fz.encode(st), self.norm))

    def __call__(self, st: dict, d=None) -> np.ndarray:
        if not len(st["ret_now"]):
            return np.zeros(0)
        half = np.nan_to_num(np.asarray(st["half_sold"], dtype=np.float64)) > 0
        return FRACTION[pick_exit(self.q(st), half)]
