#!/usr/bin/env bash
# Run from Friday's repo root as the normal user who should own its files and tools.
set -Eeuo pipefail

die() { echo "Error: $*" >&2; exit 1; }

[[ $EUID -ne 0 ]] || die "Run as your normal user, not with sudo."
[[ -f package.json && -f src/server.js ]] || die "Run this from Friday's repo root."

APP_DIR="$(pwd -P)"
SERVICE_USER="$(id -un)"
SERVICE_GROUP="$(id -gn)"
SERVICE_HOME="$(getent passwd "$SERVICE_USER" | cut -d: -f6)"
NODE_BIN="$(command -v node || true)"
NPM_BIN="$(command -v npm || true)"
CURL_BIN="/usr/bin/curl"
SYSTEMCTL_BIN="/usr/bin/systemctl"

[[ -n "$SERVICE_HOME" ]] || die "Could not determine your home directory."
[[ -n "$NODE_BIN" && -n "$NPM_BIN" ]] || die "Install Node.js 22.19+ and npm first."
[[ -x "$CURL_BIN" && -x "$SYSTEMCTL_BIN" ]] || die "Install curl and systemd first."
[[ "$APP_DIR$SERVICE_HOME$NODE_BIN" != *[[:space:]]* ]] || die "Repo, home, and Node paths must not contain spaces."

"$NODE_BIN" -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 19)) process.exit(1)' \
  || die "Friday requires Node.js 22.19 or newer."

if "$CURL_BIN" --fail --silent --max-time 2 http://127.0.0.1:3000/healthz >/dev/null 2>&1; then
  if ! sudo "$SYSTEMCTL_BIN" is-active --quiet friday.service; then
    die "Something is already serving port 3000. Stop the manually started Friday process, then rerun."
  fi
  sudo "$SYSTEMCTL_BIN" stop friday.service
fi

echo "Installing Friday dependencies..."
(cd "$APP_DIR" && "$NPM_BIN" ci --omit=dev)

echo "Writing systemd service and health-check units..."
sudo install -d -m 0755 /usr/local/libexec

sudo tee /etc/systemd/system/friday.service >/dev/null <<EOF
[Unit]
Description=Friday personal agent
Wants=network-online.target
After=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_GROUP
WorkingDirectory=$APP_DIR
Environment=HOME=$SERVICE_HOME
Environment=FRIDAY_HOME=$SERVICE_HOME/.friday
Environment=PI_CODING_AGENT_DIR=$SERVICE_HOME/.pi/agent
Environment=HOST=127.0.0.1
Environment=PORT=3000
Environment="PATH=$PATH"
ExecStart=$NODE_BIN $APP_DIR/src/server.js
Restart=always
RestartSec=10s
TimeoutStopSec=30s
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full

[Install]
WantedBy=multi-user.target
EOF

sudo tee /usr/local/libexec/friday-healthcheck >/dev/null <<EOF
#!/usr/bin/env bash
set -euo pipefail

"$SYSTEMCTL_BIN" is-active --quiet friday.service || exit 0

for attempt in 1 2; do
  if "$CURL_BIN" --fail --silent --max-time 10 http://127.0.0.1:3000/healthz >/dev/null; then
    exit 0
  fi
  if [[ "\$attempt" -eq 1 ]]; then sleep 5; fi
done

echo "Friday health check failed twice; restarting service." >&2
"$SYSTEMCTL_BIN" restart friday.service
EOF
sudo chmod 0755 /usr/local/libexec/friday-healthcheck

sudo tee /etc/systemd/system/friday-healthcheck.service >/dev/null <<'EOF'
[Unit]
Description=Check Friday HTTP health

[Service]
Type=oneshot
ExecStart=/usr/local/libexec/friday-healthcheck
EOF

sudo tee /etc/systemd/system/friday-healthcheck.timer >/dev/null <<'EOF'
[Unit]
Description=Periodic Friday health check

[Timer]
OnBootSec=2min
OnUnitActiveSec=2min
AccuracySec=15s
Unit=friday-healthcheck.service

[Install]
WantedBy=timers.target
EOF

if "$SYSTEMCTL_BIN" cat tailscaled.service >/dev/null 2>&1; then
  sudo "$SYSTEMCTL_BIN" enable --now tailscaled.service
else
  echo "Warning: tailscaled.service not found; ensure Tailscale starts at boot."
fi

sudo "$SYSTEMCTL_BIN" daemon-reload
sudo "$SYSTEMCTL_BIN" enable --now friday.service friday-healthcheck.timer
sudo "$SYSTEMCTL_BIN" status friday.service --no-pager

echo
echo "Friday restarts every 10 seconds after a process exit, with no retry limit."
echo "The health timer checks /healthz every 2 minutes and restarts Friday if it stops responding."
echo "Logs: sudo journalctl -u friday -f"
echo "Keep the laptop powered and disable suspend/lid-close sleep; systemd cannot recover while it is asleep or off."
echo "Friday runs with the permissions of $SERVICE_USER. Change the hard-coded app password before remote access."
