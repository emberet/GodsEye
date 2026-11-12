#!/usr/bin/env bash
# Rebuild everything the brain learns from, from the pulled export, so training takes in the newest days: the derived
# datasets, the entry features, the simulator's fitted inputs and the baselines. With splits.yaml in rolling mode the
# periods move with the new build's label end, so each rebuild trains on everything older and keeps a fresh test slice.
#   brain.data.derive -> brain.features.build -> brain.sim.ledger -> brain.sim.quotes -> brain.baselines
# About 6 hours on the external drive. Run by cycle.sh before the nightly full retrain (when derived/ is older than
# REBUILD_HOURS), or by hand. Stops at the first step that fails: each step swaps its outputs in only when it finishes,
# and the caller then skips the full retrain. Logs to stdout (cycle.sh sends it to the day's cycle log).
set -uo pipefail

BRAIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_DIR="${BRAIN_ENV:-$HOME/miniconda3/envs/godseye-brain}"
export BRAIN_DATA_DIR="${BRAIN_DATA_DIR:-$HOME/GodsEyeBrainData}"
[ -d "$BRAIN_DATA_DIR" ] || { echo "rebuild: $BRAIN_DATA_DIR isn't there (drive unplugged?)" >&2; exit 1; }
export TMPDIR="${TMPDIR:-$BRAIN_DATA_DIR/tmp}"
export PATH="$ENV_DIR/bin:$PATH"
cd "$BRAIN_ROOT" || exit 1
BUCKETS="${REBUILD_BUCKETS:-64}"

log() { printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*"; }
run() {
  local name="$1" t0=$SECONDS rc
  shift
  log "rebuild $name: start"
  python -m "$@"
  rc=$?
  log "rebuild $name: exit $rc ($((SECONDS - t0))s)"
  return $rc
}

run derive brain.data.derive --buckets "$BUCKETS" || exit 1
run features brain.features.build || exit 1
run "sim ledger" brain.sim.ledger || exit 1
run "sim quotes" brain.sim.quotes || exit 1
run baselines brain.baselines || exit 1
python - <<'PY'
from brain.data import splits
d = splits.describe()
print("rebuild: periods now", d["anchor"], {k: v[0][:10] for k, v in d["periods"].items()})
PY
log "rebuild: done"
