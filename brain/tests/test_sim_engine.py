"""brain.sim tape / signals / engine on tiny hand-built tapes: the trailing filter, insert-time lookups, the entry fill
(model.ts), leader-follow timing, the forward-price rule, dead-coin write-offs, the hard stop, max hold, censoring, gates
and keyed randomness. Delays are made deterministic (sigma 0) so every number can be computed by hand."""
from __future__ import annotations

import json
import math
from dataclasses import fields

import numpy as np
import pandas as pd
import pytest
import yaml

from brain.features.prices import ok_flags
from brain.sim import engine
from brain.sim.model import Obs, Tape, buyFill, sellFill
from brain.sim.params import SPEC, Chaos, SimParams, uniform
from brain.sim.quotes import QuoteModel
from brain.sim.signals import add_gates, leader_sells, prepare
from brain.sim.tape import T0_MS, SwapTape, trailing_ok

BASE = 1_793_000_040  # epoch s (2026-11-01), minute aligned
L, O, P = "Leader111", "Other222", "Third333"
P0 = 1e-6

# deterministic delays: entry lands 4 s after the leader, sales 2 s after the decision, decisions 0.5 s late
DET = dict(entry_land_mu=math.log(4), entry_land_sigma=0.0, exit_land_mu=math.log(2), exit_land_sigma=0.0,
           lateness_mu=math.log(0.5), lateness_sigma=0.0, buy_fail_p=0.0)


def params(**kw) -> SimParams:
    return SimParams(**{**DET, **kw})


def sw(i, wallet, t, side, price, sol=1.0, tokens=None, bal=0.0, mint="M1", ins=None) -> dict:
    return {"id": i, "wallet": wallet, "mint": mint, "ts": pd.Timestamp(BASE + t, unit="s", tz="UTC"), "slot": 1000 + i, "side": side,
            "sol_amount": sol, "price_sol": price, "token_amount": sol / price if tokens is None else tokens, "token_balance_before": bal,
            "ins_ts": pd.Timestamp(BASE + (t if ins is None else ins), unit="s", tz="UTC")}


def flat_tape(t_from=0, t_to=600, every=5, price=P0, mint="M1", start_id=1000, wallet=O) -> list[dict]:
    """Another wallet's alternating buys / sells at one price."""
    return [sw(start_id + k, wallet, t, "buy" if k % 2 == 0 else "sell", price, 1.0, mint=mint) for k, t in enumerate(range(t_from, t_to, every))]


def signal(i, t, mint="M1", leader=L, price=P0, sol=1.0, venue="pumpfun", pos_tokens=None) -> dict:
    return {"episode_id": i, "leader": leader, "mint": mint, "ts": pd.Timestamp(BASE + t, unit="s", tz="UTC"), "slot": 1000 + i,
            "ins_ts": pd.Timestamp(BASE + t, unit="s", tz="UTC"), "leader_sol": sol, "leader_price_sol": price, "venue": venue,
            "leader_pos_tokens": sol / price if pos_tokens is None else pos_tokens, "known_at_t": True, "crosses_outage": False,
            "leader_prior_buys_mint": 0}


def build(swaps, sigs, p: SimParams | None = None, chaos: Chaos = Chaos(), data_end=None, outage_h=()) -> tuple[engine.SimData, SimParams]:
    p = p or params()
    kw = {}
    if data_end is not None:
        kw["data_end"] = int((BASE + data_end) * 1000 - T0_MS)
    if len(outage_h):
        kw["outage_h"] = np.asarray([(BASE + h) * 1000 - T0_MS for h in outage_h], dtype=np.int64)
    tape = SwapTape.from_frame(pd.DataFrame(swaps), **kw)
    sig = add_gates(prepare(pd.DataFrame(sigs)), tape, p, chaos)
    return engine.SimData(tape, sig, leader_sells(sig, tape), QuoteModel.fallback()), p


def hold(st, d):
    return np.zeros(len(st["ret_now"]))


def follow(st, d):
    f = st["leader_sell_frac"]
    return np.where(st["event_leader_sell"], np.where(f >= 0.9, 1.0, f), 0.0)


def run(data, p, rows=None, stake=0.1, policy=follow, chaos=Chaos(), seed=0) -> pd.DataFrame:
    rows = np.arange(len(data.sig)) if rows is None else np.asarray(rows)
    b = data.book(rows, stake, p, chaos, seed)
    engine.run(b, policy)
    return b.outcomes()


def model_tape(swaps, p: SimParams) -> Tape:
    """The model.ts Tape over the same ok prints (ok filter applied the same way)."""
    d = pd.DataFrame(swaps).sort_values(["ts", "slot", "id"])
    _, ok = trailing_ok(np.zeros(len(d), dtype=np.int32), d["price_sol"].to_numpy(), d["sol_amount"].to_numpy())
    d = d[ok]
    obs = [Obs(int(r.ts.timestamp() * 1000), r.side, r.price_sol, r.sol_amount) for r in d.itertuples()]
    return Tape(obs, p.fee_bps, p.default_depth_sol, int(p.depth_window_s * 1000))


# ------------------------------------------------------------------------------------------------------------ params
def test_sim_yaml_params_match_the_code():
    raw = yaml.safe_load(SPEC.read_text())["params"]
    names = {f.name for f in fields(SimParams)}
    assert set(raw) == names
    loaded, default = SimParams.load(), SimParams()
    for n in names:
        assert getattr(loaded, n) == pytest.approx(getattr(default, n)) if not isinstance(getattr(default, n), str) else getattr(loaded, n) == getattr(default, n)


def test_keyed_draws_do_not_depend_on_the_batch():
    a = uniform(np.array([5, 6, 7]), "entry_land", 0)
    b = uniform(np.array([7]), "entry_land", 0)
    assert a[2] == b[0]
    assert uniform(np.array([7]), "exit_land", 0)[0] != b[0]
    assert uniform(np.array([7]), "entry_land", 1)[0] != b[0]
    u = uniform(np.arange(20000), "buy_fail", 3)
    assert 0 <= u.min() and u.max() < 1 and abs(u.mean() - 0.5) < 0.01


# ------------------------------------------------------------------------------------------------------------ tape
def test_trailing_filter_rejects_a_spike_and_heals_after_a_real_drop():
    price = np.r_[np.full(10, 1.0), 30.0, np.full(8, 0.01)]
    _, ok = trailing_ok(np.zeros(len(price), dtype=np.int32), price, np.ones(len(price)))
    assert ok[:10].all() and not ok[10]
    assert not ok[11:17].any() and ok[17] and ok[18]  # the 7th print at the new level passes
    # another mint is independent: its first price is always ok
    m = np.r_[np.zeros(3, dtype=np.int32), np.ones(1, dtype=np.int32)]
    _, ok2 = trailing_ok(m, np.array([1.0, 1.0, 1.0, 500.0]), np.ones(4))
    assert ok2.all()
    # dust and non-positive prices never set a price
    v, ok3 = trailing_ok(np.zeros(3, dtype=np.int32), np.array([1.0, -1.0, 1.0]), np.array([1.0, 1.0, 0.0005]))
    assert v.tolist() == [True, False, False] and ok3.tolist() == [True, False, False]


def test_ok_flag_is_the_spec_filter():
    # spec/golden/filter.json (features.yaml conventions.tracked_swap): token floor, trailing median and the lone rule
    gold = json.loads((SPEC.parents[0] / "golden" / "filter.json").read_text())
    for case in gold["cases"]:
        s = case["input"]["swaps"]
        wl = {w: i for i, w in enumerate(sorted({x["wallet"] for x in s}))}
        _, ok = trailing_ok(np.zeros(len(s), dtype=np.int32), np.array([x["price"] for x in s], dtype=float),
                            np.array([x["sol"] for x in s], dtype=float), np.array([x["tokens"] for x in s], dtype=float),
                            np.array([wl[x["wallet"]] for x in s]))
        assert ok.tolist() == case["expected"]["ok"], case["name"]
    # random multi-mint, multi-wallet tapes with unit errors, dust and sub-token prints: the one-swap-at-a-time reference
    rng = np.random.default_rng(7)
    for _ in range(200):
        k = int(rng.integers(1, 50))
        m = np.sort(rng.integers(0, 3, k)).astype(np.int32)
        w = rng.integers(0, 4, k)
        price = 1e-6 * np.exp(rng.normal(0, 0.5, k)) * np.where(rng.random(k) < 0.2, 10.0 ** rng.integers(-4, 5, k), 1.0)
        sol = np.where(rng.random(k) < 0.1, 0.0005, rng.uniform(0.001, 2, k))
        tokens = sol / price * np.where(rng.random(k) < 0.1, 1e-9, 1.0)
        _, ok = trailing_ok(m, price, sol, tokens, w)
        ref = np.zeros(k, bool)
        for mm in np.unique(m):
            ix = np.flatnonzero(m == mm)
            ref[ix] = ok_flags([{"wallet": str(w[i]), "price": price[i], "sol": sol[i], "tokens": tokens[i]} for i in ix])
        assert ok.tolist() == ref.tolist()
    # SwapTape (both the spec's and the environment's flag) applies the token floor and the lone rule
    sw_ = flat_tape(0, 100, 10) + [sw(500, P, 105, "buy", P0 * 1e5, 0.5, tokens=0.5)] + [sw(600 + k, P, 106 + k, "buy", P0 * 30, 0.5)
                                                                                         for k in range(3)]
    for env in (True, False):
        tape = SwapTape.from_frame(pd.DataFrame(sw_), env_filter=env)
        assert not (tape.ok_price > P0 * 10).any()  # 0.5 tokens: not valid; P's run 30x above everyone: lone


def test_env_filter_rejects_dust_bursts_and_only_rejects():
    # a burst of dust buys stored in the wrong units (1000x) between real material prints (the 10-31 case behind the first
    # run's 20x-capped B4 winners), by several wallets so the lone rule does not catch it
    price = np.r_[np.full(10, 1.0), np.full(7, 1000.0), np.full(4, 1.1)]
    sol = np.r_[np.full(10, 0.5), np.full(7, 0.001), np.full(4, 0.5)]
    wal = np.r_[np.zeros(10, int), np.arange(7) % 2 + 1, np.zeros(4, int)]
    m = np.zeros(len(price), dtype=np.int32)
    _, spec = trailing_ok(m, price, sol, None, wal)
    _, env = trailing_ok(m, price, sol, None, wal, env=True)
    assert spec[15] and spec[16]                         # the spec flag: the burst takes over the window
    assert env[:10].all() and not env[10:17].any()       # the environment: dust never sets the level
    assert not (env & ~spec).any()                       # it only rejects
    # one wallet's burst is lone: the spec flag rejects it by itself
    _, spec1 = trailing_ok(m, price, sol, None, np.r_[np.zeros(10, int), np.ones(7, int), np.zeros(4, int)])
    assert not spec1[10:17].any()
    # a real lasting drop on material prints heals as in the spec (the 7th print at the new level passes)
    price = np.r_[np.full(10, 1.0), np.full(8, 0.01)]
    _, env = trailing_ok(np.zeros(len(price), dtype=np.int32), price, np.full(len(price), 0.5), env=True)
    assert not env[10:16].any() and env[16] and env[17]
    # dust alone (fewer than JUDGE_MIN_N material prints in reach): the spec's rule
    price = np.r_[np.full(10, 1.0), 30.0]
    _, env = trailing_ok(np.zeros(11, dtype=np.int32), price, np.full(11, 0.002), env=True)
    assert env[:10].all() and not env[10]
    # the environment's tape uses it, the mirror ledger keeps the spec's flag
    sw_ = flat_tape(0, 100, 10) + [sw(500 + k, (P, L)[k % 2], 100 + k, "buy", P0 * 1000, 0.002) for k in range(7)] + flat_tape(110, 150, 10, start_id=600)
    env_tape, spec_tape = SwapTape.from_frame(pd.DataFrame(sw_)), SwapTape.from_frame(pd.DataFrame(sw_), env_filter=False)
    assert not (env_tape.ok_price > P0 * 10).any()
    assert (spec_tape.ok_price > P0 * 10).any()


def test_lookups_stay_inside_their_mint():
    sw_ = flat_tape(0, 50, 10, mint="A") + flat_tape(100, 150, 10, mint="B", start_id=2000)
    tape = SwapTape.from_frame(pd.DataFrame(sw_))
    a, b = tape.mint_code["A"], tape.mint_code["B"]
    t = lambda s: (BASE + s) * 1000 - T0_MS  # noqa: E731
    assert tape.last_ok([b], [t(90)])[0] == -1          # B has no print yet; A's must not leak in
    assert tape.next_ok([a], [t(45)])[0] == -1          # nothing after A's last print
    assert tape.ok_t[tape.last_ok([a], [t(25)])[0]] == t(20)
    assert tape.ok_count([b], [t(100)], [t(130)])[0] == 3
    alive, cens = tape.alive(np.array([a, a]), np.array([t(5), t(45)]), 21_600_000)
    assert alive.tolist() == [True, False] and not cens.any()


def test_alive_is_censored_by_the_data_end_and_outages():
    tape = SwapTape.from_frame(pd.DataFrame(flat_tape(0, 60, 10)), data_end=(BASE + 3600) * 1000 - T0_MS)
    t = (BASE + 55) * 1000 - T0_MS
    alive, cens = tape.alive([0], [t], 21_600_000)
    assert alive[0] and cens[0]
    tape2 = SwapTape.from_frame(pd.DataFrame(flat_tape(0, 60, 10)), outage_h=np.array([(BASE + 7200) * 1000 - T0_MS]))
    alive, cens = tape2.alive([0], [t], 21_600_000)
    assert alive[0] and cens[0]
    alive, cens = tape2.alive([0], [t], 3_600_000)  # the outage hour is outside this lookahead
    assert not alive[0] and not cens[0]


def test_insert_time_lookups():
    # a backfilled history: swaps at t=0..40 stored only at t=1000; a live swap at t=900
    sw_ = [sw(i, O, t, "buy", P0, ins=1000) for i, t in enumerate(range(0, 50, 10))] + [sw(99, P, 900, "sell", P0)]
    tape = SwapTape.from_frame(pd.DataFrame(sw_))
    t = lambda s: (BASE + s) * 1000 - T0_MS  # noqa: E731
    assert tape.first_known_t([0], [t(950)])[0] == t(900)    # the backfill is not known yet
    assert tape.first_known_t([0], [t(1001)])[0] == t(0)
    assert tape.last_known_ok_t([0], [t(950)])[0] == t(900)
    assert tape.first_known_t([0], [t(800)])[0] == -1
    f = tape.flow(np.array([0]), np.array([tape.wallet_code[P]]), np.array([t(1001)]), 300_000)
    assert f["oth_buyers_5m"][0] == 1 and f["oth_sellers_5m"][0] == 0  # 5 buys by one wallet = 1 buyer; P is the leader
    assert f["pts_5m"][0] == 6 and f["oth_net_sol_5m"][0] == pytest.approx(5.0)
    # block time ("as if live", the simulator's clock): the backfill was on the stream at its ts
    assert tape.first_t([0], [t(950)])[0] == t(0)
    assert tape.first_t([0], [t(0)])[0] == -1             # strictly before t
    assert tape.first_t([-1], [t(950)])[0] == -1          # not on the tape
    f = tape.flow(np.array([0]), np.array([tape.wallet_code[P]]), np.array([t(60)]), 300_000, clock="block")
    assert f["oth_buyers_5m"][0] == 1 and f["pts_5m"][0] == 5 and f["oth_net_sol_5m"][0] == pytest.approx(5.0)


# ------------------------------------------------------------------------------------------------------------ entry
def test_entry_fill_is_model_ts_buy_fill_at_the_land_time():
    swaps = flat_tape(0, 600) + [sw(1, L, 100, "buy", P0 * 1.002, 1.0)]
    data, p = build(swaps, [signal(1, 100, price=P0 * 1.002)])
    out = run(data, p, policy=hold)
    E = (BASE + 104) * 1000
    r = model_tape(swaps, p).midAt(E)
    want = buyFill(r["mid"], 0.1, r["depth"], p.fee_bps)
    assert out["entered"][0]
    assert out["E"][0] == E - T0_MS
    assert out["entry_px"][0] == pytest.approx(want["price"], rel=1e-12)


def test_the_entry_never_lands_before_the_decision():
    # land 4 s after the leader but decided 9 s late: the buy lands 1 s after the decision, on the price of then
    swaps = flat_tape(0, 600, every=1) + [sw(1, L, 100, "buy", P0, 1.0)]
    data, p = build(swaps, [signal(1, 100)], p=params(lateness_mu=math.log(9)))
    out = run(data, p, policy=hold)
    assert out["E"][0] == (BASE + 110) * 1000 - T0_MS
    # random draws: every entered copy lands at least entry_after_decision_s after its decision
    sigs = [signal(100 + i, 100 + 3 * i) for i in range(150)]
    swaps += [sw(100 + i, L, 100 + 3 * i, "buy", P0, 1.0) for i in range(150)]
    data, p = build(swaps, sigs, p=SimParams(buy_fail_p=0.0))
    out = run(data, p, policy=hold)
    e = out["entered"].to_numpy()
    assert e.sum() > 100
    assert (out["E"].to_numpy()[e] >= out["t_dec"].to_numpy()[e] + 1000).all()


def test_gates_buy_failure_and_unfillable_entries():
    swaps = flat_tape(0, 300) + [sw(1, L, 100, "buy", P0)]
    data, p = build(swaps, [signal(1, 100)], p=params(lateness_mu=math.log(61)))
    out = run(data, p)
    assert out["reason"][0] == "too-late" and out["pnl"][0] == 0
    data, p = build(swaps, [signal(1, 100)], p=params(buy_fail_p=1.0))
    out = run(data, p)
    assert out["reason"][0] == "buy-fail" and out["pnl"][0] == pytest.approx(-p.tx_cost_sol)
    # no ok print at or before the land time and none within 120 s: dead from entry on pumpswap, else no fill
    later = flat_tape(500, 700, mint="M1")
    data, p = build(later, [signal(1, 100, venue="pumpswap")])
    out = run(data, p)
    assert out["reason"][0] == "dead-entry" and out["pnl"][0] == pytest.approx(-0.1 - p.tx_cost_sol - p.rent_sol)
    data, p = build(later, [signal(1, 100, venue="pumpfun")])
    assert run(data, p)["reason"][0] == "no-fill"
    # a broken print (30x the leader's price) is dropped
    data, p = build(swaps, [signal(1, 100, price=P0 / 30)])
    assert run(data, p)["reason"][0] == "bad-print"


def test_young_amm_and_hiprice_gates():
    swaps = [sw(1, O, 0, "buy", 2e-4), sw(2, L, 100, "buy", 2e-4), sw(3, P, 2000, "buy", P0, mint="M2"), sw(4, L, 2100, "buy", P0, mint="M2")]
    sigs = [signal(2, 100, price=2e-4, venue="pumpswap"), signal(4, 2100, mint="M2", venue="meteora"), signal(5, 2100, mint="M2", venue="pumpfun")]
    data, _ = build(swaps, sigs)
    g = data.sig["gate"].tolist()
    assert g[0] == "pumpswap_hiprice"   # also young (first sighting 100 s ago), the first gate listed wins
    assert g[1] == "young_amm"          # first tracked sighting 100 s before: < 10 min
    assert g[2] == ""                   # bonding curve: not an AMM
    # an AMM coin first seen 8 days before the decision is old, not young (mint_first_seen_age_min caps at 7 d)
    old = [sw(1, O, -8 * 86400, "buy", P0, mint="M3"), sw(2, L, 100, "buy", P0, mint="M3")]
    data, _ = build(old, [signal(2, 100, mint="M3", venue="raydium")])
    assert data.sig["gate"].tolist() == [""]
    # block time: an AMM coin traded an hour before, but stored only days later (a backfill), is not young
    late = [sw(1, O, -3600, "buy", P0, mint="M4", ins=2 * 86400), sw(2, L, 100, "buy", P0, mint="M4", ins=2 * 86400)]
    data, _ = build(late, [signal(2, 100, mint="M4", venue="pumpswap")])
    assert data.sig["gate"].tolist() == [""]


# ------------------------------------------------------------------------------------------------------------ exits
def test_leader_follow_sells_at_the_print_nearest_the_land_time():
    swaps = flat_tape(0, 900) + [sw(1, L, 100, "buy", P0, 1.0, tokens=1e6), sw(2, L, 200, "sell", P0, 1.0, tokens=1e6, bal=1e6)]
    data, p = build(swaps, [signal(1, 100)])
    out = run(data, p)
    assert out["reason"][0] == "exit"
    L_ms = (BASE + 202) * 1000
    mt = model_tape(swaps, p)
    r = mt.midAt(L_ms)  # the print at 200 is 2 s old, the next (205) 3 s ahead: the older one is nearer
    E = (BASE + 104) * 1000
    re = mt.midAt(E)
    tokens = 0.1 / buyFill(re["mid"], 0.1, re["depth"], p.fee_bps)["price"]
    proceeds = sellFill(r["mid"], tokens, r["depth"], p.fee_bps)["sol"] * (1 - p.sell_resid_slip)
    assert out["pnl"][0] == pytest.approx(proceeds - 0.1 - 2 * p.tx_cost_sol, rel=1e-9)
    assert out["close_t"][0] == L_ms - T0_MS


def test_forward_price_only_within_10s():
    # quiet tape: the last print before the land time is 42 s old; the next comes 8 s after it -> used (dust sells set no price)
    swaps = [sw(1, L, 100, "buy", P0, 1.0, tokens=1e6), sw(2, O, 100, "sell", P0, 1.0), sw(3, L, 140, "sell", P0, 0.0005, tokens=1e6, bal=1e6),
             sw(4, O, 150, "buy", 2 * P0, 1.0), sw(5, O, 3000, "buy", 2 * P0, 1.0)]
    data, p = build(swaps, [signal(1, 100)])
    b = data.book([0], 0.1, p)
    v, nr, age, _ = b.sale_value(np.array([0]), np.array([(BASE + 142) * 1000 - T0_MS]), np.array([1e5]))
    assert not nr[0] and age[0] == pytest.approx(8.0)          # forward print at 150
    v2, _, age2, _ = b.sale_value(np.array([0]), np.array([(BASE + 120) * 1000 - T0_MS]), np.array([1e5]))
    assert age2[0] == pytest.approx(20.0)                      # 150 is 30 s ahead: never used; the print at 100 is
    assert v[0] > 1.5 * v2[0]


def test_sell_during_the_copy_delay_is_applied_at_the_fill():
    swaps = flat_tape(0, 600) + [sw(1, L, 100, "buy", P0, 1.0, tokens=1e6), sw(2, L, 102, "sell", P0, 1.0, tokens=1e6, bal=1e6)]
    data, p = build(swaps, [signal(1, 100)])
    out = run(data, p)
    assert out["reason"][0] == "exit"
    assert out["close_t"][0] == (BASE + 106) * 1000 - T0_MS  # decided at the fill (104), lands 2 s later


def test_partial_leader_sells_follow_the_fraction():
    swaps = flat_tape(0, 900) + [sw(1, L, 100, "buy", P0, 1.0, tokens=1e6), sw(2, L, 200, "sell", P0, 0.5, tokens=5e5, bal=1e6),
                                 sw(3, L, 300, "sell", P0, 0.5, tokens=5e5, bal=5e5)]
    data, p = build(swaps, [signal(1, 100)])
    b = data.book([0], 0.1, p)
    engine.run(b, follow)
    o = b.outcomes()
    assert o["reason"][0] == "exit" and o["n_tx"][0] == 3 and o["half_sold"][0]
    assert o["close_t"][0] == (BASE + 302) * 1000 - T0_MS


def test_a_dead_coin_is_written_off_after_three_failed_quotes():
    swaps = flat_tape(0, 300) + [sw(1, L, 100, "buy", P0)]
    data, p = build(swaps, [signal(1, 100)])
    out = run(data, p)
    assert out["reason"][0] == "dead" and out["rent_lost"][0]
    assert out["pnl"][0] == pytest.approx(-0.1 - p.tx_cost_sol - p.rent_sol)
    q = QuoteModel.fallback()
    ages = np.arange(60, 3600, 60.0)
    first_fail = ages[q.f_dark(ages) < p.no_route_below][0]
    dt = out["close_t"][0] - ((BASE + 295) * 1000 - T0_MS)
    assert first_fail * 1000 <= dt <= (first_fail + 4 * 60) * 1000
    # the policy never sees the dead coin as alive at its last price: no decision with quote_failed
    data, p = build(swaps, [signal(1, 100)])
    seen = []
    b = data.book([0], 0.1, p)
    engine.run(b, lambda st, d: seen.append(st["quote_failed"].max()) or np.zeros(len(st["ret_now"])))
    assert max(seen) == 0


def test_a_quiet_but_alive_coin_is_not_written_off():
    swaps = flat_tape(0, 300) + flat_tape(7000, 7100, start_id=5000) + [sw(1, L, 100, "buy", P0), sw(2, L, 7050, "sell", P0, tokens=1e6, bal=1e6)]
    data, p = build(swaps, [signal(1, 100)])
    out = run(data, p)
    assert out["reason"][0] == "exit"


def test_hard_stop_fills_at_the_gap():
    swaps = flat_tape(0, 300) + flat_tape(300, 900, price=0.3 * P0, start_id=3000) + [sw(1, L, 100, "buy", P0)]
    data, p = build(swaps, [signal(1, 100)])
    out = run(data, p, policy=hold)
    assert out["reason"][0] == "hard-stop"
    assert -0.1 * 0.75 < out["pnl"][0] < -0.1 * 0.68   # about -70 % plus costs, not the -60 % level
    assert out["close_t"][0] <= (BASE + 300 + 15 + 3) * 1000 - T0_MS


def test_hard_stop_fires_on_the_mark_without_hindsight():
    # a quiet coin whose sell quotes (obs) come in 70 % under its last price: paper.ts stops out on that quote, even though
    # the coin trades again at the old price later (the hindsight sale value would say "no stop")
    swaps = flat_tape(0, 300) + flat_tape(4000, 4300, start_id=5000) + [sw(1, L, 100, "buy", P0)]
    data, p = build(swaps, [signal(1, 100)])
    q = QuoteModel.fallback()
    low = QuoteModel(alive=q.alive, dark=q.dark, obs=q.obs * 0.3, meta={})
    data = engine.SimData(data.tape, data.sig, data.sells, low)
    out = run(data, p, policy=hold)
    assert out["reason"][0] == "hard-stop"
    assert out["close_t"][0] < (BASE + 4000) * 1000 - T0_MS


def test_max_hold_sells_after_24h():
    swaps = flat_tape(0, 90_000, every=60) + [sw(1, L, 100, "buy", P0)]
    data, p = build(swaps, [signal(1, 100)])
    out = run(data, p, policy=hold)
    assert out["reason"][0] == "max-hold"
    assert out["hold_s"][0] == pytest.approx(86_400 + 2)


def test_open_at_the_data_end_is_censored():
    swaps = flat_tape(0, 4000, every=30) + [sw(1, L, 100, "buy", P0)]
    data, p = build(swaps, [signal(1, 100)], data_end=3000)
    out = run(data, p, policy=hold)
    assert out["reason"][0] == "data-end" and out["censored"][0]


def test_one_window_many_signals_vectorised_matches_one_by_one():
    swaps = flat_tape(0, 4000, every=7) + flat_tape(0, 4000, every=11, mint="M2", start_id=9000)
    sigs = []
    for i, (t, m) in enumerate([(100, "M1"), (400, "M2"), (900, "M1"), (1500, "M2")]):
        swaps += [sw(100 + i, L, t, "buy", P0, mint=m, tokens=1e6), sw(200 + i, L, t + 300 + 50 * i, "sell", P0, mint=m, tokens=5e5, bal=1e6)]
        sigs.append(signal(100 + i, t, mint=m))
    data, p = build(swaps, sigs, p=params(entry_land_sigma=0.5, exit_land_sigma=0.5))
    all_ = run(data, p)
    for i in range(4):
        one = run(data, p, rows=[i])
        assert one["pnl"][0] == pytest.approx(all_["pnl"][i], rel=1e-12)
        assert one["close_t"][0] == all_["close_t"][i]


def test_chaos_rug_injection_and_sell_failures():
    swaps = flat_tape(0, 20_000, every=20) + [sw(1, L, 100, "buy", P0)]
    data, p = build(swaps, [signal(1, 100)])
    out = run(data, p, policy=hold, chaos=Chaos(rug_rate=1.0))
    assert out["reason"][0] in ("dead", "write-off") and out["pnl"][0] < -0.1
    # every sale attempt fails once (p 1 then retry): the leader's exit lands only after the retry delay
    swaps = flat_tape(0, 90_000, every=20) + [sw(1, L, 100, "buy", P0, tokens=1e6), sw(2, L, 200, "sell", P0, tokens=1e6, bal=1e6)]
    data, p = build(swaps, [signal(1, 100)])
    base = run(data, p)
    fail = run(data, p, chaos=Chaos(sell_fail_p=0.5, sell_retry_p50_s=600.0))
    assert base["reason"][0] == "exit"
    assert fail["close_t"][0] >= base["close_t"][0]


def test_one_clock_a_fresh_mark_is_a_recent_tracked_price():
    # a backfilled day: every swap stored two days after its ts. The exit state runs on block time like the marks, so a
    # fresh mark never sits next to "no tracked price for hours", and the crowd's flow is there
    late = 2 * 86400
    swaps = [dict(r, ins_ts=r["ts"] + pd.Timedelta(seconds=late)) for r in flat_tape(0, 900, every=7) + flat_tape(1500, 1700, every=7, start_id=5000)]
    swaps += [sw(1, L, 100, "buy", P0, tokens=1e6, ins=100 + late)]
    data, p = build(swaps, [signal(1, 100)])
    b = data.book(np.arange(1), 0.1, p, features=True)
    seen = []

    def keep(st, d):
        seen.append({k: np.asarray(st[k]).copy() for k in ("age_s", "mins_since_tracked_price", "oth_buyers_5m", "pts_5m")})
        return np.zeros(len(d.idx))
    engine.run(b, keep)
    age = np.concatenate([x["age_s"] for x in seen])
    mstp = np.concatenate([x["mins_since_tracked_price"] for x in seen])
    assert (age <= 90).any() and (age > 90).any()
    assert (mstp[age <= 90] <= 1.5).all()
    assert mstp == pytest.approx(np.minimum(age / 60, 1440))
    # by insert time all of it would be 0 (nothing stored yet); the one exception is the print that ends the gap itself
    assert (np.concatenate([x["oth_buyers_5m"] for x in seen])[age <= 90] > 0).mean() > 0.95
    assert (np.concatenate([x["pts_5m"] for x in seen])[age <= 90] > 0).mean() > 0.95


def test_a_leader_sell_during_a_pending_retry_is_delivered_after_it():
    # sell_half at the first tick fails (retry in 120 s); the leader sells everything meanwhile. The leader-sell event waits
    # for the retry and is then delivered: the follow-the-leader exit still happens
    p = params(sell_retry_sigma=0.0)
    c = Chaos(sell_fail_p=0.5, sell_retry_p50_s=120.0)
    u = lambda e, a: uniform(np.array([e]), "sell_fail", 0, a)[0]  # noqa: E731
    eid = next(e for e in range(1, 10_000) if u(e, 1) < 0.5 <= min(u(e, 2), u(e, 3)))
    swaps = flat_tape(0, 5000) + [sw(eid, L, 100, "buy", P0, tokens=1e6), sw(eid + 1, L, 170, "sell", P0, tokens=1e6, bal=1e6)]
    data, p = build(swaps, [signal(eid, 100)], p=p)
    seen = []

    def policy(st, d):
        seen.append({k: np.asarray(st[k]).copy() for k in ("t", "event_leader_sell", "minutes_since_leader_sold", "half_sold")})
        f = st["leader_sell_frac"]
        half = st["event_tick"] & (st["half_sold"] == 0) & (st["minutes_held"] >= 1)
        return np.where(st["event_leader_sell"], np.where(f >= 0.9, 1.0, f), np.where(half, 0.5, 0.0))
    out = run(data, p, policy=policy, chaos=c)
    t = lambda s: (BASE + s) * 1000 - T0_MS  # noqa: E731
    ls = [x for x in seen if x["event_leader_sell"][0]]
    assert len(ls) == 1
    assert ls[0]["t"][0] == t(104 + 60 + 2 + 120)        # tick at E + 60, sale lands 2 s later, fails, retry 120 s later
    assert ls[0]["half_sold"][0] == 1                     # the retried half has landed
    assert ls[0]["minutes_since_leader_sold"][0] == pytest.approx((286 - 170) / 60)
    assert out["reason"][0] == "exit" and out["half_sold"][0]
    assert out["close_t"][0] == t(286 + 2)


def test_the_data_end_is_the_label_end():
    from brain.sim.evaluate import data_end_ts
    # the export tail (DATA.md pitfall 18) is not replayed: label_end_t wins, data_end_t only for builds without it
    assert data_end_ts({"data_end_t": 1793981126, "label_end_t": 1793826000}) == pd.Timestamp("2026-11-04T21:00:00Z")
    assert data_end_ts({"data_end_t": 1793981126}) == pd.Timestamp(1793981126, unit="s", tz="UTC")


def test_window_days_are_the_days_with_signals(monkeypatch):
    from brain.sim import evaluate, stress
    sig = pd.DataFrame({"day": ["2026-11-02", "2026-11-03", "2026-11-03"]})
    # a test period running to the label end (11-04 21:00) has no signals on 11-04: crosses_outage drops them all
    assert evaluate.signal_days(sig, "2026-11-02", "2026-11-04T21:00Z") == ["2026-11-02", "2026-11-03"]
    assert evaluate.signal_days(sig.iloc[:0], "2026-11-02", "2026-11-04") == ["2026-11-02", "2026-11-03"]
    monkeypatch.setattr(evaluate, "data_end_ts", lambda meta=None: pd.Timestamp("2026-11-04T21:00:00Z"))
    assert stress.test_days()[-1] == "2026-11-03"
    monkeypatch.setattr(evaluate, "data_end_ts", lambda meta=None: pd.Timestamp("2026-11-05T00:00:00Z"))
    assert stress.test_days()[-1] == "2026-11-03"  # a buy at 11-04 00:00 needs its 24 h window before the label end


def test_the_account_uses_the_fees_the_book_charged():
    from brain.sim.account import account
    swaps = flat_tape(0, 3000, every=10) + [sw(1, L, 100, "buy", P0, tokens=1e6), sw(2, L, 400, "sell", P0, tokens=1e6, bal=1e6)]
    hour = (BASE // 3600) * 3600
    chaos = Chaos(tx_cost_sol=0.0008, tx_spike={hour: 5.0, hour + 3600: 5.0})
    data, p = build(swaps, [signal(1, 100)], chaos=chaos)
    out = run(data, p, chaos=chaos)
    assert out["reason"][0] == "exit" and out["n_tx"][0] == 2
    assert out["fees"][0] == pytest.approx(2 * 0.004) and out["fee_open"][0] == pytest.approx(0.004)
    # a budget-shrunk position keeps the book's fees fixed (not n_tx x the base fee) and cash nets to its pnl
    small = SimParams(**{**DET, "bankroll_sol": 0.05})
    acc = account(out, out["t_dec"].to_numpy(), small)
    size = acc["size"][0]
    assert size == pytest.approx(0.05 - 0.004 - small.rent_sol)  # cash: the stake, the buy's own (spiked) fee and the rent
    assert acc["pnl_acct"][0] == pytest.approx((out["pnl"][0] + 0.008) * size / 0.1 - 0.008)
    # without the columns (older frames): the base fee per transaction
    legacy = account(out.drop(columns=["fees", "fee_open"]), out["t_dec"].to_numpy(), small)
    assert legacy["pnl_acct"][0] == pytest.approx((out["pnl"][0] + 2 * small.tx_cost_sol) * legacy["size"][0] / 0.1 - 2 * small.tx_cost_sol)


def test_env_actions_are_indices_unless_fractions_is_set():
    from brain.sim.env import BatchEnv
    swaps = flat_tape(0, 3000, every=10) + [sw(1, L, 100, "buy", P0, tokens=1e6)]
    data, p = build(swaps, [signal(1, 100)])
    env = BatchEnv(data, p, kappa=1.5, features=False)
    env.reset([0])
    env.step(np.array([1.0]))  # an index, never guessed as a fraction: sell_half
    assert env.book.half[0] and not env.book.closed[0]
    with pytest.raises(ValueError):
        env.step(np.array([0.5]))
    env.step(np.array([1.0]), fractions=True)  # sell all that is left
    assert env.book.closed[0] and env.dec is None
