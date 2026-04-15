# WindowPanes

A local web server that turns any display into a full-screen, multi-pane dashboard. Configure a grid of panes showing websites, rotating URLs, local videos, video playlists, or YouTube streams — all from a single YAML file.

**First use case:** Kitchen portrait display (1×3 grid) on a Mac Mini running Lubuntu.

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
| `rotating_websites` | Cycle through URLs on a timer | `urls`, `interval` (seconds, default 30) |
| `video` | Single local video file | `src` or `file`, `muted`, `loop` |
| `video_playlist` | Play multiple videos in sequence | `videos`, `loop`, `muted` |
| `youtube` | YouTube video or stream embed | `url` (watch URL, embed URL, or video ID) |

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
