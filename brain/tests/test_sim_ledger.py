"""brain.sim.ledger against the spec implementation (brain/features/build.py ledger_rows, what the brain's cp_* entry
features are built from): row by row on random tapes, the rules where the first ledger differed (the 24 h bound on
the follow exit, a leader sell with no exit print, a stop after the exit clock, dead = -1 with no haircut), and the
tape's ok-filter warm-up."""
from __future__ import annotations

import duckdb
import numpy as np
import pandas as pd
import pytest

from brain.data.derive import TRAIL_WINDOW
from brain.features.build import KIND_MIRROR, ledger_rows
from brain.sim.ledger import HAIRCUT, Y_CAP, mirror
from brain.sim.signals import prepare
from brain.sim.tape import T0_MS, SwapTape, tape_frame
from test_sim_engine import BASE, L, O, P, P0, sw

H = 3600
LEADERS = ("Lead1", "Lead2")
END = 10**13  # data end far away: every row resolved


def signals_of(swaps: list[dict], leaders=LEADERS) -> pd.DataFrame:
    """Every leader buy >= 0.2 SOL of the swaps as a signal (episode_id = the swap id, ins = the swap's insert time)."""
    rows = [{"episode_id": s["id"], "leader": s["wallet"], "mint": s["mint"], "ts": s["ts"], "ins_ts": s["ins_ts"], "venue": "pumpfun"}
            for s in swaps if s["wallet"] in leaders and s["side"] == "buy" and s["sol_amount"] >= 0.2]
    return prepare(pd.DataFrame(rows))


def spec_rows(tape: SwapTape, sig: pd.DataFrame) -> pd.DataFrame:
    """build.ledger_rows (seconds) on the same tape and ok flag: (episode_id, y, resolved_ms)."""
    m, w = tape.mint.astype(np.int64), tape.wallet.astype(np.int64)
    t, a = (tape.t + T0_MS) // 1000, (tape.ins + T0_MS) // 1000
    buy = tape.side > 0
    pe = pd.Index(tape.id).get_indexer(sig["episode_id"].to_numpy())
    assert (pe >= 0).all()
    ls_pos = np.full(len(pe), -1, dtype=np.int64)  # the leader's next sell of the coin after the buy (tape order)
    for k, p in enumerate(pe):
        later = np.flatnonzero((np.arange(len(m)) > p) & (m == m[p]) & (w == w[p]) & ~buy)
        ls_pos[k] = later[0] if len(later) else -1
    led = ledger_rows(m, w, t, a, buy, tape.price, tape.ok, t[pe], m[pe], w[pe], a[pe], tape.sol[pe], ls_pos)
    led = led[led["kind"] == KIND_MIRROR]
    return pd.DataFrame({"episode_id": sig["episode_id"].to_numpy()[led["ep"].to_numpy()], "y": np.minimum(led["v"].to_numpy(), Y_CAP),
                         "resolved_ms": led["at"].to_numpy() * 1000 - T0_MS}).set_index("episode_id").sort_index()


def random_swaps(seed: int) -> list[dict]:
    rng = np.random.default_rng(seed)
    wallets = list(LEADERS) + [O, P, "Fourth444", "Fifth555"]
    out, i = [], 1
    for mint in ("M1", "M2", "M3", "M4"):
        t, lp = 0, np.log(P0)
        for _ in range(int(rng.integers(40, 160))):
            t += int(rng.choice([0, 1, 5, 20, 120, 900, 4 * H, 9 * H], p=[0.1, 0.2, 0.25, 0.2, 0.12, 0.08, 0.03, 0.02]))
            lp += rng.normal(0, 0.25) + (np.log(0.25) if rng.random() < 0.04 else 0.0)  # drift, and now and then a crash
            price = float(np.exp(lp)) * (1000.0 if rng.random() < 0.02 else 1.0)       # a unit-error print
            sol = float(rng.choice([0.0005, 0.05, 0.3, 1.5]))
            lag = int(rng.choice([0, 2, 60, 3 * H], p=[0.4, 0.4, 0.15, 0.05]))
            out.append(sw(i, wallets[int(rng.integers(len(wallets)))], t, "buy" if rng.random() < 0.55 else "sell", price, sol=sol,
                          mint=mint, ins=t + lag))
            i += 1
    return out


@pytest.mark.parametrize("seed", range(8))
def test_mirror_matches_build_ledger_rows(seed):
    swaps = random_swaps(seed)
    tape = SwapTape.from_frame(pd.DataFrame(swaps), env_filter=False, insert_index=False)
    sig = signals_of(swaps)
    got = mirror(sig, tape, END).set_index("episode_id").sort_index()
    want = spec_rows(tape, sig)
    assert len(want) > 5
    assert got.index.tolist() == want.index.tolist()
    np.testing.assert_allclose(got["y"].to_numpy(), want["y"].to_numpy(), rtol=1e-12, atol=1e-12)
    assert got["resolved_ms"].tolist() == want["resolved_ms"].tolist()


def test_mirror_rules_the_first_ledger_broke():
    ms = lambda s: (BASE + s) * 1000 - T0_MS  # noqa: E731
    # M1: the leader sells at 23 h 50 min; the first non-leader sell comes at 24 h 5 min: not a follow exit (after buy + 24 h)
    # but the grounded 24 h value, the first ok print at or after buy + 24 h
    s = [sw(1, L, 100, "buy", P0, tokens=1e6), sw(2, O, 120, "buy", P0), sw(3, L, 100 + 86_100, "sell", P0, tokens=1e6, bal=1e6),
         sw(4, P, 100 + 86_420, "buy", 1.5 * P0), sw(5, O, 100 + 86_700, "sell", 3 * P0)]
    # M2: the leader sold, no non-leader sell ever, but the coin trades at 24 h: grounded (the first ledger wrote -1)
    s += [sw(10, L, 100, "buy", P0, mint="M2", tokens=1e6), sw(11, O, 120, "buy", P0, mint="M2"),
          sw(12, L, 500, "sell", P0, mint="M2", tokens=1e6, bal=1e6), sw(13, P, 100 + 86_400 + 60, "buy", 2 * P0, mint="M2")]
    # M3: a -60 % print after the exit clock (leader sell + 15 s) but before the first non-leader sell: the stop wins
    s += [sw(20, L, 100, "buy", P0, mint="M3", tokens=1e6), sw(21, O, 120, "buy", P0, mint="M3"),
          sw(22, L, 300, "sell", P0, mint="M3", tokens=1e6, bal=1e6), sw(23, P, 400, "buy", 0.3 * P0, mint="M3"),
          sw(24, O, 500, "sell", 0.3 * P0, mint="M3")]
    # M4: dead after the entry: y = -1 exactly (no haircut), resolved at buy + 30 h
    s += [sw(30, L, 100, "buy", P0, mint="M4", tokens=1e6), sw(31, O, 120, "buy", P0, mint="M4")]
    tape = SwapTape.from_frame(pd.DataFrame(s), env_filter=False, insert_index=False)
    sig = signals_of(s, leaders=(L,))
    led = mirror(sig, tape, END).set_index("episode_id")
    assert led.loc[1, "how"] == "held" and led.loc[1, "y"] == pytest.approx(1.5 - 1 - HAIRCUT)
    assert led.loc[1, "resolved_ms"] == ms(100 + 86_420)
    assert led.loc[10, "how"] == "held" and led.loc[10, "y"] == pytest.approx(2.0 - 1 - HAIRCUT)
    assert led.loc[20, "how"] == "stop" and led.loc[20, "y"] == pytest.approx(0.3 - 1 - HAIRCUT)
    assert led.loc[20, "resolved_ms"] == ms(400)
    assert led.loc[30, "how"] == "held_dark" and led.loc[30, "y"] == -1.0 and led.loc[30, "resolved_ms"] == ms(100 + 30 * H)
    want = spec_rows(tape, sig)
    np.testing.assert_allclose(led.sort_index()["y"].to_numpy(), want["y"].to_numpy(), rtol=1e-12)


def test_tape_warm_up_gives_the_full_history_ok_flag():
    # a mint that moved 30x two days in, then a 400x spike as the window opens: with only the window's prints the spike is
    # the first print and is judged against nothing; with the warm-up rows it sees the previous 10 valid prices, as
    # derive's full-history flag does
    rng = np.random.default_rng(3)
    rows, i = [], 1
    for k in range(60):  # history at the old level, then a 30x move, and prints in the window
        t = k * 4000
        rows.append(sw(i, [O, P, L][k % 3], t, "buy", P0 * (30 if k >= 50 else 1) * float(np.exp(rng.normal(0, 0.1))), sol=0.5)); i += 1
    rows.append(sw(i, O, 55 * 4000 - 10, "buy", P0 * 30 * 400, sol=0.5)); i += 1  # the spike: the window's first print
    rows.append(sw(i, "Dust", 40 * 4000, "buy", P0, sol=0.0001)); i += 1          # invalid: never a warm-up row
    df = pd.DataFrame(rows)
    con = duckdb.connect()
    con.register("_sw", df)
    con.execute("CREATE TABLE wallet_swaps AS SELECT * EXCLUDE (ins_ts) FROM _sw")
    start, end = pd.Timestamp(BASE + 55 * 4000 - 50, unit="s", tz="UTC"), pd.Timestamp(BASE + 70 * 4000, unit="s", tz="UTC")
    full = SwapTape.from_frame(tape_frame(con, ["M1"], pd.Timestamp(BASE, unit="s", tz="UTC"), end), env_filter=False, insert_index=False)
    warm_df = tape_frame(con, ["M1"], start, end, warm=TRAIL_WINDOW, warm_from=pd.Timestamp(BASE, unit="s", tz="UTC"))
    assert len(warm_df) == (59 - 55 + 1) + 1 + TRAIL_WINDOW
    warm = SwapTape.from_frame(warm_df, env_filter=False, insert_index=False)
    cold = SwapTape.from_frame(tape_frame(con, ["M1"], start, end), env_filter=False, insert_index=False)
    t0 = (BASE + 55 * 4000 - 50) * 1000 - T0_MS
    flags = lambda tp: dict(zip(tp.id[tp.t >= t0].tolist(), tp.ok[tp.t >= t0].tolist()))  # noqa: E731
    assert flags(warm) == flags(full)
    assert not flags(full)[i - 2]       # the spike is rejected with the history ...
    assert flags(cold) != flags(full)   # ... and the window alone gets some flags wrong
