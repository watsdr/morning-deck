#!/usr/bin/env bash
# Reboot survival for Morning Deck. This box has no systemd/cron/supervisor (PID 1 is tini), so ~/.profile and ~/.bashrc
# call this on the first shell after a reboot (same pattern as hub-world's autosave daemon). Idempotent and instant:
#  - funnel-watchdog.sh loop (flock run/watchdog.loop.lock): it alone (re)starts tailscaled/funnel and the node server,
#    and only when no server of this checkout is running and :PORT is unbound, so the server is never started twice.
#  - nightly-backup.sh loop (flock run/nightly-backup.lock).
# This script never starts node itself.
cd "$(dirname "$0")/.." || exit 0
mkdir -p run logs
held() { ( exec 8>"$1"; ! flock -n 8 ); }   # lock busy = a live instance holds it
if ! held run/watchdog.loop.lock; then setsid nohup scripts/funnel-watchdog.sh >> logs/watchdog-start.log 2>&1 </dev/null & echo "$(date -Is) boot-start: watchdog launched" >> logs/boot-start.log; fi
if ! held run/nightly-backup.lock; then setsid nohup scripts/nightly-backup.sh >/dev/null 2>&1 </dev/null & echo "$(date -Is) boot-start: nightly-backup launched" >> logs/boot-start.log; fi
exit 0
