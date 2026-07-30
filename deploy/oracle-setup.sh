#!/usr/bin/env bash
#
# One-shot setup for the site-monitor on an Oracle Cloud Free Tier box
# (Ubuntu or Oracle Linux, ARM64 or x86). Idempotent — safe to re-run.
#
# Usage (run ON the server, after copying this folder to /opt/site-monitor):
#   cd /opt/site-monitor
#   cp .env.example .env && nano .env   # fill SITE_URL + Telegram creds first!
#   sudo bash deploy/oracle-setup.sh
#
set -euo pipefail

APP_DIR="/opt/site-monitor"
SERVICE="site-monitor"

echo "==> site-monitor setup"

if [[ ! -f "${APP_DIR}/.env" ]]; then
  echo "ERROR: ${APP_DIR}/.env not found. Copy .env.example to .env and fill it in first." >&2
  exit 1
fi

# 1) Node 20 (skip if a recent node is already present).
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | cut -d. -f1 | tr -d v)" -lt 18 ]]; then
  echo "==> installing Node.js 20"
  if command -v apt-get >/dev/null 2>&1; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
  elif command -v dnf >/dev/null 2>&1; then
    curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
    dnf install -y nodejs
  else
    echo "ERROR: no apt-get or dnf found; install Node 20 manually." >&2
    exit 1
  fi
else
  echo "==> node $(node -v) already present"
fi

# 2) Build.
echo "==> npm ci && npm run build"
cd "${APP_DIR}"
npm ci
npm run build

# 3) Install & start the systemd service (auto-fill user + paths so it works
#    whether the box user is "ubuntu", "opc", or something else, and regardless
#    of where you cloned the repo).
echo "==> installing systemd unit"
RUN_USER="${SUDO_USER:-$(whoami)}"
sed \
  -e "s/^User=.*/User=${RUN_USER}/" \
  -e "s#^WorkingDirectory=.*#WorkingDirectory=${APP_DIR}#" \
  -e "s#^EnvironmentFile=.*#EnvironmentFile=${APP_DIR}/.env#" \
  -e "s#^ExecStart=.*#ExecStart=$(command -v node) dist/index.js#" \
  "${APP_DIR}/deploy/${SERVICE}.service" > "/etc/systemd/system/${SERVICE}.service"
chmod 0644 "/etc/systemd/system/${SERVICE}.service"
systemctl daemon-reload
systemctl enable --now "${SERVICE}"

echo "==> done. Follow logs with:  journalctl -u ${SERVICE} -f"
systemctl --no-pager status "${SERVICE}" || true
