"""
The trained brain on the Mac side (PyTorch): the entry ensemble, the exit network, their norms and decision settings.

    b = Brain(members, exit_net, entry_meta, exit_norm, actions, margin_c, explore, meta)
    ens = b.ensemble()                          # policy.entry.Ensemble (decide / explore)
    pol = b.exit_policy(ExitFeaturizer(...))    # an engine exit policy
    b.save(state_dir); Brain.load(state_dir)    # the weights for hourly warm starts (never shipped: the bundle has ONNX)
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

import torch

from brain.features import spec
from brain.policy.entry import Ensemble
from brain.policy.exit import ExitFeaturizer, ExitPolicy
from brain.policy.nets import QNet

STATE_FILE = "brain.pt"


@dataclass
class Brain:
    members: list
    exit_net: QNet
    entry_meta: dict             # the feature build's columns, categories and norm (the entry net's inputs)
    exit_norm: spec.Norm
    actions: tuple
    margin_c: float
    explore: dict
    meta: dict = field(default_factory=dict)

    def ensemble(self, margin_c: float | None = None) -> Ensemble:
        return Ensemble(self.members, self.actions, self.margin_c if margin_c is None else margin_c)

    def exit_policy(self, fz: ExitFeaturizer) -> ExitPolicy:
        return ExitPolicy(self.exit_net, self.exit_norm, fz)

    def save(self, d: Path) -> Path:
        d = Path(d)
        d.mkdir(parents=True, exist_ok=True)
        torch.save({"members": [(m.config(), m.state_dict()) for m in self.members],
                    "exit": (self.exit_net.config(), self.exit_net.state_dict())}, d / STATE_FILE)
        (d / "brain.json").write_text(json.dumps({"entry_meta": {k: self.entry_meta[k] for k in ("columns", "categories", "norm")},
                                                  "exit_norm": self.exit_norm.to_json(), "actions": list(self.actions),
                                                  "margin_c": self.margin_c, "explore": self.explore, "meta": self.meta}, indent=1, default=str))
        return d

    @classmethod
    def load(cls, d: Path) -> "Brain":
        d = Path(d)
        st = torch.load(d / STATE_FILE, weights_only=False)
        j = json.loads((d / "brain.json").read_text())
        members = [QNet.from_config(c, s).eval() for c, s in st["members"]]
        ex = QNet.from_config(*st["exit"]).eval()
        return cls(members, ex, j["entry_meta"], spec.Norm.from_json(j["exit_norm"]), tuple(j["actions"]), float(j["margin_c"]),
                   j["explore"], j.get("meta", {}))
