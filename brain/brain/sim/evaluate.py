"""
Load a window of signals + tape once, then score policies on it: the batch evaluator.

    w = load_window("2026-10-31", "2026-11-02")                       # selection (brain.data.splits), cached tape
    r = evaluate(w, entry=lambda s: full_stake(s), exit=follow_leader)  # Result: out (per signal), acc (account), metrics
    r.metrics["per_copy"]["mean_sol"], r.metrics["account"]["net_sol"]

Policies:
  entry(sig: DataFrame) -> stake in SOL per signal (0 = skip). `stake_frac` turns a fraction of COPY_MAX_TRADE_SOL into SOL.
  exit(state: dict, decision) -> fraction of tokens_left to sell per position (0 hold, 0.5 sell_half, 1 sell_all);
  see engine.EXIT_STATE for the state names and the event context keys.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from brain.data import connect, splits
from brain.data.loaders import data_dir
from brain.sim import engine
from brain.sim.account import account, metrics, one_per_coin
from brain.sim.params import Chaos, SimParams
from brain.sim.quotes import QuoteModel
from brain.sim.signals import add_gates, leader_sells, load_signals
from brain.sim.tape import SwapTape, outage_ms, tape_frame, to_ms

CACHE = "sim/cache"
LOOKBACK = pd.Timedelta(days=7)   # young_amm looks 7 days back; the price filter warms up on it too
TAIL = pd.Timedelta(hours=31)     # 24 h max hold + 6 h grounded lookahead + delays


@dataclass
class Window:
    data: engine.SimData
    days: list[str]
    start: pd.Timestamp
    end: pd.Timestamp
    meta: dict = field(default_factory=dict)


def days_of(start, end) -> list[str]:
    return [d.strftime("%Y-%m-%d") for d in pd.date_range(pd.Timestamp(start).normalize(), pd.Timestamp(end) - pd.Timedelta(seconds=1), freq="D")]


def signal_days(sig: pd.DataFrame, start, end) -> list[str]:
    """
    The window's days: the first signal's day to the last one's (days_of(start, end) when there are none). A period that
    runs to the label end has empty days at its tail (crosses_outage drops every signal whose 24 h window passes the label
    end), and counting them would dilute copies per day, slot utilisation and positive days.
    """
    if not len(sig):
        return days_of(start, end)
    return days_of(pd.Timestamp(sig["day"].min(), tz="UTC"), pd.Timestamp(sig["day"].max(), tz="UTC") + pd.Timedelta(days=1))


def data_end_ts(meta: dict | None = None) -> pd.Timestamp:
    """
    The end of the data a simulation may read prices from: derived/_meta.json label_end_t, the start of the export tail
    (swaps not yet stored when the export ran; DATA.md pitfall 18), falling back to data_end_t for builds without it.
    Everything after it is censored, never replayed as a thin tape.
    """
    meta = meta if meta is not None else json.loads((data_dir() / "derived" / "_meta.json").read_text())
    end = meta.get("label_end_t") or meta["data_end_t"]
    return pd.Timestamp(int(end), unit="s", tz="UTC")


def period_bounds(name: str) -> tuple[pd.Timestamp, pd.Timestamp]:
    p = splits.period(name)
    return p.start, (p.end if p.end is not None else data_end_ts())


def load_window(start=None, end=None, *, period: str | None = None, con=None, known: bool = True, no_outage: bool = True,
                where: str = "", params: SimParams | None = None, chaos: Chaos = Chaos(), seed: int = 0, cache: bool = True,
                quotes: QuoteModel | None = None) -> Window:
    """Signals with ts in [start, end) (or a splits.yaml period), their tape (cached on the drive), gates and leader sells."""
    if period:
        start, end = period_bounds(period)
    start = pd.Timestamp(start, tz="UTC") if pd.Timestamp(start).tzinfo is None else pd.Timestamp(start)
    end = pd.Timestamp(end, tz="UTC") if pd.Timestamp(end).tzinfo is None else pd.Timestamp(end)
    params = params or SimParams.load()
    con = con or connect()
    sig = load_signals(con, start, end, known=known, no_outage=no_outage, where=where)
    dend = data_end_ts()
    tape_end = min(end + TAIL, dend + pd.Timedelta(seconds=1))
    # nothing is known past the loaded tape: a sale or retry landing after it is censored, not valued as a dead coin
    tape = cached_tape(con, sig["mint"].unique(), start - LOOKBACK, tape_end, min(dend, tape_end), cache, params)
    if chaos.universe_keep < 1.0:
        tape = tape.thin(chaos.universe_keep, seed, always=sig["leader"].unique())
    sig = add_gates(sig, tape, params, chaos, seed)
    sells = leader_sells(sig, tape)
    data = engine.SimData(tape, sig, sells, quotes)
    return Window(data=data, days=signal_days(sig, start, end), start=start, end=end,
                  meta={"signals": int(len(sig)), "mints": int(sig["mint"].nunique()), "swaps": int(len(tape.id)), "ok_prints": int(tape.ok.sum())})


def cached_tape(con, mints, start, end, data_end, cache: bool = True, params: SimParams | None = None) -> SwapTape:
    """The window's SwapTape, its raw swap frame cached under <DATA>/sim/cache (keyed by window, mint set and derive build)."""
    built = json.loads((data_dir() / "derived" / "_meta.json").read_text()).get("built_at", "")
    h = hashlib.sha1(("|".join(sorted(map(str, mints))) + f"|{start}|{end}|{built}").encode()).hexdigest()[:12]
    f = data_dir() / CACHE / f"tape_{pd.Timestamp(start):%Y%m%d%H}_{pd.Timestamp(end):%Y%m%d%H}_{h}.parquet"
    p = params or SimParams.load()  # model.ts fee / depth constants of sim.yaml
    kw = {"data_end": int(to_ms([data_end])[0]), "outage_h": outage_ms(con), "fee_bps": p.fee_bps, "default_depth": p.default_depth_sol,
          "depth_window_ms": int(p.depth_window_s * 1000)}
    if cache and f.is_file():
        return SwapTape.from_frame(pd.read_parquet(f), **kw)
    df = tape_frame(con, mints, start, end)
    if cache:
        f.parent.mkdir(parents=True, exist_ok=True)
        df.to_parquet(f, index=False)
    return SwapTape.from_frame(df, **kw)


@dataclass
class Result:
    out: pd.DataFrame
    acc: pd.DataFrame
    metrics: dict
    book: engine.Book | None = None


def stake_frac(frac, p: SimParams | None = None) -> np.ndarray:
    """A stake fraction (0 / 0.25 / ... / 1 of COPY_MAX_TRADE_SOL) in SOL."""
    p = p or SimParams.load()
    return np.clip(np.asarray(frac, dtype=np.float64), 0, 1) * p.max_trade_sol


def evaluate(w: Window, entry, exit, params: SimParams | None = None, chaos: Chaos = Chaos(), seed: int = 0,
             rows=None, B: int = 1000, keep_book: bool = False, features: bool = False) -> Result:
    """Score (entry, exit) policies on a window: simulate every chosen signal, run the paper account, compute the metrics."""
    params = params or SimParams.load()
    d = w.data
    rows = np.arange(len(d.sig)) if rows is None else np.asarray(rows)
    stake = np.asarray(entry(d.sig.iloc[rows]), dtype=np.float64)
    book = d.book(rows, stake, params, chaos, seed, features=features)
    engine.run(book, exit)
    out = book.outcomes()
    out["gate"] = d.sig["gate"].to_numpy()[rows]
    out["ins_lag_s"] = (d.sig["ins_ms"].to_numpy()[rows] - d.sig["t_ms"].to_numpy()[rows]) / 1000
    out["solo"] = one_per_coin(out)  # the per-signal metrics keep one position per coin
    t_dec = d.sig["t_dec"].to_numpy()[rows]
    acc = account(out, t_dec, params)
    m = metrics(out, acc, w.days, params, B=B, seed=seed)
    return Result(out=out, acc=acc, metrics=m, book=book if keep_book else None)
