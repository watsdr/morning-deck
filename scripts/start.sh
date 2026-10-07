#!/usr/bin/env bash
# Start the Morning Deck server (and optionally a public HTTPS front door) in the background.
#   scripts/start.sh               -> server only
#   scripts/start.sh --tailscale   -> server + Tailscale Funnel (permanent https://morning-deck.<tailnet>.ts.net)
#   scripts/start.sh --tunnel      -> server + trycloudflare quick tunnel (URL printed; changes every restart)
#   Flags can be combined: scripts/start.sh --tailscale --tunnel
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)
mkdir -p run logs
[ -f .env ] || scripts/init-env.sh
[ -f data/cards.json ] || node scripts/reset.js
set -a; . ./.env; set +a

WANT_TUNNEL=0; WANT_TS=0
for arg in "$@"; do
  case "$arg" in
    --tunnel) WANT_TUNNEL=1 ;;
    --tailscale) WANT_TS=1 ;;
    *) echo "unknown option: $arg (use --tailscale and/or --tunnel)" >&2; exit 2 ;;
  esac
done

if [ -f run/server.pid ] && kill -0 "$(cat run/server.pid)" 2>/dev/null; then
  echo "server already running (pid $(cat run/server.pid))"
else
  nohup node server.js >> logs/server.log 2>&1 &
  echo $! > run/server.pid
  sleep 0.6
  echo "server started (pid $(cat run/server.pid)) on http://${MD_HOST}:${MD_PORT}"
fi

if [ "$WANT_TS" = 1 ]; then
  # Tailscale runs as this user in userspace-networking mode (no TUN/root/systemd needed).
  # State (node key + Funnel TLS certs) lives in run/tailscale; the serve/funnel config is part of that state.
  TS_DIR="$ROOT/run/tailscale"
  TS_SOCK="$TS_DIR/tailscaled.sock"
  TS=( "$ROOT/bin/tailscale" "--socket=$TS_SOCK" )
  mkdir -p "$TS_DIR"; chmod 700 "$TS_DIR"
  [ -x bin/tailscaled ] || { echo "bin/tailscaled missing (see README: Tailscale Funnel)" >&2; exit 1; }
  if [ -f run/tailscaled.pid ] && kill -0 "$(cat run/tailscaled.pid)" 2>/dev/null; then
    echo "tailscaled already running (pid $(cat run/tailscaled.pid))"
  else
    setsid nohup "$ROOT/bin/tailscaled" --tun=userspace-networking \
      --statedir="$TS_DIR" --state="$TS_DIR/tailscaled.state" --socket="$TS_SOCK" \
      >> "$ROOT/logs/tailscaled.log" 2>&1 < /dev/null &
    echo $! > run/tailscaled.pid
    for i in $(seq 1 40); do "${TS[@]}" status --json >/dev/null 2>&1 && break; sleep 0.5; done
    echo "tailscaled started (pid $(cat run/tailscaled.pid)), log in logs/tailscaled.log"
  fi
  STATE=""
  for i in $(seq 1 40); do
    STATE=$("${TS[@]}" status --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).BackendState)}catch{console.log("")}})')
    [ "$STATE" = "Running" ] || [ "$STATE" = "NeedsLogin" ] && break; sleep 0.5
  done
  if [ "$STATE" != "Running" ]; then
    echo "tailscale is not logged in (state: ${STATE:-unknown}). Run:"
    echo "  bin/tailscale --socket=$TS_SOCK up --hostname=morning-deck"
    echo "then open the login URL it prints, and re-run scripts/start.sh --tailscale"
  else
    # Idempotent: (re)publishes 127.0.0.1:$MD_PORT on https://<this node>.ts.net:443 via Funnel.
    timeout 60 "${TS[@]}" funnel --bg "$MD_PORT" > logs/tailscale-funnel.log 2>&1 || true
    if grep -q 'Funnel started' logs/tailscale-funnel.log; then
      TS_URL=$("${TS[@]}" status --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log("https://"+JSON.parse(s).Self.DNSName.replace(/\.$/,"")))')
      echo "$TS_URL" > run/tailscale.url
      echo "funnel live: $TS_URL -> http://127.0.0.1:${MD_PORT}"
      echo "phone link: scripts/phone-url.sh"
    else
      echo "funnel did not start; see logs/tailscale-funnel.log:"; cat logs/tailscale-funnel.log
    fi
  fi
fi

if [ "$WANT_TUNNEL" = 1 ]; then
  if [ -f run/tunnel.pid ] && kill -0 "$(cat run/tunnel.pid)" 2>/dev/null; then
    echo "tunnel already running (pid $(cat run/tunnel.pid))"
  else
    : > logs/tunnel.log
    nohup bin/cloudflared tunnel --no-autoupdate --url "http://127.0.0.1:${MD_PORT}" >> logs/tunnel.log 2>&1 &
    echo $! > run/tunnel.pid
    for i in $(seq 1 40); do
      URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' logs/tunnel.log | head -1 || true)
      [ -n "$URL" ] && break; sleep 0.5
    done
    if [ -n "${URL:-}" ]; then echo "$URL" > run/tunnel.url; echo "tunnel started (pid $(cat run/tunnel.pid)): $URL"; echo "phone link: $URL/?token=<MD_TOKEN from .env>"; else echo "tunnel started but no URL yet; see logs/tunnel.log"; fi
  fi
fi
