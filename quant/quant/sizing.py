"""Fractional-Kelly sizing parameters. Output is a multiplier the agent may only use to REDUCE size."""

from __future__ import annotations

import numpy as np
import pandas as pd

from .config import QuantConfig


def max_drawdown(r: np.ndarray, f: float) -> float:
    """Worst peak-to-trough loss of equity compounding each return at stake fraction f (unit stake if f == 0)."""
    eq = np.cumprod(1 + (f if f > 0 else 1.0) * r)
    eq = np.concatenate([[1.0], np.maximum(eq, 0.0)])
    peak = np.maximum.accumulate(eq)
    return float(np.max(1 - eq / peak))


def risk_of_ruin(r: np.ndarray, f: float, cfg: QuantConfig, rng: np.random.Generator) -> float:
    if f <= 0 or len(r) == 0:
        return 0.0
    paths = rng.choice(r, (cfg.ruin_paths, cfg.ruin_horizon))
    eq = np.cumprod(1 + f * paths, axis=1)
    return float((eq.min(axis=1) < cfg.ruin_level).mean())


def sizing_rows(trades: pd.DataFrame, cfg: QuantConfig, now: int) -> list[dict]:
    rng = np.random.default_rng(cfg.seed + 1)
    pooled_var = float(trades["ret"].var(ddof=1)) if len(trades) > 1 else 1.0
    if not np.isfinite(pooled_var) or pooled_var <= 0:
        pooled_var = 1.0
    k = cfg.prior_strength
    valid_until = now + int(cfg.ttl_hours * 3600)
    out = []
    for w, g in trades.groupby("wallet"):
        r = g["ret"].to_numpy()
        n = len(r)
        row = {
            "leader": w,
            "computed_at": now,
            "valid_until": valid_until,
            "n": n,
            "edge": None,
            "vol": None,
            "kelly_full": 0.0,
            "kelly_mult": 0.0,
            "max_drawdown": None,
            "risk_of_ruin": None,
        }
        if n >= 2:
            edge = float(r.sum() / (n + k))  # mean shrunk toward zero edge
            var = float((n * r.var(ddof=1) + k * pooled_var) / (n + k))  # variance shrunk toward the pool
            kelly_full = max(0.0, edge / var) if var > 0 else 0.0
            row.update(edge=edge, vol=float(np.sqrt(var)), kelly_full=kelly_full)
            if n >= cfg.min_trades and edge > 0:
                row["kelly_mult"] = float(min(1.0, max(0.0, cfg.kelly_fraction * kelly_full)))
            row["max_drawdown"] = max_drawdown(r, row["kelly_mult"])
            row["risk_of_ruin"] = risk_of_ruin(r, row["kelly_mult"], cfg, rng)
        out.append(row)
    return out
