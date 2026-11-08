#!/usr/bin/env bash
# Install the hourly brain cycle as a launchd agent: fills in work.godseye.brain.plist, copies it to
# ~/Library/LaunchAgents and loads it. Run once (again after moving the repo or the data dir):
#   BRAIN_DATA_DIR=/Volumes/<drive>/GodsEyeBrainData brain/scripts/install-launchd.sh
# Remove: launchctl bootout gui/$(id -u)/work.godseye.brain && rm ~/Library/LaunchAgents/work.godseye.brain.plist
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LABEL=work.godseye.brain
DEST="$HOME/Library/LaunchAgents/$LABEL.plist"

if [ -z "${BRAIN_DATA_DIR:-}" ]; then
  echo "set BRAIN_DATA_DIR to the data dir on the external drive, e.g. /Volumes/<drive>/GodsEyeBrainData" >&2
  exit 2
fi
case "$BRAIN_DATA_DIR$HERE$HOME" in
  *[\&\|\<\>]*) echo "paths with & | < > aren't supported here" >&2; exit 2 ;;
esac
mkdir -p "$BRAIN_DATA_DIR/logs" "$HOME/Library/LaunchAgents"

sed -e "s|__CYCLE__|$HERE/cycle.sh|g" -e "s|__BRAIN_DATA_DIR__|$BRAIN_DATA_DIR|g" -e "s|__HOME__|$HOME|g" \
  "$HERE/$LABEL.plist" >"$DEST.tmp"
plutil -lint "$DEST.tmp" >/dev/null
mv "$DEST.tmp" "$DEST"

# Reload: drop any earlier copy, then load this one.
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$DEST"
echo "installed $DEST: runs $HERE/cycle.sh every hour, logs in $BRAIN_DATA_DIR/logs/"
echo "run one cycle now: launchctl kickstart gui/$(id -u)/$LABEL"
# macOS privacy: a launchd job may not write to an external drive until /bin/bash has Full Disk Access (System Settings >
# Privacy & Security > Full Disk Access > + > /bin/bash). Without it the cycle log says "Operation not permitted".
echo "needs once: System Settings > Privacy & Security > Full Disk Access: add /bin/bash (external drive access)"
