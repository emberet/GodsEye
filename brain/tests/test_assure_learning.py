"""
brain.assure.learning: the reference learner passes every learning check on the synthetic worlds, and the mutants the
checks exist for fail them (a copy-all learner, a learner that reads a leaked column, a fine-tune that trusts stale paper
marks). The trainer joins these checks through brain.assure.protocol.learners() once it exists.
"""
from __future__ import annotations

import json
from dataclasses import dataclass

import pytest

from brain.assure.learning import CopyAllLearner, Suite
from brain.assure.reference import ReferenceLearner
from brain.assure.suite import check_bundle

pytestmark = pytest.mark.learning
CHECKS = ("L1", "L2", "L3", "L4", "L5", "L6", "L7", "L8", "L9", "L10", "L11", "L12")


@pytest.fixture(scope="module")
def suite():
    return Suite()


@pytest.fixture(scope="module")
def reference(suite):
    return {c.name.split()[0]: c for c in suite.run(ReferenceLearner())}


@pytest.mark.parametrize("name", CHECKS)
def test_reference_learner_passes(reference, name):
    c = reference[name]
    assert c.passed and not c.skipped, json.dumps(c.value, default=str)[:2000]


def test_onnx_check_is_skipped_until_the_export_exists(reference):
    assert reference["L13"].skipped and not reference["L13"].passed


def test_a_copy_all_learner_fails_what_it_should(suite):
    got = {c.name.split()[0]: c for c in suite.run(CopyAllLearner(), only=("L1", "L2", "L3", "L4", "L9"))}
    assert not any(c.passed for c in got.values()), {k: c.passed for k, c in got.items()}


def test_a_learner_reading_a_leaked_column_fails_the_canary(suite):
    c = suite.run(ReferenceLearner(name="reference+canary", use_canary=True), only=("L5",))[0]
    assert not c.passed and c.value["offline_value"] > 3 * max(c.value["live_value"], 1e-6)


@dataclass
class TrustingLearner(ReferenceLearner):
    """Fine-tunes on paper rewards as reported (stale marks included)."""
    name: str = "reference-ungrounded"

    def fine_tune(self, policy, data, transitions, seed=0, ground=True, tape=None):
        return super().fine_tune(policy, data, transitions, seed, ground=False, tape=tape)


def test_trusting_stale_paper_marks_fails_the_fine_tune_check(suite):
    c = suite.run(TrustingLearner(), only=("L12",))[0]
    assert not c.passed, c.value


def test_check_bundle_refuses_fractional_stakes_undeclared_features_and_an_unverified_trainer(tmp_path):
    man = {"entry": {"actions": [0, 0.25, 0.5, 0.75, 1.0], "features": ["cp_n_7d", "venue_group=pumpswap", "future_return"]},
           "exit": {"features": ["ret_now", "mom5_missing"]}}
    (tmp_path / "manifest.json").write_text(json.dumps(man))
    res = check_bundle(tmp_path)
    by = {c["name"]: c for c in res["checks"]}
    assert not by["bundle stakes"]["passed"]
    assert by["bundle features"]["value"]["undeclared_entry"] == ["future_return"]
    assert not res["learning_verified"]                       # the trainer hasn't been through the learning checks
    man["entry"].update(actions=[0, 1], features=["cp_n_7d", "venue_group=pumpswap"])
    (tmp_path / "manifest.json").write_text(json.dumps(man))
    by = {c["name"]: c for c in check_bundle(tmp_path)["checks"]}
    assert by["bundle stakes"]["passed"] and by["bundle features"]["passed"]
