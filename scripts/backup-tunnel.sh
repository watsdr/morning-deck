#!/usr/bin/env bash
# Backup phone route for when Tailscale Funnel drops: a Cloudflare quick tunnel (free, no account, no DNS).
# The watchdog keeps it up while enabled. Its https://<random>.trycloudflare.com URL changes if it restarts
# (logged as "BACKUP URL CHANGED" in logs/watchdog.log). A phone signs in once per origin (token link or Request access).
#   scripts/backup-tunnel.sh on|off|status
set -euo pipefail
cd "$(dirname "$0")/.."; mkdir -p run
case "${1:-status}" in
  on) touch run/backup-tunnel.enabled; scripts/funnel-watchdog.sh --once; echo "backup on: $(cat run/tunnel.url 2>/dev/null)";;
  off) rm -f run/backup-tunnel.enabled; [ -f run/tunnel.pid ] && kill "$(cat run/tunnel.pid)" 2>/dev/null || true; rm -f run/tunnel.pid; echo "backup off";;
  status) u=$(cat run/tunnel.url 2>/dev/null || true); [ -f run/backup-tunnel.enabled ] && e=on || e=off
    echo "backup $e: ${u:-none}"; [ -n "$u" ] && for p in / /manifest.webmanifest; do echo "  $p -> $(curl -s -o /dev/null -m 10 -w '%{http_code}' "$u$p")"; done; true;;
  *) echo "usage: $0 on|off|status" >&2; exit 2;;
esac
