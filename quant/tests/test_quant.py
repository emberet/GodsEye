import sqlite3

import numpy as np
import pandas as pd
import pytest

from quant.config import QuantConfig
from quant.data import to_epoch_seconds
from quant.db import open_ro
from quant.run import run
from quant.stats import benjamini_hochberg, deflated_sharpe

from .conftest import DAY, NOW, SWAPS_SQL

CFG = QuantConfig(n_perm=1000, n_boot=500, ruin_paths=300)


def rows(path, table, key):
    con = sqlite3.connect(path)
    con.row_factory = sqlite3.Row
    out = {r[key]: dict(r) for r in con.execute(f"SELECT * FROM {table}")}
    con.close()
    return out


def test_lucky_wallets_rejected_after_fdr_and_skilled_accepted(population):
    s = run(population, CFG, now=NOW)
    assert s["source"] == "closed_trades"
    sk = rows(population, "wallet_skill", "wallet")
    noise = [v for k, v in sk.items() if k.startswith("noise")]
    # some noise wallets look significant on their own, none survive FDR
    assert any(v["p_value"] < 0.05 for v in noise)
    assert all(v["verdict"] == "luck" for v in noise)
    assert all(v["q_value"] > CFG.fdr_alpha for v in noise if v["p_value"] < 0.05)
    assert sk["skilled"]["verdict"] == "skill"
    assert sk["skilled"]["q_value"] <= CFG.fdr_alpha
    assert sk["skilled"]["skill_score"] > max(v["skill_score"] for v in noise)
    assert sk["skilled"]["ci_low"] > 0


def test_concentrated_and_non_persistent_wallets_are_luck(population):
    run(population, CFG, now=NOW)
    sk = rows(population, "wallet_skill", "wallet")
    assert sk["oneshot"]["verdict"] == "luck"  # one trade made all the profit
    assert sk["faded"]["verdict"] == "luck"  # did not persist into the second half
    assert sk["thin"]["verdict"] == "insufficient"


def test_kelly_caps_hold(population):
    run(population, CFG, now=NOW)
    sz = rows(population, "sizing_params", "leader")
    for v in sz.values():
        assert 0 <= v["kelly_mult"] <= 1
        assert v["kelly_mult"] <= 0.25 * v["kelly_full"] + 1e-12
        assert v["valid_until"] == NOW + int(CFG.ttl_hours * 3600)
    assert sz["thin"]["kelly_mult"] == 0  # thin data
    assert sz["skilled"]["kelly_mult"] > 0
    assert 0 <= sz["skilled"]["risk_of_ruin"] <= 1 and 0 <= sz["skilled"]["max_drawdown"] <= 1
    assert all(v["kelly_mult"] == 0 for v in sz.values() if (v["edge"] or 0) <= 0)


def test_kelly_fraction_cannot_exceed_quarter(monkeypatch):
    monkeypatch.setenv("QUANT_KELLY_FRACTION", "0.5")
    with pytest.raises(ValueError):
        QuantConfig.from_env()


def test_read_connection_is_read_only(population):
    con = open_ro(population)
    with pytest.raises(sqlite3.OperationalError):
        con.execute("DELETE FROM closed_trades")
    con.close()


def test_fallback_rebuilds_round_trips_from_wallet_swaps(tmp_path):
    path = tmp_path / "swaps.db"
    con = sqlite3.connect(path)
    con.execute(SWAPS_SQL)
    sw = []
    for i in range(35):
        t = (NOW - 20 * 86400 + i * 3600) * 1000  # epoch milliseconds
        sw.append(("w", f"b{i}", t, f"m{i}", "buy", 100.0, 1.0, 0.01))
        sw.append(("w", f"s{i}", t + 60_000, f"m{i}", "sell", 60.0, 0.8, 0.0133))
        sw.append(("w", f"s2{i}", t + 120_000, f"m{i}", "sell", 40.0, 0.6, 0.015))
    sw.append(("w", "orphan", (NOW - 86400) * 1000, "mx", "sell", 5.0, 9.0, 1.0))  # never bought: ignored
    con.executemany(
        "INSERT INTO wallet_swaps (wallet, signature, ts, mint, side, token_amount, sol_amount, price_sol)"
        " VALUES (?,?,?,?,?,?,?,?)",
        sw,
    )
    con.commit()
    con.close()
    s = run(path, CFG, now=NOW)
    assert s["source"] == "wallet_swaps" and s["trades"] == 35
    sz = rows(path, "sizing_params", "leader")
    assert sz["w"]["edge"] > 0 and sz["w"]["kelly_mult"] <= 0.25 * sz["w"]["kelly_full"] + 1e-12


def test_timestamp_units_detected():
    iso = to_epoch_seconds(["2027-01-15T08:00:00.000Z"])[0]
    assert to_epoch_seconds([iso])[0] == pytest.approx(iso)
    assert to_epoch_seconds([iso * 1000])[0] == pytest.approx(iso)
    assert to_epoch_seconds([iso * 1e6])[0] == pytest.approx(iso)


def test_bh_and_dsr_basics():
    q = benjamini_hochberg(np.array([0.01, 0.04, 0.03, 0.5]))
    assert np.allclose(q, [0.04, 0.04 * 4 / 3, 0.04, 0.5]) or (q[0] <= q[2] <= q[1] <= q[3])
    r = np.random.default_rng(0).normal(0.1, 0.3, 100)
    assert deflated_sharpe(0.33, r, 1000, 0.01) < deflated_sharpe(0.33, r, 1, 0.01)


def test_drift_is_not_timing_skill(tmp_path):
    """Every token rises steadily; a wallet that simply holds earns the drift, which random entries earn too."""
    path = tmp_path / "drift.db"
    con = sqlite3.connect(path)
    con.execute(SWAPS_SQL)
    con.execute(
        "CREATE TABLE closed_trades (id INTEGER PRIMARY KEY, wallet TEXT, mint TEXT, entry_slot INTEGER, entry_ts INTEGER,"
        " exit_ts INTEGER, entry_sol REAL, exit_sol REAL, pnl_sol REAL, return_pct REAL, hold_sec REAL,"
        " token_age_sec_at_entry REAL, venue_entry TEXT, jito_tip_entry INTEGER)"
    )
    rng = np.random.default_rng(3)
    start = NOW - 20 * 86400
    swaps, trades = [], []
    for m in range(40):
        ts = start + m * 3 * 3600 + np.arange(0, 2 * 3600, 60)
        px = 0.01 * np.exp(0.00005 * (ts - ts[0])) * np.exp(rng.normal(0, 0.01, len(ts)))
        swaps += [
            ("mkt", f"{m}-{i}", f"{t}", f"m{m}", "buy", 1.0, p, p) for i, (t, p) in enumerate(zip(ts, px, strict=True))
        ]
        i0 = int(rng.integers(0, 60))
        r = px[i0 + 60] / px[i0] - 1
        trades.append(("drifter", f"m{m}", int(ts[i0]), int(ts[i0 + 60]), 0.5, 0.5 * (1 + r), 0.5 * r, r * 100, 3600.0))
    con.executemany(
        "INSERT INTO wallet_swaps (wallet, signature, ts, mint, side, token_amount, sol_amount, price_sol) VALUES (?,?,?,?,?,?,?,?)",
        swaps,
    )
    con.executemany(
        "INSERT INTO closed_trades (wallet, mint, entry_ts, exit_ts, entry_sol, exit_sol, pnl_sol, return_pct, hold_sec) VALUES (?,?,?,?,?,?,?,?,?)",
        trades,
    )
    con.commit()
    con.close()
    run(path, CFG, now=NOW)
    sk = rows(path, "wallet_skill", "wallet")["drifter"]
    assert sk["median_return"] > 0.1  # it made money
    assert sk["p_value"] > 0.05 and sk["verdict"] == "luck"  # but no better than random entries in the same tokens


def test_price_rows_match_full_load_for_the_mints_asked(tmp_path):
    from quant.data import load_price_paths, load_swaps, price_paths

    path = str(tmp_path / "p.db")
    con = sqlite3.connect(path)
    con.execute(SWAPS_SQL)
    rows = []
    for m in ("A", "B", "C"):
        for i in range(8):
            t = pd.Timestamp(NOW - (40 - i * 5) * DAY, unit="s", tz="UTC").strftime("%Y-%m-%dT%H:%M:%S.000Z")
            rows.append((f"w{i}", t, m, "buy", 1.0, 0.1, 0.0 if i == 3 else 0.1 + i))
    con.executemany(
        "INSERT INTO wallet_swaps (wallet, ts, mint, side, token_amount, sol_amount, price_sol) VALUES (?,?,?,?,?,?,?)",
        rows,
    )
    con.commit()
    con.close()
    since = NOW - 30 * DAY
    ro = open_ro(path)
    full = price_paths(load_swaps(ro, since))
    narrow = load_price_paths(ro, since, ["A", "C"], chunk=1)
    ro.close()
    assert sorted(narrow) == ["A", "C"]
    for m in narrow:
        assert np.allclose(narrow[m][0], full[m][0], rtol=0, atol=0.01)  # SQLite julianday: sub-ms float rounding
        assert np.array_equal(narrow[m][1], full[m][1])


def test_bots_left_out_unless_copied(population):
    from quant.data import load_closed_trades

    con = sqlite3.connect(population)
    con.execute("CREATE TABLE wallets (address TEXT PRIMARY KEY, junk_reason TEXT, copy_weight REAL)")
    w = [r[0] for r in con.execute("SELECT DISTINCT wallet FROM closed_trades ORDER BY wallet LIMIT 3")]
    con.executemany(
        "INSERT INTO wallets VALUES (?,?,?)",
        [
            (w[0], "bot: median hold 6 s", 0),
            (w[1], "bot: 30 transactions an hour", 0.2),
            (w[2], "copy replay: lost", 0),
        ],
    )
    con.commit()
    con.close()
    ro = open_ro(population)
    kept = set(load_closed_trades(ro, NOW - 30 * DAY, None, skip_bots=True)[0]["wallet"])
    every = set(load_closed_trades(ro, NOW - 30 * DAY, None, skip_bots=False)[0]["wallet"])
    ro.close()
    assert every - kept == {w[0]}
