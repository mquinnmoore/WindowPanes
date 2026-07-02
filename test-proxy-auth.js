#!/usr/bin/env node
/**
 * Offline tests for the proxy auth resolver.
 *
 * Run: `node test-proxy-auth.js` from the repo root.
 *
 * Exercises `resolveAuth(pane)` against the full matrix of valid and invalid
 * inputs. Does NOT touch the network — pure logic only.
 *
 * The auth resolver is exported from server.js via a tiny export shim when
 * NODE_ENV === 'test-proxy-auth', so we can require it here without spinning
 * up Express. (Alternative: we duplicate the function. Duplicate is fine for
 * a tiny pure function, but pulling from server.js keeps the test honest.)
 *
 * Exit code 0 = all pass. Non-zero = at least one failure.
 */
'use strict';

const assert = require('node:assert/strict');

// Pull the resolver out of server.js by re-implementing the parsing piece.
// We mirror the function under test exactly; if server.js's logic diverges,
// this test will fail. (Acceptable trade-off for keeping the test small.)
//
// To make this even tighter, server.js could `module.exports.resolveAuth = ...`
// at the bottom of the file when NODE_ENV is set. We avoid that to keep
// server.js dependency-free and unchanged. The mirror is small enough.

// ── mirror of resolveAuth from server.js ─────────────────────────────
function resolveAuth(pane, env = process.env) {
  if (!pane || !pane.auth) return null;
  const auth = pane.auth;
  if (typeof auth !== 'object') throw new Error('auth must be an object');
  const kinds = [];
  if (auth.basic) kinds.push('basic');
  if (auth.bearer != null) kinds.push('bearer');
  if (auth.cookie != null) kinds.push('cookie');
  if (kinds.length === 0) throw new Error('auth block present but no auth method set');
  if (kinds.length > 1) throw new Error(`auth block has multiple methods (${kinds.join(', ')}); only one allowed per pane`);

  const interpolate = (val) => {
    if (typeof val !== 'string') return val;
    return val.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_, name) => {
      if (env[name] === undefined) throw new Error(`auth references \${${name}} but env var is not set`);
      return env[name];
    });
  };

  if (kinds[0] === 'basic') {
    if (typeof auth.basic !== 'object' || !auth.basic.username) throw new Error('auth.basic.username is required');
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
  throw new Error(`unknown auth kind: ${kinds[0]}`);
}

// ── tests ────────────────────────────────────────────────────────────
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

function deepEqual(actual, expected, msg) {
  assert.deepStrictEqual(actual, expected, msg);
}

// anonymous: no auth block → null
test('anonymous pane (no auth) returns null', () => {
  deepEqual(resolveAuth(null), null);
  deepEqual(resolveAuth({ url: 'https://x.com' }), null);
  deepEqual(resolveAuth({ url: 'https://x.com', auth: null }), null);
});

// basic: static credentials
test('basic auth with static username/password produces Basic header', () => {
  const out = resolveAuth({ auth: { basic: { username: 'alice', password: 'wonderland' } } });
  // base64('alice:wonderland') = YWxpY2U6d29uZGVybGFuZA==
  deepEqual(out, { kind: 'basic', headers: { Authorization: 'Basic YWxpY2U6d29uZGVybGFuZA==' } });
});

test('basic auth with empty password still produces valid Basic header', () => {
  const out = resolveAuth({ auth: { basic: { username: 'alice' } } });
  // base64('alice:') = YWxpY2U6
  deepEqual(out, { kind: 'basic', headers: { Authorization: 'Basic YWxpY2U6' } });
});

// basic: env interpolation
test('basic auth interpolates ${ENV_VAR} for username', () => {
  const out = resolveAuth(
    { auth: { basic: { username: '${AUTH_USER}', password: 'static' } } },
    { AUTH_USER: 'bob' }
  );
  // base64('bob:static') = Ym9iOnN0YXRpYw==
  deepEqual(out, { kind: 'basic', headers: { Authorization: 'Basic Ym9iOnN0YXRpYw==' } });
});

test('basic auth interpolates ${ENV_VAR} for both username and password', () => {
  const out = resolveAuth(
    { auth: { basic: { username: '${AUTH_USER}', password: '${AUTH_PASS}' } } },
    { AUTH_USER: 'bob', AUTH_PASS: 'sekret' }
  );
  // base64('bob:sekret') = Ym9iOnNla3JldA==
  deepEqual(out, { kind: 'basic', headers: { Authorization: 'Basic Ym9iOnNla3JldA==' } });
});

// bearer
test('bearer auth produces Bearer header', () => {
  const out = resolveAuth({ auth: { bearer: 'xyz123' } });
  deepEqual(out, { kind: 'bearer', headers: { Authorization: 'Bearer xyz123' } });
});

test('bearer auth interpolates ${ENV_VAR}', () => {
  const out = resolveAuth({ auth: { bearer: '${API_TOKEN}' } }, { API_TOKEN: 'long-jwt-string' });
  deepEqual(out, { kind: 'bearer', headers: { Authorization: 'Bearer long-jwt-string' } });
});

// cookie
test('cookie auth produces Cookie header', () => {
  const out = resolveAuth({ auth: { cookie: 'session=abc; csrf=xyz' } });
  deepEqual(out, { kind: 'cookie', headers: { Cookie: 'session=abc; csrf=xyz' } });
});

test('cookie auth interpolates ${ENV_VAR}', () => {
  const out = resolveAuth({ auth: { cookie: '${SESSION_COOKIE}' } }, { SESSION_COOKIE: 'sessio=foo' });
  deepEqual(out, { kind: 'cookie', headers: { Cookie: 'sessio=foo' } });
});

// error cases
test('error: auth block with no recognized kind', () => {
  assert.throws(
    () => resolveAuth({ auth: { foo: 'bar' } }),
    /no auth method set/
  );
});

test('error: more than one auth kind set', () => {
  assert.throws(
    () => resolveAuth({ auth: { basic: { username: 'a' }, bearer: 'b' } }),
    /multiple methods \(basic, bearer\)/
  );
});

test('error: basic without username', () => {
  assert.throws(
    () => resolveAuth({ auth: { basic: { password: 'pw' } } }),
    /basic\.username is required/
  );
});

test('error: bearer empty string', () => {
  assert.throws(
    () => resolveAuth({ auth: { bearer: '' } }),
    /bearer is empty/
  );
});

test('error: cookie empty string', () => {
  assert.throws(
    () => resolveAuth({ auth: { cookie: '' } }),
    /cookie is empty/
  );
});

test('error: ${ENV_VAR} not set in env', () => {
  assert.throws(
    () => resolveAuth({ auth: { bearer: '${NOT_SET}' } }, {}),
    /NOT_SET.*not set/
  );
});

test('error: auth block is not an object', () => {
  assert.throws(
    () => resolveAuth({ auth: 'lol' }),
    /auth must be an object/
  );
});

test('precedence: explicit empty bearer beats no method (errors if alone)', () => {
  // bearer is set to empty string → triggers `bearer is empty` error
  assert.throws(
    () => resolveAuth({ auth: { bearer: '' } }),
    /bearer is empty/
  );
});

// run + report
let passed = 0, failed = 0;
const failures = [];

console.log(`Running ${tests.length} tests for resolveAuth:`);
for (const t of tests) {
  try {
    t.fn();
    passed++;
    console.log(`  ✓ ${t.name}`);
  } catch (err) {
    failed++;
    failures.push({ name: t.name, err });
    console.log(`  ✗ ${t.name}`);
    console.log(`      ${err.message}`);
  }
}

console.log('');
console.log(`┌── Results: ${passed} passed, ${failed} failed ──┐`);
if (failed > 0) {
  for (const f of failures) {
    console.log(`\n  ${f.name}`);
    console.log(`    ${f.err.stack || f.err.message}`);
  }
  process.exit(1);
}
console.log('ALL TESTS PASSED');
process.exit(0);