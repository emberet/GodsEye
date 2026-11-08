"""
brain.export.pull: wallet_swaps.ins_ms (when the server stored a swap) reaches the Parquet export as a BIGINT on every
part, also where a part's rows all predate the column (empty) or an archived day has no such key. No real ssh or rsync:
both are replaced, and the server's CSV / archive files are written locally.
"""
from __future__ import annotations

import gzip
import json
import shutil
from pathlib import Path

import duckdb

from brain import config
from brain.export import pull


def types_of(part: Path) -> dict[str, str]:
    return {r[0]: r[1] for r in duckdb.connect().execute(f"DESCRIBE SELECT * FROM read_parquet('{part}')").fetchall()}


def fake_server(monkeypatch, tmp_path: Path, csv_text: str) -> None:
    """ssh is a no-op; rsync 'copies' the server's CSV export, prepared here."""
    served = tmp_path / "served.csv.gz"
    with gzip.open(served, "wt") as f:
        f.write(csv_text)
    monkeypatch.setattr(pull, "ssh", lambda cmd, **kw: None)

    class Done:
        returncode = 0

    def run(args, **kw):
        shutil.copy(served, args[-1])
        return Done()

    monkeypatch.setattr(pull.subprocess, "run", run)
    monkeypatch.setattr(config, "EXPORT_DIR", tmp_path / "export")
    monkeypatch.setattr(config, "PRIVATE_DIR", tmp_path / "private")


def test_ins_ms_is_a_bigint_even_when_every_row_predates_it(monkeypatch, tmp_path):
    t = pull.Table("wallet_swaps", True)
    fake_server(monkeypatch, tmp_path, "id,wallet,ts,mint,ins_ms\n1,W,2026-11-01T00:00:00Z,M,\n2,W,2026-11-01T00:00:01Z,M,\n")
    marks: dict[str, int] = {}
    assert pull.pull_table(t, marks, None) == 2
    part = next((tmp_path / "export" / "wallet_swaps").glob("part-*.parquet"))
    assert types_of(part)["ins_ms"] == "BIGINT"
    assert marks["wallet_swaps"] == 2


def test_ins_ms_values_survive_and_a_server_without_the_column_gets_nulls(monkeypatch, tmp_path):
    t = pull.Table("wallet_swaps", True)
    fake_server(monkeypatch, tmp_path, "id,wallet,ts,mint,ins_ms\n3,W,2026-11-07T00:00:00Z,M,1794312000800\n")
    pull.pull_table(t, {}, None)
    part = next((tmp_path / "export" / "wallet_swaps").glob("part-*.parquet"))
    assert duckdb.connect().execute(f"SELECT ins_ms FROM read_parquet('{part}')").fetchone()[0] == 1794312000800
    part.unlink()
    fake_server(monkeypatch, tmp_path, "id,wallet,ts,mint\n4,W,2026-11-07T00:00:00Z,M\n")  # the column not deployed yet
    pull.pull_table(t, {}, None)
    part = next((tmp_path / "export" / "wallet_swaps").glob("part-*.parquet"))
    assert types_of(part)["ins_ms"] == "BIGINT"
    assert duckdb.connect().execute(f"SELECT ins_ms FROM read_parquet('{part}')").fetchone()[0] is None


def test_other_tables_are_untouched():
    assert pull.typed_select("src", "closed_trades", ["id", "x"]) == "SELECT * FROM src"


def test_archived_days_keep_ins_ms_and_old_days_get_it_as_null(monkeypatch, tmp_path):
    raw = tmp_path / "data" / "archive_raw"
    raw.mkdir(parents=True)
    with gzip.open(raw / "2026-10-01.ndjson.gz", "wt") as f:  # archived before the column existed
        f.write(json.dumps({"id": 1, "wallet": "W", "ts": "2026-10-01T00:00:00Z", "mint": "M"}) + "\n")
    with gzip.open(raw / "2026-11-07.ndjson.gz", "wt") as f:
        f.write(json.dumps({"id": 2, "wallet": "W", "ts": "2026-11-07T00:00:00Z", "mint": "M", "ins_ms": 1794312000800}) + "\n")
    monkeypatch.setattr(config, "DATA_DIR", tmp_path / "data")
    monkeypatch.setattr(config, "EXPORT_DIR", tmp_path / "export")
    monkeypatch.setattr(pull.subprocess, "run", lambda *a, **kw: None)  # the rsync: the raw files are already here
    assert pull.pull_archive() == 2
    out = tmp_path / "export" / "wallet_swaps_archive"
    assert types_of(out / "2026-10-01.parquet")["ins_ms"] == "BIGINT"
    con = duckdb.connect()
    assert con.execute(f"SELECT ins_ms FROM read_parquet('{out / '2026-10-01.parquet'}')").fetchone()[0] is None
    assert con.execute(f"SELECT ins_ms FROM read_parquet('{out / '2026-11-07.parquet'}')").fetchone()[0] == 1794312000800
