#!/usr/bin/env bash
# Creates .env with a long random private token (only if .env doesn't exist yet).
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -f .env ]; then echo ".env already exists (token unchanged)"; exit 0; fi
umask 077
TOKEN=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")
cat > .env <<ENV
# Morning Deck private config. Do not commit.
MD_TOKEN=$TOKEN
MD_PORT=8787
MD_HOST=127.0.0.1
# Name in the greeting ("Good morning, <name>"); leave empty for just "Good morning".
MD_GREETING_NAME=
ENV
echo "wrote .env (token: ${TOKEN:0:6}…)"
