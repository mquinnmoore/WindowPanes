# WindowPanes

A local web server that turns any display into a full-screen, multi-pane dashboard. Configure a grid of panes showing websites, rotating URLs, local videos, video playlists, or YouTube streams — all from a single YAML file.

**First use case:** Arkab — Quinn's kitchen Mac Mini running Linux. 1×3 portrait display on the wall.

## Quick Start

```bash
# Install dependencies
npm install

# Edit config.yaml to match your setup, then:
./start.sh
```

This starts the server on port 3000 and opens Firefox in kiosk mode.

## Configuration

Edit `config.yaml` to define your layout and panes:

```yaml
layout:
  rows: 3
  columns: 1

panes:
  - type: video_playlist
    position: {row: 1, col: 1}
    videos:
      - /media/clips/clip_01.mkv
      - /media/clips/clip_02.mkv
    loop: true
    muted: true

  - type: website
    position: {row: 2, col: 1}
    url: https://weather.com/local

  - type: rotating_websites
    position: {row: 3, col: 1}
    urls:
      - https://news.ycombinator.com
      - https://reddit.com/r/starwars
    interval: 30
```

### Pane Types

| Type | Description | Key Fields |
|------|-------------|------------|
| `website` | Single website in an iframe | `url` |
| `rotating_websites` | Cycle through URLs on a timer | `urls`, `interval` (seconds, default 30), `order`, `proxy` |
| `video` | Single local video file | `src` or `file`, `muted`, `loop` |
| `video_playlist` | Play multiple videos in sequence or randomly | `videos`, `loop`, `muted`, `order` |
| `youtube` | YouTube video or stream embed | `url` (watch URL, embed URL, or video ID) |
| `novnc` | noVNC remote-desktop iframe (with `novnc_url`) | `novnc_url` |
| `proxied_website` | Like `website`, but goes through the server-side proxy so it bypasses `X-Frame-Options: DENY` and CSP `frame-ancestors`. For sites that block embedding (weather.com, reddit.com, nytimes.com). | `url` |
| `xscreensaver` | Linux-only. Runs an Xvfb display per pane and shows an XScreenSaver module (single module, cycle through a list, or play everything installed). See the dedicated section below. | `mode`, `modules`, `interval`, `width`, `height`, `display` |

#### Playback Order

Both `rotating_websites` and `video_playlist` support an `order` field:

- `sequential` (default) — plays items in the order listed
- `random` — picks a random next item (never repeats the same item twice in a row)

```yaml
- type: video_playlist
  videos: [...]
  order: random    # shuffle playback
```

#### `proxied_website` — When a plain `website` pane won't load

Some sites (`weather.com`, `reddit.com`, `nytimes.com`, many others) send
`X-Frame-Options: DENY` and/or `Content-Security-Policy: frame-ancestors 'none'`
to refuse to be embedded in any iframe. Firefox surfaces this as
*"This content cannot be displayed in a frame."*

`proxied_website` fetches the URL server-side, strips those headers, injects
a `<base href="…">` so relative URLs still resolve to the upstream origin,
and serves the result from the same origin as the dashboard. From Firefox's
point of view, the document is now same-origin as its parent — and the
removed headers mean the browser has no signal to refuse the frame.

```yaml
- type: proxied_website
  position: {row: 2, col: 1}
  url: https://weather.com/local
```

**Caveats & expectations:**

- **Heavy SPAs may still render broken.** Reddit, Google, Facebook, etc.
  detect iframe embedding via runtime `postMessage`/`window.parent` checks,
  cookies, or referrer-based restrictions. The proxy only defeats the
  *HTTP-header-level* refusal — script-level checks remain. If a site
  still blanks out, switch back to the plain `website` pane and accept the
  error, or open it in a separate browser window.
- **SSRF guard.** The proxy rejects URLs whose hostname resolves to a
  private/loopback IP (`127/8`, `10/8`, `172.16/12`, `192.168/16`,
  `169.254/16`, `::1`, `fc00::/7`, `fe80::/10`). Tailscale's `100.64/10`
  is allowed. Only `http:` and `https:` are accepted — `file:`, `data:`,
  `javascript:`, etc. are refused.
- **Optional allowlist.** Set `PROXY_ALLOWLIST=host1,host2` as an env var
  to restrict which upstream hostnames are proxied. Default: no allowlist.
- **Upstream timeout.** 10 s; returns HTTP 504 on overrun.

#### `rotating_websites` — proxying the whole cycle

If several sites in a `rotating_websites` list block iframes, the `proxy:
true` flag wraps every URL through the same `/api/proxy` route that
`proxied_website` uses. Each site in the cycle behaves like a
`proxied_website` pane; sites that don't need proxying are mixed in via
URL-level allowlists on the server (or just removed from the list).

```yaml
- type: rotating_websites
  position: {row: 3, col: 1}
  proxy: true
  urls:
    - https://weather.com/local
    - https://www.reddit.com/r/all/
    - https://trends.google.com/trends/hottrends/visualize
  interval: 30
  order: random
```

The pane gets the same corner badge as `proxied_website` so you can tell
at a glance which panes are routed through the server. If you'd rather
mix proxied and direct URLs in the same cycle, split them across two
panes — there is no per-URL proxy toggle.

#### YouTube TV

For YouTube TV, use the `website` pane type pointed at `https://tv.youtube.com`. Log in via Firefox on first launch; the session cookie persists across restarts.

```yaml
- type: website
  position: {row: 1, col: 1}
  url: https://tv.youtube.com
```

#### `xscreensaver` pane — Linux screensaver in a pane

A pane type that allocates its own Xvfb display, runs an XScreenSaver
module inside it, captures the framebuffer as JPEG every 250 ms, and
serves it at `GET /api/screensaver/<pane-id>.jpg`. The client polls this
URL with a cache-busting `?t=<epochMs>` query string. Each pane has its
own display (`:99`, `:100`, `:101`, …) so they don't interfere.

**Modes:**
- `single` — run one named module forever; `interval` is ignored.
- `list-sequential` — cycle modules in `modules:` in order, looping.
- `list-random` — pick from `modules:` randomly, never the same one twice in a row.
- `all-sequential` — enumerate *installed* modules; cycle in order.
- `all-random` — enumerate *installed* modules; random, no immediate repeats.

For `single` and the `list-*` modes, `modules` is required and must be
non-empty. For `all-*` modes, `modules` is ignored — the server enumerates
modules at pane-init time by scanning standard install paths
(`/usr/libexec/xscreensaver/`, `/usr/lib/xscreensaver/`, etc.).

```yaml
- type: xscreensaver
  position: {row: 1, col: 1}
  mode: list-random
  modules: [Qix, GLMatrix, Decays, Flurry, Carousel]
  interval: 45           # seconds before rotating to the next module
  width: 1280
  height: 720
  display: 99            # starting Xvfb display; auto-incremented per pane
```

**Hard requirements (host that runs the dashboard):**

| Tool | Purpose | Debian/Ubuntu apt package |
|------|---------|---------------------------|
| `Xvfb` | headless X server (one per pane) | `xvfb` |
| `ffmpeg` | capture framebuffer to JPEG | `ffmpeg` |
| `xscreensaver` | launcher + module finder | `xscreensaver` |
| Modules | `Qix`, `GLMatrix`, etc. | `xscreensaver-data`, `xscreensaver-data-extra`, `xscreensaver-gl` |

```bash
sudo apt install xvfb ffmpeg xscreensaver xscreensaver-data xscreensaver-data-extra xscreensaver-gl
```

`xwd` from `x11-apps` is a fallback capture option but the shipped
implementation uses `ffmpeg` exclusively. (`xwd` output is XWD-format,
not JPEG, so would need a converter. Sticking with ffmpeg keeps the
single-bin path simple.)

**Launch strategy (chosen):** the per-pane lifecycle spawns
`xscreensaver -root -no-splash -module <name>` (the launcher in
non-daemon mode) into `DISPLAY=:<N>`. If the launcher isn't found, it
falls back to spawning the module binary directly out of the module
directory (e.g. `/usr/libexec/xscreensaver/<ModuleName> -root`). This
avoids running the full `xscreensaver` *daemon* — running the daemon
inside an Xvfb-on-the-side pane would conflict with the host's real
screensaver (lock screen, race for `:0`) and risks locking the host
display when the dashboard shuts down.

**Behavior summary:**
- Each `xscreensaver` pane owns one Xvfb display (`:N`, unique per pane)
  and one running module process. Modules swap on a configurable
  `interval` (skip for `single`).
- Frame capture runs at 250 ms cadence via `ffmpeg -f x11grab` writing to
  `/tmp/windowpanes-screensaver/<pane-id>.jpg`. Override with
  `SCREENSAVER_FRAME_DIR`.
- The server tears down all Xvfb + module + ffmpeg children on
  `SIGTERM`/`SIGINT`, so `Esc`/`Ctrl+Q` shutdown via `start.sh` doesn't
  leak displays.

**Known limits:**
- **GLX modules are slow under Xvfb** — software GL has no hardware
  acceleration. GL-heavy modules (`GLMatrix`, `Lattice`, `Hexstrut`…)
  may drop frames; non-GL modules (`Qix`, `Decays`, `Flurry`) run at
  near-full speed.
- **Module startup jitter.** When a new module is spawned into a fresh
  Xvfb, expect ~1–2 s of blank/old frame before the new content appears.
- **No `xscreensaver` lock.** Running the daemon would cause the host's
  real lock screen to engage; the launcher-style spawn above sidesteps
  that, but it also means `xscreensaver`'s demo mode / configuration
  tooling does not work against these displays.
- **`xvfb` + GLX test build only.** Not all module binaries work under
  Xvfb. If a module crashes immediately, remove it from `modules:` (for
  `*-list-*` modes) or filter the auto-enumeration (use `list-random`
  with an explicit allowlist instead of `all-random`).

### Layout

- `layout.rows` / `layout.columns` — defines the grid dimensions
- Each pane has `position: {row: N, col: N}` (1-indexed)

### Video Paths

Video file paths in the config should be absolute paths on the host filesystem. The server mounts a media directory at `/media`. Set the `MEDIA_DIR` environment variable to point to the root of your media files.

For example, if `MEDIA_DIR=/mnt/storage` and your config has:
```yaml
videos:
  - /media/clips/saber_01.mkv
```
The server will serve `/mnt/storage/clips/saber_01.mkv`.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `CONFIG` | `./config.yaml` | Path to config file |
| `MEDIA_DIR` | `/media` | Root directory for media files |
| `PROXY_ALLOWLIST` | _(none)_ | Comma-separated hostnames allowed by `/api/proxy` (e.g. `weather.com,reddit.com`). If unset, anything not blocked by the SSRF guard is allowed. |
| `SCREENSAVER_FRAME_DIR` | `/tmp/windowpanes-screensaver` | Where `xscreensaver` panes write JPEG frames. Override if `/tmp` is too small / on tmpfs without enough space. |

## Running Without Kiosk Mode

If you just want the server (no Firefox):

```bash
npm start
# Then open http://localhost:3000 in any browser
```

## Architecture

```
Browser (Firefox kiosk)
  └── GET / → index.html
  └── GET /api/config → config.yaml as JSON
  └── GET /media/... → video files from MEDIA_DIR
```

- **server.js** — Express server: serves static files, config API, and media
- **public/app.js** — Fetches config, builds CSS Grid, renders each pane type
- **public/styles.css** — Zero-chrome fullscreen layout
- **config.yaml** — Dashboard configuration
- **start.sh** — Launches server + Firefox kiosk

## Requirements

- Node.js 18+
- Firefox (for kiosk mode)
- Video files accessible on the local filesystem
- For `xscreensaver` panes (Linux only): `xvfb`, `ffmpeg`, `xscreensaver`,
  `xscreensaver-data`, `xscreensaver-data-extra`, `xscreensaver-gl` — see
  the `xscreensaver` pane section above for the full list and rationale.
