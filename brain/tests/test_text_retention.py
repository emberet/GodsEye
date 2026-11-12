"""brain.export.pull forget_old_text: X's rules on the Mac's private copy, post text kept 30 days (made-up posts)."""
from __future__ import annotations

import duckdb
import pandas as pd

from brain import config
from brain.export import pull


def test_old_post_text_goes_ids_and_counts_stay(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "PRIVATE_DIR", tmp_path / "private")
    d = config.PRIVATE_DIR / "social_posts"
    d.mkdir(parents=True)
    now = pd.Timestamp("2026-11-13T00:00:00Z")
    rows = pd.DataFrame({"post_id": ["old", "new"], "ts": [(now - pd.Timedelta(days=40)).isoformat(), (now - pd.Timedelta(days=2)).isoformat()],
                         "text": ["an old post", "a new post"], "likes": [3, 5]})
    rows.to_parquet(d / "part-1.parquet", index=False)
    assert pull.forget_old_text(now.timestamp()) == 1
    got = duckdb.connect().execute(f"SELECT post_id, text, likes FROM read_parquet('{d}/part-1.parquet') ORDER BY post_id").fetchall()
    assert got == [("new", "a new post", 5), ("old", "", 3)]
    assert pull.forget_old_text(now.timestamp()) == 0, "nothing left to remove"
