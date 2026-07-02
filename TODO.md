# TODO — WindowPanes

## Pending

### Linux screensaver pane (Quinn, 2026-06-27 18:52 EDT — refined 2026-07-02 12:28 EDT)

**Goal:** mimic XScreenSaver behavior inside a WindowPanes pane. Run screensaver modules either one at a time, sequentially from a list, randomized from a list, sequentially through all installed, or randomized through all installed.

**Five modes to support:**
1. **single** — run one specific named module indefinitely
2. **list-sequential** — cycle through a configured list of module names in order, looping
3. **list-random** — pick randomly from a configured list (no immediate repeats)
4. **all-sequential** — enumerate installed modules, play them in order, loop
5. **all-random** — enumerate installed modules, play in randomized order (no immediate repeats)

**Likely implementation — Xvfb + per-pane subprocess:**
- Each pane spawns `XscreensaverApp` (or `-module <name>`) into a dedicated Xvfb display (`Xvfb :N +extension GLX +render -screen 0 1280x720x24`)
- Capture the Xvfb framebuffer to PNG via `xwd` or `ffmpeg -f x11grab`, then push to the pane via either:
  - (a) `<canvas>` + `setInterval` drawing the PNG (simple, ~1-3 fps)
  - (b) `<img>` with rotating `src` URLs of PNG frames (faster but cache-noisy)
  - (c) MJPEG stream via ffmpeg → pane's `video_playlist` mechanism (smooth, but ffmpeg adds CPU)
- For GLX modules (most xscreensaver hacks use GL), the Xvfb needs `+extension GLX +render` and ideally `+extension RANDR`. Pure software GL is slow but workable.
- **Simplest v1:** use `<img>` with PNG captures every ~500ms; ship without MJPEG. Optimize later if visual jank is unacceptable on Arkab.

**YAML config sketch (proposed — not yet agreed):**
```yaml
- type: xscreensaver
  position: {row: 2, col: 1}
  mode: list-random            # single | list-sequential | list-random | all-sequential | all-random
  modules: [Qix, GLMatrix, Decays]   # required for *-list-* modes; ignored otherwise
  interval: 30                 # seconds per module (only meaningful for cycling modes)
  width: 1280
  height: 720
```

**Open questions for Quinn:**
- Resolution per pane? (Arkab's portrait may want a non-standard aspect)
- Frame rate? (1 Hz is fine for most modules, GL ones want >15 to look smooth)
- Disable xscreensaver's lock screen? (the actual `xscreensar-command` lock must NOT trigger inside a pane — running an unlocked module is fine, full daemon interferes)
- Module `interval` units — seconds or matched to xscreensaver's own timing?

**Files this would touch:** `server.js` (spawn/kill subprocess + capture endpoint), `public/app.js` (new `renderXscreensaver`), `start.sh` (optional: launch a tiny supervisor if any pane is xscreensaver), `config.yaml`, `README.md`.

**Do not start until Quinn gives the go-ahead.** He explicitly said "let's try the proxy fix first" on 2026-07-02.

## Done
- 2026-07-02 — `xscreensaver` pane type added: 5 modes (single, list-sequential, list-random, all-sequential, all-random). Xvfb-per-pane, ffmpeg x11grab capture to JPEG at 250 ms, server endpoint `/api/screensaver/<id>.jpg`, client renderer with cache-busting poll + 3-strike error overlay. Pure-logic helpers in `xscreensaver-logic.js`, tested via `node test-xscreensaver-logic.js` (49 assertions, all passing). SIGTERM cleans up child Xvfb + screensaver + ffmpeg processes. Local, uncommitted.
- 2026-07-02 — `start.sh` Esc/Ctrl+Q full shutdown hotkeys (local, uncommitted). xdotool-based key watcher, graceful no-op if xdotool not installed.
- 2026-05-27 — Added `novnc` pane type + systemd unit + setup doc (pushed to mquinnmoore/WindowPanes)
