"""SQLite access: reads through a read-only URI connection, writes through a separate short connection."""

from __future__ import annotations

import os
import sqlite3
from pathlib import Path

QUANT_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS wallet_skill (
  wallet TEXT PRIMARY KEY,
  computed_at INTEGER NOT NULL,
  n_trades INTEGER NOT NULL,
  win_rate REAL,
  median_return REAL,
  ci_low REAL,
  ci_high REAL,
  p_value REAL,
  q_value REAL,
  deflated_sharpe REAL,
  persistence_rho REAL,
  skill_score REAL,
  verdict TEXT NOT NULL CHECK (verdict IN ('skill','luck','insufficient'))
);
CREATE TABLE IF NOT EXISTS sizing_params (
  leader TEXT PRIMARY KEY,
  computed_at INTEGER NOT NULL,
  valid_until INTEGER NOT NULL,
  n INTEGER NOT NULL,
  edge REAL,
  vol REAL,
  kelly_full REAL,
  kelly_mult REAL NOT NULL DEFAULT 0 CHECK (kelly_mult >= 0 AND kelly_mult <= 1),
  max_drawdown REAL,
  risk_of_ruin REAL
);
"""


def db_path() -> Path:
    root = Path(__file__).resolve().parents[2]
    custom = os.environ.get("GODSEYE_DB_PATH", "").strip()
    return (root / custom).resolve() if custom else root / "data" / "godseye.db"


def open_ro(path: Path | str) -> sqlite3.Connection:
    p = Path(path).resolve()
    if not p.exists():
        raise FileNotFoundError(p)
    con = sqlite3.connect(f"{p.as_uri()}?mode=ro", uri=True, timeout=5)
    con.execute("PRAGMA query_only = ON")
    return con


def has_table(con: sqlite3.Connection, name: str) -> bool:
    return con.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)).fetchone() is not None


def has_column(con: sqlite3.Connection, table: str, col: str) -> bool:
    return any(r[1] == col for r in con.execute(f"PRAGMA table_info({table})"))


def write_results(path: Path | str, skill_rows: list[dict], sizing_rows: list[dict]) -> None:
    con = sqlite3.connect(str(path), timeout=10)
    try:
        con.execute("PRAGMA busy_timeout = 10000")
        con.executescript(QUANT_SCHEMA_SQL)
        with con:
            con.executemany(
                """INSERT OR REPLACE INTO wallet_skill (wallet, computed_at, n_trades, win_rate, median_return, ci_low,
                   ci_high, p_value, q_value, deflated_sharpe, persistence_rho, skill_score, verdict)
                   VALUES (:wallet,:computed_at,:n_trades,:win_rate,:median_return,:ci_low,:ci_high,:p_value,:q_value,
                   :deflated_sharpe,:persistence_rho,:skill_score,:verdict)""",
                skill_rows,
            )
            con.executemany(
                """INSERT OR REPLACE INTO sizing_params (leader, computed_at, valid_until, n, edge, vol, kelly_full,
                   kelly_mult, max_drawdown, risk_of_ruin) VALUES (:leader,:computed_at,:valid_until,:n,:edge,:vol,
                   :kelly_full,:kelly_mult,:max_drawdown,:risk_of_ruin)""",
                sizing_rows,
            )
    finally:
        con.close()
