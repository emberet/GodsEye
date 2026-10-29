"""Loading closed trades (closed_trades, or rebuilt from wallet_swaps) and per-token price paths."""

from __future__ import annotations

import sqlite3

import numpy as np
import pandas as pd

from .db import has_column, has_table

CLOSE_THRESHOLD = 0.01  # same rule as agent/src/analysis/pnl.ts: <=1% of peak holding left = closed
TRADE_COLS = ["wallet", "mint", "entry_ts", "exit_ts", "entry_sol", "exit_sol", "pnl_sol", "ret", "hold_sec"]


def to_epoch_seconds(values: pd.Series) -> pd.Series:
    """Detects the timestamp unit (ISO text, epoch s, ms, us) and returns float epoch seconds."""
    s = pd.Series(values)
    if s.empty:
        return s.astype(float)
    num = pd.to_numeric(s, errors="coerce")
    if num.notna().mean() > 0.9:
        med = float(num.abs().median())
        scale = 1e6 if med > 1e14 else 1e3 if med > 1e11 else 1.0
        return num / scale
    dt = pd.to_datetime(s, utc=True, errors="coerce", format="ISO8601")
    return (dt - pd.Timestamp("1970-01-01", tz="UTC")).dt.total_seconds()


def load_swaps(con: sqlite3.Connection, since: float | None) -> pd.DataFrame:
    if not has_table(con, "wallet_swaps"):
        return pd.DataFrame(columns=["wallet", "mint", "ts", "side", "token_amount", "sol_amount", "price_sol"])
    df = pd.read_sql_query("SELECT wallet, mint, ts, side, token_amount, sol_amount, price_sol FROM wallet_swaps", con)
    df["ts"] = to_epoch_seconds(df["ts"])
    df = df.dropna(subset=["ts"])
    if since is not None:
        df = df[df["ts"] >= since]
    return df


def load_price_paths(
    con: sqlite3.Connection, since: float | None, mints: list[str], chunk: int = 500, min_obs: int = 5
) -> dict[str, tuple[np.ndarray, np.ndarray]]:
    """price_paths() for `mints` only, read straight into numpy arrays (mint code, epoch s, price).

    The live DB holds ~14M swaps in 30 days across ~90k tokens: as a DataFrame of Python objects that ran past
    6 GB; as arrays it is ~20 bytes a row. ts is converted by SQLite (ISO text sorts as time, so the window is
    applied there too).
    """
    since_iso = pd.Timestamp(since, unit="s", tz="UTC").strftime("%Y-%m-%dT%H:%M:%S") if since is not None else ""
    code = {m: i for i, m in enumerate(mints)}
    codes, times, prices = [], [], []
    for i in range(0, len(mints), chunk):
        part = mints[i : i + chunk]
        marks = ",".join("?" * len(part))
        cur = con.execute(
            "SELECT mint, (julianday(ts) - 2440587.5) * 86400.0, price_sol FROM wallet_swaps"
            f" WHERE price_sol > 0 AND ts >= ? AND mint IN ({marks})",
            [since_iso, *part],
        )
        while rows := cur.fetchmany(200_000):
            m, t, p = zip(*rows, strict=True)
            codes.append(np.fromiter((code[x] for x in m), dtype=np.int32, count=len(m)))
            times.append(np.asarray(t, dtype=float))
            prices.append(np.asarray(p, dtype=float))
    if not codes:
        return {}
    c, t, p = np.concatenate(codes), np.concatenate(times), np.concatenate(prices)
    keep = ~np.isnan(t)
    c, t, p = c[keep], t[keep], p[keep]
    order = np.lexsort((t, c))  # by mint, then time
    c, t, p = c[order], t[order], p[order]
    starts = np.flatnonzero(np.r_[True, c[1:] != c[:-1]])
    ends = np.r_[starts[1:], len(c)]
    return {mints[c[a]]: (t[a:b], p[a:b]) for a, b in zip(starts, ends, strict=True) if b - a >= min_obs}


BOTS_SQL = "SELECT address FROM wallets WHERE junk_reason LIKE 'bot:%' AND COALESCE(copy_weight, 0) = 0"


def rebuild_closed_trades(swaps: pd.DataFrame) -> pd.DataFrame:
    """Average-cost round trips per wallet and mint, mirroring realize() in agent/src/analysis/pnl.ts (SOL side)."""
    rows = []
    sw = swaps.assign(_o=(swaps["side"] != "buy").astype(int)).sort_values(["wallet", "ts", "_o"])
    for wallet, g in sw.groupby("wallet", sort=False):
        st: dict[str, dict] = {}
        for r in g.itertuples(index=False):
            s = st.get(r.mint)
            if r.side == "buy":
                if s is None or s["qty"] <= 0:
                    s = {"qty": 0.0, "cost": 0.0, "peak": 0.0, "opened": r.ts, "acc_cost": 0.0, "acc_proc": 0.0}
                    st[r.mint] = s
                s["qty"] += r.token_amount
                s["cost"] += r.sol_amount
                s["peak"] = max(s["peak"], s["qty"])
                continue
            if s is None or s["qty"] <= 0 or r.token_amount <= 0:
                continue  # sells of tokens never seen bought are ignored
            sold = min(r.token_amount, s["qty"])
            cost_part = s["cost"] * sold / s["qty"]
            s["qty"] -= sold
            s["cost"] -= cost_part
            s["acc_cost"] += cost_part
            s["acc_proc"] += r.sol_amount * sold / r.token_amount
            if s["qty"] <= s["peak"] * CLOSE_THRESHOLD:
                pnl = s["acc_proc"] - s["acc_cost"]
                rows.append(
                    (
                        wallet,
                        r.mint,
                        s["opened"],
                        r.ts,
                        s["acc_cost"],
                        s["acc_proc"],
                        pnl,
                        pnl / s["acc_cost"] if s["acc_cost"] > 0 else np.nan,
                        r.ts - s["opened"],
                    )
                )
                del st[r.mint]
    return pd.DataFrame(rows, columns=TRADE_COLS)


def load_closed_trades(
    con: sqlite3.Connection, since: float | None, swaps: pd.DataFrame | None, skip_bots: bool = False
) -> tuple[pd.DataFrame, str]:
    if has_table(con, "closed_trades"):
        # entry_ts is epoch seconds here (closed_trades); the window is applied in SQLite and again below
        bots = skip_bots and has_table(con, "wallets") and has_column(con, "wallets", "junk_reason")
        df = pd.read_sql_query(
            "SELECT wallet, mint, entry_ts, exit_ts, entry_sol, exit_sol, pnl_sol, hold_sec FROM closed_trades"
            " WHERE entry_ts >= ?" + (f" AND wallet NOT IN ({BOTS_SQL})" if bots else ""),
            con,
            params=[since if since is not None else 0],
        )
        df["entry_ts"] = to_epoch_seconds(df["entry_ts"])
        df["exit_ts"] = to_epoch_seconds(df["exit_ts"])
        # returns from SOL amounts, so the unit of return_pct never matters
        df["ret"] = np.where(df["entry_sol"] > 0, df["pnl_sol"] / df["entry_sol"].where(df["entry_sol"] > 0), np.nan)
        df["hold_sec"] = df["hold_sec"].fillna(df["exit_ts"] - df["entry_ts"])
        source = "closed_trades"
    else:
        df = rebuild_closed_trades(swaps if swaps is not None else load_swaps(con, since))
        source = "wallet_swaps"
    df = df.dropna(subset=["entry_ts", "ret"])
    df = df[df["ret"] > -1.0000001]
    if since is not None:
        df = df[df["entry_ts"] >= since]
    return df.sort_values("entry_ts").reset_index(drop=True)[TRADE_COLS], source


def price_paths(swaps: pd.DataFrame) -> dict[str, tuple[np.ndarray, np.ndarray]]:
    """mint -> (sorted ts, price_sol) from every wallet's swaps, for matched random entries."""
    out = {}
    s = swaps[(swaps["price_sol"] > 0)]
    for mint, g in s.groupby("mint"):
        if len(g) >= 5:
            g = g.sort_values("ts")
            out[mint] = (g["ts"].to_numpy(float), g["price_sol"].to_numpy(float))
    return out
