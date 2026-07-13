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
#   MONITOR=HDMI-0 ./start.sh          # pin kiosk to one monitor (X11 + xrandr)
#
# MONITOR:
#   Names the xrandr output (e.g. HDMI-0, DP-1, eDP-1) that the Firefox
#   kiosk should fully fill. Requires xrandr + an X11 session. The other
#   monitors stay enabled — they're just not claimed by the kiosk window.
#   On Wayland, GNOME/KDE without xrandr, or any non-X11 setup, the flag
#   is silently ignored and the kiosk opens on the primary display.
#
set -euo pipefail

PORT="${PORT:-3000}"
CONFIG="${CONFIG:-$(dirname "$0")/config.yaml}"
MEDIA_DIR="${MEDIA_DIR:-/media}"
MONITOR="${MONITOR:-}"

export PORT CONFIG MEDIA_DIR

# ── Pre-flight dependency check ──────────────────────────────────────
# Runs before any side effects (Node server, Firefox window). Collects
# hard errors (abort startup) and soft warnings (continue with note)
# so the operator sees a clear, actionable report instead of a stack
# trace 2 s into launch.
#
# Hard requirements:  node, firefox (or firefox-esr), node_modules/ with
#                     express + js-yaml, the config file existing.
# Soft requirements:  xrandr + xdotool only needed if MONITOR is set.
#                     xscreensaver tooling only needed if config has any
#                     `type: xscreensaver` pane.
#
# On Wayland / macOS / headless boxes some checks are skipped (not
# applicable). Skipped checks are reported as `⊘` so the operator
# knows they were considered and dismissed, not missed.
declare -a _PF_ERRORS=()
declare -a _PF_WARNINGS=()

_pf_pass() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
_pf_warn() { printf '  \033[33m⚠\033[0m %s\n' "$1"; _PF_WARNINGS+=("$1"); }
_pf_fail() { printf '  \033[31m✗\033[0m %s\n' "$1"; _PF_ERRORS+=("$1"); }
_pf_skip() { printf '  \033[90m⊘\033[0m %s\n' "$1"; }

# Detect platform once. Linux + DISPLAY set = X11 kiosk host. Wayland
# is detected from WAYLAND_DISPLAY. macOS has no X11, so all x11-only
# checks get a skip.
_IS_LINUX=0
_IS_X11=0
_IS_WAYLAND=0
case "$(uname -s 2>/dev/null)" in
  Linux)
    _IS_LINUX=1
    [ -n "${WAYLAND_DISPLAY:-}" ] && _IS_WAYLAND=1
    [ -n "${DISPLAY:-}" ] && _IS_X11=1
    ;;
esac

# 1. Node.js (hard)
if command -v node >/dev/null; then
  _pf_pass "node $(node --version 2>/dev/null | tr -d '\n')"
else
  _pf_fail "node not found on PATH (install Node.js 18+ to run server.js)"
fi

# 2. Firefox (hard — required for kiosk mode)
if command -v firefox >/dev/null; then
  _pf_pass "firefox"
elif command -v firefox-esr >/dev/null; then
  _pf_pass "firefox-esr"
elif [ "$(uname -s 2>/dev/null)" = "Darwin" ]; then
  _pf_fail "Firefox not found. macOS dev mode is fine — open http://localhost:${PORT} in your browser manually."
else
  _pf_fail "firefox (or firefox-esr) not found. On Debian/Ubuntu: sudo apt install firefox"
fi

# 3. Node module deps (hard). Cheap check: does node_modules/ exist and
# contain the top-level packages package.json declares? Cheaper than
# spawning node just to learn the require failed.
_NEED_NPM_INSTALL=0
if [ ! -d "$(dirname "$0")/node_modules" ]; then
  _NEED_NPM_INSTALL=1
elif [ ! -d "$(dirname "$0")/node_modules/express" ] || \
     [ ! -d "$(dirname "$0")/node_modules/js-yaml" ]; then
  _NEED_NPM_INSTALL=1
fi
if [ "$_NEED_NPM_INSTALL" -eq 1 ]; then
  _pf_fail "node_modules missing or incomplete — run \`npm install\` in $(dirname "$0")"
else
  _pf_pass "node_modules installed (express, js-yaml)"
fi

# 4. Config file (hard). Resolve CONFIG to an absolute path if it was
# given relative, so the existence check matches how Node will load it.
if [ -f "$CONFIG" ]; then
  _pf_pass "config: $CONFIG"
elif [ -f "$(dirname "$0")/$CONFIG" ]; then
  _pf_pass "config: $(dirname "$0")/$CONFIG (resolved relative to script)"
else
  _pf_fail "config file not found: $CONFIG (and not at \$(dirname \$0)/$CONFIG either)"
fi

# 5. xrandr + xdotool — only required when MONITOR is set.
if [ -n "$MONITOR" ]; then
  if [ "$_IS_LINUX" -eq 0 ]; then
    _pf_skip "MONITOR set but host is not Linux; flag will be ignored"
  elif [ "$_IS_WAYLAND" -eq 1 ] && [ "$_IS_X11" -eq 0 ]; then
    _pf_skip "MONITOR set but session is Wayland-only (no DISPLAY); flag will be ignored"
  else
    if command -v xrandr >/dev/null; then
      _pf_pass "xrandr $(xrandr --version 2>/dev/null | head -1 | awk '{print $NF}')"
    else
      _pf_fail "MONITOR=${MONITOR} requested but xrandr not installed. On Debian/Ubuntu: sudo apt install xrandr"
    fi
    if command -v xdotool >/dev/null; then
      _pf_pass "xdotool $(xdotool version 2>/dev/null)"
    else
      _pf_fail "MONITOR=${MONITOR} requested but xdotool not installed. On Debian/Ubuntu: sudo apt install xdotool"
    fi
  fi
fi

# 6. xscreensaver pane deps — only if the config has any of those panes.
# Parse the config (best-effort) with a tiny Node one-liner; skip the
# check entirely if parsing fails (the real server will report it
# loudly later anyway).
if [ -f "$CONFIG" ]; then
  _HAS_XSS=0
  if command -v node >/dev/null; then
    _HAS_XSS=$(node -e "try{const y=require('js-yaml');const fs=require('fs');const c=y.load(fs.readFileSync(process.argv[1],'utf8'));process.stdout.write(String(((c&&c.panes)||[]).some(p=>p&&p.type==='xscreensaver')));}catch(e){process.stdout.write('0');}" "$CONFIG" 2>/dev/null || echo 0)
  fi
  if [ "$_HAS_XSS" = "true" ]; then
    for tool in xvfb ffmpeg xscreensaver; do
      if command -v "$tool" >/dev/null; then
        _pf_pass "$tool (required by xscreensaver pane)"
      else
        _pf_warn "$tool not installed (required by xscreensaver pane). On Debian/Ubuntu: sudo apt install xvfb ffmpeg xscreensaver xscreensaver-data xscreensaver-data-extra xscreensaver-gl"
      fi
    done
  fi
fi

# 7. Optional / nice-to-have. These never block startup.
if [ "$_IS_LINUX" -eq 1 ] && [ "$_IS_X11" -eq 0 ] && [ "$_IS_WAYLAND" -eq 0 ]; then
  _pf_skip "no DISPLAY or WAYLAND_DISPLAY set; running headless (Ctrl+C is the shutdown path)"
fi

# Render the summary and decide whether to proceed.
echo
if [ ${#_PF_ERRORS[@]} -gt 0 ]; then
  printf '\033[31m[start.sh] Pre-flight failed:\033[0m %d hard error(s), %d warning(s)\n' "${#_PF_ERRORS[@]}" "${#_PF_WARNINGS[@]}"
  printf '  Fix the hard errors above and re-run.\n'
  printf '  Package install hint:\n'
  printf '    Debian/Ubuntu:  sudo apt install nodejs firefox xrandr xdotool xvfb ffmpeg xscreensaver xscreensaver-data xscreensaver-data-extra xscreensaver-gl\n'
  printf '    Then:           cd %s && npm install\n' "$(dirname "$0")"
  exit 1
fi
if [ ${#_PF_WARNINGS[@]} -gt 0 ]; then
  printf '\033[33m[start.sh] Pre-flight OK with %d warning(s) — continuing:\033[0m\n' "${#_PF_WARNINGS[@]}"
else
  printf '\033[32m[start.sh] Pre-flight OK.\033[0m\n'
fi

# Resolve target monitor geometry up front so the helper below can use it.
# `xrandr --query` line format: "<output> connected <width>x<height>+<x>+<y> ..."
# We capture the connected output whose name matches $MONITOR, parse the
# geometry out, and export it as MONITOR_GEOM="W H X Y" for the panner.
MONITOR_GEOM=""
if [ -n "$MONITOR" ]; then
  if command -v xrandr >/dev/null && [ -n "${DISPLAY:-}" ]; then
    line="$(xrandr --query 2>/dev/null | awk -v m="$MONITOR" '$1==m && $2=="connected"{print; exit}')"
    if [ -n "$line" ]; then
      # First WxH+OFFSET token, e.g. "1920x1080+1920+0"
      geom="$(echo "$line" | grep -oE '[0-9]+x[0-9]+\+[0-9]+\+[0-9]+' | head -1)"
      if [ -n "$geom" ]; then
        # Parse "WxH+X+Y" into four space-separated fields.
        # The previous approach (${geom%x*}) only captured W; awk is cleaner.
        _W=$(echo "$geom" | awk -Fx '{print $1}')
        _H=$(echo "$geom" | awk -Fx '{print $2}' | awk -F+ '{print $1}')
        _X=$(echo "$geom" | awk -F+ '{print $2}')
        _Y=$(echo "$geom" | awk -F+ '{print $3}')
        MONITOR_GEOM="$_W $_H $_X $_Y"
        echo "  Monitor:   $MONITOR (${_W}x${_H}+${_X}+${_Y})"
      else
        echo "[start.sh] MONITOR=$MONITOR is connected but xrandr returned no geometry; falling back to primary display"
      fi
    else
      echo "[start.sh] MONITOR=$MONITOR not found by xrandr; falling back to primary display"
    fi
  else
    echo "[start.sh] MONITOR is set but xrandr or DISPLAY is unavailable; falling back to primary display"
  fi
fi
export MONITOR_GEOM

echo "Starting WindowPanes..."
echo "  Port:      $PORT"
echo "  Config:    $CONFIG"
echo "  Media dir: $MEDIA_DIR"
[ -n "$MONITOR" ] && [ -z "$MONITOR_GEOM" ] && echo "  Monitor:   $MONITOR (resolution not resolved — kiosk will open on primary)"

# Start the Node server in the background
node "$(dirname "$0")/server.js" &
SERVER_PID=$!

# Give the server a moment to start
sleep 2

# Open Firefox in kiosk mode
URL="http://localhost:${PORT}"
echo "Opening Firefox kiosk at $URL"

FIREFOX_PID=""
FIREFOX_BIN=""
if command -v firefox &>/dev/null; then
  FIREFOX_BIN="firefox"
elif command -v firefox-esr &>/dev/null; then
  FIREFOX_BIN="firefox-esr"
fi

if [ -n "$FIREFOX_BIN" ]; then
  # --new-instance forces a fresh Firefox process even when the default
  # profile is already in use by another running Firefox session. Without
  # it, `firefox --kiosk $URL` hands the URL to the running instance,
  # which loads it as a regular tab in that window instead of opening a
  # kiosk on the display.
  "$FIREFOX_BIN" --kiosk --new-instance "$URL" &
  FIREFOX_PID=$!
else
  echo "Firefox not found. Open $URL manually in a browser."
fi

# If MONITOR is set and we have xdotool + a fresh Firefox PID, move/resize
# the kiosk window onto the target monitor after a short settle delay.
# Firefox's --kiosk flag claims the primary display by default; wmctrl-
# style geometry override via xdotool is the portable X11 escape hatch.
# We do this in the background so start.sh keeps watching the server.
if [ -n "$MONITOR_GEOM" ] && [ -n "$FIREFOX_PID" ] && command -v xdotool >/dev/null && [ -n "${DISPLAY:-}" ]; then
  (
    sleep 2  # let Firefox's window come up before we try to grab it
    # W and H are the first two whitespace-separated fields of MONITOR_GEOM
    # (formatted "W H" — see parsing above). Anything else (empty, malformed)
    # bails out without touching the window.
    W="$(echo "$MONITOR_GEOM" | awk '{print $1}')"
    H="$(echo "$MONITOR_GEOM" | awk '{print $2}')"
    X="$(echo "$MONITOR_GEOM" | awk '{print $3}')"
    Y="$(echo "$MONITOR_GEOM" | awk '{print $4}')"
    if [ -n "$W" ] && [ -n "$H" ]; then
      # X/Y default to 0 if the monitor is the leftmost (offset not parsed)
      : "${X:=0}" "${Y:=0}"
      # waituntil makes xdotool retry until Firefox's window exists, with a
      # hard 10s ceiling in case something else is slow.
      if xdotool search --sync --onlyvisible --class "firefox" windowunmap \
            windowmap 2>/dev/null; then :; fi
      WID="$(xdotool search --onlyvisible --class "firefox" 2>/dev/null | head -1 || true)"
      if [ -n "$WID" ]; then
        xdotool windowmove "$WID" "$X" "$Y" 2>/dev/null || true
        xdotool windowsize "$WID" "$W" "$H" 2>/dev/null || true
        xdotool windowraise "$WID" 2>/dev/null || true
        echo "[start.sh] kiosk window pinned to $MONITOR (${W}x${H}+${X}+${Y})"
      fi
    fi
  ) &
  disown 2>/dev/null || true
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

  # `waitforkey` was removed in xdotool 3.x (Ubuntu 24.04 ships 3.20160805).
  # Check for it before spawning watchers; fall back silently if absent.
  if ! xdotool waitforkey --help >/dev/null 2>&1 && \
     ! xdotool help 2>&1 | grep -q 'waitforkey'; then
    echo "[start.sh] xdotool installed but 'waitforkey' not available ($(xdotool version 2>/dev/null || echo 'unknown version')); skipping key watcher (use Ctrl+C in this terminal)"
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
