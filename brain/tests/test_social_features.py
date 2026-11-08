"""brain.social.features: the social inputs at time t, point in time, against golden.json (which the TypeScript scorer
reproduces too) and a few hand-checked rules."""
from __future__ import annotations

import json
import math

import pandas as pd
import pytest

from brain.social import golden
from brain.social.data import social_frames, to_sec
from brain.social.features import (DAY, TRANSFORMS, SocialTables, build_index, feature_names, fill_values, load_spec,
                                   median, owner_accounts, primary_account, raw_inputs, transform, transformed, vector)


def test_spec_matches_the_code():
    version, spec = load_spec()
    assert version >= 1
    assert {s.name: s.transform for s in spec} == TRANSFORMS, "features.yaml social.inputs and features.py disagree"
    names = feature_names(spec)
    assert len(names) == len(set(names))
    assert "own_record_shrunk" in names and "accounts_per_wallet_missing" not in names


def test_golden_file_is_up_to_date():
    on_disk = json.loads(golden.GOLDEN.read_text())
    assert on_disk == json.loads(json.dumps(golden.build())), "run python -m brain.social.golden"


def test_golden_hand_checked_values():
    g = json.loads(golden.GOLDEN.read_text())
    names, exp = g["features"], g["expected"]
    w1 = dict(zip(names, exp["GoldW1aaaa"]["vector"]))
    assert w1["ca_share_30d"] == pytest.approx(5 / 6)  # 6 posts in the window read before t, 5 name a coin
    assert w1["buy_before_call_share_30d"] == pytest.approx(2 / 3)  # lags +30, -120, +10 min
    assert w1["median_call_lag_min"] == pytest.approx(math.log1p(10))
    assert w1["engagement_med_30d"] == pytest.approx(math.log1p(4))
    assert w1["follower_growth_7d"] == pytest.approx(math.log(151 / 101))
    assert w1["post_rate_7d"] == pytest.approx(math.log1p(40 / 8))
    assert w1["funder_cluster_size"] == pytest.approx(math.log1p(2))  # X2's funder filled and X3 seen only after t
    assert w1["own_record_shrunk"] == pytest.approx((0.5 - 0.6 + 0.1 + 0.3 + 18 * -0.08) / (4 + 18))  # M1 bought twice: both rows
    assert exp["GoldW1aaaa"]["n_posts"] == 6
    w3 = dict(zip(names, exp["GoldW3cccc"]["vector"]))
    assert w3["followers_log"] == pytest.approx(math.log1p(900))  # a5 (900) over a4 (500)
    assert w3["post_rate_7d"] == 0.0
    assert w3["buy_before_call_share_30d_missing"] == 1.0  # only 2 pairs
    assert w3["mentioned_by_callers_30d"] == pytest.approx(math.log1p(2))  # a7, a8; a4 owns it, a9 is too old
    assert w3["accounts_per_wallet"] == pytest.approx(math.log1p(2))  # a6's link is known only after t
    w2 = dict(zip(names, exp["GoldW2bbbb"]["vector"]))
    fill = dict(zip([n for n in names if not n.endswith("_missing")], g["fill"]))
    assert w2["followers_log_missing"] == 1.0 and w2["followers_log"] == fill["followers_log"]
    assert w2["own_record_shrunk"] == pytest.approx(-0.08)  # no copies: the population mean
    for w in ("GoldW4dddd", "GoldW5hhhh", "GoldX2ffff", "GoldX3gggg"):
        assert exp[w] is None, f"{w} has no owner-grade link at t"


def _tables(links, snaps=(), posts=()) -> SocialTables:
    t = social_frames({
        "social_wallet_accounts": pd.DataFrame(links, columns=["wallet", "author_id", "how", "first_seen_at"]),
        "social_accounts": pd.DataFrame({"id": [], "created_at": []}),
        "social_account_snapshots": pd.DataFrame(list(snaps), columns=["account_id", "fetched_at", "followers", "tweets"]),
        "social_posts": pd.DataFrame(list(posts), columns=["post_id", "author_id", "ts", "fetched_at", "mints", "wallets"]),
    })
    return t


def test_tracker_mentions_are_not_owner_grade_but_its_bio_links_are():
    links = [("w1", "trk", "mention", 0), ("w2", "trk", "mention", 0), ("w3", "trk", "mention", 0), ("w4", "trk", "mention", 0),
             ("w5", "trk", "bio", 0)]
    ix = build_index(_tables(links))
    assert owner_accounts(ix, "w1", 10.0) == []
    assert owner_accounts(ix, "w5", 10.0) == ["trk"]
    # before its 4th and 5th wallets were linked, trk was not yet a tracker
    links[3] = ("w4", "trk", "mention", 100)
    links[4] = ("w5", "trk", "bio", 100)
    ix = build_index(_tables(links))
    assert owner_accounts(ix, "w1", 50.0) == ["trk"]
    assert owner_accounts(ix, "w1", 101.0) == []


def test_primary_account_uses_followers_known_before_t_then_the_lowest_id():
    links = [("w", "b", "bio", 0), ("w", "a", "bio", 0)]
    snaps = [("a", 10, 100, 0), ("b", 10, 100, 0), ("b", 50, 5000, 0)]
    ix = build_index(_tables(links, snaps))
    assert primary_account(ix, ["a", "b"], 20.0) == "a"  # a tie: lowest id
    assert primary_account(ix, ["a", "b"], 60.0) == "b"


def test_posts_read_after_t_are_invisible():
    links = [("w", "a", "bio", 0)]
    t = 40 * DAY
    posts = [("p1", "a", 39 * DAY, 39.5 * DAY, '["m1"]', "[]"), ("p2", "a", 39 * DAY, 41 * DAY, "[]", "[]")]
    raw, n = raw_inputs(build_index(_tables(links, posts=posts)), "w", t, 0.0)
    assert n == 1 and raw["ca_share_30d"] == 1.0
    assert raw["engagement_med_30d"] is None  # p1 was read 12 h after posting


def test_transforms_fill_and_vector():
    assert transform("clip:-3,3", 7.0) == 3.0
    assert transform("signed_log", -10.0) == pytest.approx(-math.log1p(10))
    assert transform("log1p", -5.0) == 0.0
    assert median([3, 1, 2]) == 2 and median([4, 1, 2, 3]) == 2.5
    _, spec = load_spec()
    rows = [{s.name: None for s in spec}, {s.name: 1.0 for s in spec} | {"acct_age_days": 3.0}]
    fill = fill_values(spec, rows)
    assert fill["acct_age_days"] == 3.0  # train_mean over the rows that have it
    assert fill["follower_growth_7d"] == 0.0  # the spec default
    v = vector(spec, transformed(spec, {s.name: None for s in spec}), fill)
    assert len(v) == len(feature_names(spec))
    assert v[1] == 1.0  # acct_age_days_missing


def test_to_sec_reads_iso_strings_timestamps_and_millis():
    s = to_sec(pd.Series(["2026-11-01T00:00:00.000Z", None, "2026-11-01T00:00:01Z"]))
    assert s.iloc[0] == 1_793_491_200 and math.isnan(s.iloc[1]) and s.iloc[2] == 1_793_491_201
    assert to_sec(pd.Series([1_793_491_200_000])).iloc[0] == 1_793_491_200
    assert to_sec(pd.Series(pd.to_datetime(["2026-11-01"], utc=True))).iloc[0] == 1_793_491_200
