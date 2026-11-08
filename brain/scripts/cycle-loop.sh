#!/usr/bin/env bash
# The hourly cycle without launchd: runs cycle.sh, then waits for the next hour, forever. For a Mac where launchd jobs
# can't reach the external drive (macOS privacy: the Full Disk Access grant to /bin/bash didn't reach launchd jobs here).
# Start it from a process that can already read the drive (Terminal, or the Claude app):
#   nohup brain/scripts/cycle-loop.sh >/dev/null 2>&1 &
# It stops when that app quits or the Mac restarts; start it again then. Stop it: pkill -f cycle-loop.sh
# cycle.sh's own lock means a launchd run and this loop never overlap.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export BRAIN_DATA_DIR="${BRAIN_DATA_DIR:-/Volumes/HP -E1/GodsEyeBrainData}"
while true; do
  /bin/bash "$HERE/cycle.sh"
  # Next run at the top of the next hour (a Mac asleep past it runs once on waking).
  sleep $(( 3600 - $(date +%s) % 3600 ))
done
