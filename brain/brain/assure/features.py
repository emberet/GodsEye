"""
Point-in-time entry features of a synthetic world, under the insert-time rule of features.yaml (a row counts at the
decision time t only if it was stored before t), named after the features.yaml features they stand in for so a trainer
that reads those names can train on a world.

    m = mirror(world)                     # the mirror ledger: every signal copied at full stake, followed out (B1)
    f = build(world, m)                   # one row per world.sig row (same order), the columns of COLUMNS
    f = build(world, m, leaky=True)       # the mutant: block time instead of insert time, and the leak canary readable
    sig, m2, tape = truncate(world, m, cut)  # the world as the server had it at cut (rows stored before it only)

Stand-ins (same meaning, simpler definitions than features.yaml):
  cp_n_7d / cp_lrshr_7d / cp_win_7d   the leader's mirror copies resolved and stored before t within 7 d: count, mean
                                      log(1 + return), share won
  leader_n_prior7 / b_n_24h            the leader's earlier buys stored before t (7 d / 24 h)
  venue_group, sfx_pump, log_price     the swap itself (log_price for log_mcap_sol)
  mint_first_seen_age_min              minutes since the mint's first swap stored before t (missing: none)
  ret_since_first                      log(leader price / the first stored price)
  cr_seen_prior_7d                     the creator's other coins first seen (stored) before t within 7 d
  tracked_active_wallets_1h            distinct tracked wallets with a swap stored in [t - 1 h, t)
  hour_sin / hour_cos                  hour of day
  leak_canary                          the signal's own outcome + noise, stored 1 h after the position closed: a
                                       point-in-time builder can never read it (always missing); a leaky one can
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from brain.baselines import follow_leader
from brain.sim.evaluate import evaluate
from brain.sim.params import SimParams

COLUMNS = ("cp_n_7d", "cp_lrshr_7d", "cp_win_7d", "leader_n_prior7", "b_n_24h", "venue_group", "sfx_pump", "log_price",
           "mint_first_seen_age_min", "ret_since_first", "cr_seen_prior_7d", "tracked_active_wallets_1h", "hour_sin", "hour_cos",
           "leak_canary")
WEEK = 7 * 86_400_000
DAY = 86_400_000
HOUR = 3_600_000
CANARY_DELAY = HOUR


def mirror(world, p: SimParams | None = None) -> pd.DataFrame:
    """The mirror ledger: each signal copied at full stake and followed out; avail = when the server could know the result."""
    p = p or SimParams()
    r = evaluate(world.window(), lambda s: np.full(len(s), p.max_trade_sol), follow_leader, p, B=10)
    o = r.out
    sig = world.sig.set_index("episode_id").loc[o["episode_id"]]
    ret = np.where(o["entered"].to_numpy(), o["pnl"].to_numpy() / p.max_trade_sol, np.nan)
    close = np.where(o["close_t"].to_numpy() < 2**61, o["close_t"].to_numpy(), np.iinfo(np.int64).max // 2)
    avail = np.maximum(close, sig["ins_ms"].to_numpy())
    rng = np.random.default_rng(world.spec.seed + 7)
    canary = np.sign(np.nan_to_num(ret)) + rng.normal(0, 0.5, len(o))
    return pd.DataFrame({"episode_id": o["episode_id"].to_numpy(), "leader": o["leader"].to_numpy(), "t_ms": o["t_ms"].to_numpy(),
                         "ret": ret, "avail": avail.astype(np.int64), "canary": canary,
                         "canary_avail": (close + CANARY_DELAY).astype(np.int64)})


def build(world, m: pd.DataFrame, leaky: bool = False, sig: pd.DataFrame | None = None, tape=None) -> pd.DataFrame:
    """Entry features for every row of `sig` (default world.sig) at its decision time t_dec, from `tape` (world.tape)."""
    sig = world.sig if sig is None else sig
    tape = world.tape if tape is None else tape
    n = len(sig)
    t = sig["t_dec"].to_numpy(np.int64)
    out = {c: np.full(n, np.nan) for c in COLUMNS}

    # the leader's mirror copies and earlier buys: availability = insert time (leaky: block time / close time)
    mm = m.set_index("episode_id")
    by_leader = {k: g for k, g in m.groupby("leader")}
    sig_by_leader = {k: g for k, g in sig.groupby("leader")}
    for i, (ld, ti, eid) in enumerate(zip(sig["leader"].to_numpy(), t, sig["episode_id"].to_numpy())):
        g = by_leader.get(ld)
        if g is not None:
            when = g["t_ms"].to_numpy() if leaky else g["avail"].to_numpy()
            if leaky:  # the mutant also counts copies still open at t (their result is in the export, not live)
                use = (g["t_ms"].to_numpy() < ti) & (g["t_ms"].to_numpy() >= ti - WEEK)
            else:
                use = (when < ti) & (g["t_ms"].to_numpy() >= ti - WEEK)
            r = g["ret"].to_numpy()[use]
            r = r[np.isfinite(r)]
            out["cp_n_7d"][i] = len(r)
            if len(r):
                out["cp_lrshr_7d"][i] = float(np.mean(np.log1p(np.clip(r, -0.95, None))))
                out["cp_win_7d"][i] = float((r > 0).mean())
        s = sig_by_leader[ld]
        when = s["t_ms"].to_numpy() if leaky else s["ins_ms"].to_numpy()
        prior = (when < ti) & (s["episode_id"].to_numpy() != eid)
        out["leader_n_prior7"][i] = int((prior & (s["t_ms"].to_numpy() >= ti - WEEK)).sum())
        out["b_n_24h"][i] = int((prior & (s["t_ms"].to_numpy() >= ti - DAY)).sum())
        if eid in mm.index:
            ca = mm.at[eid, "canary_avail"]
            if leaky or ca < ti:
                out["leak_canary"][i] = mm.at[eid, "canary"]

    v = sig["venue_clean"].to_numpy()
    out["venue_group"] = np.where(np.char.startswith(v.astype(str), "pumpswap"), 0.0, np.where(v == "pumpfun", 1.0, 2.0))
    out["sfx_pump"] = sig["mint"].str.endswith("pump").to_numpy(np.float64)
    out["log_price"] = np.log(sig["leader_price_sol"].to_numpy(np.float64))
    hr = ((t + world_t0()) // HOUR) % 24
    out["hour_sin"], out["hour_cos"] = np.sin(2 * np.pi * hr / 24), np.cos(2 * np.pi * hr / 24)

    # the mint's first stored swap (insert time) and the creator's earlier coins
    mc = tape.codes(sig["mint"])
    when_all = tape.t if leaky else tape.ins
    order = np.lexsort((when_all, tape.mint))
    tm, tw, tt, tp = tape.mint[order], when_all[order], tape.t[order], tape.price[order]
    starts = np.searchsorted(tm, np.arange(len(tape.mints)), "left")
    ends = np.searchsorted(tm, np.arange(len(tape.mints)), "right")
    for i, (c, ti) in enumerate(zip(mc, t)):
        if c < 0:
            continue
        a, b = starts[c], ends[c]
        k = np.searchsorted(tw[a:b], ti, "left")  # rows of this mint stored before t
        if k == 0:
            continue
        j = a + int(np.argmin(tt[a:a + k]))
        out["mint_first_seen_age_min"][i] = min((ti - tt[j]) / 60_000, 7 * 1440)
        out["ret_since_first"][i] = float(np.log(sig["leader_price_sol"].iat[i] / tp[j])) if tp[j] > 0 else np.nan
    cr = sig["creator"].to_numpy() if "creator" in sig else np.full(n, None)
    first_seen = sig["t_ms"].to_numpy() if leaky else sig["ins_ms"].to_numpy()
    by_cr: dict = {}
    for k_, c in enumerate(cr):
        by_cr.setdefault(c, []).append(k_)
    for c, ks in by_cr.items():
        ks = np.asarray(ks)
        fs, tms = first_seen[ks], sig["t_ms"].to_numpy()[ks]
        for k_ in ks:
            ti = t[k_]
            out["cr_seen_prior_7d"][k_] = int(((fs < ti) & (tms >= ti - WEEK) & (ks != k_)).sum())

    # tracked wallets active in the last hour, by insert time
    o2 = np.argsort(when_all, kind="stable")
    w_sorted, wl = when_all[o2], tape.wallet[o2]
    lo = np.searchsorted(w_sorted, t - HOUR, "left")
    hi = np.searchsorted(w_sorted, t, "left")
    out["tracked_active_wallets_1h"] = np.array([len(np.unique(wl[a:b])) for a, b in zip(lo, hi)], dtype=np.float64)
    f = pd.DataFrame(out)
    f.insert(0, "episode_id", sig["episode_id"].to_numpy())
    return f


def world_t0() -> int:
    from brain.sim.tape import T0_MS
    return T0_MS


def truncate(world, m: pd.DataFrame, cut_ms: int):
    """
    (sig, mirror, tape) as the server had them at cut_ms: signals of leader buys before it, mirror rows resolved and
    stored before it, swaps stored before it. A point-in-time feature of a signal decided before cut_ms is the same on
    the full world and on this one; a leaky one is not.
    """
    from brain.sim.tape import SwapTape
    sig = world.sig[world.sig["t_ms"].to_numpy() < cut_ms].reset_index(drop=True)
    mt = m[m["avail"].to_numpy() < cut_ms].copy()
    mt["canary_avail"] = np.where(mt["canary_avail"].to_numpy() < cut_ms, mt["canary_avail"].to_numpy(), np.iinfo(np.int64).max // 2)
    sw = world.swaps
    p = SimParams()
    tape = SwapTape.from_frame(sw[(sw["ins_ts"] < pd.Timestamp(world_t0() + cut_ms, unit="ms", tz="UTC")).to_numpy()],
                               data_end=world.data_end_ms, fee_bps=p.fee_bps, default_depth=p.default_depth_sol,
                               depth_window_ms=int(p.depth_window_s * 1000))
    return sig, mt, tape
