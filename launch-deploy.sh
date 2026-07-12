#!/usr/bin/env bash
cd "$(dirname "$0")"
echo "☀️  Solar Watchdog — server deploy"
echo "──────────────────────────────────"
read -r -p "Server (user@ip, e.g. root@31.97.109.46): " TARGET
[ -z "$TARGET" ] && { echo "No server given, aborting."; exit 1; }
echo "$TARGET" > .deploy-target

echo ""
echo "==> Installing your SSH key on the server (enter the SERVER password when asked)…"
ssh-copy-id -o StrictHostKeyChecking=accept-new "$TARGET" || { echo "ssh-copy-id failed"; exit 1; }

echo ""
echo "==> Running the deploy (passwordless from here)…"
./deploy.sh "$TARGET" && echo DONE > .deploy-status || echo FAILED > .deploy-status

echo ""
read -r -p "Finished. Press Enter to close this window."
