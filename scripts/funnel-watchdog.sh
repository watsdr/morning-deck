#!/usr/bin/env bash
# Keeps the permanent Funnel link (and the local server) alive. Checks WITHOUT the token: 200 or 401 = healthy.
#   scripts/funnel-watchdog.sh          -> loop forever (single instance, flock on run/watchdog.lock, pid in run/watchdog.pid)
#   scripts/funnel-watchdog.sh --once   -> one check (records into the same rolling window, may restart), then exit
# Restart rule: >= WD_FAILS_IN_WINDOW failures among the last WD_WINDOW checks, or WD_FAILS_IN_ROW in a row.
# Cooldown: no second restart within WD_COOLDOWN seconds. Every failed check and every restart is logged to logs/watchdog.log.
cd "$(dirname "$0")/.." || exit 1
ROOT=$(pwd)
PORT=$(sed -n 's/^MD_PORT=//p' .env 2>/dev/null | head -1); PORT=${PORT:-8787}
URL=${WD_URL:-https://morning-deck.tail164b96.ts.net/manifest.webmanifest}
HUB_PATH=/hub-world; HUB_PORT=8796
WINDOW=${WD_WINDOW:-8}; IN_WINDOW=${WD_FAILS_IN_WINDOW:-4}; IN_ROW=${WD_FAILS_IN_ROW:-3}
COOLDOWN=${WD_COOLDOWN:-600}; INTERVAL=${WD_INTERVAL:-20}
STATE=run/watchdog.window LAST=run/watchdog.last-restart LOG=logs/watchdog.log
TS=( "$ROOT/bin/tailscale" "--socket=$ROOT/run/tailscale/tailscaled.sock" )
LOCAL_TIMEOUT=${WD_LOCAL_TIMEOUT:-15}; LOCAL_MISSES=${WD_LOCAL_MISSES:-3}; LOCAL_MISS=run/watchdog.local-miss
LOAD_FACTOR=${WD_LOAD_FACTOR:-4}
mkdir -p run logs
port_bound() { ss -Hltn "sport = :$PORT" 2>/dev/null | grep -q .; }
server_running() { pgrep -f 'node server.js' >/dev/null || port_bound; }
start_server() { # never start a second copy; stdout goes to the live logs/server.log (opened fresh by this shell)
  if server_running; then log "start_server: already running or :$PORT bound, skipping"; return; fi
  ( set -a; [ -f .env ] && . ./.env; set +a; exec setsid nohup node server.js >> "$ROOT/logs/server.log" 2>&1 </dev/null ) &
  echo $! > run/server.pid; log "server started (pid $(cat run/server.pid)), log logs/server.log"
}
load_too_high() { awk -v n="$(nproc)" -v f="$LOAD_FACTOR" '{exit !($1 > n*f)}' /proc/loadavg; }
log() { echo "$(date -Is) $*" >> "$LOG"; }
healthy() { case "$1" in 200|401) return 0;; *) return 1;; esac; }

restart_funnel() {
  exec 8>run/watchdog-restart.lock; flock -n 8 || { log "restart already in progress elsewhere, skipping"; return; }
  local now last; now=$(date +%s); last=$(cat "$LAST" 2>/dev/null || echo 0)
  if [ $((now - last)) -lt "$COOLDOWN" ]; then log "restart wanted but in cooldown ($((now - last))s < ${COOLDOWN}s), waiting"; flock -u 8; return; fi
  if load_too_high; then log "restart wanted but load $(cut -d' ' -f1 /proc/loadavg) > ${LOAD_FACTOR}x$(nproc) cpus, skipping tailscaled restart"; flock -u 8; return; fi
  echo "$now" > "$LAST"
  log "RESTART tailscaled (window: $(cat "$STATE"))"
  pkill -f "$ROOT/bin/tailscaled" ; pkill -f '^bin/tailscaled'; sleep 3
  pkill -9 -f "$ROOT/bin/tailscaled"; pkill -9 -f '^bin/tailscaled'
  setsid nohup "$ROOT/bin/tailscaled" --tun=userspace-networking --statedir="$ROOT/run/tailscale" \
    --state="$ROOT/run/tailscale/tailscaled.state" --socket="$ROOT/run/tailscale/tailscaled.sock" >> logs/tailscaled.log 2>&1 </dev/null &
  echo $! > run/tailscaled.pid
  for _ in $(seq 1 60); do "${TS[@]}" status --json 2>/dev/null | grep -q '"BackendState": *"Running"' && break; sleep 1; done
  sleep 5
  if timeout 60 "${TS[@]}" funnel --bg "$PORT" >> "$LOG" 2>&1; then log "funnel --bg $PORT ok"; else log "funnel --bg $PORT FAILED"; fi
  if ! timeout 20 "${TS[@]}" funnel status 2>/dev/null | grep -qE "^\|-- $HUB_PATH +proxy http://127.0.0.1:$HUB_PORT"; then
    log "$HUB_PATH mapping missing, re-adding -> $HUB_PORT"
    timeout 60 "${TS[@]}" funnel --bg --set-path="$HUB_PATH" "$HUB_PORT" >> "$LOG" 2>&1 || log "re-adding $HUB_PATH FAILED"
  fi
  : > "$STATE"
  log "restart done (pid $(cat run/tailscaled.pid))"
  flock -u 8
}

check_once() {
  local code win fails row
  code=$(curl -s -o /dev/null -m 10 -w '%{http_code}' "$URL"); code=${code:-000}
  if healthy "$code"; then echo 0 >> "$STATE"; else echo 1 >> "$STATE"; log "check failed: $URL -> $code"; fi
  tail -n "$WINDOW" "$STATE" > "$STATE.tmp" && mv "$STATE.tmp" "$STATE"
  fails=$(grep -c 1 "$STATE"); row=$(tac "$STATE" | awk '$1==1{n++;next}{exit}END{print n+0}')
  if [ "$fails" -ge "$IN_WINDOW" ] || [ "$row" -ge "$IN_ROW" ]; then restart_funnel; fi
  # keep the node server alive too (401 = up, token required). Under heavy box load the server can be slow,
  # so: long timeout, 3 consecutive misses, and only (re)launch if no node server.js / no :PORT listener exists.
  code=$(curl -s -o /dev/null -m "$LOCAL_TIMEOUT" -w '%{http_code}' "http://127.0.0.1:$PORT/manifest.webmanifest"); code=${code:-000}
  if healthy "$code"; then echo 0 > "$LOCAL_MISS"; return; fi
  local miss; miss=$(( $(cat "$LOCAL_MISS" 2>/dev/null || echo 0) + 1 )); echo "$miss" > "$LOCAL_MISS"
  log "server check failed ($code), local miss $miss/$LOCAL_MISSES"
  [ "$miss" -ge "$LOCAL_MISSES" ] || return
  if server_running; then log "server slow but process/listener present (pids: $(pgrep -f 'node server.js' | tr '\n' ' ')), NOT restarting"; return; fi
  log "server process gone and :$PORT unbound after $miss misses, starting server"
  start_server
  echo 0 > "$LOCAL_MISS"
}

if [ "${1:-}" = "--once" ]; then
  exec 7>run/watchdog-once.lock; flock -w 30 7 || exit 0
  check_once; exit 0
fi

kill_stale_once() { # --once runs older than 120 s are hung; kill them
  ps -eo pid=,etimes=,args= | awk '/funnel-watchdog\.sh --once/ && !/awk/ && $2>120 {print $1}' | while read -r p; do kill "$p" 2>/dev/null && log "killed stale --once pid $p"; done
}
exec 9>run/watchdog.lock
flock -n 9 || { echo "watchdog already running (pid $(cat run/watchdog.pid 2>/dev/null))"; exit 0; }
echo $$ > run/watchdog.pid
kill_stale_once
log "watchdog started (pid $$; window $IN_WINDOW/$WINDOW, $IN_ROW in a row, cooldown ${COOLDOWN}s)"
trap 'log "watchdog stopped (pid $$)"; rm -f run/watchdog.pid; exit 0' TERM INT
while true; do kill_stale_once; check_once; sleep "$INTERVAL" & wait $!; done
