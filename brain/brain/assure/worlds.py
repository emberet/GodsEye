"""
Synthetic markets with a planted truth, in exactly the shapes brain.sim consumes (a SwapTape frame, signals, leader
sells): the real simulator, account and metrics run on them unchanged, so a check that passes here passes on the code
the trainer uses. Every world is seeded and deterministic.

    w = World(WorldSpec(seed=0))                 # tape + signals + the planted truth per signal
    win = w.window(w.days[:6])                    # an evaluate.Window over those days (the real Window type)
    w.truth                                       # per signal: cohort, kind, creator, serial, trap, oracle (copy it?)

What is planted (research-2026-11-06 findings, as mechanisms the brain must learn or must not be fooled by):
  cohorts     good leaders (their coins drift up until they sell: a small real edge), neutral (no edge: copying loses
              the costs), bad (their coins rug or bleed: the persistent bottom fifth), bots (sell 2 s after buying)
  silent rug  the coin pumps on the tape, then tracked wallets just stop trading it: the last tracked price stays high
              while the coin is unsellable (report section 2). Valued at the last tape price it looks like a win.
  loud rug    the price prints -98 % and the coin lives on at that level
  bot drift   the leader flips in 2 s; other wallets print a +20 % drift over the next minute, then the tape dies. A
              copier that follows the leader sells right away and loses the costs; one filled at the minute close
              (the old simulator, report section 4) rides the drift and looks profitable
  traps       young AMM pools (first seen at the signal) and high-priced pumpswap coins (>= 1e-4 SOL per token): mostly
              silent rugs, as in the data (gates of features.yaml)
  creators    serial creators' coins return less (coin-launch: -0.15 vs first-time creators)
  late writes on `backfill_days` every row is stored hours after its block time (ins_ts), like the history backfills
              that made 98 % of 11-01..11-06 swaps late
  regime      from `shift_day` on, a different cohort mix and a thinner tracked universe (train and test differ)
  null world  `null=True`: every leader is neutral and no coin has an edge: the only right answer is skip

The oracle copies exactly the signals that carry the planted edge (a good leader's normal, non-serial coin), which a
point-in-time learner can only approach from the leader's earlier copies: regret = oracle value - learner value.
"""
from __future__ import annotations

from dataclasses import dataclass, field, replace

import numpy as np
import pandas as pd

from brain.sim import engine
from brain.sim.evaluate import Window
from brain.sim.params import SimParams
from brain.sim.quotes import QuoteModel
from brain.sim.signals import add_gates, leader_sells, prepare
from brain.sim.tape import T0_MS, SwapTape

COHORTS = ("good", "neutral", "bad", "bot")
KINDS = ("normal", "silent_rug", "loud_rug", "bot_drift", "hiprice_rug", "young_rug", "young_ok")
HIPRICE = 2e-4
DAY_S = 86_400


@dataclass(frozen=True)
class WorldSpec:
    seed: int = 0
    start: str = "2026-09-01"
    days: int = 9
    signals_per_day: int = 220
    n_leaders: int = 90
    mix: tuple = (("good", 0.15), ("neutral", 0.45), ("bad", 0.20), ("bot", 0.20))
    edge: float = 0.14                 # good leaders' coins: mean log drift from the buy to the leader's sell
    serial_share: float = 0.15         # coins by serial creators (10+ coins a week)
    serial_penalty: float = -0.15
    young_share: float = 0.06          # coins on a young AMM pool (first seen at the signal)
    young_rug_p: float = 0.85
    hiprice_share: float = 0.04        # high-priced pumpswap coins
    hiprice_rug_p: float = 0.97
    backfill_days: tuple = ()          # day indexes whose rows are stored hours late
    backfill_lag_h: float = 3.0        # median insert lag on those days
    universe: int = 240                # tracked "other" wallets that print the tapes
    shift_day: int | None = None       # regime change from this day index on
    shift_mix: tuple = (("good", 0.08), ("neutral", 0.35), ("bad", 0.27), ("bot", 0.30))
    shift_universe: int = 24
    null: bool = False


def null_spec(**kw) -> WorldSpec:
    return WorldSpec(null=True, **kw)


@dataclass
class World:
    spec: WorldSpec = field(default_factory=WorldSpec)
    swaps: pd.DataFrame = field(init=False)
    signals: pd.DataFrame = field(init=False)
    truth: pd.DataFrame = field(init=False)
    leaders: pd.DataFrame = field(init=False)

    def __post_init__(self):
        build(self)
        self.start = pd.Timestamp(self.spec.start, tz="UTC")
        self.days = [(self.start + pd.Timedelta(days=d)).strftime("%Y-%m-%d") for d in range(self.spec.days)]
        self.data_end_ms = int((self.start + pd.Timedelta(days=self.spec.days + 2)).timestamp() * 1000) - T0_MS
        p = SimParams()
        self.tape = SwapTape.from_frame(self.swaps, data_end=self.data_end_ms, fee_bps=p.fee_bps, default_depth=p.default_depth_sol,
                                        depth_window_ms=int(p.depth_window_s * 1000))
        self.sig = add_gates(prepare(self.signals), self.tape, p)
        self.truth = self.truth.set_index("episode_id").loc[self.sig["episode_id"]].reset_index()
        self.quotes = QuoteModel.fallback()

    def window(self, days=None, tape: SwapTape | None = None) -> Window:
        """The signals of `days` (all by default) as an evaluate.Window, sharing the world's tape."""
        days = list(days) if days is not None else self.days
        rows = self.sig["day"].isin(days).to_numpy()
        sig = self.sig[rows].reset_index(drop=True)
        tp = tape or self.tape
        data = engine.SimData(tp, sig, leader_sells(sig, tp), self.quotes)
        st = pd.Timestamp(days[0], tz="UTC")
        return Window(data=data, days=days, start=st, end=pd.Timestamp(days[-1], tz="UTC") + pd.Timedelta(days=1),
                      meta={"world": self.spec.seed, "signals": int(len(sig))})

    def truth_of(self, w: Window) -> pd.DataFrame:
        return self.truth.set_index("episode_id").loc[w.data.sig["episode_id"]].reset_index()

    def oracle(self, w: Window, p: SimParams | None = None):
        """The planted-truth entry: full stake on exactly the signals that carry the edge (none in a null world)."""
        p = p or SimParams()
        ok = self.truth_of(w)["oracle"].to_numpy()
        return lambda s: np.where(s["episode_id"].map(dict(zip(w.data.sig["episode_id"], ok))).fillna(False).to_numpy(bool), p.max_trade_sol, 0.0)


# ------------------------------------------------------------------------------------------------------------ build
def _mix(spec_mix, rng, n) -> np.ndarray:
    names = [m[0] for m in spec_mix]
    p = np.array([m[1] for m in spec_mix], dtype=np.float64)
    return rng.choice(names, size=n, p=p / p.sum())


def build(w: World) -> None:
    s = w.spec
    rng = np.random.default_rng(s.seed)
    t0 = int(pd.Timestamp(s.start, tz="UTC").timestamp())
    # leaders: a cohort each (fixed for the whole world, so a leader's record carries over); a second cohort draw for
    # the regime after shift_day (a leader's cohort can change with the regime: the population changes, as in the data)
    n_l = s.n_leaders
    coh_a = np.full(n_l, "neutral", dtype=object) if s.null else _mix(s.mix, rng, n_l)
    coh_b = np.full(n_l, "neutral", dtype=object) if s.null else np.where(rng.random(n_l) < 0.7, coh_a, _mix(s.shift_mix, rng, n_l))
    activity = rng.lognormal(0, 0.8, n_l)
    w.leaders = pd.DataFrame({"leader": [f"Lead{i:03d}" for i in range(n_l)], "cohort": coh_a, "cohort_after_shift": coh_b,
                              "activity": activity})
    creators_serial = [f"Serial{i:02d}" for i in range(6)]
    rows, sigs, truth = [], [], []
    sid = 1
    eid = 1
    for d in range(s.days):
        shifted = s.shift_day is not None and d >= s.shift_day
        coh = coh_b if shifted else coh_a
        uni = s.shift_universe if shifted else s.universe
        backfill = d in s.backfill_days
        n = rng.poisson(s.signals_per_day)
        ts = np.sort(rng.uniform(t0 + d * DAY_S + 60, t0 + (d + 1) * DAY_S - 60, n))
        li = rng.choice(n_l, size=n, p=activity / activity.sum())
        for k in range(n):
            t = float(ts[k])
            leader = w.leaders["leader"].iat[li[k]]
            c = coh[li[k]]
            kind, venue, p0, drift_up, serial, creator = _coin(s, rng, c)
            mint = f"M{s.seed:03d}d{d}n{k:04d}" + ("pump" if venue == "pumpfun" else "amm1")  # sfx_pump: pump.fun mints end in "pump"
            if serial:
                creator = creators_serial[int(rng.integers(len(creators_serial)))]
            lag = rng.lognormal(np.log(s.backfill_lag_h * 3600), 0.8) if backfill else rng.uniform(0.5, 3.0)
            others = [f"Oth{int(x):04d}" for x in rng.choice(max(uni, 3), size=min(4, max(uni, 3)), replace=False)]
            coin_rows, sells, info = _tape(rng, t, mint, leader, others, kind, c, venue, p0, drift_up, s)
            for r in coin_rows:
                r["id"] = sid
                r["slot"] = sid
                r["ins"] = r["t"] + lag
                sid += 1
            rows.extend(coin_rows)
            lead_buy = info["leader_buy"]
            sigs.append({"episode_id": eid, "leader": leader, "mint": mint, "ts": t, "slot": lead_buy["id"], "ins_ts": t + lag,
                         "leader_sol": lead_buy["sol_amount"], "leader_price_sol": lead_buy["price_sol"], "venue": venue,
                         "leader_pos_tokens": lead_buy["token_amount"], "leader_tokens": lead_buy["token_amount"], "known_at_t": True,
                         "crosses_outage": False, "leader_prior_buys_mint": 0, "token_age_sec": info["age_s"], "creator": creator})
            oracle = (c == "good") and kind == "normal" and not serial and not s.null
            truth.append({"episode_id": eid, "cohort": c, "kind": kind, "venue": venue, "serial": bool(serial), "creator": creator,
                          "trap": kind in ("silent_rug", "bot_drift", "hiprice_rug", "young_rug"), "oracle": bool(oracle),
                          "backfilled": bool(backfill), "regime": "b" if shifted else "a", "first_t": info["first_t"],
                          "rug_t": info.get("rug_t", np.nan), "leader_sell_t": info.get("sell_t", np.nan)})
            eid += 1
    sw = pd.DataFrame(rows)
    sw["ts"] = pd.to_datetime((sw.pop("t") * 1000).round().astype(np.int64), unit="ms", utc=True)
    sw["ins_ts"] = pd.to_datetime((sw.pop("ins") * 1000).round().astype(np.int64), unit="ms", utc=True)
    w.swaps = sw
    sg = pd.DataFrame(sigs)
    sg["ts"] = pd.to_datetime((sg["ts"] * 1000).round().astype(np.int64), unit="ms", utc=True)
    sg["ins_ts"] = pd.to_datetime((sg["ins_ts"] * 1000).round().astype(np.int64), unit="ms", utc=True)
    w.signals = sg
    w.truth = pd.DataFrame(truth)


def _coin(s: WorldSpec, rng, cohort: str):
    """(kind, venue, p0, drift until the leader's sell, serial creator?, creator) for one coin."""
    u = rng.random()
    venue, p0 = "pumpfun", float(rng.lognormal(np.log(3e-8), 0.5))
    serial = rng.random() < s.serial_share
    creator = f"Creator{int(rng.integers(10**9)):09d}"
    if u < s.hiprice_share:
        return ("hiprice_rug" if rng.random() < s.hiprice_rug_p else "normal"), "pumpswap", HIPRICE * float(rng.uniform(1, 5)), 0.0, serial, creator
    if u < s.hiprice_share + s.young_share:
        return ("young_rug" if rng.random() < s.young_rug_p else "young_ok"), "pumpswap", float(rng.lognormal(np.log(5e-7), 0.5)), 0.0, serial, creator
    pen = s.serial_penalty if serial else 0.0
    if s.null:
        r = rng.random()
        kind = "silent_rug" if r < 0.10 else "loud_rug" if r < 0.15 else "normal"
        return kind, venue, p0, 0.0, serial, creator
    if cohort == "good":
        kind = "silent_rug" if rng.random() < 0.05 else "normal"
        return kind, venue, p0, s.edge + pen, serial, creator
    if cohort == "neutral":
        r = rng.random()
        kind = "silent_rug" if r < 0.10 else "loud_rug" if r < 0.15 else "normal"
        return kind, venue, p0, pen, serial, creator
    if cohort == "bad":
        r = rng.random()
        kind = "silent_rug" if r < 0.5 else "loud_rug" if r < 0.7 else "normal"
        return kind, venue, p0, -0.15 + pen, serial, creator
    return "bot_drift", venue, p0, 0.0, serial, creator


def _swap(t, wallet, mint, side, price, sol, bal=0.0) -> dict:
    return {"t": t, "wallet": wallet, "mint": mint, "side": side, "price_sol": price, "sol_amount": sol, "token_amount": sol / price,
            "token_balance_before": bal}


def _walk(rng, t_from, t_to, every, logp0, drift_total, sigma=0.006, depth=None, sol=(0.2, 1.5)):
    """
    Print times every ~`every` s in [t_from, t_to), each print's side and size, and a log-price path: `drift_total` spread
    over the prints, noise, and each print's own impact on a pool `depth` SOL deep (model.ts estimates depth from exactly
    that flow / price-move relation). (t, logp, side, sol).
    """
    if t_to <= t_from:
        z = np.zeros(0)
        return z, z, z.astype(object), z
    gaps = rng.uniform(0.5 * every, 1.5 * every, int((t_to - t_from) / (0.5 * every)) + 2)
    tt = t_from + np.cumsum(gaps)
    tt = tt[tt < t_to]
    n = len(tt)
    side = np.where(rng.random(n) < 0.5, "buy", "sell").astype(object)
    sz = rng.uniform(*sol, n)
    d = depth if depth is not None else float(rng.uniform(20, 45))
    imp = np.where(side == "buy", 1.0, -1.0) * sz / d
    steps = rng.normal(0.0, sigma, n) + imp - (imp.mean() if n else 0.0) + (drift_total / n if n else 0.0)
    return tt, logp0 + np.cumsum(steps), side, sz


def _tape(rng, t, mint, leader, others, kind, cohort, venue, p0, drift_up, s: WorldSpec):
    """The coin's swaps (dicts with t in epoch s), the leader's sells, and info (first print, rug and sell times)."""
    out = []
    info: dict = {}
    young = kind in ("young_rug", "young_ok")
    age = 0.0 if young else float(rng.uniform(15, 120) * 60)
    first = t - age
    info["first_t"] = first
    info["age_s"] = age if not young else 0.0
    lp = np.log(p0)
    k = 0

    def others_print(walk):
        nonlocal k
        tt, logp, side, sz = walk
        for ti, li, si, so in zip(tt.tolist(), logp.tolist(), side.tolist(), sz.tolist()):
            out.append(_swap(ti, others[k % len(others)], mint, si, float(np.exp(li)), float(so)))
            k += 1
        return logp[-1] if len(logp) else None

    depth = float(rng.uniform(20, 45))
    if not young:  # history before the signal: flat prints by the other wallets
        others_print(_walk(rng, first, t - 1, 60, lp, 0.0, 0.003, depth))
    lead_sol = float(rng.uniform(0.25, 3.0))
    buy = _swap(t, leader, mint, "buy", p0, lead_sol)
    out.append(buy)
    info["leader_buy"] = buy
    lead_tok = buy["token_amount"]
    lp = lp + lead_sol / depth  # the leader's own buy moves the pool
    life = float(rng.uniform(60, 180) * 60)

    def sell_at(ts, logp):
        price = float(np.exp(logp))
        out.append(_swap(ts, leader, mint, "sell", price, lead_tok * price, bal=lead_tok))
        info["sell_t"] = ts

    if kind == "bot_drift":
        sell_at(t + 2.0, lp)
        others_print(_walk(rng, t + 0.5, t + 15, 5, lp, 0.0, 0.002, depth))       # flat while the bot flips ...
        others_print(_walk(rng, t + 15, t + 70, 5, lp, np.log(1.2), 0.002, depth))  # ... then +20 % over the minute
        return out, None, info  # and the tape dies: a dead coin
    if kind in ("silent_rug", "hiprice_rug", "young_rug"):
        rug = t + float(rng.uniform(1, 25) * 60)
        info["rug_t"] = rug
        wk = _walk(rng, t + 1, rug, 12, lp, np.log(1.35), 0.006, depth)  # it pumps on the tape ...
        others_print(wk)
        if cohort != "bad" and rng.random() < 0.5 and len(wk[0]):  # some leaders get out before the pull, most don't
            j = int(rng.integers(len(wk[0])))
            sell_at(float(wk[0][j]) + 0.3, float(wk[1][j]))
        return out, None, info  # ... then nobody tracked trades it again
    if kind == "loud_rug":
        rug = t + float(rng.uniform(2, 30) * 60)
        info["rug_t"] = rug
        last = others_print(_walk(rng, t + 1, rug, 12, lp, 0.0, 0.006, depth))
        low = (lp if last is None else last) + np.log(0.02)
        others_print(_walk(rng, rug, rug + 120, 8, low, 0.0, 0.002, depth * 0.05, sol=(0.01, 0.05)))
        others_print(_walk(rng, rug + 120, t + 26 * 3600, 1800, low, 0.0, 0.002, depth * 0.05, sol=(0.01, 0.05)))
        return out, None, info
    # normal / young_ok: drift until the leader sells, then flat, then sparse prints so the coin stays alive past the
    # 24 h max hold + the 6 h grounded lookahead
    hold = {"good": (8, 40), "neutral": (2, 30), "bad": (1, 20)}.get(cohort, (2, 30))
    sell_t = t + float(rng.uniform(*hold) * 60)
    last = others_print(_walk(rng, t + 1, sell_t, 12, lp, drift_up, 0.006, depth))
    last = lp if last is None else last
    sell_at(sell_t, last)
    last2 = others_print(_walk(rng, sell_t + 1, t + life, 20, last - lead_sol / depth, 0.0, 0.006, depth))
    others_print(_walk(rng, t + life, t + 26 * 3600, 1800, last if last2 is None else last2, 0.0, 0.003, depth))
    return out, None, info


def with_spec(spec: WorldSpec, **kw) -> WorldSpec:
    return replace(spec, **kw)
