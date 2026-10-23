#!/usr/bin/env bash
# Make a one-time QR pairing code (single use, 5 min) and write it to run/pair-qr.png (mode 600).
# The code exists only inside the PNG and in the server's memory (hashed); nothing is printed or logged.
#   scripts/pair-qr.sh            -> run/pair-qr.png, then open it on the box and scan with the phone camera
# Or open http://127.0.0.1:8787/signin/qr in the box's browser (box-only page).
set -euo pipefail
cd "$(dirname "$0")/.."
PORT=$(sed -n "s/^MD_PORT=//p" .env | head -1); PORT=${MD_PORT_OVERRIDE:-${PORT:-8787}}
mkdir -p run; chmod 700 run
OUT=${MD_PAIR_OUT:-run/pair-qr.png}; TMP=$(mktemp run/.pair-qr.XXXXXX); chmod 600 "$TMP"
# Token goes to curl through a file descriptor, never argv/env of a child or stdout.
code=$(curl -sS -o "$TMP" -w '%{http_code}' -X POST \
  -H @<(printf 'Authorization: Bearer %s\n' "$(sed -n 's/^MD_TOKEN=//p' .env | head -1 | tr -d "\"'")") \
  "http://127.0.0.1:${PORT}/api/pair/qr.png") || { rm -f "$TMP"; echo "server not reachable on 127.0.0.1:${PORT}" >&2; exit 1; }
if [ "$code" != 200 ]; then rm -f "$TMP"; echo "pairing endpoint returned HTTP $code" >&2; exit 1; fi
mv -f "$TMP" "$OUT"; chmod 600 "$OUT"
echo "wrote $OUT (valid 5 minutes, single use). Scan it with the phone camera, then delete it: rm $OUT"
