"""
brain.policy: the brain the owner asked for, trained on paper money only (CONTRACT.md, reward.yaml, stress.yaml).

  nets       QNet, the MLP every head uses (input mask, SOL output scale, skip = 0 column); ONNX-exportable
  entry      the contextual bandit: stake targets from the simulator, input chaos, rolling-origin early stopping, the
             bootstrapped ensemble, the mean - c * std decision and Thompson exploration (policy.ts, mirrored)
  exit       IQL over hold / sell_half / sell_all on BatchEnv trajectories of a behaviour mix; rule distillation
  data       real data: subsampled day windows of the simulator joined with derived/features_entry
  score      one simulation of every candidate copy, then metrics for any stake vector (margin / kappa grids)
  reference  B4 from research/baselines-v2.json, re-scored on the same window for paired comparisons
  brain      the trained brain (PyTorch weights, for hourly warm starts)
  bundle     a written bundle (ONNX through onnxruntime) as the simulator's policy: what the gate scores
  learner    the trainer as a brain.assure learner (the learning checks on synthetic worlds)

Nothing here reaches the real copy engine, signs a transaction or writes to the server.
"""


def assure_learner():
    """brain.assure.protocol: the trainer's learner (also exposed by brain.train)."""
    from brain.policy.learner import BrainLearner
    return BrainLearner()
