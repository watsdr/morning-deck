#!/usr/bin/env bash
# Nightly runner for scripts/backup-drive.js (this box has no crontab). Single instance via flock on run/nightly-backup.lock,
# pid in run/nightly-backup.pid. Runs once a day at NB_AT (local box time, default 22:45). Log: logs/nightly-backup.log.
#   scripts/nightly-backup.sh        -> loop forever      scripts/nightly-backup.sh --once -> run now and exit
# Stages only; the Drive upload of run/backup-staging/LATEST is done by the agent with the Drive connector.
cd "$(dirname "$0")/.." || exit 1
mkdir -p run logs; LOG=logs/nightly-backup.log; AT=${NB_AT:-22:45}
run() { echo "$(date -Is) run" >> "$LOG"; node scripts/backup-drive.js >> "$LOG" 2>&1; echo "$(date -Is) exit $?" >> "$LOG"; }
[ "$1" = --once ] && { run; exit; }
exec 9>run/nightly-backup.lock; flock -n 9 || { echo "already running"; exit 0; }
echo $$ > run/nightly-backup.pid; echo "$(date -Is) loop start, daily at $AT" >> "$LOG"
while true; do
  next=$(date -d "today $AT" +%s); [ "$next" -le "$(date +%s)" ] && next=$(date -d "tomorrow $AT" +%s)
  sleep $(( next - $(date +%s) )) 9>&- & wait $!; run 9>&-
done
