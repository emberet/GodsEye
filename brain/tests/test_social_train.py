"""brain.social.train on synthetic data: no bundle (and exit 0) from a cold start or below the minimum, a full bundle
(social.onnx + manifest.json per CONTRACT.md) that onnxruntime reproduces and brain.push accepts, and the ONE
pre-registered gate test that later runs can't take again. CPU only, small."""
from __future__ import annotations

import json
from datetime import datetime, timezone

import numpy as np
import onnxruntime as ort
import pandas as pd
import pytest

from brain import config, push
from brain.social import data as sdata
from brain.social import train
from brain.social.features import DAY, SocialTables, build_index, feature_names, load_spec, raw_inputs

T0 = 1_796_083_200.0  # 2026-12-01T00:00:00Z


def synthetic(n_wallets: int, days: int = 60, seed: int = 0) -> tuple[SocialTables, pd.DataFrame]:
    """Wallets with one bio-linked account each; a hidden skill sets both the copy outcomes and the follower count."""
    rng = np.random.default_rng(seed)
    links, accounts, snaps, posts, copies = [], [], [], [], []
    for i in range(n_wallets):
        w, a = f"SynW{i:04d}", f"syn{i}"
        skill = rng.normal(0, 0.15)
        links.append((w, a, "bio", T0 - DAY + rng.uniform(0, 3600)))
        accounts.append((a, T0 - rng.uniform(30, 900) * DAY))
        followers = float(np.exp(6 + 8 * skill + rng.normal(0, 0.3)))
        for d in range(0, days, 7):
            snaps.append((a, T0 + d * DAY + 3600, followers * (1 + 0.01 * d), 1000 + 3 * d))
        for d in range(0, days, 2):
            ts = T0 + d * DAY + rng.uniform(0, DAY)
            posts.append((f"p{i}-{d}", a, ts, ts + 2 * DAY, int(rng.integers(0, 50)), 0, 0, 0, [f"m{i}-{d}"] if d % 4 else [], []))
        for d in range(days):
            for _ in range(int(rng.integers(0, 3))):
                b = T0 + d * DAY + rng.uniform(0, DAY)
                copies.append((w, b, skill - 0.05 + rng.normal(0, 0.3), b + 3600))
    t = SocialTables(
        links=pd.DataFrame(links, columns=["wallet", "author_id", "how", "first_seen"]),
        accounts=pd.DataFrame(accounts, columns=["id", "created_at"]),
        snapshots=pd.DataFrame(snaps, columns=["account_id", "fetched", "followers", "tweets"]),
        posts=pd.DataFrame(posts, columns=["post_id", "author_id", "ts", "fetched", "likes", "reposts", "replies", "quotes", "mints", "wallets"]),
        first_buys=pd.DataFrame({"wallet": [], "mint": [], "ts": [], "known_at": []}),
        ledger=pd.DataFrame({"leader": [], "y": [], "resolved_at": []}),
    )
    return t, pd.DataFrame(copies, columns=["leader", "buy_ts", "y", "resolved_at"])


def test_target_needs_five_copies_and_a_matured_window():
    copies = pd.DataFrame({"leader": ["w"] * 6, "buy_ts": [0, 1, 2, 3, 14 * DAY - 1, 14 * DAY], "y": [1, 1, 1, 1, 1, 9.0],
                           "resolved_at": [0] * 6})
    tg = train.targets(copies)
    assert train.y14(tg, "w", 0.0) == (1.0, 5)  # the copy at exactly t + 14 d is outside
    assert train.y14(tg, "w", 2.0) is None  # 4 copies
    links = pd.DataFrame({"first_seen": [0.5 * DAY]})
    days = train.asof_grid(links, 20 * DAY)
    assert days[0] == DAY and days[-1] == 4 * DAY  # matured: t + 14 d + 30 h <= the newest resolution (5 d is 6 h short)
    assert train.asof_grid(links, 20.25 * DAY)[-1] == 5 * DAY


def test_maturity_counts_from_the_newest_resolution_not_the_newest_buy(tmp_path, monkeypatch):
    """The newest buy says nothing about what has resolved: the as-of grid ends at the ledger's newest resolved_at."""
    tables, copies = synthetic(5, days=20)
    ledger = copies.assign(resolved_at=copies.buy_ts + 30 * 3600)
    seen = []
    grid = train.asof_grid
    monkeypatch.setattr(train, "asof_grid", lambda links, end, start=None: seen.append(end) or grid(links, end, start))
    train.train(tables, copies, tmp_path / "models", ledger=ledger, device="cpu")
    assert seen == [ledger.resolved_at.max()]


def test_split_keeps_an_embargo_between_train_and_validation():
    days = [i * DAY for i in range(40)]
    tr, va, emb = train.split_days(days)
    assert emb and va[0] - tr[-1] >= train.EMBARGO and len(va) == 12
    tr, va, emb = train.split_days(days[:10])
    assert not emb and tr and tr[-1] < va[0]


def test_inputs_are_point_in_time():
    tables, copies = synthetic(5, days=20)
    tables.ledger = copies[["leader", "y", "resolved_at"]]
    t = T0 + 9.5 * DAY
    full = raw_inputs(build_index(tables), "SynW0001", t, -0.05)
    cut = SocialTables(
        links=tables.links[tables.links.first_seen < t], accounts=tables.accounts,
        snapshots=tables.snapshots[tables.snapshots.fetched < t], posts=tables.posts[tables.posts.fetched < t],
        first_buys=tables.first_buys, ledger=tables.ledger[tables.ledger.resolved_at < t],
    )
    assert raw_inputs(build_index(cut), "SynW0001", t, -0.05) == full


def test_below_the_minimum_no_bundle(tmp_path, capsys):
    tables, copies = synthetic(40, days=40)
    assert train.train(tables, copies, tmp_path / "models", device="cpu") is None
    assert not (tmp_path / "models").exists() or not any((tmp_path / "models").iterdir())
    out = capsys.readouterr().out
    assert "[social] too little data: 40 owner-linked wallets" in out and "SynW" not in out


def test_cold_start_main_exits_zero_without_a_bundle(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(config, "PRIVATE_DIR", tmp_path / "private")  # nothing pulled: the X tables are empty today
    assert train.main(["--out", str(tmp_path / "models")]) == 0
    assert not (tmp_path / "models").exists()
    assert "no wallet <-> X account links yet" in capsys.readouterr().out


def test_main_below_the_minimum_exits_zero(tmp_path, monkeypatch, capsys):
    tables, copies = synthetic(30, days=40)
    monkeypatch.setattr(sdata, "load_social", lambda: tables)
    monkeypatch.setattr(sdata, "copies", lambda: (copies, copies, "test", float(copies.buy_ts.min())))
    monkeypatch.setattr(sdata, "first_buys", lambda con, pairs: tables.first_buys)
    monkeypatch.setattr(sdata, "funders", lambda con: None)

    class Con:
        def close(self):
            pass

    import brain.data
    monkeypatch.setattr(brain.data, "connect", lambda **kw: Con())
    assert train.main(["--out", str(tmp_path / "models"), "--device", "cpu"]) == 0
    assert "too little data" in capsys.readouterr().out
    assert not (tmp_path / "models").exists() or not any((tmp_path / "models").iterdir())


@pytest.fixture(scope="module")
def first_run(tmp_path_factory):
    """The first run with enough data, on the mirror ledger: it takes the pre-registered test."""
    tables, copies = synthetic(320, days=60, seed=1)
    root = tmp_path_factory.mktemp("social")
    gate_file = root / "private" / train.GATE_FILE
    d = train.train(tables, copies, root / "models", source="mirror_ledger", device="cpu", gate_file=gate_file,
                    now=datetime(2026, 12, 31, 12, tzinfo=timezone.utc))
    return {"bundle": d, "gate_file": gate_file, "root": root, "tables": tables, "copies": copies}


@pytest.fixture(scope="module")
def bundle(first_run):
    return first_run["bundle"]


def test_bundle_matches_the_contract(bundle):
    assert bundle is not None and bundle.name == "2026-12-31T12-00-00Z"
    assert sorted(p.name for p in bundle.iterdir()) == ["manifest.json", "social.onnx"]
    m = json.loads((bundle / "manifest.json").read_text())
    _, spec = load_spec()
    assert m["kind"] == "social" and m["file"] == "social.onnx" and m["input"] == "x" and m["output"] == "y"
    assert m["features"] == feature_names(spec)
    assert len(m["norm"]["mean"]) == len(m["norm"]["std"]) == len(m["features"]) and min(m["norm"]["std"]) > 0
    assert len(m["fill"]) == len(spec)
    assert m["metrics"]["target_source"] == "mirror_ledger" and m["metrics"]["days"]["embargoed"]
    assert {"passed", "spearman", "spearman_ci", "partial_spearman", "partial_spearman_ci", "wallets"} <= set(m["gate"])
    assert m["gate"]["valid"] and m["gate"]["preregistered"] and m["gate"]["looks"] == 1
    assert m["metrics"]["validation_check"] is None  # this run was the test
    assert "entry" not in m
    b = push.validate_bundle(bundle, social=True)  # the push script takes it
    assert b.files["social.onnx"] == m["sha256"]["social.onnx"]


def test_onnx_outputs_the_predicted_return(bundle):
    m = json.loads((bundle / "manifest.json").read_text())
    s = ort.InferenceSession(str(bundle / "social.onnx"), providers=["CPUExecutionProvider"])
    assert [i.name for i in s.get_inputs()] == ["x"] and [o.name for o in s.get_outputs()] == ["y"]
    z = np.zeros((3, len(m["features"])), np.float32)
    y = s.run(["y"], {"x": z})[0]
    assert y.shape == (3, 1)
    assert np.allclose(y, y[0]) and abs(float(y[0, 0]) - m["pop_mean"]) < 1.0  # a 14-day return, around the population mean


def test_learns_the_planted_signal(bundle):
    m = json.loads((bundle / "manifest.json").read_text())
    assert m["gate"]["spearman"] > 0.3, m["gate"]  # followers carry the skill that sets the copy outcomes
    assert m["metrics"]["rmse"]["validation"] < m["metrics"]["rmse"]["validation_pop_mean"]


def test_copies_keep_only_what_the_server_could_have_copied(tmp_path):
    """known_at_t: a buy made before the server knew the leader (or by a wallet it never knew) is not a copy outcome."""
    (tmp_path / "research" / "social").mkdir(parents=True)
    (tmp_path / "export" / "wallets").mkdir(parents=True)
    pd.DataFrame({"leader": ["w1", "w1", "w2", "w3"], "t": [100, 300, 500, 700], "net": [0.1, 0.2, 0.3, 0.4],
                  "exit_min": [1, 5, 60, 1440]}).to_parquet(tmp_path / "research" / "social" / "eligible.parquet")
    pd.DataFrame({"address": ["w1", "w2"], "first_seen_at": pd.to_datetime([200, 400], unit="s", utc=True)}).to_parquet(
        tmp_path / "export" / "wallets" / "all.parquet")
    df, ledger, source, start = sdata.copies(tmp_path)
    assert source == "research_reference" and start == 300.0
    assert ledger is df  # one row per (leader, mint) there: the only rows it has
    assert df[["leader", "buy_ts", "y"]].to_dict("records") == [{"leader": "w1", "buy_ts": 300.0, "y": pytest.approx(0.2)},
                                                               {"leader": "w2", "buy_ts": 500.0, "y": pytest.approx(0.3)}]
    assert df.resolved_at.tolist() == [300 + 15 + 5 * 60, 500 + 15 + 60 * 60]
    assert len(sdata.known_at_t(df, None)) == 2  # no wallets export: unfiltered


def test_target_takes_first_buys_and_the_own_record_every_ledger_row(tmp_path):
    """The mirror ledger has a row per copy-eligible buy. y14 averages each coin's first buy, picked before a NULL y is
    dropped; own_record_shrunk averages every resolved row, as score.ts reads mirror_ledger on the server."""
    (tmp_path / "export" / "mirror_ledger").mkdir(parents=True)
    (tmp_path / "export" / "wallets").mkdir(parents=True)
    ts = lambda v: pd.to_datetime(v, unit="s", utc=True)  # noqa: E731
    pd.DataFrame({
        "leader": ["w1", "w1", "w1", "w1", "w1", "w2"],
        "mint": ["m1", "m1", "m1", "m2", "m2", "m1"],
        "buy_sig": ["s1", "s2", "s3", "s4", "s5", "s6"],
        "buy_ts": ts([1000, 2000, 3000, 1500, 2500, 50]),
        "y": [0.1, 0.2, None, None, 0.4, 0.5],  # m2's first buy had no copy entry; s3 hasn't resolved yet
        "resolved_at": ts([1100, 2100, None, None, 2600, 60]),
    }).to_parquet(tmp_path / "export" / "mirror_ledger" / "all.parquet")
    pd.DataFrame({"address": ["w1", "w2"], "first_seen_at": ts([500, 100])}).to_parquet(tmp_path / "export" / "wallets" / "all.parquet")
    first, ledger, source, _ = sdata.copies(tmp_path)
    assert source == "mirror_ledger"
    assert first[["leader", "buy_ts", "y"]].to_dict("records") == [{"leader": "w1", "buy_ts": 1000.0, "y": pytest.approx(0.1)}]
    assert sorted(ledger.y.round(3).tolist()) == [0.1, 0.2, 0.4]  # w2's buy came before the server knew it

    tables, _ = synthetic(3, days=5)
    train.train(tables, first, tmp_path / "models", ledger=ledger, device="cpu")
    assert len(tables.ledger) == 3  # own_record_shrunk is built on the whole ledger, not the targets


def test_a_look_is_taken_once_and_later_runs_carry_the_recorded_verdict(first_run, capsys):
    gate_file = first_run["gate_file"]
    rec = json.loads(gate_file.read_text())
    m1 = json.loads((first_run["bundle"] / "manifest.json").read_text())
    assert len(rec["looks"]) == 1 and rec["passed"] == m1["gate"]["passed"]
    look = rec["looks"][0]
    assert look["seed"] == 0 and look["source"] == "mirror_ledger" and look["version"] == m1["version"]
    assert look["model_sha256"] == m1["sha256"]["social.onnx"]
    assert look["validation"]["days"] == m1["metrics"]["days"]["validation"]
    assert "SynW" not in gate_file.read_text()  # counts and days only

    # Another seed, a later run: no new look, the recorded verdict is what the server reads.
    d = train.train(first_run["tables"], first_run["copies"], first_run["root"] / "models", source="mirror_ledger", device="cpu",
                    seed=7, gate_file=gate_file, now=datetime(2027, 1, 2, tzinfo=timezone.utc))
    m2 = json.loads((d / "manifest.json").read_text())
    assert len(json.loads(gate_file.read_text())["looks"]) == 1
    assert m2["gate"]["passed"] == m1["gate"]["passed"] and m2["gate"]["tested_version"] == m1["version"]
    assert "spearman" not in m2["gate"] and m2["metrics"]["validation_check"]["valid"]  # its own numbers: information only
    assert "recorded verdict" in capsys.readouterr().out

    # A retest only looks at days after the last look's labels: none here, so the verdict stays.
    d = train.train(first_run["tables"], first_run["copies"], first_run["root"] / "models", source="mirror_ledger", device="cpu",
                    retest=True, gate_file=gate_file, now=datetime(2027, 1, 3, tzinfo=timezone.utc))
    m3 = json.loads((d / "manifest.json").read_text())
    assert len(json.loads(gate_file.read_text())["looks"]) == 1 and m3["gate"]["passed"] == m1["gate"]["passed"]


def test_a_recorded_failure_stays_failed_until_a_retest_on_new_days(tmp_path):
    gate_file = tmp_path / train.GATE_FILE
    failed = {"at": "2026-12-01T00:00:00Z", "version": "v1", "model_sha256": "0" * 64, "seed": 0, "source": "mirror_ledger",
              "feature_spec_version": 1, "validation": {"first_day": 0.0, "last_day": 9 * DAY, "days": 10},
              "result": {"passed": False, "valid": True}}
    train.write_looks(gate_file, [failed])
    assert train.recorded_gate(train.read_looks(gate_file))["passed"] is False
    days = [i * DAY for i in range(60)]
    tr, va, emb = train.retest_split(days, 9 * DAY)
    assert va[0] == 23 * DAY and emb and tr[-1] <= va[0] - train.EMBARGO  # labels of the old look end at day 9 + 14
    assert train.retest_split(days[:23], 9 * DAY) is None


def test_the_gate_is_not_a_test_without_the_servers_own_record(tmp_path):
    """On the research reference, own_record_shrunk counts first buys only (the server counts every ledger row): the
    gate computes nothing, can't pass and records no look."""
    rng = np.random.default_rng(0)
    w = np.repeat(np.arange(400), 2).astype(str)
    p, y, own = rng.normal(size=800), rng.normal(size=800), rng.normal(size=800)
    g = train.gate(p, y, own, w, True, train.MIN_WALLETS, B=20, server_ledger=False)
    assert not g["passed"] and not g["valid"] and "spearman" not in g
    g = train.gate(p, y, own, w[:400], True, train.MIN_WALLETS, B=20)
    assert not g["valid"] and "200 validation wallets" in g["reason"]
    g = train.gate(p + 5 * y, y, own, w, True, train.MIN_WALLETS, B=50, alpha=0.05 / 3)
    assert g["valid"] and g["passed"] and g["alpha"] == pytest.approx(0.05 / 3)

    tables, copies = synthetic(320, days=60, seed=1)
    gate_file = tmp_path / train.GATE_FILE
    d = train.train(tables, copies, tmp_path / "models", source="research_reference", device="cpu", gate_file=gate_file)
    m = json.loads((d / "manifest.json").read_text())
    assert not m["gate"]["passed"] and not m["gate"]["valid"] and not gate_file.exists()


def test_no_label_before_the_ledger_is_complete():
    """The server keeps 8 days of mirror_ledger: an as-of day is labelled only once both its 14-day window and its own
    record (rows resolved in [t - 7 d, t), bought up to 30 h earlier) lie inside what the Mac holds."""
    links = pd.DataFrame({"first_seen": [0.5 * DAY]})
    start = 10.2 * DAY  # the ledger the Mac holds begins well after the first link
    days = train.asof_grid(links, 60 * DAY, start)
    assert days[0] == 19 * DAY and days[0] - train.OWN_LEAD >= start and days[0] - train.OWN_LEAD - DAY < start
    assert train.asof_grid(links, 60 * DAY)[0] == DAY  # no ledger bound
    assert train.asof_grid(links, start + 20 * DAY, start) == []  # an 8-day ledger (or 20) labels nothing
    assert train.asof_grid(links, 60 * DAY, float("nan")) == []


def test_train_labels_nothing_before_the_ledger_coverage(tmp_path, monkeypatch, capsys):
    tables, copies = synthetic(5, days=40)
    start = T0 + 12 * DAY  # the pulls began on day 12: the ledger rows before it are someone else's partial picture
    seen = []
    lab = train.labelled
    monkeypatch.setattr(train, "labelled", lambda ix, tg, asofs: seen.extend(asofs) or lab(ix, tg, asofs))
    assert train.train(tables, copies, tmp_path / "models", device="cpu", ledger_start=start) is None  # 5 wallets: below the minimum
    assert seen and min(seen) >= start + train.OWN_LEAD
    assert "the ledger covers" in capsys.readouterr().out
    seen.clear()
    train.train(tables, copies, tmp_path / "models", device="cpu")  # default: from the ledger's earliest buy
    assert min(seen) >= copies.buy_ts.min() + train.OWN_LEAD


def test_ledger_parts_accumulate_once_each_and_coverage_restarts_after_a_gap(tmp_path):
    """Each pull is the server's 8-day ledger as it was then: a row in two parts counts once, its resolved version; the
    coverage is the newest unbroken stretch of parts."""
    d = tmp_path / "export" / "mirror_ledger"
    d.mkdir(parents=True)
    (tmp_path / "export" / "wallets").mkdir(parents=True)
    ts = lambda v: pd.to_datetime(v, unit="s", utc=True)  # noqa: E731
    part = lambda name, rows: pd.DataFrame(rows, columns=["leader", "mint", "buy_sig", "buy_ts", "y", "resolved_at"]).assign(  # noqa: E731
        buy_ts=lambda f: ts(f.buy_ts), resolved_at=lambda f: ts(f.resolved_at)).to_parquet(d / name)
    part("part-1.parquet", [("w1", "m1", "s1", 1000, None, None),  # not resolved when pulled
                            ("w1", "m2", "s2", 1500, 0.3, 1600)])
    part("part-2.parquet", [("w1", "m1", "s1", 1000, 0.1, 1100),  # the same row, resolved
                            ("w1", "m1", "s3", 2000, 0.2, 2100), ("w1", "m2", "s2", 1500, 0.3, 1600)])
    pd.DataFrame({"address": ["w1"], "first_seen_at": ts([500])}).to_parquet(tmp_path / "export" / "wallets" / "all.parquet")
    first, ledger, _, start = sdata.copies(tmp_path)
    assert sorted(ledger.y.round(3).tolist()) == [0.1, 0.2, 0.3]  # s1 and s2 once each, s1 resolved
    assert first[["mint", "buy_ts"]].to_dict("records") == [{"mint": "m1", "buy_ts": 1000.0}, {"mint": "m2", "buy_ts": 1500.0}]
    assert start == 1000.0
    # A pull after a gap the server's retention didn't bridge: coverage starts again at its earliest buy.
    part("part-3.parquet", [("w1", "m3", "s4", 90_000, 0.5, 90_100)])
    *_, start = sdata.copies(tmp_path)
    assert start == 90_000.0
    assert sdata.coverage_start(pd.DataFrame({"lo": [0.0, 50.0, 300.0], "hi": [100.0, 200.0, 400.0]})) == 300.0
    assert sdata.coverage_start(pd.DataFrame({"lo": [0.0, 50.0], "hi": [100.0, 200.0]})) == 0.0


def test_a_first_buy_pruned_before_the_pulls_is_not_promoted():
    """The ledger the Mac holds may start after a coin's real first buy: the later buy left there is not a first buy."""
    import duckdb

    con = duckdb.connect()
    con.sql("""CREATE TABLE wallet_swaps AS SELECT * FROM (VALUES
                 ('w1', 'm1', 'buy', to_timestamp(500)), ('w1', 'm1', 'buy', to_timestamp(2000)),
                 ('w1', 'm2', 'sell', to_timestamp(500)), ('w1', 'm2', 'buy', to_timestamp(1500)),
                 ('w2', 'm1', 'buy', to_timestamp(1200))) t(wallet, mint, side, ts)""")
    first = pd.DataFrame({"leader": ["w1", "w1", "w2"], "mint": ["m1", "m2", "m1"], "buy_ts": [2000.0, 1500.0, 1200.0],
                          "y": [0.1, 0.2, 0.3], "resolved_at": [2100.0, 1600.0, 1300.0]})
    kept = sdata.drop_pruned_firsts(con, first, 1000.0)
    assert kept[["leader", "mint"]].to_dict("records") == [{"leader": "w1", "mint": "m2"}, {"leader": "w2", "mint": "m1"}]
    assert sdata.drop_pruned_firsts(con, first.drop(columns="mint"), 1000.0) is not None  # the research reference: as is
    assert len(sdata.drop_pruned_firsts(con, first, float("nan"))) == 3


def test_a_pass_carries_over_only_to_the_tested_spec_and_source(tmp_path, capsys):
    passed = {"at": "2026-12-01T00:00:00Z", "version": "v1", "model_sha256": "0" * 64, "seed": 0, "source": "mirror_ledger",
              "feature_spec_version": 1, "validation": {"first_day": 0.0, "last_day": 9 * DAY, "days": 10},
              "result": {"passed": True, "valid": True}}
    assert train.recorded_gate([passed], 1, "mirror_ledger")["passed"] is True
    g = train.recorded_gate([passed], 2, "mirror_ledger")
    assert g["passed"] is False and "untested spec version" in g["reason"]
    g = train.recorded_gate([passed], 1, "research_reference")
    assert g["passed"] is False and "target source changed" in g["reason"]
    assert train.recorded_gate([passed | {"result": {"passed": False}}], 1, "mirror_ledger")["reason"] == "the pre-registered test failed"

    # Through a run: the look tested another spec version, so this model ships with passed = false.
    spec_version, _ = load_spec()
    gate_file = tmp_path / train.GATE_FILE
    train.write_looks(gate_file, [passed | {"feature_spec_version": spec_version + 1}])
    tables, copies = synthetic(20, days=40)
    d = train.train(tables, copies, tmp_path / "models", source="mirror_ledger", device="cpu", gate_file=gate_file, min_wallets=5)
    m = json.loads((d / "manifest.json").read_text())
    assert m["gate"]["passed"] is False and "untested spec version" in m["gate"]["reason"]
    assert len(train.read_looks(gate_file)) == 1
    assert "recorded verdict: failed (untested spec version" in capsys.readouterr().out
