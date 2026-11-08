"""
The entry head: a contextual bandit over the stake actions (reward.yaml `entry`, CONTRACT.md "Decision").

    Y = stake_targets(out, actions, kappa, p)               # R = g(net SOL P&L) per non-zero stake, from one full-stake run
    aug = Augment.for_entry(meta)                           # training chaos on the inputs (stress.yaml feature_dropout)
    ep, folds = early_stop(Z, Y, w, day, folds, aug)        # rolling-origin folds (splits.yaml) pick the epoch count
    ens = fit_ensemble(Z, Y, w, epochs=ep, aug=aug)         # 5 members, each on its own bootstrap resample
    q = ens.q(Z)                                            # [members, n, actions] expected reward (SOL), skip = 0
    frac = ens.decide(q, margin_c)                          # mean - c * std, best non-zero stake if > 0 (policy.ts pickStake)
    frac = ens.explore(q, curiosity, rng)                   # Thompson: one random member + curiosity * std (decideExplore)

Targets come from the simulator only (grounded valuation, real costs, chaos): a signal copied at full stake and exited by
the bundle's exit gives its net P&L; a fractional stake's P&L is the same position scaled with the fixed costs unchanged
(account.py's rule), and R = g(pnl) with g(x) = x - (kappa - 1) max(0, -x). Skip is 0. Gated signals and signals the
policy could not take (too late, broken print) are never training rows. Each row is weighted so every training day
counts the same (the last fit days hold most signals); a member's bootstrap draws Poisson(1) weights on top.
The loss is Huber with a 2-stake knee: losses are bounded (-1.5 stakes at kappa 1.5) but a 20x print would otherwise
decide the fit; that shrinks the largest wins a little, so q is if anything conservative.
"""
from __future__ import annotations

import copy
import time
from dataclasses import dataclass, field

import numpy as np
import pandas as pd
import torch
from torch import nn

from brain.policy.nets import QNet, device, predict
from brain.sim.env import g
from brain.sim.params import SimParams

ACTIONS = (0.0, 1.0)  # owner decision 2026-11-07 (brain.assure.suite STAKE_ACTIONS): skip or full stake
ALL_ACTIONS = (0.0, 0.25, 0.5, 0.75, 1.0)  # CONTRACT.md's list, kept for --actions 5
MEMBERS = 5
HUBER_STAKES = 2.0
MAX_EPOCHS = 40
PATIENCE = 6
BATCH = 4096
LR = 1e-3
WEIGHT_DECAY = 1e-4
# Weight of the training-chaos run in the entry target (the base run has the rest). stress.yaml's training ranges are
# pessimistic by design (injected rugs up to 10 %, sell failures 25-50 %, buy failures up to 20 %, fees up to 0.0008):
# on a fit day they turn a +0.0014 SOL mean copy into -0.024, so a pure chaos target makes every q negative and the head
# copies nothing. A quarter keeps the pull toward signals that survive chaos while q stays close to the base simulator's
# reward, the one the selection window and the gate score; the stress suite checks the chaos robustness on its own.
CHAOS_WEIGHT = 0.25
NOT_DECISIONS = ("too-late", "bad-print")  # signals the policy could not act on: not training rows
CP_FEATURES = ("cp_lrshr_7d", "cp_n_7d", "cp_win_7d")  # the mirror ledger (cold_ledger: all missing)
# stress.yaml feature_dropout.structural, at their worst day
STRUCTURAL_WORST = {"log_token_age": 0.76, "venue_group": 0.14, "cr_seen_prior_7d": 0.22, "ret_since_first": 0.54,
                    "dd_from_high": 0.54, "mint_first_seen_age_min": 0.54}
NO_NOISE = ("venue_via_bot", "sfx_pump", "social_score", "social_missing")
MASKED = ("social_score", "social_missing")  # constant in every training row (no X data yet): the net must not read them


def log(*a) -> None:
    print(time.strftime("%H:%M:%S"), *a, flush=True)


# ------------------------------------------------------------------------------------------------------------ targets
def stake_targets(out: pd.DataFrame, actions=ACTIONS, kappa: float = 1.5, p: SimParams | None = None) -> np.ndarray:
    """
    R = g(pnl) per non-zero stake [n, len(actions) - 1] from a full-stake run (book.outcomes()): a stake f of the full size
    keeps the fixed costs (fees, lost rent) and scales the rest, pnl_f = (pnl + fixed) * f / f_run - fixed.
    """
    p = p or SimParams.load()
    pnl = out["pnl"].to_numpy(np.float64)
    run = np.where(out["stake"].to_numpy(np.float64) > 0, out["stake"].to_numpy(np.float64), p.max_trade_sol)
    fixed = out["n_tx"].to_numpy() * p.tx_cost_sol + np.where(out["rent_lost"].to_numpy(bool), p.rent_sol, 0.0)
    cols = []
    for f in actions:
        if f <= 0:
            continue
        cols.append(g((pnl + fixed) * (f * p.max_trade_sol / run) - fixed, kappa))
    return np.column_stack(cols)


def day_weights(day: np.ndarray) -> np.ndarray:
    """Each day's rows sum to the same total (mean weight 1)."""
    days, inv, cnt = np.unique(np.asarray(day), return_inverse=True, return_counts=True)
    w = 1.0 / cnt[inv]
    return w * len(w) / w.sum()


# ------------------------------------------------------------------------------------------------------------ input chaos
@dataclass
class Augment:
    """
    Training chaos on normalised inputs (stress.yaml training_chaos.feature_dropout): a feature goes missing by writing the
    columns it has when missing (its default / training mean, its `_missing` flag = 1), so a dropped input looks exactly
    like a live missing one. Per training row: random dropout with p ~ U(0, dropout_max) per feature, the whole mirror
    ledger missing for `cold` of the rows (the first week after deployment), Gaussian noise of `noise_std` on the
    continuous columns for `noise_p` of the rows.
    """
    groups: dict                      # feature -> column indices
    missing: np.ndarray               # each column's value when its feature is missing (normalised)
    noise_cols: np.ndarray            # bool per column
    cold_features: tuple = CP_FEATURES
    dropout_max: float = 0.3
    cold: float = 0.2
    noise_p: float = 0.5
    noise_std: float = 0.1

    @classmethod
    def for_entry(cls, meta: dict, **kw) -> "Augment":
        from brain.features import spec
        feats = spec.entry_features()
        cols = list(meta["columns"])
        raw = {f.name: (None if f.onehot else np.nan) for f in feats}
        X = spec.encode(raw, feats, meta["categories"])
        miss = spec.normalise(X, spec.Norm.from_json(meta["norm"]))[0].astype(np.float32)
        groups = {}
        for f in feats:
            idx = [i for i, c in enumerate(cols) if c == f.name or c.startswith(f.name + "=") or c == f.name + "_missing"]
            groups[f.name] = np.asarray(idx, dtype=np.int64)
        binary = spec.binary_columns(feats, meta["categories"])
        noise = np.array([c not in binary and c not in NO_NOISE for c in cols])
        return cls(groups, miss, noise, **kw)

    def drop(self, Z: np.ndarray, rows: np.ndarray, feature: str) -> None:
        idx = self.groups.get(feature)
        if idx is None or not len(idx) or not rows.any():
            return
        sub = Z[rows]
        sub[:, idx] = self.missing[idx]
        Z[rows] = sub

    def __call__(self, Z: np.ndarray, rng: np.random.Generator) -> np.ndarray:
        Z = np.array(Z, dtype=np.float32, copy=True)
        n = len(Z)
        if self.dropout_max > 0:
            p = rng.uniform(0, self.dropout_max, n)
            for f in self.groups:
                self.drop(Z, rng.random(n) < p, f)
        if self.cold > 0:
            cold = rng.random(n) < self.cold
            for f in self.cold_features:
                self.drop(Z, cold, f)
        if self.noise_p > 0 and self.noise_cols.any():
            on = rng.random(n) < self.noise_p
            k = np.flatnonzero(self.noise_cols)
            Z[np.ix_(on, k)] += rng.normal(0, self.noise_std, (int(on.sum()), len(k))).astype(np.float32)
        return Z

    def scenario(self, Z: np.ndarray, seed: int = 0, dropout: float = 0.0, structural: bool = False, cold_ledger: bool = False) -> np.ndarray:
        """The stress suite's entry-side chaos (fixed seed): feature_dropout_30 and cold_ledger (features missing, no noise)."""
        rng = np.random.default_rng(seed)
        Z = np.array(Z, dtype=np.float32, copy=True)
        n = len(Z)
        if dropout > 0:
            for f in self.groups:
                self.drop(Z, rng.random(n) < dropout, f)
        if structural:
            for f, share in STRUCTURAL_WORST.items():
                self.drop(Z, rng.random(n) < share, f)
        if cold_ledger:
            for f in self.cold_features:
                self.drop(Z, np.ones(n, bool), f)
        return Z


def input_mask(columns: list[str]) -> np.ndarray:
    return np.array([0.0 if c in MASKED else 1.0 for c in columns], dtype=np.float32)


# ------------------------------------------------------------------------------------------------------------ training
def _loss(pred: torch.Tensor, y: torch.Tensor, w: torch.Tensor) -> torch.Tensor:
    per = nn.functional.huber_loss(pred, y, reduction="none", delta=HUBER_STAKES).mean(1)
    return (per * w).sum() / w.sum().clamp_min(1e-9)


def fit_member(Z, Y, w, *, epochs: int = MAX_EPOCHS, seed: int = 0, aug: Augment | None = None, valid=None, mask=None,
               scale: float = 0.1, patience: int | None = None, dev=None, init: QNet | None = None, lr: float = LR,
               batch: int = BATCH) -> tuple[QNet, list[float]]:
    """
    One member: Y (SOL) per non-zero stake, w row weights. With `valid` = (Zv, Yv, wv) the validation loss is recorded per
    epoch and the best epoch's weights are kept (early stopping with `patience`). `init` warm-starts (hourly mode).
    """
    torch.manual_seed(seed)
    rng = np.random.default_rng(seed)
    dev = dev or device()
    Z = np.asarray(Z, dtype=np.float32)
    Ys = torch.as_tensor(np.asarray(Y, dtype=np.float32) / scale)
    W = torch.as_tensor(np.asarray(w, dtype=np.float32))
    net = copy.deepcopy(init) if init is not None else QNet(Z.shape[1], Ys.shape[1], mask=mask, scale=scale, skip_zero=True)
    net = net.to(dev)
    opt = torch.optim.AdamW(net.parameters(), lr=lr, weight_decay=WEIGHT_DECAY)
    hist: list[float] = []
    best, best_state, bad = np.inf, None, 0
    if valid is not None:
        Zv = torch.as_tensor(np.asarray(valid[0], dtype=np.float32), device=dev)
        Yv = torch.as_tensor(np.asarray(valid[1], dtype=np.float32) / scale, device=dev)
        Wv = torch.as_tensor(np.asarray(valid[2], dtype=np.float32), device=dev)
    for ep in range(epochs):
        net.train()
        Za = aug(Z, rng) if aug is not None else Z
        Xt = torch.from_numpy(Za)
        order = torch.as_tensor(rng.permutation(len(Za)))
        for i in range(0, len(order), batch):
            b = order[i:i + batch]
            x, y, wb = Xt[b].to(dev), Ys[b].to(dev), W[b].to(dev)
            opt.zero_grad()
            loss = _loss(net.raw(x), y, wb)
            loss.backward()
            opt.step()
        if valid is not None:
            net.eval()
            with torch.no_grad():
                vl = float(_loss(net.raw(Zv), Yv, Wv))
            hist.append(vl)
            if vl < best - 1e-6:
                best, best_state, bad = vl, copy.deepcopy(net.state_dict()), 0
            else:
                bad += 1
                if patience is not None and bad >= patience:
                    break
    if best_state is not None:
        net.load_state_dict(best_state)
    return net.to("cpu").eval(), hist


def early_stop(Z, Y, w, day, folds: list[tuple[list[str], list[str]]], aug=None, mask=None, seed: int = 0, dev=None,
               max_epochs: int = MAX_EPOCHS) -> tuple[int, list[dict]]:
    """
    Rolling-origin early stopping: one member per fold (train days -> later validation days), the best epoch of each;
    the ensemble trains for their median (at least 2). Returns (epochs, per-fold records).
    """
    day = np.asarray(day)
    rec = []
    for k, (tr_days, va_days) in enumerate(folds):
        tr, va = np.isin(day, tr_days), np.isin(day, va_days)
        if tr.sum() < 200 or va.sum() < 50:
            rec.append({"fold": k, "skipped": f"train {int(tr.sum())} / valid {int(va.sum())} rows"})
            continue
        net, hist = fit_member(Z[tr], Y[tr], day_weights(day[tr]) * w[tr], epochs=max_epochs, seed=seed + k, aug=aug,
                               valid=(Z[va], Y[va], day_weights(day[va])), mask=mask, patience=PATIENCE, dev=dev)
        best = int(np.argmin(hist)) + 1
        q = predict(net, Z[va])[:, 1:]
        rec.append({"fold": k, "train_days": list(tr_days), "valid_days": list(va_days), "n_train": int(tr.sum()), "n_valid": int(va.sum()),
                    "best_epoch": best, "valid_loss": float(min(hist)), "valid_loss_epoch1": float(hist[0]),
                    **ranking(q.max(1), Y[va][np.arange(int(va.sum())), q.argmax(1)])})
    eps = [r["best_epoch"] for r in rec if "best_epoch" in r]
    return (max(2, int(np.median(eps))) if eps else 8), rec


def ranking(q: np.ndarray, y: np.ndarray) -> dict:
    """How well q orders realized reward: Spearman, and the mean R of the top fifth / of q > 0 (validation metrics)."""
    from scipy.stats import spearmanr
    q, y = np.asarray(q, dtype=np.float64), np.asarray(y, dtype=np.float64)
    if len(q) < 3:
        return {}
    top = q >= np.quantile(q, 0.8)
    pos = q > 0
    return {"spearman": float(spearmanr(q, y).statistic), "mean_R_all": float(y.mean()), "mean_R_top20": float(y[top].mean()),
            "n_q_pos": int(pos.sum()), "mean_R_q_pos": float(y[pos].mean()) if pos.any() else None}


def fit_ensemble(Z, Y, w, day, *, epochs: int, members: int = MEMBERS, seed: int = 0, aug=None, mask=None, dev=None,
                 init: list | None = None, lr: float = LR, batch: int = BATCH) -> list[QNet]:
    """`members` nets, each on its own bootstrap resample (Poisson(1) row weights) of the day-balanced rows."""
    rng = np.random.default_rng(seed)
    base = day_weights(day) * np.asarray(w, dtype=np.float64)
    out = []
    for k in range(members):
        boot = rng.poisson(1.0, len(base)).astype(np.float64)
        keep = boot > 0
        net, _ = fit_member(Z[keep], Y[keep], (base * boot)[keep], epochs=epochs, seed=seed * 1000 + k, aug=aug, mask=mask, dev=dev,
                            init=init[k] if init else None, lr=lr, batch=batch)
        out.append(net)
    return out


# ------------------------------------------------------------------------------------------------------------ decisions
def pick_stake(scores: np.ndarray, actions) -> np.ndarray:
    """policy.ts pickStake per row: the best non-zero stake by score (a larger stake needs a strictly higher score), if > 0."""
    acts = np.asarray(actions, dtype=np.float64)
    nz = np.flatnonzero(acts > 0)
    s = np.where(np.isfinite(scores[:, nz]), scores[:, nz], -np.inf)
    best = s.argmax(1)  # first maximum: the smaller stake on ties
    return np.where(s[np.arange(len(s)), best] > 0, acts[nz][best], 0.0)


@dataclass
class Ensemble:
    members: list
    actions: tuple = ACTIONS
    margin_c: float = 1.0
    meta: dict = field(default_factory=dict)

    def q(self, Z: np.ndarray) -> np.ndarray:
        """[members, n, actions] in SOL (skip = 0)."""
        if not self.members:
            return np.zeros((1, len(Z), len(self.actions)), dtype=np.float32)
        return np.stack([predict(m, Z) if isinstance(m, nn.Module) else np.asarray(m(Z), dtype=np.float32) for m in self.members])

    @staticmethod
    def stats(q: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        return q.mean(0), q.std(0)  # population std, as policy.ts ensembleStats

    def decide(self, q: np.ndarray, margin_c: float | None = None) -> np.ndarray:
        if not self.members:
            return np.zeros(q.shape[1])
        mu, sd = self.stats(q)
        c = self.margin_c if margin_c is None else margin_c
        return pick_stake(mu - c * sd, self.actions)

    def explore(self, q: np.ndarray, curiosity: float, rng: np.random.Generator) -> np.ndarray:
        """policy.ts decideExplore: one member chosen at random decides, curiosity x std added to every non-zero stake."""
        if not self.members:
            return np.zeros(q.shape[1])
        _, sd = self.stats(q)
        m = rng.integers(0, q.shape[0], q.shape[1])
        s = q[m, np.arange(q.shape[1])]
        nz = np.asarray(self.actions) > 0
        s = np.where(nz[None, :], s + curiosity * sd, s)
        return pick_stake(s, self.actions)


def qualify(mu: np.ndarray, sd: np.ndarray, y: np.ndarray, grid=(0.0, 0.5, 1.0, 1.5, 2.0, 3.0), t_min: float = 2.0) -> dict:
    """
    Out-of-fold margin choice for small data (the synthetic worlds of brain.assure): a margin qualifies when the copies it
    makes have a mean R significantly above skip (t >= t_min); of those within 10 % of the best total R, the most cautious
    (largest c). None qualifies: copy nothing (the research default is skip).
    """
    cand = []
    for c in grid:
        yc = y[(mu - c * sd) > 0]
        if len(yc) > 2 and yc.std(ddof=1) > 0:
            t = float(yc.mean() / (yc.std(ddof=1) / np.sqrt(len(yc))))
            if t >= t_min:
                cand.append((float(yc.sum()), c, t, len(yc)))
    if not cand:
        return {"qualified": False, "margin_c": None}
    top = max(v for v, *_ in cand)
    ok = [x for x in cand if x[0] >= top - 0.1 * abs(top)]
    v, c, t, n = max(ok, key=lambda x: x[1])
    return {"qualified": v > 0, "margin_c": c, "value": v, "t": t, "copies": n}
