"""
Chaos for training and the stress suite of the promotion gate (brain/spec/stress.yaml).

    c = sample_training_chaos(rng, hours)            # one draw of training_chaos for a day (hours = its hour starts, epoch s)
    for s in scenarios(): s.name, s.dates, s.chaos   # the named stress scenarios, as data
    res = run_suite(entry, exit)                     # every scenario through the batch evaluator -> {name: metrics}
    res = run_scenario(crash_rugwave_replay(), entry, exit)

Each scenario replays the same 1 SOL / 5-slot / one-per-coin / 0.5 SOL daily-loss paper account on the rebuilt simulator
with a Chaos (params.Chaos) on top of the base sim. held_out_test is in the list for completeness: run it once per frozen
candidate, never to tune.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from brain.data import splits
from brain.data.loaders import data_dir
from brain.sim.params import Chaos

SELECTION_DAYS = ("2026-10-31", "2026-11-01")  # splits.yaml selection (stress.yaml was written before the split moved)
# stress.yaml dead_pool_on_stale_exit
DEAD_POOL_BASE = {"pumpswap": 0.958, "pumpfun": 0.034, "other": 0.125}
DEAD_POOL_UPPER = {"pumpswap": 1.0, "pumpfun": 0.2, "other": 0.3}
SPIKE_MULT, SPIKE_P = (1.0, 3.41, 7.49, 27.14), (0.85, 0.10, 0.04, 0.01)
CRASH_FILE = "research/regimes-chaos/stress_scenarios.json"


@dataclass(frozen=True)
class Scenario:
    name: str
    dates: tuple[str, ...]        # UTC days whose signals are replayed
    chaos: Chaos
    hours: tuple[str, ...] = ()   # replay only signals in these hour starts (crash_hours)
    why: str = ""


def selection_days() -> tuple[str, ...]:
    p = splits.period("selection")
    return tuple(d.strftime("%Y-%m-%d") for d in pd.date_range(p.start, p.end - pd.Timedelta(seconds=1), freq="D"))


def test_days() -> tuple[str, ...]:
    """Test days with signals: a buy's 24 h window must end before the label end (crosses_outage), so the day after is empty."""
    from brain.sim.evaluate import data_end_ts
    last = (data_end_ts() - pd.Timedelta(hours=24) - pd.Timedelta(seconds=1)).normalize()
    return tuple(d.strftime("%Y-%m-%d") for d in pd.date_range(splits.test_start(), last, freq="D"))


def hour_starts(days) -> np.ndarray:
    return np.concatenate([np.arange(int(pd.Timestamp(d, tz="UTC").timestamp()), int(pd.Timestamp(d, tz="UTC").timestamp()) + 86400, 3600)
                           for d in days]) if len(days) else np.zeros(0, dtype=np.int64)


def backlog(days, per_day: int = 1, seed: int = 0) -> frozenset:
    """`per_day` random backlog-outage hours per day."""
    rng = np.random.default_rng(seed)
    out = []
    for d in days:
        h = hour_starts([d])
        out.extend(rng.choice(h, size=per_day, replace=False).tolist())
    return frozenset(int(x) for x in out)


def spikes(days, mult: float, hours_per_day: int, seed: int = 0) -> dict:
    """A priority-fee spike of `mult` for a run of `hours_per_day` hours on each day."""
    rng = np.random.default_rng(seed)
    out = {}
    for d in days:
        h = hour_starts([d])
        s = int(rng.integers(0, max(1, 24 - hours_per_day + 1)))
        out.update({int(x): mult for x in h[s:s + hours_per_day]})
    return out


def sample_training_chaos(rng: np.random.Generator, hours) -> Chaos:
    """One draw of stress.yaml training_chaos (per episode-day; windowed effects per hour)."""
    hours = np.asarray(hours, dtype=np.int64)
    spike = {}
    i = 0
    while i < len(hours):  # runs of mean ~2.2 h
        m = float(rng.choice(SPIKE_MULT, p=SPIKE_P))
        run = int(min(7, rng.geometric(1 / 2.2)))
        if m > 1:
            spike.update({int(h): m for h in hours[i:i + run]})
        i += run
    thin = rng.random() < 0.3
    return Chaos(
        delay_mult=float(rng.choice([1.0, 2.0, 4.0], p=[0.7, 0.2, 0.1])),
        tail_p=0.01, tail_s=(15.0, 60.0),
        backlog_hours=frozenset(int(h) for h in hours[rng.random(len(hours)) < 0.031]),
        slip_mult=float(np.exp(rng.uniform(np.log(0.5), np.log(3.0)))),
        tx_cost_sol=float(rng.uniform(0.0003, 0.0008)),
        tx_spike=spike,
        rug_rate=float(rng.uniform(0.0, 0.10)),
        dead_pool={"pumpswap": float(rng.uniform(0.90, 1.0)), "pumpfun": float(rng.uniform(0.0, 0.2)), "other": float(rng.uniform(0.0, 0.3))},
        quote_haircut=True,
        sell_fail_p=float(rng.uniform(0.245, 0.5)),
        buy_fail_p=float(rng.uniform(0.098, 0.2)),
        dropout_p=float(rng.uniform(0.0, 0.3)),
        universe_keep=float(rng.uniform(0.1, 0.5)) if thin else 1.0,
    )


# ------------------------------------------------------------------------------------------------------------ scenarios
def base_selection() -> Scenario:
    return Scenario("base_selection", selection_days(), Chaos(), why="base sim, chaos off")


def crash_rugwave_replay() -> Scenario:
    return Scenario("crash_rugwave_replay", ("2026-10-17", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30"),
                    Chaos(dead_pool=DEAD_POOL_UPPER, rug_rate=0.064), why="worst train block (+ 10-17), dead_pool upper ends, rug 0.064")


def worst_day_alt() -> Scenario:
    return Scenario("worst_day_alt", ("2026-10-17", "2026-10-25"), Chaos())


def good_control() -> Scenario:
    return Scenario("good_control", ("2026-10-19", "2026-10-20", "2026-11-01"), Chaos(), why="a policy that only wins here is regime-fitted")


def crash_hours() -> Scenario:
    """The 21 crash hours of regimes-chaos replayed on their own signals and tapes (their conditions, not injected)."""
    f = data_dir() / CRASH_FILE
    hours = tuple(json.loads(f.read_text())["scenarios"]["crash_replay"]["crash_hours"]) if f.is_file() else ()
    days = tuple(sorted({h[:10] for h in hours}))
    return Scenario("crash_hours", days, Chaos(), hours=hours)


def delay_x4() -> Scenario:
    d = selection_days()
    return Scenario("delay_x4", d, Chaos(delay_mult=4.0, tail_p=0.05, backlog_hours=backlog(d, 1)))


def fee_spike() -> Scenario:
    d = selection_days()
    return Scenario("fee_spike", d, Chaos(tx_cost_sol=0.0008, tx_spike=spikes(d, 7.49, 7)))


def dead_pool_extreme() -> Scenario:
    return Scenario("dead_pool_extreme", selection_days(), Chaos(dead_pool={"pumpswap": 1.0, "pumpfun": 0.2, "other": 0.3}))


def sell_outage() -> Scenario:
    return Scenario("sell_outage", selection_days(), Chaos(sell_fail_p=0.5, sell_retry_p50_s=1800.0), why="Jupiter 429 storm")


def thin_universe() -> Scenario:
    return Scenario("thin_universe", selection_days(), Chaos(universe_keep=0.2), why="tracked_universe_shrink toward 1k wallets/hour")


def feature_dropout_30() -> Scenario:
    return Scenario("feature_dropout_30", selection_days(), Chaos(dropout_p=0.3),
                    why="exit-state dropout 0.3; entry-feature structural missingness is the feature pipeline's (entry policy)")


def cold_ledger() -> Scenario:
    return Scenario("cold_ledger", selection_days(), Chaos(), why="entry policy must be evaluated with cp_* missing (cp_n_7d = 0): a feature-side switch")


def combined_worst() -> Scenario:
    d = ("2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30")
    return Scenario("combined_worst", d, Chaos(delay_mult=2.0, slip_mult=2.0, tx_cost_sol=0.0008, tx_spike={h: 3.41 for h in hour_starts(d).tolist()},
                                               dead_pool=DEAD_POOL_UPPER, rug_rate=0.064, dropout_p=0.3, backlog_hours=backlog(d, 1),
                                               universe_keep=0.2))


def held_out_test() -> Scenario:
    return Scenario("held_out_test", test_days(), Chaos(), why="run ONCE per frozen candidate; signals end 24 h before the label end")


SCENARIOS = (base_selection, crash_rugwave_replay, worst_day_alt, good_control, crash_hours, delay_x4, fee_spike, dead_pool_extreme,
             sell_outage, thin_universe, feature_dropout_30, cold_ledger, combined_worst, held_out_test)


def scenarios(include_test: bool = False) -> list[Scenario]:
    out = [f() for f in SCENARIOS]
    return out if include_test else [s for s in out if s.name != "held_out_test"]


def run_scenario(s: Scenario, entry, exit, params=None, seed: int = 0, con=None, B: int = 500) -> dict:
    """Load the scenario's days (one window per contiguous run of days) and score the policies under its chaos."""
    from brain.data import connect
    from brain.sim.evaluate import evaluate, load_window
    con = con or connect()
    days = sorted(pd.Timestamp(d, tz="UTC") for d in s.dates)
    runs, cur = [], [days[0]] if days else []
    for d in days[1:]:
        if d - cur[-1] == pd.Timedelta(days=1):
            cur.append(d)
        else:
            runs.append(cur)
            cur = [d]
    if cur:
        runs.append(cur)
    out = {}
    for r in runs:
        where = ""
        if s.hours:
            hs = [h for h in s.hours if r[0] <= pd.Timestamp(h) < r[-1] + pd.Timedelta(days=1)]
            if not hs:
                continue
            where = "date_trunc('hour', ts) IN (" + ", ".join(f"TIMESTAMPTZ '{pd.Timestamp(h).isoformat()}'" for h in hs) + ")"
        w = load_window(r[0], r[-1] + pd.Timedelta(days=1), con=con, params=params, chaos=s.chaos, seed=seed, where=where)
        if not w.meta["signals"]:  # e.g. 10-17: no leader was known to the server yet (known_at_t)
            out[f"{r[0]:%Y-%m-%d}..{r[-1]:%Y-%m-%d}"] = {"signals": 0}
            continue
        res = evaluate(w, entry, exit, params, s.chaos, seed, B=B)
        out[f"{r[0]:%Y-%m-%d}..{r[-1]:%Y-%m-%d}"] = res.metrics
    return {"scenario": s.name, "why": s.why, "chaos": {k: (sorted(v) if isinstance(v, frozenset) else v) for k, v in s.chaos.__dict__.items()},
            "runs": out}


def run_suite(entry, exit, params=None, seed: int = 0, include_test: bool = False, names=None) -> dict:
    sc = [s for s in scenarios(include_test) if names is None or s.name in names]
    return {s.name: run_scenario(s, entry, exit, params, seed) for s in sc}
