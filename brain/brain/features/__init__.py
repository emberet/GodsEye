"""
The brain's inputs (brain/spec/features.yaml): the entry vector of a leader buy and the exit vector of an open position.

    spec.py    the spec as code: feature lists, transforms, column layout, the encoder and normalisation
    entry.py   reference entry features + gates of one buy from the server's state (what features.ts mirrors)
    exit.py    exit features from a position's state (the simulator calls it; paper.ts mirrors it)
    build.py   the offline build: every episode's entry features, point in time -> derived/features_entry/
    golden.py  spec/golden/*.json, the cases both sides reproduce to 1e-6

Load a built set:  brain.features.build.load_entry(...)
"""
from brain.features.entry import entry_raw, entry_vector, gate
from brain.features.exit import exit_matrix, exit_raw, flow

__all__ = ["entry_raw", "entry_vector", "gate", "exit_raw", "exit_matrix", "flow"]
