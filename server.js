const express = require('express');
const path = require('path');
const fs = require('fs');
const dns = require('dns');
const yaml = require('js-yaml');
const { spawn } = require('child_process');

const logic = require('./xscreensaver-logic');

const app = express();
const PORT = process.env.PORT || 3000;
const CONFIG_PATH = process.env.CONFIG || path.join(__dirname, 'config.yaml');
const MEDIA_DIR = process.env.MEDIA_DIR || '/media';

// Where captured frame JPEGs land for /api/screensaver/<id>.jpg
const SCREENSAVER_FRAME_DIR = process.env.SCREENSAVER_FRAME_DIR
  || '/tmp/windowpanes-screensaver';
const SCREENSAVER_CAPTURE_INTERVAL_MS = 250; // refresh frame every 250ms
const SCREENSAVER_XVFB_READY_TIMEOUT_MS = 5000;

// Serve static frontend files
app.use(express.static(path.join(__dirname, 'public')));

// Serve media files (videos, images, etc.)
app.use('/media', express.static(MEDIA_DIR, {
  // Allow range requests for video seeking
  acceptRanges: true
}));

// API: return parsed config as JSON
function readConfig() {
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  return yaml.load(raw);
}

app.get('/api/config', (req, res) => {
  try {
    res.json(readConfig());
  } catch (err) {
    console.error('Failed to load config:', err.message);
    res.status(500).json({ error: 'Failed to load config', detail: err.message });
  }
});

// ─── /api/proxy — bypass X-Frame-Options / CSP frame-ancestors ────────────
//
// Fetches the upstream URL server-side and serves it from our own origin,
// stripping the headers that prevent embedding (x-frame-options,
// content-security-policy, etc.) so the iframe can render.
//
// Optional env: PROXY_ALLOWLIST=host1,host2 — comma-separated hostnames.
// If set, requests to any other host return 403. Default: no allowlist.
//
// Security: SSRF guard rejects URL hostnames that resolve to private/loopback
// addresses (127/8, 10/8, 172.16/12, 192.168/16, 169.254/16, ::1, fc00::/7,
// fe80::/10). Tailscale's 100.64.0.0/10 is allowed (Quinn's homelab).
//
// For HTML upstream responses we rewrite relative URLs to absolute so the
// browser requests assets directly from the upstream origin (no double
// proxying of CSS/JS/images). Non-HTML responses are forwarded verbatim.

const PROXY_TIMEOUT_MS = 10000;
const PROXY_ALLOWLIST = (process.env.PROXY_ALLOWLIST || '')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

// Response headers we must remove to allow iframe embedding
const BLOCKED_HEADERS = new Set([
  'x-frame-options',
  'content-security-policy',
  'content-security-policy-report-only',
  'frame-options',
]);

function isPrivateOrLoopback(ip) {
  // Normalize IPv4-mapped IPv6 (e.g. "::ffff:127.0.0.1" → "127.0.0.1")
  const m = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (m) ip = m[1];

  // IPv4 checks
  const v4 = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 127) return true;                              // 127.0.0.0/8
    if (a === 10) return true;                               // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true;        // 172.16.0.0/12
    if (a === 192 && b === 168) return true;                 // 192.168.0.0/16
    if (a === 169 && b === 254) return true;                 // 169.254.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return false;      // 100.64.0.0/10 Tailscale — allow
    return false;
  }

  // IPv6 checks
  const lc = ip.toLowerCase();
  if (lc === '::1' || lc === '0:0:0:0:0:0:0:1') return true; // loopback
  if (lc.startsWith('fc') || lc.startsWith('fd')) return true;// fc00::/7 ULA
  if (lc.startsWith('fe80:') || lc.startsWith('fe8') ||
      lc.startsWith('fe9:') || lc.startsWith('fea:') ||
      lc.startsWith('feb:')) return true;                     // fe80::/10 link-local

  return false;
}

async function assertSafeUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('invalid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('only http/https allowed');
  }

  const hostname = parsed.hostname.toLowerCase();
  if (PROXY_ALLOWLIST.length > 0 && !PROXY_ALLOWLIST.includes(hostname)) {
    throw new Error('host not in allowlist');
  }

  // Resolve hostname → check all returned IPs against the private ranges
  const addrs = await dns.promises.lookup(hostname, { all: true });
  for (const { address } of addrs) {
    if (isPrivateOrLoopback(address)) {
      throw new Error(`blocked private address ${address}`);
    }
  }

  return { parsed, hostname };
}

function copyHeaders(upstreamHeaders, contentType) {
  const out = {};
  for (const [key, value] of upstreamHeaders.entries()) {
    const lk = key.toLowerCase();
    if (BLOCKED_HEADERS.has(lk)) continue;
    if (lk === 'content-length') continue;       // we'll set if known
    if (lk === 'content-encoding') continue;     // we serve uncompressed
    if (lk === 'transfer-encoding') continue;
    if (lk === 'connection') continue;
    if (lk === 'strict-transport-security') continue; // HSTS doesn't apply inside iframe
    out[key] = value;
  }
  if (contentType) out['Content-Type'] = contentType;
  // Belt-and-suspenders for HTML: explicit allow header too
  if (contentType && /^text\/html/i.test(contentType)) {
    out['X-Frame-Options'] = 'ALLOWALL';
    // Disable any leftover frame-ancestors via CSP too (defense in depth)
    out['Content-Security-Policy'] = "frame-ancestors *";
  }
  return out;
}

/**
 * Rewrite relative URLs to absolute so they resolve upstream.
 * Inputs:
 *   html     — string body of an HTML document
 *   baseUrl  — absolute URL of the upstream page (e.g. 'https://x.com/foo/bar')
 */
function rewriteHtml(html, baseUrl, opts = {}) {
  const baseOrigin = new URL(baseUrl).origin + '/';

  // 1. Inject <base href="<upstream-origin>/"> into <head> so unresolved
  //    relative URLs route back to the upstream origin.
  let out = html;
  if (/<head[^>]*>/i.test(out)) {
    out = out.replace(/<head([^>]*)>/i, `<head$1><base href="${baseOrigin}">`);
  } else if (/<html[^>]*>/i.test(out)) {
    out = out.replace(/<html([^>]*)>/i, `<html$1><head><base href="${baseOrigin}"></head>`);
  } else {
    // No <head>/<html>? Prepend a base anyway.
    out = `<head><base href="${baseOrigin}"></head>` + out;
  }

  // 2. Strip any upstream <meta http-equiv="Content-Security-Policy" ...>
  out = out.replace(
    /<meta\s[^>]*http-equiv\s*=\s*["']?Content-Security-Policy["']?[^>]*>/gi,
    ''
  );

  // 3. Rewrite known relative URL attributes to absolute. Attributes can have
  //    various quote styles ("...", '...', or unquoted). Run against html
  //    BEFORE injecting <base> would lose the base reference, so we do it
  //    after — but the <base> target is referenced via origin only, so our
  //    pass below uses baseUrl as the resolution root.
  const ATTRS = ['href', 'src'];
  const reTag = new RegExp(
    `<(\\w+)([^>]*?)\\s(${ATTRS.join('|')})=("([^"]*)"|'([^']*)'|([^\\s"'>]+))([^>]*)>`,
    'gi'
  );
  out = out.replace(reTag, (match, tagName, before, attrName, _q, dq, sq, unq, after) => {
    const raw = dq !== undefined ? dq : (sq !== undefined ? sq : (unq || ''));
    if (!raw) return match;
    // Skip absolute URLs, protocol-relative, anchors, inlines, mailto, etc.
    if (/^(https?:)?\/\//i.test(raw)) return match;
    if (raw.startsWith('#')) return match;          // anchors stay relative
    if (/^(data:|javascript:|mailto:|tel:)/i.test(raw)) return match;
    let abs;
    try {
      abs = new URL(raw, baseUrl).href;
    } catch {
      return match;
    }
    // If the caller asked us to route assets through the proxy (because
    // the pane has auth headers that need to be applied to every request
    // — Basic / Bearer / Cookie), wrap the absolute URL in the proxy URL.
    // The browser will then re-fetch through /api/proxy, which applies
    // auth on the way out. Without this, browser-direct fetches for CSS/JS/
    // images 401 and the iframe renders blank.
    if (opts.assetProxyBase) {
      const q = dq !== undefined ? '"' : (sq !== undefined ? "'" : '"');
      return `<${tagName}${before} ${attrName}=${q}${opts.assetProxyBase}${encodeURIComponent(abs)}${q}${after}>`;
    }
    const q = dq !== undefined ? '"' : (sq !== undefined ? "'" : '"');
    return `<${tagName}${before} ${attrName}=${q}${abs}${q}${after}>`;
  });

  return out;
}

// ── Auth resolver for proxied panes ────────────────────────────────────
// Resolves the `auth:` block on a pane into an HTTP header bag that the
// proxy can attach to upstream fetches. Supports three shapes:
//   - basic:   { username, password }  → Authorization: Basic <b64>
//   - bearer:  <string>                → Authorization: Bearer <token>
//   - cookie:  <string>                → Cookie: <raw value>
// Strings containing `${VAR}` are interpolated from process.env at request
// time so secrets never need to live in config.yaml.
//
// Errors out (HTTP 400) on:
//   - empty/missing required fields
//   - more than one auth kind per pane (ambiguous)
//   - `${VAR}` references that aren't set in the environment
function resolveAuth(pane) {
  if (!pane || !pane.auth) return null;
  const auth = pane.auth;
  if (typeof auth !== 'object') {
    throw new Error('auth must be an object');
  }
  const kinds = [];
  if (auth.basic) kinds.push('basic');
  if (auth.bearer != null) kinds.push('bearer');
  if (auth.cookie != null) kinds.push('cookie');
  if (kinds.length === 0) {
    throw new Error('auth block present but no auth method set (use basic:, bearer:, or cookie:)');
  }
  if (kinds.length > 1) {
    throw new Error(`auth block has multiple methods (${kinds.join(', ')}); only one allowed per pane`);
  }

  const interpolate = (val) => {
    if (typeof val !== 'string') return val;
    return val.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_, name) => {
      if (process.env[name] === undefined) {
        throw new Error(`auth references \${${name}} but env var is not set`);
      }
      return process.env[name];
    });
  };

  if (kinds[0] === 'basic') {
    if (typeof auth.basic !== 'object' || !auth.basic.username) {
      throw new Error('auth.basic.username is required');
    }
    const user = interpolate(auth.basic.username);
    const pass = interpolate(auth.basic.password ?? '');
    const token = Buffer.from(`${user}:${pass}`, 'utf8').toString('base64');
    return { kind: 'basic', headers: { Authorization: `Basic ${token}` } };
  }
  if (kinds[0] === 'bearer') {
    const token = interpolate(auth.bearer);
    if (!token) throw new Error('auth.bearer is empty');
    return { kind: 'bearer', headers: { Authorization: `Bearer ${token}` } };
  }
  if (kinds[0] === 'cookie') {
    const cookie = interpolate(auth.cookie);
    if (!cookie) throw new Error('auth.cookie is empty');
    return { kind: 'cookie', headers: { Cookie: cookie } };
  }
  // unreachable; for TS-style safety
  throw new Error(`unknown auth kind: ${kinds[0]}`);
}

// Look up a pane by its client-side id (`pane-N` where N is the index in
// config.panes). Returns null if the id is malformed or out of range.
function lookupPaneById(paneId) {
  if (!paneId || typeof paneId !== 'string') return null;
  const m = /^pane-(\d+)$/.exec(paneId);
  if (!m) return null;
  const idx = parseInt(m[1], 10);
  let panes;
  try {
    panes = readConfig().panes || [];
  } catch {
    return null;
  }
  return panes[idx] || null;
}

app.get('/api/proxy', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl || typeof targetUrl !== 'string') {
    return res.status(400).send('Missing ?url= parameter');
  }

  // Optional paneId — when provided, the server looks up that pane's
  // `auth:` block and applies the resulting headers (Basic/Bearer/Cookie)
  // to the upstream fetch. When absent, the proxy is anonymous (existing
  // behavior). Clients should always pass paneId for proxy'd panes so
  // that asset subrequests pick up auth too.
  const paneId = req.query.paneId;
  const pane = paneId ? lookupPaneById(paneId) : null;
  if (paneId && !pane) {
    return res.status(400).send(`Proxy: paneId '${paneId}' not found in config`);
  }

  // Resolve auth (if any) — throws on bad config, missing env vars,
  // or multiple auth methods set on the same pane.
  let authHeaders = null;
  try {
    const resolved = resolveAuth(pane);
    if (resolved) authHeaders = resolved.headers;
  } catch (err) {
    return res.status(400).send(`Proxy auth error: ${err.message}`);
  }

  // Defense-in-depth: SSRF + scheme guard
  let parsed, hostname;
  try {
    ({ parsed, hostname } = await assertSafeUrl(targetUrl));
  } catch (err) {
    return res.status(400).send(`Proxy rejected URL: ${err.message}`);
  }

  // Forward request with AbortController for timeout
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);

  let upstream;
  try {
    upstream = await fetch(parsed.href, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        // Pretend to be a normal browser — some sites gate on UA
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:124.0) Gecko/20100101 Firefox/124.0',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        ...(authHeaders || {}),
      },
    });
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      return res.status(504).send('Upstream fetch timed out');
    }
    return res.status(502).send(`Upstream fetch failed: ${err.message}`);
  }
  clearTimeout(timeout);

  const upstreamCT = upstream.headers.get('content-type') || '';
  const isHtml = /^text\/html/i.test(upstreamCT);

  // Read full body (HTML rewrite needs the whole doc).
  // Note: spec says no streaming/chunked rewriting for v1 — full buffer is fine.
  const buf = Buffer.from(await upstream.arrayBuffer());
  const len = buf.length;

  // Build response headers
  const headers = copyHeaders(upstream.headers, upstreamCT);
  if (isHtml) {
    let html = buf.toString('utf8');
    // If auth is set, route asset URLs back through this proxy so the
    // browser's subrequests for CSS/JS/images pick up auth headers too.
    // Without this, the HTML renders but static assets 401 and the
    // iframe looks blank.
    const rewriteOpts = authHeaders
      ? { assetProxyBase: paneId ? `/api/proxy?paneId=${paneId}&url=` : `/api/proxy?url=` }
      : {};
    html = rewriteHtml(html, parsed.href, rewriteOpts);
    const body = Buffer.from(html, 'utf8');
    headers['Content-Length'] = String(body.length);
    res.writeHead(upstream.status, headers);
    return res.end(body);
  }

  // Non-HTML (images, CSS, JS, fonts, etc.) — forward verbatim
  headers['Content-Length'] = String(len);
  res.writeHead(upstream.status, headers);
  res.end(buf);
});

// ────────────────────────────────────────────────────────────────────────
// /api/screensaver — xscreensaver pane frame serving
// ────────────────────────────────────────────────────────────────────────
//
// Each `type: xscreensaver` pane in config.yaml owns:
//   - one Xvfb display (`:N`, N >= 99, unique per pane)
//   - one running xscreensaver module process (or daemon + active module)
//   - one continuous capture child (ffmpeg x11grab) writing JPEG to disk
//   - one rotation timer that swaps modules on the configured `interval`
//
// Frame files live in SCREENSAVER_FRAME_DIR as `<pane-id>.jpg`. The client
// polls `/api/screensaver/<pane-id>.jpg?t=<epochMs>` every 250ms. We don't
// worry about ordering — a stale frame is fine if a capture is in flight.
//
// Children are tracked in per-pane state so SIGTERM can kill them cleanly.
// We never shell-string user values; all child spawns use args arrays.

const screensaverPanes = new Map(); // paneId -> { ...state }
const allocatedDisplays = new Set(); // display numbers currently in use

// Pane-ID scheme: 1:1 with the pane's index in config.panes. The client
// uses the same scheme (loop index when building panes) so client and
// server agree without an extra round-trip.
function paneIdFor(configPanes, idx) {
  return `pane-${idx}`;
}

// ─── Helpers ─────────────────────────────────────────────────────────

function findInPath(names) {
  // Return the first existing absolute path among `names`, or null.
  const dirs = (process.env.PATH || '').split(':');
  for (const n of names) {
    if (path.isAbsolute(n) && fs.existsSync(n)) return n;
    for (const d of dirs) {
      if (!d) continue;
      const candidate = path.join(d, n);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {}
    }
  }
  return null;
}

function framePathFor(paneId) {
  return path.join(SCREENSAVER_FRAME_DIR, `${paneId}.jpg`);
}

function ensureFrameDir() {
  try {
    fs.mkdirSync(SCREENSAVER_FRAME_DIR, { recursive: true });
  } catch (err) {
    console.error(`[xscreensaver] cannot create frame dir ${SCREENSAVER_FRAME_DIR}:`, err.message);
  }
}

function safeKill(proc, signal = 'SIGTERM') {
  if (!proc || proc.killed) return;
  try {
    proc.kill(signal);
  } catch {
    /* proc already dead */
  }
}

// Poll /tmp/.X11-unix/XN until Xvfb has bound the display, or timeout.
async function waitForDisplay(displayNum, timeoutMs) {
  const socketPath = `/tmp/.X11-unix/X${displayNum}`;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await fs.promises.access(socketPath, fs.constants.F_OK);
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  return false;
}

// Pick the first display number `>= startingFrom` not yet allocated.
function allocateDisplay(startingFrom) {
  let n = Math.max(0, Number(startingFrom) || 99);
  while (allocatedDisplays.has(n)) n++;
  allocatedDisplays.add(n);
  return n;
}

function releaseDisplay(displayNum) {
  if (displayNum == null) return;
  allocatedDisplays.delete(displayNum);
}

// ─── Spawn helpers ───────────────────────────────────────────────────

function spawnXvfb(displayNum, width, height) {
  // Xvfb args: display is positional, rest are flags. Order matches the
  // spec TODO — `+extension GLX +render` for xscreensaver GL modules,
  // `-nolisten tcp` so we don't expose an unauthenticated X server.
  const args = [
    `:${displayNum}`,
    '-screen', '0', `${width}x${height}x24`,
    '+extension', 'GLX',
    '+render',
    '-nolisten', 'tcp',
  ];
  return spawn('Xvfb', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });
}

// Spawn the requested module. Tries `xscreensaver -module <name>` first
// (single-binary launcher; preferred), falls back to direct module
// binaries under the standard module dirs.
function spawnModule(moduleName, displayNum, moduleDir) {
  const display = `:${displayNum}`;

  // Try the `xscreensaver` launcher first
  const launcher = findInPath(['xscreensaver']);
  if (launcher) {
    return spawn(
      launcher,
      ['-root', '-no-splash', '-module', moduleName],
      {
        env: { ...process.env, DISPLAY: display },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
  }

  // Fallback: spawn the module binary directly from the module dir.
  if (moduleDir) {
    const binaryPath = path.join(moduleDir, moduleName);
    try {
      if (fs.statSync(binaryPath).isFile()) {
        return spawn(binaryPath, ['-root'], {
          env: { ...process.env, DISPLAY: display },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      }
    } catch {}
  }

  return null;
}

function spawnCapture(displayNum, width, height, outPath) {
  // ffmpeg -f x11grab -video_size WxH -i :N -frames:v 1 -q:v 5 -y <file>
  // Note: -y overwrites an existing file, which is what we want.
  return spawn(
    'ffmpeg',
    [
      '-loglevel', 'error',
      '-f', 'x11grab',
      '-video_size', `${width}x${height}`,
      '-i', `:${displayNum}`,
      '-frames:v', '1',
      '-q:v', '5',
      '-y', outPath,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  );
}

function pipeProcLog(proc, tag, streamName) {
  if (!proc) return;
  const stream = proc[streamName];
  if (!stream) return;
  let buf = '';
  stream.on('data', (chunk) => {
    buf += chunk.toString();
    if (buf.length > 4096) buf = buf.slice(-4096);
    const lines = buf.split(/\r?\n/);
    buf = lines.pop() || '';
    for (const line of lines) {
      if (line.trim()) console.log(`[xscreensaver ${tag}] ${line.trim()}`);
    }
  });
  stream.on('end', () => {
    if (buf.trim()) console.log(`[xscreensaver ${tag}] ${buf.trim()}`);
  });
}

// ─── Single-pane lifecycle ────────────────────────────────────────────

async function startXscreensaverPane(paneId, pane) {
  ensureFrameDir();

  // Validate required host tools up front. Skip-but-disable the pane so
  // the client renders its error div.
  const xvfbPath = findInPath(['Xvfb']);
  if (!xvfbPath) {
    console.error(`[xscreensaver ${paneId}] Xvfb not in PATH; pane disabled`);
    screensaverPanes.set(paneId, { enabled: false, reason: 'xvfb-missing' });
    return;
  }
  const ffmpegPath = findInPath(['ffmpeg']);
  if (!ffmpegPath) {
    console.error(`[xscreensaver ${paneId}] ffmpeg not in PATH; pane disabled`);
    screensaverPanes.set(paneId, { enabled: false, reason: 'ffmpeg-missing' });
    return;
  }

  const mode = pane.mode || 'single';
  if (!logic.isValidMode(mode)) {
    console.error(`[xscreensaver ${paneId}] invalid mode '${mode}'; pane disabled`);
    screensaverPanes.set(paneId, { enabled: false, reason: 'invalid-mode' });
    return;
  }

  const width = Math.max(64, Math.min(7680, Number(pane.width) || 1280));
  const height = Math.max(64, Math.min(4320, Number(pane.height) || 720));
  const intervalSec = Math.max(1, Number(pane.interval) || 30);
  const intervalMs = intervalSec * 1000;
  const displayStart = (pane.display != null) ? Number(pane.display) : 99;

  // Build module list per mode
  let modules = [];
  if (mode === 'single' || mode === 'list-sequential' || mode === 'list-random') {
    modules = logic.normalizeModules(pane.modules);
    if (modules.length === 0) {
      console.error(`[xscreensaver ${paneId}] '${mode}' mode requires non-empty 'modules'; pane disabled`);
      screensaverPanes.set(paneId, { enabled: false, reason: 'empty-modules' });
      return;
    }
  } else {
    // all-sequential / all-random: enumerate from disk
    modules = logic.enumerateFromFilesystem(logic.DEFAULT_MODULE_DIRS);
    if (modules.length === 0) {
      console.error(`[xscreensaver ${paneId}] '${mode}' mode found zero installed modules in ${JSON.stringify(logic.DEFAULT_MODULE_DIRS)}; pane disabled`);
      screensaverPanes.set(paneId, { enabled: false, reason: 'no-installed-modules' });
      return;
    }
    console.log(`[xscreensaver ${paneId}] '${mode}' enumerated ${modules.length} modules: ${modules.slice(0, 8).join(', ')}${modules.length > 8 ? ', ...' : ''}`);
  }

  // Allocate Xvfb display
  const displayNum = allocateDisplay(displayStart);

  // Spawn Xvfb
  let xvfbProc;
  try {
    xvfbProc = spawnXvfb(displayNum, width, height);
  } catch (err) {
    console.error(`[xscreensaver ${paneId}] failed to spawn Xvfb: ${err.message}`);
    releaseDisplay(displayNum);
    screensaverPanes.set(paneId, { enabled: false, reason: 'xvfb-spawn-failed' });
    return;
  }

  pipeProcLog(xvfbProc, paneId, 'stdout');
  pipeProcLog(xvfbProc, paneId, 'stderr');

  xvfbProc.on('exit', (code, signal) => {
    const state = screensaverPanes.get(paneId);
    // If we requested shutdown, the exit is expected.
    if (state && state.stopping) return;
    console.error(`[xscreensaver ${paneId}] Xvfb exited unexpectedly code=${code} signal=${signal}; pane disabled`);
    stopXscreensaverPane(paneId).catch(() => {});
    const cur = screensaverPanes.get(paneId);
    screensaverPanes.set(paneId, { ...(cur || {}), enabled: false, reason: 'xvfb-died', xvfbProc: null, moduleProc: null });
  });

  // Wait for Xvfb to bind /tmp/.X11-unix/X<N>
  const ready = await waitForDisplay(displayNum, SCREENSAVER_XVFB_READY_TIMEOUT_MS);
  if (!ready) {
    console.error(`[xscreensaver ${paneId}] Xvfb :${displayNum} did not become ready in ${SCREENSAVER_XVFB_READY_TIMEOUT_MS}ms`);
    safeKill(xvfbProc);
    releaseDisplay(displayNum);
    screensaverPanes.set(paneId, { enabled: false, reason: 'xvfb-not-ready', xvfbProc: null });
    return;
  }

  // Where the module binaries likely live (if we need a fallback).
  // We just use the first directory that contains at least one matching
  // module name; if none does, we still try direct spawn via PATH lookup
  // in spawnModule().
  let moduleDir = null;
  for (const dir of logic.DEFAULT_MODULE_DIRS) {
    if (!modules.length) break;
    const candidate = path.join(dir, modules[0]);
    try {
      if (fs.statSync(candidate).isFile()) {
        moduleDir = dir;
        break;
      }
    } catch {}
  }

  // Build initial state
  const state = {
    enabled: true,
    display: displayNum,
    width,
    height,
    mode,
    modules,
    intervalMs,
    xvfbProc,
    moduleProc: null,
    currentIndex: null,
    moduleDir,
    rotationTimer: null,
    captureTimer: null,
    capturing: false,
    outPath: framePathFor(paneId),
    stopping: false,
    error: null,
  };
  screensaverPanes.set(paneId, state);

  console.log(`[xscreensaver ${paneId}] ready — display :${displayNum} mode=${mode} ${width}x${height} interval=${intervalSec}s modules=${modules.length}`);

  // Start the first module. For 'single' we keep rotating off (no timer)
  // but pick index 0 once.
  cycleToNextModule(paneId);

  // Rotation timer (skip for 'single')
  if (mode !== 'single') {
    state.rotationTimer = setInterval(() => cycleToNextModule(paneId), intervalMs);
    // Unref so the timer doesn't keep the process alive on shutdown.
    if (state.rotationTimer && typeof state.rotationTimer.unref === 'function') {
      state.rotationTimer.unref();
    }
  }

  // Capture loop
  state.captureTimer = setInterval(() => captureFrame(paneId), SCREENSAVER_CAPTURE_INTERVAL_MS);
  if (state.captureTimer && typeof state.captureTimer.unref === 'function') {
    state.captureTimer.unref();
  }
}

function cycleToNextModule(paneId) {
  const state = screensaverPanes.get(paneId);
  if (!state || !state.enabled || state.stopping) return;

  const pick = logic.pickNext(state.mode, state.modules, state.currentIndex);
  if (!pick.ok) {
    console.error(`[xscreensaver ${paneId}] pickNext failed: ${pick.reason}`);
    return;
  }
  state.currentIndex = pick.index;
  const moduleName = state.modules[pick.index];

  // Kill the previous module process, if any
  safeKill(state.moduleProc);
  state.moduleProc = null;

  const proc = spawnModule(moduleName, state.display, state.moduleDir);
  if (!proc) {
    console.error(`[xscreensaver ${paneId}] could not spawn module '${moduleName}' (no launcher or binary found)`);
    // For 'single', we have no recovery: disable the pane.
    if (state.mode === 'single') {
      state.enabled = false;
      state.error = 'spawn-failed';
    }
    return;
  }

  pipeProcLog(proc, paneId, 'stdout');
  pipeProcLog(proc, paneId, 'stderr');

  proc.on('exit', (code, signal) => {
    // If this is the active module, clear it from state
    const cur = screensaverPanes.get(paneId);
    if (cur && cur.moduleProc === proc) cur.moduleProc = null;
    if (cur && cur.stopping) return;
    if (code != null && code !== 0 && signal !== 'SIGTERM' && signal !== 'SIGKILL') {
      // Module crashed unexpectedly — log but don't disable (cycling
      // modes will rotate to the next module at the next tick anyway).
      console.warn(`[xscreensaver ${paneId}] module '${moduleName}' exited code=${code} signal=${signal}`);
    }
  });

  state.moduleProc = proc;
  console.log(`[xscreensaver ${paneId}] → module '${moduleName}' (index ${pick.index})`);
}

function captureFrame(paneId) {
  const state = screensaverPanes.get(paneId);
  if (!state || !state.enabled || state.stopping) return;
  if (state.capturing) return; // previous capture still in flight
  if (!state.xvfbProc || state.xvfbProc.killed) return;

  state.capturing = true;
  let proc;
  try {
    proc = spawnCapture(state.display, state.width, state.height, state.outPath);
  } catch (err) {
    state.capturing = false;
    console.error(`[xscreensaver ${paneId}] capture spawn failed: ${err.message}`);
    return;
  }

  // 2-second hard kill: if ffmpeg hangs (Xvfb died mid-capture, display
  // unreachable, etc.) don't let it block the event loop or hold the
  // capture slot forever. unref() so the timer doesn't keep the server alive.
  const CAPTURE_TIMEOUT_MS = 2000;
  const killTimer = setTimeout(() => {
    if (!proc.killed) {
      console.warn(`[xscreensaver ${paneId}] capture ffmpeg exceeded ${CAPTURE_TIMEOUT_MS}ms, SIGKILL`);
      try { proc.kill('SIGKILL'); } catch (_) { /* already gone */ }
    }
  }, CAPTURE_TIMEOUT_MS);
  killTimer.unref();

  proc.on('error', (err) => {
    state.capturing = false;
    clearTimeout(killTimer);
    console.error(`[xscreensaver ${paneId}] capture error: ${err.message}`);
  });

  proc.on('exit', (code, signal) => {
    state.capturing = false;
    clearTimeout(killTimer);
    if (signal === 'SIGKILL' && code == null) {
      // We killed it via the timeout above. Don't double-log.
      return;
    }
    if (code !== 0 && code != null) {
      // Capture failed (often: X server gone, ffmpeg can't connect).
      // Throttle this log: only fire every ~10s.
      const now = Date.now();
      if (!state.lastCaptureErrorLog || now - state.lastCaptureErrorLog > 10000) {
        console.warn(`[xscreensaver ${paneId}] capture exited with code=${code}`);
        state.lastCaptureErrorLog = now;
      }
    }
  });
}

async function stopXscreensaverPane(paneId) {
  const state = screensaverPanes.get(paneId);
  if (!state) return;
  state.stopping = true;

  if (state.rotationTimer) { clearInterval(state.rotationTimer); state.rotationTimer = null; }
  if (state.captureTimer) { clearInterval(state.captureTimer); state.captureTimer = null; }

  safeKill(state.moduleProc);
  state.moduleProc = null;

  // Xvfb must die last so the screensaver & capture can tear down cleanly.
  safeKill(state.xvfbProc);
  state.xvfbProc = null;

  releaseDisplay(state.display);

  // Brief grace period so child processes have a chance to actually exit
  // before we forget about them. We don't await — this is best-effort.
  await new Promise((r) => setTimeout(r, 250));

  const stillAlive = state.moduleProc || state.xvfbProc;
  if (stillAlive) {
    // Mark disabled so future polls return 404.
    state.enabled = false;
  }

  // Don't delete the entry — clients may still poll for a moment and
  // should get a clear 404 rather than a 500.
}

function stopAllXscreensaverPanes() {
  const entries = [...screensaverPanes.entries()];
  for (const [paneId] of entries) {
    stopXscreensaverPane(paneId).catch(() => {});
  }
}

// Boot all xscreensaver panes in config (called once after listen)
function bootXscreensaverPanes() {
  let cfg;
  try {
    cfg = readConfig();
  } catch (err) {
    console.error('[xscreensaver] cannot read config at boot:', err.message);
    return;
  }
  const panes = (cfg && cfg.panes) || [];
  for (let i = 0; i < panes.length; i++) {
    const pane = panes[i];
    if (!pane || pane.type !== 'xscreensaver') continue;
    const paneId = paneIdFor(panes, i);
    startXscreensaverPane(paneId, pane).catch((err) => {
      console.error(`[xscreensaver ${paneId}] boot error:`, err.message);
    });
  }
}

// ─── HTTP route: serve the latest frame for a pane ───────────────────

app.get('/api/screensaver/:paneId.jpg', (req, res) => {
  // Reject path traversal attempts
  if (req.params.paneId.includes('/') || req.params.paneId.includes('..')) {
    return res.status(400).json({ error: 'bad paneId' });
  }
  const paneId = req.params.paneId;
  const state = screensaverPanes.get(paneId);
  if (!state) {
    return res.status(404).json({ error: 'no such pane', paneId });
  }
  if (!state.enabled) {
    return res.status(503).json({
      error: 'xscreensaver pane disabled',
      reason: state.reason || 'unknown',
      paneId,
    });
  }
  const p = state.outPath || framePathFor(paneId);
  try {
    fs.statSync(p);
  } catch {
    // Frame not yet captured — try again soon
    res.set('Retry-After', '1');
    return res.status(503).json({ error: 'frame not ready', reason: 'frame-not-ready', paneId });
  }
  // No content-length / no cache control — let express stream the file.
  // Cache-Control: no-store so the client cache-buster (Date.now in src)
  // is the only signal we honor.
  res.set('Content-Type', 'image/jpeg');
  res.set('Cache-Control', 'no-store, max-age=0');
  res.sendFile(p);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`WindowPanes server running at http://localhost:${PORT}`);
  console.log(`Config: ${CONFIG_PATH}`);
  console.log(`Media dir: ${MEDIA_DIR}`);
  if (PROXY_ALLOWLIST.length > 0) {
    console.log(`Proxy allowlist: ${PROXY_ALLOWLIST.join(', ')}`);
  } else {
    console.log('Proxy allowlist: (none — set PROXY_ALLOWLIST=host1,host2 to restrict)');
  }
  // Start xscreensaver panes (best-effort, errors per-pane)
  bootXscreensaverPanes();
});

// ─── Graceful shutdown — kill all screensaver panes ───────────────────
//
// start.sh's cleanup trap sends SIGTERM to the server pid when the user
// hits Esc / Ctrl+Q / Ctrl+C. We must tear down Xvfb + screensaver +
// ffmpeg children cleanly. Without this, Xvfb processes leak across
// restarts and consume port :99, :100, ... forever.
function gracefulShutdown(signal) {
  console.log(`[server] received ${signal}, tearing down xscreensaver panes...`);
  stopAllXscreensaverPanes();
  // Give children a moment to flush, then exit. We exit 0 because the
  // parent (start.sh) treats exit-0 as "clean shutdown".
  setTimeout(() => process.exit(0), 600);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
