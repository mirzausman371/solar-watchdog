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
  pm2 start index.mjs --name solar-watchdog --node-args='--env-file=$REMOTE_DIR/.env' --time
  pm2 save
  pm2 startup -u \$(whoami) --hp \$HOME 2>/dev/null | tail -1 || true
  sleep 3
  pm2 logs solar-watchdog --lines 6 --nostream
"

echo "==> Opening port 8080 (if ufw is active)…"
ssh "$TARGET" 'sudo ufw status 2>/dev/null | grep -q "Status: active" && sudo ufw allow 8080/tcp || echo "ufw inactive or unavailable — skipping"'

SERVER_IP="${TARGET##*@}"
echo ""
echo "✅ Deployed. Dashboard: http://$SERVER_IP:8080 (login with your DASH_PASSWORD)"
