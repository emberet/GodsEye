"""
DuckDB views over the exported server tables and the derived research datasets.

    from brain.data import connect
    con = connect()                       # views: wallet_swaps, closed_trades, ..., episodes, bars_1m, episode_paths
    con.sql("select count(*) from episodes").fetchone()
    con.sql("select ins_ts from wallet_swaps_ins where ...")   # wallet_swaps + the insert-time proxy (ins_ts)

Every connection is opened with the team's resource limits (memory_limit 1200MB, 2 threads, temp files on the data
drive) and TimeZone=UTC, so TIMESTAMPTZ columns print and truncate in UTC.

Parquet is always globbed with `[!.]*.parquet`: macOS writes `._*` AppleDouble twins on the FAT32 drive that are not
Parquet and make read_parquet fail.

`wallet_swaps` is the union of export/wallet_swaps and export/wallet_swaps_archive (swaps the server moved out of the
live table), deduplicated on (signature, wallet, mint, side) with the live export winning. Columns are cast to the live
table's types, so the archive may be written with looser types (e.g. ts as an ISO string).
"""
from __future__ import annotations

from pathlib import Path

import duckdb

from brain import config

PARQUET_GLOB = "[!.]*.parquet"

# The live wallet_swaps schema. The archive is cast to it column by column (missing columns become NULL).
SWAP_COLUMNS: dict[str, str] = {
    "id": "BIGINT",
    "wallet": "VARCHAR",
    "signature": "VARCHAR",
    "slot": "BIGINT",
    "ts": "TIMESTAMPTZ",
    "mint": "VARCHAR",
    "side": "VARCHAR",
    "token_amount": "DOUBLE",
    "token_balance_before": "DOUBLE",
    "sol_amount": "DOUBLE",
    "price_sol": "DOUBLE",
    "venue": "VARCHAR",
    "jito_tip": "BIGINT",
    "fee_lamports": "BIGINT",
    "token_age_sec": "DOUBLE",
    "quote": "VARCHAR",
    "quote_amount": "DOUBLE",
    "sol_usd": "DOUBLE",
    "usd_amount": "DOUBLE",
}

DERIVED_TABLES = ("episodes", "bars_1m", "episode_paths", "ins_steps", "hourly_swaps", "outage_hours")


def data_dir() -> Path:
    """BRAIN_DATA_DIR (via brain.config), falling back to the external drive if the configured dir has no export."""
    d = Path(config.DATA_DIR)
    if (d / "export").is_dir():
        return d
    drive = Path("/Volumes/HP -E1/GodsEyeBrainData")
    return drive if (drive / "export").is_dir() else d


def export_dir(root: Path | None = None) -> Path:
    return (root or data_dir()) / "export"


def derived_dir(root: Path | None = None) -> Path:
    return (root or data_dir()) / "derived"


def sql_str(s: str | Path) -> str:
    """A SQL string literal (paths contain a space and could contain a quote)."""
    return "'" + str(s).replace("'", "''") + "'"


def has_parquet(d: Path, recursive: bool = False) -> bool:
    if not d.is_dir():
        return False
    it = d.rglob("*.parquet") if recursive else d.glob("*.parquet")
    return any(not p.name.startswith(".") for p in it)


def parquet_glob(d: Path) -> str:
    return str(d / PARQUET_GLOB)


def configure(con: duckdb.DuckDBPyConnection, memory_limit: str = "1200MB", threads: int = 2, temp_dir: Path | None = None) -> None:
    con.execute(f"SET memory_limit='{memory_limit}'")
    con.execute(f"SET threads={int(threads)}")
    td = temp_dir or (data_dir() / "tmp" / "duckdb")
    try:
        td.mkdir(parents=True, exist_ok=True)
        con.execute(f"SET temp_directory={sql_str(td)}")
    except OSError:
        pass  # drive unplugged (e.g. tests): keep duckdb's default temp dir
    con.execute("SET TimeZone='UTC'")
    con.execute("SET preserve_insertion_order=false")
    con.execute("SET enable_progress_bar=false")


def swap_select(source_glob: str, src: int) -> str:
    """SELECT over one swaps source, cast to the live schema, tagged with `_src` (0 = live export, 1 = archive)."""
    return f"SELECT {swap_cast_list(source_glob)}, {src} AS _src FROM read_parquet({sql_str(source_glob)}, union_by_name=true)"


def swap_cast_list(source_glob: str) -> str:
    cols = present_columns(source_glob)
    parts = []
    for c, t in SWAP_COLUMNS.items():
        parts.append(f"TRY_CAST({c} AS {t}) AS {c}" if c in cols else f"NULL::{t} AS {c}")
    return ", ".join(parts)


def present_columns(source_glob: str) -> set[str]:
    con = duckdb.connect()
    try:
        rows = con.execute(f"DESCRIBE SELECT * FROM read_parquet({sql_str(source_glob)}, union_by_name=true)").fetchall()
    finally:
        con.close()
    return {r[0] for r in rows}


def swap_sources(root: Path | None = None, archive: bool = True) -> list[tuple[str, int]]:
    """(glob, src) for every swaps source with data: the live export first, then the archive."""
    e = export_dir(root)
    out = []
    if has_parquet(e / "wallet_swaps"):
        out.append((parquet_glob(e / "wallet_swaps"), 0))
    if archive and has_parquet(e / "wallet_swaps_archive"):
        out.append((parquet_glob(e / "wallet_swaps_archive"), 1))
    return out


def swaps_union_sql(sources: list[tuple[str, int]], where: str = "") -> str:
    """
    All swaps from `sources`, deduplicated on (signature, wallet, mint, side), preferring the lower `_src` then lower id.
    `where` (SQL on the swap columns) is applied before the dedupe, e.g. a mint bucket. Keeps the `_src` column.
    """
    if not sources:
        raise FileNotFoundError("no wallet_swaps parquet found")
    w = f" WHERE {where}" if where else ""
    parts = [f"SELECT * FROM ({swap_select(g, s)}){w}" for g, s in sources]
    if len(parts) == 1:
        return parts[0]
    u = " UNION ALL ".join(parts)
    return (
        f"SELECT * EXCLUDE (_rn) FROM (SELECT *, row_number() OVER (PARTITION BY signature, wallet, mint, side "
        f"ORDER BY _src, id) AS _rn FROM ({u})) WHERE _rn = 1"
    )


def swaps_view_sql(sources: list[tuple[str, int]]) -> str:
    """
    The wallet_swaps view: the live export plus archive rows whose (signature, wallet, mint, side) is not in the live
    export. Uses a 64-bit hash of the key for the anti-join so the build side stays small (~8 bytes per live swap).
    """
    if len(sources) == 1:
        return f"SELECT * EXCLUDE (_src) FROM ({swap_select(*sources[0])})"
    live = swap_select(*sources[0])
    arch = " UNION ALL ".join(swap_select(g, s) for g, s in sources[1:])
    return (
        f"SELECT * EXCLUDE (_src) FROM ({live}) UNION ALL "
        f"SELECT * EXCLUDE (_src, _k) FROM (SELECT *, hash(signature, wallet, mint, side) AS _k FROM ({arch})) a "
        f"WHERE NOT EXISTS (SELECT 1 FROM (SELECT hash(signature, wallet, mint, side) AS _k FROM "
        f"read_parquet({sql_str(sources[0][0])})) l WHERE l._k = a._k)"
    )


def connect(
    root: Path | str | None = None,
    *,
    archive: bool = True,
    derived: bool = True,
    memory_limit: str = "1200MB",
    threads: int = 2,
    database: str = ":memory:",
) -> duckdb.DuckDBPyConnection:
    """
    A duckdb connection with one view per exported table (named like the table) plus `wallet_swaps_live`
    (export only), `wallet_swaps_archive` (when present), `wallet_swaps_ins` (wallet_swaps + ins_ts) and, when built,
    the derived `episodes`, `bars_1m`, `episode_paths`, `ins_steps`, `hourly_swaps`, `outage_hours` views.
    """
    root = Path(root) if root else data_dir()
    con = duckdb.connect(database)
    configure(con, memory_limit, threads, root / "tmp" / "duckdb")
    e = export_dir(root)
    if e.is_dir():
        for d in sorted(e.iterdir()):
            if not d.is_dir() or d.name.startswith((".", "_")) or not has_parquet(d):
                continue
            if d.name in ("wallet_swaps", "wallet_swaps_archive"):
                continue
            con.execute(f"CREATE OR REPLACE VIEW {d.name} AS SELECT * FROM read_parquet({sql_str(parquet_glob(d))}, union_by_name=true)")
    sources = swap_sources(root, archive)
    if sources:
        con.execute(f"CREATE OR REPLACE VIEW wallet_swaps AS {swaps_view_sql(sources)}")
        for g, s in sources:
            name = "wallet_swaps_live" if s == 0 else "wallet_swaps_archive"
            con.execute(f"CREATE OR REPLACE VIEW {name} AS SELECT * EXCLUDE (_src) FROM ({swap_select(g, s)})")
    if derived:
        attach_derived(con, root)
    if sources:
        con.execute(f"CREATE OR REPLACE VIEW wallet_swaps_ins AS {swaps_ins_view_sql(con)}")
    return con


def swaps_ins_view_sql(con: duckdb.DuckDBPyConnection) -> str:
    """
    wallet_swaps plus ins_ts, the insert-time proxy (features.yaml INSERT-TIME RULE): the running max of ts in id
    (insert) order, never below the swap's own ts. A swap counts at decision time t only if ins_ts < t.
    Uses derived/ins_steps.parquet when built (an ASOF join on id); swaps with an id above the ones it covers (an export
    pulled after the last derive) get ins_ts NULL until derive runs again. Without it, a window over every swap (slow).
    """
    has_steps = con.execute("SELECT count(*) FROM duckdb_views() WHERE view_name = 'ins_steps'").fetchone()[0] > 0
    if not has_steps:
        return ("SELECT *, to_timestamp(greatest(max(epoch(ts)::BIGINT) OVER (ORDER BY id ROWS BETWEEN UNBOUNDED PRECEDING "
                "AND CURRENT ROW), epoch(ts)::BIGINT)) AS ins_ts FROM wallet_swaps")
    return (
        "SELECT s.*, CASE WHEN s.id <= (SELECT max(id) FROM ins_steps) "
        "THEN to_timestamp(greatest(i.ins_t, epoch(s.ts)::BIGINT)) END AS ins_ts "
        "FROM wallet_swaps s ASOF LEFT JOIN ins_steps i ON s.id >= i.id"
    )


def attach_derived(con: duckdb.DuckDBPyConnection, root: Path | None = None) -> None:
    dd = derived_dir(root)
    ep = dd / "episodes.parquet"
    if ep.is_file():
        con.execute(f"CREATE OR REPLACE VIEW episodes AS SELECT * FROM read_parquet({sql_str(ep)})")
    if has_parquet(dd / "bars_1m"):
        con.execute(f"CREATE OR REPLACE VIEW bars_1m AS SELECT * FROM read_parquet({sql_str(parquet_glob(dd / 'bars_1m'))})")
    for name in ("ins_steps", "hourly_swaps", "outage_hours"):
        f = dd / f"{name}.parquet"
        if f.is_file():
            con.execute(f"CREATE OR REPLACE VIEW {name} AS SELECT * FROM read_parquet({sql_str(f)})")
    if has_parquet(dd / "episode_paths", recursive=True):
        g = dd / "episode_paths" / "*" / PARQUET_GLOB
        con.execute(f"CREATE OR REPLACE VIEW episode_paths AS SELECT * FROM read_parquet({sql_str(g)}, hive_partitioning=true)")


def tables(con: duckdb.DuckDBPyConnection) -> list[str]:
    return sorted(r[0] for r in con.execute("SELECT view_name FROM duckdb_views() WHERE NOT internal").fetchall())


if __name__ == "__main__":  # quick listing: python -m brain.data.loaders
    c = connect()
    for t in tables(c):
        print(t, c.execute(f"SELECT count(*) FROM {t}").fetchone()[0])


def dense_paths(path, max_k: int = 1440, last_k=None):
    """
    Expand sparse episode_paths rows (observed minutes only) to the dense per-minute grid k = 0..max_k.

    `path`: DataFrame with episode_id, k, close_ret, high_ret, low_ret, n (every episode must have its k = 0 anchor).
    `last_k`: optional {episode_id: last minute inside the data} (e.g. (data_end_t - t0) // 60 from episodes);
    minutes after it are dropped instead of forward-filled past the end of the data.
    Returns episode_id, k, close_ret (forward-filled), high_ret / low_ret (the minute's own extremes when observed,
    else the carried close), n (0 when not observed), observed, minutes_since_price.
    """
    import numpy as np
    import pandas as pd

    p = path.sort_values(["episode_id", "k"])
    ids = np.unique(p["episode_id"].to_numpy())
    width = max_k + 1
    total = len(ids) * width
    eid = np.repeat(ids, width)
    kk = np.tile(np.arange(width, dtype=np.int16), len(ids))
    row = np.searchsorted(ids, p["episode_id"].to_numpy()) * width + p["k"].to_numpy().astype(np.int64)
    observed = np.zeros(total, dtype=bool)
    observed[row] = True
    # index of the last observed row at or before each grid cell, within the same episode
    idx = np.where(observed, np.arange(total), -1)
    idx = np.maximum.accumulate(idx)
    src = np.full(total, -1, dtype=np.int64)
    src[row] = np.arange(len(p))
    take = src[idx]
    close = p["close_ret"].to_numpy(dtype=np.float32)[take]
    hi = np.where(observed, p["high_ret"].to_numpy(dtype=np.float32)[take], close)
    lo = np.where(observed, p["low_ret"].to_numpy(dtype=np.float32)[take], close)
    n = np.where(observed, p["n"].to_numpy()[take], 0)
    since = (np.arange(total) - idx).astype(np.int16)
    out = pd.DataFrame({"episode_id": eid, "k": kk, "close_ret": close, "high_ret": hi, "low_ret": lo, "n": n,
                        "observed": observed, "minutes_since_price": since})
    if last_k is not None:
        lk = pd.Series(last_k).reindex(ids).fillna(max_k).to_numpy()
        out = out[out["k"].to_numpy() <= np.repeat(lk, width)]
    return out.reset_index(drop=True)
