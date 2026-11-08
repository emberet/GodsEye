"""
brain.social.pull: the social link and snapshot tables land whole in PRIVATE_DIR, and every pull of mirror_ledger is kept
as its own snapshot part, which brain.social.data.copies reads back deduped (the resolved version winning) with the
coverage running from the oldest part. No real ssh or rsync: both are replaced, and the server's CSV is written locally.
"""
from __future__ import annotations

import gzip
from datetime import datetime, timezone
from pathlib import Path

import duckdb
import pytest

from brain import config
from brain.export import pull
from brain.social import data as sdata
from brain.social import pull as spull

DAY = 86_400.0
T0 = 1_793_000_000.0  # 2026-10-26
HEADER = "id,leader,mint,buy_ts,buy_sig,entry_px,y,lr,resolved_at,n_tracked_wallets,created_at\n"


def iso(t: float) -> str:
    return datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


@pytest.fixture
def server(monkeypatch, tmp_path: Path):
    """ssh is a no-op; rsync 'copies' whatever CSV the test puts in served[0]."""
    served = [""]

    class Done:
        returncode = 0

    def run(args, **kw):
        with gzip.open(args[-1], "wt") as f:
            f.write(served[0])
        return Done()

    monkeypatch.setattr(pull, "ssh", lambda cmd, **kw: None)
    monkeypatch.setattr(pull.subprocess, "run", run)
    monkeypatch.setattr(config, "EXPORT_DIR", tmp_path / "export")
    monkeypatch.setattr(config, "PRIVATE_DIR", tmp_path / "private")
    return served


def ledger_csv(rows: list[tuple]) -> str:
    """rows: (id, leader, mint, buy_ts, y or None, resolved_at or None)."""
    out = HEADER
    for i, leader, mint, buy, y, res in rows:
        out += f"{i},{leader},{mint},{iso(buy)},sig{i},0.001,{'' if y is None else y},,{'' if res is None else iso(res)},12,{iso(buy)}\n"
    return out


def test_two_snapshot_pulls_leave_two_parts_and_read_back_as_one_ledger(server, tmp_path):
    server[0] = ledger_csv([(1, "L1", "M1", T0, 0.05, T0 + 3600), (2, "L1", "M2", T0 + DAY, None, None)])
    assert spull.pull_snapshot("mirror_ledger", now=T0 + 2 * DAY) == 2
    # Seven days on: row 1 was pruned on the server, row 2 resolved, row 3 is new.
    server[0] = ledger_csv([(2, "L1", "M2", T0 + DAY, -0.2, T0 + DAY + 600), (3, "L2", "M1", T0 + 8 * DAY, None, None)])
    assert spull.pull_snapshot("mirror_ledger", now=T0 + 9 * DAY) == 2
    parts = sorted((tmp_path / "export" / "mirror_ledger").glob("part-*.parquet"))
    assert len(parts) == 2, "no part is deleted"
    types = {r[0]: r[1] for r in duckdb.connect().execute(f"DESCRIBE SELECT * FROM read_parquet('{parts[0]}')").fetchall()}
    assert types["y"] == "DOUBLE" and types["buy_ts"] == "VARCHAR", "every part types alike, also where y is all NULL"

    first, ledger, source, start = sdata.copies(tmp_path)
    assert source == "mirror_ledger"
    assert start == pytest.approx(T0), "the coverage runs from the oldest part's earliest buy"
    assert sorted(ledger.y.round(3)) == [-0.2, 0.05], "the pruned row is kept, the resolved version wins, the open one waits"
    assert len(first) == 2


def test_a_pull_after_more_than_eight_days_says_the_coverage_starts_again(server, capsys):
    server[0] = ledger_csv([(1, "L1", "M1", T0, 0.05, T0 + 3600)])
    spull.pull_snapshot("mirror_ledger", now=T0 + DAY)
    spull.pull_snapshot("mirror_ledger", now=T0 + 3 * DAY)
    assert "starts again" not in capsys.readouterr().out
    spull.pull_snapshot("mirror_ledger", now=T0 + 12 * DAY)
    out = capsys.readouterr().out
    assert "starts again" in out and "L1" not in out, "counts only, never a row"


def test_link_and_snapshot_tables_are_pulled_whole_into_private(server, tmp_path):
    server[0] = "wallet,author_id,how,n,first_seen_at,updated_at\nW1,a1,bio,1,2026-11-01T00:00:00.000Z,2026-11-01T00:00:00.000Z\n"
    spull.pull_social({"social_wallet_accounts", "mirror_ledger"})  # social_account_snapshots not on the server: skipped
    assert not (tmp_path / "private" / "social_account_snapshots").exists()
    server[0] = server[0] + "W2,a2,mention,2,2026-11-02T00:00:00.000Z,2026-11-02T00:00:00.000Z\n"
    spull.pull_social({"social_wallet_accounts"})
    links = sdata.read_private("social_wallet_accounts", tmp_path / "private")
    assert sorted(links.wallet) == ["W1", "W2"], "replaced whole: the latest pull, once"
    assert [p.name for p in (tmp_path / "private" / "social_wallet_accounts").glob("*.parquet")] == ["all.parquet"]
    assert len(list((tmp_path / "export" / "mirror_ledger").glob("part-*.parquet"))) == 1


def test_an_empty_answer_writes_no_part(server, tmp_path):
    server[0] = ""
    assert spull.pull_snapshot("mirror_ledger", now=T0) == 0
    assert not list((tmp_path / "export" / "mirror_ledger").glob("*.parquet"))
