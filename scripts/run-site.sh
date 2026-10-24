#!/bin/sh
# The public website (godseye.work): builds a production copy of the dashboard into dashboard/.next-site
# (separate from the dev server's .next), then serves it on port 3100 and restarts it if it ever exits.
# Cloudflare Tunnel points godseye.work at http://127.0.0.1:3100. Ctrl-C stops it.
cd "$(dirname "$0")/.." || exit 1
export NEXT_DIST_DIR=.next-site
export NEXT_PUBLIC_SITE_URL="${NEXT_PUBLIC_SITE_URL:-https://godseye.work}"
PORT="${SITE_PORT:-3100}"
trap 'echo "[GodsEye site] stopped."; exit 0' INT TERM
echo "[GodsEye site] building…"
npm run build -w dashboard || exit 1
while true; do
  (cd dashboard && npx next start -p "$PORT" -H 127.0.0.1)
  echo "[GodsEye site] exited with code $? at $(date -u +%Y-%m-%dT%H:%M:%SZ); restarting in 5 s (Ctrl-C to stop)."
  sleep 5
done
