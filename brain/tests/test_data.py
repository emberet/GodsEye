"""brain.data: loaders (views, archive dedupe, ._ files), derive (prices, bars, entries, paths, leader exits, insert
time, known_at_t, outage hours) and splits, on tiny synthetic swaps with hand-computed answers."""
from __future__ import annotations

import json
from datetime import datetime, timezone

import duckdb
import numpy as np
import pandas as pd
import pytest

from brain.data import derive, loaders, splits

BASE = 1_791_999_960  # a minute-aligned UTC epoch second (2026-10-14)
assert BASE % 60 == 0
L, O, X = "Leader1111", "Other2222", "NotInPool333"
M = "MintAAAA"


def swap(i, wallet, t, side, price, sol, tokens=None, bal=0.0, mint=M, sig=None):
    tokens = sol / price if tokens is None else tokens
    return {
        "id": i, "wallet": wallet, "signature": sig or f"sig{i}", "slot": 1000 + t, "ts": pd.Timestamp(BASE + t, unit="s", tz="UTC"),
        "mint": mint, "side": side, "token_amount": tokens, "token_balance_before": bal, "sol_amount": sol, "price_sol": price,
        "venue": "pumpswap", "jito_tip": 0, "fee_lamports": 5000, "token_age_sec": 100.0, "quote": "SOL",
        "quote_amount": sol, "sol_usd": 150.0, "usd_amount": sol * 150,
    }


def synthetic_swaps() -> pd.DataFrame:
    rows = [
        swap(1, L, 0, "buy", 0.01, 1.0, tokens=100.0),  # episode 1
        swap(2, O, 3, "buy", 0.011, 0.1),
        swap(3, O, 7, "buy", 0.012, 0.1),
        swap(4, O, 20, "sell", 0.013, 0.1),  # entry_15 (age 5) -> t0 = 20, p0 = 0.013
        swap(5, O, 40, "buy", 0.02, 0.1),  # minute 1
        swap(6, O, 45, "buy", 5.0, 0.0005),  # dust: no price
        swap(7, O, 50, "buy", 0.5, 0.1, tokens=2.0),  # unit-error spike: not ok
        swap(8, O, 70, "buy", 0.021, 0.1),  # entry_60 (age 10), minute 1 close
        swap(9, L, 420, "sell", 0.0286, 50 * 0.0286, tokens=50.0, bal=100.0),  # leader sells half, minute 7, peak +120%
        swap(10, L, 1000, "buy", 0.025, 0.1, tokens=4.0, bal=50.0),  # episode 2 (prior buy 1), minute 17
        swap(11, O, 3020, "buy", 0.0039, 0.1),  # minute 50: -70%
        swap(12, L, 7220, "sell", 0.013, 50 * 0.013, tokens=50.0, bal=54.0),  # minute 120, leader out of ep 1
        swap(13, O, 90020, "buy", 1.0, 0.1, tokens=2.0),  # after 24 h (and an outlier): never in the path
        swap(14, X, 30, "buy", 0.015, 1.0),  # wallet not in the pool (nor is O): no episode, but a price
        swap(15, L, 5, "buy", 0.012, 0.04),  # below MIN_LEADER_SOL: no episode, counts as a prior buy for ep 2
    ]
    df = pd.DataFrame(rows)
    df.loc[df["id"] == 14, "price_sol"] = 0.015
    return df


FIRST_SEEN = BASE + 500  # the leader joined the server's wallets table between episode 1 (t = 0) and 10 (t = 1000)


def con_with(df: pd.DataFrame, pool=(L,), src: int = 0, first_seen=FIRST_SEEN) -> duckdb.DuckDBPyConnection:
    con = duckdb.connect()
    con.execute("SET TimeZone='UTC'")
    df = df.copy()
    if "_src" not in df:
        df["_src"] = src
    con.register("swaps_df", df)
    con.execute("CREATE TEMP TABLE pool AS SELECT unnest(?) AS address, to_timestamp(?) AS first_seen_at", [list(pool), first_seen])
    derive.prepare_swaps(con, "SELECT * FROM swaps_df")
    return con


@pytest.fixture()
def built():
    df = synthetic_swaps()
    con = con_with(df)
    data_end = BASE + 90020
    derive.run_core(con, data_end)
    eps = con.execute(derive.episodes_sql(data_end)).df().set_index("episode_id")
    path = con.execute(derive.PATHS_SQL).df()
    return con, eps, path


def test_prices_drop_dust_and_unit_errors(built):
    con, _, _ = built
    ok = dict(con.execute("SELECT t - ? AS rel, ok FROM px", [BASE]).fetchall())
    assert ok[45] is False  # dust
    assert ok[50] is False  # 0.5 among ~0.01-0.03 neighbours
    assert ok[90020] is False  # 1.0 far above its neighbours
    valid = dict(con.execute("SELECT t - ? AS rel, valid FROM px", [BASE]).fetchall())
    assert valid[50] and valid[90020]  # rejected as outliers, not by the token floor
    con.execute("UPDATE sw SET token_amount = 0.5 WHERE id = 5")  # under 1 token: no price, even at the market's level
    derive.build_prices(con)
    assert dict(con.execute("SELECT t - ? AS rel, valid FROM px", [BASE]).fetchall())[40] is False
    assert ok[3020] is True  # a real -70% move with neighbours on both sides is kept
    assert all(ok[t] for t in (0, 3, 7, 20, 40, 70, 420, 1000, 7220))


def test_episode_selection(built):
    _, eps, _ = built
    assert sorted(eps.index) == [1, 10]  # 15 is below 0.05 SOL, 14 is not a pool wallet, sells are not episodes
    assert eps.loc[1, "leader"] == L and eps.loc[1, "split"] == "train"
    assert eps.loc[1, "leader_prior_buys_mint"] == 0
    assert eps.loc[10, "leader_prior_buys_mint"] == 2  # buys 1 and 15 came before
    assert eps.loc[1, "mint_prior_swaps"] == 0
    assert eps.loc[1, "ts"] == pd.Timestamp(BASE, unit="s", tz="UTC")


def test_entry_prices_by_delay(built):
    _, eps, _ = built
    e = eps.loc[1]
    assert e["entry_price_5"] == pytest.approx(0.012) and e["entry_age_5"] == 0  # the leader's own small buy at t=5
    assert e["entry_price_15"] == pytest.approx(0.013) and e["entry_age_15"] == 5
    assert e["entry_price_30"] == pytest.approx(0.015) and e["entry_age_30"] == 0  # any tracked wallet's swap prices
    assert e["entry_price_60"] == pytest.approx(0.021) and e["entry_age_60"] == 10  # the 0.5 spike at 50 is skipped
    assert e["entry_vs_leader_15"] == pytest.approx(0.3)
    assert e["entry_ts_15"] == pd.Timestamp(BASE + 20, unit="s", tz="UTC")
    # episode 10: next ok price is 2020 s later, outside the 120 s window
    e2 = eps.loc[10]
    for d in derive.DELAYS:
        assert pd.isna(e2[f"entry_price_{d}"])
    assert pd.isna(e2["ret_1m"]) and pd.isna(e2["max_ret_24h"]) and pd.isna(e2["n_price_points_24h"])


def test_forward_returns_and_extremes(built):
    _, eps, _ = built
    e = eps.loc[1]
    p0 = 0.013
    assert e["ret_1m"] == pytest.approx(0.021 / p0 - 1, rel=1e-5)
    assert e["ret_5m"] == pytest.approx(0.021 / p0 - 1, rel=1e-5)
    assert e["ret_15m"] == pytest.approx(0.0286 / p0 - 1, rel=1e-5)
    assert e["ret_1h"] == pytest.approx(0.0039 / p0 - 1, rel=1e-5)
    assert e["ret_6h"] == pytest.approx(0.0, abs=1e-6)
    assert e["ret_24h"] == pytest.approx(0.0, abs=1e-6)
    assert e["max_ret_24h"] == pytest.approx(1.2, rel=1e-5) and e["minutes_to_peak"] == 7
    assert e["min_ret_24h"] == pytest.approx(-0.7, rel=1e-5) and e["minutes_to_trough"] == 50
    assert e["minutes_to_stop60"] == 50 and e["minutes_to_2x"] == 7
    assert e["n_price_points_24h"] == 7 and e["n_path_minutes"] == 5
    assert e["last_price_ts"] == pd.Timestamp(BASE + 7220, unit="s", tz="UTC")
    assert not e["censored_24h"]


def test_leader_sells(built):
    _, eps, _ = built
    e = eps.loc[1]
    assert e["leader_first_sell_sec"] == 420 and e["leader_first_sell_frac"] == pytest.approx(0.5)
    assert e["leader_sold_frac_24h"] == pytest.approx(1.0) and e["leader_n_sells_24h"] == 2
    assert e["leader_exit_sec"] == 7220
    e2 = eps.loc[10]  # holds 54 after the buy; sells 50 later
    assert e2["leader_first_sell_sec"] == 6220
    assert e2["leader_sold_frac_24h"] == pytest.approx(50 / 54)
    assert pd.isna(e2["leader_exit_sec"])


def test_paths(built):
    _, _, path = built
    p = path[path.episode_id == 1].sort_values("k")
    assert list(p.k) == [0, 1, 7, 17, 50, 120]
    assert p.iloc[0][["close_ret", "high_ret", "low_ret"]].tolist() == [0, 0, 0]
    m1 = p[p.k == 1].iloc[0]
    assert m1.n == 3 and m1.close_ret == pytest.approx(0.021 / 0.013 - 1, rel=1e-5)  # t = 30, 40, 70
    assert m1.high_ret == pytest.approx(0.021 / 0.013 - 1, rel=1e-5) and m1.low_ret == pytest.approx(0.015 / 0.013 - 1, rel=1e-5)
    assert (path.episode_id == 10).sum() == 0  # no entry -> no path
    assert set(path.day) == {pd.Timestamp(BASE, unit="s").strftime("%Y-%m-%d")}


def test_dense_paths(built):
    _, _, path = built
    d = loaders.dense_paths(path[path.episode_id == 1], max_k=130)
    assert len(d) == 131 and d.observed.sum() == 6
    r = d.set_index("k")
    assert r.loc[6, "close_ret"] == pytest.approx(0.021 / 0.013 - 1, rel=1e-5) and r.loc[6, "minutes_since_price"] == 5
    assert r.loc[6, "high_ret"] == r.loc[6, "close_ret"] and r.loc[6, "n"] == 0
    assert r.loc[7, "close_ret"] == pytest.approx(1.2, rel=1e-5) and r.loc[7, "minutes_since_price"] == 0
    assert r.loc[130, "close_ret"] == pytest.approx(0.0, abs=1e-6)
    cut = loaders.dense_paths(path[path.episode_id == 1], max_k=130, last_k={1: 60})
    assert cut.k.max() == 60


def test_paths_match_brute_force_on_random_tape():
    """Phase-bar paths equal a direct per-episode computation over the raw prices (many episodes, phases, two mints)."""
    rng = np.random.default_rng(7)
    rows, i = [], 1
    for mint in ("MintR1", "MintR2"):
        ts = np.sort(rng.choice(np.arange(0, 30 * 3600), size=400, replace=False))
        price = 0.01 * np.exp(np.cumsum(rng.normal(0, 0.05, size=len(ts))))
        for t, pr in zip(ts, price):
            who = L if rng.random() < 0.3 else O
            rows.append(swap(i, who, int(t), "buy" if rng.random() < 0.6 else "sell", float(pr), float(rng.uniform(0.06, 1.0)), mint=mint))
            i += 1
    df = pd.DataFrame(rows)
    con = con_with(df)
    data_end = BASE + 40 * 3600
    derive.run_core(con, data_end)
    path = con.execute("SELECT episode_id, k, close_ret, high_ret, low_ret, n FROM path").df()
    eps = con.execute(derive.episodes_sql(data_end)).df()
    px = con.execute("SELECT mint, t, p, okey FROM px WHERE ok_label ORDER BY mint, okey").df()
    entered = eps[eps.entry_price_15.notna()]
    assert len(entered) > 50
    for _, e in entered.iterrows():
        t0 = int(e.entry_ts_15.timestamp())
        p0 = e.entry_price_15
        w = px[(px.mint == e.mint) & (px.t > t0) & (px.t <= t0 + 86400)].copy()
        w["k"] = np.ceil((w.t - t0) / 60).astype(int)
        g = w.groupby("k").agg(close=("p", "last"), hi=("p", "max"), lo=("p", "min"), n=("p", "size"))
        got = path[(path.episode_id == e.episode_id) & (path.k >= 1)].set_index("k").sort_index()
        assert list(got.index) == list(g.index)
        np.testing.assert_allclose(got.close_ret, g.close / p0 - 1, rtol=1e-5, atol=1e-6)
        np.testing.assert_allclose(got.high_ret, g.hi / p0 - 1, rtol=1e-5, atol=1e-6)
        np.testing.assert_allclose(got.low_ret, g.lo / p0 - 1, rtol=1e-5, atol=1e-6)
        assert list(got.n) == list(g.n)
        if len(g):
            assert e.minutes_to_peak == g.index[np.argmax(g.hi.to_numpy())]
            last = g[g.index <= 60]
            if len(last):
                assert e.ret_1h == pytest.approx(last.close.iloc[-1] / p0 - 1, rel=1e-5, abs=1e-6)


def test_censoring_nulls_late_horizons():
    df = synthetic_swaps()
    con = con_with(df)
    data_end = BASE + 20 + 4000  # data stops ~67 min after the 15 s entry
    derive.run_core(con, data_end)
    e = con.execute(derive.episodes_sql(data_end)).df().set_index("episode_id").loc[1]
    assert e["censored_24h"]
    assert not pd.isna(e["ret_1h"]) and pd.isna(e["ret_6h"]) and pd.isna(e["ret_24h"])


def test_bars(built):
    con, _, _ = built
    b = con.execute(derive.BARS_SQL).df().sort_values("minute").reset_index(drop=True)
    first = b.iloc[0]
    assert first.minute == pd.Timestamp(BASE, unit="s", tz="UTC")
    # minute 0 holds t = 0..59: ok prices 0.01, 0.011, 0.012, 0.012(id15), 0.013, 0.015, 0.02 (dust and spike excluded)
    assert first.open == pytest.approx(0.01) and first.close == pytest.approx(0.02)
    assert first.high == pytest.approx(0.02) and first.low == pytest.approx(0.01)
    assert first.n_trades == 9 and first.n_priced == 7
    assert first.n_buyers == 3 and first.n_sellers == 1
    assert first.sell_sol == pytest.approx(0.1)
    assert b.minute.is_unique


def test_prepare_swaps_dedupes_live_first():
    df = synthetic_swaps()
    dup = df[df.id == 5].copy()
    dup["_src"] = 1
    dup["id"] = 99
    dup["price_sol"] = 0.0201  # archive copy differs: the live row must win
    both = pd.concat([df.assign(_src=0), dup])
    con = con_with(both)
    rows = con.execute("SELECT id, price_sol FROM sw WHERE signature = 'sig5'").fetchall()
    assert rows == [(5, 0.02)]


def write_parquet(df: pd.DataFrame, path):
    path.parent.mkdir(parents=True, exist_ok=True)
    df.to_parquet(path, index=False)


@pytest.fixture()
def root(tmp_path):
    e = tmp_path / "export"
    df = synthetic_swaps()
    write_parquet(df[df.id <= 8], e / "wallet_swaps" / "part-1.parquet")
    arch = df[df.id >= 6].copy()  # overlaps live on ids 6..8
    arch["ts"] = arch["ts"].dt.strftime("%Y-%m-%dT%H:%M:%S.000Z")  # archive written with ts as text
    write_parquet(arch, e / "wallet_swaps_archive" / "2026-10-17.parquet")
    (e / "wallet_swaps" / "._part-1.parquet").write_bytes(b"\x00\x05\x16\x07 AppleDouble junk")
    (e / "wallet_swaps_archive" / "._2026-10-17.parquet").write_bytes(b"junk")
    write_parquet(pd.DataFrame({"address": [L], "tier": ["a"], "first_seen_at": [pd.Timestamp(FIRST_SEEN, unit="s", tz="UTC")]}),
                  e / "wallets" / "part-1.parquet")
    (e / "wallets" / "._part-1.parquet").write_bytes(b"junk")
    write_parquet(pd.DataFrame({"mint": [M], "symbol": ["AAA"]}), e / "token_info" / "part-1.parquet")
    (e / "runner_early_counts").mkdir()  # empty table dir: no view
    return tmp_path


def test_connect_views_and_archive_union(root):
    con = loaders.connect(root)
    names = loaders.tables(con)
    assert {"wallet_swaps", "wallet_swaps_live", "wallet_swaps_archive", "wallets", "token_info"} <= set(names)
    assert "runner_early_counts" not in names
    assert con.execute("SELECT count(*) FROM wallet_swaps").fetchone()[0] == 15
    assert con.execute("SELECT count(DISTINCT signature) FROM wallet_swaps").fetchone()[0] == 15
    assert con.execute("SELECT typeof(ts) FROM wallet_swaps_archive LIMIT 1").fetchone()[0] == "TIMESTAMP WITH TIME ZONE"
    assert con.execute("SELECT current_setting('TimeZone')").fetchone()[0] == "UTC"
    assert con.execute("SELECT current_setting('threads')").fetchone()[0] == 2
    no_arch = loaders.connect(root, archive=False)
    assert no_arch.execute("SELECT count(*) FROM wallet_swaps").fetchone()[0] == 8


def test_build_end_to_end(root):
    meta = derive.build(root, n_buckets=2)
    dd = root / "derived"
    assert (dd / "episodes.parquet").is_file() and (dd / "_meta.json").is_file()
    assert not list(dd.glob("_build_*"))
    assert json.loads((dd / "_meta.json").read_text())["counts"]["episodes"] == 2 == meta["counts"]["episodes"]
    con = loaders.connect(root)
    assert con.execute("SELECT count(*) FROM episodes").fetchone()[0] == 2
    assert con.execute("SELECT count(*) FROM bars_1m").fetchone()[0] > 0
    assert con.execute("SELECT count(*) FROM episode_paths WHERE episode_id = 1").fetchone()[0] == 6
    assert con.execute("SELECT ret_1h FROM episodes WHERE episode_id = 1").fetchone()[0] == pytest.approx(0.0039 / 0.013 - 1, rel=1e-5)
    day_dirs = sorted(p.name for p in (dd / "episode_paths").iterdir())
    assert day_dirs == [f"day={datetime.fromtimestamp(BASE, timezone.utc):%Y-%m-%d}"]
    derive.build(root, n_buckets=3)  # re-run with a different split: same answer, old files replaced
    con = loaders.connect(root)
    assert con.execute("SELECT count(*) FROM episodes").fetchone()[0] == 2
    assert con.execute("SELECT count(*) FROM episode_paths").fetchone()[0] == 6
    assert len(list((dd / "bars_1m").glob("*.parquet"))) <= 3


def test_partial_build_does_not_replace(root):
    derive.build(root, n_buckets=2)
    derive.build(root, n_buckets=2, only_buckets=[0, 1])
    assert (root / "derived" / "_partial" / "episodes.parquet").is_file()
    assert json.loads((root / "derived" / "_meta.json").read_text())["buckets_built"] == [0, 1]


def random_tape(mints, n=150, seed=7):
    rng = np.random.default_rng(seed)
    rows, i = [], 1000
    for mint in mints:
        ts = np.sort(rng.choice(np.arange(0, 30 * 3600), size=n, replace=False))
        price = 0.01 * np.exp(np.cumsum(rng.normal(0, 0.05, size=len(ts))))
        for t, pr in zip(ts, price):
            who = L if rng.random() < 0.3 else O
            rows.append(swap(i, who, int(t), "buy" if rng.random() < 0.6 else "sell", float(pr), float(rng.uniform(0.06, 1.0)), mint=mint))
            i += 1
    return pd.DataFrame(rows)


def test_sliced_paths_and_resume(tmp_path, monkeypatch):
    root = tmp_path
    write_parquet(random_tape([f"Mint{c}" for c in "BCDEFGH"]), root / "export" / "wallet_swaps" / "part-1.parquet")
    write_parquet(pd.DataFrame({"address": [L]}), root / "export" / "wallets" / "part-1.parquet")
    derive.build(root, n_buckets=4)
    con = loaders.connect(root)
    ref_eps = con.execute("SELECT * EXCLUDE (src) FROM episodes ORDER BY episode_id").df()
    ref_path = con.execute("SELECT episode_id, k, close_ret FROM episode_paths ORDER BY episode_id, k").df()
    con.close()

    # one episode per path slice, and a crash in the second bucket, then --resume
    monkeypatch.setattr(derive, "PATH_CHUNK_EPISODES", 1)
    real = derive.process_bucket
    calls = []

    def flaky(con, stage, k, data_end_t):
        calls.append(k)
        if len(calls) == 2:
            raise RuntimeError("drive unplugged")
        return real(con, stage, k, data_end_t)

    monkeypatch.setattr(derive, "process_bucket", flaky)
    with pytest.raises(RuntimeError):
        derive.build(root, n_buckets=4)
    assert len(list((root / "derived").glob("_build_*"))) == 1
    derive.build(root, n_buckets=4, resume=True)
    assert len(calls) >= 3 and calls[2] == calls[1] and calls.count(calls[0]) == 1  # the finished bucket was not redone
    assert not list((root / "derived").glob("_build_*"))
    con = loaders.connect(root)
    eps = con.execute("SELECT * EXCLUDE (src) FROM episodes ORDER BY episode_id").df()
    path = con.execute("SELECT episode_id, k, close_ret FROM episode_paths ORDER BY episode_id, k").df()
    pd.testing.assert_frame_equal(eps, ref_eps)
    pd.testing.assert_frame_equal(path, ref_path)


# --------------------------------------------------------------------------------------------------------------------
# data v2: trailing price filter, insert time, known_at_t, outage hours, splits
# --------------------------------------------------------------------------------------------------------------------

def ok_by_id(df: pd.DataFrame) -> dict:
    con = con_with(df)
    derive.build_prices(con)
    return dict(con.execute("SELECT s.id, p.ok FROM px p JOIN sw s ON s.mint = p.mint AND s.okey = p.okey").fetchall())


def test_trailing_filter_heals_after_a_real_drop():
    """10 prints at 1e-6, then a lasting 20x drop: the first 6 low prints are rejected (the median of the previous 10
    is still high), the 7th passes once 6 of the 10 are low. Non-recursive: rejected prints still enter the window."""
    rows = [swap(i, O, i * 10, "sell", 1e-6, 0.5) for i in range(1, 11)]
    rows += [swap(i, O, i * 10, "sell", 5e-8, 0.5) for i in range(11, 21)]
    ok = ok_by_id(pd.DataFrame(rows))
    assert all(ok[i] for i in range(1, 11))  # the mint's first price has no history and passes
    assert [ok[i] for i in range(11, 21)] == [False] * 6 + [True] * 4


def test_trailing_filter_uses_only_earlier_prices():
    """Point in time: a swap's `ok` is the same on the full tape and on the tape cut right after it."""
    df = random_tape(["MintT1", "MintT2"], n=120, seed=3)
    df.loc[df.sample(frac=0.05, random_state=1).index, "price_sol"] *= 40  # unit-error spikes
    full = ok_by_id(df)
    assert 0 < sum(not v for v in full.values()) < len(full)
    order = df.sort_values(["ts", "slot", "id"])
    for cut in (17, 60, 133, 200):
        part = ok_by_id(order.iloc[:cut])
        assert part == {i: full[i] for i in part}


def flags_by_id(df: pd.DataFrame) -> pd.DataFrame:
    con = con_with(df)
    derive.build_prices(con)
    return con.execute("SELECT s.id, p.valid, p.lone, p.ok, p.ok_label FROM px p JOIN sw s ON s.mint = p.mint AND s.okey = p.okey").df().set_index("id")


def normal_tape(n=10, price=1e-6, wallets=("A1", "B2")) -> list[dict]:
    """n prints at `price` alternating between `wallets`, 10 s apart, 0.1 SOL each (1e5 tokens at 1e-6)."""
    return [swap(i, wallets[i % len(wallets)], i * 10, "buy", price, 0.1) for i in range(1, n + 1)]


def test_one_wallets_unit_error_run_never_forms_a_level():
    """A wallet prints 8 times at 1e6x the market with micro token amounts (0.005 tokens for 0.005 SOL), interleaved
    with other wallets' normal prints: none of them may pass, however long the run (the token floor)."""
    rows = normal_tape(10)
    for j in range(8):
        rows.append(swap(100 + j, "Dust9", 200 + j * 10, "sell", 1.0, 0.005, tokens=0.005))
        if j % 2:
            rows.append(swap(200 + j, "C3", 205 + j * 10, "buy", 1e-6, 0.1))
    f = flags_by_id(pd.DataFrame(rows))
    run = list(range(100, 108))
    assert not f.loc[run, "valid"].any() and not f.loc[run, "ok_label"].any()
    assert f.loc[[201, 203, 205, 207], "ok"].all()


def test_one_wallets_run_cannot_heal_against_other_wallets():
    """The same run with whole token amounts (1000x the market, 2 tokens for 0.002 SOL) passes the token floor and
    fills the trailing window, so the median moves to its level after 6 prints; only its own wallet backs that level
    against the other wallets' prints in the window (`lone`), so it stays rejected. Once others trade at it, it heals."""
    rows = normal_tape(10)
    rows += [swap(100 + j, "Run9", 200 + j * 10, "sell", 1e-3, 0.002) for j in range(9)]
    f = flags_by_id(pd.DataFrame(rows))
    run = list(range(100, 109))
    assert f.loc[run, "valid"].all()
    assert not f.loc[run, "ok"].any() and not f.loc[run, "ok_label"].any()
    assert f.loc[[106, 107, 108], "lone"].all()  # the median is at the run's level by now: only `lone` rejects these
    # a second wallet confirming the new level: its prints and the run's next ones pass
    rows += [swap(300 + j, "C3" if j % 2 else "D4", 300 + j * 10, "buy", 1.1e-3, 0.1) for j in range(4)]
    rows += [swap(400, "Run9", 400, "sell", 1e-3, 0.002)]
    f = flags_by_id(pd.DataFrame(rows))
    assert f.loc[[300, 301, 302, 303, 400], "ok"].all()


def test_real_drop_by_several_wallets_heals():
    rows = normal_tape(10)
    rows += [swap(i, "C3" if i % 2 else "D4", i * 10, "sell", 5e-8, 0.5) for i in range(11, 21)]
    f = flags_by_id(pd.DataFrame(rows))
    low = list(range(11, 21))
    assert f.loc[low, "ok"].tolist() == [False] * 6 + [True] * 4
    assert f.loc[low, "ok_label"].all()  # labels: the price never comes back, so the drop is real from its first print


def test_labels_keep_a_rug_tail_but_not_a_low_unit_error():
    """A rug at the end of the coin's life (one wallet dumps, nothing follows) is hidden from the causal filter but kept
    for labels; a single low print that the market climbs straight back from stays rejected for both."""
    rows = normal_tape(10)
    rows += [swap(11, "C3", 110, "sell", 1e-10, 0.1)]  # low unit error ...
    rows += [swap(i, "A1" if i % 2 else "B2", i * 10, "buy", 1e-6, 0.5) for i in range(12, 16)]  # ... the market is still there
    rows += [swap(i, "Rug9", i * 10, "sell", 1e-8, 0.5) for i in range(16, 26)]  # the rug: 100x down, one wallet, 10 prints
    f = flags_by_id(pd.DataFrame(rows))
    assert not f.loc[11, "ok"] and not f.loc[11, "ok_label"]
    rug = list(range(16, 26))
    assert not f.loc[rug, "ok"].any()  # rm out of range, then lone against the earlier wallets
    assert f.loc[rug, "ok_label"].all()
    # the episode labels see the rug: its last price and trough, not the pre-rug level
    rows.append(swap(30, L, 120, "buy", 1e-6, 1.0))
    con = con_with(pd.DataFrame(rows))
    data_end = BASE + 90000
    derive.run_core(con, data_end)
    e = con.execute(derive.episodes_sql(data_end)).df().set_index("episode_id").loc[30]
    assert e["min_ret_24h"] == pytest.approx(-0.99, rel=1e-4) and e["ret_24h"] == pytest.approx(-0.99, rel=1e-4)
    assert e["last_price_ts"] == pd.Timestamp(BASE + 250, unit="s", tz="UTC")
    assert e["leader_price_ok"]


def test_insert_time_is_running_max_in_id_order():
    rows = [swap(1, O, 100, "buy", 0.01, 0.1), swap(2, O, 200, "buy", 0.01, 0.1),
            swap(3, O, 50, "buy", 0.01, 0.1, mint="MintB"),  # backfilled: stored after a swap of t = 200
            swap(4, O, 300, "buy", 0.01, 0.1, mint="MintB"), swap(5, O, 250, "buy", 0.01, 0.1)]
    df = pd.DataFrame(rows)
    want = {1: 100, 2: 200, 3: 200, 4: 300, 5: 300}
    con = con_with(df)  # running max over this source
    got = dict(con.execute("SELECT id, ins_t - ? FROM sw", [BASE]).fetchall())
    assert got == want
    assert con.execute("SELECT bool_and(ins_ts = to_timestamp(ins_t) AND ins_t >= t) FROM sw").fetchone()[0]
    # the change-point table over all swaps, then one mint alone (as a bucket sees it) joined to it
    steps = con.execute(derive.ins_steps_sql("SELECT * FROM swaps_df")).df()
    assert steps.id.tolist() == [1, 2, 4, 5] and (steps.ins_t - BASE).tolist() == [100, 200, 300, 300]
    con.register("steps_df", steps)
    con.execute("CREATE TEMP TABLE steps AS SELECT * FROM steps_df")
    derive.prepare_swaps(con, "SELECT * FROM swaps_df WHERE mint = 'MintB'", "steps")
    assert dict(con.execute("SELECT id, ins_t - ? FROM sw", [BASE]).fetchall()) == {3: 200, 4: 300}


def test_episode_insert_time_and_known_at_t(built):
    _, eps, _ = built
    assert eps.loc[1, "ins_ts"] == pd.Timestamp(BASE, unit="s", tz="UTC")
    assert eps.loc[10, "ins_ts"] == pd.Timestamp(BASE + 1000, unit="s", tz="UTC")  # ids 1..9 have smaller ts
    assert eps.loc[1, "leader_first_seen_at"] == pd.Timestamp(FIRST_SEEN, unit="s", tz="UTC")
    assert not eps.loc[1, "known_at_t"] and eps.loc[10, "known_at_t"]
    assert not eps["crosses_outage"].any()  # no outage hours given


def test_known_at_t_false_without_first_seen():
    con = con_with(synthetic_swaps(), first_seen=None)
    derive.run_core(con, BASE + 90020)
    eps = con.execute(derive.episodes_sql(BASE + 90020)).df()
    assert not eps["known_at_t"].any() and eps["leader_first_seen_at"].isna().all()


def test_crosses_outage_touches_the_24h_window():
    df = synthetic_swaps()
    data_end = BASE + 90020

    h0 = BASE // 3600 * 3600  # episode 1 (ts BASE) is 2760 s into hour h0, episode 10 (BASE + 1000) 160 s into h0 + 1
    assert BASE - h0 == 2760

    def crosses(hours):
        con = con_with(df)
        derive.run_core(con, data_end, outage=[h0 + h * 3600 for h in hours])
        return con.execute(derive.episodes_sql(data_end)).df().set_index("episode_id")["crosses_outage"].to_dict()

    assert crosses([]) == {1: False, 10: False}
    assert crosses([0]) == {1: True, 10: False}  # the buy's own hour counts; an hour before the buy does not
    assert crosses([1]) == {1: True, 10: True}
    assert crosses([24]) == {1: True, 10: True}  # [ts, ts + 24 h] reaches into hour 24
    assert crosses([25]) == {1: False, 10: True}
    assert crosses([26, -1]) == {1: False, 10: False}


def test_outage_hours_masks_dips_not_level_shifts():
    """Days 0-6 at 100/h, an outage on day 7 (5/h), days 8-13 at 100/h, then a lasting drop to 10/h from day 14."""
    rate = [100] * 7 * 24 + [5] * 24 + [100] * 6 * 24 + [10] * 7 * 24
    start = 1_792_000_800  # a whole hour
    hourly = pd.DataFrame({"h": [start + 3600 * i for i in range(len(rate))], "n": rate})
    hourly = hourly[hourly.n > 0]
    end = start + 3600 * len(rate) - 1
    o = derive.outage_hours(hourly, start, end)
    day = (o.h - start) // 86400
    assert o.loc[day == 7, "masked"].all()
    assert not o.loc[day != 7, "masked"].any()  # days 14+ are low against the past but so is what follows
    assert o.loc[day < 3, "back"].isna().all()  # too little history to judge
    # the same drop at the very end of the data (nothing follows) is judged on the past alone
    o2 = derive.outage_hours(hourly[hourly.h < start + 3600 * 24 * 15], start, start + 3600 * 24 * 15 - 1)
    assert o2.loc[(o2.h - start) // 86400 == 14, "masked"].all()
    # a partial last hour is scaled to a full hour; under 15 min covered it is not judged; empty hours count 0
    o3 = derive.outage_hours(hourly[hourly.h < start + 3600 * 24 * 10], start, start + 3600 * 24 * 10 - 3600 + 1799)
    assert o3.iloc[-1].rate == pytest.approx(200.0) and not o3.iloc[-1].masked
    o4 = derive.outage_hours(hourly[hourly.h < start + 3600 * 24 * 10], start, start + 3600 * 24 * 10 - 3600 + 600)
    assert np.isnan(o4.iloc[-1].rate) and not o4.iloc[-1].masked
    gap = hourly[(hourly.h != start + 3600 * 24 * 9 + 7200)]
    o5 = derive.outage_hours(gap, start, start + 3600 * 24 * 10 - 1)
    assert o5.loc[o5.h == start + 3600 * 24 * 9 + 7200, "n_swaps"].item() == 0
    assert o5.loc[o5.h == start + 3600 * 24 * 9 + 7200, "masked"].item()


def test_splits_spec():
    names = [p.name for p in splits.periods()]
    assert names == ["fit", "embargo", "selection", "test"]
    assert splits.period_of("2026-10-16T00:00:00Z") == "fit"
    assert splits.period_of("2026-10-29T23:59:59Z") == "fit"
    assert splits.period_of("2026-10-30T12:00:00Z") == "embargo"
    assert splits.period_of("2026-10-31T00:00:00Z") == "selection"
    assert splits.period_of("2026-11-01T23:59:59Z") == "selection"
    assert splits.period_of("2026-11-02T00:00:00Z") == "test"
    assert splits.period_of("2026-11-09") == "test"
    assert splits.period_of("2026-10-15T23:00:00Z") is None
    assert splits.test_start() == pd.Timestamp("2026-11-02", tz="UTC")
    assert derive.TEST_START.startswith("2026-11-02T00:00:00")
    emb = splits.period("embargo")
    assert emb.end - emb.start == pd.Timedelta(hours=splits.load()["embargo_hours"])
    fs = splits.folds()
    assert [f.name for f in fs] == ["f1", "f2", "f3", "f4"]
    for f in fs:  # a 24 h embargo between train and validation, validation never reaches test
        assert f.valid_from - f.train_to >= pd.Timedelta(hours=24) and f.valid_to <= splits.test_start()
    last = fs[-1]
    assert (last.train_from, last.train_to) == (splits.data_start(), splits.period("fit").end)
    assert (last.valid_from, last.valid_to) == (splits.period("selection").start, splits.period("selection").end)


def test_period_sql_matches_period_of():
    con = duckdb.connect()
    con.execute("SET TimeZone='UTC'")
    ts = ["2026-10-15 23:59:59", "2026-10-16 00:00:00", "2026-10-29 23:59:59", "2026-10-30 00:00:00",
          "2026-10-31 00:00:00", "2026-11-01 23:59:59", "2026-11-02 00:00:00", "2026-11-06 16:00:00"]
    got = [r[0] for r in con.execute(f"SELECT {splits.period_sql('x')} FROM (SELECT unnest(?)::TIMESTAMPTZ AS x)",
                                     [[t + "+00" for t in ts]]).fetchall()]
    assert got == [splits.period_of(t + "Z") for t in ts]


def test_build_writes_v2_outputs(root):
    derive.build(root, n_buckets=2)
    dd = root / "derived"
    for f in ("ins_steps.parquet", "hourly_swaps.parquet", "outage_hours.parquet"):
        assert (dd / f).is_file()
    con = loaders.connect(root)
    assert {"ins_steps", "hourly_swaps", "outage_hours", "wallet_swaps_ins"} <= set(loaders.tables(con))
    e = con.execute("SELECT episode_id, known_at_t, period, crosses_outage, ins_ts FROM episodes ORDER BY episode_id").fetchall()
    assert [(r[0], r[1], r[3]) for r in e] == [(1, False, False), (10, True, False)]
    assert e[1][4] == pd.Timestamp(BASE + 1000, unit="s", tz="UTC")
    # the view and the change points agree with a direct running max over the union
    v = dict(con.execute("SELECT id, epoch(ins_ts)::BIGINT FROM wallet_swaps_ins").fetchall())
    direct = dict(con.execute("SELECT id, max(epoch(ts)::BIGINT) OVER (ORDER BY id) FROM wallet_swaps").fetchall())
    assert v == direct and len(v) == 15
    meta = json.loads((dd / "_meta.json").read_text())
    assert meta["params"]["trail_window"] == 10 and meta["params"]["splits"]["periods"][0]["name"] == "fit"


def test_outage_run_spreads_to_its_ragged_edges():
    """Days 0-6 at 100/h; an outage on day 7 at 5/h that fades out over 21-23 h at 30/h (under half of normal, over a
    quarter) with a 40/h hole at 10 h; back to 100/h from day 8, one 60/h hour on day 9. The edges and the hole are
    masked, the lone 60/h hour is not, and day 8 is judged against the normal days, not the outage."""
    rate = [100] * 7 * 24 + [5] * 21 + [30] * 3 + [100] * 6 * 24
    rate[7 * 24 + 10] = 40
    rate[9 * 24 + 5] = 60
    start = 1_792_000_800
    hourly = pd.DataFrame({"h": [start + 3600 * i for i in range(len(rate))], "n": rate})
    o = derive.outage_hours(hourly, start, start + 3600 * len(rate) - 1)
    day = (o.h - start) // 86400
    assert o.loc[day == 7, "masked"].all()
    assert not o.loc[day != 7, "masked"].any()
    assert (o.loc[day == 8, "back"] == 100).all()  # the masked day 7 is left out of the trailing median
    assert not o["export_tail"].any() and (o["complete"] == 1).all()  # no insert lags given: no export tail


def lagged_hist(max_lag_h: float, n: int = 20_000) -> pd.DataFrame:
    """Insert lags spread evenly over [0, max_lag_h) hours, as insert_lag_sql returns them."""
    lag_min = (np.arange(n) * max_lag_h * 60 / n).astype(np.int64)
    return pd.DataFrame({"lag_min": lag_min, "n": 1}).groupby("lag_min", as_index=False)["n"].sum()


def test_export_tail_is_masked_and_never_a_level():
    """Ten days at 100/h, exported while swaps arrive with lags spread over 0-40 h: an hour x hours before the export
    holds x / 40 of its swaps. Below 90 % (the last ~36 h) is the tail: masked, and labels end there. As a following
    day it counts at its corrected rate (rate / complete) while at least half complete, so its raw low rate cannot pass
    an earlier dip off as a lasting level. Judged on rates alone most of it would pass (rate > 25 % of back)."""
    start = 1_792_000_800
    end = start + 10 * 86400 - 1
    hours = np.arange(start, end, 3600)
    lag = lagged_hist(40)
    share = derive.tail_completeness(lag, end, hours)
    assert share[0] == 1.0 and share[-1] < 0.05
    assert share[-25] == pytest.approx(24.5 / 40, abs=0.01)  # 24.5 h from mid-hour to the export
    hourly = pd.DataFrame({"h": hours, "n": np.round(100 * share).astype(int)})
    o = derive.outage_hours(hourly, start, end, lag)
    first = start + 10 * 86400 - 36 * 3600  # mid-hour under 36 h before the export: under 90 %
    assert o.loc[o.h >= first, "export_tail"].all() and not o.loc[o.h < first, "export_tail"].any()
    assert o.loc[o.h >= first, "masked"].all() and not o.loc[o.h < first, "masked"].any()
    assert derive.label_end(o, end) == first
    f = o.loc[o.h < first - 86400 + 16 * 3600, "fwd"]  # followed by tail hours >= 50 % complete, or by complete ones
    assert f.notna().all() and np.allclose(f, 100, atol=2)
    assert o.loc[(o.h >= first - 86400 + 16 * 3600) & (o.h < first), "fwd"].isna().all()  # only < 50 % tail follows
    # a dip on the day before the tail is masked: its following day is the tail, scaled back up
    dip = hourly.copy()
    dip.loc[(dip.h >= first - 86400) & (dip.h < first - 86400 + 6 * 3600), "n"] = 10
    od = derive.outage_hours(dip, start, end, lag)
    assert od.loc[(od.h >= first - 86400) & (od.h < first - 86400 + 6 * 3600), "masked"].all()
    old = derive.outage_hours(hourly, start, end)  # without the insert lags: the tail hours at >= half pass
    assert not old.loc[(old.h >= first) & (share >= 0.5), "masked"].any()
    assert derive.label_end(old, end) == end
    # too few reference swaps: no estimate, every hour complete
    assert (derive.tail_completeness(lag.head(5), end, hours) == 1).all()


def test_insert_lag_histogram():
    rows = [swap(1, O, 100, "buy", 0.01, 0.1), swap(2, O, 4000, "buy", 0.01, 0.1),
            swap(3, O, 130, "buy", 0.01, 0.1, mint="MintB"),  # stored after t = 4000: 3870 s late -> 64 min
            swap(4, O, 4100, "buy", 0.01, 0.1), swap(5, O, 9000, "buy", 0.01, 0.1)]
    con = con_with(pd.DataFrame(rows))
    con.execute(f"CREATE TEMP TABLE steps AS {derive.ins_steps_sql('SELECT * FROM swaps_df')}")
    h = con.execute(derive.insert_lag_sql("SELECT * FROM swaps_df", "steps", BASE, BASE + 5000)).df()
    assert dict(zip(h.lag_min, h.n)) == {0: 3, 64: 1}  # t = 9000 is outside the window


def test_build_with_a_lagged_export_tail(tmp_path):
    """Six days of swaps stored 0-40 h after their block time, exported before the last ones arrived: the build
    finds the tail, masks it, and censors every label that reaches into it."""
    rng = np.random.default_rng(11)
    start = BASE - BASE % 86400
    t = np.sort(rng.choice(np.arange(0, 6 * 86400), size=6000, replace=False))
    lag = rng.uniform(0, 40 * 3600, size=len(t)).astype(np.int64)
    export_t = 6 * 86400
    keep = t + lag <= export_t
    t, lag = t[keep], lag[keep]
    order = np.argsort(t + lag, kind="stable")  # ids in insert order
    price = 0.01 * np.exp(np.cumsum(rng.normal(0, 0.02, size=len(t))))
    rows = []
    for i, j in enumerate(order):
        r = swap(i + 1, L if j % 4 == 0 else O, int(t[j]) + start - BASE, "buy" if j % 3 else "sell", float(price[j]), 0.2,
                 mint=f"MintL{j % 3}")
        rows.append(r)
    root = tmp_path
    write_parquet(pd.DataFrame(rows), root / "export" / "wallet_swaps" / "part-1.parquet")
    write_parquet(pd.DataFrame({"address": [L], "first_seen_at": [pd.Timestamp(start, unit="s", tz="UTC")]}),
                  root / "export" / "wallets" / "part-1.parquet")
    meta = derive.build(root, n_buckets=2)
    end, lab = meta["data_end_t"], meta["label_end_t"]
    assert end - 40 * 3600 < lab < end - 30 * 3600 and lab % 3600 == 0
    con = loaders.connect(root)
    o = con.execute("SELECT min(epoch(hour))::BIGINT, bool_and(export_tail) FROM outage_hours WHERE export_tail").fetchone()
    assert o == (lab, True)
    e = con.execute("""SELECT epoch(ts)::BIGINT AS t, epoch(entry_ts_15)::BIGINT AS t0, censored_24h, crosses_outage,
                              ret_1h, ret_24h FROM episodes WHERE entry_ts_15 IS NOT NULL""").df()
    assert (e.censored_24h == (e.t0 + 86400 > lab)).all()
    assert e.loc[e.censored_24h, "ret_24h"].isna().all() and e.loc[~e.censored_24h, "ret_24h"].notna().any()
    assert e.loc[e.t0 + 3600 > lab, "ret_1h"].isna().all()
    assert (e.crosses_outage == (e.t + 86400 >= lab)).all()
