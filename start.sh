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
# xdotool isn't installed (e.g. macOS dev, headless CI), or can't reach
# the X server, the watcher is silently skipped — Firefox itself still
# honors Ctrl+Q on macOS, and Ctrl+C in the terminal always works.
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
  # --new-instance forces a fresh Firefox process even when the default
  # profile is already in use by another running Firefox session. Without
  # it, `firefox --kiosk $URL` hands the URL to the running instance,
  # which loads it as a regular tab in that window instead of opening a
  # kiosk on the display.
  firefox --kiosk --new-instance "$URL" &
  FIREFOX_PID=$!
elif command -v firefox-esr &>/dev/null; then
  firefox-esr --kiosk --new-instance "$URL" &
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
# Uses `xdotool waitforkey`, which blocks until the specified key is pressed
# anywhere on the X11 display. (NOT `xdotool keydown` — that sends a key
# event and returns immediately; it does not listen.)
#
# On Wayland, headless macOS, or any system without xdotool, the watcher
# is skipped silently. Ctrl+C still works in the terminal, and Firefox
# itself honors Ctrl+Q on macOS.
start_key_watcher() {
  if ! command -v xdotool >/dev/null; then
    return
  fi
  # xdotool waitforkey needs an X server.
  if [ -z "${DISPLAY:-}" ] && [ -z "${WAYLAND_DISPLAY:-}" ]; then
    return
  fi

  # Sanity check: confirm xdotool can actually talk to the X server before
  # we spawn the watcher, otherwise waitforkey returns instantly and the
  # script shuts down on startup. (Hit this on 2026-07-02 — the bug was
  # using `xdotool keydown` instead of `waitforkey`; both reported
  # instantly and looked identical from the script's perspective.)
  if ! xdotool getmouselocation --shell >/dev/null 2>&1; then
    echo "[start.sh] xdotool can't reach the X server; skipping key watcher (use Ctrl+C in this terminal)"
    return
  fi

  watch_for() {
    local key="$1"
    # waitforkey exits 0 when the key is pressed. Loop so a single watcher
    # can fire multiple shutdowns in a session (e.g. after a config tweak).
    while true; do
      if xdotool waitforkey "$key"; then
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
