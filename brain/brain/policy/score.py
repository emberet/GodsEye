"""
Scoring a policy on a window from one simulation of every candidate copy (exact, because positions are independent:
the account applies slots, budget and the loss limit afterwards, account.py).

    full = simulate(window, ei, exit_policy)          # every ungated signal copied at full stake, the policy's exit
    res = choose(full, window, stake_frac)            # metrics of the copies a stake vector makes (others skipped)

`choose` gives what evaluate() would for the same entry decisions with the same exit, seed and chaos, without simulating
again: the margin, kappa and curiosity grids all re-use one run.

Fill sanity (`fill_outliers`): a simulated fill more than FILL_X away from the tape print it is priced on is a simulator
artifact, not a trade. model.ts adds a print's own impact (sol / depth, capped at 3x) to its mid; on wash-traded coins
(rings of bots trading 5-10 SOL back and forth at a flat price) the depth estimate is tiny, so a copy "buys" at a
quarter of the price after a big sell print and "sells" at three times it after a big buy print. On the 11-07 selection
run every SOL the first brain made came from 95 such copies of two coins (+27.5 SOL; the other 1,106 copies -2.8 SOL).
Real fills land within -2.5 %..+4 % of the model (sim.yaml entry_fill, n=37). The trainer never learns from such copies
and the gate reports every result with and without them.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from brain.sim import engine
from brain.sim.account import account, metrics, one_per_coin
from brain.sim.params import Chaos, SimParams


FILL_X = 2.0


def fill_columns(out: pd.DataFrame, book, tape) -> pd.DataFrame:
    """entry_vs_print / sale_vs_print: the fill prices over the last ok print at the entry / at the close (NaN unless filled)."""
    m = tape.codes(out["mint"])
    E = out["E"].to_numpy(np.int64)
    ent = out["entered"].to_numpy(bool) & (out["reason"].to_numpy() != "dead-entry")
    li = tape.last_ok(m, np.where(ent, E, 0))
    px = np.where(ent & (li >= 0), tape.ok_price[np.clip(li, 0, None)] if len(tape.ok_price) else np.nan, np.nan)
    out["entry_vs_print"] = out["entry_px"].to_numpy() / px
    sold = book.tok0 - book.tok
    sale = np.where(ent & (sold > 0), book.proceeds / np.where(sold > 0, sold, 1.0), np.nan)
    ct = out["close_t"].to_numpy(np.int64)
    lc = tape.last_ok(m, np.where(ent & (ct < 2**61), ct, 0))
    pc = np.where(ent & (lc >= 0), tape.ok_price[np.clip(lc, 0, None)] if len(tape.ok_price) else np.nan, np.nan)
    out["sale_vs_print"] = sale / pc
    return out


def fill_outliers(out: pd.DataFrame, x: float = FILL_X) -> np.ndarray:
    """Copies whose entry fill or (average) sale price is more than x times away from its tape print (see the docstring)."""
    e = out["entry_vs_print"].to_numpy() if "entry_vs_print" in out else np.full(len(out), np.nan)
    s = out["sale_vs_print"].to_numpy() if "sale_vs_print" in out else np.full(len(out), np.nan)
    with np.errstate(invalid="ignore"):
        return (e < 1 / x) | (e > x) | (s > x)


def clean(out: pd.DataFrame) -> pd.DataFrame:
    """The outcomes with fill-outlier copies turned into skips (P&L 0)."""
    bad = fill_outliers(out)
    o = out.copy()
    o["pnl"] = np.where(bad, 0.0, o["pnl"].to_numpy())
    o["stake"] = np.where(bad, 0.0, o["stake"].to_numpy())
    o["reason"] = np.where(bad, "skip", o["reason"].to_numpy())
    o["entered"] = o["entered"].to_numpy() & ~bad
    return o


def simulate(window, ei, exit_policy, p: SimParams | None = None, chaos: Chaos = Chaos(), seed: int = 0, rows=None) -> pd.DataFrame:
    """Book outcomes of every row (gated rows skipped) copied at full stake; columns as evaluate()'s out, plus the fill checks."""
    p = p or SimParams.load()
    d = window.data
    rows = np.arange(len(d.sig)) if rows is None else np.asarray(rows)
    stake = np.where(ei.gated[rows], 0.0, p.max_trade_sol)
    book = d.book(rows, stake, p, chaos, seed, features=True)
    engine.run(book, exit_policy)
    out = book.outcomes()
    out["gate"] = d.sig["gate"].to_numpy()[rows]
    out["ins_lag_s"] = (d.sig["ins_ms"].to_numpy()[rows] - d.sig["t_ms"].to_numpy()[rows]) / 1000
    out["rent_lost"] = out["rent_lost"].to_numpy(bool)
    return fill_columns(out, book, d.tape)


def apply_stakes(full: pd.DataFrame, frac, p: SimParams | None = None) -> pd.DataFrame:
    """The outcomes when only rows with frac > 0 are copied, at frac x the full stake (fixed costs unchanged)."""
    p = p or SimParams.load()
    frac = np.asarray(frac, dtype=np.float64)
    out = full.copy()
    take = (frac > 0) & (out["stake"].to_numpy() > 0)
    fixed = out["n_tx"].to_numpy() * p.tx_cost_sol + np.where(out["rent_lost"].to_numpy(bool), p.rent_sol, 0.0)
    pnl = out["pnl"].to_numpy(np.float64)
    scaled = np.where(frac < 1, (pnl + fixed) * frac - fixed, pnl)
    out["pnl"] = np.where(take, scaled, 0.0)
    out["stake"] = np.where(take, out["stake"].to_numpy() * np.clip(frac, 0, 1), 0.0)
    out["reason"] = np.where(take | out["reason"].isin(("too-late", "bad-print")).to_numpy(), out["reason"].to_numpy(), "skip")
    out["entered"] = out["entered"].to_numpy() & take
    return out


def choose(full: pd.DataFrame, window, frac, p: SimParams | None = None, B: int = 500, seed: int = 0, days=None) -> dict:
    """evaluate()'s metrics for the stake vector `frac` (one value per row of `full`), plus the outcomes and account."""
    p = p or SimParams.load()
    out = apply_stakes(full, frac, p)
    out["solo"] = one_per_coin(out)
    t_dec = window.data.sig["t_dec"].to_numpy()[out["row"].to_numpy()]
    acc = account(out, t_dec, p)
    m = metrics(out, acc, days or window.days, p, B=B, seed=seed)
    return {"out": out, "acc": acc, "metrics": m}


# The gate's copies-per-day floor (paper account, selection): before_real_money (stress.yaml) wants >= 300 closed paper
# trades within 14 days, i.e. >= 22 a day. It is also what keeps "skip everything" from passing the gate.
MIN_COPIES_PER_DAY = 22


def cleaned(res, window, p: SimParams | None = None, B: int = 500, seed: int = 0) -> dict:
    """An evaluate() Result (keep_book=True) with its fill-outlier copies turned into skips: out, acc, metrics, n_outliers."""
    p = p or SimParams.load()
    out = fill_columns(res.out.copy(), res.book, window.data.tape)
    n = int(fill_outliers(out).sum())
    o = clean(out)
    o["solo"] = one_per_coin(o)
    acc = account(o, o["t_dec"].to_numpy(), p)
    return {"out": o, "acc": acc, "metrics": metrics(o, acc, window.days, p, B=B, seed=seed), "n_outliers": n, "raw_out": out}
