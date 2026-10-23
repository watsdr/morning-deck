#!/usr/bin/env bash
# Rebuild Morning Deck from the newest off-disk backup + the GitHub repo + npm ci.
#   scripts/restore.sh [BACKUP_SET_DIR] [TARGET_DIR]
#   BACKUP_SET_DIR: a folder holding cards.json, answers.json, source.tar.gz, manifest.json (download the newest
#                   morning-deck_<set>_* files from Drive folder 1Klpu5Yni9GVRtt1aFjLkW0sZxrfJB-Z1 and strip the
#                   "morning-deck_<set>_" prefix). Default: newest set in run/backup-staging/.
#   TARGET_DIR:     default /workspace/morning-deck-restored. Refuses to write into a dir that already has data/.
# It never touches the live app dir, never starts the server, and never invents a token.
set -euo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
SET=${1:-}
if [ -z "$SET" ]; then
  S="$HERE/run/backup-staging"; [ -f "$S/LATEST" ] || { echo "no BACKUP_SET_DIR given and no $S/LATEST" >&2; exit 2; }
  SET="$S/$(cat "$S/LATEST")"
fi
TARGET=${2:-/workspace/morning-deck-restored}
REPO=${MD_REPO:-https://github.com/watsdr/morning-deck.git}
for f in cards.json answers.json source.tar.gz manifest.json; do [ -f "$SET/$f" ] || { echo "missing $SET/$f" >&2; exit 2; }; done
# integrity check against manifest sha256s
node -e '
const fs=require("fs"),c=require("crypto"),d=process.argv[1],m=JSON.parse(fs.readFileSync(d+"/manifest.json"));
for(const f of m.files){const h=c.createHash("sha256").update(fs.readFileSync(d+"/"+f.file)).digest("hex");if(h!==f.sha256){console.error("sha256 mismatch: "+f.file);process.exit(3)}}
for(const f of ["cards.json","answers.json"])JSON.parse(fs.readFileSync(d+"/"+f));console.log("backup "+m.set+" verified (commit "+(m.gitCommit||"?").slice(0,7)+")")' "$SET"
[ -e "$TARGET/data" ] && { echo "$TARGET/data already exists; refusing to overwrite" >&2; exit 2; }
COMMIT=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).gitCommit||"")' "$SET/manifest.json")
if [ ! -d "$TARGET/.git" ]; then git clone --quiet "$REPO" "$TARGET"; fi
cd "$TARGET"
if [ -n "$COMMIT" ] && git cat-file -e "$COMMIT^{commit}" 2>/dev/null; then git checkout --quiet "$COMMIT"; echo "checked out $COMMIT";
else echo "commit ${COMMIT:-?} not on GitHub (local-only commits); using the default branch + the tarball"; fi
# Tarball holds the exact source at backup time (incl. unpushed commits / untracked files), never secrets.
tar -xzf "$SET/source.tar.gz" -C "$TARGET"
npm ci --no-audit --no-fund
mkdir -p data run logs && chmod 700 data run logs
install -m 600 "$SET/cards.json" data/cards.json
install -m 600 "$SET/answers.json" data/answers.json
cat <<MSG
Restored into $TARGET.
Next (by hand):
  1. Secrets are never backed up. Either copy the old .env from a safe place, or run scripts/init-env.sh
     (new token: every phone must sign in again, e.g. scripts/pair-qr.sh) and scripts/init-vapid.sh
     (new VAPID key: phones must tap "Notify me" again).
  2. Start: scripts/start.sh --tailscale   (Tailscale state in run/tailscale is not backed up: re-login if needed)
MSG
