#!/usr/bin/env bash
# The hourly Mac cycle (run by launchd, work.godseye.brain.plist): pull the server's data, train, gate, and push the new
# model only when the gate passes; then the same for the private social model.
#   pull.sh -> brain.train --mode hourly (full at 03:xx) -> brain.gate --bundle <dir> --no-test -> brain.push <dir>
#           -> brain.social.train -> brain.gate --bundle <dir> --no-test --social -> brain.push <dir> --social
# The gate never scores the TEST window here (--no-test): TEST is looked at once, by hand, at the end (splits.yaml).
# Gate exit 0 pushes the model; exit 3 (explore-only, CONTRACT.md "Promotion") pushes it with brain.push --explore-only,
# which ships it with brain_enabled false (the Brain account skips every signal, Explore and Baseline still trade) and
# skips (exit 4) while the server runs a promoted model. CYCLE_EXPLORE_ONLY=0 turns that off: exit 3 then keeps the
# server's model like any other. Anything else keeps the server's model.
# The social lane has no explore-only: only exit 0 pushes it.
# Skips quietly when BRAIN_DATA_DIR isn't reachable (drive unplugged) and never overlaps another cycle (a mkdir lock).
# A step whose module isn't built yet is skipped with a log line. Log: $BRAIN_DATA_DIR/logs/cycle-YYYY-MM-DD.log.
# The new bundle is the newest manifest.json the train step wrote under models/ or private/ (up to 3 levels down).
set -uo pipefail

BRAIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_DIR="${BRAIN_ENV:-$HOME/miniconda3/envs/godseye-brain}"
export BRAIN_DATA_DIR="${BRAIN_DATA_DIR:-$HOME/GodsEyeBrainData}"
# Act on gate exit 3? On by default: before the first promotion it is how the Explore account gets a model to gather
# data with. The runtime (agent/src/brain/model.ts, policy.ts) reads brain_enabled false as "the Brain account skips".
EXPLORE_ONLY="${CYCLE_EXPLORE_ONLY:-1}"

# Drive not mounted (or the Mac just woke and it isn't back yet): nothing to do, say nothing. The check is -d on the data
# dir itself, never on its parent or the mount point, and nothing below creates it: a missing drive can't turn into a
# fresh folder on the Mac's own disk. (-d follows a ~/GodsEyeBrainData symlink, so an unplugged drive reads as missing.)
[ -d "$BRAIN_DATA_DIR" ] || exit 0
mkdir -p "$BRAIN_DATA_DIR/logs" "$BRAIN_DATA_DIR/tmp" 2>/dev/null || exit 0
export TMPDIR="$BRAIN_DATA_DIR/tmp"

exec >>"$BRAIN_DATA_DIR/logs/cycle-$(date +%Y-%m-%d).log" 2>&1
log() { printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*"; }

# One cycle at a time. A lock left by a crashed cycle (its pid is gone) is taken over.
LOCK="$BRAIN_DATA_DIR/.cycle.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  pid="$(cat "$LOCK/pid" 2>/dev/null || true)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    log "cycle $pid still running: skipped"
    exit 0
  fi
  log "stale lock (pid ${pid:-unknown}): taking it over"
  rm -rf "$LOCK"
  mkdir "$LOCK" 2>/dev/null || { log "lost the lock race: skipped"; exit 0; }
fi
echo $$ >"$LOCK/pid"
MARKER=""
trap 'rm -rf "$LOCK"; [ -n "$MARKER" ] && rm -f "$MARKER"' EXIT

if [ ! -x "$ENV_DIR/bin/python" ]; then
  log "no python in $ENV_DIR: skipped"
  exit 1
fi
export PATH="$ENV_DIR/bin:$PATH" CONDA_PREFIX="$ENV_DIR" CONDA_DEFAULT_ENV=godseye-brain
cd "$BRAIN_ROOT" || exit 1

# Is this python module there yet? (Teammates' modules land over time; a missing one is a skipped step.)
have() {
  python - "$1" <<'PY' 2>/dev/null
import importlib.util, sys
try:
    sys.exit(0 if importlib.util.find_spec(sys.argv[1]) else 1)
except ModuleNotFoundError:
    sys.exit(1)
PY
}

# Run one step, logging its exit code and how long it took. Returns the step's exit code.
step() {
  local name="$1" t0=$SECONDS rc
  shift
  log "$name: start"
  "$@"
  rc=$?
  log "$name: exit $rc ($((SECONDS - t0))s)"
  return $rc
}

# The directory of the newest manifest.json written since $MARKER was touched, or nothing.
new_bundle() {
  find "$BRAIN_DATA_DIR/models" "$BRAIN_DATA_DIR/private" -maxdepth 3 -type f -name manifest.json \
    -newer "$MARKER" -exec stat -f '%m %N' {} + 2>/dev/null | sort -rn | head -n 1 | cut -d' ' -f2- |
    { read -r m && dirname "$m"; }
}

# train -> gate -> push for one model. $1 label, $2 train module, $3 "--social" or "", the rest are train arguments.
lane() {
  local label="$1" train="$2" social="$3" bundle rc
  shift 3
  if ! have "$train"; then
    log "$label: $train isn't built yet: skipped"
    return 0
  fi
  MARKER="$(mktemp "$BRAIN_DATA_DIR/.cycle-marker.XXXXXX")" || return 1
  step "$label train" python -m "$train" "$@"
  rc=$?
  bundle="$(new_bundle)"
  rm -f "$MARKER"
  MARKER=""
  [ $rc -eq 0 ] || return 1
  if [ -z "$bundle" ]; then
    log "$label: no new bundle written: nothing to gate"
    return 0
  fi
  log "$label: new bundle $bundle"
  if ! have brain.gate; then
    log "$label: brain.gate isn't built yet: not pushed"
    return 0
  fi
  step "$label gate" python -m brain.gate --bundle "$bundle" --no-test $social
  rc=$?
  if [ $rc -eq 3 ] && [ -z "$social" ] && [ "$EXPLORE_ONLY" != 1 ]; then
    log "$label: gate exit 3: explore-only, not pushed (CYCLE_EXPLORE_ONLY=0): the server keeps its current model"
    return 0
  fi
  if [ $rc -eq 3 ] && [ -z "$social" ]; then
    # Explore-only: good enough for the Explore account to keep gathering data, not for the Brain account to trade.
    log "$label: gate exit 3: explore-only (brain_enabled false), pushed only while the server has no promoted model"
    step "$label push --explore-only" python -m brain.push "$bundle" --explore-only
    rc=$?
    if [ $rc -eq 4 ]; then
      log "$label: the server runs a promoted model: it keeps it"
      return 0
    fi
    return $rc
  fi
  if [ $rc -ne 0 ]; then
    log "$label: gate exit $rc: the server keeps its current model"
    return 0
  fi
  step "$label push" python -m brain.push "$bundle" $social
}

mode="${CYCLE_MODE:-hourly}"
[ "$(date +%H)" = "03" ] && [ -z "${CYCLE_MODE:-}" ] && mode=full
log "cycle start (pid $$, mode $mode)"
failed=0

if ! step pull "$BRAIN_ROOT/scripts/pull.sh"; then
  # Server unreachable or the pull broke: training on stale data and pushing nowhere helps nobody.
  log "cycle end: pull failed"
  exit 1
fi
lane model brain.train "" --mode "$mode" || failed=1
lane social brain.social.train --social || failed=1

log "cycle end ($([ $failed -eq 0 ] && echo ok || echo "with failures"))"
exit $failed
