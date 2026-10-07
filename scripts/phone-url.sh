#!/usr/bin/env bash
# Print the full private phone link (base URL + token).
#   scripts/phone-url.sh           -> permanent Tailscale Funnel link (default)
#   scripts/phone-url.sh --tunnel  -> current Cloudflare quick-tunnel link (changes on restart)
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
if [ "${1:-}" = "--tunnel" ]; then
  [ -f run/tunnel.url ] || { echo "no tunnel running (scripts/start.sh --tunnel)"; exit 1; }
  BASE=$(cat run/tunnel.url)
else
  BASE=$(cat run/tailscale.url 2>/dev/null) || { echo "no Tailscale URL yet (scripts/start.sh --tailscale), or use --tunnel" >&2; exit 1; }
fi
echo "${BASE}/?token=${MD_TOKEN}"
