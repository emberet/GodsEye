import re
import sqlite3
from pathlib import Path

import pytest

from quant.config import QuantConfig
from quant.flow import FLOW_SCHEMA_SQL
from quant.run import run

from .conftest import NOW

CFG = QuantConfig(n_perm=1000, n_boot=500, ruin_paths=300)
ON = QuantConfig(n_perm=1000, n_boot=500, ruin_paths=300, use_flow="on")


def put_flow(path, clusters=(), backtests=(), at=NOW):
    con = sqlite3.connect(path)
    con.executescript(FLOW_SCHEMA_SQL)
    con.executemany(
        "INSERT OR REPLACE INTO wallet_clusters (wallet, cluster_id, role, funder, follows, lead_lag_score, sync_score,"
        " independent_score, n_mints, computed_at) VALUES (?,?,?,NULL,NULL,0,0,?,10,?)",
        [(w, cid, role, ind, at) for w, cid, role, ind in clusters],
    )
    con.executemany(
        "INSERT OR REPLACE INTO backtest_results (leader, computed_at, n_trades, n_open, copy_return_pct, copy_pnl_sol,"
        " max_drawdown, delay_sec, slippage_bps, fee_bps, size_sol) VALUES (?,?,30,0,?,0,0,5,100,100,0.1)",
        [(w, at, r) for w, r in backtests],
    )
    con.commit()
    con.close()


def verdict(path, w="skilled"):
    con = sqlite3.connect(path)
    v = con.execute("SELECT verdict, skill_score FROM wallet_skill WHERE wallet=?", (w,)).fetchone()
    con.close()
    return v


def test_flag_off_ignores_flow_tables(population):
    put_flow(population, [("skilled", "c1", "sybil", 0.0)], [("skilled", -50.0)])
    run(population, CFG, now=NOW)
    assert verdict(population)[0] == "skill"


def test_independent_skilled_wallet_not_penalized(population):
    run(population, CFG, now=NOW)
    base = verdict(population)
    put_flow(population, [("skilled", None, "independent", 1.0)], [("skilled", 12.5)])
    s = run(population, ON, now=NOW)
    v = verdict(population)
    assert v[0] == "skill" and v[1] == pytest.approx(base[1])
    assert s["flow"]["skill_after"] == 1


@pytest.mark.parametrize("role", ["follower", "sybil"])
def test_follower_or_sybil_cannot_be_skill(population, role):
    put_flow(population, [("skilled", "c1" if role == "sybil" else None, role, 0.2)], [("skilled", 40.0)])
    s = run(population, ON, now=NOW)
    assert verdict(population)[0] == "luck"
    assert s["flow"]["follower_or_sybil"] == 1


@pytest.mark.parametrize("ret", [-3.0, 0.0, None])
def test_copy_return_must_be_positive(population, ret):
    put_flow(population, [("skilled", None, "independent", 1.0)], [] if ret is None else [("skilled", ret)])
    run(population, ON, now=NOW)
    assert verdict(population)[0] == "luck"


def test_missing_or_stale_tables_block_skill(population, tmp_path):
    run(population, ON, now=NOW)  # tables never written
    assert verdict(population)[0] == "luck"
    put_flow(population, [("skilled", None, "independent", 1.0)], [("skilled", 10.0)], at=NOW - 72 * 3600)
    run(population, ON, now=NOW)
    assert verdict(population)[0] == "luck"


def test_independent_score_scales_skill_score(population):
    run(population, CFG, now=NOW)
    base = verdict(population)[1]
    put_flow(population, [("skilled", None, "leader", 0.5)], [("skilled", 10.0)])
    run(population, ON, now=NOW)
    v = verdict(population)
    assert v[0] == "skill" and v[1] == pytest.approx(base * 0.5)


def test_use_flow_validated(monkeypatch):
    monkeypatch.setenv("QUANT_USE_FLOW", "maybe")
    with pytest.raises(ValueError):
        QuantConfig.from_env()
    monkeypatch.setenv("QUANT_USE_FLOW", "on")
    assert QuantConfig.from_env().use_flow == "on"
    monkeypatch.delenv("QUANT_USE_FLOW")
    assert QuantConfig.from_env().use_flow == "off"


def test_schema_matches_rust():
    rs = (Path(__file__).resolve().parents[2] / "rust/ingest/crates/ge-flow/src/db.rs").read_text()
    assert re.search(r'FLOW_SCHEMA_SQL: &str = "(.*?)";', rs, re.S).group(1) == FLOW_SCHEMA_SQL
