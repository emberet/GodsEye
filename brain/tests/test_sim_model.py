"""brain.sim.model against the golden fixtures of agent/src/replay/model.ts (sim.yaml reference_implementation): every
probe (midAt / buyFill / sellFill) and every simulated position field to 1e-9 relative, plus a few hand-checked formulas."""
from __future__ import annotations

import json
from dataclasses import asdict
from pathlib import Path

import pytest

from brain.data.loaders import data_dir
from brain.sim.model import DEFAULT_PARAMS, LeaderSwap, Obs, ReplayParams, Tape, buyFill, sellFill, simulateMint

PARITY = data_dir() / "research" / "sim-fidelity" / "parity"
REL = 1e-9


def run_case(c: dict) -> dict:
    p = ReplayParams(**{**asdict(DEFAULT_PARAMS), **c["params"]})

    def mk() -> Tape:
        obs = [Obs(o["t"], o["side"], o["price"], o["sol"], o.get("sig")) for o in c["obs"]]
        return Tape(obs, p.feeBps, p.defaultDepthSol, p.depthWindowSec * 1000, p.fixedDepthSol)

    t1 = mk()
    probes = []
    for t in c["probes"]:
        r = t1.midAt(t)
        if not r:
            probes.append(None)
            continue
        r = {k: v for k, v in r.items() if k != "i"}
        probes.append({**r, "buy": buyFill(r["mid"], p.sizeSol, r["depth"], p.feeBps), "sell": sellFill(r["mid"], 1e6, r["depth"], p.feeBps)})
    eps = simulateMint(mk(), "MINT", [LeaderSwap(**s) for s in c["swaps"]], c["endT"], p)
    return {"name": c["name"], "probes": probes, "episodes": eps}


def compare(a, b, path: str, worst: list) -> None:
    if isinstance(a, dict):
        assert isinstance(b, dict) and set(a) == set(b), f"{path}: keys differ"
        for k in a:
            compare(a[k], b[k], f"{path}.{k}", worst)
    elif isinstance(a, list):
        assert isinstance(b, list) and len(a) == len(b), f"{path}: length differs"
        for i, (x, y) in enumerate(zip(a, b)):
            compare(x, y, f"{path}[{i}]", worst)
    elif isinstance(a, (int, float)) and not isinstance(a, bool) and isinstance(b, (int, float)) and not isinstance(b, bool):
        d = abs(a - b) / max(1e-300, abs(a), abs(b)) if (a or b) else 0.0
        if d > worst[0]:
            worst[0], worst[1] = d, path
    else:
        assert a == b, f"{path}: {a!r} vs {b!r}"


@pytest.mark.skipif(not (PARITY / "ts_out.json").is_file(), reason="golden fixtures not on this machine (data drive)")
def test_golden_fixtures_match_model_ts():
    cases = json.loads((PARITY / "cases.json").read_text())
    ts_out = json.loads((PARITY / "ts_out.json").read_text())
    assert len(cases) == len(ts_out) >= 300
    worst = [0.0, ""]
    n_pos = 0
    for c, want in zip(cases, ts_out):
        got = run_case(c)
        compare(want, got, c["name"], worst)
        n_pos += len(want["episodes"])
    assert n_pos > 600
    assert worst[0] <= REL, f"max relative difference {worst[0]:.3e} at {worst[1]}"


def test_fill_formulas():
    # 100 bps fee, own impact = size / depth, capped at MAX_IMPACT
    b = buyFill(1e-6, 0.1, 50.0, 100)
    assert b["price"] == pytest.approx(1e-6 * 1.01 * (1 + 0.1 / 50))
    assert b["tokens"] == pytest.approx(0.1 / b["price"])
    s = sellFill(1e-6, 1e5, 50.0, 100)
    assert s["price"] == pytest.approx(1e-6 * 0.99 / (1 + 0.1 / 50))
    assert sellFill(1.0, 1e9, 1.0, 100)["price"] == pytest.approx(0.99 / 4)  # impact capped at 3


def test_mid_strips_fee_and_adds_the_prints_own_impact():
    tape = Tape([Obs(0, "buy", 1.01, 30.0), Obs(1000, "sell", 0.99, 30.0)], 100, 30.0, 600_000)
    r = tape.midAt(500)
    assert r["mid"] == pytest.approx(1.0 * (1 + 1.0))  # depth 30 default, impact 30/30
    assert r["ageSec"] == pytest.approx(0.5)
    assert tape.midAt(-1) is None
    assert tape.midAt(2000)["mid"] == pytest.approx(1.0 / 2.0)


@pytest.mark.skipif(not (PARITY / "ts_out.json").is_file(), reason="golden fixtures not on this machine (data drive)")
def test_vectorised_tape_matches_model_ts_probes():
    """The engine's fills go through SwapTape.mid_at / depth_at (vectorised), not Tape: they too must reproduce the TS probes."""
    import numpy as np

    from brain.sim.tape import T0_MS, SwapTape
    cases = json.loads((PARITY / "cases.json").read_text())
    ts_out = json.loads((PARITY / "ts_out.json").read_text())
    worst, n = [0.0, ""], 0
    for c, want in zip(cases, ts_out):
        p = ReplayParams(**{**asdict(DEFAULT_PARAMS), **c["params"]})
        if p.fixedDepthSol is not None or not c["obs"]:
            continue
        obs = c["obs"]
        k = len(obs)
        tape = SwapTape(mints=np.array(["M"]), wallets=np.array(["w"]), id=np.arange(k), mint=np.zeros(k, np.int32),
                        t=np.array([o["t"] for o in obs], np.int64) - T0_MS, wallet=np.zeros(k, np.int32),
                        side=np.array([1 if o["side"] == "buy" else -1 for o in obs], np.int8), sol=np.array([o["sol"] for o in obs]),
                        price=np.array([o["price"] for o in obs]), tokens=np.zeros(k), bal=np.zeros(k),
                        ins=np.array([o["t"] for o in obs], np.int64) - T0_MS, ok=np.ones(k, bool), fee_bps=p.feeBps,
                        default_depth=p.defaultDepthSol, depth_window_ms=int(p.depthWindowSec * 1000), insert_index=False)
        t = np.array(c["probes"], np.int64) - T0_MS
        i = tape.last_ok(np.zeros(len(t), np.int64), t)
        mid, depth = tape.mid_at(i)
        for j, w in enumerate(want["probes"]):
            if w is None:
                assert i[j] == -1, f"{c['name']} probe {j}: TS has no price"
                continue
            got = {"mid": mid[j], "depth": depth[j], "ageSec": (t[j] - tape.ok_t[i[j]]) / 1000,
                   "buy": buyFill(mid[j], p.sizeSol, depth[j], p.feeBps), "sell": sellFill(mid[j], 1e6, depth[j], p.feeBps)}
            compare(w, {kk: (float(v) if not isinstance(v, dict) else {a: float(b) for a, b in v.items()}) for kk, v in got.items()},
                    f"{c['name']}.probes[{j}]", worst)
            n += 1
    assert n > 500
    assert worst[0] <= REL, f"max relative difference {worst[0]:.3e} at {worst[1]}"
