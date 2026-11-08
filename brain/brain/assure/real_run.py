"""
The reference learner on the real data: trained on the last fit days, scored on the selection window by the rebuilt
simulator, next to the baselines (research/baselines-v2.json). A sanity read of what a plain point-in-time learner finds
in the real data after realistic costs; the research expects about "skip". Read-only except the result file.

    python -m brain.assure.real_run [--sample 8] [--train-from 2026-10-27]
    -> <DATA>/reports/assure-real-YYYY-MM-DD.json

The test window is never touched (splits.yaml: run once per frozen candidate, never to tune).
"""
from __future__ import annotations

import argparse
import json
import time

import numpy as np
import pandas as pd

from brain.assure.protocol import TrainData, score
from brain.assure.reference import ReferenceLearner
from brain.data import connect, splits
from brain.data.loaders import data_dir
from brain.sim.account import counted, cluster_ci
from brain.sim.env import kappa_from_spec
from brain.sim.evaluate import load_window
from brain.sim.params import SimParams
from brain.sim.quotes import QuoteModel

NUMERIC = ("cp_lrshr_7d", "cp_n_7d", "cp_win_7d", "ps_r_7d", "dd_rate_7d", "b_first_7d", "lf_flip60_7d", "b_n_24h", "leader_n_prior7",
           "b_size_ratio", "log_fee", "venue_via_bot", "sfx_pump", "log_mcap_sol", "leader_sold_at_decision", "mint_first_seen_age_min",
           "cr_seen_prior_7d", "ret_since_first", "dd_from_high", "log_token_age", "m_buyers_5m", "m_buysol_5m", "tracked_active_wallets_1h",
           "hour_sin", "hour_cos")


def log(*a) -> None:
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def features_for(con, sig: pd.DataFrame, venues: list[str]) -> pd.DataFrame:
    """features_entry rows for the window's signals (by episode_id, same order); venue_group one-hot."""
    root = str(data_dir() / "derived" / "features_entry")
    days = sorted(sig["day"].unique())
    files = ", ".join(f"'{root}/day={d}/[!.]*.parquet'" for d in days)
    con.register("_ids", pd.DataFrame({"episode_id": sig["episode_id"].to_numpy()}))
    f = con.execute(f"""SELECT f.* FROM read_parquet([{files}], hive_partitioning=false) f JOIN _ids USING (episode_id)""").df()
    f = f.set_index("episode_id").loc[sig["episode_id"]].reset_index()
    out = f[["episode_id", *NUMERIC]].copy()
    vg = f["venue_group"].fillna("missing").to_numpy()
    for v in venues:
        out[f"venue_group={v}"] = (vg == v).astype(np.float64)
    return out


def concentration(out: pd.DataFrame, sig: pd.DataFrame, p: SimParams) -> dict:
    """Where the P&L comes from: per coin, the top coins' share, without the top 1 % of coins, and near-cap returns."""
    c = counted(out)
    o = out[c].copy()
    if not len(o):
        return {"copies": 0}
    o["ret"] = o["pnl"] / o["stake"]
    o["venue"] = sig.set_index("episode_id").loc[o["episode_id"], "venue_clean"].to_numpy()
    by = o.groupby("mint").agg(pnl=("pnl", "sum"), copies=("pnl", "size"), max_ret=("ret", "max"), venue=("venue", "first")).sort_values("pnl", ascending=False)
    tot = float(o["pnl"].sum())
    k = max(1, int(np.ceil(0.01 * len(by))))
    n_dec = int((~out["reason"].isin(("too-late", "bad-print"))).sum())
    return {"copies": int(len(o)), "coins": int(len(by)), "sum_sol": tot, "top3_share": float(by["pnl"].head(3).sum() / tot) if tot else None,
            "per_decision_without_top1pct_coins": float((tot - by["pnl"].head(k).sum()) / max(n_dec, 1)),
            "per_decision_without_top3_coins": float((tot - by["pnl"].head(3).sum()) / max(n_dec, 1)),
            "copies_returning_over_5x": int((o["ret"] > 5).sum()), "near_cap_returns": int((o["ret"] > 0.9 * p.bad_print_x - 1).sum()),
            "top_coins": [{"mint": m, **{k2: (float(v) if isinstance(v, (float, np.floating)) else (int(v) if isinstance(v, (int, np.integer)) else v))
                                         for k2, v in r.items()}} for m, r in by.head(5).iterrows()],
            "by_venue": {k2: float(v) for k2, v in o.groupby("venue")["pnl"].sum().items()}}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--sample", type=int, default=8, help="train on the signals of 1 in N coins (by mint hash: the tape shrinks too)")
    ap.add_argument("--train-from", default="2026-10-27")
    a = ap.parse_args(argv)
    t0 = time.time()
    con = connect()
    p = SimParams.load()
    qm = QuoteModel.load()
    meta = json.loads((data_dir() / "derived" / "features_entry_meta.json").read_text())
    venues = meta["categories"]["venue_group"]
    fit = splits.period("fit")
    log(f"train window {a.train_from}..{fit.end}, 1 in {a.sample}")
    trw = load_window(a.train_from, fit.end, con=con, params=p, quotes=qm, where=f"hash(mint) % {a.sample} = 0")
    log("train signals", trw.meta)
    trf = features_for(con, trw.data.sig, venues)
    inputs = tuple(c for c in trf.columns if c != "episode_id")
    learner = ReferenceLearner(name="reference-real")
    learner._inputs = lambda: inputs  # the real feature columns instead of the world stand-ins
    pol = learner.fit(TrainData(trw, trf, p, kappa_from_spec()), seed=0)
    log("fit", pol.meta)
    sew = load_window(period="selection", con=con, params=p, quotes=qm)
    log("selection signals", sew.meta)
    sef = features_for(con, sew.data.sig, venues)
    r = score(pol, sew, sef, p, B=500)
    out = r.out
    live = (out["ins_lag_s"].to_numpy() <= 60)
    c = counted(out)
    lp = np.where(c, out["pnl"].to_numpy(), 0.0)[live]
    llo, lhi = cluster_ci(lp, out["mint"].to_numpy()[live], 500, 0) if live.any() else (float("nan"), float("nan"))
    conc = concentration(out, sew.data.sig, p)
    log("concentration", json.dumps(conc, default=str)[:600])
    base = json.loads((data_dir() / "research" / "baselines-v2.json").read_text()).get("selection", {})
    res = {"created_at": pd.Timestamp.now(tz="UTC").isoformat(), "train": {"from": a.train_from, "to": str(fit.end), "sample": a.sample,
           **trw.meta}, "policy": pol.meta, "selection": {"per_decision": r.metrics["per_decision"], "per_copy": r.metrics["per_copy"],
           "account": {k: r.metrics["account"][k] for k in ("net_sol", "final_equity", "max_drawdown_sol", "ruined", "trades", "worst_day_sol")},
           "live_deliverable": {"n": int(live.sum()), "per_decision": float(lp.mean()) if len(lp) else None, "ci95_mint": [llo, lhi]}},
           "baselines_selection": {k: {"per_decision": v.get("per_decision", {}).get("mean_sol"), "account_net": v.get("account", {}).get("net_sol")}
                                   for k, v in base.items() if isinstance(v, dict)},
           "concentration": conc, "quote_model": qm.meta.get("fit_before"), "runtime_s": round(time.time() - t0, 1)}
    f = data_dir() / "reports" / f"assure-real-{pd.Timestamp.now(tz='UTC'):%Y-%m-%d}.json"
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(json.dumps(res, indent=1, default=lambda x: x.item() if hasattr(x, "item") else str(x)))
    log("wrote", f)
    print(json.dumps({"selection_per_decision": res["selection"]["per_decision"], "account": res["selection"]["account"],
                      "baselines": res["baselines_selection"]}, default=str, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
