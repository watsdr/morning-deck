#!/usr/bin/env bash
# Add Web Push VAPID keys to .env (once). Keeps .env at mode 600. Never prints the private key.
set -euo pipefail
cd "$(dirname "$0")/.."
if grep -q '^MD_VAPID_PRIVATE=' .env; then echo "VAPID keys already in .env"; exit 0; fi
umask 077
node -e '
const wp=require("web-push");const k=wp.generateVAPIDKeys();const fs=require("fs");
let s=fs.readFileSync(".env","utf8");if(!s.endsWith("\n"))s+="\n";
s+=`MD_VAPID_PUBLIC=${k.publicKey}\nMD_VAPID_PRIVATE=${k.privateKey}\nMD_VAPID_SUBJECT=mailto:morning-deck@localhost\n`;
fs.writeFileSync(".env.tmp",s,{mode:0o600});fs.renameSync(".env.tmp",".env");'
chmod 600 .env
echo "VAPID keys added to .env (restart the server to use them)"
