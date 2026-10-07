#!/usr/bin/env bash
# Public DEMO instance: same code, separate process, port, data dir, env file and quick tunnel.
#   scripts/demo.sh start   -> demo server (MD_DEMO=1) on $DEMO_PORT + its own Cloudflare quick tunnel
#   scripts/demo.sh stop    -> stop both (the real server/tunnels are never touched)
#   scripts/demo.sh url     -> print the public demo URL
#   scripts/demo.sh status
# Demo mode: no token, SAMPLE deck re-seeded at start + hourly, answers never stored, uploads + card intake disabled.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)
DEMO_PORT=${DEMO_PORT:-8792}
DEMO_DIR=${DEMO_DIR:-$(dirname "$ROOT")/morning-deck-demo-data}
DEMO_NAME=${DEMO_NAME:-}   # greeting name shown in the demo ("" = just "Good morning")
mkdir -p run logs
alive() { [ -f "$1" ] && kill -0 "$(cat "$1")" 2>/dev/null; }

case "${1:-}" in
  start)
    [ "$DEMO_DIR" != "$ROOT/data" ] || { echo "DEMO_DIR must not be the real data dir" >&2; exit 1; }
    mkdir -p "$DEMO_DIR"; chmod 700 "$DEMO_DIR"
    if [ ! -f "$DEMO_DIR/.env" ]; then   # demo-only token: the real .env is never read by the demo
      ( umask 077; echo "MD_TOKEN=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")" > "$DEMO_DIR/.env" )
    fi
    if alive run/demo-server.pid; then echo "demo server already running (pid $(cat run/demo-server.pid))"
    else
      env -u MD_TOKEN -u MD_PORT -u MD_HOST -u MD_DATA_DIR -u DATA_DIR \
        MD_DEMO=1 MD_ENV_FILE="$DEMO_DIR/.env" MD_DATA_DIR="$DEMO_DIR" MD_PORT="$DEMO_PORT" MD_HOST=127.0.0.1 MD_GREETING_NAME="$DEMO_NAME" \
        nohup setsid node server.js >> logs/demo-server.log 2>&1 < /dev/null &
      echo $! > run/demo-server.pid
      UP=0; for i in $(seq 1 30); do curl -sf "http://127.0.0.1:$DEMO_PORT/api/health" >/dev/null && { UP=1; break; }; sleep 0.2; done
      if [ "$UP" != 1 ] || ! alive run/demo-server.pid; then echo "demo server failed to start (port $DEMO_PORT busy?); see logs/demo-server.log" >&2; tail -5 logs/demo-server.log >&2; rm -f run/demo-server.pid; exit 1; fi
      echo "demo server started (pid $(cat run/demo-server.pid)) on http://127.0.0.1:$DEMO_PORT, data $DEMO_DIR"
    fi
    if alive run/demo-tunnel.pid; then echo "demo tunnel already running (pid $(cat run/demo-tunnel.pid)): $(cat run/demo-tunnel.url 2>/dev/null)"
    else
      [ -x bin/cloudflared ] || { echo "bin/cloudflared missing; demo is local only" >&2; exit 0; }
      : > logs/demo-tunnel.log
      nohup setsid bin/cloudflared tunnel --no-autoupdate --url "http://127.0.0.1:$DEMO_PORT" >> logs/demo-tunnel.log 2>&1 < /dev/null &
      echo $! > run/demo-tunnel.pid
      URL=""
      for i in $(seq 1 60); do URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' logs/demo-tunnel.log | head -1 || true); [ -n "$URL" ] && break; sleep 0.5; done
      if [ -n "$URL" ]; then echo "$URL" > run/demo-tunnel.url; echo "demo tunnel started (pid $(cat run/demo-tunnel.pid)): $URL"
      else echo "demo tunnel started but no URL yet; see logs/demo-tunnel.log"; fi
    fi ;;
  stop)
    for n in demo-tunnel demo-server; do
      if alive run/$n.pid; then kill "$(cat run/$n.pid)" && echo "stopped $n (pid $(cat run/$n.pid))"; else echo "$n not running"; fi
      rm -f run/$n.pid
    done
    rm -f run/demo-tunnel.url ;;
  url)
    alive run/demo-tunnel.pid && [ -f run/demo-tunnel.url ] && cat run/demo-tunnel.url || { echo "demo tunnel not running (scripts/demo.sh start)" >&2; exit 1; } ;;
  status)
    for n in demo-server demo-tunnel; do alive run/$n.pid && echo "$n running (pid $(cat run/$n.pid))" || echo "$n stopped"; done
    [ -f run/demo-tunnel.url ] && echo "url: $(cat run/demo-tunnel.url)" || true ;;
  *) echo "usage: scripts/demo.sh start|stop|url|status" >&2; exit 2 ;;
esac
