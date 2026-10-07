#!/usr/bin/env bash
# Stop the server and tunnel started by scripts/start.sh
#   scripts/stop.sh              -> server + Cloudflare tunnel (Tailscale Funnel is left up; it just 502s while the server is down)
#   scripts/stop.sh --tailscale  -> also stop tailscaled (Funnel config is kept in run/tailscale and returns on next start)
cd "$(dirname "$0")/.."
NAMES="tunnel server"; [ "${1:-}" = "--tailscale" ] && NAMES="$NAMES tailscaled"
for n in $NAMES; do
  if [ -f run/$n.pid ] && kill -0 "$(cat run/$n.pid)" 2>/dev/null; then kill "$(cat run/$n.pid)" && echo "stopped $n (pid $(cat run/$n.pid))"; else echo "$n not running"; fi
  rm -f run/$n.pid
done
