#!/usr/bin/env bash
# Named Cloudflare Tunnel for https://morning.watsdr.com (runs alongside Tailscale Funnel).
#   scripts/cloudflare-tunnel.sh setup   -> create tunnel "morning-deck" + route DNS (needs ~/.cloudflared/cert.pem and watsdr.com zone on Cloudflare)
#   scripts/cloudflare-tunnel.sh start|stop|status
set -euo pipefail
cd "$(dirname "$0")/.."; ROOT=$(pwd); mkdir -p run logs cloudflare
NAME=morning-deck; HOST=${CF_HOSTNAME:-morning.watsdr.com}; CF="$ROOT/bin/cloudflared"
CFG="$ROOT/cloudflare/config.yml"
write_config() {
  local id; id=$(cat cloudflare/tunnel-id)
  cat > "$CFG" <<YML
tunnel: $id
credentials-file: $HOME/.cloudflared/$id.json
no-autoupdate: true
ingress:
  - hostname: $HOST
    path: ^/hub-world(/.*)?\$
    service: http://127.0.0.1:8796
  - hostname: $HOST
    service: http://127.0.0.1:8787
  - service: http_status:404
YML
  "$CF" tunnel --config "$CFG" ingress validate
}
case "${1:-}" in
  setup)
    [ -f "$HOME/.cloudflared/cert.pem" ] || { echo "not logged in: run bin/cloudflared tunnel login" >&2; exit 1; }
    "$CF" tunnel info "$NAME" >/dev/null 2>&1 || "$CF" tunnel create "$NAME"
    "$CF" tunnel list -o json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).find(t=>t.name==="'$NAME'").id))' > cloudflare/tunnel-id
    write_config
    "$CF" tunnel route dns "$NAME" "$HOST"
    echo "tunnel $(cat cloudflare/tunnel-id) -> $HOST" ;;
  start)
    [ -f cloudflare/tunnel-id ] || { echo "run: $0 setup" >&2; exit 1; }
    write_config >/dev/null
    if [ -f run/cftunnel.pid ] && kill -0 "$(cat run/cftunnel.pid)" 2>/dev/null; then echo "already running (pid $(cat run/cftunnel.pid))"; exit 0; fi
    setsid nohup "$CF" tunnel --config "$CFG" run "$NAME" >> logs/cftunnel.log 2>&1 < /dev/null &
    echo $! > run/cftunnel.pid; echo "named tunnel started (pid $!): https://$HOST  (log logs/cftunnel.log)" ;;
  stop)
    if [ -f run/cftunnel.pid ] && kill -0 "$(cat run/cftunnel.pid)" 2>/dev/null; then kill "$(cat run/cftunnel.pid)"; echo stopped; else echo "not running"; fi
    rm -f run/cftunnel.pid ;;
  status)
    # Tokenless check only: expect 401 on / (never send MD_TOKEN to the public URL)
    curl -s -o /dev/null -w "https://$HOST/ -> %{http_code}\n" "https://$HOST/" || true
    curl -s -o /dev/null -w "https://$HOST/hub-world -> %{http_code}\n" "https://$HOST/hub-world" || true ;;
  *) echo "usage: $0 setup|start|stop|status" >&2; exit 2 ;;
esac
