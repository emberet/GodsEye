"""
Pulls the server tables the social model trains on that brain.export.pull leaves out: `python -m brain.social.pull`.

  social_wallet_accounts      PRIVATE_DIR, replaced whole each pull: small, never pruned, and keyed by (wallet, author_id)
  social_account_snapshots    rather than an integer id, so there is no watermark to pull from
  mirror_ledger               EXPORT_DIR/mirror_ledger/part-<ms>.parquet: the server's whole ledger as it is now, a new part
                              each pull, none deleted. The server deletes rows bought more than 8 days ago (ledger.ts
                              LEDGER_KEEP_MS) and updates a row in place when it resolves (y, resolved_at), so neither a
                              whole-table copy (only ~8 days, never enough for the as-of grid) nor an id watermark (misses the
                              updates) would do. brain.social.data.copies reads the parts as snapshots: rows deduped by
                              (leader, mint, buy_sig), the resolved version winning, and the coverage is the newest unbroken
                              stretch of them. Pull at least every 8 days, or the coverage starts again (said so below).

Uses brain.export.pull's ssh / rsync plumbing; like it, the server's database is only ever read. Nothing here prints a
row: counts only.
"""
from __future__ import annotations

import argparse
import gzip
import shlex
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import duckdb

from brain import config
from brain.export import pull

LEDGER_KEEP_SEC = 8 * 86_400  # agent/src/brain/ledger.ts LEDGER_KEEP_MS
WHOLE: list[pull.Table] = [pull.Table("social_wallet_accounts", False, private=True),
                           pull.Table("social_account_snapshots", False, private=True)]
SNAPSHOTS = ("mirror_ledger",)
# Read as text, these mirror_ledger columns are cast back (times stay ISO text: every part types alike, whatever its rows).
NUMERIC = {"id": "BIGINT", "n_tracked_wallets": "BIGINT", "leader_sol": "DOUBLE", "leader_price_sol": "DOUBLE",
           "entry_px": "DOUBLE", "exit_px": "DOUBLE", "y": "DOUBLE", "lr": "DOUBLE", "y_quote": "DOUBLE"}


def fetch(name: str, sql: str) -> Path:
    """Runs `sql` read-only on the server into a gzip'd CSV and copies it here (resumable); the caller deletes it."""
    remote_file = f"{pull.REMOTE_TMP}/{name}.csv.gz"
    pull.ssh(f"mkdir -p {pull.REMOTE_TMP} && sqlite3 -readonly -csv -header {shlex.quote(config.SERVER_DB)} {shlex.quote(sql)} | gzip -1 > {remote_file}")
    tmp_path = Path(tempfile.gettempdir()) / f"brain-pull-{name}.csv.gz"
    for attempt in range(5):
        r = subprocess.run(["rsync", "-q", "--partial", "--timeout=60", f"{config.SERVER}:{remote_file}", str(tmp_path)])
        if r.returncode == 0:
            break
        time.sleep(5 * (attempt + 1))
    else:
        raise RuntimeError(f"rsync of {name} kept failing")
    pull.ssh(f"rm -f {remote_file}")
    return tmp_path


def last_pull(dest: Path) -> float | None:
    """When the newest snapshot part in `dest` was pulled (unix s, from its name), or None without one."""
    stamps = [int(p.stem.split("-", 1)[1]) for p in dest.glob("part-*.parquet") if p.stem.split("-", 1)[1].isdigit()]
    return max(stamps) / 1000.0 if stamps else None


def pull_snapshot(name: str, now: float | None = None) -> int:
    """The server's whole `name` table as a new part file beside the earlier ones (none deleted). Returns its rows."""
    dest = config.EXPORT_DIR / name
    dest.mkdir(parents=True, exist_ok=True)
    now = time.time() if now is None else now
    prev = last_pull(dest)
    tmp_path = fetch(name, f"SELECT * FROM {name}")
    try:
        with gzip.open(tmp_path, "rt") as f:
            header = f.readline()
        if not header.strip():
            return 0
        part = dest / f"part-{int(now * 1000)}.parquet"
        con = duckdb.connect()
        source = f"read_csv_auto('{tmp_path}', header=true, all_varchar=true)"
        have = {r[0] for r in con.execute(f"DESCRIBE SELECT * FROM {source}").fetchall()}
        casts = [f"CAST({c} AS {t}) AS {c}" for c, t in NUMERIC.items() if c in have] if name == "mirror_ledger" else []
        replace = f" REPLACE ({', '.join(casts)})" if casts else ""
        con.execute(f"COPY (SELECT *{replace} FROM {source}) TO '{part}' (FORMAT parquet, COMPRESSION zstd)")
        n = con.execute(f"SELECT count(*) FROM read_parquet('{part}')").fetchone()[0]
        if prev is not None and now - prev > LEDGER_KEEP_SEC:
            print(f"  {name}: {(now - prev) / 86_400:.1f} days since the last pull (the server keeps 8): rows were pruned in "
                  f"between, so the ledger's coverage starts again at this pull")
        return n
    finally:
        tmp_path.unlink(missing_ok=True)


def pull_social(have: set[str]) -> None:
    """Pulls every table above that the server has (`have`: its table names); brain.export.pull can call this too."""
    for t in WHOLE:
        if t.name not in have:
            print(f"  {t.name}: not on the server yet, skipped")
            continue
        t0 = time.time()
        print(f"  {t.name}: {pull.pull_table(t, {}, None):,} rows in {time.time() - t0:.0f}s")
    for name in SNAPSHOTS:
        if name not in have:
            print(f"  {name}: not on the server yet, skipped")
            continue
        t0 = time.time()
        print(f"  {name}: {pull_snapshot(name):,} rows (a new snapshot part) in {time.time() - t0:.0f}s")


def main(argv: list[str] | None = None) -> int:
    argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter).parse_args(argv)
    config.ensure_dirs()
    pull_social(pull.server_tables())
    pull.drop_appledouble()
    return 0


if __name__ == "__main__":
    sys.exit(main())
