#!/usr/bin/env bash
# One-command deploy: ./deploy.sh user@server-ip
# Syncs the watchdog (code + .env + all runtime data) and starts it under pm2.
set -euo pipefail

TARGET="${1:?usage: ./deploy.sh user@server-ip}"
DIR="$(cd "$(dirname "$0")" && pwd)"
REMOTE_DIR="~/solar-watchdog"

echo "==> Checking server prerequisites…"
ssh "$TARGET" '
  set -e
  if ! command -v node >/dev/null; then echo "NODE_MISSING"; exit 0; fi
  NODE_V=$(node --version)
  MAJOR=$(echo "$NODE_V" | sed "s/v\([0-9]*\).*/\1/")
  if [ "$MAJOR" -lt 20 ]; then echo "NODE_OLD $NODE_V"; exit 0; fi
  echo "NODE_OK $NODE_V"
  command -v pm2 >/dev/null && echo "PM2_OK $(pm2 --version)" || echo "PM2_MISSING"
' | tee /tmp/solar-deploy-check

if grep -q "NODE_MISSING\|NODE_OLD" /tmp/solar-deploy-check; then
  echo "==> Installing Node 20 (NodeSource)…"
  ssh "$TARGET" 'curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs'
fi
if grep -q "PM2_MISSING" /tmp/solar-deploy-check; then
  echo "==> Installing pm2…"
  ssh "$TARGET" 'sudo npm install -g pm2'
fi

echo "==> Syncing files…"
rsync -av \
  --include="index.mjs" --include=".env" \
  --include="*.json" --include="history.jsonl" \
  --exclude="*" \
  "$DIR/" "$TARGET:$REMOTE_DIR/"

echo "==> Starting under pm2…"
ssh "$TARGET" "
  cd $REMOTE_DIR
  pm2 delete solar-watchdog 2>/dev/null || true
  pm2 start index.mjs --name solar-watchdog --node-args=\"--env-file=\$PWD/.env\" --time
  pm2 save
  pm2 startup -u \$(whoami) --hp \$HOME 2>/dev/null | tail -1 || true
  sleep 3
  pm2 logs solar-watchdog --lines 6 --nostream
"

# Port 8080 stays firewalled — access is via the nginx HTTPS proxy only.
SERVER_IP="${TARGET##*@}"
echo ""
echo "✅ Deployed. Watchdog on 127.0.0.1:8080 behind nginx (see PUBLIC_URL)."
