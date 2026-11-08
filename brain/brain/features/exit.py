"""
The exit features of an open position at decision time t (features.yaml `exit`): what the simulator calls with its path
state and what paper.ts computes from ExitState. spec/golden/exit.json pins both sides.

Inputs (one dict per decision, or a frame with one column per key for many):

    ret_now, peak_ret, minutes_held, minutes_since_price, mins_since_tracked_price, ret_5m_ago,
    minutes_since_leader_sold                                  floats (ExitState)
    leader_sold, half_sold, quote_failed                       0/1
    sell_quote_ratio, leader_sold_frac                         float or NaN/None (missing)
    tokens, tokens_left                                        the position (tokens bought, tokens left)
    venue                                                      the entry swap's venue
    oth_buyers_5m, oth_sellers_5m, oth_net_sol_5m, pts_5m      the mint's tracked flow in [t - 5 min, t), from flow()
    active_wallets_1h                                          StreamState.activeWallets1h(t), NaN/None when missing
    leader_ps_r_7d                                             the entry's ps_r_7d, NaN/None when missing

    from brain.features import exit as fx
    raw = fx.exit_raw(inputs)                     # {feature: raw value} or a frame of them
    Z = fx.exit_matrix(frame, norm)               # normalised [n, columns] for the network

The simulator's Decision.state (brain/sim/engine.py: EXIT_STATE + FLOW_STATE, a dict of arrays) works as is: where the
inputs above are absent, a feature given under its own name is taken as it is (mom5, position, entry_venue_pumpswap,
entry_tracked_active_wallets_1h), and `<name>_missing` = 1 marks `<name>` missing (the engine's sell_quote_ratio_missing).
drawdown_from_peak is always recomputed from ret_now and peak_ret. active_wallets_1h(t) gives the hourly count offline.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from brain.features import spec
from brain.features.entry import msec, strip_venue

FLOW_SEC = 300.0
TRACKED_CAP_MIN = 1440.0
LOG_FLOOR = 1e-9


def flow(ring: list[dict], t_ms: int, leader: str | None, window_ms: int = int(FLOW_SEC * 1000)) -> dict:
    """
    The mint's tracked crowd in [t - window, t) delivered before t (ring rows {wallet, side, sol, price, ts, at, ok},
    times as epoch ms or ISO; t in epoch ms): oth_* leave the leader out, pts_5m counts everyone's ok swaps.
    """
    buyers, sellers, net, pts = set(), set(), 0.0, 0
    for r in ring:
        ts, at = msec(r["ts"]), msec(r["at"])
        if not (t_ms - window_ms <= ts < t_ms) or not at < t_ms:
            continue
        if r["ok"]:
            pts += 1
        if r["wallet"] == leader:
            continue
        if r["side"] == "buy":
            buyers.add(r["wallet"])
            net += float(r["sol"])
        else:
            sellers.add(r["wallet"])
            net -= float(r["sol"])
    return {"oth_buyers_5m": float(len(buyers)), "oth_sellers_5m": float(len(sellers)), "oth_net_sol_5m": net,
            "pts_5m": float(pts)}


def _col(f: pd.DataFrame, name: str, default=np.nan) -> np.ndarray:
    if name not in f:
        return np.full(len(f), default, dtype=np.float64)
    return pd.to_numeric(f[name], errors="coerce").to_numpy(dtype=np.float64)


def _vectors(inputs: dict) -> bool:
    return any(isinstance(v, (np.ndarray, pd.Series, list)) for v in inputs.values())


def exit_raw(inputs: dict | pd.DataFrame) -> dict | pd.DataFrame:
    """Raw exit features (NaN = missing) from the inputs above; one decision (a dict of scalars) gives a dict, a frame or
    a dict of arrays (the simulator's Decision.state) a frame."""
    one = isinstance(inputs, dict) and not _vectors(inputs)
    f = pd.DataFrame([inputs]) if one else pd.DataFrame(inputs) if isinstance(inputs, dict) else inputs
    ret, peak = _col(f, "ret_now"), _col(f, "peak_ret")
    with np.errstate(divide="ignore", invalid="ignore"):
        dd = np.where(1.0 + peak > 0, np.maximum(0.0, 1.0 - (1.0 + ret) / (1.0 + peak)), 0.0)
        if "ret_5m_ago" in f or "mom5" not in f:
            mom = np.log(np.maximum(LOG_FLOOR, 1.0 + ret)) - np.log(np.maximum(LOG_FLOOR, 1.0 + _col(f, "ret_5m_ago", 0.0)))
        else:
            mom = _col(f, "mom5")
        if "tokens" in f or "position" not in f:
            tokens, left = _col(f, "tokens"), _col(f, "tokens_left")
            position = np.where(tokens > 0, left / tokens, 1.0)
        else:
            position = _col(f, "position")
    if "venue" in f or "entry_venue_pumpswap" not in f:
        venue = f["venue"].tolist() if "venue" in f else [None] * len(f)
        pumpswap = np.array([1.0 if (strip_venue(v)[0] or "").startswith("pumpswap") else 0.0 for v in venue])
    else:
        pumpswap = _col(f, "entry_venue_pumpswap", 0.0)
    aw = _col(f, "active_wallets_1h") if "active_wallets_1h" in f else _col(f, "entry_tracked_active_wallets_1h")
    lsf = _col(f, "leader_sold_frac")
    out = pd.DataFrame({
        "ret_now": ret,
        "peak_ret": peak,
        "drawdown_from_peak": dd,
        "minutes_held": _col(f, "minutes_held"),
        "leader_sold": _col(f, "leader_sold", 0.0),
        "half_sold": _col(f, "half_sold", 0.0),
        "minutes_since_price": _col(f, "minutes_since_price"),
        "position": position,
        "mins_since_tracked_price": np.minimum(_col(f, "mins_since_tracked_price"), TRACKED_CAP_MIN),
        "quote_failed": _col(f, "quote_failed", 0.0),
        "sell_quote_ratio": _col(f, "sell_quote_ratio"),
        "mom5": mom,
        "oth_buyers_5m": _col(f, "oth_buyers_5m", 0.0),
        "oth_sellers_5m": _col(f, "oth_sellers_5m", 0.0),
        "oth_net_sol_5m": _col(f, "oth_net_sol_5m", 0.0),
        "pts_5m": _col(f, "pts_5m", 0.0),
        "leader_sold_frac": np.where(np.isfinite(lsf), np.clip(lsf, 0.0, 1.0), 0.0),
        "minutes_since_leader_sold": _col(f, "minutes_since_leader_sold", 0.0),
        "entry_venue_pumpswap": pumpswap,
        "entry_tracked_active_wallets_1h": aw,
        "leader_ps_r_7d": _col(f, "leader_ps_r_7d"),
    }, index=f.index)
    for b in ("leader_sold", "half_sold", "quote_failed"):
        out[b] = (out[b] > 0).astype(np.float64)
    for name in out.columns:  # an explicit missing flag wins over the value next to it
        flag = _col(f, f"{name}_missing", 0.0)
        out[name] = np.where(flag > 0, np.nan, out[name].to_numpy(dtype=np.float64))
    return {k: float(v) for k, v in out.iloc[0].items()} if one else out


def active_wallets_1h(t_ms, hourly: pd.Series | None = None) -> np.ndarray:
    """
    entry_tracked_active_wallets_1h offline at exit decision times (epoch ms): the previous complete UTC hour's count
    from the feature build (derived/active_wallets_hourly.parquet unless `hourly` is given), NaN outside the data.
    """
    from brain.features import build

    hourly = build.load_hourly() if hourly is None else hourly
    return build.active_wallets_at(np.asarray(t_ms, dtype=np.int64) // 1000, hourly)


def exit_matrix(inputs: dict | pd.DataFrame, norm: spec.Norm) -> np.ndarray:
    """Normalised exit vectors [n, columns] (exit features have no categoricals)."""
    raw = exit_raw(inputs)
    X = spec.encode(raw, spec.exit_features())
    return spec.normalise(X, norm)


def case_inputs(case: dict) -> dict:
    """A golden exit case (ExitState, position, ring, ...) as exit_raw's inputs."""
    t = msec(case["now"])
    s = dict(case["state"])
    p = case["position"]
    s.update({"tokens": p["tokens"], "tokens_left": p["tokens_left"], "venue": p.get("venue")})
    s.update(flow(case.get("ring", []), t, p.get("leader")))
    s["active_wallets_1h"] = case.get("active_wallets_1h")
    s["leader_ps_r_7d"] = case.get("leader_ps_r_7d")
    for k in ("leader_sold", "half_sold", "quote_failed"):
        s[k] = 1.0 if s.get(k) else 0.0
    return {k: (np.nan if v is None else v) for k, v in s.items()}
