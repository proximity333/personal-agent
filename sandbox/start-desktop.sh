#!/usr/bin/env bash
# Container entrypoint for the desktop sandbox.
# Starts: envd (platform protocol) -> Xvfb -> x11vnc/noVNC -> browse relay -> Chromium.
set -euo pipefail

export DISPLAY=:99
export HOME=/home/user
mkdir -p /workspace "$HOME/.config"
chmod 777 /workspace 2>/dev/null || true

# 1) envd is mandatory: agent-sandbox controller uses it on 49983 for
#    init / commands / snapshot / pause-resume.
#    ENVD_ARGS: newer envd (0.10.x) in a plain container needs -isnotfc -no-cgroups.
/usr/bin/envd ${ENVD_ARGS:-} -port 49983 &

# 2) Virtual display.
Xvfb :99 -screen 0 1280x800x24 -nolisten tcp -ac &
for _ in $(seq 1 40); do
  [ -e /tmp/.X11-unix/X99 ] && break
  sleep 0.2
done

# 3) VNC + noVNC on 6080 (reachable via the sandbox per-port router).
#    NOTE: -nopw is for POC only; put auth in front before exposing publicly.
x11vnc -display :99 -nopw -forever -shared -rfbport 5900 -bg -o /tmp/x11vnc.log || true
websockify --web /usr/share/novnc 6080 127.0.0.1:5900 &

# 4) browse relay: the extension connects to 127.0.0.1:19988.
browse serve >>/tmp/browse-relay.log 2>&1 &

# 5) Chromium on Xvfb with the browse extension, persistent profile.
CHROME_BIN="$(command -v chromium || command -v chromium-browser || true)"
if [ -n "${CHROME_BIN}" ]; then
  "$CHROME_BIN" \
    --no-sandbox \
    --disable-dev-shm-usage \
    --disable-gpu \
    --user-data-dir="$HOME/.config/chromium" \
    --load-extension=/opt/browse-extension \
    --no-first-run \
    --no-default-browser-check \
    about:blank >>/tmp/chromium.log 2>&1 &
else
  echo "WARN: chromium not found in PATH" >&2
fi

# Keep the container alive; tini reaps children.
wait