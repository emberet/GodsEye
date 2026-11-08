"""
Tiny model bundles for agent/test/brain-model.test.ts (CONTRACT.md "Model bundle").

    ~/miniconda3/envs/godseye-brain/bin/python agent/test/fixtures/brain/make-fixtures.py

Writes, next to this script:
  v1/          a valid bundle: 5 entry members (4 features -> 5 stakes) and an exit net (3 features -> 3 actions)
  v2/          another valid bundle with different weights, for the hot-reload test
  bad-hash/    v2's files with a manifest whose sha256 for entry-0.onnx is wrong
  expected.json   one input per bundle and the q values PyTorch computes for it (the runtime must match to 1e-5)

Seeded, so a rerun gives the same numbers (the .onnx bytes may differ across torch versions; the hashes follow them).
"""
import hashlib
import json
import os
import shutil

import torch

HERE = os.path.dirname(os.path.abspath(__file__))
ENTRY_FEATURES = ["leader_n_prior", "leader_win_rate", "coin_age_min", "liq_sol"]
EXIT_FEATURES = ["ret_now", "held_min", "leader_sold"]
STAKES = [0, 0.25, 0.5, 0.75, 1.0]
EXIT_ACTIONS = ["hold", "sell_half", "sell_all"]
MEMBERS = 5


def mlp(n_in: int, n_out: int) -> torch.nn.Module:
    return torch.nn.Sequential(torch.nn.Linear(n_in, 8), torch.nn.ReLU(), torch.nn.Linear(8, n_out)).eval()


def export(model: torch.nn.Module, n_in: int, path: str) -> None:
    torch.onnx.export(
        model,
        (torch.zeros(1, n_in),),
        path,
        input_names=["x"],
        output_names=["q"],
        dynamic_axes={"x": {0: "n"}, "q": {0: "n"}},
        opset_version=17,
        dynamo=False,
        external_data=False,
    )


def sha256(path: str) -> str:
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def bundle(name: str, seed: int, version: str) -> dict:
    out = os.path.join(HERE, name)
    shutil.rmtree(out, ignore_errors=True)
    os.makedirs(out)
    torch.manual_seed(seed)
    members = [mlp(len(ENTRY_FEATURES), len(STAKES)) for _ in range(MEMBERS)]
    exit_net = mlp(len(EXIT_FEATURES), len(EXIT_ACTIONS))
    files = []
    for i, m in enumerate(members):
        export(m, len(ENTRY_FEATURES), os.path.join(out, f"entry-{i}.onnx"))
        files.append(f"entry-{i}.onnx")
    export(exit_net, len(EXIT_FEATURES), os.path.join(out, "exit.onnx"))
    files.append("exit.onnx")

    manifest = {
        "version": version,
        "created_at": "2026-11-06T12:00:00Z",
        "feature_spec_version": 1,
        "entry": {
            "features": ENTRY_FEATURES,
            "norm": {"mean": [3.0, 0.5, 30.0, 40.0], "std": [2.0, 0.25, 15.0, 20.0]},
            "members": files[:MEMBERS],
            "input": "x",
            "output": "q",
            "actions": STAKES,
        },
        "exit": {
            "features": EXIT_FEATURES,
            "norm": {"mean": [0.0, 60.0, 0.0], "std": [0.5, 60.0, 1.0]},
            "file": "exit.onnx",
            "input": "x",
            "output": "q",
            "actions": EXIT_ACTIONS,
        },
        "explore": {"rate": 0.1, "curiosity": 0.5},
        "metrics": {"validation": {}, "stress": {}, "baseline": {}},
        "sha256": {f: sha256(os.path.join(out, f)) for f in files},
    }
    with open(os.path.join(out, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=2)

    # One normalised input per net, and what PyTorch says for it.
    ex = torch.tensor([[0.5, -1.0, 1.5, 0.25]])
    xx = torch.tensor([[-0.4, 1.0, 0.0]])
    with torch.no_grad():
        return {
            "version": version,
            "entry_x": ex[0].tolist(),
            "entry_q": [m(ex)[0].tolist() for m in members],
            "exit_x": xx[0].tolist(),
            "exit_q": exit_net(xx)[0].tolist(),
        }


def main() -> None:
    expected = {"v1": bundle("v1", 1, "2026-11-06T12-00-00Z"), "v2": bundle("v2", 2, "2026-11-06T13-00-00Z")}
    bad = os.path.join(HERE, "bad-hash")
    shutil.rmtree(bad, ignore_errors=True)
    shutil.copytree(os.path.join(HERE, "v2"), bad)
    with open(os.path.join(bad, "manifest.json")) as f:
        m = json.load(f)
    m["version"] = "2026-11-06T14-00-00Z"
    m["sha256"]["entry-0.onnx"] = "0" * 64
    with open(os.path.join(bad, "manifest.json"), "w") as f:
        json.dump(m, f, indent=2)
    with open(os.path.join(HERE, "expected.json"), "w") as f:
        json.dump(expected, f, indent=2)


if __name__ == "__main__":
    main()
