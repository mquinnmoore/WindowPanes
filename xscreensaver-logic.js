'use strict';

/**
 * xscreensaver-logic.js — pure-logic helpers for the xscreensaver pane type.
 *
 * No process spawning here. Server-side code (server.js) and the offline
 * test (test-xscreensaver-logic.js) both depend on this module so the
 * logic is testable without touching Xvfb / xscreensaver / ffmpeg.
 *
 * Exposes:
 *   - VALID_MODES         — the five supported mode strings
 *   - pickNext(mode, modules, currentIndex) → { ok, index } | { ok: false, reason }
 *   - enumerateFromFilesystem(dirs)         → string[]  // sorted module names
 *   - DEFAULT_MODULE_DIRS — sensible defaults for enumerateFromFilesystem()
 *   - isValidMode(mode)                     → bool
 *   - normalizeModules(modules)             → cleaned module list
 */

const fs = require('fs');
const path = require('path');

const VALID_MODES = [
  'single',
  'list-sequential',
  'list-random',
  'all-sequential',
  'all-random',
];

const DEFAULT_MODULE_DIRS = [
  '/usr/libexec/xscreensaver',
  '/usr/lib/xscreensaver',
  '/usr/lib64/xscreensaver',
  '/usr/share/xscreensaver',
  '/usr/local/libexec/xscreensaver',
  '/usr/local/lib/xscreensaver',
];

/**
 * List of binaries that *aren't* modules even if they live in the module
 * directory. Heuristic but accurate enough for Debian/Ubuntu/Fedora installs.
 */
const NON_MODULE_NAMES = new Set([
  'xscreensaver',
  'xscreensaver-command',
  'xscreensaver-demo',
  'xscreensaver-getimage',
  'xscreensaver-getimage-file',
  'xscreensaver-gl-helper',
  'xscreensaver-noip',
  'xscreensaver-settings',
  'xscreensaver-text',
  'pixbuf-cells',
  'pixbuf-flips',
  'pixbuf-pixmap',
  'pixbuf-ximage',
]);

function isValidMode(mode) {
  return VALID_MODES.includes(mode);
}

/**
 * Clean a user-supplied module list: trim, drop empties, dedupe, preserve order.
 */
function normalizeModules(modules) {
  if (!Array.isArray(modules)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of modules) {
    if (typeof raw !== 'string') continue;
    const name = raw.trim();
    if (!name) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/**
 * Pick the next module index for a pane, given its mode, list, and current
 * index. Pure function — no randomness seeded by clock; randomness uses
 * Math.random (test verifies "no immediate repeat" statistically).
 *
 * @param {string} mode           one of VALID_MODES
 * @param {string[]} modules      non-empty list of module names
 * @param {number|null} currentIndex  current module index, or null/undefined
 *                                   if no module has been picked yet
 * @returns {{ok: true, index: number} | {ok: false, reason: string}}
 */
function pickNext(mode, modules, currentIndex) {
  const list = Array.isArray(modules) ? modules : [];
  if (list.length === 0) {
    return { ok: false, reason: 'empty' };
  }
  const n = list.length;
  switch (mode) {
    case 'single':
      // Always the only index — never rotates.
      return { ok: true, index: 0 };
    case 'list-sequential':
    case 'all-sequential': {
      // For sequential cycles, the very first pick should be index 0, then
      // advance one tick at a time. `currentIndex == null` means "no
      // module has been picked yet" (initial start-up).
      if (currentIndex == null || currentIndex < 0) {
        return { ok: true, index: 0 };
      }
      return { ok: true, index: (currentIndex + 1) % n };
    }
    case 'list-random':
    case 'all-random': {
      if (n === 1) return { ok: true, index: 0 };
      // Pick uniformly at random, never returning currentIndex.
      // For n=2 with currentIndex=0, the only other index is 1 — so we
      // must allow it (not loop forever).
      if (currentIndex == null || currentIndex < 0) {
        return { ok: true, index: Math.floor(Math.random() * n) };
      }
      let idx;
      // Bound retries to prevent pathological loops (n=1 is handled above).
      let attempts = 0;
      do {
        idx = Math.floor(Math.random() * n);
        attempts++;
        if (attempts > 32) { idx = (currentIndex + 1) % n; break; }
      } while (idx === currentIndex);
      return { ok: true, index: idx };
    }
    default:
      return { ok: false, reason: 'unknown-mode' };
  }
}

/**
 * Enumerate installed xscreensaver modules by scanning a list of
 * directories for executable files. Pure function — works against any
 * `dirs` array, e.g. test fixtures.
 *
 * Filters out non-module helpers (anything with a `-` in its name or in
 * NON_MODULE_NAMES). Modules are typically PascalCase with no dashes:
 * `Qix`, `GLMatrix`, `Decays`, `Flurry`, `Carousel`, etc.
 *
 * @param {string[]} dirs
 * @returns {string[]} sorted unique module names found
 */
function enumerateFromFilesystem(dirs) {
  if (!Array.isArray(dirs)) return [];
  const seen = new Set();
  for (const dir of dirs) {
    if (!dir || typeof dir !== 'string') continue;
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue; // dir doesn't exist or isn't readable
    }
    for (const name of entries) {
      if (typeof name !== 'string' || !name) continue;
      if (NON_MODULE_NAMES.has(name)) continue;
      // Module binaries are bare identifiers; helpers are `xscreensaver-*`
      // or `pixbuf-*`. Anything with `-` is not a module.
      if (name.includes('-')) continue;
      // Skip ones with extensions — modules are typically extensionless.
      if (path.extname(name)) continue;
      // Check that it's an executable regular file (any of ugo has +x).
      let full;
      try {
        full = path.join(dir, name);
      } catch {
        continue;
      }
      let stat;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      // S_IXUSR | S_IXGRP | S_IXOTH
      if ((stat.mode & 0o111) === 0) continue;
      seen.add(name);
    }
  }
  return [...seen].sort();
}

module.exports = {
  VALID_MODES,
  DEFAULT_MODULE_DIRS,
  isValidMode,
  normalizeModules,
  pickNext,
  enumerateFromFilesystem,
};
