"""
Does it learn? Learner-agnostic checks on synthetic worlds with a planted truth (brain.assure.worlds), every score from
the rebuilt simulator. A learner is anything with fit(TrainData, seed) -> Policy (brain.assure.protocol).

  L1 null_world      no edge anywhere: it copies (almost) nothing and the account stays whole
  L2 veto            it skips the bad leaders it has a record of, and never copies a gated signal
  L3 edge            where an edge exists it beats skip (mint-clustered CI above 0, pooled over 5 worlds) and captures a
                     share of the oracle's value; no world is significantly worse than skip
  L4 traps           silent rugs, high-priced pumpswap, young AMM and 2 s flippers are no larger a share of its copies
                     than of the signals
  L5 leak_canary     trained on an export that leaks a future column, its live decisions don't change (it reads only
                     point-in-time features)
  L6 learning_curve  more training days never make it worse on held-out days, and it ends up above skip
  L7 seed_stability  five training seeds: none loses, the values agree
  L8 regime_shift    trained in one regime, tested in a harsher one (more rugs and bots, a 10x thinner universe): not
                     ruined, within the daily loss limit
  L9 stress          under combined-worst chaos (delay x2, slippage x2, fees 0.0008, dead pools, injected rugs, 30 %
                     missing exit features) it loses less than copy-all and at most a little more than skip
  L10 kappa          a heavier loss weight (kappa 2) never makes it copy more than kappa 1.5
  L11 stakes         stakes are skip or full only
  L12 fine_tune      paper transitions improve it or leave it, and a burst of optimistic paper rewards on rugs (the
                     stale-mark artifact) doesn't make it copy bad leaders once rewards are grounded
  L13 onnx           exported decisions equal the trained model's (when brain.export_onnx exists)

    suite = Suite()                                # builds and caches the worlds
    checks = suite.run(learner)                    # list of artifacts.Check
"""
from __future__ import annotations

import importlib
from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from brain.assure import features as F
from brain.assure.artifacts import Check
from brain.assure.protocol import FixedPolicy, TrainData, score
from brain.assure.worlds import World, WorldSpec
from brain.baselines import follow_leader
from brain.sim.params import Chaos, SimParams
from brain.sim.stress import DEAD_POOL_UPPER

PANEL_SEEDS = (0, 1, 2, 3, 4)
NULL_SEEDS = (100, 101)
REGIME_SEED = 200
PANEL = dict(days=12, signals_per_day=400, backfill_days=(5,))
TEST_DAYS = 4
TOL_DEC = 1e-4          # per-decision SOL: "about skip"
MIN_CAPTURE = 0.10      # of the oracle's per-decision value (the oracle knows each leader's cohort; a learner only sees records)
STRESS = Chaos(delay_mult=2.0, slip_mult=2.0, tx_cost_sol=0.0008, dead_pool=DEAD_POOL_UPPER, rug_rate=0.064, dropout_p=0.3)


@dataclass
class Prepared:
    world: World
    feats: pd.DataFrame
    mirror: pd.DataFrame

    def part(self, days, leaky_canary: bool = False):
        win = self.world.window(days)
        f = self.feats
        if leaky_canary:
            m = self.mirror.set_index("episode_id")
            f = f.copy()
            f["leak_canary"] = m.loc[f["episode_id"], "canary"].to_numpy()
        return win, f.set_index("episode_id").loc[win.data.sig["episode_id"]].reset_index()

    def data(self, days, p: SimParams, kappa: float = 1.5, leaky_canary: bool = False) -> TrainData:
        win, f = self.part(days, leaky_canary)
        return TrainData(win, f, p, kappa)


@dataclass
class CopyAllLearner:
    """The mutant learner of the checks: copies everything (B1)."""
    name: str = "copy-all"

    def fit(self, data, seed: int = 0):
        return FixedPolicy("copy-all", lambda f, s: np.ones(len(s)), follow_leader)


@dataclass
class Suite:
    params: SimParams = field(default_factory=SimParams)
    panel_seeds: tuple = PANEL_SEEDS
    null_seeds: tuple = NULL_SEEDS
    _cache: dict = field(default_factory=dict)

    def prepared(self, spec: WorldSpec) -> Prepared:
        if spec not in self._cache:
            w = World(spec)
            m = F.mirror(w, self.params)
            self._cache[spec] = Prepared(w, F.build(w, m), m)
        return self._cache[spec]

    def split(self, pr: Prepared, test_days: int = TEST_DAYS):
        return pr.world.days[:-test_days], pr.world.days[-test_days:]

    # ------------------------------------------------------------------------------------------------ runner
    def run(self, learner, only=None) -> list[Check]:
        names = only or ("L1", "L2", "L3", "L4", "L5", "L6", "L7", "L8", "L9", "L10", "L11", "L12", "L13")
        fits = self._panel_fits(learner) if set(names) & {"L2", "L3", "L4", "L9", "L11"} else None
        out = []
        for n in names:
            fn = getattr(self, "l" + n[1:].lower())
            c = fn(learner, fits) if n in ("L2", "L3", "L4", "L9", "L11") else fn(learner)
            c.name = f"{n} {c.name} [{learner.name}]"
            out.append(c)
        return out

    def _panel_fits(self, learner) -> list[dict]:
        out = []
        for s in self.panel_seeds:
            pr = self.prepared(WorldSpec(seed=s, **PANEL))
            tr, te = self.split(pr)
            pol = learner.fit(pr.data(tr, self.params), seed=0)
            win, f = pr.part(te)
            res = score(pol, win, f, self.params)
            orc = score(FixedPolicy("oracle", lambda f_, s_, w=pr.world, wn=win: w.oracle(wn, self.params)(s_) / self.params.max_trade_sol, follow_leader),
                        win, f, self.params)
            stake = np.asarray(pol.stake(f, win.data.sig), dtype=np.float64)
            out.append({"seed": s, "pr": pr, "policy": pol, "win": win, "feats": f, "res": res, "oracle": orc, "stake": stake,
                        "truth": pr.world.truth_of(win)})
        return out

    # ------------------------------------------------------------------------------------------------ checks
    def l1(self, learner) -> Check:
        rows = []
        for s in self.null_seeds:
            pr = self.prepared(WorldSpec(seed=s, null=True, **{k: v for k, v in PANEL.items()}))
            tr, te = self.split(pr)
            pol = learner.fit(pr.data(tr, self.params), seed=0)
            win, f = pr.part(te)
            r = score(pol, win, f, self.params)
            rows.append({"seed": s, "copy_rate": r.metrics["per_decision"]["copy_rate"], "account_final": r.metrics["account"]["final_equity"],
                         "per_decision": r.metrics["per_decision"]["mean_sol"]})
        ok = all(x["copy_rate"] <= 0.01 and x["account_final"] >= 0.99 for x in rows)
        return Check("null_world", ok, {"worlds": rows}, "no edge: copy rate <= 1 % and the 1 SOL account ends >= 0.99 SOL on every world",
                     "" if ok else "it copies where nothing pays: it learned noise, or the costs are not in its reward")

    def l2(self, learner, fits) -> Check:
        rows = []
        for x in fits:
            t, st = x["truth"], x["stake"] > 0
            gated = x["win"].data.sig["gate"].to_numpy() != ""
            bad = t["cohort"].to_numpy() == "bad"
            good = t["cohort"].to_numpy() == "good"
            rows.append({"seed": x["seed"], "bad_copy_rate": float(st[bad & ~gated].mean()) if (bad & ~gated).any() else 0.0,
                         "good_copy_rate": float(st[good & ~gated].mean()) if (good & ~gated).any() else 0.0, "gated_copies": int((st & gated).sum())})
        ok = all(r["gated_copies"] == 0 and r["bad_copy_rate"] <= 0.03 and (r["good_copy_rate"] == 0 or r["bad_copy_rate"] <= 0.25 * r["good_copy_rate"])
                 for r in rows)
        return Check("veto", ok, {"worlds": rows}, "bad leaders copied <= 3 % (and <= 1/4 of the good leaders' rate); zero gated copies",
                     "" if ok else "it copies leaders whose record says they lose, or gated coins")

    def l3(self, learner, fits) -> Check:
        from brain.sim.account import cluster_ci, counted
        rows, pnl, grp = [], [], []
        for x in fits:
            pd_ = x["res"].metrics["per_decision"]
            o = x["oracle"].metrics["per_decision"]["mean_sol"]
            out = x["res"].out
            keep = ~out["reason"].isin(("too-late", "bad-print")).to_numpy()
            pnl.append(np.where(counted(out), out["pnl"].to_numpy(), 0.0)[keep])
            grp.append((str(x["seed"]) + ":" + out["mint"].astype(str)).to_numpy()[keep])
            rows.append({"seed": x["seed"], "per_decision": pd_["mean_sol"], "ci95": pd_["ci95_mint"], "oracle": o,
                         "capture": pd_["mean_sol"] / o if o > 0 else float("nan"), "copies": int((x["stake"] > 0).sum()),
                         "account": x["res"].metrics["account"]["net_sol"]})
        allp, allg = np.concatenate(pnl), np.concatenate(grp)
        lo, hi = cluster_ci(allp, allg, 1000, 0)
        worse = sum(r["ci95"][1] < 0 for r in rows)
        cap = float(np.nanmedian([r["capture"] for r in rows]))
        ok = lo > 0 and worse == 0 and cap >= MIN_CAPTURE
        return Check("edge", ok, {"pooled_per_decision": float(allp.mean()), "pooled_ci95": [lo, hi], "significantly_worse": worse,
                                  "median_oracle_capture": cap, "worlds": rows},
                     f"pooled over the 5 worlds it beats skip (mint-clustered CI > 0), no world is significantly worse, median capture of the oracle's value >= {MIN_CAPTURE:.0%}",
                     "" if ok else "it can't find a planted edge (or it loses where skip doesn't)")

    def l4(self, learner, fits) -> Check:
        tr_c = tr_a = n_c = n_a = 0
        rug_c = rug_a = 0
        for x in fits:
            t, st = x["truth"], x["stake"] > 0
            ungated = x["win"].data.sig["gate"].to_numpy() == ""
            trap = t["trap"].to_numpy()
            rug = t["kind"].isin(["silent_rug", "hiprice_rug", "young_rug"]).to_numpy()
            tr_c += int((trap & st).sum())
            n_c += int(st.sum())
            tr_a += int((trap & ungated).sum())
            n_a += int(ungated.sum())
            rug_c += int((rug & st).sum())
            rug_a += int((rug & ungated).sum())
        share_c = tr_c / n_c if n_c else 0.0
        share_a = tr_a / n_a if n_a else 0.0
        rs_c, rs_a = (rug_c / n_c if n_c else 0.0), (rug_a / n_a if n_a else 0.0)
        ok = share_c <= share_a and rs_c <= rs_a
        return Check("traps", ok, {"trap_share_of_copies": share_c, "trap_share_of_signals": share_a, "rug_share_of_copies": rs_c,
                                   "rug_share_of_signals": rs_a, "copies": n_c},
                     "traps (silent rugs, high-priced pumpswap, young AMM, 2 s flippers) are no larger a share of its copies than of the signals",
                     "" if ok else "it prefers the coins that only look good on the tape")

    def l5(self, learner) -> Check:
        pr = self.prepared(WorldSpec(seed=self.panel_seeds[0], **PANEL))
        tr, te = self.split(pr)
        pol = learner.fit(pr.data(tr, self.params, leaky_canary=True), seed=0)
        win, f_off = pr.part(te, leaky_canary=True)
        _, f_live = pr.part(te)
        a = np.asarray(pol.stake(f_off, win.data.sig)) > 0
        b = np.asarray(pol.stake(f_live, win.data.sig)) > 0
        v_off = score(pol, win, f_off, self.params).metrics["per_decision"]["mean_sol"]
        v_live = score(pol, win, f_live, self.params).metrics["per_decision"]["mean_sol"]
        agree = float((a == b).mean())
        ok = agree >= 0.995 and abs(v_off - v_live) <= TOL_DEC
        return Check("leak_canary", ok, {"decision_agreement": agree, "offline_value": v_off, "live_value": v_live, "offline_copies": int(a.sum()),
                                         "live_copies": int(b.sum())},
                     "offline (the export leaks a future column) and live decisions agree >= 99.5 % and their values within 1e-4 SOL",
                     "" if ok else "it trains on a column the server can't have at decision time: offline results won't hold live")

    def l6(self, learner) -> Check:
        pr = self.prepared(WorldSpec(seed=self.panel_seeds[0], **PANEL))
        tr, te = self.split(pr)
        win, f = pr.part(te)
        orc = score(FixedPolicy("oracle", lambda f_, s_: pr.world.oracle(win, self.params)(s_) / self.params.max_trade_sol, follow_leader),
                    win, f, self.params).metrics["per_decision"]["mean_sol"]
        rows = []
        for k in (2, 4, len(tr)):
            pol = learner.fit(pr.data(tr[-k:], self.params), seed=0)
            v = score(pol, win, f, self.params).metrics["per_decision"]["mean_sol"]
            rows.append({"train_days": k, "per_decision": v, "regret": orc - v})
        vals = [r["per_decision"] for r in rows]
        ok = all(vals[i + 1] >= vals[i] - TOL_DEC for i in range(len(vals) - 1)) and vals[-1] > 0 and rows[-1]["regret"] <= rows[0]["regret"] + TOL_DEC
        return Check("learning_curve", ok, {"curve": rows, "oracle": orc},
                     "held-out value never falls by more than 1e-4 SOL/decision as training days grow, ends above skip, regret shrinks",
                     "" if ok else "more data doesn't help: it isn't learning the planted signal")

    def l7(self, learner) -> Check:
        pr = self.prepared(WorldSpec(seed=self.panel_seeds[0], **PANEL))
        tr, te = self.split(pr)
        win, f = pr.part(te)
        vals, copies = [], []
        for sd in range(5):
            pol = learner.fit(pr.data(tr, self.params), seed=sd)
            vals.append(score(pol, win, f, self.params).metrics["per_decision"]["mean_sol"])
            copies.append(set(win.data.sig["episode_id"].to_numpy()[np.asarray(pol.stake(f, win.data.sig)) > 0].tolist()))
        jac = [len(a & b) / len(a | b) for i, a in enumerate(copies) for b in copies[i + 1:] if (a | b)]
        jm = float(np.mean(jac)) if jac else 1.0
        ok = min(vals) >= -TOL_DEC and float(np.std(vals)) <= 3 * TOL_DEC and jm >= 0.4
        return Check("seed_stability", ok, {"per_decision": vals, "std": float(np.std(vals)), "mean_copy_jaccard": jm},
                     "5 training seeds: none below -1e-4 SOL/decision, std <= 3e-4, copy sets overlap (mean Jaccard >= 0.4)",
                     "" if ok else "its result depends on the training seed: what it learned is noise")

    def l8(self, learner) -> Check:
        spec = WorldSpec(seed=REGIME_SEED, shift_day=8, **{k: v for k, v in PANEL.items()})
        pr = self.prepared(spec)
        tr, te = pr.world.days[:8], pr.world.days[8:]
        pol = learner.fit(pr.data(tr, self.params), seed=0)
        win, f = pr.part(te)
        r = score(pol, win, f, self.params)
        b1 = score(FixedPolicy("b1", lambda f_, s_: np.ones(len(s_)), follow_leader), win, f, self.params)
        a = r.metrics["account"]
        ok = not a["ruined"] and a["worst_day_sol"] >= -self.params.daily_loss_sol and a["net_sol"] >= -0.10
        return Check("regime_shift", ok, {"account_net": a["net_sol"], "worst_day": a["worst_day_sol"], "ruined": a["ruined"],
                                          "copies": int(a["trades"]), "b1_account_net": b1.metrics["account"]["net_sol"]},
                     "trained before a regime change, tested after it: not ruined, worst day >= -0.5 SOL, account >= -0.10 SOL",
                     "" if ok else "a population change breaks it: it needs a regime-aware fallback")

    def l9(self, learner, fits) -> Check:
        rows = []
        for x in fits[:3]:
            r = score(x["policy"], x["win"], x["feats"], self.params, chaos=STRESS)
            b1 = score(FixedPolicy("b1", lambda f_, s_: np.ones(len(s_)), follow_leader), x["win"], x["feats"], self.params, chaos=STRESS)
            rows.append({"seed": x["seed"], "account_net": r.metrics["account"]["net_sol"], "per_decision": r.metrics["per_decision"]["mean_sol"],
                         "b1_account_net": b1.metrics["account"]["net_sol"]})
        ok = all(r["account_net"] >= -0.10 and r["account_net"] > r["b1_account_net"] for r in rows)
        return Check("stress", ok, {"worlds": rows}, "combined-worst chaos: account >= -0.10 SOL and better than copy-all on every world",
                     "" if ok else "it only works in a calm market")

    def l10(self, learner) -> Check:
        pr = self.prepared(WorldSpec(seed=self.panel_seeds[0], **PANEL))
        tr, te = self.split(pr)
        win, f = pr.part(te)
        n = {}
        for kappa in (1.5, 2.0):
            pol = learner.fit(pr.data(tr, self.params, kappa=kappa), seed=0)
            n[kappa] = int((np.asarray(pol.stake(f, win.data.sig)) > 0).sum())
        ok = n[2.0] <= n[1.5] + max(2, int(0.1 * n[1.5]))
        return Check("kappa", ok, {"copies_kappa_1.5": n[1.5], "copies_kappa_2.0": n[2.0]},
                     "kappa 2 copies no more than kappa 1.5 (+10 %, at least 2, for training noise)",
                     "" if ok else "the loss weight doesn't reach its decisions: the reward isn't the one in reward.yaml")

    def l11(self, learner, fits) -> Check:
        vals = np.unique(np.concatenate([np.round(x["stake"], 9) for x in fits]))
        ok = set(vals.tolist()) <= {0.0, 1.0}
        return Check("stakes", ok, {"stake_fractions_used": vals.tolist()}, "stake fractions are 0 or 1 only (owner decision: skip or full)",
                     "" if ok else "it stakes fractions: with a reward linear in stake that only adds fixed fees")

    def l12(self, learner) -> Check:
        if not hasattr(learner, "fine_tune"):
            return Check("fine_tune", False, {}, "learner has fine_tune", "the learner has no fine_tune: skipped", skipped=True)
        pr = self.prepared(WorldSpec(seed=self.panel_seeds[0], **PANEL))
        days = pr.world.days
        tr, paper, te = days[:-7], days[-7:-4], days[-4:]
        base = learner.fit(pr.data(tr, self.params), seed=0)
        win, f = pr.part(te)
        out = {}
        honest, poisoned = paper_transitions(pr, paper, self.params, exit_policy=base.exit)
        for name, trn, ground in (("honest", honest, True), ("poisoned_grounded", poisoned, True), ("poisoned_raw", poisoned, False)):
            pol = learner.fine_tune(base, pr.data(tr, self.params), trn, seed=0, ground=ground)
            st = np.asarray(pol.stake(f, win.data.sig)) > 0
            t = pr.world.truth_of(win)
            out[name] = {"per_decision": score(pol, win, f, self.params).metrics["per_decision"]["mean_sol"], "copies": int(st.sum()),
                         "bad_copy_rate": float(st[(t["cohort"] == "bad").to_numpy()].mean()), "rug_copies": int((st & rug_kind(t)).sum())}
        st0 = np.asarray(base.stake(f, win.data.sig)) > 0
        t = pr.world.truth_of(win)
        b0 = {"per_decision": score(base, win, f, self.params).metrics["per_decision"]["mean_sol"], "copies": int(st0.sum()),
              "bad_copy_rate": float(st0[(t["cohort"] == "bad").to_numpy()].mean()), "rug_copies": int((st0 & rug_kind(t)).sum())}
        ok = (out["honest"]["per_decision"] >= b0["per_decision"] - TOL_DEC
              and out["poisoned_grounded"]["bad_copy_rate"] <= b0["bad_copy_rate"] + 0.02
              and out["poisoned_grounded"]["rug_copies"] <= b0["rug_copies"] + 2
              and out["poisoned_grounded"]["per_decision"] >= b0["per_decision"] - TOL_DEC)
        return Check("fine_tune", ok, {"base": b0, **out, "transitions": int(len(honest)), "poisoned_rows": int(poisoned["poisoned"].sum())},
                     "honest paper transitions don't hurt (>= base - 1e-4); optimistic rewards on rugs, once grounded, add no rug copies (+2 max), no bad-leader copies (+2 % max) and don't hurt",
                     "" if ok else "paper transitions make it worse, or stale paper marks teach it to copy rugs")

    def l13(self, learner) -> Check:
        try:
            importlib.import_module("brain.export_onnx")
        except ImportError:
            return Check("onnx", False, {}, "exported decisions equal the model's", "brain.export_onnx is not built yet: skipped", skipped=True)
        fn = getattr(learner, "onnx_roundtrip", None)
        if fn is None:
            return Check("onnx", False, {}, "exported decisions equal the model's", f"{learner.name} has no onnx_roundtrip(): skipped", skipped=True)
        pr = self.prepared(WorldSpec(seed=self.panel_seeds[0], **PANEL))
        tr, te = self.split(pr)
        pol = learner.fit(pr.data(tr, self.params), seed=0)
        win, f = pr.part(te)
        agree = float(fn(pol, f, win.data.sig))
        ok = agree >= 0.999
        return Check("onnx", ok, {"decision_agreement": agree}, "ONNX and torch decisions agree on >= 99.9 % of signals",
                     "" if ok else "the server would trade a different model than the one the gate passed")


def rug_kind(t: pd.DataFrame) -> np.ndarray:
    return t["kind"].isin(["silent_rug", "hiprice_rug", "young_rug"]).to_numpy()


def paper_transitions(pr: Prepared, days, p: SimParams, share: float = 0.5, seed: int = 0, exit_policy=follow_leader) -> tuple[pd.DataFrame, pd.DataFrame]:
    """
    What an Explore account would log over `days`: a random half of the ungated signals copied at full stake and exited by
    the bundle's own exit policy, one row per closed position (features, stake, reward = net SOL, close_ms, mark_age_s). The poisoned copy reports
    the stale-mark artifact: silent rugs closed at their old tape price (+0.03 SOL, mark 15 min old).
    """
    win, f = pr.part(days)
    sig = win.data.sig
    rng = np.random.default_rng(seed)
    take = (rng.random(len(sig)) < share) & (sig["gate"].to_numpy() == "")
    rows = np.flatnonzero(take)
    from brain.sim.evaluate import evaluate
    r = evaluate(win, lambda s: np.full(len(s), p.max_trade_sol), exit_policy, p, rows=rows, B=10)
    o = r.out[r.out["entered"].to_numpy()].reset_index(drop=True)
    tr = f.set_index("episode_id").loc[o["episode_id"]].reset_index()
    tr["mint"] = o["mint"].to_numpy()
    tr["stake"] = o["stake"].to_numpy()
    tr["reward"] = o["pnl"].to_numpy()
    tr["close_ms"] = np.minimum(o["close_t"].to_numpy(), pr.world.data_end_ms)
    tr["mark_age_s"] = 0.0
    truth = pr.world.truth.set_index("episode_id").loc[o["episode_id"]]
    rug = truth["kind"].isin(["silent_rug", "hiprice_rug", "young_rug"]).to_numpy()
    poisoned = tr.copy()
    poisoned["poisoned"] = rug
    poisoned.loc[rug, "reward"] = 0.03
    poisoned.loc[rug, "mark_age_s"] = 900.0
    rug_t = truth["rug_t"].to_numpy()
    poisoned.loc[rug, "close_ms"] = np.where(np.isfinite(rug_t[rug]), (rug_t[rug] * 1000).astype(np.int64) - F.world_t0() + 15 * 60_000,
                                             poisoned.loc[rug, "close_ms"].to_numpy())
    tr["poisoned"] = False
    return tr, poisoned
