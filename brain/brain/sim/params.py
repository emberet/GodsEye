"""
The simulator's numbers: SimParams (brain/spec/sim.yaml `params`, the evidence is the prose above it) and Chaos (the
knobs of brain/spec/stress.yaml: training chaos and the stress scenarios). Defaults = the base simulator, chaos off.

    from brain.sim.params import SimParams, Chaos
    p = SimParams.load()                 # sim.yaml params (every key must be a field here)
    c = Chaos(delay_mult=2.0, slip_mult=2.0)

Random draws are keyed by (episode id, stream, attempt) through `uniform()` (a splitmix64 hash), not by batch order: the
same signal gets the same delay, buy failure and haircut under every policy (common random numbers, so policy
differences are paired) and in any batch composition.
"""
from __future__ import annotations

import math
from dataclasses import asdict, dataclass, field, fields, replace
from functools import lru_cache
from pathlib import Path

import numpy as np
import yaml

SPEC = Path(__file__).resolve().parents[2] / "spec" / "sim.yaml"


@dataclass(frozen=True)
class SimParams:
    bankroll_sol: float = 1.0
    max_trade_sol: float = 0.1
    min_trade_sol: float = 0.01
    max_positions: int = 5
    daily_loss_sol: float = 0.5
    tx_cost_sol: float = 0.0003
    rent_sol: float = 0.00204
    fee_bps: float = 100.0
    default_depth_sol: float = 30.0
    depth_window_s: float = 600.0
    entry_land_mu: float = 1.442
    entry_land_sigma: float = 0.557
    exit_land_mu: float = 1.442
    exit_land_sigma: float = 0.557
    lateness_mu: float = -0.261
    lateness_sigma: float = 1.338
    entry_after_decision_s: float = 1.0
    max_copy_delay_s: float = 60.0
    swap_level_s: float = 86400.0
    price_event_gap_s: float = 15.0
    minute_s: float = 60.0
    fresh_s: float = 90.0
    forward_price_s: float = 10.0
    alive_lookahead_s: float = 21600.0
    no_route_below: float = 0.10
    no_route_mark: float = 0.001
    dead_after_fails: int = 3
    hard_stop: float = 0.60
    max_hold_s: float = 86400.0
    sell_resid_slip: float = 0.0069
    buy_fail_p: float = 0.098
    sell_fail_p: float = 0.0
    sell_retry_mu: float = 5.652
    sell_retry_sigma: float = 3.28
    null_entry_window_s: float = 120.0
    null_entry_dead_s: float = 600.0
    bad_print_x: float = 20.0
    fill_mode: str = "quote"

    @classmethod
    def load(cls, path: Path = SPEC, **over) -> "SimParams":
        return replace(_load(path), **over)

    def to_dict(self) -> dict:
        return asdict(self)


@lru_cache(maxsize=4)
def _load(path: Path) -> SimParams:
    raw = yaml.safe_load(Path(path).read_text()).get("params", {})
    known = {f.name: f.type for f in fields(SimParams)}
    unknown = set(raw) - set(known)
    if unknown:
        raise KeyError(f"sim.yaml params not in SimParams: {sorted(unknown)}")
    cast = {k: (str(v) if known[k] == "str" else int(v) if known[k] == "int" else float(v)) for k, v in raw.items()}
    return SimParams(**cast)


@dataclass(frozen=True)
class Chaos:
    """
    Stress / training-chaos knobs (stress.yaml). Every field at its default = the base simulator.

    delay_mult        x the entry and exit land delays (training: 1/2/4 with p 0.7/0.2/0.1)
    tail_p, tail_s    a stream tail: with probability tail_p an extra uniform(tail_s) seconds on the entry delay
    backlog_hours     hour starts (epoch s) of backlog outages: every signal in the hour is > 60 s late (gated too_late),
                      exit decisions in it land `backlog_lateness_s` later
    slip_mult         x the residual sell slippage, and the entry fill error (mean +0.89 %) scaled by (slip_mult - 1)
    tx_cost_sol       per-transaction cost (None = SimParams.tx_cost_sol); tx_spike {hour start: multiplier}
    rug_rate          probability a position is rugged at a uniform minute 1..60 after entry (price -95..-100 %, sells
                      return 0-5 % of the entry value, no route after)
    dead_pool         {venue group: p} an exit priced on a tracked tape > 60 min old is worth 0 with probability p
    quote_haircut     draw a per-sale haircut from the fresh-tape quote residual (median -0.33 %, p10 -10.6 %, 4.5 % > 90 %)
    sell_fail_p       per sale attempt (None = SimParams); sell_retry_p50_s overrides the retry delay median
    buy_fail_p        None = SimParams
    dropout_p         each exit-state feature is NaN (missing) with this probability per decision; dropout_features
                      limits it to those names (empty = every continuous feature)
    universe_keep     keep this share of tracked wallets in the tape (tracked_universe_shrink); applied when the tape is
                      built (Market.thin)
    """
    delay_mult: float = 1.0
    tail_p: float = 0.0
    tail_s: tuple[float, float] = (15.0, 60.0)
    backlog_hours: frozenset = frozenset()
    backlog_lateness_s: float = 1045.0
    slip_mult: float = 1.0
    tx_cost_sol: float | None = None
    tx_spike: dict = field(default_factory=dict)
    rug_rate: float = 0.0
    dead_pool: dict = field(default_factory=dict)
    quote_haircut: bool = False
    sell_fail_p: float | None = None
    sell_retry_p50_s: float | None = None
    buy_fail_p: float | None = None
    dropout_p: float = 0.0
    dropout_features: tuple[str, ...] = ()
    universe_keep: float = 1.0

    @property
    def is_base(self) -> bool:
        return self == Chaos()


ENTRY_ERR_MEAN = 0.0089  # real buy fills vs model.ts buyFill, mean (sim-fidelity C2); scaled by slip_mult - 1 under chaos


# --------------------------------------------------------------------------------------------------------- random draws
_M1, _M2, _G = np.uint64(0xBF58476D1CE4E5B9), np.uint64(0x94D049BB133111EB), np.uint64(0x9E3779B97F4A7C15)
STREAMS = {"lateness": 1, "entry_land": 2, "buy_fail": 3, "tail": 4, "tail_s": 5, "exit_land": 6, "sell_fail": 7, "retry": 8,
           "rug": 9, "rug_min": 10, "rug_left": 11, "rug_drop": 12, "dead_pool": 13, "haircut": 14, "dropout": 15}


def _mix(x: np.ndarray) -> np.ndarray:
    with np.errstate(over="ignore"):
        x = x + _G
        x = (x ^ (x >> np.uint64(30))) * _M1
        x = (x ^ (x >> np.uint64(27))) * _M2
        return x ^ (x >> np.uint64(31))


def uniform(key, stream: str, seed: int = 0, attempt=0) -> np.ndarray:
    """Uniform [0, 1) draws keyed by (key, stream, seed, attempt): deterministic per signal, independent across streams."""
    k = np.asarray(key).astype(np.int64).astype(np.uint64)
    a = np.asarray(attempt).astype(np.int64).astype(np.uint64)
    with np.errstate(over="ignore"):
        x = _mix(k ^ _mix(np.uint64(STREAMS[stream]) + np.uint64(seed) * np.uint64(1_000_003)))
        x = _mix(x ^ (a * np.uint64(0x2545F4914F6CDD1D)))
    return (x >> np.uint64(11)).astype(np.float64) / float(1 << 53)


def lognormal(u: np.ndarray, mu: float, sigma: float) -> np.ndarray:
    """exp(mu + sigma * z) with z the normal quantile of u (keeps draws keyed: no generator state)."""
    from scipy.special import ndtri
    return np.exp(mu + sigma * ndtri(np.clip(u, 1e-12, 1 - 1e-12)))


def lognormal_median(p50: float, mu: float, sigma: float) -> float:
    """mu that moves a lognormal's median to p50, keeping sigma (for overrides like sell_retry_p50_s)."""
    return math.log(p50) if p50 > 0 else mu
