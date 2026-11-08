"""
Grounding paper rewards before they train anything (report section 2, "the tape can't see dead coins").

The paper account closes a position at its own mark. When that mark was stale (no tracked print for > 90 s) and the coin
never trades again, the paper P&L is the old tape price of an unsellable coin: exactly the artifact that turned a
losing strategy into "+34.9 SOL a week". ground_rewards re-values such rows the way sim.yaml values a sale (grounded:
no ok tracked print within 6 h after the close = dead = written off, the rent lost) before a fine-tune uses them.

    tr = ground_rewards(transitions, tape, params)   # rows: mint, close_ms, stake, reward, mark_age_s (NaN = unknown)
    tr["grounded"]                                   # True where the reward was replaced

`from_brain_transitions` turns the server's brain_transitions rows (CONTRACT.md) into that shape: one row per closed
position, the entry row's features, the closing row's reward, and the mark age from the closing row's info.mark_age_s
(paper.ts should log it; without it every close of a coin that then went dark is treated as stale).
"""
from __future__ import annotations

import json

import numpy as np
import pandas as pd

from brain.sim.params import SimParams


def ground_rewards(tr: pd.DataFrame, tape, p: SimParams | None = None) -> pd.DataFrame:
    p = p or SimParams()
    tr = tr.copy()
    if not len(tr):
        tr["grounded"] = np.zeros(0, bool)
        return tr
    m = tape.codes(tr["mint"])
    t = tr["close_ms"].to_numpy(np.int64)
    alive, cens = tape.alive(m, t, int(p.alive_lookahead_s * 1000))
    age = tr["mark_age_s"].to_numpy(np.float64) if "mark_age_s" in tr else np.full(len(tr), np.nan)
    stale = ~(age <= p.fresh_s)  # NaN (unknown) counts as stale
    dead = (m >= 0) & ~alive & ~cens & stale
    write_off = -(tr["stake"].to_numpy(np.float64) + 2 * p.tx_cost_sol + p.rent_sol)
    rep = tr["reward"].to_numpy(np.float64)
    tr["reward_reported"] = rep
    tr["reward"] = np.where(dead, np.minimum(rep, write_off), rep)
    tr["grounded"] = dead & (rep > write_off)
    return tr


def from_brain_transitions(rows: pd.DataFrame, feature_names) -> pd.DataFrame:
    """brain_transitions (CONTRACT.md) -> one row per closed position: features, stake, reward, close_ms, mark_age_s."""
    if not len(rows):
        return pd.DataFrame(columns=["position_id", "mint", "stake", "reward", "close_ms", "mark_age_s", *feature_names])
    r = rows.copy()
    r["info_d"] = r["info"].map(lambda s: json.loads(s) if isinstance(s, str) and s else (s or {}))
    ent = r[(r["kind"] == "entry") & (r["done"] == 1) & r["reward"].notna()]
    ent = ent[ent["info_d"].map(lambda d: not d.get("blocked"))]
    last = r[(r["kind"] == "exit") & (r["done"] == 1)].sort_values("id").groupby("position_id").tail(1)
    j = ent.merge(last[["position_id", "ts", "info_d"]], on="position_id", how="inner", suffixes=("", "_close"))
    feats = np.array([json.loads(f) if isinstance(f, str) else f for f in j["features"]], dtype=object)
    out = pd.DataFrame({"position_id": j["position_id"].to_numpy(), "mint": j["mint"].to_numpy(),
                        "stake": j.apply(lambda x: float(x["action"]) * float(x["info_d"].get("base_size_sol", 0.1)), axis=1).to_numpy(),
                        "reward": j["reward"].to_numpy(np.float64),
                        "close_ms": (pd.to_datetime(j["ts_close"], utc=True).astype("int64") // 10**6).to_numpy(),
                        "mark_age_s": j["info_d_close"].map(lambda d: d.get("mark_age_s", np.nan)).to_numpy(np.float64)})
    for k, name in enumerate(feature_names):
        out[name] = [float(f[k]) if f is not None and len(f) > k and f[k] is not None else np.nan for f in feats]
    from brain.sim.tape import T0_MS
    out["close_ms"] = out["close_ms"] - T0_MS
    return out
