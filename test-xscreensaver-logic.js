'use strict';

/**
 * test-xscreensaver-logic.js — offline unit tests for xscreensaver-logic.js
 *
 * Run: node test-xscreensaver-logic.js
 *
 * Exits 0 on success, non-zero on failure. Designed to run on any
 * platform (macOS dev included) without Xvfb / xscreensaver / ffmpeg.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  VALID_MODES,
  DEFAULT_MODULE_DIRS,
  isValidMode,
  normalizeModules,
  pickNext,
  enumerateFromFilesystem,
} = require('./xscreensaver-logic');

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) {
    console.log(`  ✓ ${msg}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${msg}`);
    failed++;
  }
}

function assertEq(actual, expected, msg) {
  assert(actual === expected, `${msg} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

function section(label) {
  console.log(`\n── ${label} ─────────────────────────────────────────`);
}

// ──────────────────────────────────────────────────────────────────────
// 1. Mode validation
// ──────────────────────────────────────────────────────────────────────
section('Mode validation');
for (const m of VALID_MODES) {
  assert(isValidMode(m), `isValidMode('${m}') is true`);
}
assert(!isValidMode('weird'), `isValidMode('weird') is false`);
assert(!isValidMode(''), `isValidMode('') is false`);
assert(!isValidMode(null), `isValidMode(null) is false`);
assert(!isValidMode(undefined), `isValidMode(undefined) is false`);

// ──────────────────────────────────────────────────────────────────────
// 2. normalizeModules
// ──────────────────────────────────────────────────────────────────────
section('normalizeModules');
assertEq(
  JSON.stringify(normalizeModules([' a ', 'b', 'a', '', null, 'c'])),
  JSON.stringify(['a', 'b', 'c']),
  'trims, dedupes, drops empties'
);
assertEq(normalizeModules(null).length, 0, 'null → []');
assertEq(normalizeModules(undefined).length, 0, 'undefined → []');
assertEq(normalizeModules([]).length, 0, '[] → []');
assertEq(normalizeModules('not an array').length, 0, 'string → []');

// ──────────────────────────────────────────────────────────────────────
// 3. pickNext — sequential modes
// ──────────────────────────────────────────────────────────────────────
section('pickNext — sequential');

const seqModules = ['A', 'B', 'C'];

// start-up: currentIndex null/undefined/-1 → returns 0
assertEq(pickNext('list-sequential', seqModules, null).ok, true, 'seq null → ok');
assertEq(pickNext('list-sequential', seqModules, null).index, 0, 'seq null → index 0');
assertEq(pickNext('list-sequential', seqModules, undefined).index, 0, 'seq undefined → index 0');
assertEq(pickNext('list-sequential', seqModules, -1).index, 0, 'seq -1 → index 0');

// walk the cycle: 0 → 1 → 2 → 0
assertEq(pickNext('list-sequential', seqModules, 0).index, 1, 'seq 0 → 1');
assertEq(pickNext('list-sequential', seqModules, 1).index, 2, 'seq 1 → 2');
assertEq(pickNext('list-sequential', seqModules, 2).index, 0, 'seq 2 → wraps to 0');

assertEq(pickNext('all-sequential', seqModules, 2).index, 0, 'all-sequential wraps the same way');

// ──────────────────────────────────────────────────────────────────────
// 4. pickNext — random modes (no immediate repeat)
// ──────────────────────────────────────────────────────────────────────
section('pickNext — random');

const randModules = ['A', 'B', 'C', 'D'];

// single is non-cycling but uses index 0
assertEq(pickNext('single', ['only'], null).index, 0, 'single [only] → 0');
assertEq(pickNext('single', ['only'], 0).index, 0, 'single [only] when running → 0');

// list-random never returns currentIndex (1000-iter assertion)
{
  let lastRepeat = 0;
  for (let i = 0; i < 1000; i++) {
    const idx = i % randModules.length; // alternate 0,1,2,3
    const r = pickNext('list-random', randModules, idx);
    if (!r.ok) throw new Error(`unexpected error: ${r.reason}`);
    if (r.index === idx) lastRepeat++;
  }
  assertEq(lastRepeat, 0, 'list-random — no immediate repeats over 1000 iterations');
}
{
  let lastRepeat = 0;
  for (let i = 0; i < 1000; i++) {
    const idx = (i * 7) % randModules.length;
    const r = pickNext('all-random', randModules, idx);
    if (!r.ok) throw new Error(`unexpected error: ${r.reason}`);
    if (r.index === idx) lastRepeat++;
  }
  assertEq(lastRepeat, 0, 'all-random — no immediate repeats over 1000 iterations');
}

// currentIndex=null on random → any index in [0, n)
{
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const r = pickNext('list-random', randModules, null);
    if (r.index < 0 || r.index >= randModules.length) {
      throw new Error(`out-of-range index ${r.index}`);
    }
    seen.add(r.index);
  }
  assert(seen.size > 1, 'list-random with null start index produces varied indices');
}

// n=2 edge: random must not loop forever (must eventually return the other index)
{
  let sawBoth = false;
  const r1 = pickNext('list-random', ['x', 'y'], 0);
  if (r1.ok && r1.index === 1) sawBoth = true;
  // Above is probabilistic; force a deterministic check by running many.
  let count0 = 0, count1 = 0;
  for (let i = 0; i < 200; i++) {
    const r = pickNext('list-random', ['x', 'y'], 0);
    if (r.index === 0) count0++; else if (r.index === 1) count1++;
  }
  assert(count1 > 100, 'list-random n=2 avoids immediate repeat (≥100 of 200 must avoid)');
  assertEq(count0, 0, 'list-random n=2 with currentIndex=0 → never returns 0');
  // silence unused
  void sawBoth;
}

// n=1 — random must return 0 (no choice)
assertEq(pickNext('list-random', ['only'], 0).index, 0, 'list-random n=1 → 0');

// ──────────────────────────────────────────────────────────────────────
// 5. pickNext — error cases
// ──────────────────────────────────────────────────────────────────────
section('pickNext — error cases');

const emptyResult = pickNext('single', [], 0);
assertEq(emptyResult.ok, false, 'single + empty modules → ok=false');
assertEq(emptyResult.reason, 'empty', "single + empty → reason 'empty'");

assertEq(pickNext('list-sequential', [], 0).ok, false, 'list-sequential + empty → ok=false');
assertEq(pickNext('list-random', [], 0).ok, false, 'list-random + empty → ok=false');
assertEq(pickNext('all-sequential', [], 0).ok, false, 'all-sequential + empty → ok=false');
assertEq(pickNext('all-random', [], 0).ok, false, 'all-random + empty → ok=false');

assertEq(pickNext('unknown-mode', ['a'], 0).ok, false, 'unknown mode → ok=false');
assertEq(pickNext('unknown-mode', ['a'], 0).reason, 'unknown-mode', "unknown mode → reason 'unknown-mode'");

// ──────────────────────────────────────────────────────────────────────
// 6. enumerateFromFilesystem — fake tmp directory
// ──────────────────────────────────────────────────────────────────────
section('enumerateFromFilesystem');

{
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xss-fake-'));
  const moduleDir = path.join(tmpRoot, 'modules');
  fs.mkdirSync(moduleDir, { recursive: true });

  // Create a few "module" binaries (executable, no dash in name)
  for (const mod of ['Qix', 'GLMatrix', 'Decays', 'Flurry', 'Carousel']) {
    const p = path.join(moduleDir, mod);
    fs.writeFileSync(p, '#!/bin/sh\n');
    fs.chmodSync(p, 0o755);
  }

  // Create some "helpers" that should NOT be picked up (have dash)
  for (const helper of ['xscreensaver-helper', 'pixbuf-flip', 'pixbuf-cells']) {
    const p = path.join(moduleDir, helper);
    fs.writeFileSync(p, '#!/bin/sh\n');
    fs.chmodSync(p, 0o755);
  }

  // Create a non-executable file that should NOT be picked up
  fs.writeFileSync(path.join(moduleDir, 'NoExec'), 'data');

  // Create a directory with the same name as a module — must NOT be picked
  fs.mkdirSync(path.join(moduleDir, 'IsDir'));

  const result = enumerateFromFilesystem([moduleDir]);
  const expected = ['Carousel', 'Decays', 'Flurry', 'GLMatrix', 'Qix'];

  assertEq(
    JSON.stringify(result),
    JSON.stringify(expected),
    `enumerate picks exact module set (got ${JSON.stringify(result)})`
  );

  // Missing dir → no throw, returns []
  const missing = path.join(tmpRoot, 'does-not-exist');
  const r2 = enumerateFromFilesystem([missing, moduleDir]);
  assertEq(
    JSON.stringify(r2),
    JSON.stringify(expected),
    'enumerate ignores non-existent dirs and still finds modules'
  );

  // Empty dirs list → []
  assertEq(enumerateFromFilesystem([]).length, 0, 'empty dir list → []');
  assertEq(enumerateFromFilesystem(null).length, 0, 'null dir list → []');

  // Cleanup
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

// ──────────────────────────────────────────────────────────────────────
// 7. defaults sanity
// ──────────────────────────────────────────────────────────────────────
section('Defaults & module-export sanity');
assert(Array.isArray(DEFAULT_MODULE_DIRS), 'DEFAULT_MODULE_DIRS is an array');
assert(DEFAULT_MODULE_DIRS.length > 0, 'DEFAULT_MODULE_DIRS has entries');
assert(VALID_MODES.length === 5, 'VALID_MODES has exactly 5 entries');

const logicMod = require('./xscreensaver-logic');
assertEq(typeof logicMod.pickNext, 'function', 'exports pickNext as function');
assertEq(typeof logicMod.enumerateFromFilesystem, 'function', 'exports enumerateFromFilesystem as function');
assertEq(typeof logicMod.isValidMode, 'function', 'exports isValidMode as function');
assertEq(typeof logicMod.normalizeModules, 'function', 'exports normalizeModules as function');

// ──────────────────────────────────────────────────────────────────────
// Done
// ──────────────────────────────────────────────────────────────────────
console.log(`\n┌── Results: ${passed} passed, ${failed} failed ──┐`);
if (failed > 0) {
  console.error('TESTS FAILED');
  process.exit(1);
}
console.log('ALL TESTS PASSED');
process.exit(0);
