#!/usr/bin/env bash
#
# WindowPanes — start server + open Firefox in kiosk mode
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

if command -v firefox &>/dev/null; then
  firefox --kiosk "$URL" &
elif command -v firefox-esr &>/dev/null; then
  firefox-esr --kiosk "$URL" &
else
  echo "Firefox not found. Open $URL manually in a browser."
fi

# Wait for the server process (Ctrl+C kills everything)
trap "kill $SERVER_PID 2>/dev/null; exit" INT TERM
wait $SERVER_PID
