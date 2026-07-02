/**
 * WindowPanes v1 — Client-side pane renderer
 *
 * Fetches config from /api/config and builds the CSS Grid dashboard.
 * Supports: website, rotating_websites, video, video_playlist, youtube
 */

(async function () {
  'use strict';

  const grid = document.getElementById('grid');

  let config;
  try {
    const res = await fetch('/api/config');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    config = await res.json();
  } catch (err) {
    grid.innerHTML = `<div class="pane"><div class="pane-error">Failed to load config: ${err.message}</div></div>`;
    return;
  }

  const { layout, panes } = config;
  const rows = layout.rows || 1;
  const cols = layout.columns || 1;

  // Set up CSS Grid
  grid.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
  grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;

  // Build each pane
  for (const [i, pane] of panes.entries()) {
    const el = document.createElement('div');
    el.className = 'pane';

    // Position on grid
    const row = pane.position?.row || 1;
    const col = pane.position?.col || 1;
    el.style.gridRow = row;
    el.style.gridColumn = col;

    // Stable id — server uses the same scheme (`pane-${i}` keyed by index
    // in config.panes). Used for /api/screensaver/<id>.jpg lookups.
    const paneId = `pane-${i}`;

    try {
      switch (pane.type) {
        case 'website':
          renderWebsite(el, pane);
          break;
        case 'rotating_websites':
          renderRotatingWebsites(el, pane);
          break;
        case 'video':
          renderVideo(el, pane);
          break;
        case 'video_playlist':
          renderVideoPlaylist(el, pane);
          break;
        case 'youtube':
          renderYouTube(el, pane);
          break;
        case 'novnc':
          renderNoVNC(el, pane);
          break;
        case 'proxied_website':
          renderProxiedWebsite(el, pane);
          break;
        case 'xscreensaver':
          renderXscreensaver(el, pane, paneId);
          break;
        default:
          el.innerHTML = `<div class="pane-error">Unknown pane type: ${pane.type}</div>`;
      }
    } catch (err) {
      el.innerHTML = `<div class="pane-error">Error: ${err.message}</div>`;
    }

    grid.appendChild(el);
  }

  // ── Pane renderers ──────────────────────────────────────────

  /**
   * Single website — iframe
   */
  function renderWebsite(el, pane) {
    const iframe = document.createElement('iframe');
    iframe.src = resolveSrc(pane, pane.url);
    iframe.setAttribute('loading', 'lazy');
    iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups');
    if (pane.proxy) el.classList.add('proxied');
    el.appendChild(iframe);
  }

  /**
   * Rotating websites — cycle iframes on a timer
   * order: 'sequential' (default) or 'random'
   * proxy: true (optional) — wrap each URL through the server-side proxy so
   *   sites that send X-Frame-Options: DENY or CSP frame-ancestors still load
   */
  function renderRotatingWebsites(el, pane) {
    const urls = pane.urls || [];
    if (urls.length === 0) {
      el.innerHTML = '<div class="pane-error">No URLs configured</div>';
      return;
    }

    const iframe = document.createElement('iframe');
    iframe.setAttribute('loading', 'lazy');
    iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups');
    if (pane.proxy) el.classList.add('proxied');
    el.appendChild(iframe);

    const isRandom = pane.order === 'random';
    let index = isRandom ? randomInt(urls.length) : 0;
    const interval = (pane.interval || 30) * 1000;

    function showNext() {
      iframe.src = resolveSrc(pane, urls[index]);
      if (isRandom) {
        index = randomIntExcluding(urls.length, index);
      } else {
        index = (index + 1) % urls.length;
      }
    }

    showNext();
    setInterval(showNext, interval);
  }

  /**
   * Single local video — HTML5 video element
   */
  function renderVideo(el, pane) {
    const video = document.createElement('video');
    // Convert absolute file path to server media URL
    video.src = toMediaUrl(pane.src || pane.file);
    video.autoplay = true;
    video.muted = pane.muted !== false; // muted by default
    video.loop = pane.loop !== false;   // loop by default
    video.playsInline = true;
    video.setAttribute('preload', 'auto');
    el.appendChild(video);
  }

  /**
   * Video playlist — play multiple videos in sequence or random order
   * order: 'sequential' (default) or 'random'
   */
  function renderVideoPlaylist(el, pane) {
    const videos = pane.videos || [];
    if (videos.length === 0) {
      el.innerHTML = '<div class="pane-error">No videos configured</div>';
      return;
    }

    const video = document.createElement('video');
    video.autoplay = true;
    video.muted = pane.muted !== false;
    video.playsInline = true;
    video.setAttribute('preload', 'auto');
    el.appendChild(video);

    const isRandom = pane.order === 'random';
    let index = isRandom ? randomInt(videos.length) : 0;
    const shouldLoop = pane.loop !== false;

    function playNext() {
      video.src = toMediaUrl(videos[index]);
      video.play().catch(() => {}); // autoplay may require muted
    }

    function advance() {
      if (isRandom) {
        index = randomIntExcluding(videos.length, index);
      } else {
        index++;
        if (index >= videos.length) {
          if (shouldLoop) {
            index = 0;
          } else {
            return false; // done
          }
        }
      }
      return true;
    }

    video.addEventListener('ended', () => {
      if (advance()) playNext();
    });

    video.addEventListener('error', () => {
      console.warn('Video error, skipping:', videos[index]);
      if (advance()) setTimeout(playNext, 1000);
    });

    playNext();
  }

  /**
   * YouTube / YouTube TV embed
   */
  function renderYouTube(el, pane) {
    const iframe = document.createElement('iframe');
    iframe.className = 'youtube-embed';

    // Accept a direct embed URL or a video/channel ID
    let url = pane.url || '';
    if (!url.includes('youtube.com') && !url.includes('youtu.be')) {
      // Assume it's a video ID
      url = `https://www.youtube.com/embed/${url}?autoplay=1&mute=1`;
    } else if (url.includes('watch?v=')) {
      // Convert watch URL to embed
      const videoId = new URL(url).searchParams.get('v');
      url = `https://www.youtube.com/embed/${videoId}?autoplay=1&mute=1`;
    } else if (!url.includes('/embed/')) {
      // For YouTube TV or other URLs, use as-is in iframe
    }

    iframe.src = url;
    iframe.setAttribute('allow', 'autoplay; encrypted-media; picture-in-picture');
    iframe.setAttribute('allowfullscreen', '');
    el.appendChild(iframe);
  }

  /**
   * Proxied website — iframe that points at our /api/proxy endpoint,
   * which fetches the upstream server-side and strips X-Frame-Options /
   * CSP frame-ancestors. Used for sites like weather.com, reddit.com,
   * nytimes.com that block embedding otherwise.
   *
   * The 'proxied' class lets styles.css draw a small badge so the user
   * can tell at a glance this pane is going through the proxy.
   */
  function renderProxiedWebsite(el, pane) {
    if (!pane.url) {
      el.innerHTML = '<div class="pane-error">proxied_website pane requires url</div>';
      return;
    }
    const iframe = document.createElement('iframe');
    iframe.src = resolveSrc({ proxy: true }, pane.url);
    iframe.setAttribute('loading', 'lazy');
    iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups');
    el.classList.add('proxied');
    el.appendChild(iframe);
  }

  /**
   * noVNC remote desktop pane — embeds a noVNC web client pointing at a
   * local websockify proxy that bridges to a VNC server.
   *
   * Required: novnc_url — full URL to the noVNC vnc.html endpoint with
   *           query params (host, port, autoconnect, password, resize)
   *
   * Example config.yaml entry:
   *   - type: novnc
   *     novnc_url: "http://localhost:6080/vnc.html?host=localhost&port=6080&autoconnect=true&resize=scale&password=YOURPASSWORD"
   *
   * The iframe allows popups + forms so the noVNC toolbar works correctly.
   * The sandbox deliberately omits allow-same-origin to avoid cross-origin
   * elevation, but noVNC only needs allow-scripts to function.
   */
  function renderNoVNC(el, pane) {
    if (!pane.novnc_url) {
      el.innerHTML = '<div class="pane-error">novnc pane requires novnc_url</div>';
      return;
    }
    const iframe = document.createElement('iframe');
    iframe.src = pane.novnc_url;
    iframe.setAttribute('loading', 'lazy');
    // noVNC needs scripts; forms + popups for its toolbar/clipboard support
    iframe.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups allow-modals');
    iframe.setAttribute('allow', 'clipboard-read; clipboard-write');
    el.appendChild(iframe);
  }

  /**
   * xscreensaver pane — renders an <img> that polls the server-side
   * screensaver frame endpoint at ~250ms. The server (server.js) runs an
   * Xvfb per pane, spawns a screensaver module into it, and continuously
   * captures the framebuffer to JPEG. We just refresh the <img> src with
   * a cache-busting query string.
   *
   * paneId is the server-side id assigned by index in config.panes
   * (`pane-N`), which the server uses to identify the running Xvfb.
   *
   * Error handling:
   *   - Initial fetch probes the endpoint; if the server returns 503 with a
   *     structured JSON error body (e.g. `{reason: 'ffmpeg-missing'}`) we
   *     surface that reason to the user via the `.pane-error` overlay and
   *     stop polling.
   *   - After the initial probe succeeds, the <img> polling path takes
   *     over. If frames go bad later (Xvfb died, display unreachable),
   *     3 consecutive <img> errors switch the pane to the error overlay.
   */
  function renderXscreensaver(el, pane, paneId) {
    if (!paneId) {
      el.innerHTML = '<div class="pane-error">xscreensaver pane missing paneId</div>';
      return;
    }

    let consecutiveErrors = 0;
    let stopped = false;
    const ERROR_THRESHOLD = 3;
    const POLL_MS = 250;

    function showError(msg) {
      stopped = true;
      while (el.firstChild) el.removeChild(el.firstChild);
      const err = document.createElement('div');
      err.className = 'pane-error';
      err.textContent = msg;
      el.appendChild(err);
    }

    function startPolling() {
      const img = document.createElement('img');
      img.className = 'screensaver-frame';
      img.alt = '';
      el.appendChild(img);

      img.addEventListener('load', () => {
        consecutiveErrors = 0;
      });
      img.addEventListener('error', () => {
        consecutiveErrors++;
        if (consecutiveErrors >= ERROR_THRESHOLD) {
          showError(`xscreensaver pane unavailable (${consecutiveErrors} failed loads)`);
        }
      });

      function refresh() {
        if (stopped) return;
        img.src = `/api/screensaver/${paneId}.jpg?t=${Date.now()}`;
      }
      refresh();
      setInterval(refresh, POLL_MS);
    }

    // Map server-side reason codes to user-facing messages. Keep these
    // short — they're rendered in a tight pane slot.
    const REASON_HUMAN = {
      // missing-deps
      'xvfb-missing':         'XScreenSaver: xvfb not installed — `sudo apt install xvfb`',
      'ffmpeg-missing':       'XScreenSaver: ffmpeg not installed — `sudo apt install ffmpeg`',
      'xscreensaver-missing': 'XScreenSaver: xscreensaver not installed — `sudo apt install xscreensaver xscreensaver-data xscreensaver-gl`',
      // xvfb lifecycle
      'xvfb-spawn-failed':    'XScreenSaver: failed to start Xvfb (check display number)',
      'xvfb-not-ready':       'XScreenSaver: Xvfb did not become ready in time',
      'xvfb-died':            'XScreenSaver: Xvfb display died',
      // config issues
      'invalid-mode':         'XScreenSaver: invalid `mode` (use: single, list-sequential, list-random, all-sequential, all-random)',
      'empty-modules':        'XScreenSaver: no modules configured (set `modules:` for single or list-* modes)',
      'no-installed-modules': 'XScreenSaver: no installed XScreenSaver modules found (apt install xscreensaver-data xscreensaver-gl)',
      // transient
      'frame-not-ready':      'XScreenSaver: capturing first frame…',
    };

    // Initial probe — gives us the JSON error body so we can render a
    // useful message instead of just "unavailable".
    fetch(`/api/screensaver/${paneId}.jpg`)
      .then((res) => {
        if (res.ok) {
          startPolling();
          return;
        }
        // Try to parse the JSON error body for a specific reason.
        res.json().then((body) => {
          const reason = (body && body.reason) || 'unknown';
          const human = REASON_HUMAN[reason] || `XScreenSaver: pane disabled (reason: ${reason})`;
          showError(human);
        }).catch(() => {
          showError(`XScreenSaver: pane disabled (HTTP ${res.status})`);
        });
      })
      .catch(() => {
        // Network error — fall back to img polling and let its error handler deal with it
        startPolling();
      });
  }

  // ── Helpers ─────────────────────────────────────────────────

  /**
   * Random int [0, max)
   */
  function randomInt(max) {
    return Math.floor(Math.random() * max);
  }

  /**
   * Random int [0, max) excluding a specific value (avoids repeats).
   * Falls back to same value if max <= 1.
   */
  function randomIntExcluding(max, exclude) {
    if (max <= 1) return 0;
    let n;
    do {
      n = randomInt(max);
    } while (n === exclude);
    return n;
  }

  /**
   * Convert an absolute file path to a /media/... URL.
   * The server mounts MEDIA_DIR at /media, so we strip the MEDIA_DIR prefix.
   * If the path already starts with /media/, use as-is.
   */
  function toMediaUrl(filePath) {
    if (!filePath) return '';
    if (filePath.startsWith('/media/')) {
      // Already a URL path — use directly
      return filePath;
    }
    // Assume it's an absolute path under the media directory;
    // the server serves MEDIA_DIR at /media, so just prepend /media
    // and let the user ensure paths are relative to MEDIA_DIR.
    return '/media/' + filePath.replace(/^\/+/, '');
  }

  /**
   * Resolve an iframe src URL. If the pane has `proxy: true`, route the
   * URL through the server-side /api/proxy endpoint (defeats X-Frame-Options
   * and CSP frame-ancestors). Otherwise returns the URL as-is.
   *
   * Returns an empty string for null/undefined URL.
   */
  function resolveSrc(pane, url) {
    if (!url) return '';
    if (pane && pane.proxy) {
      return `/api/proxy?url=${encodeURIComponent(url)}`;
    }
    return url;
  }

})();
