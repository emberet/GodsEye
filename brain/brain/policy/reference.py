"""
B4, the hand-rule bar, as research/baselines-v2.json defines it (veto threshold, exit), re-scored here on whatever
window the brain is scored on, so the comparison is paired: same signals, same seed, same chaos.

    entry, exit_rule, info = b4()          # info: the json's rule and its stored selection / test metrics
"""
from __future__ import annotations

import json

from brain.baselines import EXIT_CANDIDATES, b4_entry
from brain.data.loaders import data_dir
from brain.sim.ledger import load_ledger
from brain.sim.params import SimParams

BASELINES = "research/baselines-v2.json"


def baselines(path=None) -> dict:
    return json.loads((path or data_dir() / BASELINES).read_text())


def exit_rule(name: str):
    for e in EXIT_CANDIDATES:
        if e.name == name:
            return e
    raise KeyError(f"B4 exit {name!r} is not in brain.baselines.EXIT_CANDIDATES")


def b4(p: SimParams | None = None, path=None, led=None):
    p = p or SimParams.load()
    js = baselines(path)
    rule = js["b4_rule"]
    q20 = float(rule["veto"]["q20_cp_lrshr_7d"])
    led = load_ledger() if led is None else led
    return b4_entry(led, q20, p), exit_rule(rule["exit"]), {"veto_q20": q20, "exit": rule["exit"], "json": js}
