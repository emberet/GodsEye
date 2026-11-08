#!/usr/bin/env bash
# Pull the server's data to the Mac (python -m brain.export.pull) in the godseye-brain conda env.
# Refuses when BRAIN_DATA_DIR is missing (it may be a symlink to the external drive): the drive isn't plugged in, and
# writing to a fresh folder in its place would split the data in two. Temp files go on the drive too. Extra arguments go to the puller (e.g. --only wallet_swaps).
set -euo pipefail

BRAIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_DIR="${BRAIN_ENV:-$HOME/miniconda3/envs/godseye-brain}"
export BRAIN_DATA_DIR="${BRAIN_DATA_DIR:-$HOME/GodsEyeBrainData}"

if [ ! -d "$BRAIN_DATA_DIR" ]; then
  echo "pull: $BRAIN_DATA_DIR is missing (drive unplugged?): not pulling" >&2
  exit 2
fi
mkdir -p "$BRAIN_DATA_DIR/tmp"
export TMPDIR="$BRAIN_DATA_DIR/tmp"
if [ ! -x "$ENV_DIR/bin/python" ]; then
  echo "pull: no python in $ENV_DIR (create the godseye-brain env first)" >&2
  exit 2
fi

# Activate the env: its bin first on PATH (enough for python and the ssh/sqlite tools it shells out to).
export PATH="$ENV_DIR/bin:$PATH" CONDA_PREFIX="$ENV_DIR" CONDA_DEFAULT_ENV=godseye-brain
cd "$BRAIN_ROOT"
exec python -m brain.export.pull "$@"
