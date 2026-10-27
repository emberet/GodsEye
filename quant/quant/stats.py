"""Skill vs luck statistics for wallets' closed trades."""

from __future__ import annotations

import numpy as np
import pandas as pd
from scipy import stats as st

from .config import QuantConfig

EULER_GAMMA = 0.5772156649015329


def null_returns(trades: pd.DataFrame, paths: dict, pool: np.ndarray, n: int, rng: np.random.Generator) -> np.ndarray:
    """(n, len(trades)) matrix of returns from random entries: same token, same window, same hold.
    Trades whose token has no price path draw from the pooled returns of every wallet (population luck)."""
    out = np.empty((n, len(trades)))
    for j, t in enumerate(trades.itertuples(index=False)):
        p = paths.get(t.mint)
        if p is None:
            out[:, j] = rng.choice(pool, n)
            continue
        ts, px = p
        hold = max(float(t.hold_sec or 0.0), 0.0)
        lo, hi = ts[0], max(ts[0], ts[-1] - hold)
        t0 = rng.uniform(lo, hi, n) if hi > lo else np.full(n, lo)
        i0 = np.clip(np.searchsorted(ts, t0, side="right") - 1, 0, len(ts) - 1)
        i1 = np.clip(np.searchsorted(ts, t0 + hold, side="right") - 1, 0, len(ts) - 1)
        out[:, j] = px[i1] / px[i0] - 1.0
    return out


def perm_pvalue(obs: float, null_means: np.ndarray) -> float:
    """One-sided permutation p-value. When fewer than 10 null draws reach the observed value the empirical
    estimate is floored by the draw count (too coarse for FDR across thousands of wallets), so the tail is
    taken from a normal fit to the null means instead (the CLT holds for a mean of 30+ trades)."""
    hits = int((null_means >= obs).sum())
    if hits >= 10:
        return float((1 + hits) / (1 + len(null_means)))
    sd = float(null_means.std(ddof=1))
    if sd <= 0:
        return 1.0 if obs <= float(null_means.mean()) else 0.0
    return float(min(1.0, st.norm.sf((obs - float(null_means.mean())) / sd)))


def bootstrap_median_ci(r: np.ndarray, n_boot: int, rng: np.random.Generator) -> tuple[float, float]:
    idx = rng.integers(0, len(r), (n_boot, len(r)))
    med = np.median(r[idx], axis=1)
    return float(np.quantile(med, 0.025)), float(np.quantile(med, 0.975))


def sharpe(r: np.ndarray) -> float:
    sd = r.std(ddof=1) if len(r) > 1 else 0.0
    return float(r.mean() / sd) if sd > 0 else 0.0


def deflated_sharpe(sr: float, r: np.ndarray, n_trials: int, sr_var: float) -> float:
    """Bailey and Lopez de Prado (2014): P(true SR > expected max SR of n_trials unskilled strategies)."""
    t = len(r)
    if t < 3:
        return 0.0
    n_trials = max(n_trials, 1)
    if n_trials > 1 and sr_var > 0:
        sr0 = np.sqrt(sr_var) * (
            (1 - EULER_GAMMA) * st.norm.ppf(1 - 1 / n_trials) + EULER_GAMMA * st.norm.ppf(1 - 1 / (n_trials * np.e))
        )
    else:
        sr0 = 0.0
    if r.std() > 1e-12 * max(1.0, abs(float(r.mean()))):
        skew = float(st.skew(r, bias=False))
        kurt = float(st.kurtosis(r, fisher=False, bias=False))
    else:
        skew, kurt = 0.0, 3.0
    denom = 1 - skew * sr + (kurt - 1) / 4 * sr**2
    if not np.isfinite(denom) or denom <= 0:
        denom = 1e-9
    return float(st.norm.cdf((sr - sr0) * np.sqrt(t - 1) / np.sqrt(denom)))


def benjamini_hochberg(p: np.ndarray) -> np.ndarray:
    p = np.asarray(p, float)
    m = len(p)
    if m == 0:
        return p
    order = np.argsort(p)
    ranked = p[order] * m / np.arange(1, m + 1)
    q = np.minimum.accumulate(ranked[::-1])[::-1]
    out = np.empty(m)
    out[order] = np.minimum(q, 1.0)
    return out


def shrunk_mean(r: np.ndarray, k: float) -> float:
    """Mean shrunk toward 0 (no edge) by k pseudo-trades."""
    return float(r.sum() / (len(r) + k)) if len(r) else 0.0


def best_trade_share(pnl: np.ndarray) -> float:
    gains = pnl[pnl > 0]
    return float(gains.max() / gains.sum()) if gains.size else 1.0


def persistence(trades: pd.DataFrame, cfg: QuantConfig) -> tuple[float, float, dict[str, bool]]:
    """Rank wallets on the first half of the window, test on the second half.
    Returns (Spearman rho across wallets, top-minus-bottom quintile spread, per-wallet persistent flag)."""
    if trades.empty:
        return float("nan"), float("nan"), {}
    mid = trades["entry_ts"].min() + (trades["entry_ts"].max() - trades["entry_ts"].min()) / 2
    k = cfg.prior_strength / 2
    a, b, flags = {}, {}, {}
    for w, g in trades.groupby("wallet"):
        r1 = g.loc[g["entry_ts"] < mid, "ret"].to_numpy()
        r2 = g.loc[g["entry_ts"] >= mid, "ret"].to_numpy()
        if len(r1) >= 5 and len(r2) >= 5:
            a[w], b[w] = shrunk_mean(r1, k), shrunk_mean(r2, k)
            # per-wallet: edge positive in both halves, and the second half beats a coin flip on wins
            flags[w] = a[w] > 0 and b[w] > 0 and (r2 > 0).mean() > 0.5
        else:
            flags[w] = False
    if len(a) < 3:
        return float("nan"), float("nan"), flags
    ws = list(a)
    x, y = np.array([a[w] for w in ws]), np.array([b[w] for w in ws])
    rho = float(st.spearmanr(x, y).statistic)
    qn = max(1, len(ws) // 5)
    order = np.argsort(x)
    spread = float(y[order[-qn:]].mean() - y[order[:qn]].mean())
    return rho, spread, flags


def analyse(trades: pd.DataFrame, paths: dict, cfg: QuantConfig, now: int) -> tuple[pd.DataFrame, dict]:
    rng = np.random.default_rng(cfg.seed)
    pool = trades["ret"].to_numpy()
    wallets = list(trades.groupby("wallet"))
    srs = np.array([sharpe(g["ret"].to_numpy()) for _, g in wallets if len(g) >= cfg.min_trades])
    sr_var = float(srs.var(ddof=1)) if len(srs) > 1 else 0.0
    n_tested = max(len(srs), 1)
    rho, spread, flags = persistence(trades, cfg)
    rows = []
    for w, g in wallets:
        r = g["ret"].to_numpy()
        n = len(r)
        wins = int((r > 0).sum())
        row = {
            "wallet": w,
            "computed_at": now,
            "n_trades": n,
            "win_rate": None,
            "median_return": float(np.median(r)),
            "ci_low": None,
            "ci_high": None,
            "p_value": None,
            "q_value": None,
            "deflated_sharpe": None,
            "persistence_rho": None if np.isnan(rho) else rho,
            "skill_score": 0.0,
            "verdict": "insufficient",
            "_best_share": best_trade_share(g["pnl_sol"].to_numpy()),
            "_persistent": flags.get(w, False),
        }
        if n >= cfg.min_trades:
            null = null_returns(g, paths, pool, cfg.n_perm, rng)
            base = float((null > 0).mean())
            row["win_rate"] = (wins + cfg.prior_strength * base) / (n + cfg.prior_strength)  # Beta-shrunk
            p_bin = float(st.binomtest(wins, n, min(max(base, 1e-6), 1 - 1e-6), alternative="greater").pvalue)
            obs = r.mean()
            p_perm = perm_pvalue(obs, null.mean(axis=1))
            row["p_value"] = max(p_bin, p_perm)  # both timing and hit rate must beat random entries
            row["ci_low"], row["ci_high"] = bootstrap_median_ci(r, cfg.n_boot, rng)
            row["deflated_sharpe"] = deflated_sharpe(sharpe(r), r, n_tested, sr_var)
        rows.append(row)
    df = pd.DataFrame(rows)
    tested = df["p_value"].notna()
    df["q_value"] = df["q_value"].astype(object)
    if tested.any():
        df.loc[tested, "q_value"] = benjamini_hochberg(df.loc[tested, "p_value"].to_numpy(float))
    rho_ok = np.isnan(rho) or len(flags) < 10 or rho >= cfg.min_persistence_rho
    for i, row in df[tested].iterrows():
        q, dsr, share = float(row["q_value"]), float(row["deflated_sharpe"]), float(row["_best_share"])
        conc_penalty = max(0.0, 1.0 - share)
        persist = 1.0 if row["_persistent"] and rho_ok else 0.0
        df.at[i, "skill_score"] = float((1 - q) * dsr * conc_penalty * persist)
        ok = q <= cfg.fdr_alpha and persist and share <= cfg.max_best_share and dsr >= cfg.min_dsr
        df.at[i, "verdict"] = "skill" if ok else "luck"
    summary = {
        "wallets": len(df),
        "tested": int(tested.sum()),
        "skill": int((df["verdict"] == "skill").sum()),
        "persistence_rho": rho,
        "quintile_spread": spread,
    }
    return df, summary
