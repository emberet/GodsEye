"""
Pull the server's data to the Mac as Parquet: `python -m brain.export.pull`.

Each table is read on the server with `sqlite3 -readonly` into a gzip'd CSV in /tmp there (the database itself is never
written), copied over with resumable rsync, then deleted on the server. Append-only tables (an integer `id`) are pulled incrementally from a watermark and land as new part files;
small state tables are replaced whole. Social (X) tables go to PRIVATE_DIR, never to the shared export.
"""
from __future__ import annotations

import argparse
import csv
import gzip
import json
import shlex
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path

import duckdb

from brain import config


@dataclass(frozen=True)
class Table:
    name: str
    incremental: bool  # append-only with an integer id
    private: bool = False
    where: str = ""  # extra filter (SQL) for the server side


TABLES: list[Table] = [
    Table("wallet_swaps", True),
    Table("closed_trades", True),
    Table("smart_flows", True),
    Table("shadow_candidates", True),
    Table("shadow_samples", True),
    Table("copy_decisions", True),
    Table("wallet_evaluations", True),
    Table("weight_history", True),
    Table("copy_trades", True),
    Table("positions", False),
    Table("wallets", False),
    Table("wallet_stats", False),
    Table("wallet_activity", False),
    Table("token_info", False),
    Table("smart_wallets", False),
    Table("copy_replays", False),
    Table("runner_tokens", False),
    Table("runner_buyers", False),
    Table("runner_early_counts", False),
    Table("brain_transitions", True),
    Table("brain_paper_positions", False),
    Table("brain_shadow_quotes", True),  # sell quotes after leader buys: the simulator's fill check (brain.sim.quotes)
    Table("feature_history", True),
    Table("weight_shadow", True),  # late-copier weights next to the real ones (agent/src/learning/late-weights.ts)  # rug, organic, skill and cluster values as they were when made (agent/src/learning/history.ts)
    Table("x_accounts", False, private=True),
    Table("x_posts", False, private=True),
    Table("x_wallet_links", False, private=True),
    Table("social_accounts", False, private=True),
    Table("social_posts", True, private=True),
]


REMOTE_TMP = "/tmp/godseye-brain-export"

# Columns pinned to a type on every part, whatever one file's sniffing says, and added as NULL where the source lacks
# them (rows stored or archived before the column existed). wallet_swaps.ins_ms: when the server stored the swap (epoch
# ms; NULL = before the column), so "what the server knew at t" is ins_ms <= t, not ts (features.yaml ins_lag_sec).
PINNED: dict[str, dict[str, str]] = {"wallet_swaps": {"ins_ms": "BIGINT"}}


def typed_select(source: str, table: str, columns: list[str]) -> str:
    """SELECT over `source` (a duckdb table function) with the table's pinned columns cast, or added as NULL if missing."""
    pinned = PINNED.get(table, {})
    have = set(columns)
    casts = [f"CAST({c} AS {t}) AS {c}" for c, t in pinned.items() if c in have]
    added = [f"CAST(NULL AS {t}) AS {c}" for c, t in pinned.items() if c not in have]
    replace = f" REPLACE ({', '.join(casts)})" if casts else ""
    return f"SELECT *{replace}{''.join(', ' + a for a in added)} FROM {source}"


def ssh(cmd: str, **kw) -> subprocess.CompletedProcess:
    return subprocess.run(["ssh", config.SERVER, cmd], check=True, **kw)


def server_tables() -> set[str]:
    out = ssh(f"sqlite3 -readonly {shlex.quote(config.SERVER_DB)} \"select name from sqlite_master where type='table'\"", capture_output=True, text=True)
    return set(out.stdout.split())


def watermarks_path() -> Path:
    return config.EXPORT_DIR / "_watermarks.json"


def load_watermarks() -> dict[str, int]:
    p = watermarks_path()
    return json.loads(p.read_text()) if p.exists() else {}


def pull_table(t: Table, marks: dict[str, int], max_rows: int | None) -> int:
    dest = (config.PRIVATE_DIR if t.private else config.EXPORT_DIR) / t.name
    dest.mkdir(parents=True, exist_ok=True)
    conds = [c for c in [t.where, f"id > {marks.get(t.name, 0)}" if t.incremental else ""] if c]
    sql = f"SELECT * FROM {t.name}" + (f" WHERE {' AND '.join(conds)}" if conds else "") + (" ORDER BY id" if t.incremental else "")
    if max_rows:
        sql += f" LIMIT {max_rows}"
    # Export to a file on the server first, then rsync it (resumable): one long pipe over ssh stalls on big tables.
    remote_file = f"{REMOTE_TMP}/{t.name}.csv.gz"
    ssh(f"mkdir -p {REMOTE_TMP} && sqlite3 -readonly -csv -header {shlex.quote(config.SERVER_DB)} {shlex.quote(sql)} | gzip -1 > {remote_file}")
    tmp_path = Path(tempfile.gettempdir()) / f"brain-pull-{t.name}.csv.gz"
    for attempt in range(5):
        r = subprocess.run(["rsync", "-q", "--partial", "--timeout=60", f"{config.SERVER}:{remote_file}", str(tmp_path)])
        if r.returncode == 0:
            break
        time.sleep(5 * (attempt + 1))
    else:
        raise RuntimeError(f"rsync of {t.name} kept failing")
    ssh(f"rm -f {remote_file}")
    try:
        with gzip.open(tmp_path, "rt") as f:
            header = f.readline()
        if not header.strip():
            return 0
        part = dest / (f"part-{int(time.time())}.parquet" if t.incremental else "all.parquet")
        con = duckdb.connect()
        # Every column as text first, then let duckdb sniff types per file; ids and reals come back numeric (pinned ones cast).
        columns = next(csv.reader([header]))
        source = f"read_csv_auto('{tmp_path}', header=true, sample_size=-1)"
        con.execute(f"COPY ({typed_select(source, t.name, columns)}) TO '{part}' (FORMAT parquet, COMPRESSION zstd)")
        n = con.execute(f"SELECT count(*) FROM read_parquet('{part}')").fetchone()[0]
        if t.incremental and n:
            marks[t.name] = int(con.execute(f"SELECT max(id) FROM read_parquet('{part}')").fetchone()[0])
        if not t.incremental:
            for old in dest.glob("part-*.parquet"):
                old.unlink()
        return n
    finally:
        tmp_path.unlink(missing_ok=True)


def pull_archive() -> int:
    """Swaps the agent moved out of wallet_swaps into daily ndjson.gz files (data/archive/wallet_swaps): past the hot
    window, and junk wallets' sooner. They still price coins, so they become export/wallet_swaps_archive/<day>.parquet."""
    raw = config.DATA_DIR / "archive_raw"
    raw.mkdir(parents=True, exist_ok=True)
    src = config.SERVER_DB.rsplit("/", 1)[0] + "/archive/wallet_swaps/"
    subprocess.run(["rsync", "-q", "--partial", "--timeout=60", "-r", f"{config.SERVER}:{src}", f"{raw}/"], check=True)
    dest = config.EXPORT_DIR / "wallet_swaps_archive"
    dest.mkdir(parents=True, exist_ok=True)
    done = 0
    con = duckdb.connect()
    for f in sorted(raw.glob("[!.]*.ndjson.gz")):
        out = dest / f.name.replace(".ndjson.gz", ".parquet")
        # A day file grows until the day is past the hot window, so redo it whenever the raw file is newer.
        if out.exists() and out.stat().st_mtime >= f.stat().st_mtime:
            continue
        # sample_size=-1: infer the columns from every line. A day file archived across a deploy gains a key part-way
        # (ins_ms appeared 3.25 M lines into 10-28), which the default 20k-line sample misses and duckdb then refuses.
        source = f"read_json_auto('{f}', format='newline_delimited', sample_size=-1)"
        columns = [r[0] for r in con.execute(f"DESCRIBE SELECT * FROM {source}").fetchall()]
        con.execute(f"COPY ({typed_select(source, 'wallet_swaps', columns)}) TO '{out}' (FORMAT parquet, COMPRESSION zstd)")
        done += 1
    return done


def drop_appledouble() -> int:
    """macOS writes a `._name` metadata twin beside every file on the FAT32 drive; parquet globs would read them as data."""
    n = 0
    for f in config.DATA_DIR.rglob("._*"):
        f.unlink(missing_ok=True)
        n += 1
    return n


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--only", nargs="*", help="pull just these tables")
    ap.add_argument("--max-rows", type=int, default=None, help="cap rows per table per run (testing)")
    args = ap.parse_args(argv)
    config.ensure_dirs()
    have = server_tables()
    marks = load_watermarks()
    for t in TABLES:
        if args.only and t.name not in args.only:
            continue
        if t.name not in have:
            print(f"  {t.name}: not on the server yet, skipped")
            continue
        t0 = time.time()
        n = pull_table(t, marks, args.max_rows)
        watermarks_path().write_text(json.dumps(marks, indent=1))
        print(f"  {t.name}: {n:,} rows in {time.time() - t0:.0f}s")
    if not args.only or "archive" in args.only:
        t0 = time.time()
        print(f"  archive: {pull_archive()} day files converted in {time.time() - t0:.0f}s")
    drop_appledouble()
    return 0


if __name__ == "__main__":
    sys.exit(main())
