"""
Train the brain and write a model bundle: `python -m brain.train --mode full|hourly`.

full (from scratch, about 2 h on the Mac):
  1. exit data   each usable fit day (splits.yaml fit, known_at_t, outage-free; subsampled by a hash of episode_id) is
                 loaded twice, base and with one draw of stress.yaml training_chaos; ungated signals are copied at full
                 stake and exited by a mix of behaviour policies (policy.exit.BehaviourMix) in the BatchEnv: one
                 transition per exit decision with the potential-based reward of reward.yaml
  2. exit head   norm fit on those states, supervised pretrain on the remaining value, then IQL
  3. exit choice on selection, B4's entries exited by the IQL head vs by B4's own rule (baselines-v2.json), on the paired
                 per-decision difference; when the rule is better with the CI wholly below 0, the exit network is the rule
                 (built exactly, or distilled: its argmax agrees with the rule on the training states)
  4. entry data  each fit day again: every ungated signal copied at full stake with the chosen exit, base and under its
                 training chaos; target R = g(net SOL P&L) per stake, averaged over the two runs
  5. entry head  5 bootstrapped MLPs per kappa (1.5 and 2.0, reward.yaml kappa_band) on day-balanced weights with input
                 chaos (dropout, cold ledger, noise); the epoch count from splits.yaml's rolling-origin folds inside fit
  6. selection   one simulation of every ungated selection signal with the chosen exit; kappa and margin_c from the
                 grid (reward.yaml kappa_selection_rule: account never below 0.7 SOL, day-block bootstrap p95 max
                 drawdown <= 0.7, copies per day >= MIN_COPIES_PER_DAY, then the best mean net SOL per decision); explore
                 curiosity and rate the same way
  7. bundle      <DATA>/models/<version>/ (export_onnx: ONNX parity 1e-5, sha256, manifest last); the PyTorch weights for
                 hourly warm starts go to <DATA>/models/_state/<version>/ (never pushed)

hourly (minutes): warm-starts from the newest saved state on days newer than it trained on (fit days only: selection
and test stay held out unless --allow-holdout) and on brain_transitions when the export has them (rewards grounded
first: brain.assure.transitions; entry rows train the ensemble, exit decisions join the IQL buffer through
policy.exit.transitions_buffer), a few epochs / IQL steps, the previous margin_c and explore kept.

The test window (splits.yaml test) is never read here. Paper money only: nothing here trades or signs anything.
"""
from __future__ import annotations

import argparse
import gc
import hashlib
import json
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd

from brain.data import connect, splits
from brain.data.loaders import data_dir
from brain.export_onnx import version_now, write_bundle
from brain.features import build, spec
from brain.policy import data as pdata
from brain.policy import entry as pe
from brain.policy import exit as px
from brain.policy.brain import Brain
from brain.policy.nets import HIDDEN, device, setup_threads
from brain.policy.reference import b4
from brain.policy.score import MIN_COPIES_PER_DAY, choose, clean, cleaned, fill_outliers, simulate
from brain.sim import engine
from brain.sim.env import g, kappa_from_spec
from brain.sim.evaluate import evaluate, load_window
from brain.sim.params import Chaos, SimParams
from brain.sim.stress import hour_starts, sample_training_chaos

MODELS = "models"
PER_DAY = 30_000          # signals sampled per fit day (before gates): the big days hold 1.3-1.5 M
TRAJ_PER_DAY = 8_000      # exit trajectories per day (half base, half chaos)
IQL_STEPS = 30_000
KAPPAS = (1.5, 2.0)       # reward.yaml kappa_band
C_GRID = (0.0, 0.25, 0.5, 1.0, 1.5, 2.0, 3.0, 4.0)
CURIOSITY_GRID = (0.0, 0.5, 1.0, 2.0)
EXPLORE_TARGET_PER_DAY = 60    # explore copies wanted per day (about 300 closed trades in a week of paper data)
EXPLORE_WORST_DAY = -0.25      # an explore setting may not lose more than half the daily loss limit on a selection day
MIN_EQUITY = 0.7               # reward.yaml kappa_selection_rule
MAX_DRAWDOWN = 0.7             # on the day-block bootstrap p95 of the max drawdown (maxdd_p95)
EXIT_DATA_VERSION = 2          # bump when the exit data (trajectories, features) change: the cache key
EXIT_CHOICE_SHARE = 0.3        # share of selection signals (hash) the exit choice is scored on
CHAOS_WEIGHT = pe.CHAOS_WEIGHT


def log(*a) -> None:
    print(time.strftime("%H:%M:%S"), *a, flush=True)


# ------------------------------------------------------------------------------------------------------------ steps
def exit_data(con, days: pd.DataFrame, meta, hourly, p, seed: int, per_day: int, traj_per_day: int) -> tuple[px.Buffer, list]:
    parts, info = [], []
    rng = np.random.default_rng(seed)
    for k, (day, n) in enumerate(zip(days["day"], days["n"])):
        t = time.time()
        chaos = sample_training_chaos(rng, hour_starts([day]))
        for tag, c, s in (("base", Chaos(), seed + 2 * k), ("chaos", chaos, seed + 2 * k + 1)):
            w = pdata.day_window(day, int(n), per_day, con, chaos=c, seed=s, params=p)
            ei = pdata.entry_inputs(w, meta)
            ok = np.flatnonzero(~ei.gated)
            take = np.random.default_rng(s).permutation(ok)[: traj_per_day // 2]
            buf = px.collect(w, np.sort(take), px.ExitFeaturizer(ei.ps_r, hourly), chaos=c, seed=s, params=p)
            parts.append(buf)
            info.append({"day": day, "run": tag, "signals": int(len(ei.Z)), "ungated": int(len(ok)), **buf.meta})
            del w, ei
            gc.collect()
        log(f"exit data {day}: {sum(len(b) for b in parts[-2:]):,} transitions ({time.time() - t:.0f} s)")
    return px.Buffer.concat(parts), info


def entry_data(con, days: pd.DataFrame, meta, hourly, p, seed: int, per_day: int, brain_exit_net, exit_norm) -> dict:
    """Per ungated fit signal: Z, the P&L of each run (base, chaos), day, mint, leader."""
    rng = np.random.default_rng(seed + 7)
    Zs, pnl, day_, mint, eid, info = [], [], [], [], [], []
    for k, (day, n) in enumerate(zip(days["day"], days["n"])):
        t = time.time()
        chaos = sample_training_chaos(rng, hour_starts([day]))
        runs = {}
        artifacts = 0
        base_ei = None
        for tag, c, s in (("base", Chaos(), seed + 100 + 2 * k), ("chaos", chaos, seed + 101 + 2 * k)):
            w = pdata.day_window(day, int(n), per_day, con, chaos=c, seed=s, params=p)
            ei = pdata.entry_inputs(w, meta)
            out = simulate(w, ei, px.ExitPolicy(brain_exit_net, exit_norm, px.ExitFeaturizer(ei.ps_r, hourly)), p, c, s)
            out = out[out["stake"].to_numpy() > 0]
            # fill-outlier copies (simulator artifacts, policy.score) are never targets
            usable = ~out["reason"].isin(pe.NOT_DECISIONS).to_numpy() & ~fill_outliers(out)
            artifacts += int(fill_outliers(out).sum())
            runs[tag] = out[usable].set_index("episode_id")
            if tag == "base":
                base_ei, base_sig = ei, w.data.sig
            del w
            gc.collect()
        sig = base_sig
        rows = np.flatnonzero(~base_ei.gated)
        e = sig["episode_id"].to_numpy()[rows]
        P = np.full((len(rows), 2), np.nan)
        for j, tag in enumerate(("base", "chaos")):
            r = runs[tag]
            hit = pd.Index(r.index).get_indexer(e)
            ok = hit >= 0
            P[ok, j] = r["pnl"].to_numpy()[hit[ok]]
        keep = np.isfinite(P).any(1)
        Zs.append(base_ei.Z[rows][keep])
        pnl.append(P[keep])
        day_.append(np.full(int(keep.sum()), day))
        mint.append(sig["mint"].to_numpy()[rows][keep])
        eid.append(e[keep])
        info.append({"day": day, "rows": int(keep.sum()), "fill_outliers_dropped": artifacts, "mean_pnl_base": float(np.nanmean(P[keep, 0])),
                     "mean_pnl_chaos": float(np.nanmean(P[keep, 1]))})
        log(f"entry data {day}: {int(keep.sum()):,} rows, mean pnl base {info[-1]['mean_pnl_base']:+.5f} "
            f"chaos {info[-1]['mean_pnl_chaos']:+.5f} ({time.time() - t:.0f} s)")
    return {"Z": np.concatenate(Zs), "pnl": np.concatenate(pnl), "day": np.concatenate(day_), "mint": np.concatenate(mint),
            "episode_id": np.concatenate(eid), "info": info}


def entry_targets(ed: dict, kappa: float, actions, p, chaos_weight: float = None) -> np.ndarray:
    """
    R per non-zero stake: g(P&L) of the base run and of the training-chaos run, weighted (1 - w, w); a signal one run
    could not score (too late under a backlog hour) takes the other run's R.
    """
    w = CHAOS_WEIGHT if chaos_weight is None else chaos_weight
    cols = []
    for f in actions:
        if f <= 0:
            continue
        # a full-stake run scaled to f with fees unchanged would be exact; the fee share is small next to the stake, so
        # fractional stakes (only with --actions 5) scale the whole P&L
        R = g(ed["pnl"] * f, kappa)
        base, ch = R[:, 0], R[:, 1]
        cols.append(np.where(np.isfinite(base) & np.isfinite(ch), (1 - w) * base + w * ch, np.where(np.isfinite(base), base, ch)))
    return np.column_stack(cols)


def train_entry(ed: dict, kappa: float, actions, meta, p, seed: int, dev, members: int = pe.MEMBERS,
                chaos_weight: float | None = None) -> tuple[list, dict]:
    Y = entry_targets(ed, kappa, actions, p, chaos_weight)
    aug = pe.Augment.for_entry(meta)
    mask = pe.input_mask(meta["columns"])
    days = sorted(set(ed["day"]))
    folds = pdata.fold_days(days)
    w = np.ones(len(Y))
    epochs, rec = pe.early_stop(ed["Z"], Y, w, ed["day"], folds, aug=aug, mask=mask, seed=seed, dev=dev)
    log(f"entry kappa {kappa}: {epochs} epochs from {len(folds)} folds " +
        ", ".join(f"[{r.get('best_epoch')}: rho {r.get('spearman', float('nan')):+.3f}]" for r in rec))
    mem = pe.fit_ensemble(ed["Z"], Y, w, ed["day"], epochs=epochs, members=members, seed=seed, aug=aug, mask=mask, dev=dev)
    return mem, {"kappa": kappa, "epochs": epochs, "folds": rec, "rows": int(len(Y)), "days": days}


def exit_choice(w_sel, ps_r, p, brain_exit, hourly, seed: int = 0) -> dict:
    """
    B4's entries on a hash subsample of selection, exited by the IQL head and by B4's rule, fill-outlier copies (simulator
    artifacts, policy.score) counted as skips. The two exits do not count the same copies (a longer hold blocks later
    signals on the coin), so their per-copy means are not paired. The choice is pre-declared on the one paired
    statistic: the per-decision difference IQL minus rule over the same signals (a skip or a blocked copy scores 0),
    mint-clustered CI; the rule replaces IQL only when that CI lies wholly below 0. The per-copy difference is
    reported with its own CI.
    """
    from brain.gate import per_copy_diff
    from brain.sim.account import paired_diff
    entry, rule, info = b4(p)
    eids = w_sel.data.sig["episode_id"].to_numpy()
    rows = np.flatnonzero((pd.util.hash_array(eids) % 1000) < int(EXIT_CHOICE_SHARE * 1000))
    res = {}
    for name, ex in (("iql", brain_exit(px.ExitFeaturizer(ps_r, hourly))), (rule.name, rule)):
        t = time.time()
        r = cleaned(evaluate(w_sel, entry, ex, p, rows=rows, B=10, features=True, keep_book=True), w_sel, p, B=300, seed=seed)
        res[name] = r
        pc = r["metrics"]["per_copy"]
        log(f"exit choice {name}: per copy {pc['mean_sol']:+.5f} {np.round(pc['ci95_mint'], 5).tolist()} n {pc['n']}, "
            f"{r['n_outliers']} fill outliers skipped ({time.time() - t:.0f} s)")
    d = paired_diff(res["iql"]["out"], res[rule.name]["out"], B=500)
    out = {"rule": rule.name, "rows": int(len(rows)), "share": EXIT_CHOICE_SHARE,
           **{k: {"per_copy": v["metrics"]["per_copy"]["mean_sol"], "ci95_mint": v["metrics"]["per_copy"]["ci95_mint"],
                  "n": v["metrics"]["per_copy"]["n"], "per_decision": v["metrics"]["per_decision"]["mean_sol"], "fill_outliers": v["n_outliers"]}
              for k, v in res.items()},
           "paired_per_decision_iql_minus_rule": d}
    pc = per_copy_diff(res["iql"]["out"], res[rule.name]["out"], B=500, seed=seed)
    out["per_copy_iql_minus_rule"] = {**pc, "note": "different copy sets: reported, not the decision"}
    out.update(exit_winner(d, rule.name))
    return out


def exit_winner(paired: dict, rule: str) -> dict:
    """exit_choice's pre-declared decision on the paired per-decision difference (iql - rule) and its mint CI."""
    lo, hi = paired["ci95_mint"]
    return {"chosen": rule if hi < 0 else "iql", "significant": bool(lo > 0 or hi < 0),
            "decision_rule": "the rule only when the paired per-decision CI (iql - rule) lies wholly below 0, else iql"}


def maxdd_p95(acc: pd.DataFrame, days, bankroll: float, B: int = 1000, seed: int = 0) -> float:
    """
    reward.yaml kappa_selection_rule: the 95th percentile of the account's max drawdown over a day-block bootstrap (the
    selection days drawn with replacement, each day's copies (by decision day) with their closes in time order;
    research reward-design/10_choose.py).
    """
    days = list(days)
    if not len(acc) or not days:
        return 0.0
    a = acc.sort_values("close_at", kind="stable")
    byday = {d: x["pnl_acct"].to_numpy(np.float64) for d, x in a.groupby("open_day")}
    rng = np.random.default_rng(seed)
    out = np.empty(B)
    for i in range(B):
        pnl = np.concatenate([byday.get(d, np.zeros(0)) for d in rng.choice(days, len(days), replace=True)])
        eq = bankroll + np.r_[0.0, np.cumsum(pnl)]
        out[i] = float((np.maximum.accumulate(eq) - eq).max())
    return float(np.percentile(out, 95))


def select(full: pd.DataFrame, w_sel, ens_by_kappa: dict, ei, p) -> dict:
    """The (kappa, margin_c) grid on selection from one simulation; reward.yaml's rule plus the copies-per-day floor."""
    rows = []
    qs = {}
    for kappa, ens in ens_by_kappa.items():
        q = ens.q(ei.Z)
        qs[kappa] = q
        mu, sd = ens.stats(q)
        for c in C_GRID:
            frac = np.where(ei.gated, 0.0, ens.decide(q, c))
            r = choose(full, w_sel, frac, p, B=200)
            m = r["metrics"]
            a = m["account"]
            rows.append({"kappa": kappa, "margin_c": c, "per_decision": m["per_decision"]["mean_sol"], "per_copy": m["per_copy"]["mean_sol"],
                         "per_copy_ci95": m["per_copy"]["ci95_mint"], "copies": m["per_copy"]["n"], "copies_per_day": a["copies_per_day_mean"],
                         "account_net": a["net_sol"], "min_equity": a["min_equity"], "max_drawdown": a["max_drawdown_sol"],
                         "max_drawdown_p95": maxdd_p95(r["acc"], w_sel.days, p.bankroll_sol), "wanted": int((frac > 0).sum())})
            log(f"  kappa {kappa} c {c}: per decision {rows[-1]['per_decision']:+.6f} per copy {rows[-1]['per_copy']:+.5f} "
                f"copies/day {rows[-1]['copies_per_day']:.0f} account {rows[-1]['account_net']:+.3f} min eq {rows[-1]['min_equity']:.3f} "
                f"maxDD p95 {rows[-1]['max_drawdown_p95']:.3f}")
    t = pd.DataFrame(rows)
    ok = t[(t["min_equity"] >= MIN_EQUITY) & (t["max_drawdown_p95"] <= MAX_DRAWDOWN) & (t["copies_per_day"] >= MIN_COPIES_PER_DAY)]
    rule = "reward.yaml kappa_selection_rule + copies per day floor"
    if not len(ok):
        ok = t[t["copies_per_day"] >= MIN_COPIES_PER_DAY]
        rule = "no setting keeps the account >= 0.7 with the copies floor: best per decision among those with enough copies"
    if not len(ok):
        ok = t
        rule = "no setting reaches the copies floor: best per decision overall"
    best = ok.sort_values(["per_decision", "kappa", "margin_c"], ascending=[False, True, False]).iloc[0]
    return {"kappa": float(best["kappa"]), "margin_c": float(best["margin_c"]), "rule": rule, "grid": rows, "q": qs}


def calibrate_explore(full, w_sel, ens, q, ei, p, seed: int = 0) -> dict:
    """Curiosity: the largest whose explore account never loses more than EXPLORE_WORST_DAY a day; rate for the target."""
    rows = []
    days = max(1, len(w_sel.days))
    route = np.random.default_rng(seed).random(len(ei.Z))
    for cur in CURIOSITY_GRID:
        frac = np.where(ei.gated, 0.0, ens.explore(q, cur, np.random.default_rng(seed + 1)))
        want = float((frac > 0).sum()) / days
        rate = float(np.clip(EXPLORE_TARGET_PER_DAY / max(want, 1e-9), 0.01, 0.25))
        m = choose(full, w_sel, np.where(route < rate, frac, 0.0), p, B=100)["metrics"]
        rows.append({"curiosity": cur, "rate": rate, "wanted_per_day_all": want, "copies_per_day": m["account"]["copies_per_day_mean"],
                     "worst_day": m["account"]["worst_day_sol"], "account_net": m["account"]["net_sol"], "per_copy": m["per_copy"]["mean_sol"]})
    ok = [r for r in rows if r["worst_day"] >= EXPLORE_WORST_DAY]
    best = max(ok, key=lambda r: r["curiosity"]) if ok else min(rows, key=lambda r: r["curiosity"])
    return {"rate": best["rate"], "curiosity": best["curiosity"], "grid": rows,
            "rule": f"largest curiosity with the explore account's worst selection day >= {EXPLORE_WORST_DAY} SOL; rate for {EXPLORE_TARGET_PER_DAY} copies/day"}


def baseline_metrics() -> dict:
    from brain.policy.reference import baselines
    js = baselines()
    keep = lambda m: {"per_decision": m["per_decision"]["mean_sol"], "per_copy": m["per_copy"]["mean_sol"],  # noqa: E731
                      "per_copy_ci95": m["per_copy"]["ci95_mint"], "account_net": m["account"]["net_sol"],
                      "max_drawdown": m["account"]["max_drawdown_sol"], "copies_per_day": m["account"]["copies_per_day_mean"]}
    return {"source": "research/baselines-v2.json", "created_at": js.get("created_at"), "b4_rule": {"veto_q20": js["b4_rule"]["veto"]["q20_cp_lrshr_7d"],
            "exit": js["b4_rule"]["exit"]}, "selection": {k: keep(js["selection"][k]) for k in ("B1", "B2", "B4")}}


# ------------------------------------------------------------------------------------------------------------ modes
def full(a) -> Path:
    t0 = time.time()
    setup_threads()
    dev = device(a.device != "cpu")
    p = SimParams.load()
    con = connect()
    meta = build.load_meta()
    hourly = build.load_hourly()
    actions = pe.ALL_ACTIONS if a.actions == 5 else pe.ACTIONS
    days = pdata.usable_days("fit", con)
    if a.days:
        days = days[days["day"].isin(a.days.split(","))].reset_index(drop=True)
    log(f"fit days: {', '.join(days['day'])} (sampled to {a.per_day:,} signals per day)")
    timing = {}
    # 1-2 exit
    t = time.time()
    key = hashlib.sha1(json.dumps([list(days["day"]), a.per_day, a.traj_per_day, a.seed, EXIT_DATA_VERSION]).encode()).hexdigest()[:12]
    cache = models_dir(a) / "_work" / f"exit-data-{key}.npz"
    if a.reuse_exit_data and cache.is_file():
        buf = px.Buffer.load(cache)
        xinfo = json.loads(cache.with_suffix(".json").read_text())
        log(f"exit data reused: {cache.name} ({len(buf):,} transitions)")
    else:
        buf, xinfo = exit_data(con, days, meta, hourly, p, a.seed, a.per_day, a.traj_per_day)
        cache.parent.mkdir(parents=True, exist_ok=True)
        buf.save(cache)
        cache.with_suffix(".json").write_text(json.dumps(xinfo, default=str))
    timing["exit_data_s"] = round(time.time() - t)
    xnorm = px.fit_exit_norm(buf.X)
    t = time.time()
    log(f"IQL on {len(buf):,} transitions, {a.iql_steps} steps ({dev})")
    iql, iql_info = px.fit_exit(buf, xnorm, steps=a.iql_steps, seed=a.seed, dev=dev)
    timing["iql_s"] = round(time.time() - t)
    # 3 exit choice on selection
    t = time.time()
    w_sel = load_window(period="selection", con=con, params=p, where=pdata.share_where(a.sel_share))
    log(f"selection window: {w_sel.meta}")
    ei_sel = pdata.entry_inputs(w_sel, meta)
    choice = exit_choice(w_sel, ei_sel.ps_r, p, lambda fz: px.ExitPolicy(iql, xnorm, fz), hourly, a.seed)
    exit_net, exit_info = iql, {"kind": "iql", **iql_info}
    if choice["chosen"] != "iql":
        from brain.policy.reference import exit_rule
        rule = exit_rule(choice["chosen"])
        if px.as_threshold(rule) is not None:
            exit_net = px.rule_net(rule, xnorm)
            exit_info = {"kind": "rule_net", "rule": rule.name, "iql": iql_info}
            log(f"exit: {rule.name} beat IQL on selection; the exit network is the rule, built exactly")
        else:
            exit_net, dinfo = px.distill(rule, buf, xnorm, seed=a.seed, dev=dev)
            exit_info = {"kind": "distilled_rule", **dinfo, "iql": iql_info}
            log(f"exit: {rule.name} beat IQL on selection; distilled (agreement {dinfo['agreement']:.4f})")
    timing["exit_choice_s"] = round(time.time() - t)
    check_x = px.normalise(buf.X[np.random.default_rng(0).integers(0, len(buf), 2048)], xnorm)
    del buf
    gc.collect()
    # 4-5 entry
    t = time.time()
    ed = entry_data(con, days, meta, hourly, p, a.seed, a.per_day, exit_net, xnorm)
    timing["entry_data_s"] = round(time.time() - t)
    t = time.time()
    ens_by_kappa, einfo = {}, {}
    for kappa in KAPPAS:
        mem, info = train_entry(ed, kappa, actions, meta, p, a.seed, dev, chaos_weight=a.chaos_weight)
        ens_by_kappa[kappa] = pe.Ensemble(mem, actions)
        einfo[str(kappa)] = info
    timing["entry_train_s"] = round(time.time() - t)
    # 6 selection
    t = time.time()
    full_sel = simulate(w_sel, ei_sel, px.ExitPolicy(exit_net, xnorm, px.ExitFeaturizer(ei_sel.ps_r, hourly)), p, Chaos(), 0)
    n_art = int(fill_outliers(full_sel).sum())
    log(f"selection: {int((full_sel['stake'] > 0).sum()):,} candidate copies simulated, {n_art} fill outliers set to skip ({time.time() - t:.0f} s)")
    full_sel = clean(full_sel)  # kappa, margin and curiosity are never chosen for what a simulator artifact pays
    sel = select(full_sel, w_sel, ens_by_kappa, ei_sel, p)
    kappa, margin = sel["kappa"], sel["margin_c"]
    ens = ens_by_kappa[kappa]
    explore = calibrate_explore(full_sel, w_sel, ens, sel["q"][kappa], ei_sel, p, a.seed)
    timing["selection_s"] = round(time.time() - t)
    log(f"chosen: kappa {kappa}, margin_c {margin} ({sel['rule']}); explore rate {explore['rate']:.3f} curiosity {explore['curiosity']}")
    # 7 bundle
    version = version_now()
    brain = Brain(ens.members, exit_net, meta, xnorm, actions, margin, {"rate": explore["rate"], "curiosity": explore["curiosity"]})
    metrics = {
        "validation": {"entry": einfo, "exit": {k: v for k, v in exit_info.items() if k != "history"}, "exit_choice": choice},
        "selection": {"chosen": {"kappa": kappa, "margin_c": margin, "rule": sel["rule"]}, "grid": sel["grid"], "explore": explore,
                      "fill_outliers_skipped": n_art},
        "baseline": baseline_metrics(),
        "data": {"trained_days": list(days["day"]), "paper_transitions_range": None,  # brain.gate trained_on: no holdout day
                 "fit_days": days.to_dict(orient="records"), "per_day": a.per_day, "traj_per_day": a.traj_per_day, "exit_runs": xinfo,
                 "entry_runs": ed["info"], "entry_rows": int(len(ed["Z"])), "transitions": int(iql_info["transitions"])},
        "training": {"mode": "full", "seed": a.seed, "sel_share": a.sel_share, "chaos_weight": a.chaos_weight, "device": str(dev), "iql_steps": a.iql_steps, "timing_s": timing,
                     "chaos": "stress.yaml training_chaos: one draw per day for half the runs; input chaos on the entry rows"},
        "stress": {"note": "scored by python -m brain.gate (gate-report.json next to the bundle)"},
    }
    out = write_bundle(models_dir(a), version, ens.members, exit_net, meta, xnorm, actions=actions, margin_c=margin,
                       explore=brain.explore, metrics=metrics, check_entry=ei_sel.Z[:4096], check_exit=check_x)
    brain.meta = {"version": version, "trained_days": list(days["day"]), "kappa": kappa, "exit_kind": exit_info["kind"]}
    brain.save(models_dir(a) / "_state" / version)
    log(f"bundle {out} ({time.time() - t0:.0f} s total)")
    return out


def models_dir(a) -> Path:
    return Path(a.out) if getattr(a, "out", "") else data_dir() / MODELS


def latest_state(root: Path | None = None) -> Path | None:
    d = (root or data_dir() / MODELS) / "_state"
    if not d.is_dir():
        return None
    vs = sorted(x for x in d.iterdir() if (x / "brain.pt").is_file())
    return vs[-1] if vs else None


def transitions_rows(meta) -> tuple[pd.DataFrame, pd.DataFrame, list | None]:
    """
    brain_transitions from the export (Brain and Explore accounts): (one row per closed position with its entry features
    and net P&L, the exit rows, [first ts, last ts] of the rows read). Empty and None when the export has no such table.
    """
    from brain.assure.transitions import from_brain_transitions
    from brain.data.loaders import export_dir
    d = export_dir() / "brain_transitions"
    # The pull makes the folder even when the server has no rows yet (no paper trades before the stream is back).
    if not d.is_dir() or not any(d.glob("[!.]*.parquet")):
        return pd.DataFrame(), pd.DataFrame(), None
    import duckdb
    con = duckdb.connect()
    rows = con.execute(f"SELECT * FROM read_parquet('{d}/[!.]*.parquet', union_by_name=true) WHERE account IN ('brain', 'explore')").df()
    # Only transitions dated in fit: with rolling periods (splits.yaml) newer ones fall in embargo / selection / test,
    # and learning from them would score selection in-sample. They join once the window has moved past them.
    from brain.data import splits
    ts = pd.to_datetime(rows["ts"], utc=True)
    keep = (ts < splits.period("fit").end).to_numpy()
    rows, ts = rows[keep].reset_index(drop=True), ts[keep]
    span = [ts.min().isoformat(), ts.max().isoformat()] if len(rows) else None
    return from_brain_transitions(rows, meta["columns"]), rows[rows["kind"] == "exit"].reset_index(drop=True), span


def exit_norms(root: Path):
    """model_version -> the exit Norm its bundle's manifest declares (None when that bundle is not under `root`)."""
    cache: dict = {}

    def norm_of(v):
        if v not in cache:
            f = Path(root) / str(v) / "manifest.json"
            x = json.loads(f.read_text())["exit"] if v and f.is_file() else None
            cache[v] = spec.Norm(list(x["features"]), np.asarray(x["norm"]["mean"]), np.asarray(x["norm"]["std"])) if x else None
        return cache[v]
    return norm_of


def hourly_mode(a) -> Path | None:
    t0 = time.time()
    setup_threads()
    dev = device(a.device != "cpu")
    sd = latest_state(models_dir(a))
    if sd is None:
        log("no saved brain state: run --mode full first")
        return None
    brain = Brain.load(sd)
    p = SimParams.load()
    con = connect()
    meta = build.load_meta()
    hourly = build.load_hourly()
    trained = set(brain.meta.get("trained_days", []))
    periods = ("fit", "embargo", "selection", "test") if a.allow_holdout else ("fit",)
    cand = pd.concat([pdata.usable_days(per, con) for per in periods], ignore_index=True)
    days = cand[cand["day"].isin(a.days.split(","))] if a.days else cand[~cand["day"].isin(trained) & (cand["day"] > max(trained, default=""))]
    days = days.reset_index(drop=True)
    tr, tr_exit, tr_span = transitions_rows(meta)
    if not len(days) and not len(tr):
        log(f"nothing new since {sd.name}: no new usable days (holdout {'allowed' if a.allow_holdout else 'kept out'}) and no brain_transitions")
        return None
    per_day = min(a.per_day, 10_000)
    info = {"from_state": sd.name, "days": list(days["day"]), "transitions": int(len(tr))}
    kappa = float(brain.meta.get("kappa", kappa_from_spec()))
    members, exit_net = brain.members, brain.exit_net
    trg = None
    if len(tr):  # the paper account's closes, re-valued as the simulator values a sale before anything learns from them
        from brain.assure.transitions import ground_rewards
        from brain.sim.tape import T0_MS, load_tape
        t_lo = pd.Timestamp(int(tr["close_ms"].min()) + T0_MS - 86_400_000, unit="ms", tz="UTC")
        t_hi = pd.Timestamp(int(tr["close_ms"].max()) + T0_MS + 7 * 3_600_000, unit="ms", tz="UTC")
        tape = load_tape(con, tr["mint"].unique(), t_lo, t_hi)
        trg = ground_rewards(tr, tape, p)
        trg = trg[trg["stake"].to_numpy() > 0]
        info["transitions_grounded"] = int(trg["grounded"].sum())
    if brain.meta.get("exit_kind", "iql") == "iql" and tuple(brain.exit_net.hidden) == HIDDEN:
        parts = []
        if len(days):
            parts.append(exit_data(con, days, meta, hourly, p, a.seed, per_day, min(a.traj_per_day, 4000))[0])
        if trg is not None and len(tr_exit):
            tb = px.transitions_buffer(tr_exit, trg, exit_norms(models_dir(a)), kappa, p.tx_cost_sol)
            parts.append(tb)
            info["exit_transitions"] = tb.meta
        buf = px.Buffer.concat(parts) if parts else px.empty_buffer()
        if len(buf):
            exit_net, iql_info = px.fit_exit(buf, brain.exit_norm, steps=min(a.iql_steps, 4000), seed=a.seed, dev=dev, init=brain.exit_net)
            info["exit"] = {k: v for k, v in iql_info.items() if k != "history"}
    else:  # a rule exit (rule_net) is kept as it is: IQL steps would turn it back into a learned head
        info["exit"] = {"kept": brain.meta.get("exit_kind", "rule_net")}
    if len(days):
        ed = entry_data(con, days, meta, hourly, p, a.seed, per_day, exit_net, brain.exit_norm)
        Z, Y, day = ed["Z"], entry_targets(ed, kappa, brain.actions, p, a.chaos_weight), ed["day"]
    else:
        Z, Y, day = np.zeros((0, len(meta["columns"])), np.float32), np.zeros((0, len(brain.actions) - 1)), np.zeros(0, dtype=object)
    if trg is not None and len(trg):
        Zt = trg[meta["columns"]].to_numpy(np.float32)
        Rt = g(trg["reward"].to_numpy() * (p.max_trade_sol / trg["stake"].to_numpy()), kappa)
        Z = np.vstack([Z, Zt])
        Y = np.vstack([Y, np.repeat(Rt[:, None], Y.shape[1] or 1, axis=1)])
        day = np.concatenate([day, np.full(len(Zt), "paper")])
    members = pe.fit_ensemble(Z, Y, np.ones(len(Y)), day, epochs=a.hourly_epochs, members=len(brain.members), seed=a.seed,
                              aug=pe.Augment.for_entry(meta), mask=pe.input_mask(meta["columns"]), dev=dev, init=brain.members, lr=pe.LR / 3)
    version = version_now()
    # what this bundle and every state it warm-started from learned from (brain.gate trained_on refuses holdout days)
    trained_days = sorted(trained | set(days["day"]))
    spans = [x for x in (brain.meta.get("paper_transitions_range"), tr_span if len(tr) else None) if x]
    tr_range = [min(x[0] for x in spans), max(x[1] for x in spans)] if spans else None
    nb = Brain(members, exit_net, meta, brain.exit_norm, brain.actions, brain.margin_c, brain.explore,
               {"version": version, "trained_days": trained_days, "paper_transitions_range": tr_range, "kappa": kappa,
                "warm_start": sd.name, "exit_kind": brain.meta.get("exit_kind", "iql")})
    check_e = Z[:4096] if len(Z) else np.zeros((8, len(meta["columns"])), np.float32)
    check_x = np.random.default_rng(0).normal(0, 1, (512, len(brain.exit_norm.columns))).astype(np.float32)
    metrics = {"validation": {"hourly": info}, "selection": {"note": "margin_c and explore kept from " + sd.name},
               "baseline": baseline_metrics(), "training": {"mode": "hourly", "seconds": round(time.time() - t0)},
               "data": {"trained_days": trained_days, "paper_transitions_range": tr_range, "new_days": list(days["day"])}}
    out = write_bundle(models_dir(a), version, members, exit_net, meta, brain.exit_norm, actions=brain.actions, margin_c=brain.margin_c,
                       explore=brain.explore, metrics=metrics, check_entry=check_e, check_exit=check_x)
    nb.save(models_dir(a) / "_state" / version)
    log(f"hourly bundle {out} ({time.time() - t0:.0f} s)")
    return out


# ------------------------------------------------------------------------------------------------------------ assure
def assure_learner():
    """brain.assure.protocol: the trainer's learner for the learning checks on synthetic worlds."""
    from brain.policy.learner import BrainLearner
    return BrainLearner()


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="python -m brain.train", description=__doc__.split("\n\n")[0])
    ap.add_argument("--mode", choices=("full", "hourly"), default="full")
    ap.add_argument("--per-day", type=int, default=PER_DAY, help="signals sampled per fit day (hash of episode_id)")
    ap.add_argument("--traj-per-day", type=int, default=TRAJ_PER_DAY, help="exit trajectories per day")
    ap.add_argument("--iql-steps", type=int, default=IQL_STEPS)
    ap.add_argument("--hourly-epochs", type=int, default=2)
    ap.add_argument("--reuse-exit-data", action="store_true", help="reuse the cached exit trajectories of an identical earlier run")
    ap.add_argument("--chaos-weight", type=float, default=CHAOS_WEIGHT, help="weight of the training-chaos run in the entry target")
    ap.add_argument("--days", default="", help="comma-separated days (default: every usable fit day / every new day)")
    ap.add_argument("--allow-holdout", action="store_true", help="hourly: also train on selection/test days (brain.gate rejects the bundle)")
    ap.add_argument("--sel-share", type=float, default=1.0, help="share of selection signals (hash) for the exit choice and calibration")
    ap.add_argument("--out", default="", help="models dir (default <DATA>/models)")
    ap.add_argument("--actions", type=int, choices=(2, 5), default=2, help="2 = skip/full (owner decision), 5 = CONTRACT.md's list")
    ap.add_argument("--device", default="auto", help="auto (Apple GPU when available) or cpu")
    ap.add_argument("--seed", type=int, default=0)
    a = ap.parse_args(argv)
    out = full(a) if a.mode == "full" else hourly_mode(a)
    if out is not None:
        print(json.dumps({"bundle": str(out)}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
