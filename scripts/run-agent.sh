#!/bin/sh
# Keeps the GodsEye agent running: if it ever exits (a crash, running out of memory), it is restarted
# after 10 seconds. Ctrl-C stops it for good.
cd "$(dirname "$0")/.." || exit 1
trap 'echo "[GodsEye] stopped."; exit 0' INT TERM
while true; do
  npm run agent -w agent
  code=$?
  echo "[GodsEye] agent exited with code $code at $(date -u +%Y-%m-%dT%H:%M:%SZ); restarting in 10 s (Ctrl-C to stop)."
  sleep 10
done
