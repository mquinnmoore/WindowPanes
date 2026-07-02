const express = require('express');
const path = require('path');
const fs = require('fs');
const dns = require('dns');
const yaml = require('js-yaml');

const app = express();
const PORT = process.env.PORT || 3000;
const CONFIG_PATH = process.env.CONFIG || path.join(__dirname, 'config.yaml');
const MEDIA_DIR = process.env.MEDIA_DIR || '/media';

// Serve static frontend files
app.use(express.static(path.join(__dirname, 'public')));

// Serve media files (videos, images, etc.)
app.use('/media', express.static(MEDIA_DIR, {
  // Allow range requests for video seeking
  acceptRanges: true
}));

// API: return parsed config as JSON
app.get('/api/config', (req, res) => {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const config = yaml.load(raw);
    res.json(config);
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
function rewriteHtml(html, baseUrl) {
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
    const q = dq !== undefined ? '"' : (sq !== undefined ? "'" : '"');
    return `<${tagName}${before} ${attrName}=${q}${abs}${q}${after}>`;
  });

  return out;
}

app.get('/api/proxy', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl || typeof targetUrl !== 'string') {
    return res.status(400).send('Missing ?url= parameter');
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
    html = rewriteHtml(html, parsed.href);
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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`WindowPanes server running at http://localhost:${PORT}`);
  console.log(`Config: ${CONFIG_PATH}`);
  console.log(`Media dir: ${MEDIA_DIR}`);
  if (PROXY_ALLOWLIST.length > 0) {
    console.log(`Proxy allowlist: ${PROXY_ALLOWLIST.join(', ')}`);
  } else {
    console.log('Proxy allowlist: (none — set PROXY_ALLOWLIST=host1,host2 to restrict)');
  }
});
