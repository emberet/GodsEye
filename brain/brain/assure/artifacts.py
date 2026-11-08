"""
One check per measurement artifact the research report found (research-2026-11-06 sections 2, 3, 4, 8 and 9). Each
returns a Check; `passed` False means the artifact is back. World checks run the real simulator on brain.assure.worlds;
the `real_*` checks read the data on the drive (read-only).

  A1 dead_coins          a silent rug (the tape freezes high, the coin is unsellable) is written off, never valued at its
                         last tape price                                                   (report 2: "+34.9 SOL a week")
  A2 exit_timing         following a 2 s bot's sell fills right after it, so the bot picks lose the costs; only the old
                         minute-close fill made them look profitable                      (report 4: B3 "+2.2 SOL")
  A3 stops_at_gap        the -60 % stop fills at the next observed price, not at -60 %     (report 3: real stops -80.8 %)
  A4 break_even          costs per round trip: about 4 % gross at 0.1 SOL, about 6 % at 0.025 SOL (report 3)
  A5 calibration_cutoff  no calibration used for selection was fit on quotes from the selection or test windows
                                                                                           (report 8: short exits "profit")
  A6 point_in_time       features of a decision equal those computed from the rows stored before it (report 1, 9)
  A7 one_per_coin        stacked copies of one coin count once                              (sim review: B4's "edge")
  real_dead_coins        on held-out shadow quotes: grounded valuation tracks the real Jupiter quote, the tape price
                         does not
"""
from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field

import numpy as np
import pandas as pd

from brain.baselines import follow_leader
from brain.sim.account import one_per_coin
from brain.sim.evaluate import evaluate
from brain.sim.params import SimParams
from brain.sim.quotes import QuoteModel


@dataclass
class Check:
    name: str
    passed: bool
    value: dict
    rule: str
    detail: str = ""
    skipped: bool = False
    warning: str = ""

    def to_dict(self) -> dict:
        return asdict(self)


def tape_valued() -> QuoteModel:
    """The mutant valuation: every stale mark and every sale at the last tape price (no haircut, never 'no route')."""
    q = QuoteModel.fallback()
    return QuoteModel(alive=np.ones_like(q.alive), dark=np.ones_like(q.dark), obs=np.ones_like(q.obs), meta={"mutant": "tape-valued"})


def full_stake(p: SimParams):
    return lambda s: np.full(len(s), p.max_trade_sol)


def minute_close(st: dict, d=None) -> np.ndarray:
    """The old simulator's follow-the-leader fill: hold through the leader's sell, sell at the next minute tick."""
    return np.where(st["event_tick"] & (st["leader_sold"] > 0), 1.0, 0.0)


def hold(st: dict, d=None) -> np.ndarray:
    return np.zeros(len(st["ret_now"]))


# ------------------------------------------------------------------------------------------------------------ A1
def dead_coins(world, quotes: QuoteModel | None = None, p: SimParams | None = None) -> Check:
    """Copies of silent rugs whose leader never sold before the pull: the sim must lose at least 80 % of the stake on them."""
    p = p or SimParams()
    win = world.window()
    if quotes is not None:
        win.data.quotes = quotes
    t = world.truth_of(win)
    rows = np.flatnonzero(t["kind"].isin(["silent_rug", "hiprice_rug", "young_rug"]).to_numpy() & t["leader_sell_t"].isna().to_numpy()
                          & (win.data.sig["gate"].to_numpy() == ""))
    r = evaluate(win, full_stake(p), follow_leader, p, rows=rows, B=10)
    o = r.out[r.out["entered"].to_numpy()]
    mean_ret = float(o["pnl"].mean() / p.max_trade_sol) if len(o) else float("nan")
    reasons = o["reason"].value_counts().to_dict()
    ok = len(o) >= 10 and mean_ret <= -0.80
    return Check("A1 dead_coins", bool(ok), {"n": int(len(o)), "mean_return": mean_ret, "reasons": {k: int(v) for k, v in reasons.items()}},
                 "mean return of copies held into a silent rug <= -80 % (written off, rent lost)",
                 "" if ok else "silent rugs are valued near their last tape price: the dead-coin artifact is back")


def real_dead_coins(samples: pd.DataFrame, fit_before, eval_from) -> Check:
    """
    Fit the quote model on shadow quotes before `fit_before`, then on the later (held-out) quotes compare the grounded value
    ratio (alive: m_alive(age), dark: f_dark(age), no route below 0.10) and the tape value (ratio 1) with the real quote.
    """
    from brain.sim.quotes import QuoteModel as QM
    fit_before, eval_from = utc(fit_before), utc(eval_from)
    qm = QM.fit(samples, before=fit_before)
    d = samples[(samples["status"] == "ok") & ~samples["transient_err"].astype(bool) & samples["close_ok"].notna() & (samples["close_ok"] > 0)
                & (pd.to_datetime(samples["sampled_at"], utc=True) >= eval_from)].copy()
    if len(d) < 50:
        return Check("A1 real_dead_coins", False, {"n": int(len(d))}, "needs >= 50 held-out shadow quotes", "too few held-out quotes", skipped=True)
    real = np.where(d["rug"].astype(bool), 0.0, d["quote_val"] / d["close_ok"]).clip(0, 2)
    age = d["age_ok_s"].to_numpy(np.float64)
    dead = d["tape_dead"].astype(bool).to_numpy()
    fd = qm.f_dark(age)
    grounded = np.where(dead, np.where(fd < SimParams().no_route_below, 0.0, fd), qm.m_alive(age))
    gdiff, tdiff = float(np.mean(grounded - real)), float(np.mean(1.0 - real))
    ok = gdiff <= 0.07 and tdiff >= 0.15
    warn = ""
    if gdiff < -0.10:
        fit = samples[(pd.to_datetime(samples["sampled_at"], utc=True) < fit_before) & samples["tape_dead"].astype(bool)]
        rug_fit = float(fit["rug"].astype(bool).mean())
        warn = (f"grounded valuation is {-gdiff:.2f} below real quotes out of sample (conservative, so it can't buy rugs, but it makes "
                f"the brain timid): dark coins were unsellable {d.loc[dead, 'rug'].astype(bool).mean():.0%} of the time out of sample "
                f"vs {rug_fit:.0%} in the fit window (the 10-27..10-30 rug wave); refit the quote model as shadow quotes accumulate")
    return Check("A1 real_dead_coins", bool(ok), {"n": int(len(d)), "grounded_minus_real": gdiff, "tape_minus_real": tdiff,
                                                  "fit_n": int(qm.meta["n"]), "fit_before": str(fit_before), "eval_from": str(eval_from),
                                                  "share_dead_tape": float(dead.mean()), "share_unsellable": float(d["rug"].astype(bool).mean())},
                 "held out: grounded valuation is never optimistic (mean(grounded - real quote) <= +0.07) while the tape price is >= 0.15 too high",
                 "" if ok else "grounded valuation is optimistic against real sell quotes (or no better than the tape price)", warning=warn)


# ------------------------------------------------------------------------------------------------------------ A2
def exit_timing(world, exit_policy=follow_leader, p: SimParams | None = None) -> Check:
    """Copies of 2 s bot flips, exited by `exit_policy`: they must lose (the costs), and the exit must land next to the sell."""
    p = p or SimParams()
    win = world.window()
    t = world.truth_of(win)
    rows = np.flatnonzero((t["kind"] == "bot_drift").to_numpy() & (win.data.sig["gate"].to_numpy() == ""))
    r = evaluate(win, full_stake(p), exit_policy, p, rows=rows, B=10)
    o = r.out[r.out["entered"].to_numpy() & (r.out["reason"] == "exit").to_numpy()]
    mean_ret = float(o["pnl"].mean() / p.max_trade_sol) if len(o) else float("nan")
    hold_s = float(o["hold_s"].median()) if len(o) else float("nan")
    ok = len(o) >= 20 and mean_ret < 0 and hold_s <= 30
    return Check("A2 exit_timing", bool(ok), {"n": int(len(o)), "mean_return": mean_ret, "median_hold_s": hold_s},
                 "following a 2 s flipper loses (mean return < 0) and sells within 30 s of the fill (median), not at the minute close",
                 "" if ok else "copies of 2 s flippers ride the post-sell drift: the minute-close exit artifact is back")


# ------------------------------------------------------------------------------------------------------------ A3
def stops_at_gap(world, p: SimParams | None = None, out: pd.DataFrame | None = None) -> Check:
    """Copies held into a loud rug (the price prints -98 % in one step): the hard stop must fill near the gap, not at -60 %."""
    p = p or SimParams()
    if out is None:
        win = world.window()
        t = world.truth_of(win)
        rows = np.flatnonzero((t["kind"] == "loud_rug").to_numpy() & (win.data.sig["gate"].to_numpy() == ""))
        out = evaluate(win, full_stake(p), hold, p, rows=rows, B=10).out
    o = out[(out["reason"] == "hard-stop").to_numpy()]
    ret = o["pnl"].to_numpy() / o["stake"].to_numpy() if len(o) else np.zeros(0)
    med = float(np.median(ret)) if len(ret) else float("nan")
    ok = len(o) >= 10 and med <= -0.85
    return Check("A3 stops_at_gap", bool(ok), {"n": int(len(o)), "median_return": med, "share_at_or_above_minus_60pct": float((ret >= -0.61).mean()) if len(ret) else float("nan")},
                 "median hard-stop return on a -98 % gap <= -85 % (the stop fills at the next observed price)",
                 "" if ok else "stops fill at the stop level: losses are understated")


# ------------------------------------------------------------------------------------------------------------ A4
def break_even(p: SimParams | None = None) -> Check:
    """The gross price rise a round trip needs to break even at 0.1 and 0.025 SOL (model.ts fills, fees, slippage)."""
    p = p or SimParams()
    f, D, slip, tx = p.fee_bps / 1e4, p.default_depth_sol, p.sell_resid_slip, p.tx_cost_sol

    def net(r, s):
        tok = s / ((1 + f) * (1 + min(3, s / D)))   # tokens per unit mid
        val = tok * (1 + r)
        sol = val * (1 - f) / (1 + min(3, val / D)) * (1 - slip)
        return sol - s - 2 * tx

    def solve(s):
        lo, hi = 0.0, 1.0
        for _ in range(60):
            mid = (lo + hi) / 2
            lo, hi = (mid, hi) if net(mid, s) < 0 else (lo, mid)
        return (lo + hi) / 2

    b10, b025 = solve(0.1), solve(0.025)
    ok = 0.03 <= b10 <= 0.055 and 0.045 <= b025 <= 0.08
    return Check("A4 break_even", bool(ok), {"at_0.1_sol": b10, "at_0.025_sol": b025, "tx_cost_sol": tx, "fee_bps": p.fee_bps},
                 "break-even gross return 3-5.5 % at 0.1 SOL and 4.5-8 % at 0.025 SOL (report: about 4 % and 6 %)",
                 "" if ok else "the cost model no longer matches the measured fees (BRAIN_TX_COST_SOL 0.0003, 1 % DEX fee, slippage)")


# ------------------------------------------------------------------------------------------------------------ A5
def calibration_cutoff(meta: dict, selection_start) -> Check:
    """A quote model used to choose or gate must be fit only on quotes sampled before the selection window."""
    sel = utc(selection_start)
    fb = meta.get("fit_before")
    to = meta.get("sampled_to")
    if meta.get("fallback"):
        return Check("A5 calibration_cutoff", True, {"fallback": True}, "fallback tables carry no sample", "the fallback model (no fit)")
    if fb is None:
        return Check("A5 calibration_cutoff", False, {"meta": {k: meta.get(k) for k in ("n", "sampled_from", "sampled_to")}},
                     "the model records fit_before", "the quote model does not record its cutoff: it can't be trusted for selection")
    fbt = pd.Timestamp(fb)
    tot = pd.Timestamp(to) if to else None
    tot = tot.tz_localize("UTC") if tot is not None and tot.tzinfo is None else tot
    ok = fbt <= sel and (tot is None or tot < sel)
    return Check("A5 calibration_cutoff", bool(ok), {"fit_before": str(fbt), "sampled_to": str(tot), "selection_start": str(sel), "n": meta.get("n")},
                 "fit_before <= the selection start and every sample before it",
                 "" if ok else f"the quote model includes quotes up to {tot}: selection-window results use quotes from the window they choose on")


# ------------------------------------------------------------------------------------------------------------ A6
def point_in_time(world, build, m: pd.DataFrame, cuts=(0.35, 0.6, 0.85), columns=None) -> Check:
    """
    `build(world, m, sig=..., tape=...)` on the full world vs on the world truncated at a cut (only rows stored before it):
    every decision before the cut must get identical features. A leaky builder differs.
    """
    from brain.assure import features as F
    full = build(world, m).set_index("episode_id")
    cols = [c for c in (columns or full.columns)]
    bad: dict = {}
    n = 0
    for q in cuts:
        cut = int(world.sig["t_dec"].quantile(q))
        sig, mt, tape = F.truncate(world, m, cut)
        part = build(world, mt, sig=sig, tape=tape).set_index("episode_id")
        ids = sig.loc[sig["t_dec"].to_numpy() < cut, "episode_id"].to_numpy()
        a, b = full.loc[ids, cols], part.loc[ids, cols]
        n += len(ids)
        for c in cols:
            x, y = a[c].to_numpy(np.float64), b[c].to_numpy(np.float64)
            diff = ~((np.isnan(x) & np.isnan(y)) | np.isclose(x, y, rtol=1e-9, atol=1e-12))
            if diff.any():
                bad[c] = bad.get(c, 0) + int(diff.sum())
    ok = not bad
    return Check("A6 point_in_time", ok, {"decisions_compared": n, "features_that_changed": bad},
                 "a decision's features are the same with and without the rows stored after it",
                 "" if ok else f"features read rows stored after the decision: {sorted(bad)}")


# ------------------------------------------------------------------------------------------------------------ A7
def one_per_coin_rule(out: pd.DataFrame) -> Check:
    """The per-signal metrics keep one position per coin: of copies overlapping in one coin, only the first counts."""
    keep = one_per_coin(out)
    copies = (out["stake"].to_numpy() > 0)
    o = out[copies]
    overlaps = 0
    for _, g in o.groupby("mint"):
        g = g.sort_values(["t_dec", "episode_id"])
        end = -1
        for t, c in zip(g["t_dec"].to_numpy(), g["close_t"].to_numpy()):
            if t < end:
                overlaps += 1
            else:
                end = c
    blocked = int((copies & ~keep).sum())
    ok = blocked == overlaps
    return Check("A7 one_per_coin", ok, {"copies": int(copies.sum()), "overlapping": overlaps, "blocked": blocked},
                 "every copy made while an earlier copy of the coin is open is dropped from the per-signal metrics",
                 "" if ok else "stacked copies of one coin are averaged in: a few hot coins decide the mean")


def utc(ts) -> pd.Timestamp:
    t = pd.Timestamp(ts)
    return t.tz_localize("UTC") if t.tzinfo is None else t


def load_json(path) -> dict:
    return json.loads(open(path).read())
