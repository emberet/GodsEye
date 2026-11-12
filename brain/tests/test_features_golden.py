"""brain/spec/golden: the files are up to date with brain.features.golden, every case reproduces from its JSON input alone
to 1e-6, and the cases cover what the TS side must get right. Plus the spec rules the golden files rely on."""
from __future__ import annotations

import json
import math

import numpy as np
import pytest

from brain.features import exit as fx
from brain.features import golden, spec
from brain.features.entry import entry_raw, gate

ENTRY = golden.GOLDEN_DIR / "entry.json"
EXIT = golden.GOLDEN_DIR / "exit.json"
LIVE_KINDS = ("swap:", "ring:", "db:", "ledger:", "position:")


def close(a, b, tol=1e-6) -> bool:
    if a is None or b is None or isinstance(a, str) or isinstance(b, str):
        return (a is None and (b is None or (isinstance(b, float) and math.isnan(b)))) or a == b
    if math.isnan(b):
        return False
    return abs(a - b) <= tol * max(1.0, abs(a))


def same(a, b, tol=1e-9) -> bool:
    """JSON trees equal, numbers to `tol` (relative): libm differs in the last digits between macOS and Linux (CI)."""
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(same(a[k], b[k], tol) for k in a)
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(same(x, y, tol) for x, y in zip(a, b))
    if isinstance(a, float) or isinstance(b, float):
        if not (isinstance(a, (int, float)) and isinstance(b, (int, float))):
            return False
        return (math.isnan(a) and math.isnan(b)) or abs(a - b) <= tol * max(1.0, abs(a), abs(b))
    return a == b


def test_golden_files_are_up_to_date():
    for path, built in ((ENTRY, golden.build_entry()), (EXIT, golden.build_exit())):
        assert same(json.loads(path.read_text()), json.loads(golden.render(built))), "run python -m brain.features.golden"


def test_entry_cases_reproduce_from_the_json_alone():
    doc = json.loads(ENTRY.read_text())
    feats = spec.entry_features()
    assert doc["features"] == [f.name for f in feats] and doc["feature_spec_version"] == spec.version()
    assert doc["columns"] == spec.columns(feats, doc["categories"])
    norm = spec.Norm(doc["columns"], np.array(doc["norm"]["mean"]), np.array(doc["norm"]["std"]))
    for c in doc["cases"]:
        raw = entry_raw(c["input"])
        assert gate(c["input"], raw) == c["expected"]["gate"], c["name"]
        for k, v in c["expected"]["raw"].items():
            assert close(v, raw[k]), (c["name"], k, v, raw[k])
        z = spec.normalise(spec.encode(raw, feats, doc["categories"]), norm)[0]
        assert len(z) == len(doc["columns"])
        assert np.allclose(z, c["expected"]["vector"], rtol=0, atol=1e-6), c["name"]


def test_exit_cases_reproduce_from_the_json_alone():
    doc = json.loads(EXIT.read_text())
    feats = spec.exit_features()
    assert doc["features"] == [f.name for f in feats] and doc["columns"] == spec.columns(feats)
    norm = spec.Norm(doc["columns"], np.array(doc["norm"]["mean"]), np.array(doc["norm"]["std"]))
    for c in doc["cases"]:
        raw = fx.exit_raw(fx.case_inputs(c["input"]))
        for k, v in c["expected"]["raw"].items():
            assert close(v, raw[k]), (c["name"], k, v, raw[k])
        z = fx.exit_matrix(fx.case_inputs(c["input"]), norm)[0]
        assert np.allclose(z, c["expected"]["vector"], rtol=0, atol=1e-6), c["name"]


def test_cases_cover_what_the_runtime_must_get_right():
    doc = json.loads(ENTRY.read_text())
    cases = doc["cases"]
    assert len(cases) >= 30 and len(json.loads(EXIT.read_text())["cases"]) >= 10
    assert {c["expected"]["gate"] for c in cases} == {None, *spec.gates()}
    raws = [c["expected"]["raw"] for c in cases]
    for f in spec.entry_features():  # every flagged feature is missing somewhere and present somewhere
        if f.missing_flag:
            assert any(r[f.name] is None for r in raws) and any(r[f.name] is not None for r in raws), f.name
    for f in spec.load()["entry"]:  # every 0/1 feature takes both values (sfx_pump 1 everywhere would pass any port)
        if f["definition"].startswith(("1 if", "1 when")):
            assert {r[f["name"]] for r in raws} == {0.0, 1.0}, f["name"]
    assert any(r["signal_lateness_sec"] == 0.0 for r in raws) and any(r["signal_lateness_sec"] > 0 for r in raws)
    groups = {r["venue_group"] for r in raws}
    assert "missing" in groups and any(g not in doc["categories"]["venue_group"] for g in groups)  # an unseen level
    assert any(c["input"]["first_seen"] is None for c in cases)  # first sighting
    assert any(c["input"]["swap"]["venue"] and "(via bot)" in c["input"]["swap"]["venue"] for c in cases)


def test_every_feature_has_one_live_source():
    doc = spec.load()
    for head in ("entry", "exit"):
        for f in doc[head]:
            src = f["live_source"]
            assert isinstance(src, str) and src.startswith(LIVE_KINDS), (f["name"], src)
            assert sum(src.count(k) for k in LIVE_KINDS) == 1, (f["name"], src)  # one structure, no "or" fallbacks
            assert " or " not in src.split("(")[0], (f["name"], src)
            assert f["transform"] in ("none", "log1p", "share", "log10", "signed_log", "onehot") or f["transform"].startswith("clip:")
            assert f.get("default") is not None
    names = [f["name"] for f in doc["entry"]]
    assert "ct_win_7d" not in names and any(d["name"] == "ct_win_7d" for d in doc["dropped"])
    assert doc["version"] == 1


def test_transforms_and_missing_rules():
    assert spec.transform("log1p", -3.0) == 0.0
    assert spec.transform("log10", 0.0) == 0.0 and spec.transform("log10", 1000.0) == pytest.approx(3.0)
    assert spec.transform("signed_log", -math.e + 1) == pytest.approx(-1.0)
    assert spec.transform("clip:-1,3", 7.0) == 3.0
    feats = [spec.Feature("x", "entry", "log1p", True, 0.0), spec.Feature("y", "entry", "none", False, "train_mean")]
    X = spec.encode({"x": float("nan"), "y": None}, feats)
    assert X[0, 0] == 0.0 and X[0, 1] == 1.0 and math.isnan(X[0, 2])  # numeric default, flag; train_mean left to normalise


# ---------------------------------------------------------------------------------------------------------------------
# The trailing price filter (filter.json): prices.py against derive.build_prices, the SQL the offline build uses


FILTER = golden.GOLDEN_DIR / "filter.json"


def sql_ok(rows: list[dict]) -> list[bool]:
    """derive.build_prices' ok flag for one coin's swaps in the given order (one second apart)."""
    import duckdb
    import pandas as pd

    from brain.data import derive

    df = pd.DataFrame(rows)
    n = len(df)
    df = pd.DataFrame({
        "id": np.arange(1, n + 1), "signature": [f"s{i}" for i in range(n)], "wallet": df["wallet"], "mint": "M",
        "side": "buy", "ts": pd.to_datetime(1_792_800_000 + np.arange(n), unit="s", utc=True), "slot": np.arange(n),
        "price_sol": df["price"].astype(float), "sol_amount": df["sol"].astype(float), "token_amount": df["tokens"].astype(float), "_src": 0,
    })
    con = duckdb.connect()
    con.register("swaps_df", df)
    derive.prepare_swaps(con, "SELECT * FROM swaps_df")
    derive.build_prices(con)
    return [bool(x) for x in con.execute("SELECT ok FROM px ORDER BY okey").df()["ok"]]


def test_filter_file_is_up_to_date_and_matches_the_sql():
    from brain.features import prices

    assert same(json.loads(FILTER.read_text()), json.loads(golden.render(golden.build_filter()))), "run python -m brain.features.golden"
    doc = json.loads(FILTER.read_text())
    assert len(doc["cases"]) >= 10
    for c in doc["cases"]:
        rows = c["input"]["swaps"]
        assert prices.ok_flags(rows) == c["expected"]["ok"], c["name"]
        assert sql_ok(rows) == c["expected"]["ok"], c["name"]
    flags = {c["name"]: c["expected"]["ok"] for c in doc["cases"]}
    assert flags["rug_heals_on_the_7th_print"][10:] == [False] * 6 + [True] * 3
    assert flags["window_is_ten"] == [True] + [False] * 10 + [True] * 2


@pytest.mark.parametrize("seed", [11, 12, 13])
def test_filter_reference_matches_the_sql_on_random_tapes(seed):
    from brain.features import prices

    rng = np.random.default_rng(seed)
    rows, p = [], 1e-7
    for _ in range(400):
        p *= float(np.exp(rng.normal(0, 0.3)))
        if rng.random() < 0.02:
            p *= float(rng.choice([0.01, 50.0]))  # a lasting jump
        price = p * float(rng.choice([1.0, 30.0, 0.02], p=[0.9, 0.05, 0.05]))  # glitches
        if rng.random() < 0.03:
            price = 0.0
        sol = float(rng.choice([0.0005, 0.01, 0.3, 2.0]))
        rows.append({"wallet": f"W{int(rng.integers(0, 4))}", "price": price, "sol": sol,
                     "tokens": sol / price if price > 0 and rng.random() > 0.03 else 0.5})
    want = sql_ok(rows)
    assert prices.ok_flags(rows) == want
    assert 0 < sum(want) < len(want)
