"""brain.features.build: the vectorised offline build reproduces the reference (entry.entry_raw on the server state that
cases.offline_case rebuilds) for every episode of random synthetic tapes with real-time and backfilled inserts, and the
ledger rows match a literal swap-by-swap port of ledger.ts."""
from __future__ import annotations

import math

import duckdb
import numpy as np
import pandas as pd
import pytest

from brain.data import derive
from brain.features import build, cases, intervals, prices, spec
from brain.features import entry as fe

BASE = 1_792_800_000  # 2026-10-25 UTC-ish, an epoch second
DAY = 86_400
LEADERS = [f"Lead{i}" for i in range(6)]
OTHERS = [f"Oth{i}" for i in range(10)]
MINTS = [f"Mint{i}pump" if i % 2 else f"Mint{i}" for i in range(8)]
VENUES = ["pumpswap", "pumpfun", "pumpswap (via bot)", "meteora damm v2", "raydium", "orca (via bot)", None, "jupiter"]


def synthetic(seed: int, backfill_share: float = 0.3) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Random tapes over ~9 days: bursts of trading per mint, leaders buying and flipping, a rug, price glitches, and a
    mix of real-time inserts (0-2 s) and wallet-history backfills (hours to days later)."""
    rng = np.random.default_rng(seed)
    rows = []
    for mi, mint in enumerate(MINTS):
        venue = VENUES[mi]
        start = BASE + int(rng.integers(0, 3 * DAY))
        p = float(10 ** rng.uniform(-8, -3))
        t = start
        if mi % 2:  # a leader's buy is the coin's first sighting
            rows.append((LEADERS[mi % len(LEADERS)], mint, "buy", t, p, 0.3, venue))
        for burst in range(int(rng.integers(2, 6))):
            t += int(rng.choice([30, 600, 3_600, 5 * 3_600, 2 * DAY]))
            for _ in range(int(rng.integers(5, 40))):
                t += int(rng.integers(0, 40))
                p *= float(np.exp(rng.normal(0, 0.15)))
                if rng.random() < 0.03:
                    p *= 0.05  # a rug-like drop
                wallet = rng.choice(LEADERS + OTHERS)
                side = "buy" if rng.random() < 0.6 else "sell"
                sol = float(rng.choice([0.0005, 0.03, 0.06, 0.1, 0.25, 0.5, 1.2]))
                price = p * (30.0 if rng.random() < 0.02 else 1.0)  # unit glitch
                rows.append((wallet, mint, side, t, price, sol, venue))
                if wallet in LEADERS and side == "buy" and rng.random() < 0.5:  # the leader flips it
                    rows.append((wallet, mint, "sell", t + int(rng.integers(0, 90)), p * 1.02, sol * 0.9, venue))
    df = pd.DataFrame(rows, columns=["wallet", "mint", "side", "t", "price_sol", "sol_amount", "venue"])
    # insert order: real-time rows land 0-2 s after ts, a backfilled mint-wallet pair lands in one batch much later
    backfill = {(w, m): rng.random() < backfill_share for w, m in sorted(set(zip(df.wallet, df.mint)))}
    later = {(w, m): int(rng.choice([3_600, 6 * 3_600, 2 * DAY, 8 * DAY])) for w, m in sorted(backfill)}
    lag = [later[(w, m)] if backfill[(w, m)] else (int(rng.integers(0, 3)) if backfill_share else 0) for w, m in zip(df.wallet, df.mint)]
    df["ins"] = df["t"] + np.array(lag) + (rng.random(len(df)) if backfill_share else 0.0)
    df = df.sort_values("ins", kind="stable").reset_index(drop=True)
    df["id"] = np.arange(1, len(df) + 1)
    df["signature"] = [f"sig{i}" for i in df["id"]]
    df["slot"] = df["t"]
    df["ts"] = pd.to_datetime(df["t"], unit="s", utc=True)
    df["token_amount"] = df["sol_amount"] / df["price_sol"]
    df["token_balance_before"] = np.where(rng.random(len(df)) < 0.9, rng.uniform(0, 5e5, len(df)), -1.0)
    df["fee_lamports"] = np.where(rng.random(len(df)) < 0.95, rng.integers(5_000, 2_000_000, len(df)), -1)
    for c in ("jito_tip", "token_age_sec", "quote", "quote_amount", "sol_usd", "usd_amount"):
        df[c] = None
    creators = ["CreA", "CreA", "CreB", None, "CreA", "", "CreB", "CreC"]
    ti = pd.DataFrame({
        "mint": MINTS, "creator": creators,
        "pool_created_at": [BASE - 3_600 * i if i % 3 else np.nan for i in range(len(MINTS))],
        "launch_checked_at": [BASE + DAY * (i % 4) if i % 3 else np.nan for i in range(len(MINTS))],
    })
    return df.drop(columns=["t", "ins"]), ti


def run_build(df: pd.DataFrame, ti: pd.DataFrame, lag: int = 1):
    con = duckdb.connect()
    con.execute("SET TimeZone='UTC'")
    con.register("swaps_df", df.assign(_src=0))
    derive.prepare_swaps(con, "SELECT * FROM swaps_df")
    sw = build.bucket_swaps(con, ("venue", "fee_lamports", "token_balance_before"))
    pool = set(LEADERS)
    e = sw[(sw["side"] == "buy") & sw["wallet"].isin(pool) & (sw["sol"] >= 0.05)].copy()
    e["leader_pos_tokens"] = np.maximum(e["token_balance_before"].fillna(0), 0) + e["tokens"].fillna(0)
    e.loc[e["token_balance_before"] < 0, "leader_pos_tokens"] = -1.0  # unknown holding (the stream gave no balance)
    eps = pd.DataFrame({"episode_id": e["id"].to_numpy(), "leader": e["wallet"].to_numpy(), "mint": e["mint"].to_numpy(),
                        "T": e["t"].to_numpy(), "sol": e["sol"].to_numpy(), "leader_pos_tokens": e["leader_pos_tokens"].to_numpy()})
    mf, mints, ledger = build.mint_stage(sw, eps[["episode_id", "leader_pos_tokens"]], lag)
    lsw = sw[sw["wallet"].isin(pool)][["wallet", "mint", "side", "t", "a", "sol"]]
    lf = build.leader_stage(lsw, eps[["episode_id", "leader", "T", "sol"]], ledger, lag)
    cf = build.creator_stage(eps[["episode_id", "mint", "T"]], mints, ti, lag)
    hp = build.hourly_pairs(sw)
    counts = hp.groupby("h")["wallet"].nunique()
    hourly = build.active_hours(counts, np.arange(counts.index.min() - 3_600, counts.index.max() + 1, 3_600))
    base = eps.rename(columns={"sol": "leader_sol"}).merge(
        sw[["id", "price", "venue", "fee_lamports", "a"]].rename(columns={"id": "episode_id", "price": "leader_price_sol", "a": "ins_t"}), on="episode_id")
    base["ts"] = pd.to_datetime(base["T"], unit="s", utc=True)
    base["period"] = "fit"
    base["known_at_t"] = True
    base["crosses_outage"] = False
    for f in (mf, lf, cf):
        base = base.merge(f, on="episode_id", how="left")
    rows = build.assemble(base, hourly, lag)
    return sw, eps, ledger, hourly, rows


def same(a, b, tol=1e-9) -> bool:
    if isinstance(a, str) or isinstance(b, str) or a is None or b is None:
        return a == b
    if math.isnan(a) or math.isnan(b):
        return math.isnan(a) and math.isnan(b)
    return abs(a - b) <= tol * max(1.0, abs(a), abs(b))


@pytest.mark.parametrize("seed", [1, 2, 3])
def test_bulk_build_matches_the_reference_for_every_episode(seed):
    df, ti = synthetic(seed)
    sw, eps, ledger, hourly, rows = run_build(df, ti)
    assert len(rows) == len(eps) > 50
    rows = rows.set_index("episode_id")
    bad = []
    for ep in eps.itertuples():
        case = cases.offline_case(sw, ep.episode_id, ep.leader_pos_tokens, ledger, ti, hourly)
        raw = fe.entry_raw(case)
        g = fe.gate(case, raw)
        r = rows.loc[ep.episode_id]
        for name in build.FEATURE_COLUMNS:
            if not same(raw[name], r[name]):
                bad.append((ep.episode_id, name, raw[name], r[name]))
        if g != (None if pd.isna(r["gate"]) else r["gate"]):
            bad.append((ep.episode_id, "gate", g, r["gate"]))
    assert not bad, bad[:20]
    # the synthetic tapes exercise what the features are about
    assert rows["mint_first_seen_age_min"].isna().any() and rows["mint_first_seen_age_min"].notna().any()
    assert (rows["cp_n_7d"] > 0).any() and rows["ps_r_7d"].notna().any() and rows["dd_rate_7d"].notna().any()
    assert (rows["m_buyers_5m"] > 0).any() and rows["dd_from_high"].notna().any() and rows["cr_seen_prior_7d"].notna().any()
    assert (rows["lf_flip60_7d"] > 0).any() and (rows["b_n_24h"] > 0).any() and rows["log_token_age"].notna().any()
    assert set(rows["gate"].dropna()) >= {"below_min_leader_buy", "young_amm"}
    aw = rows["tracked_active_wallets_1h"]
    assert aw.isna().any() and (aw.dropna() > 0).all()  # an empty previous hour is missing, never 0


def test_leader_sold_at_decision_counts_same_second_sells_already_stored():
    """A 1 s decision lag sees the leader's sells in the buy's own second that were stored in that second."""
    L, O = "Lead0", "Oth1"
    rows = [
        (1, L, "buy", BASE, BASE, 0.5, 100.0),
        (2, L, "sell", BASE, BASE, 0.1, 30.0),  # same second, stored then: counts
        (3, L, "sell", BASE, BASE + 5, 0.1, 20.0),  # same second, stored 5 s later: not yet
        (4, O, "sell", BASE, BASE, 0.1, 50.0),  # someone else
        (5, L, "sell", BASE + 1, BASE + 1, 0.1, 40.0),  # the next second: after t
    ]
    df = pd.DataFrame(rows, columns=["id", "wallet", "side", "t", "a", "sol", "tokens"])
    df["mint"], df["okey"], df["price"], df["ok"] = "M", df["t"] * 1_000_000 + df["id"], 0.01, True
    feats, _, _ = build.mint_stage(df, pd.DataFrame({"episode_id": [1], "leader_pos_tokens": [200.0]}))
    assert feats["leader_sold_at_decision"].iloc[0] == pytest.approx(30.0 / 200.0)


# ---------------------------------------------------------------------------------------------------------------------
# Ledger rows against a literal port of ledger.ts (one swap at a time, in order)


def mirror_ref(m: pd.DataFrame, e) -> tuple[float, float] | None:
    """(y, resolved_at) of one copy-eligible buy, stepping through the mint's later swaps like MirrorLedger.step."""
    T, leader = e.t, e.wallet
    entry = lsell = None
    later = m[m["okey"] > e.okey]
    for s in later.itertuples():
        if s.wallet == leader and s.side == "sell" and lsell is None and s.t <= T + build.HOLD:
            lsell = s
        if not s.ok:
            continue
        if entry is None:
            if s.t > T + build.ENTRY_TO:
                return None
            if s.wallet != leader and s.t >= T + build.ENTRY_FROM:
                entry = s
            continue
        if s.t <= entry.t:
            continue
        if s.t >= T + build.HOLD:
            if s.t <= T + build.HOLD + build.GROUNDED:
                return s.price / entry.price - 1 - build.MIRROR_COST, max(s.a, e.a, entry.a)
            break
        if s.price <= entry.price * (1 + build.MIRROR_STOP):
            return s.price / entry.price - 1 - build.MIRROR_COST, max(s.a, e.a, entry.a)
        if lsell is not None and s.wallet != leader and s.side == "sell" and s.t >= max(lsell.t + build.EXIT_AFTER_SELL, entry.t + 1):
            return s.price / entry.price - 1 - build.MIRROR_COST, max(s.a, e.a, entry.a, lsell.a)
    if entry is None:
        return None
    return -1.0, max(T + build.HOLD + build.GROUNDED, e.a, entry.a)


def ps_ref(m: pd.DataFrame, e) -> tuple[float | None, float] | None:
    """(r, avail_at) like MirrorLedger.postSellReturn on the leader's first sell after the buy (None: no row)."""
    sells = m[(m["okey"] > e.okey) & (m["wallet"] == e.wallet) & (m["side"] == "sell")]
    if not len(sells) or sells["t"].iloc[0] > e.t + build.HOLD:
        return None
    s = sells.iloc[0]
    sm = s.t // 60 * 60
    end = sm + build.PS_AVAIL
    ok = m[m["ok"] & (m["t"] >= sm) & (m["t"] < end)]
    if not len(ok):
        return -1.0, max(end, e.a, s.a)
    bar = next((x for x in (sm, sm + 60, sm + 120) if ((ok["t"] >= x) & (ok["t"] < x + 60)).any()), None)
    if bar is None:
        return "drop"
    close = ok[(ok["t"] >= bar) & (ok["t"] < bar + 60)].iloc[-1]
    after = ok[ok["t"] >= bar + 60]
    if not len(after):
        return -1.0, max(end, e.a, s.a, close.a)
    last = after.iloc[-1]
    return min(max(last.price / close.price - 1, -1.0), 10.0), max(end, e.a, s.a, close.a, last.a)


@pytest.mark.parametrize("seed", [4, 5])
def test_ledger_rows_match_a_literal_port_of_ledger_ts(seed):
    df, ti = synthetic(seed)
    sw, eps, ledger, _, _ = run_build(df, ti)
    sw = sw.sort_values(["mint", "okey"]).reset_index(drop=True)
    by_id = sw.set_index("id")
    eligible = eps[eps["sol"] >= fe.MIN_LEADER_BUY_SOL].reset_index(drop=True)
    _, _, led = build.mint_stage(sw, eps[["episode_id", "leader_pos_tokens"]])
    groups = {m: g for m, g in sw.groupby("mint", sort=False)}
    mirror = led[led["kind"] == build.KIND_MIRROR].reset_index(drop=True)
    ps = led[led["kind"] == build.KIND_PS].reset_index(drop=True)
    want_m, want_p = [], []
    for ep in eligible.itertuples():
        e = by_id.loc[ep.episode_id]
        row = pd.Series({"t": e.t, "wallet": e.wallet, "okey": e.okey, "a": e.a})
        r = mirror_ref(groups[e.mint], row)
        if r is not None:
            want_m.append((ep.leader, r[0], r[1]))
        p = ps_ref(groups[e.mint], row)
        if p is not None and p != "drop":
            want_p.append((ep.leader, p[0], p[1]))
    got_m = sorted(zip(mirror["leader"], mirror["v"].round(9), mirror["at"]))
    got_p = sorted(zip(ps["leader"], ps["v"].round(9), ps["at"]))
    assert got_m == sorted((a, round(b, 9), int(c)) for a, b, c in want_m)
    assert got_p == sorted((a, round(b, 9), int(c)) for a, b, c in want_p)
    assert len(want_m) > 5 and len(want_p) > 5
    dd = led[led["kind"] == build.KIND_DD]
    assert len(dd) == len(eligible)


def test_mirror_follows_the_leader_out_and_writes_off_dead_coins():
    """Hand-made: entry by another wallet at +20 s, leader sells at +100 s, exit = next non-leader sell from +115 s."""
    L, O1, O2 = "Lead0", "Oth1", "Oth2"
    t0 = BASE
    rows = [
        (1, L, "buy", t0, 1.0, 0.5),
        (2, O1, "buy", t0 + 20, 1.1, 0.1),   # entry 1.1
        (3, L, "sell", t0 + 100, 1.2, 0.4),  # leader's first sell
        (4, O2, "sell", t0 + 110, 1.3, 0.1),  # too early (before sell + 15 s)
        (5, O1, "buy", t0 + 120, 1.4, 0.1),  # a buy: not an exit
        (6, O2, "sell", t0 + 130, 1.5, 0.1),  # the exit
    ]
    df = pd.DataFrame(rows, columns=["id", "wallet", "side", "t", "price", "sol"])
    df["mint"], df["okey"], df["a"], df["ok"], df["tokens"] = "M", df["t"] * 1_000_000, df["t"], True, 1.0
    eps = pd.DataFrame({"episode_id": [1], "leader_pos_tokens": [1.0]})
    _, _, led = build.mint_stage(df, eps)
    m = led[led["kind"] == build.KIND_MIRROR].iloc[0]
    assert m["v"] == pytest.approx(1.5 / 1.1 - 1 - 0.026) and m["at"] == t0 + 130
    # same tape, but nothing trades after the entry: dead at buy + 30 h, y = -1
    _, _, led = build.mint_stage(df[df["id"] <= 2], eps)
    m = led[led["kind"] == build.KIND_MIRROR].iloc[0]
    assert m["v"] == -1.0 and m["at"] == t0 + 30 * 3_600
    d = led[led["kind"] == build.KIND_DD].iloc[0]
    assert d["v"] == 1.0 and d["at"] == t0 + 7_215


def test_interval_helpers_against_brute_force():
    rng = np.random.default_rng(0)
    v = rng.random(700)
    lo = rng.integers(0, 700, 3000)
    hi = np.minimum(700, lo + rng.integers(0, 300, 3000))
    assert np.array_equal(intervals.range_min(v, lo, hi), [v[a:b].min() if b > a else np.inf for a, b in zip(lo, hi)])
    lv = rng.random(3000) * 0.05

    def first(a, b, x):
        return next((j for j in range(a, b) if v[j] <= x), -1)

    assert np.array_equal(intervals.first_le(v, lo, hi, lv), [first(a, b, x) for a, b, x in zip(lo, hi, lv)])
    g, s = rng.integers(0, 9, 2000), rng.integers(0, 500, 2000)
    e = s + rng.integers(-5, 120, 2000)
    w = rng.random(2000)
    qg, qt = rng.integers(0, 9, 1500), rng.integers(0, 700, 1500)
    act = [(g == a) & (s < t) & (t <= e) for a, t in zip(qg, qt)]
    assert np.allclose(intervals.stab(g, s, e, qg, qt, w), [w[x].sum() for x in act])
    G, S_, E_ = intervals.islands(g, s, e)
    assert np.array_equal(intervals.stab(G, S_, E_, qg, qt), [float(x.any()) for x in act])
    assert np.allclose(intervals.stab_max(g, s, e, w, qg, qt), [w[x].max() if x.any() else np.nan for x in act], equal_nan=True)


def test_norm_comes_from_present_values_and_binary_columns_stay_0_1():
    feats = [spec.Feature("a", "entry", "log1p", True, "train_mean"), spec.Feature("v", "entry", "onehot", False, "missing")]
    cats = {"v": ["x", "missing", "other"]}
    raw = pd.DataFrame({"a": [0.0, np.e - 1, np.nan, 3.0], "v": ["x", "missing", "y", None]})
    X = spec.encode(raw, feats, cats)
    cols = spec.columns(feats, cats)
    assert cols == ["a", "a_missing", "v=x", "v=missing", "v=other"]
    norm = spec.fit_norm(X, cols)
    present = np.log1p([0.0, np.e - 1, 3.0])
    assert norm.mean[0] == pytest.approx(present.mean()) and norm.std[0] == pytest.approx(present.std())
    assert list(norm.mean[1:]) == [0, 0, 0, 0] and list(norm.std[1:]) == [1, 1, 1, 1]
    Z = spec.normalise(X, norm)
    assert Z[2, 0] == 0.0 and Z[2, 1] == 1.0  # missing: the mean, flagged
    assert list(Z[2, 2:]) == [0, 0, 1] and list(Z[3, 2:]) == [0, 1, 0]  # unseen level -> other; None -> 'missing'
    assert spec.fit_levels({"pumpswap": 9000, "pumpfun_curve": 990, "rare": 1}) == ["pumpswap", "pumpfun_curve", "other"]


@pytest.mark.parametrize("seed", [1, 2, 3, 7])
def test_coin_and_leader_features_do_not_see_swaps_stored_after_t(seed):
    """On a tape with backfills, deleting every swap stored at or after t leaves the features of an episode stored
    before t unchanged: the ok flags too (an earlier-ts swap backfilled after t must not flip the flag of a swap the
    server had). The ledger features are left out: an outcome that was knowable before t is the same, but a row's
    eventual value can differ from what a server would have written at its deadline when its deciding swap was stored
    late; tracked_active_wallets_1h reads the hourly table of the whole tape."""
    df, ti = synthetic(seed, backfill_share=0.3)
    sw, eps, _, _, rows = run_build(df, ti)
    rows = rows.set_index("episode_id")
    keep = [c for c in build.FEATURE_COLUMNS if c not in ("cp_lrshr_7d", "cp_n_7d", "cp_win_7d", "ps_r_7d", "dd_rate_7d", "tracked_active_wallets_1h")]
    e = eps.merge(sw[["id", "a"]], left_on="episode_id", right_on="id")
    in_time = e.loc[e["a"] < e["T"] + 1, "episode_id"].to_numpy()
    assert len(in_time) >= 12
    rng = np.random.default_rng(seed)
    for eid in rng.choice(in_time, 12, replace=False):
        t = int(sw.loc[sw["id"] == eid, "t"].iloc[0]) + 1
        cut_ids = set(sw.loc[sw["a"] < t, "id"])
        assert eid in cut_ids
        _, _, _, _, cut = run_build(df[df["id"].isin(cut_ids)], ti)
        a, b = rows.loc[eid, keep], cut.set_index("episode_id").loc[eid, keep]
        assert all(same(x, y) for x, y in zip(a, b)), (eid, [(k, x, y) for k, x, y in zip(keep, a, b) if not same(x, y)])


def test_ok_flags_follow_arrival_order_not_block_time():
    """bucket_swaps feeds the trailing filter in insert order: three low prints with earlier ts, backfilled hours later,
    leave the flag of a print the server already had as it was (derive's ts-ordered ok rejects it in hindsight)."""
    rows = [  # (id, wallet, t, price); ids are the insert order
        (1, "A", 0, 1e-6), (2, "B", 10, 1e-6), (3, "X", 30, 5e-6),  # real time: X is within 10x of the median of A, B
        (4, "D", 20, 3e-7), (5, "E", 21, 3e-7), (6, "F", 22, 3e-7),  # backfilled: ts before X, stored after it
    ]
    df = pd.DataFrame(rows, columns=["id", "wallet", "t", "price_sol"])
    df["mint"], df["side"], df["sol_amount"], df["slot"], df["_src"] = "M", "buy", 0.1, df["t"], 0
    df["token_amount"] = df["sol_amount"] / df["price_sol"]
    df["signature"] = [f"s{i}" for i in df["id"]]
    df["ts"] = pd.to_datetime(BASE + df["t"], unit="s", utc=True)
    con = duckdb.connect()
    con.execute("SET TimeZone='UTC'")
    con.register("swaps_df", df.drop(columns="t"))
    derive.prepare_swaps(con, "SELECT * FROM swaps_df")
    sw = build.bucket_swaps(con).sort_values("id")
    assert sw["ok"].tolist() == prices.ok_flags([{"wallet": r.wallet, "price": r.price_sol, "sol": r.sol_amount, "tokens": r.token_amount}
                                                 for r in df.itertuples()])
    assert sw.set_index("id").loc[3, "ok"]
    derive.build_prices(con)  # `sw` is left as it was: derive's ts-ordered flag sees D, E, F before X
    hind = con.execute("SELECT s.id, p.ok FROM sw s JOIN px p USING (mint, okey)").df().set_index("id")["ok"]
    assert not hind.loc[3]
    assert sorted(sw["okey"]) == sorted(con.execute("SELECT okey FROM sw").df()["okey"])  # block-time okey kept


def test_swap_features_of_an_empty_chunk():
    """A day with no episodes in the built buckets (a partial build) assembles to an empty frame, not a dtype error."""
    base = pd.DataFrame({"T": pd.Series(dtype=np.int64), "leader_sol": pd.Series(dtype=float), "leader_price_sol": pd.Series(dtype=float),
                         "venue": pd.Series(dtype=object), "fee_lamports": pd.Series(dtype=float), "mint": pd.Series(dtype=object),
                         "mint_first_seen_age_min": pd.Series(dtype=float)})
    out = build.swap_features(base, pd.Series([5.0], index=[BASE // 3_600 * 3_600]))
    assert len(out) == 0 and "gate" in out and "tracked_active_wallets_1h" in out


def test_gate_column_is_a_string_even_when_no_gate_fires(tmp_path):
    df, ti = synthetic(1)
    *_, rows = run_build(df, ti)
    passed = rows[rows["gate"].isna()].head(5)
    build._write(passed, tmp_path / "x.parquet")
    import pyarrow.parquet as pq
    assert str(pq.read_schema(tmp_path / "x.parquet").field("gate").type) in ("string", "large_string")


def test_fit_meta_takes_levels_and_norm_from_fit_training_rows_only(tmp_path):
    df, ti = synthetic(2)
    *_, rows = run_build(df, ti)
    rows = rows.copy()
    rows.loc[rows.index[::2], "period"] = "selection"  # half the rows are not fit: they must not move the norm
    rows.loc[rows.index[1::4], "known_at_t"] = False
    rows["day"] = pd.to_datetime(rows["ts"]).dt.strftime("%Y-%m-%d")
    for d, g in rows.groupby("day"):
        build._write(g.drop(columns="day"), tmp_path / f"day={d}" / "part-00.parquet")
    meta = build.fit_meta(duckdb.connect(), tmp_path)
    train = rows[(rows["period"] == "fit") & rows["known_at_t"] & ~rows["crosses_outage"] & rows["gate"].isna()]
    assert meta["n_train_rows"] == len(train) > 0
    assert meta["categories"]["venue_group"] == spec.fit_levels(train["venue_group"].value_counts().to_dict())
    feats = spec.entry_features()
    want = spec.fit_norm(spec.encode(train, feats, meta["categories"]), meta["columns"], spec.binary_columns(feats, meta["categories"]))
    assert np.allclose(meta["norm"]["mean"], want.mean) and np.allclose(meta["norm"]["std"], want.std)
    assert sum(meta["gates"]["counts"].values()) == len(rows)
    Z = build.matrix(train, meta)
    assert Z.shape == (len(train), len(meta["columns"])) and Z.dtype == np.float32 and np.isfinite(Z).all()


def test_a_column_constant_in_training_keeps_its_raw_scale():
    """social_missing is 1 on every historical row: live, a 0 must move the input by 1, not by a million."""
    feats = [spec.Feature("social_missing", "entry", "none", False, 1.0), spec.Feature("x", "entry", "none", False, 0.0)]
    X = spec.encode(pd.DataFrame({"social_missing": [1.0, 1.0, 1.0], "x": [0.0, 1.0, 2.0]}), feats)
    norm = spec.fit_norm(X, ["social_missing", "x"], set())
    assert norm.mean[0] == 1.0 and norm.std[0] == 1.0 and norm.std[1] == pytest.approx(np.std([0, 1, 2]))
    assert spec.normalise(spec.encode({"social_missing": 0.0, "x": 1.0}, feats), norm)[0, 0] == -1.0
