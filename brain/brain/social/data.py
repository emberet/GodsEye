"""
Loads what the social model trains on, as features.SocialTables plus the copy outcomes its target averages.

  private/<table>/       social_wallet_accounts, social_accounts, social_account_snapshots, social_posts (pulled into
                         PRIVATE_DIR by brain.export.pull and brain.social.pull; a table not pulled yet reads as empty)
  export wallets         funder + funder_filled_at (only when the server has that column)
  wallet_swaps           each linked wallet's first buy of each coin its posts name, with the INSERT-TIME rule of
                         features.yaml: known_at = the running max of ts in id (insert) order
  copy outcomes          the strict mirror ledger (export/mirror_ledger, the snapshot parts brain.social.pull writes, or
                         derived/mirror_ledger*.parquet) when it exists; until then the research reference label
                         (research/social/eligible.parquet, built by
                         brain/research/social/_common.eligible), said so in the log. Either way only copies the server
                         could have made count: the leader was in the wallets table at the buy (known_at_t, splits.yaml).
                         Two cuts of them: the first buy of each coin (the y14 target) and every resolved row (what
                         own_record_shrunk averages, as the server's scorer reads the ledger)
  ledger coverage        the server deletes mirror_ledger rows bought more than 8 days ago (ledger.ts LEDGER_KEEP_MS), so
                         the Mac's copy is the part files it has pulled, each one the server's ledger as it was then.
                         Rows seen in several parts count once (the resolved version wins). Each part covers the buys from
                         its earliest to its latest; the ledger covers the newest unbroken stretch of them (a gap longer
                         than the retention between two pulls starts it again). Windows that reach before its start are
                         partial: train.py labels no as-of day there, and a coin whose first buy fell before it has no
                         first buy here (drop_pruned_firsts)

Every time is unix seconds (float). Nothing here prints a wallet, a handle or a post.
"""
from __future__ import annotations

import json
from pathlib import Path

import duckdb
import numpy as np
import pandas as pd

from brain import config
from brain.data.loaders import configure, data_dir, derived_dir, has_parquet, parquet_glob, sql_str
from brain.social.features import SocialTables

SOCIAL_TABLES = ("social_wallet_accounts", "social_accounts", "social_account_snapshots", "social_posts")
BLOCK = 65_536  # wallet_swaps ids per block when approximating insert time


def to_sec(s: pd.Series) -> pd.Series:
    """Unix seconds (float) from ISO strings, timestamps or numbers (ms when above 1e11). NaN when missing."""
    if pd.api.types.is_numeric_dtype(s) and not pd.api.types.is_bool_dtype(s):
        v = s.astype(float)
        return v.where(v < 1e11, v / 1000.0)
    ts = pd.to_datetime(s, utc=True) if pd.api.types.is_datetime64_any_dtype(s) else pd.to_datetime(s, utc=True, errors="coerce", format="mixed")
    return (ts - pd.Timestamp(0, tz="UTC")).dt.total_seconds()


def _addresses(v) -> list[str]:
    """A JSON array column (as stored by the collector) as a list."""
    if v is None or (isinstance(v, float) and np.isnan(v)):
        return []
    if isinstance(v, (list, tuple, np.ndarray)):
        return [str(x) for x in v]
    try:
        out = json.loads(v)
    except (TypeError, ValueError):
        return []
    return [str(x) for x in out] if isinstance(out, list) else []


def _con() -> duckdb.DuckDBPyConnection:
    con = duckdb.connect()
    configure(con)
    return con


def read_private(name: str, private_dir: Path | None = None) -> pd.DataFrame:
    """One private table as pulled (all part files), or an empty frame when it isn't there."""
    d = Path(private_dir or config.PRIVATE_DIR) / name
    if not has_parquet(d):
        return pd.DataFrame()
    con = _con()
    try:
        return con.sql(f"SELECT * FROM read_parquet({sql_str(parquet_glob(d))}, union_by_name=true)").df()
    finally:
        con.close()


def social_frames(raw: dict[str, pd.DataFrame]) -> SocialTables:
    """The server's social tables (column names as in agent/src/social/schema.ts) -> SocialTables, times in seconds.
    first_buys, ledger and funders are left empty: see first_buys(), copies() and funders()."""
    def col(df, name, default=None):
        return df[name] if name in df else pd.Series(default, index=df.index, dtype=object)

    la = raw.get("social_wallet_accounts", pd.DataFrame())
    links = pd.DataFrame({"wallet": col(la, "wallet"), "author_id": col(la, "author_id"), "how": col(la, "how"),
                          "first_seen": to_sec(col(la, "first_seen_at"))}).dropna(subset=["wallet", "author_id", "first_seen"])
    ac = raw.get("social_accounts", pd.DataFrame())
    accounts = pd.DataFrame({"id": col(ac, "id"), "created_at": to_sec(col(ac, "created_at"))})
    sn = raw.get("social_account_snapshots", pd.DataFrame())
    snapshots = pd.DataFrame({"account_id": col(sn, "account_id"), "fetched": to_sec(col(sn, "fetched_at")),
                              "followers": pd.to_numeric(col(sn, "followers"), errors="coerce"),
                              "tweets": pd.to_numeric(col(sn, "tweets"), errors="coerce")}).dropna(subset=["account_id", "fetched"])
    po = raw.get("social_posts", pd.DataFrame())
    posts = pd.DataFrame({"post_id": col(po, "post_id"), "author_id": col(po, "author_id"), "ts": to_sec(col(po, "ts")),
                          "fetched": to_sec(col(po, "fetched_at"))})
    for k in ("likes", "reposts", "replies", "quotes"):
        posts[k] = pd.to_numeric(col(po, k), errors="coerce")
    posts["mints"] = [_addresses(v) for v in col(po, "mints", "[]")]
    posts["wallets"] = [_addresses(v) for v in col(po, "wallets", "[]")]
    posts = posts.dropna(subset=["author_id", "ts", "fetched"]).drop_duplicates("post_id")
    empty = pd.DataFrame({"wallet": [], "mint": [], "ts": [], "known_at": []})
    return SocialTables(links, accounts, snapshots, posts, empty, pd.DataFrame({"leader": [], "y": [], "resolved_at": []}))


def load_social(private_dir: Path | None = None) -> SocialTables:
    return social_frames({n: read_private(n, private_dir) for n in SOCIAL_TABLES})


def first_buys(con: duckdb.DuckDBPyConnection, pairs: pd.DataFrame) -> pd.DataFrame:
    """Each (wallet, mint) of `pairs`: the wallet's first buy of the coin (ts) and when the server had stored it (known_at
    = max ts over every swap with a lower or equal id: the insert-time rule). Uses the `wallet_swaps` view."""
    if pairs.empty:
        return pd.DataFrame({"wallet": [], "mint": [], "ts": [], "known_at": []})
    con.register("_pairs", pairs[["wallet", "mint"]].drop_duplicates())
    df = con.sql(f"""
        WITH q AS (SELECT s.id, s.wallet, s.mint, s.ts FROM wallet_swaps s JOIN _pairs p ON p.wallet = s.wallet AND p.mint = s.mint
                    WHERE s.side = 'buy'),
             f AS (SELECT * FROM q QUALIFY row_number() OVER (PARTITION BY wallet, mint ORDER BY ts, id) = 1),
             b AS (SELECT id // {BLOCK} blk, max(ts) mx FROM wallet_swaps GROUP BY 1),
             cb AS (SELECT blk, max(mx) OVER (ORDER BY blk ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) prev FROM b),
             inb AS (SELECT f.id, max(s.ts) mx FROM f JOIN wallet_swaps s ON s.id // {BLOCK} = f.id // {BLOCK} AND s.id <= f.id GROUP BY 1)
        SELECT f.wallet, f.mint, epoch(f.ts) ts, epoch(greatest(coalesce(cb.prev, inb.mx), inb.mx)) known_at
          FROM f JOIN inb USING (id) LEFT JOIN cb ON cb.blk = f.id // {BLOCK}""").df()
    con.unregister("_pairs")
    return df


def known_at_t(df: pd.DataFrame, wallets: pd.DataFrame | None) -> pd.DataFrame:
    """The copies whose leader was already in the server's wallets table at the buy (known_at_t = buy_ts >= first_seen_at):
    only those could have been copied. `wallets` (address, first_seen in seconds) None = no wallets export: unfiltered."""
    if wallets is None:
        return df
    first = wallets.dropna(subset=["first_seen"]).drop_duplicates("address").set_index("address").first_seen
    seen = df.leader.map(first)
    return df[seen.notna() & (df.buy_ts >= seen)].reset_index(drop=True)


def _wallets_first_seen(con: duckdb.DuckDBPyConnection, root: Path) -> pd.DataFrame | None:
    d = root / "export" / "wallets"
    if not has_parquet(d):
        return None
    df = con.sql(f"SELECT address, first_seen_at FROM read_parquet({sql_str(parquet_glob(d))}, union_by_name=true)").df()
    return pd.DataFrame({"address": df.address, "first_seen": to_sec(df.first_seen_at)})


def coverage_start(parts: pd.DataFrame) -> float:
    """The start of the newest unbroken stretch the ledger parts cover (each part: lo..hi, its earliest and latest buy);
    NaN without parts. The earliest buy a part holds is at or after its real cut, so the start errs late (safe)."""
    start, end = float("nan"), -np.inf
    for lo, hi in parts.dropna(subset=["lo", "hi"]).sort_values("lo")[["lo", "hi"]].itertuples(index=False):
        if lo > end:  # a gap (or the first part): coverage starts again here
            start = float(lo)
        end = max(end, float(hi))
    return start


def copies(root: Path | None = None) -> tuple[pd.DataFrame, pd.DataFrame, str, float]:
    """(first, ledger, source, start): copy outcomes as leader, buy_ts, y, resolved_at, known_at_t only, and the time
    from which the outcomes are complete (unix s; NaN when there are none).

      first   one row per copy-eligible first buy of a coin (with its mint): the y14 target. The first ledger row of each
              (leader, mint) is picked before a NULL y is dropped, so a first buy the copier couldn't enter drops the pair
              instead of promoting a later buy of the same coin. A first buy pruned before the pulls began can't be seen
              here: drop_pruned_firsts checks the swaps for one.
      ledger  every resolved ledger row, repeat buys of a coin included: own_record_shrunk, exactly the rows score.ts
              reads on the server (features.yaml: "over mirror_ledger rows").
      start   the ledger's coverage start (see the module doc); the research reference's earliest buy.

    The research reference has one row per (leader, mint), so there `first` and `ledger` are the same frame and
    own_record_shrunk is not the server's (train.py won't count a gate test run on it)."""
    root = root or data_dir()
    con = _con()
    try:
        wallets = _wallets_first_seen(con, root)
        sources = []
        if has_parquet(root / "export" / "mirror_ledger"):
            sources.append(parquet_glob(root / "export" / "mirror_ledger"))
        if any(not p.name.startswith(".") for p in derived_dir(root).glob("mirror_ledger*.parquet")):
            sources.append(str(derived_dir(root) / "mirror_ledger*.parquet"))
        for g in sources:
            src = f"read_parquet({sql_str(g)}, union_by_name=true, filename=true)"
            # A row is (leader, mint, buy_sig) on the server (UNIQUE); a part pulled before it resolved holds it unresolved.
            key = "buy_sig" if "buy_sig" in {r[0] for r in con.sql(f"DESCRIBE SELECT * FROM {src}").fetchall()} else "buy_ts"
            parts = con.sql(f"SELECT min(buy_ts) lo, max(buy_ts) hi FROM {src} GROUP BY filename").df()
            df = con.sql(f"""WITH d AS (SELECT * FROM {src} QUALIFY row_number() OVER (PARTITION BY leader, mint, {key}
                                             ORDER BY resolved_at IS NULL, y IS NULL, resolved_at DESC, filename DESC) = 1)
                             SELECT leader, mint, buy_ts, y, resolved_at,
                                    row_number() OVER (PARTITION BY leader, mint ORDER BY buy_ts) = 1 AS first FROM d
                             ORDER BY leader, buy_ts, mint""").df()  # a window query's row order isn't fixed
            df = known_at_t(pd.DataFrame({"leader": df.leader, "mint": df.mint, "buy_ts": to_sec(df.buy_ts), "y": df.y.astype(float),
                                          "resolved_at": to_sec(df.resolved_at), "first": df["first"].astype(bool)}), wallets)
            resolved = df[df.y.notna() & df.resolved_at.notna()]
            cols = ["leader", "buy_ts", "y", "resolved_at"]
            start = coverage_start(pd.DataFrame({"lo": to_sec(parts.lo), "hi": to_sec(parts.hi)}))
            return (resolved[resolved["first"]][["leader", "mint", *cols[1:]]].reset_index(drop=True), resolved[cols].reset_index(drop=True),
                    "mirror_ledger", start)
        ref = root / "research" / "social" / "eligible.parquet"
        if ref.is_file():
            df = con.sql(f"SELECT leader, t, net, exit_min FROM read_parquet({sql_str(ref)}) WHERE net IS NOT NULL").df()
            df = known_at_t(pd.DataFrame({"leader": df.leader, "buy_ts": df.t.astype(float), "y": df.net.astype(float),
                                          "resolved_at": df.t.astype(float) + 15 + df.exit_min.astype(float) * 60}), wallets)
            return df, df, "research_reference", float(df.buy_ts.min()) if len(df) else float("nan")
    finally:
        con.close()
    empty = pd.DataFrame({"leader": [], "buy_ts": [], "y": [], "resolved_at": []})
    return empty, empty, "none", float("nan")


def drop_pruned_firsts(con: duckdb.DuckDBPyConnection, first: pd.DataFrame, start: float) -> pd.DataFrame:
    """The first-buy rows minus every (leader, mint) the leader had already bought before the ledger's coverage start
    (any buy in the `wallet_swaps` view): its real first buy was pruned before the Mac pulled it, so the row the ledger
    still holds is a later buy. Frames without a mint column (the research reference) or start come back as they are."""
    if first.empty or "mint" not in first or not np.isfinite(start):
        return first
    con.register("_firsts", first[["leader", "mint"]].drop_duplicates())
    early = con.sql(f"""SELECT DISTINCT s.wallet leader, s.mint FROM wallet_swaps s JOIN _firsts f ON f.leader = s.wallet AND f.mint = s.mint
                         WHERE s.side = 'buy' AND epoch(s.ts) < {float(start)}""").df()
    con.unregister("_firsts")
    if early.empty:
        return first
    keep = ~pd.MultiIndex.from_frame(first[["leader", "mint"]]).isin(pd.MultiIndex.from_frame(early[["leader", "mint"]]))
    return first[keep].reset_index(drop=True)


def funders(con: duckdb.DuckDBPyConnection) -> pd.DataFrame | None:
    """address, funder, first_seen, funder_filled from the exported wallets, or None without funder_filled_at."""
    try:
        cols = {r[0] for r in con.sql("DESCRIBE wallets").fetchall()}
    except duckdb.Error:
        return None
    if not {"funder", "funder_filled_at", "first_seen_at"} <= cols:
        return None
    df = con.sql("SELECT address, funder, first_seen_at, funder_filled_at FROM wallets WHERE funder IS NOT NULL").df()
    return pd.DataFrame({"address": df.address, "funder": df.funder, "first_seen": to_sec(df.first_seen_at),
                         "funder_filled": to_sec(df.funder_filled_at)})
