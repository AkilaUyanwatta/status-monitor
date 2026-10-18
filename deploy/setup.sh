#!/usr/bin/env bash
# One-time (idempotent) VM setup for Ubuntu 24.04: swap, Docker, app directory.
# Run from the directory containing docker-compose.yml and .env.example:
#   sudo ./setup.sh
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  exec sudo bash "$0" "$@"
fi

SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR=/opt/status-monitor
SWAPFILE=/swapfile

echo "==> Swap (2 GB)"
if ! swapon --show=NAME --noheadings | grep -qx "$SWAPFILE"; then
  if [ ! -f "$SWAPFILE" ]; then
    fallocate -l 2G "$SWAPFILE"
    chmod 600 "$SWAPFILE"
    mkswap "$SWAPFILE"
  fi
  swapon "$SWAPFILE"
fi
grep -q "^$SWAPFILE " /etc/fstab || echo "$SWAPFILE none swap sw 0 0" >> /etc/fstab
# Prefer RAM; only swap under real pressure.
echo "vm.swappiness=10" > /etc/sysctl.d/99-status-monitor.conf
sysctl -q -p /etc/sysctl.d/99-status-monitor.conf

echo "==> Docker"
if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y docker.io docker-compose-v2
fi
systemctl enable --now docker
if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != root ]; then
  usermod -aG docker "$SUDO_USER"
fi

echo "==> $APP_DIR"
install -d -m 755 "$APP_DIR"
install -m 644 "$SRC_DIR/docker-compose.yml" "$APP_DIR/docker-compose.yml"
install -m 644 "$SRC_DIR/.env.example" "$APP_DIR/.env.example"
if [ ! -f "$APP_DIR/.env" ]; then
  install -m 600 "$SRC_DIR/.env.example" "$APP_DIR/.env"
  echo "    created $APP_DIR/.env from the example: edit it before starting"
else
  chmod 600 "$APP_DIR/.env"
  echo "    kept existing $APP_DIR/.env"
fi

# No inbound firewall changes: the tunnel connects outbound only.
echo "==> Done. Next: sudo nano $APP_DIR/.env, then: cd $APP_DIR && sudo docker compose up -d"
