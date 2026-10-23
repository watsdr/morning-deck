#!/usr/bin/env bash
# Approve a phone's "Request access from this phone" sign-in (box only; the server refuses this over Funnel/tunnel).
#   scripts/approve-phone.sh <CODE>         -> shows the request's device (user-agent), asks y/N, approves
#   scripts/approve-phone.sh <CODE> --yes   -> approve without asking
# The phone then gets a 180-day session. Only approve a code you see on YOUR phone's screen right now.
set -euo pipefail
cd "$(dirname "$0")/.."
CODE=$(printf '%s' "${1:-}" | tr '[:lower:]' '[:upper:]' | tr -cd 'A-Z0-9')
[ ${#CODE} -eq 6 ] || { echo "usage: $0 <6-character code shown on the phone> [--yes]" >&2; exit 2; }
PORT=$(sed -n "s/^MD_PORT=//p" .env | head -1); PORT=${MD_PORT_OVERRIDE:-${PORT:-8787}}
call() { # token reaches curl through a file descriptor only (never argv, env of a child, or stdout)
  curl -sS -w '\n%{http_code}' -X POST -H 'Content-Type: application/json' \
    -H @<(printf 'Authorization: Bearer %s\n' "$(sed -n 's/^MD_TOKEN=//p' .env | head -1 | tr -d "\"'")") \
    --data "{\"code\":\"$CODE\"}" "http://127.0.0.1:${PORT}/api/device/$1"
}
out=$(call info) || { echo "server not reachable on 127.0.0.1:${PORT}" >&2; exit 1; }
status=${out##*$'\n'}; body=${out%$'\n'*}
[ "$status" = 200 ] || { echo "no pending request with code $CODE (expired after 10 min, already used, or mistyped)" >&2; exit 1; }
ua=$(printf '%s' "$body" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.ua+"  (requested "+new Date(j.createdAt).toLocaleString("en-US",{timeZone:"America/New_York"})+" ET)")})')
echo "Request $CODE from: $ua"
if [ "${2:-}" != "--yes" ]; then
  read -r -p "Approve this device for 180 days? [y/N] " ans
  case "$ans" in y|Y|yes) ;; *) echo "not approved"; exit 1 ;; esac
fi
out=$(call approve); status=${out##*$'\n'}
[ "$status" = 200 ] || { echo "approval failed (HTTP $status); the request may have just expired" >&2; exit 1; }
echo "approved $CODE. The phone signs in within a few seconds."
