"""
The bars the brain must beat, re-scored on the rebuilt simulator (brain/sim, sim.yaml): every number the promotion gate
compares with comes from here.

  skip  skip everything: 0 per decision, the account stays at 1 SOL (the default the research recommends)
  B1    copy all: every copy-eligible leader buy at 0.1 SOL, exit = follow the leader's sells (model.ts copySell:
        the leader's sold fraction of its balance, >= 90 % = all), with the brain's hard stops (-60 %, 24 h)
  B2    today's rules, point in time: leaders whose copy weight (weight_history, the last change before the decision)
        is > 0, stake copySize(weight) = min(0.1, 1 SOL x weight) (0 below 0.01), pump.fun coins only (the rug screen
        can't be replayed; the unscreened-coin rule of learning/copyable.ts), exit = the config fallback sl35 / tp300 plus
        following the leader (the learned-exit tuner never qualified a rule: research/baselines B2-tuner), max hold 24 h
  B4    the hand-rule bar: the features.yaml gates, then a veto of leaders with no copy history (cp_n_7d = 0) and of the
        bottom fifth of the mirror-ledger copy return (cp_lrshr_7d <= its fit-period 20th percentile), full stake, and the
        best simple exit of EXIT_CANDIDATES chosen on the selection window (splits.yaml: selection chooses the B4 exit).
        cp_n_7d / cp_lrshr_7d are read from derived/features_entry (brain/features/build.py, the spec implementation): the
        very numbers the brain is trained on, at T + 1 s, so the bar and the brain veto on the same thing. The simulator's
        own ledger (brain.sim.ledger) is only cross-checked against them (b4_rule.ledger_crosscheck).

Selection (10-31..11-01) and test (11-02 onward) are scored on the same population (known_at_t, not crosses_outage,
leader buy >= 0.2 SOL); test is reported separately and never used for a choice.

    python -m brain.baselines            # -> <DATA>/research/baselines-v2.json, per-signal outcomes in research/baselines-v2/

The JSON records the derive build it was made on (build.derive_built_at, derived/_meta.json built_at) and the data end
(label_end_t): a gate reading it can refuse a baseline made on another build. The run refuses to start when
features_entry is older than the derive build, and checks that no test signal is at or after the data end.
"""
from __future__ import annotations

import json
import time
from dataclasses import dataclass

import numpy as np
import pandas as pd

from brain.data import connect, splits
from brain.data.loaders import data_dir
from brain.sim.account import cluster_ci, counted
from brain.features.build import load_entry, load_meta
from brain.sim.evaluate import Window, data_end_ts, evaluate, load_window
from brain.sim.ledger import built_on, cp_features, ledger_meta, load_ledger
from brain.sim.params import SimParams
from brain.sim.quotes import QuoteModel
from brain.sim.tape import T0_MS, to_ms

OUT_JSON = "research/baselines-v2.json"
OUT_DIR = "research/baselines-v2"
VETO_Q = 0.20
COPY_BUDGET_SOL = 1.0  # COPY_BUDGET_SOL: copySize = min(COPY_MAX_TRADE_SOL, budget x weight)


def log(*a) -> None:
    print(time.strftime("%H:%M:%S"), *a, flush=True)


# ------------------------------------------------------------------------------------------------------------ exits
def follow_leader(st: dict, d=None) -> np.ndarray:
    """model.ts / copy engine: on the leader's sell, sell the same fraction of what we hold (>= 90 % of its balance = all)."""
    f = st["leader_sell_frac"]
    return np.where(st["event_leader_sell"], np.where(f >= 0.9, 1.0, f), 0.0)


@dataclass(frozen=True)
class RuleExit:
    """A simple exit: follow the leader and/or sell everything at a stop, a take-profit, a trailing stop or a time."""
    name: str
    follow: bool = True
    sl: float | None = None
    tp: float | None = None
    trail: float | None = None
    arm: float = 0.0
    time_min: float | None = None

    def __call__(self, st: dict, d=None) -> np.ndarray:
        r = st["ret_now"]
        out = follow_leader(st) if self.follow else np.zeros(len(r))
        all_ = np.zeros(len(r), bool)
        with np.errstate(invalid="ignore"):
            if self.sl is not None:
                all_ |= r <= -self.sl
            if self.tp is not None:
                all_ |= r >= self.tp
            if self.trail is not None:
                all_ |= (st["peak_ret"] >= self.arm) & (st["drawdown_from_peak"] >= self.trail)
            if self.time_min is not None:
                all_ |= st["minutes_held"] >= self.time_min
        return np.where(all_, 1.0, out)


B1_EXIT = RuleExit("follow")
B2_EXIT = RuleExit("follow|sl35|tp300", sl=0.35, tp=3.0)
EXIT_CANDIDATES = (
    RuleExit("follow"),
    RuleExit("follow|t1", time_min=1), RuleExit("follow|t2", time_min=2), RuleExit("follow|t5", time_min=5),
    RuleExit("follow|t10", time_min=10), RuleExit("follow|t30", time_min=30),
    RuleExit("t1", follow=False, time_min=1), RuleExit("t5", follow=False, time_min=5),
    RuleExit("follow|trail10", trail=0.10), RuleExit("follow|trail20", trail=0.20),
    RuleExit("follow|sl30", sl=0.30), RuleExit("follow|tp50", tp=0.5), RuleExit("follow|tp100", tp=1.0),
    RuleExit("follow|trail10|t10", trail=0.10, time_min=10),
)


# ------------------------------------------------------------------------------------------------------------ entries
def b1_entry(p: SimParams):
    return lambda s: np.full(len(s), p.max_trade_sol)


def weights_at(con, wallets, t_ms) -> np.ndarray:
    """Each wallet's copy weight at t: weight_history's last change strictly before t (0 when none)."""
    wh = con.execute("SELECT wallet, ts, new_weight FROM weight_history ORDER BY wallet, ts").df()
    if wh.empty:
        return np.zeros(len(t_ms))
    codes = pd.Index(pd.unique(pd.concat([wh["wallet"], pd.Series(list(wallets))], ignore_index=True)))
    wk = (codes.get_indexer(wh["wallet"]).astype(np.int64) << 42) | to_ms(wh["ts"])
    o = np.argsort(wk, kind="stable")
    wk, w = wk[o], wh["new_weight"].to_numpy(np.float64)[o]
    q = codes.get_indexer(pd.Series(list(wallets))).astype(np.int64)
    j = np.searchsorted(wk, (q << 42) | np.asarray(t_ms, dtype=np.int64), "left") - 1
    same = (j >= 0) & ((wk[np.clip(j, 0, None)] >> 42) == q)
    return np.where(same, w[np.clip(j, 0, None)], 0.0)


def b2_entry(con, p: SimParams):
    def entry(s: pd.DataFrame) -> np.ndarray:
        w = weights_at(con, s["leader"], s["t_dec"].to_numpy())
        size = np.minimum(p.max_trade_sol, COPY_BUDGET_SOL * np.maximum(w, 0))
        size = np.where(size >= p.min_trade_sol, size, 0.0)
        return np.where(s["mint"].str.endswith("pump").to_numpy(), size, 0.0)
    return entry


CP = ["cp_n_7d", "cp_lrshr_7d"]
FIT_WHERE = "period = 'fit' AND known_at_t AND NOT crosses_outage AND leader_sol >= 0.2"


def entry_cp(con, sig: pd.DataFrame) -> pd.DataFrame:
    """cp_n_7d / cp_lrshr_7d of each signal from derived/features_entry, by episode_id (NaN for an episode it lacks)."""
    days = ", ".join(f"'{d}'" for d in sorted(sig["day"].unique()))
    con.register("_b4_ids", pd.DataFrame({"episode_id": sig["episode_id"].to_numpy(np.int64)}))
    try:
        f = load_entry(where=f"day IN ({days}) AND episode_id IN (SELECT episode_id FROM _b4_ids)", columns=["episode_id"] + CP, con=con)
    finally:
        con.unregister("_b4_ids")
    return f.drop_duplicates("episode_id").set_index("episode_id")[CP]


def veto_threshold(con) -> dict:
    """The fit-period 20th percentile of features_entry cp_lrshr_7d over copy-eligible known signals with copy history (cp_n_7d > 0)."""
    p = splits.period("fit")
    f = load_entry(where=FIT_WHERE, columns=CP, con=con)
    has = f["cp_n_7d"].to_numpy() > 0
    q = float(np.quantile(f.loc[has, "cp_lrshr_7d"], VETO_Q))
    return {"q20_cp_lrshr_7d": q, "fit_signals": int(len(f)), "fit_with_history": int(has.sum()), "period": [str(p.start), str(p.end)],
            "source": "derived/features_entry (build.py ledger_rows)"}


def cp_of(cp: pd.DataFrame, s: pd.DataFrame) -> pd.DataFrame:
    """cp_n_7d / cp_lrshr_7d per signal: `cp` is features_entry's columns by episode_id (entry_cp), or a mirror ledger
    (leader, y, resolved_ms) read at each decision time. An episode features_entry lacks has no copy history."""
    if "resolved_ms" in cp:
        return cp_features(cp, s["leader"], s["t_dec"].to_numpy())[CP]
    out = cp.reindex(s["episode_id"].to_numpy())
    return pd.DataFrame({"cp_n_7d": out["cp_n_7d"].fillna(0).to_numpy(), "cp_lrshr_7d": out["cp_lrshr_7d"].fillna(0).to_numpy()})


def b4_entry(cp: pd.DataFrame, q20: float, p: SimParams):
    def entry(s: pd.DataFrame) -> np.ndarray:
        c = cp_of(cp, s)
        ok = (s["gate"].to_numpy() == "") & (c["cp_n_7d"].to_numpy() > 0) & (c["cp_lrshr_7d"].to_numpy() > q20)
        return np.where(ok, p.max_trade_sol, 0.0)
    return entry


def ledger_crosscheck(sig: pd.DataFrame, cp: pd.DataFrame, q20: float) -> dict:
    """brain.sim.ledger's cp_* at each decision time vs features_entry's: correlation and B4 veto agreement (report only)."""
    try:
        meta = ledger_meta()
    except FileNotFoundError:
        return {"skipped": "no ledger_mirror.parquet"}
    if meta.get("derive_built_at") != built_on()["derive_built_at"]:
        return {"skipped": f"ledger_mirror.parquet is from another derive build ({meta.get('derive_built_at') or 'unstamped'})"}
    a, b = cp_of(load_ledger(), sig), cp_of(cp, sig)
    va = (a["cp_n_7d"].to_numpy() > 0) & (a["cp_lrshr_7d"].to_numpy() > q20)
    vb = (b["cp_n_7d"].to_numpy() > 0) & (b["cp_lrshr_7d"].to_numpy() > q20)
    return {"corr_cp_lrshr_7d": float(np.corrcoef(a["cp_lrshr_7d"], b["cp_lrshr_7d"])[0, 1]),
            "corr_cp_n_7d": float(np.corrcoef(a["cp_n_7d"], b["cp_n_7d"])[0, 1]),
            "veto_disagree_share": float((va != vb).mean()), "signals": int(len(sig))}


# ------------------------------------------------------------------------------------------------------------ reporting
def subset(out: pd.DataFrame, mask: np.ndarray, B: int = 500) -> dict:
    """Per-copy stats of the copies inside `mask` (e.g. live-deliverable signals), one position per coin."""
    c = counted(out) & np.asarray(mask)
    pnl = out["pnl"].to_numpy()[c]
    lo, hi = cluster_ci(pnl, out["mint"].to_numpy()[c], B) if len(pnl) else (float("nan"), float("nan"))
    return {"n": int(c.sum()), "mean_sol": float(pnl.mean()) if len(pnl) else None, "ci95_mint": [lo, hi], "sum_sol": float(pnl.sum())}


def active_wallet_terciles(con, w: Window) -> np.ndarray:
    """tracked_active_wallets_1h of the previous complete hour per signal, as a tercile 0/1/2 over the window's signals."""
    st, en = w.start - pd.Timedelta(hours=1), w.end
    h = con.execute(f"""SELECT epoch(date_trunc('hour', ts))::BIGINT AS h, count(DISTINCT wallet) AS n FROM wallet_swaps
                        WHERE ts >= TIMESTAMPTZ '{st.isoformat()}' AND ts < TIMESTAMPTZ '{en.isoformat()}' GROUP BY 1""").df()
    m = dict(zip(h["h"], h["n"]))
    t = (w.data.sig["t_dec"].to_numpy() + T0_MS) // 1000
    prev = (t // 3600 - 1) * 3600
    n = np.array([m.get(x, 0) for x in prev], dtype=np.float64)
    cuts = np.quantile(n, [1 / 3, 2 / 3]) if len(n) else [0, 0]
    return np.searchsorted(cuts, n, side="right"), [float(c) for c in cuts]


def report(r, w: Window, terc, cuts) -> dict:
    m = dict(r.metrics)
    out = r.out
    sig = w.data.sig
    m["live_deliverable_ins_lag_le_60s"] = subset(out, out["ins_lag_s"].to_numpy() <= 60)
    m["first_buys"] = subset(out, sig["leader_prior_buys_mint"].fillna(0).to_numpy() == 0)
    m["by_active_wallets_tercile"] = {"cuts": cuts, **{str(k): subset(out, terc == k) for k in range(3)}}
    return m


def save_outcomes(r, name: str, period: str) -> None:
    d = data_dir() / OUT_DIR
    d.mkdir(parents=True, exist_ok=True)
    cols = ["episode_id", "leader", "mint", "day", "t_dec", "stake", "entered", "pnl", "reason", "n_tx", "fees", "fee_open", "censored", "E", "close_t", "gate",
            "ins_lag_s", "solo"]
    r.out[cols].to_parquet(d / f"{period}_{name}.parquet", index=False)


def build_stamp() -> dict:
    """The derive and features_entry builds this run reads, and the data end; refuses stale features."""
    meta = json.loads((data_dir() / "derived" / "_meta.json").read_text())
    dend = data_end_ts(meta)
    if meta.get("label_end_t") and dend != pd.Timestamp(int(meta["label_end_t"]), unit="s", tz="UTC"):
        raise SystemExit(f"data end {dend} is not the build's label_end_t: the export tail would be replayed")
    fe_built = load_meta().get("built_at", "")
    if pd.Timestamp(fe_built) < pd.Timestamp(meta["built_at"]):
        raise SystemExit(f"derived/features_entry ({fe_built}) is older than the derive build ({meta['built_at']}): "
                         "run python -m brain.features.build first")
    return {"derive_built_at": meta["built_at"], "features_entry_built_at": fe_built, "label_end_t": meta.get("label_end_t"),
            "data_end_t": meta.get("data_end_t"), "data_end": str(dend)}


def main() -> int:
    t0 = time.time()
    con = connect()
    p = SimParams.load()
    qm = QuoteModel.load()
    stamp = build_stamp()
    log(f"derive build {stamp['derive_built_at']}, features_entry {stamp['features_entry_built_at']}, data end {stamp['data_end']}")
    veto = veto_threshold(con)
    log(f"B4 veto: cp_lrshr_7d <= {veto['q20_cp_lrshr_7d']:+.5f} (fit q20, features_entry) or no copy history")
    res: dict = {"version": 3, "created_at": pd.Timestamp.now(tz="UTC").isoformat(), "build": stamp, "sim_params": p.to_dict(),
                 "quote_model": qm.meta, "splits": {q.name: [str(q.start), str(q.end)] for q in splits.periods()},
                 "data_end": stamp["data_end"], "b4_rule": {"veto": veto}, "population": {}}
    windows, cps = {}, {}
    for period in ("selection", "test"):
        log(f"loading {period}")
        w = load_window(period=period, con=con, params=p, quotes=qm)
        windows[period] = w
        sig = w.data.sig
        if (sig["t_ms"].to_numpy() >= int(to_ms([data_end_ts()])[0])).any():
            raise SystemExit(f"{period}: signals at or after the data end {stamp['data_end']}")
        cps[period] = entry_cp(con, sig)
        missing = int((~sig["episode_id"].isin(cps[period].index)).sum())
        res["population"][period] = {**w.meta, "days": w.days, "last_signal": str(pd.Timestamp(int(sig["t_ms"].max()) + T0_MS, unit="ms", tz="UTC")),
                                     "gates": sig["gate"].replace("", "none").value_counts().to_dict(), "missing_from_features_entry": missing}
        res["b4_rule"].setdefault("ledger_crosscheck", {})[period] = ledger_crosscheck(sig, cps[period], veto["q20_cp_lrshr_7d"])
        log(f"  {w.meta}; {missing} not in features_entry; ledger cross-check {res['b4_rule']['ledger_crosscheck'][period]}")
    # B4's exit: chosen on selection only
    sel = windows["selection"]
    cand = {}
    for ex in EXIT_CANDIDATES:
        r = evaluate(sel, b4_entry(cps["selection"], veto["q20_cp_lrshr_7d"], p), ex, p, B=300)
        pc = r.metrics["per_copy"]
        cand[ex.name] = {"n": pc["n"], "n_stacked": pc["n_stacked"], "mean_sol": pc["mean_sol"], "ci95_mint": pc["ci95_mint"],
                         "account_net_sol": r.metrics["account"]["net_sol"]}
        log(f"  B4 exit {ex.name:<20} per copy {pc['mean_sol']:+.5f} n {pc['n']}  account {r.metrics['account']['net_sol']:+.3f}")
    best = max(EXIT_CANDIDATES, key=lambda e: (cand[e.name]["mean_sol"] if cand[e.name]["n"] else -np.inf))
    res["b4_rule"].update({"exit": best.name, "exit_rule": best.__dict__, "exit_candidates_selection": cand,
                           "chosen_by": "highest per-copy mean on selection (B4 entries, one position per coin)"})
    log(f"B4 exit: {best.name}")
    for period, w in windows.items():
        policies = {"B1": (b1_entry(p), B1_EXIT), "B2": (b2_entry(con, p), B2_EXIT),
                    "B4": (b4_entry(cps[period], veto["q20_cp_lrshr_7d"], p), best)}
        terc, cuts = active_wallet_terciles(con, w)
        res[period] = {"skip": {"per_decision": {"mean_sol": 0.0}, "account": {"net_sol": 0.0, "final_equity": p.bankroll_sol}}}
        for name, (entry, ex) in policies.items():
            t = time.time()
            r = evaluate(w, entry, ex, p)
            res[period][name] = report(r, w, terc, cuts)
            save_outcomes(r, name, period)
            m = r.metrics
            log(f"{period} {name}: per decision {m['per_decision']['mean_sol']:+.5f}  per copy {m['per_copy']['mean_sol']:+.5f} "
                f"{np.round(m['per_copy']['ci95_mint'], 5).tolist()} n {m['per_copy']['n']}  account {m['account']['net_sol']:+.3f} "
                f"({m['account']['trades']} trades, maxDD {m['account']['max_drawdown_sol']:.3f})  {time.time() - t:.0f} s")
    res["notes"] = [
        "Per decision = sum of P&L over every signal of the population, skipped = 0 (the gate's yardstick: skip scores 0).",
        "Per copy = mean over signals the policy copied, one position per coin with unlimited slots (a copy made while an "
        "earlier copy of the coin is still open is blocked and scores 0; per_copy.n_stacked counts them), mint-clustered 95 % CI. "
        "Per decision, by day, the subsets and B4's exit choice use the same copies.",
        "Account = 1 SOL, 5 slots, one position per coin, 0.5 SOL NET realized daily loss limit (gains offset losses, as "
        "paper.ts day_loss_sol), first come first served (paper.ts room()).",
        "B4's leader veto reads cp_n_7d / cp_lrshr_7d from derived/features_entry (build.py, features.yaml: the brain's own "
        "entry features, at T + 1 s), with resolved_at = the latest insert time of the rows that decide it, so a decision "
        "never sees a copy outcome the server had not stored yet. b4_rule.ledger_crosscheck compares brain.sim.ledger with it.",
        "The entry lands at max(leader block + entry delay, decision + 1 s) (sim.yaml entry_after_decision_s).",
        "Exits are evaluated on every stream price (15 s throttle) for the whole hold; the -60 % stop fires on the mark.",
        "The data ends at derived/_meta.json label_end_t (data_end above, build.label_end_t), the start of the export tail: "
        "no signal at or after it is scored, nothing after it is replayed, and positions still open there are closed at "
        "the mark and flagged censored. build.derive_built_at names the derive build every number here comes from.",
        "One clock: marks, events, the exit state and the young_amm gate run on block time ('as if live', sim.yaml insert_time); "
        "the B4 veto's ledger rows count only once resolved by insert time.",
        "The test period is almost all backfilled (ins_ts - ts > 10 min): live_deliverable_ins_lag_le_60s is the part the "
        "server would have decided on in time.",
        "B2 holds at most 24 h (the real engine: 48 h) and ignores the rug screen except the pump-suffix rule.",
        "Test is reported once and never used for a choice; B4's exit and veto threshold come from selection / fit.",
    ]
    res["runtime_s"] = round(time.time() - t0, 1)
    path = data_dir() / OUT_JSON
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(res, indent=1, default=lambda o: o.tolist() if hasattr(o, "tolist") else str(o)))
    log(f"wrote {path} in {res['runtime_s']} s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
