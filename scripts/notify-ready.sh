#!/usr/bin/env bash
# Send the "deck is ready" Web Push now (count only, no card text). The 6:15 assemble already does this itself;
# this is for any other step that wants to ping. Localhost only; reads the token from .env without printing it.
#   scripts/notify-ready.sh            -> send (server skips it when 0 cards are pending)
#   scripts/notify-ready.sh --dry-run  -> show what would be sent
set -euo pipefail
cd "$(dirname "$0")/.."
PORT=${MD_PORT_OVERRIDE:-$(sed -n 's/^MD_PORT=//p' .env | head -1)}; PORT=${PORT:-8787}
q=""; [ "${1:-}" = "--dry-run" ] && q="?dryRun=1"
curl -sS -m 30 -X POST "http://127.0.0.1:$PORT/api/notify$q" -H @<(printf 'Authorization: Bearer %s\n' "$(sed -n 's/^MD_TOKEN=//p' .env | head -1)")
echo
