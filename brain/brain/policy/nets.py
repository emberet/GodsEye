"""
The brain's networks (PyTorch): small MLPs that export to ONNX with the shapes CONTRACT.md fixes.

    net = QNet(n_in, n_out, mask=mask, scale=0.1, skip_zero=True)   # entry member: x [n, F] -> q [n, len(actions)]
    net = QNet(n_in, 3, scale=0.1)                                  # exit: x [n, 23] -> q over hold / sell_half / sell_all
    v = QNet(n_in, 1)                                               # IQL's state value (never exported)

The body learns in "stake units" (rewards / COPY_MAX_TRADE_SOL, so a 0.1 SOL copy losing everything is -1); `scale`
turns its output back into SOL, so the exported q is the expected reward in SOL that the runtime compares with 0.
`mask` zeroes input columns the network must not read yet (social_score / social_missing until X data exists: they are
constant in every training row, so a live value would be an input the net never saw). `skip_zero` puts the skip
action's q (0 by reward.yaml: skip_reward 0) in front of the learned stakes.
"""
from __future__ import annotations

import os

import numpy as np
import torch
from torch import nn

HIDDEN = (128, 128)
THREADS = int(os.environ.get("BRAIN_TORCH_THREADS", "2"))  # a 16 GB Mac shared by the team: two threads per job


def setup_threads() -> None:
    torch.set_num_threads(THREADS)


def device(prefer_gpu: bool = True) -> torch.device:
    """Apple's GPU (MPS) for training when present, else CPU. Inference inside the simulator always runs on CPU."""
    if prefer_gpu and torch.backends.mps.is_available():
        return torch.device("mps")
    return torch.device("cpu")


class QNet(nn.Module):
    def __init__(self, n_in: int, n_out: int, hidden=HIDDEN, mask=None, scale: float = 1.0, skip_zero: bool = False):
        super().__init__()
        layers: list[nn.Module] = []
        k = n_in
        for h in hidden:
            layers += [nn.Linear(k, h), nn.ReLU()]
            k = h
        layers.append(nn.Linear(k, n_out))
        self.body = nn.Sequential(*layers)
        m = torch.ones(n_in) if mask is None else torch.as_tensor(np.asarray(mask, dtype=np.float32))
        self.register_buffer("mask", m.reshape(1, n_in).float())
        self.register_buffer("scale", torch.tensor(float(scale)))
        self.skip_zero = skip_zero
        self.n_in, self.n_out, self.hidden = n_in, n_out, tuple(hidden)

    def raw(self, x: torch.Tensor) -> torch.Tensor:
        """The body's output in stake units (what training regresses)."""
        return self.body(x * self.mask)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        q = self.raw(x) * self.scale
        if self.skip_zero:
            q = torch.cat([torch.zeros_like(q[:, :1]), q], dim=1)
        return q

    def config(self) -> dict:
        return {"n_in": self.n_in, "n_out": self.n_out, "hidden": list(self.hidden), "scale": float(self.scale),
                "skip_zero": self.skip_zero, "mask": self.mask.flatten().tolist()}

    @classmethod
    def from_config(cls, c: dict, state: dict | None = None) -> "QNet":
        net = cls(c["n_in"], c["n_out"], c["hidden"], c["mask"], c["scale"], c["skip_zero"])
        if state is not None:
            net.load_state_dict(state)
        return net


@torch.no_grad()
def predict(net: nn.Module, X: np.ndarray, batch: int = 65_536) -> np.ndarray:
    """net(X) on CPU in float32 batches (inference inside the simulator loop: small batches, no GPU round trips)."""
    net = net.to("cpu").eval()
    X = np.asarray(X, dtype=np.float32)
    if not len(X):
        return np.zeros((0, net(torch.zeros(1, X.shape[1])).shape[1]), dtype=np.float32)
    out = [net(torch.from_numpy(X[i:i + batch])).numpy() for i in range(0, len(X), batch)]
    return np.concatenate(out)
