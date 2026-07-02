#!/usr/bin/env bash
#
# WindowPanes — start server + open Firefox in kiosk mode
#
# Hotkeys (while Firefox has focus):
#   Esc       — full shutdown (server + Firefox)
#   Ctrl+Q    — full shutdown (server + Firefox)
#   Ctrl+C    — full shutdown (in this terminal)
#
# Esc/Ctrl+Q require `xdotool` on the X11 display hosting Firefox. If
# xdotool isn't installed (e.g. macOS dev, headless CI), the watcher is
# silently skipped — Firefox itself still honors Ctrl+Q on macOS, and
# Ctrl+C in the terminal always works.
#
# Usage:
#   ./start.sh                         # defaults
#   PORT=8080 MEDIA_DIR=/mnt/videos CONFIG=./my.yaml ./start.sh
#
set -euo pipefail

PORT="${PORT:-3000}"
CONFIG="${CONFIG:-$(dirname "$0")/config.yaml}"
MEDIA_DIR="${MEDIA_DIR:-/media}"

export PORT CONFIG MEDIA_DIR

echo "Starting WindowPanes..."
echo "  Port:      $PORT"
echo "  Config:    $CONFIG"
echo "  Media dir: $MEDIA_DIR"

# Start the Node server in the background
node "$(dirname "$0")/server.js" &
SERVER_PID=$!

# Give the server a moment to start
sleep 2

# Open Firefox in kiosk mode
URL="http://localhost:${PORT}"
echo "Opening Firefox kiosk at $URL"

FIREFOX_PID=""
if command -v firefox &>/dev/null; then
  firefox --kiosk "$URL" &
  FIREFOX_PID=$!
elif command -v firefox-esr &>/dev/null; then
  firefox-esr --kiosk "$URL" &
  FIREFOX_PID=$!
else
  echo "Firefox not found. Open $URL manually in a browser."
fi

# Cleanup trap — runs on Ctrl+C in this terminal, SIGTERM, or signals
# from the key watcher. Kills both server and Firefox cleanly.
KEY_WATCHER_PIDS=()

cleanup() {
  echo
  echo "[start.sh] Shutting down WindowPanes..."
  if [ -n "$FIREFOX_PID" ]; then
    kill "$FIREFOX_PID" 2>/dev/null || true
  fi
  kill "$SERVER_PID" 2>/dev/null || true
  for pid in "${KEY_WATCHER_PIDS[@]:-}"; do
    [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  done
  exit 0
}
trap cleanup INT TERM

# Key watcher — Esc and Ctrl+Q trigger a full shutdown.
# Uses xdotool's `keydown` mode, which blocks until the specified key is
# pressed anywhere on the X11 display. On Wayland, headless macOS, or any
# system without xdotool, the watcher is skipped silently (Ctrl+C still
# works in the terminal, and Ctrl+Q still quits Firefox on macOS).
start_key_watcher() {
  if ! command -v xdotool >/dev/null; then
    return
  fi
  # xdotool keydown needs an X server. On Wayland-only systems, it will
  # silently fail; bail early with a one-time hint.
  if [ -z "${DISPLAY:-}" ] && [ -z "${WAYLAND_DISPLAY:-}" ]; then
    return
  fi

  watch_for() {
    local key="$1"
    while true; do
      if xdotool keydown "$key" >/dev/null 2>&1; then
        echo "[start.sh] $key pressed — shutting down"
        cleanup
        exit 0
      fi
      sleep 0.3
    done
  }

  # Each watcher in its own subshell so they can listen for different keys
  # simultaneously without one blocking the other.
  ( watch_for Escape ) & KEY_WATCHER_PIDS+=($!)
  ( watch_for ctrl+q ) & KEY_WATCHER_PIDS+=($!)
  disown 2>/dev/null || true
}
start_key_watcher

echo
echo "WindowPanes running. Hotkeys:"
echo "  Esc     → shutdown"
echo "  Ctrl+Q  → shutdown"
echo "  Ctrl+C  → shutdown (in this terminal)"

# Wait for the server process
wait "$SERVER_PID"
