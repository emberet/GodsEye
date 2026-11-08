"""
One episode's server state rebuilt from the offline tables, in the golden case shape (entry.py docstring): what the
live server would hold at t = T + lag if its stream and DB had been what the export shows, with every swap counted from
its insert time (ins_ts). Slow and literal on purpose: the tests run entry.entry_raw on it for every episode of a
synthetic set and compare with the vectorised build (build.py), so this file is the written-out mapping

    ring           the mint's swaps with ts in [T - 60 min, t) stored before t
    hist_max       the highest ok price with ts in [T - 7 d, T - 60 min) stored before t
    first_seen     sighting S = the mint's first insert time; first_seen_at = the earliest ts stored by S within 7 d
                   (else S); first ok price (sol >= 0.01) among those rows by (ts, slot, id), else the first stored later
    leader_holding sells by the leader after the buy (okey order) with ts >= T stored before t
    db             the leader's stored swaps; token_info; other sighted mints of the creator
    ledgers        the build's ledger rows of the leader (their `at` is resolved_at / avail_at)

Inputs: sw (id, wallet, mint, side, t, a, okey, sol, price, tokens, ok, venue, fee_lamports), the episode's
leader_pos_tokens, ledger rows (kind, leader, at, v, lr), token_info (mint, creator, pool_created_at,
launch_checked_at; epoch seconds), hourly active wallets (build.active_hours: by hour start, NaN = no process saw it).
"""
from __future__ import annotations

from datetime import datetime, timezone

import numpy as np
import pandas as pd

W7 = 7 * 86_400
RING = 3_600
FIRST_PRICE_MIN_SOL = 0.01


def iso(sec: float) -> str:
    d = datetime.fromtimestamp(float(sec), timezone.utc)
    return d.strftime("%Y-%m-%dT%H:%M:%S.") + f"{d.microsecond // 1000:03d}Z"


def ms(sec: float) -> float:
    return float(sec) * 1000.0


def _f(v):
    return None if v is None or (isinstance(v, float) and np.isnan(v)) else v


def sighting(ms_: pd.DataFrame) -> tuple[float, float, float | None, float | None]:
    """(S, first_seen_at, first ok price, first ok price at) of one mint's swaps (ok flags given)."""
    S = float(ms_["a"].min())
    at = ms_[(ms_["a"] <= S) & (ms_["t"] >= S - W7)]
    fts = float(at["t"].min()) if len(at) else S
    q = ms_[ms_["ok"] & (ms_["sol"] >= FIRST_PRICE_MIN_SOL)]
    p0 = q[(q["a"] <= S) & (q["t"] >= S - W7)].sort_values("okey")
    if len(p0):
        return S, fts, float(p0["price"].iloc[0]), float(p0["t"].iloc[0])
    p1 = q[q["a"] > S].sort_values(["a", "okey"])
    if len(p1):
        return S, fts, float(p1["price"].iloc[0]), float(p1["a"].iloc[0])
    return S, fts, None, None


def offline_case(sw: pd.DataFrame, episode_id: int, leader_pos_tokens: float, ledger: pd.DataFrame,
                 token_info: pd.DataFrame, hourly: pd.Series, lag: int = 1) -> dict:
    e = sw[sw["id"] == episode_id].iloc[0]
    T = int(e["t"])
    now = T + lag
    mint, leader = e["mint"], e["wallet"]
    m = sw[sw["mint"] == mint].sort_values("okey")
    stored = m[m["a"] < now]

    ring = [{"wallet": r.wallet, "side": r.side, "sol": float(r.sol), "price": float(r.price), "ts": ms(r.t), "at": ms(r.a),
             "ok": bool(r.ok)} for r in stored[stored["t"] >= T - RING].itertuples()]
    old = stored[stored["ok"] & (stored["t"] >= T - W7) & (stored["t"] < T - RING)]
    hist_max = None
    if len(old):
        top = old.sort_values("price", ascending=False).iloc[0]
        hist_max = {"price": float(top["price"]), "ts": ms(top["t"]), "at": ms(top["a"])}

    ti = token_info.set_index("mint")
    creator = ti["creator"].get(mint) if mint in ti.index else None
    creator = creator if isinstance(creator, str) and creator else None
    first_seen = None
    S, fts, fop, foa = sighting(m)
    if S < now:
        if foa is not None and foa >= now:  # the first ok price arrives after t
            fop, foa = None, None
        first_seen = {"firstSeenAt": ms(fts), "firstOkPrice": fop, "firstOkAt": None if foa is None else ms(foa), "creator": creator,
                      "creatorResolvedAt": None}

    sold = m[(m["wallet"] == leader) & (m["side"] == "sell") & (m["okey"] > e["okey"]) & (m["t"] >= T) & (m["a"] < now)]
    holding = {"buyTs": ms(T), "postBuyTokens": float(leader_pos_tokens), "soldTokens": float(np.nan_to_num(sold["tokens"]).sum())}

    prev = now // 3_600 * 3_600 - 3_600
    aw = float(hourly.get(prev, np.nan))
    aw = aw if aw > 0 else None  # no process saw that hour (build.active_hours)

    mine = sw[(sw["wallet"] == leader) & (sw["a"] < now) & (sw["t"] >= T - W7 - 86_400)]
    scan = [{"mint": r.mint, "side": r.side, "sol_amount": float(r.sol), "ts": iso(r.t)} for r in mine.itertuples()]
    token = None
    if mint in ti.index:
        pca, lca = _f(ti["pool_created_at"].get(mint)), _f(ti["launch_checked_at"].get(mint))
        token = {"pool_created_at": None if pca is None else iso(pca), "launch_checked_at": None if lca is None else iso(lca)}
    coins = []
    if creator:
        for other in ti.index[(ti["creator"] == creator).to_numpy()]:
            om = sw[sw["mint"] == other]
            if other == mint or not len(om):
                continue
            So, ftso, _, _ = sighting(om.sort_values("okey"))
            if So < now:
                coins.append({"mint": other, "first_seen_at": iso(ftso)})

    led = ledger[ledger["leader"] == leader]
    ledgers = {
        "mirror": [{"resolved_at": iso(r.at), "y": float(r.v), "lr": float(r.lr)} for r in led[led["kind"] == 0].itertuples()],
        "ps": [{"avail_at": iso(r.at), "r": _f(float(r.v)), "done": 1} for r in led[led["kind"] == 1].itertuples()],
        "dd": [{"avail_at": iso(r.at), "dead": float(r.v), "done": 1} for r in led[led["kind"] == 2].itertuples()],
    }
    return {
        "now": iso(now),
        "swap": {"wallet": leader, "mint": mint, "side": "buy", "sol_amount": float(e["sol"]), "price_sol": float(e["price"]),
                 "token_amount": _f(float(e["tokens"])), "venue": _f(e.get("venue")), "fee_lamports": _f(e.get("fee_lamports")),
                 "ts": iso(T), "signature": f"sig{episode_id}"},
        "ring": ring,
        "hist_max": hist_max,
        "first_seen": first_seen,
        "leader_holding": holding,
        "active_wallets_1h": aw,
        "screen": None,
        "db": {"wallet_swaps": scan, "token_info": token, "creator_coins": coins, "social_scores": None, "social_model_version": None},
        "ledgers": ledgers,
    }
