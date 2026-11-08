"""
Running the assurance checks: the worlds suite, the real-data checks, a bundle check for the promotion gate, the report.

    res = run(real=True)                    # {"passed", "checks": [...], "missing": [...]}
    res = check_bundle(bundle_dir)          # what brain.gate calls before promoting a bundle
    write_report(res)                       # <DATA>/reports/assure-YYYY-MM-DD.{json,html}

A check that was skipped never counts as passed: check_bundle's `learning_verified` is True only when the trainer itself
went through every learning check and passed.
"""
from __future__ import annotations

import html
import json
import time
from pathlib import Path

import numpy as np
import pandas as pd
import yaml

from brain.assure import artifacts as A
from brain.assure import features as F
from brain.assure.artifacts import Check
from brain.assure.learning import PANEL, Suite
from brain.assure.protocol import learners
from brain.assure.worlds import World, WorldSpec
from brain.sim.params import SimParams

FEATURES_SPEC = Path(__file__).resolve().parents[2] / "spec" / "features.yaml"
STAKE_ACTIONS = [0.0, 1.0]   # owner decision 2026-11-07: skip or full stake only


def world_artifacts(p: SimParams | None = None) -> list[Check]:
    p = p or SimParams()
    w = World(WorldSpec(seed=0, backfill_days=(4,)))
    m = F.mirror(w, p)
    return [A.dead_coins(w, p=p), A.exit_timing(w, p=p), A.stops_at_gap(w, p=p), A.break_even(p),
            A.point_in_time(w, F.build, m), A.one_per_coin_rule(_stacked_frame())]


def _stacked_frame() -> pd.DataFrame:
    """Three overlapping copies of one coin, one later copy after it closed, one other coin: 2 of 5 must be dropped."""
    return pd.DataFrame({"episode_id": [1, 2, 3, 4, 5], "mint": ["A", "A", "A", "A", "B"], "t_dec": [0, 10, 20, 500, 5],
                         "close_t": [100, 110, 120, 600, 50], "stake": [0.1] * 5, "reason": ["exit"] * 5, "t_ms": [0, 10, 20, 500, 5]})


def real_artifacts() -> list[Check]:
    """The checks that read the real data on the drive (read-only). Skipped (never passed) when the drive is missing."""
    from brain.data import splits
    from brain.data.loaders import data_dir
    from brain.sim.quotes import SAVED, SOURCE
    out = []
    d = data_dir()
    sel = splits.period("selection").start
    src = d / SOURCE
    if src.is_file():
        out.append(A.real_dead_coins(pd.read_parquet(src), sel, sel))
    else:
        out.append(Check("A1 real_dead_coins", False, {}, "shadow quotes on the drive", f"{src} missing", skipped=True))
    qf = d / SAVED
    if qf.is_file():
        out.append(A.calibration_cutoff(json.loads(qf.read_text()).get("meta", {}), sel))
    else:
        out.append(Check("A5 calibration_cutoff", False, {}, "a saved quote model", f"{qf} missing", skipped=True))
    out.append(A.break_even(SimParams.load()))
    bf = d / "research" / "baselines-v2.json"
    if bf.is_file():
        b = json.loads(bf.read_text())
        pcs = [b.get(per, {}).get(name, {}).get("per_copy", {}) for per in ("selection", "test") for name in ("B1", "B2", "B4")]
        has = [("n_stacked" in pc) for pc in pcs if pc]
        ok = bool(has) and all(has)
        out.append(Check("A7 real_one_per_coin", ok, {"baseline_results_with_one_per_coin": int(sum(has)), "of": len(has)},
                         "every baseline result the gate compares with is scored one position per coin (per_copy.n_stacked present)",
                         "" if ok else "baselines-v2.json was scored without the one-position-per-coin rule: re-run python -m brain.baselines"))
    return out


def learning(learner_filter: str = "all", quick: bool = False) -> tuple[list[Check], list[str]]:
    ls, missing = learners()
    if learner_filter != "all":
        ls = [x for x in ls if x.name == learner_filter or (learner_filter == "trainer" and x.name != "reference")]
    s = Suite(panel_seeds=(0, 1, 2) if quick else Suite().panel_seeds)
    out = []
    for lr in ls:
        out.extend(s.run(lr))
    return out, missing


def run(real: bool = False, learner: str = "all", quick: bool = False) -> dict:
    t0 = time.time()
    checks = world_artifacts()
    if real:
        checks += real_artifacts()
    lc, missing = learning(learner, quick)
    checks += lc
    return summarize(checks, missing, t0)


def summarize(checks: list[Check], missing: list[str], t0: float) -> dict:
    failed = [c.name for c in checks if not c.passed and not c.skipped]
    return {"created_at": pd.Timestamp.now(tz="UTC").isoformat(), "passed": not failed, "failed": failed,
            "skipped": [c.name for c in checks if c.skipped], "warnings": [f"{c.name}: {c.warning}" for c in checks if c.warning],
            "missing": missing, "runtime_s": round(time.time() - t0, 1), "checks": [c.to_dict() for c in checks]}


def check_bundle(bundle_dir) -> dict:
    """
    For brain.gate before a promotion: the bundle's manifest follows the owner's decisions and declares only spec
    features, the cost and calibration checks hold, and the trainer that made it passes every learning check.
    Promote only when `passed` and `learning_verified` are both True.
    """
    t0 = time.time()
    bundle_dir = Path(bundle_dir)
    man = json.loads((bundle_dir / "manifest.json").read_text())
    checks = []
    acts = [float(a) for a in man.get("entry", {}).get("actions", [])]
    checks.append(Check("bundle stakes", acts == STAKE_ACTIONS, {"actions": acts}, f"entry.actions == {STAKE_ACTIONS} (skip or full)",
                        "" if acts == STAKE_ACTIONS else "the bundle can stake fractions: the owner approved skip or full only"))
    spec = yaml.safe_load(FEATURES_SPEC.read_text())
    names = {e["name"] for e in spec["entry"]} | {e["name"] + "_missing" for e in spec["entry"]}
    xnames = {e["name"] for e in spec["exit"]} | {e["name"] + "_missing" for e in spec["exit"]}
    ent = man.get("entry", {}).get("features", [])
    ext = man.get("exit", {}).get("features", [])

    def base(n):  # one-hot columns are "<feature>=<level>" or "<feature>_<level>"
        return n.split("=")[0]
    bad_e = [n for n in ent if base(n) not in names and not any(base(n).startswith(k + "_") for k in names)]
    bad_x = [n for n in ext if base(n) not in xnames and not any(base(n).startswith(k + "_") for k in xnames)]
    ok = not bad_e and not bad_x
    checks.append(Check("bundle features", ok, {"undeclared_entry": bad_e, "undeclared_exit": bad_x},
                        "every input is a features.yaml feature (point in time by spec)",
                        "" if ok else "the bundle reads inputs features.yaml doesn't define: nothing proves they are point in time"))
    checks += real_artifacts()
    lc, missing = learning("trainer")
    checks += lc
    res = summarize(checks, missing, t0)
    trainer = [c for c in lc if "[reference]" not in c.name]
    res["learning_verified"] = bool(trainer) and all(c.passed and not c.skipped for c in trainer if "L13" not in c.name)
    res["bundle"] = str(bundle_dir)
    return res


# ------------------------------------------------------------------------------------------------------------ report
def write_report(res: dict, out_dir: Path | None = None) -> tuple[Path, Path]:
    from brain.data.loaders import data_dir
    out_dir = out_dir or data_dir() / "reports"
    out_dir.mkdir(parents=True, exist_ok=True)
    day = pd.Timestamp.now(tz="UTC").strftime("%Y-%m-%d")
    j = out_dir / f"assure-{day}.json"
    h = out_dir / f"assure-{day}.html"
    j.write_text(json.dumps(res, indent=1, default=_num))
    h.write_text(to_html(res))
    return j, h


def _num(x):
    if isinstance(x, (np.floating, np.integer)):
        return x.item()
    if isinstance(x, (np.ndarray,)):
        return x.tolist()
    return str(x)


def to_html(res: dict) -> str:
    rows = []
    for c in res["checks"]:
        state = "skip" if c["skipped"] else ("pass" if c["passed"] else "fail")
        val = html.escape(json.dumps(c["value"], default=_num)[:900])
        note = html.escape(c["detail"] or c.get("warning") or "")
        rows.append(f"<tr class='{state}'><td>{state.upper()}</td><td>{html.escape(c['name'])}</td><td>{html.escape(c['rule'])}</td>"
                    f"<td>{note}</td><td><code>{val}</code></td></tr>")
    head = "PASSED" if res["passed"] else "FAILED: " + ", ".join(res["failed"])
    miss = "".join(f"<li>{html.escape(m)}</li>" for m in res.get("missing", []))
    warn = "".join(f"<li>{html.escape(w)}</li>" for w in res.get("warnings", []))
    return f"""<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Brain assurance</title><style>
:root{{--bg:#fff;--fg:#1a1a1a;--mut:#666;--ok:#e7f5ec;--bad:#fdeaea;--sk:#f2f2f2;--line:#ddd}}
@media (prefers-color-scheme: dark){{:root{{--bg:#121212;--fg:#eee;--mut:#aaa;--ok:#14301f;--bad:#3a1717;--sk:#222;--line:#333}}}}
body{{font:14px/1.45 -apple-system,system-ui,sans-serif;background:var(--bg);color:var(--fg);margin:24px 16px;max-width:1400px}}
table{{border-collapse:collapse;width:100%}}td{{border-bottom:1px solid var(--line);padding:6px 8px;vertical-align:top}}
tr.pass td:first-child{{background:var(--ok)}}tr.fail td:first-child{{background:var(--bad)}}tr.skip td:first-child{{background:var(--sk)}}
code{{font-size:11px;word-break:break-all;color:var(--mut)}}</style></head><body>
<h1>Brain assurance: {html.escape(head)}</h1>
<p>{html.escape(res['created_at'])} · {res['runtime_s']} s · private (paper money only)</p>
{f"<h2>Not checked yet</h2><ul>{miss}</ul>" if miss else ""}{f"<h2>Warnings</h2><ul>{warn}</ul>" if warn else ""}
<table>{''.join(rows)}</table></body></html>"""
