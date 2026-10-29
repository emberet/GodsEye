"""Job settings. Every value can be overridden with an env var QUANT_<NAME upper>."""

from __future__ import annotations

import os
from dataclasses import dataclass, fields


@dataclass(frozen=True)
class QuantConfig:
    window_days: float = 30.0
    min_trades: int = 30  # minimum closed trades before any verdict other than 'insufficient'
    fdr_alpha: float = 0.05  # Benjamini-Hochberg level
    max_best_share: float = 0.5  # best trade's share of gross profit above this blocks 'skill'
    min_persistence_rho: float = (
        -1.0
    )  # optional population Spearman gate (-1 = off); per-wallet persistence always applies
    min_dsr: float = 0.0  # optional Deflated Sharpe gate (0 = off)
    prior_strength: float = 20.0  # pseudo-trades for Bayesian shrinkage
    n_perm: int = 2000
    n_boot: int = 2000
    ruin_paths: int = 1000
    ruin_horizon: int = 100
    ruin_level: float = 0.5  # equity falling below this fraction counts as ruin
    kelly_fraction: float = 0.25  # hard ceiling: never above quarter Kelly
    ttl_hours: float = 6.0  # sizing rows are valid for this long
    seed: int = 7
    # Phase 4: consume the Rust ge-analyze tables (backtest_results, wallet_clusters). off|on, default off.
    use_flow: str = "off"
    flow_max_age_hours: float = 48.0  # flow/backtest rows older than this count as missing
    # 1 = leave out wallets the agent flagged as bots (wallets.junk_reason 'bot:...') unless copied: never copied,
    # and they hold most of the trades (the job ran out of memory on them)
    skip_bots: int = 1

    @classmethod
    def from_env(cls) -> QuantConfig:
        kw = {}
        for f in fields(cls):
            v = os.environ.get(f"QUANT_{f.name.upper()}")
            if v not in (None, ""):
                kw[f.name] = type(f.default)(v)
        cfg = cls(**kw)
        if cfg.kelly_fraction > 0.25 or cfg.kelly_fraction < 0:
            raise ValueError("kelly_fraction must be within [0, 0.25]")
        if cfg.use_flow not in ("off", "on"):
            raise ValueError("QUANT_USE_FLOW must be off or on")
        return cfg
