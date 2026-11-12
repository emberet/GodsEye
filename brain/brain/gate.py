"""
The promotion gate (CONTRACT.md "Promotion"): `python -m brain.gate --bundle <dir> [--social]`.

    exit 0  promote: the bundle passes the sanity checks, the stress suite and the bar
    exit 5  real-test: not promoted, but the real-test check passes (brain.push --real-test): the Brain sleeve may trade it
    exit 3  explore-only: sanity and the stress suite's safety checks pass, the bar does not (brain.push --explore-only)
    exit 1  reject: keep the server's current model

The real-test check (real_test(), the Brain sleeve's licence for real money, roadmap 2026-11-11): every sanity check;
the stress suite's safety checks, unchanged, on the same copies run through the server's real-money rails
(spec/rails.yaml: 5% of the account a trade, a 20% day's stop, a pause 50% below the high); zero gated copies; and every
assure check but the planted-edge and stress-world learning ones. Only the proven-edge and stress bars are relaxed.

The bundle is scored as the server would run it: its ONNX files through onnxruntime with the manifest's norms, margin_c
and exit network (policy.bundle), on the rebuilt simulator (sim.yaml), the same population as the baselines (leader buy
>= 0.2 SOL, known_at_t, outage-free).

Every policy (the candidate, B1, B2, B4) is scored with its fill-outlier copies turned into skips: a fill more than 2x
away from the tape print it is priced on is a simulator artifact (policy.score), and the first brain made all its
selection profit from such copies. The raw numbers are in the report next to the clean ones.

The bar (selection window, splits.yaml; B4 re-scored on the same window, seed and chaos, so every difference is paired):
  b4_per_copy       per-copy mean minus B4's, mint-clustered 95 % CI above 0 (copies one per coin, as baselines)
  b4_per_decision   per-decision difference with B4 (account.paired_diff: a skip scores 0), CI above 0
  copies_per_day    the 5-slot paper account opens >= MIN_COPIES_PER_DAY copies a day: "skip everything" fails here
  drawdown          account max drawdown <= B4's (re-scored, and the baselines-v2.json figure)
  live_slice        on the selection signals stored within 60 s of their block (features.yaml stored_late = False: the
                    ones the server decides live, with live-like features) the per-copy mean beats B4's. Half of
                    selection (all of 11-01) and nearly all of test were backfilled, and their insert-time entry features
                    (no flow, a tracked population of ~20 wallets) are a state the live server rarely sees
                    (vs_B4_by_storage reports both slices, the test one too)
  beats_b1_b2       stress.yaml base_selection: per copy >= 0.005 SOL above B1 and B2 with the paired CI above 0. The
                    criterion says "per decision" but quotes per-copy figures (B1 -0.0082, B2 -0.0085 SOL/copy); the gate
                    reads it per copy and reports the per-decision difference next to it until stress.yaml settles it
  robust            per decision >= 0 without the top 1 % of mints (by P&L; both readings of "1 %", robustness()) and
                    without any single venue group
  assure            brain.assure check_bundle: the bundle checks pass and the trainer passed every learning check
Sanity also rejects a bundle whose training touched embargo, selection or test days (manifest metrics.data.trained_days,
else the fit days or _state/<v>/brain.json): its selection score would be in-sample. Paper transitions (hourly) come
from the live server, inside the open-ended test period: allowed, but they make TEST in-sample for that bundle.
Safety (stress.yaml pass_criteria, the scenarios replayed on hash subsamples of each day; entry-side chaos for
cold_ledger and feature_dropout_30 from policy.entry.Augment):
  combined_worst    per decision >= -EXPLORE_BUDGET and no day below -0.5 SOL
  crash_rugwave_replay, worst_day_alt   account never below 0.7 SOL, per-decision CI lower bound > -0.002
  gated             zero copies of gated signals anywhere
The held-out test window (11-02 onward) is scored only with --final-test, once per bundle: every scoring is appended to
the ledger <models>/_work/test-ledger.jsonl, and a second one of the same bundle is refused unless --rescore-test. Each
report carries the ledger's history (test_ledger: how often TEST has been seen, so whether it is still a holdout);
nothing in the decision reads test. The report goes next to the bundle: <models>/<version>.gate-report.json, with the
sha256 of the gate.py that wrote it.

--social checks a social bundle (manifest, hash, the network runs and gives finite numbers): sanity only, exit 0 or 1.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd

from brain.export_onnx import verify
from brain.features import build, spec
from brain.policy import data as pdata
from brain.policy.bundle import Bundle, BundleError, stake_callback
from brain.policy.entry import Augment
from brain.policy.exit import ExitFeaturizer
from brain.policy.reference import b4, baselines
from brain.policy.score import FILL_X, MIN_COPIES_PER_DAY, cleaned
from brain.sim.account import Rails, account, cluster_ci, counted, metrics, one_per_coin, paired_diff
from brain.sim.evaluate import evaluate, load_window
from brain.sim.params import SimParams
from brain.sim.stress import scenarios

PROMOTE, EXPLORE_ONLY, REJECT = 0, 3, 1
REAL_TEST = 5  # not promoted, but passes the real-test check: brain.push --real-test (the Brain sleeve may trade it)
# The assure checks the real-test check does not require: the planted-edge and stress-world learning checks, i.e. the
# "proven edge" and stress bars. Every other assure check (the bundle, the real-data checks, null world, veto) stays.
RELAXED_ASSURE = ("L3 ", "L9 ")
EXPLORE_BUDGET = 1e-4      # SOL per decision combined_worst may lose (skip scores 0): about half B4's selection loss
B1B2_MARGIN = 0.005        # stress.yaml base_selection
STRESS_PER_DAY = 40_000    # signals per stress day (hash subsample; the big days hold 1.3-1.5 M)
LIVE_LAG_S = 60            # features.yaml stored_late: a signal stored later than this could not have been decided live
REPORT = "{version}.gate-report.json"
TEST_LEDGER = "_work/test-ledger.jsonl"   # under the models dir: one line per TEST scoring, append-only
HELD_OUT = ("embargo", "selection", "test")


def log(*a) -> None:
    print(time.strftime("%H:%M:%S"), *a, flush=True)


# ------------------------------------------------------------------------------------------------------------ stats
def per_copy_diff(a: pd.DataFrame, b: pd.DataFrame, B: int = 1000, seed: int = 0) -> dict:
    """Per-copy mean of a minus b's (each over its own counted copies), CI by a Poisson bootstrap over mints (shared)."""
    ca, cb = counted(a), counted(b)
    mints = np.unique(np.r_[a["mint"].to_numpy()[ca], b["mint"].to_numpy()[cb]].astype(str))
    def sums(o, c):
        m = pd.Index(mints).get_indexer(o["mint"].to_numpy()[c].astype(str))
        return (np.bincount(m, weights=o["pnl"].to_numpy()[c], minlength=len(mints)), np.bincount(m, minlength=len(mints)).astype(float))
    sa, na = sums(a, ca)
    sb, nb = sums(b, cb)
    if not na.sum() or not nb.sum():
        return {"n_a": int(na.sum()), "n_b": int(nb.sum()), "mean_diff": None, "ci95_mint": [None, None]}
    rng = np.random.default_rng(seed)
    out = np.empty(B)
    for i in range(0, B, 100):
        w = rng.poisson(1.0, (min(100, B - i), len(mints)))
        out[i:i + len(w)] = (w @ sa) / np.maximum(w @ na, 1e-12) - (w @ sb) / np.maximum(w @ nb, 1e-12)
    lo, hi = np.percentile(out, [2.5, 97.5])
    return {"n_a": int(na.sum()), "n_b": int(nb.sum()), "mean_a": float(sa.sum() / na.sum()), "mean_b": float(sb.sum() / nb.sum()),
            "mean_diff": float(sa.sum() / na.sum() - sb.sum() / nb.sum()), "ci95_mint": [float(lo), float(hi)]}


def robustness(out: pd.DataFrame, venues: np.ndarray) -> dict:
    """
    Per decision without the top 1 % of mints (by the policy's P&L) and without each venue group. stress.yaml says "the
    top 1 % of mints" and does not say of which set, so both readings are checked (min) until its owner rules:
      without_top1pct_window_mints  1 % of every mint in the window (the reading the gate first checked; it grows with
                                    the policy's selectivity: a policy that copies 500 of 21,000 loses 210 of its 500)
      without_top1pct_mints         1 % of the mints the policy copied (at least one)
    The looser reading alone was adopted after 2026-11-07T22-48-49Z had failed the strict one; no bundle passes on it.
    """
    keep = ~out["reason"].isin(("too-late", "bad-print")).to_numpy()
    c = counted(out)
    pnl = np.where(c, out["pnl"].to_numpy(), 0.0)
    mint = out["mint"].to_numpy()
    by = pd.Series(pnl[keep & c]).groupby(mint[keep & c]).sum().sort_values(ascending=False)
    top = set(by.index[: max(1, int(np.ceil(0.01 * len(by))))]) if len(by) else set()
    m = keep & ~np.isin(mint, list(top))
    res = {"without_top1pct_mints": float(pnl[m].sum() / max(m.sum(), 1)), "n_top_mints": len(top), "n_copied_mints": int(len(by))}
    n_all = len(np.unique(mint[keep]))
    top_w = set(by.index[: int(np.ceil(0.01 * n_all))]) if n_all else set()
    m = keep & ~np.isin(mint, list(top_w))
    res["without_top1pct_window_mints"] = float(pnl[m].sum() / max(m.sum(), 1))
    for v in sorted(set(venues)):
        m = keep & (venues != v)
        res[f"without_{v}"] = float(pnl[m].sum() / max(m.sum(), 1))
    res["n_top_window_mints"] = len(top_w)
    res["min"] = min(v for k, v in res.items() if k not in ("n_top_mints", "n_copied_mints", "n_top_window_mints"))
    return res


def by_storage(a: pd.DataFrame, b: pd.DataFrame, B: int = 500) -> dict:
    """
    Per-copy a vs b on the signals stored within LIVE_LAG_S of their block (what the server decides live: its features
    are live-like) and on the rest (backfilled: entry features built by insert time from a half-stored past).
    """
    res = {}
    for name, keep in (("stored_in_time", lambda o: o["ins_lag_s"].to_numpy() <= LIVE_LAG_S),
                       ("stored_late", lambda o: o["ins_lag_s"].to_numpy() > LIVE_LAG_S)):
        sa, sb = a[keep(a)], b[keep(b)]
        res[name] = {"signals": int(len(sa)), **per_copy_diff(sa, sb, B=B)}
    return res


def brief(m: dict) -> dict:
    a = m["account"]
    return {"per_decision": m["per_decision"]["mean_sol"], "per_decision_ci95": m["per_decision"]["ci95_mint"],
            "per_copy": m["per_copy"]["mean_sol"], "per_copy_ci95": m["per_copy"]["ci95_mint"], "copies": m["per_copy"]["n"],
            "account_net": a["net_sol"], "min_equity": a["min_equity"], "max_drawdown": a["max_drawdown_sol"],
            "copies_per_day": a["copies_per_day_mean"], "worst_day": a["worst_day_sol"], "trades": a["trades"],
            "slot_utilisation": a["slot_utilisation"], "exit_reasons": m["per_copy"]["exit_reasons"], "coverage": m["coverage"]}


def check(name: str, ok: bool, value, rule: str) -> dict:
    return {"name": name, "passed": bool(ok), "value": value, "rule": rule}


# ------------------------------------------------------------------------------------------------------------ holdout
def trained_on(manifest: dict, bundle_dir: Path) -> dict:
    """
    What the bundle learned from: its training days and the date range of any paper transitions, from the manifest
    (metrics.data, train.py), else the fit days it lists, else _state/<version>/brain.json (bundles before the field).
    """
    from brain.data import splits
    data = manifest.get("metrics", {}).get("data", {}) or {}
    days, source = data.get("trained_days"), "manifest metrics.data.trained_days"
    if days is None and data.get("fit_days"):
        days, source = [d["day"] for d in data["fit_days"]], "manifest metrics.data.fit_days"
    if days is None:
        st = bundle_dir.parent / "_state" / str(manifest.get("version", bundle_dir.name)) / "brain.json"
        try:
            days, source = json.loads(st.read_text())["meta"]["trained_days"], str(st)
        except (OSError, KeyError, ValueError):
            pass
    tr = data.get("paper_transitions_range")
    per = splits.period_of  # a bare day is its 00:00 UTC
    held = sorted({d for d in days or [] if per(d) in HELD_OUT})
    tr_periods = sorted({per(t) for t in tr}) if tr else []
    if tr:  # a range spans every period between its ends
        names = [p.name for p in splits.periods()]
        idx = [names.index(x) for x in tr_periods if x in names]
        tr_periods = names[min(idx): max(idx) + 1] if idx else tr_periods
    return {"trained_days": days, "source": source if days is not None else None, "held_out_days": held,
            "paper_transitions_range": tr, "paper_transitions_periods": tr_periods,
            "test_in_sample": bool([d for d in held if per(d) == "test"]) or "test" in tr_periods}


def holdout_check(t: dict) -> dict:
    """Sanity: no training day in embargo / selection / test, and no paper transition dated in embargo or selection."""
    bad_tr = [x for x in t["paper_transitions_periods"] if x in ("embargo", "selection")]
    ok = t["trained_days"] is not None and not t["held_out_days"] and not bad_tr
    return check("trained_out_of_sample", ok, t, "training days known and none in embargo/selection/test (splits.yaml); paper "
                 "transitions none in embargo/selection: otherwise selection is scored in-sample")


def ledger_path(models: Path) -> Path:
    return models / TEST_LEDGER


def read_ledger(models: Path) -> list[dict]:
    try:
        return [json.loads(x) for x in ledger_path(models).read_text().splitlines() if x.strip()]
    except OSError:
        return []


def append_ledger(models: Path, entry: dict) -> None:
    p = ledger_path(models)
    p.parent.mkdir(parents=True, exist_ok=True)
    with p.open("a") as f:
        f.write(json.dumps(entry, default=_json) + "\n")


OLD_TEST_FROM = "2026-11-02T00:00:00+00:00"  # the fixed test start, for ledger rows written before the periods rolled


def ledger_summary(models: Path, version: str | None) -> dict:
    """
    How often the current TEST window has been scored (this bundle, every bundle): numbers seen before are no longer a
    clean holdout. The periods roll with the data (splits.yaml), so only scorings of this window's start count.
    """
    from brain.data import splits
    now = splits.test_start().isoformat()
    rows = [r for r in read_ledger(models) if r.get("test_from", OLD_TEST_FROM) == now]
    mine = [r for r in rows if r.get("version") == version]
    return {"views_all_bundles": len(rows), "bundles": sorted({r.get("version") for r in rows}), "views_this_bundle": mine,
            "label": (f"TEST has been scored {len(rows)} times across {len({r.get('version') for r in rows})} bundles "
                      "(gate and trainer changed between views): its numbers are already seen, not a clean holdout")
            if rows else "TEST never scored: still held out"}


def code_hash() -> str:
    import hashlib
    return hashlib.sha256(Path(__file__).read_bytes()).hexdigest()


# ------------------------------------------------------------------------------------------------------------ scoring
class Scorer:
    def __init__(self, bundle: Bundle, p: SimParams, con, meta: dict, hourly):
        self.b, self.p, self.con, self.meta, self.hourly = bundle, p, con, meta, hourly
        self.rails = Rails.load()
        self.aug = Augment.for_entry(meta)

    def candidate(self, w, ei, chaos=None, seed: int = 0, B: int = 500, rows=None, keep_book: bool = False):
        from brain.sim.params import Chaos
        frac = self.b.entry_stakes(ei)
        return evaluate(w, stake_callback(frac, self.p.max_trade_sol), self.b.exit_policy(ExitFeaturizer(ei.ps_r, self.hourly)), self.p,
                        chaos or Chaos(), seed, rows=rows, B=B, features=True, keep_book=keep_book), frac

    def inputs(self, w, entry_chaos: dict | None = None):
        ei = pdata.entry_inputs(w, self.meta)
        if entry_chaos:
            ei.Z = self.aug.scenario(ei.Z, **entry_chaos)
        return ei


def gated_copies(out: pd.DataFrame, gated: np.ndarray) -> int:
    return int(((out["stake"].to_numpy() > 0) & gated[out["row"].to_numpy()]).sum())


def run_stress(sc: Scorer, per_day: int, seed: int = 0, names=None) -> dict:
    """Each stress scenario (but base_selection and held_out_test) on hash subsamples of its days, one account path."""
    res = {}
    counts = {}
    for s in scenarios():
        if s.name in ("base_selection",) or (names and s.name not in names):
            continue
        t = time.time()
        entry_chaos = {"cold_ledger": {"cold_ledger": True}, "feature_dropout_30": {"dropout": 0.3, "structural": True, "seed": seed}}.get(s.name)
        outs, gated, outliers = [], 0, 0
        days = []
        for day in s.dates:
            if day not in counts:
                n = sc.con.execute(f"""SELECT count(*) FROM episodes WHERE day = '{day}' AND leader_sol >= 0.2 AND known_at_t
                                       AND NOT crosses_outage""").fetchone()[0]
                counts[day] = int(n)
            if not counts[day]:
                continue
            where = pdata.sample_where(counts[day], per_day)  # the same sample in every scenario: one tape cache per day
            hs = [pd.Timestamp(h) for h in s.hours if h.startswith(day)]
            if s.hours and not hs:
                continue
            start = pd.Timestamp(day, tz="UTC")
            w = load_window(start, start + pd.Timedelta(days=1), con=sc.con, params=sc.p, chaos=s.chaos, seed=seed, where=where)
            if not w.meta["signals"]:
                continue
            rows = None
            if hs:  # crash_hours: only the signals inside those hours
                hour = pd.to_datetime(w.data.sig["ts"], utc=True).dt.floor("h")
                rows = np.flatnonzero(hour.isin(hs).to_numpy())
                if not len(rows):
                    continue
            ei = sc.inputs(w, entry_chaos)
            r, frac = sc.candidate(w, ei, s.chaos, seed, B=10, rows=rows, keep_book=True)
            o = cleaned(r, w, sc.p, B=10)
            outs.append(o["out"])
            outliers += o["n_outliers"]
            gated += gated_copies(r.out, ei.gated)
            days.append(day)
        if not outs:
            res[s.name] = {"skipped": "no signals (e.g. 10-17: no leader known yet)"}
            continue
        o = pd.concat(outs, ignore_index=True)  # one account path across the scenario's days (t_dec is on one clock)
        o["solo"] = one_per_coin(o)
        acc = account(o, o["t_dec"].to_numpy(), sc.p)
        m = metrics(o, acc, days, sc.p, B=300, seed=seed)
        # The same copies through the server's real-money rails (spec/rails.yaml): what the real-test check reads.
        m_r = metrics(o, account(o, o["t_dec"].to_numpy(), sc.p, rails=sc.rails), days, sc.p, B=300, seed=seed)
        res[s.name] = {"days": days, "per_day_sample": per_day, "gated_copies": gated, "fill_outliers_skipped": outliers, **brief(m),
                       "rails": {**brief(m_r), "blocked": m_r["account"]["blocked"]},
                       "by_day": {d: v for d, v in m["by_day"].items()}}
        log(f"stress {s.name}: per decision {m['per_decision']['mean_sol']:+.6f} account {m['account']['net_sol']:+.3f} "
            f"min eq {m['account']['min_equity']:.3f} worst day {m['account']['worst_day_sol']:+.3f} ({time.time() - t:.0f} s)")
    return res


def rails_view(st: dict) -> dict:
    """The stress results as the real-money rails saw them (each scenario's `rails` figures over its own)."""
    return {k: ({**v, **v["rails"]} if isinstance(v, dict) and "rails" in v else v) for k, v in st.items()}


def real_test(sanity: list[dict], rails_safety: list[dict], bar: list[dict], assure: dict | None) -> dict:
    """
    The real-test check (the Brain sleeve's licence for real money): every sanity check; the stress suite's safety checks,
    unchanged, scored on the real-money rails; zero copies of gated signals on selection; and every assure check but the
    learning ones RELAXED_ASSURE names. Only the proven-edge bar and the stress bars are relaxed.
    """
    failed = [c["name"] for c in sanity + rails_safety if not c["passed"]]
    if not rails_safety:
        failed.append("rails_safety (the stress suite did not run)")
    failed += [c["name"] for c in bar if c["name"] == "selection_gated_copies" and not c["passed"]]
    if assure is None:
        failed.append("assure (did not run)")
    else:
        failed += [n for n in assure.get("failed", []) if not n.startswith(RELAXED_ASSURE)]
    return {"passed": not failed, "failed": failed, "relaxed": ["the bar: edge over B4/B1/B2, copies per day, drawdown vs B4, "
            "live slice, robustness", *[f"assure {x.strip()}" for x in RELAXED_ASSURE]],
            "rails": {k: v for k, v in Rails.load().__dict__.items()}}


def safety_checks(st: dict) -> list[dict]:
    out = []
    cw = st.get("combined_worst", {})
    if "per_decision" in cw:
        out.append(check("combined_worst", cw["per_decision"] >= -EXPLORE_BUDGET and cw["worst_day"] >= -0.5,
                         {"per_decision": cw["per_decision"], "worst_day": cw["worst_day"]},
                         f"per decision >= -{EXPLORE_BUDGET} SOL and no day below -0.5 SOL"))
    for name in ("crash_rugwave_replay", "worst_day_alt"):
        s = st.get(name, {})
        if "per_decision" in s:
            lo = s["per_decision_ci95"][0]
            out.append(check(name, s["min_equity"] >= 0.7 and (not np.isfinite(lo) or lo > -0.002),
                             {"min_equity": s["min_equity"], "per_decision_ci95": s["per_decision_ci95"]},
                             "account never below 0.7 SOL; per-decision CI lower bound > -0.002 SOL"))
    g = sum(s.get("gated_copies", 0) for s in st.values() if isinstance(s, dict))
    out.append(check("stress_gated_copies", g == 0, g, "zero copies of gated signals in every scenario"))
    return out


# ------------------------------------------------------------------------------------------------------------ main
def gate(bundle_dir: Path, a) -> tuple[int, dict]:
    t0 = time.time()
    rep: dict = {"bundle": str(bundle_dir), "created_at": pd.Timestamp.now(tz="UTC").isoformat(), "gate_sha256": code_hash(), "checks": {}}
    v = verify(bundle_dir)
    meta = build.load_meta()
    sanity = [check("bundle_files", v["ok"], v["problems"], "manifest shape, hashes, every network runs with the declared widths")]
    trained = None
    try:
        b = Bundle(bundle_dir)
        b.check_columns(meta["columns"])
        sanity.append(check("columns", True, None, "entry/exit features equal the feature build's and features.yaml's columns"))
        sanity.append(check("feature_spec_version", b.manifest["feature_spec_version"] == spec.version(),
                            b.manifest["feature_spec_version"], "the bundle was built for features.yaml's version"))
        trained = trained_on(b.manifest, bundle_dir)
        sanity.append(holdout_check(trained))
    except (BundleError, KeyError, ValueError, OSError) as e:
        sanity.append(check("load", False, str(e), "the bundle loads"))
        b = None
    rep["version"] = b.version if b else None
    rep["checks"]["sanity"] = sanity
    rep["test_ledger"] = ledger_summary(bundle_dir.parent, rep["version"])
    if not all(c["passed"] for c in sanity):
        rep["decision"] = {"exit": REJECT, "why": "sanity"}
        return REJECT, rep
    p = SimParams.load()
    from brain.data import connect
    con = connect()
    hourly = build.load_hourly()
    sc = Scorer(b, p, con, b.entry_meta(), hourly)  # the manifest's norm, as the runtime normalises
    js = baselines()
    # ---- selection
    t = time.time()
    w = load_window(period="selection", con=con, params=p, where=pdata.share_where(a.sel_share))
    ei = sc.inputs(w)
    log(f"selection {w.meta} ({time.time() - t:.0f} s)")
    cand_raw, frac = sc.candidate(w, ei, B=200, keep_book=True)
    cand = cleaned(cand_raw, w, p, B=1000)
    b4_entry, b4_exit, b4info = b4(p)
    rb4 = cleaned(evaluate(w, b4_entry, b4_exit, p, B=200, keep_book=True), w, p, B=1000)
    log(f"candidate {brief(cand['metrics'])['per_copy']:+.5f}/copy ({cand['n_outliers']} fill outliers skipped; raw "
        f"{brief(cand_raw.metrics)['per_copy']:+.5f}), B4 {brief(rb4['metrics'])['per_copy']:+.5f}/copy ({rb4['n_outliers']} skipped)")
    sel = {"window": w.meta, "share": a.sel_share, "candidate": brief(cand["metrics"]), "B4": brief(rb4["metrics"]),
           "fill_outliers": {"candidate": cand["n_outliers"], "B4": rb4["n_outliers"],
                             "rule": f"copies filled more than {FILL_X}x away from their tape print are simulator artifacts (policy.score): skipped"},
           "candidate_raw_with_fill_outliers": brief(cand_raw.metrics),
           "B4_stored": {k: js["selection"]["B4"][k2][k3] for k, (k2, k3) in {"per_copy": ("per_copy", "mean_sol"),
                         "per_decision": ("per_decision", "mean_sol"), "max_drawdown": ("account", "max_drawdown_sol")}.items()},
           "by_day": cand["metrics"]["by_day"]}
    co, bo = cand["out"], rb4["out"]
    pc = per_copy_diff(co, bo)
    pdd = paired_diff(co, bo, B=1000)
    sel["vs_B4_per_copy"], sel["vs_B4_per_decision"] = pc, pdd
    sel["vs_B4_per_copy_raw"] = per_copy_diff(cand_raw.out, rb4["raw_out"], B=300)
    live = co["ins_lag_s"].to_numpy() <= LIVE_LAG_S
    c_live = counted(co) & live
    sel["live_deliverable_ins_lag_le_60s"] = {"n": int(c_live.sum()), "mean": float(co["pnl"].to_numpy()[c_live].mean()) if c_live.any() else None}
    sel["vs_B4_by_storage"] = by_storage(co, bo)
    res_b12 = {}
    if not a.no_b1b2:
        from brain.baselines import B1_EXIT, B2_EXIT, b1_entry, b2_entry
        for name, (en, ex) in {"B1": (b1_entry(p), B1_EXIT), "B2": (b2_entry(con, p), B2_EXIT)}.items():
            t = time.time()
            r = cleaned(evaluate(w, en, ex, p, B=100, keep_book=True), w, p, B=300)
            res_b12[name] = {**brief(r["metrics"]), "fill_outliers": r["n_outliers"], "vs_per_copy": per_copy_diff(co, r["out"], B=500),
                             "vs_per_decision": paired_diff(co, r["out"], B=500)}
            log(f"{name} re-scored: {res_b12[name]['per_copy']:+.5f}/copy ({time.time() - t:.0f} s)")
            del r
    sel["B1_B2"] = res_b12
    venues = pd.Series(w.data.sig["venue_clean"].to_numpy()[co["row"].to_numpy()]).map(_venue_group).to_numpy()
    sel["robust"] = robustness(co, venues)
    rep["selection"] = sel
    # ---- the bar (on the outcomes without fill outliers; the raw ones are reported above)
    cm, bm = cand["metrics"], rb4["metrics"]
    bar = [
        check("b4_per_copy", pc["mean_diff"] is not None and pc["ci95_mint"][0] > 0, pc, "per-copy mean minus B4's, mint-clustered CI above 0"),
        check("b4_per_decision", pdd["ci95_mint"][0] > 0, pdd, "per-decision difference with B4 (paired), mint-clustered CI above 0"),
        check("copies_per_day", cm["account"]["copies_per_day_mean"] >= MIN_COPIES_PER_DAY, cm["account"]["copies_per_day"],
              f">= {MIN_COPIES_PER_DAY} paper copies a day (5 slots): skip-everything must not pass"),
        check("drawdown", cm["account"]["max_drawdown_sol"] <= min(bm["account"]["max_drawdown_sol"], js["selection"]["B4"]["account"]["max_drawdown_sol"]),
              {"candidate": cm["account"]["max_drawdown_sol"], "B4": bm["account"]["max_drawdown_sol"],
               "B4_stored": js["selection"]["B4"]["account"]["max_drawdown_sol"]}, "account max drawdown <= B4's"),
        check("live_slice", (sel["vs_B4_by_storage"]["stored_in_time"]["mean_diff"] or 0) > 0, sel["vs_B4_by_storage"]["stored_in_time"],
              f"on the signals stored within {LIVE_LAG_S} s (live-like features) the per-copy mean beats B4's: an edge that "
              "lives only on backfilled signals is not one the server can trade"),
        check("robust", sel["robust"]["min"] >= 0, sel["robust"], "per decision >= 0 without the top 1 % of mints (of the window and of its copies: both readings) / any venue group"),
        check("selection_gated_copies", gated_copies(co, ei.gated) == 0, gated_copies(co, ei.gated), "zero copies of gated signals"),
    ]
    for name, r in res_b12.items():
        d = r["vs_per_copy"]
        bar.append(check(f"beats_{name}", d["mean_diff"] is not None and d["mean_diff"] >= B1B2_MARGIN and d["ci95_mint"][0] > 0,
                         {"per_copy": d, "per_decision_reported": r["vs_per_decision"]},
                         f"per copy >= {B1B2_MARGIN} SOL above {name}, paired mint CI above 0 (stress.yaml base_selection says 'per "
                         "decision' but quotes per-copy figures; the per-decision difference is reported until stress.yaml settles it)"))
    rep["checks"]["bar"] = bar
    del cand_raw
    del w, ei, cand, rb4, co, bo
    # ---- stress
    if not a.no_stress:
        st = run_stress(sc, a.stress_per_day, names=a.stress.split(",") if a.stress else None)
        rep["stress"] = st
        rep["checks"]["safety"] = safety_checks(st)
        rep["checks"]["rails_safety"] = safety_checks(rails_view(st))
    else:
        rep["checks"]["safety"] = [check("stress_suite", False, None, "the stress suite ran (--no-stress)")]
        rep["checks"]["rails_safety"] = []
    # ---- test: only with --final-test, once per bundle (the ledger), never used in the decision
    if getattr(a, "final_test", False) and trained["test_in_sample"]:
        rep["test_reported_never_used"] = {"skipped": "the bundle trained on test-period data (trained_out_of_sample): TEST is in-sample for it"}
    elif getattr(a, "final_test", False):
        t = time.time()
        wt = load_window(period="test", con=con, params=p, where=pdata.share_where(a.test_share))
        eit = sc.inputs(wt)
        ct_raw, _ = sc.candidate(wt, eit, B=200, keep_book=True)
        ct = cleaned(ct_raw, wt, p, B=1000)
        bt = cleaned(evaluate(wt, b4_entry, b4_exit, p, B=200, keep_book=True), wt, p, B=1000)
        lt = counted(ct["out"]) & (ct["out"]["ins_lag_s"].to_numpy() <= LIVE_LAG_S)
        prior = rep["test_ledger"]
        rep["test_reported_never_used"] = {
            "label": "TEST window (splits.yaml test): not used by any check or decision. " + (
                f"Seen before ({prior['views_all_bundles']} earlier scorings, {len(prior['views_this_bundle'])} of this bundle): "
                "not a clean holdout" if prior["views_all_bundles"] else "First scoring: held out until now"),
            "held_out": not prior["views_all_bundles"],
            "window": wt.meta, "days": wt.days, "share": a.test_share, "candidate": brief(ct["metrics"]), "B4": brief(bt["metrics"]),
            "fill_outliers": {"candidate": ct["n_outliers"], "B4": bt["n_outliers"]}, "candidate_raw_with_fill_outliers": brief(ct_raw.metrics),
            "vs_B4_per_copy": per_copy_diff(ct["out"], bt["out"]), "vs_B4_per_decision": paired_diff(ct["out"], bt["out"], B=1000),
            "live_deliverable_ins_lag_le_60s": {"n": int(lt.sum()), "mean": float(ct["out"]["pnl"].to_numpy()[lt].mean()) if lt.any() else None},
            "vs_B4_by_storage": by_storage(ct["out"], bt["out"]), "by_day": ct["metrics"]["by_day"],
            "stress_yaml_held_out_test": {  # stress.yaml pass_criteria held_out_test: reported, never a check
                "per_decision_ge_0": bool(ct["metrics"]["per_decision"]["mean_sol"] >= 0),
                "account_ge_1_sol": bool(1.0 + ct["metrics"]["account"]["net_sol"] >= 1.0)}}
        from brain.data import splits
        append_ledger(bundle_dir.parent, {"version": rep["version"], "at": pd.Timestamp.now(tz="UTC").isoformat(), "gate_sha256": rep["gate_sha256"],
                                          "test_from": splits.test_start().isoformat(),
                                          "share": a.test_share, "rescore": bool(getattr(a, "rescore_test", False)),
                                          "per_copy": ct["metrics"]["per_copy"]["mean_sol"], "per_decision": ct["metrics"]["per_decision"]["mean_sol"]})
        log(f"test (reported only): candidate {brief(ct['metrics'])['per_copy']:+.5f}/copy, B4 {brief(bt['metrics'])['per_copy']:+.5f}/copy "
            f"({time.time() - t:.0f} s)")
        del wt, eit, ct, bt, ct_raw
    # ---- assure
    if not a.no_assure:
        from brain.assure.suite import check_bundle
        t = time.time()
        res = check_bundle(bundle_dir)
        rep["assure"] = {"passed": res["passed"], "learning_verified": res["learning_verified"], "failed": res["failed"],
                         "skipped": res["skipped"], "checks": [{k: c.get(k) for k in ("name", "passed", "skipped", "detail", "value")} for c in res["checks"]]}
        bar.append(check("assure", res["passed"] and res["learning_verified"], {"failed": res["failed"]},
                         "brain.assure check_bundle passes and the trainer passed every learning check"))
        log(f"assure: passed {res['passed']} learning_verified {res['learning_verified']} ({time.time() - t:.0f} s)")
    else:
        bar.append(check("assure", False, None, "brain.assure check_bundle ran (--no-assure)"))
    rep["real_test"] = real_test(sanity, rep["checks"]["rails_safety"], bar, rep.get("assure"))
    code = decide(sanity, rep["checks"]["safety"], bar, rep["real_test"]["passed"])
    rep["decision"] = {"exit": code, "promote": code == PROMOTE, "explore_only": code == EXPLORE_ONLY, "real_test": rep["real_test"]["passed"],
                       "failed": [c["name"] for c in sanity + rep["checks"]["safety"] + bar if not c["passed"]]}
    rep["runtime_s"] = round(time.time() - t0)
    return code, rep


def decide(sanity: list[dict], safety: list[dict], bar: list[dict], real: bool = False) -> int:
    """
    0 promote (everything passes), 5 real-test (not promoted, but the real-test check passes), 3 explore-only (sanity and
    safety pass, the bar does not), 1 reject.
    """
    if not all(c["passed"] for c in sanity):
        return REJECT
    safe = bool(safety) and all(c["passed"] for c in safety)
    if safe and bar and all(c["passed"] for c in bar):
        return PROMOTE
    if real:
        return REAL_TEST
    return EXPLORE_ONLY if safe else REJECT


def _venue_group(v: str) -> str:
    from brain.features.entry import venue_group
    return venue_group(v)


def social(bundle_dir: Path) -> tuple[int, dict]:
    """Sanity of a social bundle (CONTRACT.md "Social score"): manifest, hash, the network runs, finite output [n, 1]."""
    from brain.export_onnx import session, sha256
    rep = {"bundle": str(bundle_dir), "kind": "social", "checks": []}
    try:
        m = json.loads((bundle_dir / "manifest.json").read_text())
        f = m.get("file", "social.onnx")
        ok_hash = sha256(bundle_dir / f) == m.get("sha256", {}).get(f)
        rep["checks"].append(check("hash", ok_hash, f, "sha256 of the network matches the manifest"))
        n = len(m["features"])
        shapes = len(m["norm"]["mean"]) == n and len(m["norm"]["std"]) == n and all(s > 0 for s in m["norm"]["std"])
        rep["checks"].append(check("norm", shapes, n, "norm mean/std per feature, std > 0"))
        try:  # onnxruntime raises its own errors on a damaged file
            s = session(bundle_dir / f)
            x = np.random.default_rng(0).normal(0, 1, (64, n)).astype(np.float32)
            y = s.run([m.get("output", "y")], {m.get("input", "x"): x})[0]
            rep["checks"].append(check("runs", y.shape == (64, 1) and bool(np.isfinite(y).all()), list(y.shape), "output [n, 1], finite"))
        except Exception as e:  # noqa: BLE001
            rep["checks"].append(check("runs", False, f"{type(e).__name__}: {str(e)[:200]}", "output [n, 1], finite"))
        rep["checks"].append(check("kind", m.get("kind") == "social", m.get("kind"), "manifest kind = social"))
        rep["version"] = m.get("version")
    except (OSError, KeyError, ValueError, json.JSONDecodeError) as e:
        rep["checks"].append(check("load", False, str(e), "the social bundle loads"))
    ok = all(c["passed"] for c in rep["checks"])
    rep["decision"] = {"exit": PROMOTE if ok else REJECT}
    return (PROMOTE if ok else REJECT), rep


def write_report(bundle_dir: Path, rep: dict) -> Path:
    path = bundle_dir.parent / REPORT.format(version=rep.get("version") or bundle_dir.name)
    rep.setdefault("gate_sha256", code_hash())
    path.write_text(json.dumps(rep, indent=1, default=_json))
    return path


def _json(o):
    if isinstance(o, (np.floating, np.integer)):
        return o.item()
    if isinstance(o, (np.bool_,)):
        return bool(o)
    if isinstance(o, np.ndarray):
        return o.tolist()
    return str(o)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="python -m brain.gate", description=__doc__.split("\n\n")[0])
    ap.add_argument("--bundle", required=True)
    ap.add_argument("--social", action="store_true", help="validate a social bundle (sanity only)")
    ap.add_argument("--sel-share", type=float, default=1.0, help="share of selection signals scored (hash of episode_id)")
    ap.add_argument("--test-share", type=float, default=1.0)
    ap.add_argument("--stress-per-day", type=int, default=STRESS_PER_DAY)
    ap.add_argument("--stress", default="", help="only these scenarios (comma-separated)")
    ap.add_argument("--no-stress", action="store_true", help="skip the stress suite (then the bundle can't pass)")
    ap.add_argument("--final-test", action="store_true",
                    help="also score the TEST window (reported only): once per bundle, at the end, never for tuning")
    ap.add_argument("--rescore-test", action="store_true", help="with --final-test: allow a second TEST scoring of this bundle")
    ap.add_argument("--no-test", action="store_true", help="the default (kept for scripts/cycle.sh): TEST is not scored")
    ap.add_argument("--no-b1b2", action="store_true", help="skip re-scoring B1 / B2 (then the bundle can't pass)")
    ap.add_argument("--no-assure", action="store_true", help="skip brain.assure check_bundle (then the bundle can't pass)")
    a = ap.parse_args(argv)
    d = Path(a.bundle)
    if a.final_test and a.no_test:
        ap.error("--final-test and --no-test")
    if a.final_test and not a.social and not a.rescore_test:
        try:
            version = json.loads((d / "manifest.json").read_text()).get("version") or d.name
        except (OSError, ValueError):
            version = d.name
        seen = [r for r in read_ledger(d.parent) if r.get("version") == version]
        if seen:  # checked before anything runs: the gate takes ~15 min before it reaches TEST
            ap.error(f"TEST was already scored for {version} ({len(seen)}x, first {seen[0].get('at')}; ledger {ledger_path(d.parent)}): "
                     "it is used once. --rescore-test overrides")
    code, rep = social(d) if a.social else gate(d, a)
    if a.no_b1b2 and not a.social:
        rep["checks"]["bar"].append(check("b1_b2_scored", False, None, "B1 and B2 re-scored (--no-b1b2)"))
        if code == PROMOTE:
            code = EXPLORE_ONLY
        rep["decision"]["exit"] = code
    path = write_report(d, rep)
    log(f"gate: exit {code} ({'promote' if code == PROMOTE else 'real-test' if code == REAL_TEST else 'explore-only' if code == EXPLORE_ONLY else 'reject'}); report {path}")
    print(json.dumps({"exit": code, "report": str(path), "failed": rep.get("decision", {}).get("failed")}))
    return code


if __name__ == "__main__":
    sys.exit(main())
