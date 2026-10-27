import sqlite3

import numpy as np
import pytest

NOW = 1_800_000_000
DAY = 86400

CLOSED_SQL = """CREATE TABLE closed_trades (id INTEGER PRIMARY KEY AUTOINCREMENT, wallet TEXT, mint TEXT, entry_slot INTEGER,
entry_ts INTEGER, exit_ts INTEGER, entry_sol REAL, exit_sol REAL, pnl_sol REAL, return_pct REAL, hold_sec REAL,
token_age_sec_at_entry REAL, venue_entry TEXT, jito_tip_entry INTEGER, UNIQUE(wallet, mint, entry_ts))"""
SWAPS_SQL = """CREATE TABLE wallet_swaps (id INTEGER PRIMARY KEY AUTOINCREMENT, wallet TEXT, signature TEXT, slot INTEGER,
ts TEXT, mint TEXT, side TEXT, token_amount REAL, token_balance_before REAL DEFAULT 0, sol_amount REAL, price_sol REAL)"""


def add_wallet(rows, wallet, returns, rng, start=NOW - 29 * DAY, end=NOW - 60):
    ts = np.sort(rng.uniform(start, end, len(returns)))
    for i, (t, r) in enumerate(zip(ts, returns, strict=True)):
        e = 0.5
        rows.append((wallet, f"{wallet}-m{i}", int(t), int(t) + 600, e, e * (1 + r), e * r, r * 100, 600.0))


def write_closed(path, rows):
    con = sqlite3.connect(path)
    con.execute(CLOSED_SQL)
    con.execute(SWAPS_SQL)
    con.executemany(
        "INSERT INTO closed_trades (wallet, mint, entry_ts, exit_ts, entry_sol, exit_sol, pnl_sol, return_pct,"
        " hold_sec) VALUES (?,?,?,?,?,?,?,?,?)",
        rows,
    )
    con.commit()
    con.close()


@pytest.fixture
def population(tmp_path):
    rng = np.random.default_rng(1)
    rows = []
    for k in range(200):
        add_wallet(rows, f"noise{k}", np.clip(rng.normal(0, 0.3, 40), -0.95, None), rng)
    add_wallet(rows, "skilled", np.clip(rng.normal(0.25, 0.3, 60), -0.95, None), rng)
    add_wallet(rows, "oneshot", np.array([-0.02] * 29 + [20.0]), rng)
    half = NOW - 15 * DAY
    add_wallet(rows, "faded", np.clip(rng.normal(0.4, 0.2, 30), -0.95, None), rng, end=half - 3600)
    add_wallet(rows, "faded", np.clip(rng.normal(-0.3, 0.2, 30), -0.95, None), rng, start=half + 3600)
    add_wallet(rows, "thin", np.full(10, 0.5), rng)
    path = tmp_path / "pop.db"
    write_closed(path, rows)
    return path
