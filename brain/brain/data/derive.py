"""
Build the research datasets in DATA_DIR/derived/ from the exported swaps:  python -m brain.data.derive

    bars_1m/b00.parquet ...       per-mint 1-minute bars (one file per mint-hash bucket)
    episodes.parquet              one row per qualifying leader BUY: copy entry prices, forward returns, leader exits
    episode_paths/day=YYYY-MM-DD/ per-episode minute path for 24 h after the 15 s entry (sparse: observed minutes only)
    ins_steps.parquet             the insert-time proxy as change points (id, ins_t): see build_ins_steps
    hourly_swaps.parquet          tracked swaps per UTC hour and the outage test; outage_hours.parquet = the masked hours
                                  (ingest outages and the export tail, whose swaps were not all stored yet)
    _meta.json                    build parameters, data end, label end (where the export tail starts), row counts

Everything is per mint, so the work is split into mint-hash buckets (default 32): one pass splits the swaps into
bucket files, then each bucket is processed alone in DuckDB under the team's memory limit. The build goes to a
staging dir and replaces the old outputs only at the end, so it is re-runnable and readers never see half a build.

See brain/research/DATA.md for definitions and pitfalls. The SQL building blocks below take their inputs from temp
tables (`sw` = swaps, `pool` = analyzed wallet addresses), so tests run them on tiny synthetic frames.
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import duckdb
import pandas as pd

from brain.data import splits
from brain.data.loaders import (
    configure,
    data_dir,
    derived_dir,
    export_dir,
    has_parquet,
    parquet_glob,
    present_columns,
    sql_str,
    swap_select,
    swap_sources,
    swaps_view_sql,
)

DELAYS = (5, 15, 30, 60)  # copy entry delays, seconds after the leader's swap
ENTRY_WINDOW_SEC = 120  # an entry price must be observed within this long after ts + delay
PATH_DELAY = 15  # the forward path / returns start at the 15 s entry
HORIZONS = {"1m": 60, "5m": 300, "15m": 900, "1h": 3600, "6h": 21600, "24h": 86400}
PATH_SEC = 86400
MIN_LEADER_SOL = 0.05  # episode = buy of at least this much SOL
MIN_PRICE_SOL = 0.001  # swaps smaller than this don't set prices (dust: fee-dominated, noisy)
# ... nor do swaps of fewer tokens: a memecoin (~1e9 supply) trades >= 1 token per 0.001 SOL below a 1M SOL market cap,
# so a sub-token amount is a unit/parse error. High-priced non-memecoins (xStocks, wrapped majors) get no price.
MIN_PRICE_TOKENS = 1.0
OUTLIER_X = 10.0  # a price more than 10x off the median of the mint's previous valid prices is a unit/parse error
TRAIL_WINDOW = 10  # ... over this many previous valid prices (TRAILING: the server can run the same filter live)
LEADER_EXIT_FRAC = 0.99  # the leader has "exited" once they sold 99% of the position held right after the buy
TEST_START = splits.test_start().isoformat()  # ts >= this is held-out test (brain/spec/splits.yaml)
VALUATION_SEC = 86400  # crosses_outage: the episode's [ts, ts + 24 h] window touches a masked hour
OUTAGE_SHARE = 0.25  # an hour is an ingest outage below this share of the trailing median for that hour of day ...
OUTAGE_DAYS = 7  # ... over the previous 7 days (at least OUTAGE_MIN_DAYS of them in the data)
OUTAGE_MIN_DAYS = 3
OUTAGE_MIN_COVER_SEC = 900  # the partial first / last hour of the data is judged only if it covers 15 min
OUTAGE_EXT_BACK = 0.5  # an hour next to a masked run is masked too while below 50 % of `back` (and of `fwd`) ...
OUTAGE_EXT_FWD = 0.1  # ... or below 10 % of `fwd`: the ragged start / end of an outage
# The export tail: swaps reach wallet_swaps hours to days after their block time (backfills), so the last hours before
# the export are missing many swaps. An hour is complete enough for labels while the share of its swaps expected to be
# stored by the export (from the insert lags of older swaps) is at least COMPLETE_SHARE.
COMPLETE_SHARE = 0.9
LAG_CAP_SEC = 3 * 86400  # lags are measured up to this (the 11-06 export: none above 52 h) ...
LAG_REF_SEC = 2 * 86400  # ... on the swaps with ts in [data end - cap - ref, data end - cap), whose lags <= cap all show
LAG_MIN_REF = 1000  # fewer reference swaps than this: no tail estimate (every hour counts as complete)
FWD_MIN_COMPLETE = 0.5  # a tail hour counts in `fwd` at rate / complete, and only while at least half complete
BASE_MINTS = (
    "So11111111111111111111111111111111111111112",  # wSOL
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",  # USDC
    "Es9vMFrzaCERmJfrF4H2FYD4KLNykYKbjfJLtJhbAjZb",  # USDT
)
OKEY_MULT = 1_000_000  # okey = t * 1e6 + rank within the second: a total order of swaps per mint usable in ASOF joins


# --------------------------------------------------------------------------------------------------------------------
# SQL building blocks. Inputs: temp table `sw` (swap columns + _src), temp table `pool(address)`.
# --------------------------------------------------------------------------------------------------------------------

def prepare_swaps(con: duckdb.DuckDBPyConnection, source_sql: str, ins_steps: str | None = None) -> None:
    """
    Temp table `sw` from a swaps query: deduped on (signature, wallet, mint, side), with t (epoch s), okey and the
    insert-time proxy ins_t (epoch s) / ins_ts = the running max of ts in id (insert) order, never below the swap's own ts.
    `ins_steps` names a table of (id, ins_t) change points built over ALL swaps (build_ins_steps; the full build, where
    a bucket holds only some mints); without it the running max is taken over this source alone.
    """
    if ins_steps:
        ins = f"SELECT s.*, greatest(coalesce(i.ins_t, s.t), s.t) AS ins_t FROM d s ASOF LEFT JOIN {ins_steps} i ON s.id >= i.id"
    else:
        ins = "SELECT *, greatest(coalesce(max(t) OVER (ORDER BY id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW), t), t) AS ins_t FROM d"
    con.execute(f"""
        CREATE OR REPLACE TEMP TABLE sw AS
        WITH d AS (
            SELECT * EXCLUDE (_rn), epoch(ts)::BIGINT AS t FROM (
                SELECT *, row_number() OVER (PARTITION BY signature, wallet, mint, side ORDER BY _src, id) AS _rn
                FROM ({source_sql})
                WHERE ts IS NOT NULL AND mint IS NOT NULL AND wallet IS NOT NULL
            ) WHERE _rn = 1
        )
        SELECT *, to_timestamp(ins_t) AS ins_ts,
               t * {OKEY_MULT} + row_number() OVER (PARTITION BY mint, t ORDER BY slot, id, side) AS okey
        FROM ({ins})
    """)


def ins_steps_sql(swaps_sql: str) -> str:
    """
    The insert-time proxy over every swap in `swaps_sql`, stored as its change points: (id, ins_t) where ins_t = max ts
    (epoch s) over ids <= id first takes a new value, plus a last row at the highest id (the coverage end). A swap's
    ins_t is the row with the greatest id <= its own (an ASOF join). wallet_swaps has no inserted_at; ids are serial
    in insert order (live and archive share them), so a swap was stored no earlier than any swap with a smaller id.
    """
    return f"""
        WITH r AS MATERIALIZED (
            SELECT id, max(t) OVER (ORDER BY id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS m
            FROM (SELECT id, epoch(ts)::BIGINT AS t FROM ({swaps_sql}) WHERE id IS NOT NULL AND ts IS NOT NULL)
        )
        SELECT id, ins_t FROM (SELECT min(id) AS id, m AS ins_t FROM r GROUP BY m UNION SELECT max(id), max(m) FROM r)
        ORDER BY id
    """


def hourly_swaps_sql(swaps_sql: str) -> str:
    """Tracked swaps per UTC hour of ts (h = epoch s of the hour start)."""
    return f"SELECT (epoch(ts)::BIGINT // 3600) * 3600 AS h, count(*)::BIGINT AS n FROM ({swaps_sql}) WHERE ts IS NOT NULL GROUP BY 1"


def insert_lag_sql(swaps_sql: str, ins_steps: str, lo_t: int, hi_t: int) -> str:
    """
    Histogram (lag_min, n) of the insert lag ins_t - t in whole minutes (capped at LAG_CAP_SEC) of the swaps with
    lo_t <= t < hi_t, ins_t from the `ins_steps` change points as in prepare_swaps.
    """
    return f"""
        SELECT least((greatest(coalesce(i.ins_t, s.t), s.t) - s.t) // 60, {LAG_CAP_SEC // 60})::BIGINT AS lag_min,
               count(*)::BIGINT AS n
        FROM (SELECT id, epoch(ts)::BIGINT AS t FROM ({swaps_sql})
              WHERE id IS NOT NULL AND ts >= to_timestamp({int(lo_t)}) AND ts < to_timestamp({int(hi_t)})) s
        ASOF LEFT JOIN {ins_steps} i ON s.id >= i.id
        GROUP BY 1
    """


def tail_completeness(lag_hist, data_end_t: int, hours, cap_sec: int = LAG_CAP_SEC, min_ref: int = LAG_MIN_REF):
    """
    Expected share of each hour's swaps (hour starts `hours`, epoch s) that were stored by the export at data_end_t:
    the share of the reference swaps (insert_lag_sql) stored within data_end_t - mid-hour, out of those stored within
    cap_sec. 1.0 for hours older than cap_sec, and everywhere without min_ref reference swaps.
    """
    import numpy as np

    hours = np.asarray(hours, dtype=np.int64)
    lag = np.asarray(lag_hist["lag_min"], dtype=np.int64) * 60 if len(lag_hist) else np.zeros(0, dtype=np.int64)
    n = np.asarray(lag_hist["n"], dtype=np.float64) if len(lag_hist) else np.zeros(0)
    keep = lag < cap_sec
    lag, n = lag[keep], n[keep]
    if n.sum() < min_ref:
        return np.ones(len(hours))
    order = np.argsort(lag)
    lag, cum = lag[order], np.cumsum(n[order]) / n.sum()
    x = data_end_t - (hours + 1800)  # how long a swap at mid-hour had to get stored
    i = np.searchsorted(lag, x, side="right")  # reference swaps with lag <= x (a lag of m minutes counts as m * 60 s)
    share = np.where(i > 0, cum[np.maximum(i - 1, 0)], 0.0)
    return np.where(x >= cap_sec, 1.0, share)


def outage_hours(hourly, data_start_t: int, data_end_t: int, lag_hist=None, share: float = OUTAGE_SHARE,
                 days: int = OUTAGE_DAYS, min_days: int = OUTAGE_MIN_DAYS, min_cover_sec: int = OUTAGE_MIN_COVER_SEC,
                 complete_share: float = COMPLETE_SHARE):
    """
    Every UTC hour from the data start to its end (missing hours count 0): n_swaps, rate (n_swaps scaled to a full
    hour; the first and last hours are partial), back (median rate at the same hour of day on the previous `days` days
    that are not masked, NULL with fewer than `min_days` of them), fwd (the same over the next `days` days, any that
    exist), complete (tail_completeness of `lag_hist`; 1 without it), export_tail and `masked`.

    export_tail = the hour and every later one have complete < complete_share: the export ran before their swaps were all
    stored, so their tape looks quiet like a dead coin's. Tail hours are masked. As a following day (fwd) a tail hour
    counts at rate / complete, and not at all under FWD_MIN_COMPLETE: its raw rate would pass an earlier dip off as a
    lasting level, and leaving it out would leave the last days before the tail no following day to tell a level by.
    masked = export_tail, or rate < share * back unless the following days are as low (rate < share * fwd is false): a lasting
    drop in the tracked set (10-31, when the server tracked far fewer wallets for good) is a new level, not an outage.
    Then a masked run spreads to each neighbouring hour still well below normal (OUTAGE_EXT_BACK / OUTAGE_EXT_FWD): an
    outage fades in and out over a few hours.
    """
    import numpy as np
    import pandas as pd

    h0 = data_start_t // 3600 * 3600
    hours = np.arange(h0, data_end_t // 3600 * 3600 + 1, 3600, dtype=np.int64)
    n = pd.Series(dict(zip(hourly["h"], hourly["n"]))).reindex(hours).fillna(0).to_numpy(dtype=np.float64)
    cover = np.minimum(hours + 3600, data_end_t + 1) - np.maximum(hours, data_start_t)
    judged = cover >= min_cover_sec
    rate = np.where(judged, n * 3600.0 / np.maximum(cover, 1), np.nan)
    complete = np.ones(len(hours)) if lag_hist is None else tail_completeness(lag_hist, data_end_t, hours)
    low = np.flatnonzero(complete < complete_share)
    tail = np.zeros(len(hours), dtype=bool)
    if len(low):
        tail[low[0]:] = True  # completeness only falls towards the end

    def med(i, offsets, need, use, r=rate):
        v = [r[i + o] for o in offsets if 0 <= i + o < len(hours) and use[i + o] and not np.isnan(r[i + o])]
        return float(np.median(v)) if len(v) >= need else np.nan

    with np.errstate(divide="ignore", invalid="ignore"):
        full = np.where(complete >= FWD_MIN_COMPLETE, rate / complete, np.nan)  # the rate the tail hour will have
    fwd = np.array([med(i, [24 * k for k in range(1, days + 1)], 1, ~np.isnan(full), full) for i in range(len(hours))])
    # in time order, so `back` leaves out the masked hours before it (an outage is not the normal it is judged against)
    masked = tail.copy()
    back = np.full(len(hours), np.nan)
    for i in range(len(hours)):
        back[i] = med(i, [-24 * k for k in range(1, days + 1)], min_days, ~masked)
        if judged[i] and not np.isnan(back[i]) and rate[i] < share * back[i]:
            masked[i] |= np.isnan(fwd[i]) or rate[i] < share * fwd[i]
    with np.errstate(invalid="ignore"):
        weak = judged & (((rate < OUTAGE_EXT_BACK * back) & ~(rate >= OUTAGE_EXT_BACK * fwd)) | (rate < OUTAGE_EXT_FWD * fwd))
    while True:
        nxt = np.zeros(len(hours), dtype=bool)
        nxt[1:] |= masked[:-1]
        nxt[:-1] |= masked[1:]
        add = nxt & weak & ~masked
        if not add.any():
            break
        masked |= add
    return pd.DataFrame({"hour": pd.to_datetime(hours, unit="s", utc=True), "h": hours, "n_swaps": n.astype(np.int64),
                         "rate": rate, "back": back, "fwd": fwd, "complete": complete, "export_tail": tail, "masked": masked})


def label_end(hourly, data_end_t: int) -> int:
    """The end of the complete tape: the first tail hour of outage_hours, or the data end. Labels stop here."""
    t = hourly.loc[hourly["export_tail"], "h"] if "export_tail" in hourly else []
    return int(min(t)) if len(t) else int(data_end_t)


def set_outage(con: duckdb.DuckDBPyConnection, hours=()) -> None:
    """Temp table `outage(h)`: the masked hours (epoch s of the hour start) that episodes_sql tests crosses_outage on."""
    con.execute("CREATE OR REPLACE TEMP TABLE outage (h BIGINT)")
    if len(hours):
        con.executemany("INSERT INTO outage VALUES (?)", [[int(h)] for h in hours])


def build_prices(con: duckdb.DuckDBPyConnection) -> None:
    """
    Temp table `px`: every swap with
      valid     price > 0, trade >= MIN_PRICE_SOL and >= MIN_PRICE_TOKENS tokens
      rm        price / median of the mint's previous TRAIL_WINDOW valid prices (NULL for its first valid price)
      lone      no print by another wallet among those previous valid prices is within OUTLIER_X of it, and at least
                one is not: only the print's own wallet backs its level
      ok        usable price, CAUSAL (decision-time columns, bars): valid, rm within OUTLIER_X, and not lone
      ok_label  usable for labels (entries, paths, returns): ok, or a valid print rejected for being more than OUTLIER_X
                below the market (rm, or lone under another wallet's price) when no later ok price of the mint is more
                than OUTLIER_X above it: a drop the coin never comes back from is real (a rug), and hindsight is fine
                for labels. Without it a rug's first prints stay hidden and the label keeps the pre-rug price.
    The window holds every valid price, passed or not, so `ok` heals after a real >10x move (a filter fed only the
    prices it accepted would reject everything after a rug forever). `lone` keeps one wallet's run of unit-error prints
    from healing into a level on its own; the token floor drops the micro-token prints (1e-6 .. 1e-2 tokens for a
    normal-sized SOL amount) such runs are made of.
    Temp table `pxs`: ok_label prices per (mint, second).
    """
    lo, hi = 1.0 / OUTLIER_X, OUTLIER_X
    near = f"x.p BETWEEN p / {OUTLIER_X} AND p * {OUTLIER_X}"
    con.execute(f"""
        CREATE OR REPLACE TEMP TABLE px AS
        WITH w AS (
            SELECT mint, wallet, side, t, okey, price_sol AS p, sol_amount, valid,
                   CASE WHEN valid THEN price_sol / median(price_sol) OVER win END AS rm,
                   CASE WHEN valid THEN list({{'p': price_sol, 'w': wallet}}) OVER win END AS prev
            FROM (SELECT *, coalesce(price_sol > 0 AND isfinite(price_sol) AND sol_amount >= {MIN_PRICE_SOL}
                                     AND token_amount >= {MIN_PRICE_TOKENS}, false) AS valid FROM sw)
            WINDOW win AS (PARTITION BY mint, valid ORDER BY okey ROWS BETWEEN {TRAIL_WINDOW} PRECEDING AND 1 PRECEDING)
        ), c AS (
            SELECT * EXCLUDE (prev),
                   coalesce(len(list_filter(prev, lambda x: x.w <> wallet AND {near})) = 0
                            AND len(list_filter(prev, lambda x: x.w <> wallet AND NOT ({near}))) > 0, false) AS lone,
                   coalesce(len(list_filter(prev, lambda x: x.w <> wallet AND x.p > p * {OUTLIER_X})) > 0, false) AS above
            FROM w
        ), k AS (
            SELECT *, coalesce(valid AND (rm IS NULL OR rm BETWEEN {lo} AND {hi}) AND NOT lone, false) AS ok FROM c
        )
        SELECT * EXCLUDE (above, later_hi),
               ok OR coalesce(valid AND (rm < {lo} OR (lone AND above)) AND (later_hi IS NULL OR later_hi <= p * {OUTLIER_X}), false) AS ok_label
        FROM (SELECT *, max(p) FILTER (WHERE ok) OVER (PARTITION BY mint ORDER BY okey ROWS BETWEEN 1 FOLLOWING AND UNBOUNDED FOLLOWING) AS later_hi FROM k)
    """)
    con.execute("""
        CREATE OR REPLACE TEMP TABLE pxs AS
        SELECT mint, t, arg_max(p, okey) AS close, max(p) AS hi, min(p) AS lo, count(*)::INT AS n
        FROM px WHERE ok_label GROUP BY mint, t
    """)


BARS_SQL = """
    SELECT mint, to_timestamp((t // 60) * 60) AS minute,
           arg_min(p, okey) FILTER (WHERE ok) AS open,
           max(p) FILTER (WHERE ok) AS high,
           min(p) FILTER (WHERE ok) AS low,
           arg_max(p, okey) FILTER (WHERE ok) AS close,
           count(*)::INT AS n_trades,
           (count(*) FILTER (WHERE ok))::INT AS n_priced,
           coalesce(sum(sol_amount) FILTER (WHERE side = 'buy'), 0) AS buy_sol,
           coalesce(sum(sol_amount) FILTER (WHERE side = 'sell'), 0) AS sell_sol,
           (count(DISTINCT wallet) FILTER (WHERE side = 'buy'))::INT AS n_buyers,
           (count(DISTINCT wallet) FILTER (WHERE side = 'sell'))::INT AS n_sellers
    FROM px GROUP BY mint, t // 60
"""


def build_episode_base(con: duckdb.DuckDBPyConnection, min_sol: float = MIN_LEADER_SOL) -> None:
    """
    Temp table `swq` (swaps with the per wallet+mint sequence) and `ep` (the qualifying buys). The pool table
    `pool(address, first_seen_at)` is the analyzed wallets, one row per address.
    """
    base = ", ".join(sql_str(m) for m in BASE_MINTS)
    con.execute("""
        CREATE OR REPLACE TEMP TABLE swq AS
        SELECT id, wallet, mint, side, t, okey, token_amount, token_balance_before,
               row_number() OVER (PARTITION BY wallet, mint ORDER BY okey, side) AS wseq,
               coalesce(count(*) FILTER (WHERE side = 'buy') OVER (PARTITION BY wallet, mint ORDER BY okey, side
                   ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS leader_prior_buys_mint,
               row_number() OVER (PARTITION BY mint ORDER BY okey, wallet, side) - 1 AS mint_prior_swaps
        FROM sw
    """)
    con.execute(f"""
        CREATE OR REPLACE TEMP TABLE ep AS
        SELECT s.id AS episode_id, s.wallet AS leader, s.mint, s.ts, s.t, s.slot, s.signature,
               s.sol_amount AS leader_sol, s.price_sol AS leader_price_sol, coalesce(p.ok, false) AS leader_price_ok,
               s.usd_amount AS leader_usd, s.venue, s.token_age_sec, s.quote, s.jito_tip, s.fee_lamports,
               s.token_amount AS leader_tokens,
               coalesce(s.token_balance_before, 0) + coalesce(s.token_amount, 0) AS leader_pos_tokens,
               q.wseq, q.leader_prior_buys_mint, q.mint_prior_swaps, s._src AS src,
               s.ins_ts, w.first_seen_at AS leader_first_seen_at
        FROM sw s
        JOIN pool w ON w.address = s.wallet
        JOIN swq q ON q.mint = s.mint AND q.okey = s.okey AND q.wallet = s.wallet AND q.side = s.side
        LEFT JOIN px p ON p.mint = s.mint AND p.okey = s.okey
        WHERE s.side = 'buy' AND s.sol_amount >= {float(min_sol)}
          AND s.mint NOT IN ({base})
    """)


def build_entries(con: duckdb.DuckDBPyConnection) -> None:
    """Temp table `ent`: first ok_label price at or after ts + delay (kept only within ENTRY_WINDOW_SEC), per delay."""
    cols, joins = [], []
    for d in DELAYS:
        a = f"p{d}"
        ok = f"{a}.t <= e.t + {d + ENTRY_WINDOW_SEC}"
        cols.append(f"CASE WHEN {ok} THEN {a}.p END AS entry_price_{d}")
        cols.append(f"CASE WHEN {ok} THEN ({a}.t - (e.t + {d}))::INT END AS entry_age_{d}")
        if d == PATH_DELAY:
            cols.append(f"CASE WHEN {ok} THEN {a}.t END AS t0")
        joins.append(f"ASOF LEFT JOIN (SELECT mint, okey, t, p FROM px WHERE ok_label) {a} ON e.mint = {a}.mint AND {a}.okey >= (e.t + {d}) * {OKEY_MULT}")
    con.execute(f"CREATE OR REPLACE TEMP TABLE ent AS SELECT e.episode_id, {', '.join(cols)} FROM ep e {' '.join(joins)}")


def build_e15(con: duckdb.DuckDBPyConnection) -> None:
    """Temp table `e15`: episodes with a 15 s entry: t0, p0, phase r = t0 % 60, b0 = (t0 - r) / 60, UTC day."""
    con.execute(f"""
        CREATE OR REPLACE TEMP TABLE e15 AS
        SELECT e.episode_id, e.mint, n.t0, n.entry_price_{PATH_DELAY} AS p0,
               (n.t0 % 60)::INT AS r, (n.t0 - n.t0 % 60) // 60 AS b0,
               strftime(CAST(e.ts AS DATE), '%Y-%m-%d') AS day
        FROM ep e JOIN ent n USING (episode_id)
        WHERE n.t0 IS NOT NULL
    """)


def build_paths(con: duckdb.DuckDBPyConnection, where: str = "") -> None:
    """
    Temp table `path`: for each episode with a 15 s entry (t0, p0), one row per minute k in 1..1440 that has an ok
    price in (t0 + 60(k-1), t0 + 60k], plus the anchor row k = 0 (ret 0). Returns are price / p0 - 1.

    Episodes whose t0 share the same second-of-minute phase r = t0 % 60 share minute boundaries, so the mint's prices
    are first rolled into "phase bars" (bar b covers seconds (60(b-1) + r, 60b + r]) for each (mint, r) some episode
    needs; an episode's minute k is then phase bar b0 + k with b0 = (t0 - r) / 60. The join emits path rows directly
    instead of pairing every episode with every swap of a hot mint.

    `where` (SQL on e15: episode_id, mint, t0, day, ...) restricts the episodes, so a big bucket can be done in slices.
    """
    w = f"WHERE {where}" if where else ""
    con.execute(f"CREATE OR REPLACE TEMP TABLE e15d AS SELECT * FROM e15 {w}")
    con.execute("""
        CREATE OR REPLACE TEMP TABLE pbar AS
        SELECT p.mint, u.r, (p.t - u.r + 59) // 60 AS b,
               arg_max(p.close, p.t) AS close, max(p.hi) AS hi, min(p.lo) AS lo, sum(p.n)::INT AS n, max(p.t) AS last_t
        FROM pxs p JOIN (SELECT DISTINCT mint, r FROM e15d) u ON u.mint = p.mint
        GROUP BY p.mint, u.r, b
    """)
    con.execute(f"""
        CREATE OR REPLACE TEMP TABLE path AS
        SELECT e.episode_id, (pb.b - e.b0)::SMALLINT AS k,
               (pb.close / e.p0 - 1)::FLOAT AS close_ret,
               (pb.hi / e.p0 - 1)::FLOAT AS high_ret,
               (pb.lo / e.p0 - 1)::FLOAT AS low_ret,
               pb.n, pb.last_t
        FROM e15d e JOIN pbar pb ON pb.mint = e.mint AND pb.r = e.r AND pb.b > e.b0 AND pb.b <= e.b0 + {PATH_SEC // 60}
        UNION ALL
        SELECT episode_id, 0::SMALLINT, 0::FLOAT, 0::FLOAT, 0::FLOAT, 0, t0 FROM e15d
    """)
    hcols = ", ".join(f"arg_max(close_ret, k) FILTER (WHERE k <= {s // 60}) AS ret_{h}" for h, s in HORIZONS.items())
    con.execute(f"""
        CREATE OR REPLACE TEMP TABLE pstat AS
        SELECT episode_id, {hcols},
               max(high_ret) AS max_ret_24h, min(low_ret) AS min_ret_24h,
               arg_max(k, {{'v': high_ret, 'early': -k}}) AS minutes_to_peak,
               arg_min(k, {{'v': low_ret, 'early': k}}) AS minutes_to_trough,
               min(k) FILTER (WHERE low_ret <= -0.6) AS minutes_to_stop60,
               min(k) FILTER (WHERE high_ret >= 1.0) AS minutes_to_2x,
               sum(n)::INT AS n_price_points_24h, count(*)::INT AS n_path_minutes, max(last_t) AS last_t
        FROM path WHERE k >= 1 GROUP BY episode_id
    """)


def build_leader_sells(con: duckdb.DuckDBPyConnection) -> None:
    """Temp table `lsel`: the leader's own sells of the mint after each episode (first sell, 24 h share, full exit)."""
    con.execute("""
        CREATE OR REPLACE TEMP TABLE ls AS
        SELECT wallet, mint, t, okey, wseq, coalesce(token_amount, 0) AS token_amount,
               sum(coalesce(token_amount, 0)) OVER w AS cum_tok, row_number() OVER w AS cnt
        FROM swq q WHERE side = 'sell' AND EXISTS (SELECT 1 FROM ep WHERE ep.leader = q.wallet AND ep.mint = q.mint)
        WINDOW w AS (PARTITION BY wallet, mint ORDER BY wseq)
    """)
    con.execute(f"""
        CREATE OR REPLACE TEMP TABLE lsel0 AS
        SELECT e.episode_id, e.leader, e.mint, e.t, e.leader_pos_tokens AS pos,
               f.t AS first_t, f.token_amount AS first_tok,
               coalesce(b.cum_tok, 0) AS cum0, coalesce(b.cnt, 0) AS cnt0,
               coalesce(c.cum_tok, 0) AS cum24, coalesce(c.cnt, 0) AS cnt24
        FROM ep e
        ASOF LEFT JOIN ls f ON e.leader = f.wallet AND e.mint = f.mint AND f.wseq > e.wseq
        ASOF LEFT JOIN ls b ON e.leader = b.wallet AND e.mint = b.mint AND b.wseq < e.wseq
        ASOF LEFT JOIN ls c ON e.leader = c.wallet AND e.mint = c.mint AND c.okey <= (e.t + {PATH_SEC}) * {OKEY_MULT} + {OKEY_MULT - 1}
    """)
    con.execute(f"""
        CREATE OR REPLACE TEMP TABLE lsel AS
        SELECT l.episode_id,
               to_timestamp(l.first_t) AS leader_first_sell_ts,
               (l.first_t - l.t)::BIGINT AS leader_first_sell_sec,
               CASE WHEN l.pos > 0 AND l.first_t IS NOT NULL THEN least(1.0, l.first_tok / l.pos) END AS leader_first_sell_frac,
               CASE WHEN l.pos > 0 THEN least(1.0, greatest(0.0, (l.cum24 - l.cum0) / l.pos)) END AS leader_sold_frac_24h,
               (l.cnt24 - l.cnt0)::INT AS leader_n_sells_24h,
               (x.t - l.t)::BIGINT AS leader_exit_sec
        FROM lsel0 l
        ASOF LEFT JOIN ls x ON l.leader = x.wallet AND l.mint = x.mint AND x.cum_tok >= l.cum0 + {LEADER_EXIT_FRAC} * l.pos
    """)


def episodes_sql(label_end_t: int) -> str:
    """
    The final episode rows from ep, ent, pstat, lsel and the `outage` hours. Horizon returns past label_end_t (the end
    of the complete tape: label_end, i.e. the data end or the start of the export tail) are NULL (censored).
    """
    hret = []
    for h, s in HORIZONS.items():
        hret.append(f"CASE WHEN n.t0 + {s} <= {label_end_t} THEN p.ret_{h} END AS ret_{h}")
    ent_cols = []
    for d in DELAYS:
        ent_cols += [f"n.entry_price_{d}", f"n.entry_age_{d}",
                     f"CASE WHEN e.leader_price_ok THEN n.entry_price_{d} / e.leader_price_sol - 1 END AS entry_vs_leader_{d}"]
    return f"""
        SELECT e.episode_id, e.leader, e.mint, e.ts, e.slot, e.signature,
               CAST(e.ts AS DATE) AS day,
               CASE WHEN e.ts >= TIMESTAMPTZ '{TEST_START}' THEN 'test' ELSE 'train' END AS split,
               {splits.period_sql('e.ts')} AS period,
               e.ins_ts, e.leader_first_seen_at, coalesce(e.ts >= e.leader_first_seen_at, false) AS known_at_t,
               EXISTS (SELECT 1 FROM outage o WHERE o.h >= e.t // 3600 * 3600 AND o.h <= e.t + {VALUATION_SEC}) AS crosses_outage,
               e.leader_sol, e.leader_price_sol, e.leader_price_ok, e.leader_usd, e.venue, e.token_age_sec, e.quote,
               e.jito_tip, e.fee_lamports, e.leader_tokens, e.leader_pos_tokens, e.leader_prior_buys_mint,
               e.mint_prior_swaps, e.src,
               {', '.join(ent_cols)},
               to_timestamp(n.t0) AS entry_ts_15,
               {', '.join(hret)},
               p.max_ret_24h, p.min_ret_24h, p.minutes_to_peak, p.minutes_to_trough, p.minutes_to_stop60, p.minutes_to_2x,
               coalesce(p.n_price_points_24h, CASE WHEN n.t0 IS NOT NULL THEN 0 END) AS n_price_points_24h,
               coalesce(p.n_path_minutes, CASE WHEN n.t0 IS NOT NULL THEN 0 END) AS n_path_minutes,
               to_timestamp(p.last_t) AS last_price_ts,
               (n.t0 + {PATH_SEC} > {label_end_t}) AS censored_24h,
               l.leader_first_sell_ts, l.leader_first_sell_sec, l.leader_first_sell_frac, l.leader_sold_frac_24h,
               l.leader_n_sells_24h, l.leader_exit_sec
        FROM ep e
        JOIN ent n USING (episode_id)
        LEFT JOIN pstat p USING (episode_id)
        LEFT JOIN lsel l USING (episode_id)
    """


PATHS_SQL = """
    SELECT p.episode_id, p.k, p.close_ret, p.high_ret, p.low_ret, p.n, strftime(CAST(e.ts AS DATE), '%Y-%m-%d') AS day
    FROM path p JOIN ep e USING (episode_id)
"""


def run_core(con: duckdb.DuckDBPyConnection, data_end_t: int, min_sol: float = MIN_LEADER_SOL, outage=()) -> None:
    """All steps on the `sw` and `pool` temp tables; leaves `px`, `ep`, `path`, ... as temp tables."""
    set_outage(con, outage)
    build_prices(con)
    build_episode_base(con, min_sol)
    build_entries(con)
    build_e15(con)
    build_paths(con)
    build_leader_sells(con)


def drop_temps(con: duckdb.DuckDBPyConnection) -> None:
    for t in ("sw", "px", "pxs", "swq", "ep", "ent", "e15", "e15d", "pbar", "path", "pstat_all", "bars", "pstat", "ls", "lsel0", "lsel"):
        con.execute(f"DROP TABLE IF EXISTS {t}")


# --------------------------------------------------------------------------------------------------------------------
# Full build
# --------------------------------------------------------------------------------------------------------------------

def rmtree(p: Path) -> None:
    """shutil.rmtree that tolerates macOS deleting a `._x` twin on its own when `x` goes (FAT32 drive)."""
    def onexc(func, path, exc):
        if not isinstance(exc, FileNotFoundError):
            raise exc
    if p.exists():
        shutil.rmtree(p, onexc=onexc)


def log(msg: str) -> None:
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


def split_swaps(con: duckdb.DuckDBPyConnection, sources: list[tuple[str, int]], out: Path, n_buckets: int,
                per_pass: int = 8) -> None:
    """
    Write swaps/bucket=k/*.parquet by hash(mint) % n_buckets (not yet deduped). A few passes of `per_pass` buckets
    each: one PARTITION_BY over all buckets buffers too much under the 1.2 GB limit and crawls on the USB drive.
    """
    u = " UNION ALL ".join(swap_select(g, s) for g, s in sources)
    for lo in range(0, n_buckets, per_pass):
        hi = min(n_buckets, lo + per_pass)
        con.execute(f"""
            COPY (SELECT * FROM (SELECT *, (hash(mint) % {n_buckets})::INT AS bucket FROM ({u})) WHERE bucket >= {lo} AND bucket < {hi})
            TO {sql_str(out)} (FORMAT parquet, PARTITION_BY (bucket), COMPRESSION zstd, OVERWRITE_OR_IGNORE true)
        """)
        log(f"  split buckets {lo}..{hi - 1}")


PATH_CHUNK_EPISODES = 20_000  # episodes per path slice: bounds the path rows held at once (<= 1441 per episode)


def process_bucket(con: duckdb.DuckDBPyConnection, stage: Path, k: int, label_end_t: int) -> dict:
    """
    Everything for the swaps in temp table `sw`: bars, the bucket's episode part, and its paths written one
    (day, slice) at a time, so a coin traded all day by thousands of leaders (e.g. PUMP) never holds all its paths at once.
    """
    build_prices(con)
    build_episode_base(con)
    build_entries(con)
    build_e15(con)
    build_leader_sells(con)
    con.execute(f"CREATE OR REPLACE TEMP TABLE bars AS {BARS_SQL}")
    con.execute(f"COPY (SELECT * FROM bars ORDER BY mint, minute) TO {sql_str(stage / 'bars_1m' / f'b{k:02d}.parquet')} (FORMAT parquet, COMPRESSION zstd)")
    path_rows = 0
    first = True
    for d, n in con.execute("SELECT day, count(*) FROM e15 GROUP BY day ORDER BY day").fetchall():
        out = stage / "episode_paths" / f"day={d}"
        out.mkdir(parents=True, exist_ok=True)
        slices = max(1, -(-n // PATH_CHUNK_EPISODES))
        for j in range(slices):
            build_paths(con, f"day = '{d}' AND hash(episode_id) % {slices} = {j}")
            name = f"b{k:02d}.parquet" if slices == 1 else f"b{k:02d}_{j:02d}.parquet"
            con.execute(f"COPY (SELECT episode_id, k, close_ret, high_ret, low_ret, n FROM path ORDER BY episode_id, k) TO {sql_str(out / name)} (FORMAT parquet, COMPRESSION zstd)")
            path_rows += con.execute("SELECT count(*) FROM path").fetchone()[0]
            if first:
                con.execute("CREATE OR REPLACE TEMP TABLE pstat_all AS SELECT * FROM pstat")
                first = False
            else:
                con.execute("INSERT INTO pstat_all SELECT * FROM pstat")
    if first:  # no episode with an entry in this bucket: an empty pstat with the right columns
        build_paths(con, "false")
    else:
        con.execute("CREATE OR REPLACE TEMP TABLE pstat AS SELECT * FROM pstat_all")
    con.execute(f"COPY ({episodes_sql(label_end_t)} ORDER BY ts, episode_id) TO {sql_str(stage / '_episodes' / f'b{k:02d}.parquet')} (FORMAT parquet, COMPRESSION zstd)")
    return {
        "swaps": con.execute("SELECT count(*) FROM sw").fetchone()[0],
        "bars": con.execute("SELECT count(*) FROM bars").fetchone()[0],
        "episodes": con.execute("SELECT count(*) FROM ep").fetchone()[0],
        "path_rows": path_rows,
    }


def merge_episodes(con: duckdb.DuckDBPyConnection, parts: Path, dest: Path) -> None:
    """One episodes.parquet ordered by (ts, episode_id), streamed day by day so no global sort is held in memory."""
    import pyarrow.parquet as pq

    src = f"read_parquet({sql_str(parquet_glob(parts))})"
    days = [r[0] for r in con.execute(f"SELECT DISTINCT day FROM {src} ORDER BY day").fetchall()]
    writer = None
    try:
        for j, d in enumerate(days):
            log(f"  episodes of {d} ({j + 1}/{len(days)})")
            reader = con.sql(f"SELECT * FROM {src} WHERE day = DATE '{d}' ORDER BY ts, episode_id").to_arrow_reader(100_000)
            for batch in reader:
                if writer is None:
                    writer = pq.ParquetWriter(str(dest), batch.schema, compression="zstd")
                writer.write_batch(batch)
    finally:
        if writer is not None:
            writer.close()


def clear_bucket(stage: Path, k: int) -> None:
    """Remove whatever an interrupted run left for bucket k."""
    for f in [stage / "bars_1m" / f"b{k:02d}.parquet", stage / "_episodes" / f"b{k:02d}.parquet",
              *(stage / "episode_paths").glob(f"day=*/b{k:02d}*.parquet")]:
        try:
            f.unlink()
        except FileNotFoundError:
            pass


def build(root: Path | None = None, n_buckets: int = 32, only_buckets: list[int] | None = None, archive: bool = True,
          memory_limit: str = "1200MB", threads: int = 2, resume: bool = False) -> dict:
    root = root or data_dir()
    t_start = time.time()
    sources = swap_sources(root, archive)
    if not sources:
        raise SystemExit(f"no wallet_swaps parquet under {export_dir(root)}")
    wallets_dir = export_dir(root) / "wallets"
    if not has_parquet(wallets_dir):
        raise SystemExit("export/wallets missing: it defines the analyzed pool")
    # a partial build (--only) never replaces the real outputs: it lands in derived/_partial/
    dd = derived_dir(root) if only_buckets is None else derived_dir(root) / "_partial"
    dd.mkdir(parents=True, exist_ok=True)
    old_stages = sorted(dd.glob("_build_*"))
    if resume and old_stages:
        stage = old_stages[-1]
        meta_b = json.loads((stage / "_build.json").read_text()) if (stage / "_build.json").is_file() else {}
        if meta_b.get("n_buckets", n_buckets) != n_buckets:
            raise SystemExit(f"{stage} was split into {meta_b['n_buckets']} buckets: pass --buckets {meta_b['n_buckets']}")
        log(f"resuming {stage.name}")
    else:
        for o in old_stages:
            rmtree(o)
        stage = dd / f"_build_{int(t_start)}"
    for sub in ("bars_1m", "episode_paths", "_episodes", "_done"):
        (stage / sub).mkdir(parents=True, exist_ok=True)
    (stage / "_build.json").write_text(json.dumps({"n_buckets": n_buckets, "sources": [g for g, _ in sources]}))
    con = duckdb.connect()
    configure(con, memory_limit, threads, root / "tmp" / "duckdb")

    log(f"sources: {[g for g, _ in sources]}")
    data_start_t, data_end_t = None, 0
    for g, s in sources:
        lo, hi = con.execute(f"SELECT min(epoch(ts))::BIGINT, max(epoch(ts))::BIGINT FROM ({swap_select(g, s)})").fetchone()
        data_end_t = max(data_end_t, hi or 0)
        data_start_t = lo if data_start_t is None or (lo is not None and lo < data_start_t) else data_start_t
    log(f"data end {datetime.fromtimestamp(data_end_t, timezone.utc).isoformat()}")

    # global passes over all swaps (a bucket holds only some mints): the insert-time proxy and the outage hours
    union = swaps_view_sql(sources)
    if not (stage / "ins_steps.parquet").is_file():
        log("insert-time steps")
        con.execute(f"COPY ({ins_steps_sql(union)}) TO {sql_str(stage / '_ins_steps.parquet')} (FORMAT parquet)")
        (stage / "_ins_steps.parquet").rename(stage / "ins_steps.parquet")
    con.execute(f"CREATE OR REPLACE TEMP TABLE ins_steps AS SELECT * FROM read_parquet({sql_str(stage / 'ins_steps.parquet')})")
    # always recomputed (a minute): a resumed build must not label with a stale export tail or outage mask
    log("hourly swap counts and insert lags")
    lag_hist = con.execute(insert_lag_sql(union, "ins_steps", data_end_t - LAG_CAP_SEC - LAG_REF_SEC, data_end_t - LAG_CAP_SEC)).df()
    hourly = outage_hours(con.execute(hourly_swaps_sql(union)).df(), data_start_t, data_end_t, lag_hist)
    hourly.to_parquet(stage / "hourly_swaps.parquet", index=False)
    hourly[hourly["masked"]].drop(columns=["masked"]).to_parquet(stage / "outage_hours.parquet", index=False)
    set_outage(con, hourly.loc[hourly["masked"], "h"].tolist())
    label_end_t = label_end(hourly, data_end_t)
    log(f"outage hours: {int(hourly['masked'].sum())} of {len(hourly)} ({int(hourly['export_tail'].sum())} in the export tail); "
        f"labels end {datetime.fromtimestamp(label_end_t, timezone.utc).isoformat()}")
    labels = {"label_end_t": label_end_t, "outage": [int(h) for h in hourly.loc[hourly["masked"], "h"]]}
    labels_p = stage / "_labels.json"
    if not (labels_p.is_file() and json.loads(labels_p.read_text()) == labels):
        stale = list((stage / "_done").glob("b*.json"))
        if stale:  # buckets labelled with another tail / mask (or by a build that did not record one)
            log(f"label end or outage hours changed: redoing the {len(stale)} finished buckets")
            for f in stale:
                f.unlink()
        labels_p.write_text(json.dumps(labels))

    if (stage / "swaps" / "_split_done").is_file():
        log("swaps already split")
    else:
        log(f"splitting swaps into {n_buckets} mint buckets")
        rmtree(stage / "swaps")
        split_swaps(con, sources, stage / "swaps", n_buckets)
        (stage / "swaps" / "_split_done").write_text("ok")
    wg = parquet_glob(wallets_dir)
    fs = "TRY_CAST(first_seen_at AS TIMESTAMPTZ)" if "first_seen_at" in present_columns(wg) else "NULL::TIMESTAMPTZ"
    con.execute(f"""
        CREATE OR REPLACE TEMP TABLE pool AS
        SELECT address, min({fs}) AS first_seen_at FROM read_parquet({sql_str(wg)}, union_by_name=true)
        WHERE address IS NOT NULL GROUP BY address
    """)

    buckets = only_buckets if only_buckets is not None else list(range(n_buckets))
    counts = {"swaps": 0, "bars": 0, "episodes": 0, "path_rows": 0}
    for k in buckets:
        tb = time.time()
        done = stage / "_done" / f"b{k:02d}.json"
        if done.is_file():
            c = json.loads(done.read_text())
            for key in counts:
                counts[key] += c[key]
            continue
        clear_bucket(stage, k)
        bdir = stage / "swaps" / f"bucket={k}"
        if not has_parquet(bdir):
            done.write_text(json.dumps({key: 0 for key in counts}))
            continue
        prepare_swaps(con, f"SELECT * EXCLUDE (bucket) FROM read_parquet({sql_str(parquet_glob(bdir))})", "ins_steps")
        c = process_bucket(con, stage, k, label_end_t)
        done.write_text(json.dumps(c))
        for key in counts:
            counts[key] += c[key]
        drop_temps(con)
        log(f"bucket {k:02d}: {c} in {time.time() - tb:.0f}s")

    log("writing episodes.parquet")
    if has_parquet(stage / "_episodes"):
        merge_episodes(con, stage / "_episodes", stage / "episodes.parquet")
    con.close()
    rmtree(stage / "_episodes")
    rmtree(stage / "swaps")

    meta = {
        "built_at": datetime.now(timezone.utc).isoformat(),
        "build_seconds": round(time.time() - t_start),
        "sources": [g for g, _ in sources],
        "data_end_ts": datetime.fromtimestamp(data_end_t, timezone.utc).isoformat(),
        "data_end_t": data_end_t,
        "label_end_ts": datetime.fromtimestamp(label_end_t, timezone.utc).isoformat(),
        "label_end_t": label_end_t,
        "n_buckets": n_buckets,
        "buckets_built": buckets,
        "params": {
            "delays": DELAYS, "entry_window_sec": ENTRY_WINDOW_SEC, "path_delay": PATH_DELAY, "horizons": HORIZONS,
            "min_leader_sol": MIN_LEADER_SOL, "min_price_sol": MIN_PRICE_SOL, "min_price_tokens": MIN_PRICE_TOKENS,
            "outlier_x": OUTLIER_X,
            "price_filter": f"trailing: median of the previous {TRAIL_WINDOW} valid prices of the mint, not backed by its own "
                            "wallet alone; labels also keep > 10x drops the price never climbs back from",
            "trail_window": TRAIL_WINDOW, "leader_exit_frac": LEADER_EXIT_FRAC, "test_start": TEST_START,
            "base_mints_excluded": BASE_MINTS, "valuation_sec": VALUATION_SEC, "outage_share": OUTAGE_SHARE,
            "outage_days": OUTAGE_DAYS, "outage_min_days": OUTAGE_MIN_DAYS, "outage_min_cover_sec": OUTAGE_MIN_COVER_SEC,
            "outage_ext_back": OUTAGE_EXT_BACK, "outage_ext_fwd": OUTAGE_EXT_FWD, "complete_share": COMPLETE_SHARE,
            "lag_cap_sec": LAG_CAP_SEC, "lag_ref_sec": LAG_REF_SEC, "fwd_min_complete": FWD_MIN_COMPLETE,
            "splits": splits.load(),
        },
        "data_start_t": data_start_t,
        "outage_hours": [datetime.fromtimestamp(int(h), timezone.utc).isoformat() for h in hourly.loc[hourly["masked"], "h"]],
        "export_tail_hours": int(hourly["export_tail"].sum()),
        "counts": counts,
    }
    (stage / "_meta.json").write_text(json.dumps(meta, indent=1))

    # swap the staged build in
    for name in ("bars_1m", "episode_paths", "episodes.parquet", "ins_steps.parquet", "hourly_swaps.parquet",
                 "outage_hours.parquet", "_meta.json"):
        old = dd / name
        if not (stage / name).exists():
            continue
        if old.is_dir():
            rmtree(old)
        elif old.exists():
            old.unlink()
        (stage / name).rename(old)
    rmtree(stage)
    for p in dd.glob("._*"):  # macOS AppleDouble twins of files we just replaced
        try:
            p.unlink()
        except OSError:
            pass
    log(f"done in {time.time() - t_start:.0f}s: {counts}")
    return meta


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--buckets", type=int, default=32, help="number of mint-hash buckets")
    ap.add_argument("--only", type=str, default="", help="comma-separated bucket numbers (for a quick test build)")
    ap.add_argument("--no-archive", action="store_true", help="ignore export/wallet_swaps_archive")
    ap.add_argument("--root", type=str, default="", help="data dir (default brain.config.DATA_DIR)")
    ap.add_argument("--resume", action="store_true", help="continue the newest interrupted build (same --buckets)")
    a = ap.parse_args(argv)
    only = [int(x) for x in a.only.split(",") if x.strip()] or None
    build(Path(a.root) if a.root else None, a.buckets, only, not a.no_archive, resume=a.resume)
    return 0


if __name__ == "__main__":
    sys.exit(main())
