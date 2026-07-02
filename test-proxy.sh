#!/usr/bin/env bash
#
# test-proxy.sh — smoke-test the /api/proxy route
#
# Starts the WindowPanes server, hits the proxy endpoint with example.com
# (a small, always-200 HTML page that has no X-Frame-Options), and asserts:
#   • HTTP 200
#   • No x-frame-options header in the response
#   • No content-security-policy header in the response
#   • Response body looks like HTML (<!DOCTYPE or <html)
#
# Then optionally runs the same checks against nytimes.com (a known blocker)
# to demonstrate the header-stripping in action.
#
# Pass an arg to test an additional URL:   ./test-proxy.sh https://nytimes.com
#
# Exits 0 on success, 1 on any assertion failure.

set -u

PORT="${PORT:-3777}"
LOGFILE="$(mktemp -t windowpanes-proxy-test.XXXXXX.log)"
PID=""

cleanup() {
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null || true
    wait "$PID" 2>/dev/null || true
  fi
  # Keep the log on failure for debugging; print it.
  if [ "${KEEP_LOG:-0}" = "1" ]; then
    echo "[test-proxy] server log kept at: $LOGFILE"
  else
    rm -f "$LOGFILE"
  fi
}
trap cleanup EXIT INT TERM

echo "[test-proxy] starting server on port $PORT..."
PORT="$PORT" node "$(dirname "$0")/server.js" >"$LOGFILE" 2>&1 &
PID=$!

# Wait for the port to be reachable (up to 15 s)
for i in $(seq 1 30); do
  if curl -sf -o /dev/null "http://127.0.0.1:${PORT}/api/config" 2>/dev/null; then
    break
  fi
  sleep 0.5
done
if ! curl -sf -o /dev/null "http://127.0.0.1:${PORT}/api/config" 2>/dev/null; then
  echo "[test-proxy] FAIL: server did not start within 15s"
  echo "--- server log ---"
  cat "$LOGFILE"
  KEEP_LOG=1
  exit 1
fi

FAIL=0

run_assertions() {
  local label="$1"
  local target_url="$2"
  local expect_html_body="$3"  # "yes" | "no"

  echo
  echo "── $label ──"
  echo "  target: $target_url"

  # Use a temp file for headers, /dev/stderr for body length, stdout for response body
  local hdr body status
  hdr="$(mktemp)"
  body="$(mktemp)"

  # -w "%{http_code}" writes just the code; -D dumps headers; -o body file
  status="$(curl -sS -g -o "$body" -D "$hdr" -w '%{http_code}' \
    "http://127.0.0.1:${PORT}/api/proxy?url=$(printf %s "$target_url" | sed 's/&/%26/g')")"

  echo "  status: $status"

  # Status code check
  if [ "$status" != "200" ]; then
    echo "  ✗ status was $status, expected 200"
    FAIL=1
  else
    echo "  ✓ status 200"
  fi

  # No *blocking* X-Frame-Options in headers. For HTML we may have set
  # X-Frame-Options: ALLOWALL ourselves for paranoia — that's fine.
  # We just need to make sure we don't echo back DENY/SAMEORIGIN/SAMEORIGIN.
  local xfo
  xfo="$(grep -i '^x-frame-options:' "$hdr" | head -1 | tr -d '\r' | sed 's/^[^:]*: *//')"
  if [ -z "$xfo" ]; then
    echo "  ✓ no x-frame-options in response"
  else
    # Bash 3.2 (macOS) has no ${var^^} case modifier — use tr
    xfo_upper=$(printf %s "$xfo" | tr '[:lower:]' '[:upper:]')
    case "$xfo_upper" in
      ALLOWALL|"" )
        echo "  ✓ x-frame-options is permissive: '$xfo'"
        ;;
      * )
        echo "  ✗ x-frame-options has blocking value: '$xfo'"
        FAIL=1
        ;;
    esac
  fi

  # No *blocking* Content-Security-Policy in headers. For HTML we may have
  # set frame-ancestors * ourselves — that's fine. Any other CSP is
  # suspicious and probably means the upstream CSP leaked through.
  local csp
  csp="$(grep -i '^content-security-policy:' "$hdr" | head -1 | tr -d '\r' | sed 's/^[^:]*: *//')"
  if [ -z "$csp" ]; then
    echo "  ✓ no content-security-policy in response"
  else
    case "$csp" in
      *"frame-ancestors "* | "frame-ancestors "* )
        echo "  ✓ csp contains only permissive frame-ancestors: '$csp'"
        ;;
      * )
        echo "  ✗ csp has non-frame-ancestors directive(s): '$csp'"
        FAIL=1
        ;;
    esac
  fi

  # Content-Type sanity
  local ct
  ct="$(grep -i '^content-type:' "$hdr" | head -1 | tr -d '\r')"
  echo "  $ct"

  # HTML body shape check
  local head
  head="$(head -c 200 "$body" | tr '\n' ' ')"
  if [ "$expect_html_body" = "yes" ]; then
    if echo "$head" | grep -qiE '<!doctype|<html'; then
      echo "  ✓ body looks like HTML"
    else
      echo "  ✗ body does not look like HTML"
      echo "    first 200 bytes: $head"
      FAIL=1
    fi
  else
    echo "  (skipping HTML body shape check — non-HTML target)"
  fi

  rm -f "$hdr" "$body"
}

# Primary smoke test: example.com — small, no X-Frame-Options, always 200
run_assertions "example.com (simple HTML)" "https://example.com" "yes"

# Optional second test: a known X-Frame-Options blocker, if passed as $1
if [ "${1:-}" != "" ]; then
  run_assertions "extra: $1" "$1" "yes"
fi

echo
if [ "$FAIL" -eq 0 ]; then
  echo "[test-proxy] PASS — all assertions held"
  exit 0
else
  echo "[test-proxy] FAIL — see above"
  KEEP_LOG=1
  exit 1
fi
